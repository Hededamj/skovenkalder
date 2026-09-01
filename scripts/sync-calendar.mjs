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
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const STATUS_FILE = join(REPO_ROOT, "booking-status.json");

const MONTH_NAMES = [
  "Januar", "Februar", "Marts", "April", "Maj", "Juni",
  "Juli", "August", "September", "Oktober", "November", "December",
];

const SYNC_WINDOW_MONTHS = 12; // hvor mange måneder fremad vi auto-styrer

// Kalender-regler (aftalt med Friederikke, sep. 2026):
const FEW_DATES_SHARE = 0.70; // ≥ 70 % bookede nætter → "Få datoer tilbage"
const MIN_NIGHTS = 2;         // en brugbar ledig stribe skal kunne rumme 2 nætter
const CHANGEOVER_DAYS = 1;    // skiftedag(e) til rengøring på hver side af en booking

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
 * Dag-serienummer (dage siden epoch, UTC) – gør beregninger på tværs af
 * månedsgrænser trivielle (skiftedage og ledige striber).
 */
const DAY_MS = 86400000;
function daySerial(year, month, day) {
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/**
 * Sæt af bookede NÆTTER (dag-serienumre) for alle events.
 * ICS DTEND er exclusive (checkout-dag), så sidste nat er end-1 —
 * undtagen enkeltdags-events (start == end / manglende DTEND).
 */
function bookedNightSerials(events) {
  const nights = new Set();
  for (const ev of events) {
    const start = ev.start;
    const end = ev.end ?? ev.start;
    const s = daySerial(start.year, start.month, start.day);
    let e = daySerial(end.year, end.month, end.day) - 1;
    if (e < s) e = s; // enkeltdags-event
    for (let x = s; x <= e; x++) nights.add(x);
  }
  return nights;
}

/**
 * Mapper events til status + detaljer pr. (år, måned) i sync-vinduet.
 *
 * Regler (aftalt med Friederikke, sep. 2026):
 *  - Hver booking blokerer CHANGEOVER_DAYS skiftedag(e) på hver side
 *    (rengøring/skift mellem grupper).
 *  - En ledig stribe tæller kun, hvis den kan rumme MIN_NIGHTS nætter.
 *  - status: ingen brugbar stribe             → "booked"
 *            ≥ FEW_DATES_SHARE bookede nætter → "partial"
 *            ellers                           → "available"
 *  - free: [{from, to}] = ankomstdag/afrejsedag. Striber der når månedens
 *    udgang, cappes på sidste dag i måneden.
 */
function buildMonthlyStatus(events, today = new Date()) {
  const booked = bookedNightSerials(events);
  const blocked = new Set();
  for (const x of booked) {
    for (let b = x - CHANGEOVER_DAYS; b <= x + CHANGEOVER_DAYS; b++) {
      blocked.add(b);
    }
  }

  const startYear = today.getFullYear();
  const startMonth = today.getMonth() + 1;

  const months = [];
  for (let offset = 0; offset < SYNC_WINDOW_MONTHS; offset++) {
    const m = ((startMonth - 1 + offset) % 12) + 1;
    const y = startYear + Math.floor((startMonth - 1 + offset) / 12);

    const daysInMonth = new Date(y, m, 0).getDate();
    const firstSerial = daySerial(y, m, 1);

    // Ledige striber (kun ≥ MIN_NIGHTS) og bookede nætter i måneden
    const free = [];
    let bookedNights = 0;
    let runStart = null;
    for (let d = 1; d <= daysInMonth + 1; d++) {
      const serial = firstSerial + d - 1;
      if (d <= daysInMonth && booked.has(serial)) bookedNights++;
      const usable = d <= daysInMonth && !blocked.has(serial);
      if (usable && runStart === null) runStart = d;
      if (!usable && runStart !== null) {
        const lastNight = d - 1;
        if (lastNight - runStart + 1 >= MIN_NIGHTS) {
          free.push({ from: runStart, to: Math.min(lastNight + 1, daysInMonth) });
        }
        runStart = null;
      }
    }

    // Weekender: fredage i måneden; en weekend er ledig hvis både
    // fredags- og lørdagsnatten er brugbare (inkl. skiftedage)
    let weekendsTotal = 0;
    let weekendsFree = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const serial = firstSerial + d - 1;
      if (new Date(serial * DAY_MS).getUTCDay() !== 5) continue; // 5 = fredag
      weekendsTotal++;
      if (!blocked.has(serial) && !blocked.has(serial + 1)) weekendsFree++;
    }

    let status;
    if (free.length === 0) status = "booked";
    else if (bookedNights / daysInMonth >= FEW_DATES_SHARE) status = "partial";
    else status = "available";

    months.push({
      name: MONTH_NAMES[m - 1],
      year: y,
      status,
      free,
      weekends: { free: weekendsFree, total: weekendsTotal },
    });
  }

  return months;
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
// pathToFileURL håndterer platformsforskelle (Windows-drevbogstaver,
// file:///-slashes) korrekt.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[sync-calendar] FEJL:", err);
    process.exit(1);
  });
}
