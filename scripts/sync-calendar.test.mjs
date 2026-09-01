/**
 * Tests for buildMonthlyStatus i sync-calendar.mjs.
 * Kør: node --test scripts/
 *
 * Regler under test:
 *  - Skiftedag: hver booking blokerer én dag på hver side (CHANGEOVER_DAYS=1)
 *  - Ledige striber < 2 nætter (MIN_NIGHTS) tælles ikke
 *  - status: ingen brugbar stribe → booked; ≥70 % bookede nætter → partial;
 *    ellers → available
 *  - free: [{from, to}] = ankomst-/afrejsedag; striber der når månedens
 *    udgang, "cappes" på sidste dag i måneden
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildMonthlyStatus } from "./sync-calendar.mjs";

// Fast "i dag": 15. januar 2027 → sync-vinduet er jan.–dec. 2027
const TODAY = new Date(2027, 0, 15);

// Hjælpere: ICS-datoer som i extractEvents-output
const d = (s) => ({
  year: Number(s.slice(0, 4)),
  month: Number(s.slice(4, 6)),
  day: Number(s.slice(6, 8)),
});
const ev = (start, end) => ({ start: d(start), end: end ? d(end) : undefined });
const find = (months, name, year) =>
  months.find((m) => m.name === name && m.year === year);

test("tom kalender: alle måneder available med hele måneden ledig", () => {
  const months = buildMonthlyStatus([], TODAY);
  assert.equal(months.length, 12);
  for (const m of months) assert.equal(m.status, "available");
  assert.deepEqual(find(months, "Marts", 2027).free, [{ from: 1, to: 31 }]);
  assert.deepEqual(find(months, "April", 2027).free, [{ from: 1, to: 30 }]);
});

test("skiftedag: bookinger 1.–3. og 10.–13. marts giver ledigt 4.–9. og 14.–31.", () => {
  // Nætter 1–2 (checkout 3.) og nætter 10–12 (checkout 13.)
  const months = buildMonthlyStatus(
    [ev("20270301", "20270303"), ev("20270310", "20270313")],
    TODAY,
  );
  const marts = find(months, "Marts", 2027);
  assert.deepEqual(marts.free, [
    { from: 4, to: 9 },
    { from: 14, to: 31 },
  ]);
  assert.equal(marts.status, "available");
});

test("hul på 1 nat tælles ikke: måneden er fuldt booket", () => {
  // Nætter 1–5 og 9–31; kun d. 7. er brugbar efter skiftedage → for kort
  const months = buildMonthlyStatus(
    [ev("20270301", "20270306"), ev("20270309", "20270401")],
    TODAY,
  );
  const marts = find(months, "Marts", 2027);
  assert.deepEqual(marts.free, []);
  assert.equal(marts.status, "booked");
});

test("70 % bookede nætter → partial (Få datoer tilbage)", () => {
  // 21 af 30 nætter i april = 70 %
  const months = buildMonthlyStatus([ev("20270401", "20270422")], TODAY);
  const april = find(months, "April", 2027);
  assert.equal(april.status, "partial");
  assert.deepEqual(april.free, [{ from: 23, to: 30 }]);
});

test("under 70 % bookede nætter → stadig available", () => {
  // 20 af 30 nætter i april ≈ 67 %
  const months = buildMonthlyStatus([ev("20270401", "20270421")], TODAY);
  assert.equal(find(months, "April", 2027).status, "available");
});

test("skiftedag krydser månedsgrænse: booking 31. marts blokerer 1. april", () => {
  const months = buildMonthlyStatus([ev("20270331", "20270401")], TODAY);
  const april = find(months, "April", 2027);
  assert.equal(april.free[0].from, 2);
  assert.equal(april.status, "available");
});

test("helt booket måned → booked med tom free-liste", () => {
  const months = buildMonthlyStatus([ev("20270301", "20270401")], TODAY);
  const marts = find(months, "Marts", 2027);
  assert.equal(marts.status, "booked");
  assert.deepEqual(marts.free, []);
});

test("weekender: tom kalender → alle weekender ledige (marts 4, april 5 fredage)", () => {
  const months = buildMonthlyStatus([], TODAY);
  assert.deepEqual(find(months, "Marts", 2027).weekends, { free: 4, total: 4 });
  assert.deepEqual(find(months, "April", 2027).weekends, { free: 5, total: 5 });
});

test("weekender: booket fre–lør (5.–7. marts) → 3 af 4 weekender ledige", () => {
  // Nætter fre 5. + lør 6. marts 2027
  const months = buildMonthlyStatus([ev("20270305", "20270307")], TODAY);
  assert.deepEqual(find(months, "Marts", 2027).weekends, { free: 3, total: 4 });
});

test("weekend over månedsgrænse: booket 1. maj blokerer weekenden 30. april", () => {
  // Nat lør 1. maj 2027; fredag 30. april er skiftedag → weekend ikke ledig
  const months = buildMonthlyStatus([ev("20270501", "20270502")], TODAY);
  assert.deepEqual(find(months, "April", 2027).weekends, { free: 4, total: 5 });
});

test("direkte kørsel uden ICS-url logger no-op-besked (main-guard virker også på Windows)", () => {
  const script = fileURLToPath(new URL("./sync-calendar.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script], {
    env: { ...process.env, GOOGLE_CALENDAR_ICS_URL: "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ikke sat/);
});
