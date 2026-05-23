#!/usr/bin/env node
/**
 * sync-calendar.mjs
 *
 * Henter Skoven Kalders booking-kalender via en hemmelig ICS URL,
 * udleder fri/optaget pr. måned og skriver booking-status.json.
 *
 * Kører i GitHub Action hver time. Lokalt: `node scripts/sync-calendar.mjs`
 * (kræver miljøvariabel GOOGLE_CALENDAR_ICS_URL).
 *
 * Bevidste valg:
 *  - Ingen npm-afhængigheder. Et minimalt ICS-parse-trin er nok til
 *    Google Calendar-events. Mindre angrebsflade, intet build-step.
 *  - Vi læser KUN datoer fra hvert VEVENT — aldrig SUMMARY, ATTENDEE,
 *    DESCRIPTION e.l. Output-JSON indeholder dermed ingen kundedata.
 *  - Hvis ICS URL mangler eller netværket fejler: vi skriver IKKE noget.
 *    Det betyder eksisterende booking-status.json bevares uændret —
 *    siden bliver aldrig tom pga. en sync-fejl.
 *  - "Manual"-entries i den eksisterende JSON respekteres (fx Marts 2027
 *    "Åbner snart") og overskrives ikke. Kalenderen styrer kun måneder
 *    inden for et 12-måneders vindue fra "i dag".
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const STATUS_FILE = join(REPO_ROOT, "booking-status.json");

const MONTH_NAMES = [
  "Januar", "Februar", "Marts", "April", "Maj", "Juni",
  "Juli", "August", "September", "Oktober", "November", "December",
];

const SYNC_WINDOW_MONTHS = 12; // hvor mange måneder fremad vi auto-styrer

function log(...args) {
  console.log("[sync-calendar]", ...args);
}

export { extractEvents, buildMonthlyStatus, mergeStatus, parseIcsDate };

async function readExistingStatus() {
  try {
    const raw = await readFile(STATUS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    log("Kunne ikke læse eksisterende booking-status.json:", err.message);
    return { lastSync: null, lastSyncSource: "manual", months: [] };
  }
}

/**
 * Parser ICS-datoformat. Google Calendar leverer enten:
 *   - DTSTART;VALUE=DATE:20260315           (heldagsbegivenhed)
 *   - DTSTART:20260315T140000Z              (UTC tidspunkt)
 *   - DTSTART;TZID=Europe/Copenhagen:20260315T140000
 * Vi behøver kun dato (år, måned, dag).
 */
function parseIcsDate(value) {
  // Strip evt. "VALUE=DATE:" eller "TZID=...:" præfiks
  const colonIdx = value.lastIndexOf(":");
  const raw = colonIdx >= 0 ? value.slice(colonIdx + 1) : value;
  const datePart = raw.slice(0, 8); // YYYYMMDD
  if (!/^\d{8}$/.test(datePart)) return null;
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6)); // 1-12
  const day = Number(datePart.slice(6, 8));
  return { year, month, day };
}

/**
 * Splitter et ICS-dokument til VEVENT-blokke og udtrækker kun DTSTART/DTEND.
 * Returns: [{ start: {year,month,day}, end: {year,month,day} }]
 * Bemærk: vi ignorerer RRULE (gentagelser). Skoven Kalders bookinger er
 * konkrete enkeltstående datoer, ikke ugentlige gentagelser.
 */
function extractEvents(icsText) {
  // Foldede linjer i ICS (linjer der starter med space) skal samles
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let inEvent = false;
  let current = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current.start) events.push(current);
      inEvent = false;
      current = {};
      continue;
    }
    if (!inEvent) continue;

    if (line.startsWith("DTSTART")) {
      const date = parseIcsDate(line);
      if (date) current.start = date;
    } else if (line.startsWith("DTEND")) {
      const date = parseIcsDate(line);
      if (date) current.end = date;
    }
    // BEVIDST: vi læser INGEN andre felter (SUMMARY, DESCRIPTION, etc.)
  }

  return events;
}

/**
 * Beregner sæt af bookede dage i (year, month) for én event.
 * ICS DTEND er exclusive (typisk for både heldagsbegivenheder og overnatninger
 * hvor DTEND = checkout-dag). Vi trækker derfor 1 fra slutdagen — undtagen
 * for enkeltdags-events hvor start == end.
 */
function bookedDaysInMonth(ev, year, month, daysInMonth) {
  if (!eventOverlapsMonth(ev, year, month)) return [];
  const start = ev.start;
  const end = ev.end ?? ev.start;

  const firstDay =
    start.year === year && start.month === month ? start.day : 1;

  let lastDay;
  if (end.year === year && end.month === month) {
    lastDay = end.day - 1;
    // Enkeltdags-event: start og end er samme dag
    if (
      start.year === end.year &&
      start.month === end.month &&
      start.day === end.day
    ) {
      lastDay = start.day;
    }
  } else {
    lastDay = daysInMonth;
  }

  if (lastDay < firstDay) return [];

  const days = [];
  for (let d = firstDay; d <= Math.min(lastDay, daysInMonth); d++) {
    days.push(d);
  }
  return days;
}

/**
 * Mapper events til status pr. (år, måned) inden for sync-vinduet.
 * Heuristik:
 *  - 0 events der overlapper måneden     → "available"
 *  - events dækker (næsten) hele måneden → "booked"
 *  - delvist dækket                      → "partial"
 */
function buildMonthlyStatus(events, today = new Date()) {
  const startYear = today.getFullYear();
  const startMonth = today.getMonth() + 1;

  const months = [];
  for (let offset = 0; offset < SYNC_WINDOW_MONTHS; offset++) {
    const m = ((startMonth - 1 + offset) % 12) + 1;
    const y = startYear + Math.floor((startMonth - 1 + offset) / 12);

    const daysInMonth = new Date(y, m, 0).getDate();
    const bookedDays = new Set();

    for (const ev of events) {
      for (const d of bookedDaysInMonth(ev, y, m, daysInMonth)) {
        bookedDays.add(d);
      }
    }

    let status;
    if (bookedDays.size === 0) status = "available";
    else if (bookedDays.size >= daysInMonth - 2) status = "booked";
    else status = "partial";

    months.push({ name: MONTH_NAMES[m - 1], year: y, status });
  }

  return months;
}

function eventOverlapsMonth(ev, year, month) {
  const start = ev.start;
  const end = ev.end ?? ev.start;
  // Måned-interval i "absolute month number" (år*12+måned) for nem sammenligning
  const monthKey = year * 12 + month;
  const startKey = start.year * 12 + start.month;
  const endKey = end.year * 12 + end.month;
  return monthKey >= startKey && monthKey <= endKey;
}

/**
 * Fletter calendar-baseret status ind i eksisterende JSON.
 *
 * Regler:
 *  - Entries med { manual: true } bevares ALTID (uanset sync-vindue) og
 *    "vinder" over calendar-data for samme (måned, år).
 *  - Auto-genererede entries (uden manual-flag) inden for sync-vinduet
 *    erstattes af calendar-data.
 *  - Auto-genererede entries UDEN FOR sync-vinduet bevares (gammelt data).
 */
function mergeStatus(existing, calendarMonths) {
  const monthKey = (m) => `${m.year}-${MONTH_NAMES.indexOf(m.name) + 1}`;

  const manualByKey = new Map();
  const autoByKey = new Map();
  for (const m of existing.months ?? []) {
    if (m.manual) manualByKey.set(monthKey(m), m);
    else autoByKey.set(monthKey(m), m);
  }

  // Calendar-genereret data overskriver auto-entries i sync-vinduet
  for (const m of calendarMonths) {
    autoByKey.set(monthKey(m), m);
  }

  // Manuelle entries vinder altid over auto
  const finalByKey = new Map(autoByKey);
  for (const [key, m] of manualByKey) finalByKey.set(key, m);

  // Sortér: (år, måned) stigende
  return [...finalByKey.values()].sort((a, b) => {
    const ay = a.year - b.year;
    if (ay !== 0) return ay;
    return MONTH_NAMES.indexOf(a.name) - MONTH_NAMES.indexOf(b.name);
  });
}

async function main() {
  const icsUrl = process.env.GOOGLE_CALENDAR_ICS_URL;

  if (!icsUrl) {
    log("GOOGLE_CALENDAR_ICS_URL ikke sat — sync springes over (no-op).");
    log("Eksisterende booking-status.json bevares uændret.");
    return;
  }

  log("Henter ICS fra hemmelig URL...");
  const response = await fetch(icsUrl);
  if (!response.ok) {
    throw new Error(`ICS fetch fejlede: HTTP ${response.status}`);
  }
  const icsText = await response.text();
  log(`Modtog ${icsText.length} bytes ICS-data.`);

  const events = extractEvents(icsText);
  log(`Fandt ${events.length} events.`);

  const calendarMonths = buildMonthlyStatus(events);
  const existing = await readExistingStatus();
  const mergedMonths = mergeStatus(existing, calendarMonths);

  const output = {
    lastSync: new Date().toISOString(),
    lastSyncSource: "calendar",
    months: mergedMonths,
  };

  await writeFile(STATUS_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");
  log(`Skrev ${STATUS_FILE} (${mergedMonths.length} måneder).`);
}

// Kør main() kun når scriptet køres direkte (ikke ved import fra test)
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error("[sync-calendar] FEJL:", err);
    process.exit(1);
  });
}
