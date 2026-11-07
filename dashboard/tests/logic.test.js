import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkNewFalls, formatAgo, formatClock, formatReading, heatInfo, incidentBadges, incidentPlace,
  dotLabel, incidentTitle, incidentWho, isSimulated, lastSeenText, mapLayout, namePatch, summarize,
  zoneOptions, zonePatch,
} from "../logic.js";

test("isSimulated only matches the sim- prefix", () => {
  assert.equal(isSimulated("sim-01"), true);
  assert.equal(isSimulated("helmet-01"), false);
  assert.equal(isSimulated("my-sim-01"), false);
  assert.equal(isSimulated(null), false);
});

test("summarize counts devices, online, simulated, and new incidents", () => {
  const devices = [
    { device_id: "helmet-01", online: true },
    { device_id: "sim-01", online: true },
    { device_id: "sim-02", online: false },
  ];
  const incidents = [{ status: "new" }, { status: "confirmed" }, { status: "new" }];
  assert.deepEqual(summarize(devices, incidents), {
    devices: 3, online: 2, simulated: 2, incidents: 3, newIncidents: 2,
  });
});

test("summarize handles empty lists", () => {
  assert.deepEqual(summarize([], []), { devices: 0, online: 0, simulated: 0, incidents: 0, newIncidents: 0 });
});

test("formatAgo picks seconds, minutes, or hours", () => {
  assert.equal(formatAgo(0), "0 s ago");
  assert.equal(formatAgo(-500), "0 s ago");
  assert.equal(formatAgo(12_400), "12 s ago");
  assert.equal(formatAgo(59_400), "59 s ago");
  assert.equal(formatAgo(60_000), "1 min ago");
  assert.equal(formatAgo(59 * 60_000), "59 min ago");
  assert.equal(formatAgo(2 * 3_600_000 + 5_000), "2 h ago");
});

// --- Workers (D2) -----------------------------------------------------------

test("heatInfo maps every protocol level and falls back for none", () => {
  assert.equal(heatInfo("normal").label, "Normal");
  assert.equal(heatInfo("extreme_caution").css, "heat--extreme-caution");
  assert.equal(heatInfo("extreme_danger").label, "Extreme danger");
  assert.equal(heatInfo(null).label, "No reading");
  assert.equal(heatInfo("weird").css, "heat--none");
});

test("formatReading shows what exists", () => {
  const full = { heat_index_c: 30.14, temp_c: 29.4, humidity_pct: 41.2 };
  assert.equal(formatReading(full), "Heat index 30.1 °C (air 29.4 °C, 41 % humidity)");
  assert.equal(formatReading({ heat_index_c: null, temp_c: 22, humidity_pct: null }), "No heat index (air 22.0 °C)");
  assert.equal(formatReading({ heat_index_c: null, temp_c: null, humidity_pct: null }), "No temperature reading");
  assert.equal(formatReading(null), "No readings yet");
});

test("lastSeenText", () => {
  const now = Date.parse("2026-11-06T15:00:10.000Z");
  assert.equal(lastSeenText({ last_seen: "2026-11-06T15:00:07.000Z" }, now), "Last seen 3 s ago");
  assert.equal(lastSeenText({ last_seen: null }, now), "No readings yet");
});

test("zoneOptions lists no-zone, the grid, and an unknown current zone", () => {
  const cfg = { zones: [{ id: "A1", label: "A1" }, { id: "B2" }] };
  assert.deepEqual(zoneOptions(cfg, null).map((o) => o.value), ["", "A1", "B2"]);
  assert.equal(zoneOptions(cfg, "B2").length, 3);
  const withOld = zoneOptions(cfg, "Z9");
  assert.deepEqual(withOld.at(-1), { value: "Z9", label: "Z9 (not on map)" });
  assert.deepEqual(zoneOptions(null, null), [{ value: "", label: "No zone" }]);
});

test("namePatch trims, ignores no-ops, and rejects empty or long names", () => {
  assert.deepEqual(namePatch("  Sam R. ", "helmet-01"), { body: { name: "Sam R." } });
  assert.deepEqual(namePatch("Sam R.", "Sam R."), {});
  assert.deepEqual(namePatch(" Sam R. ", "Sam R."), {});
  assert.ok(namePatch("   ", "Sam").error);
  assert.ok(namePatch("x".repeat(81), "Sam").error);
  assert.deepEqual(namePatch("x".repeat(80), "Sam"), { body: { name: "x".repeat(80) } });
});

test("zonePatch sends null for no zone and nothing when unchanged", () => {
  assert.deepEqual(zonePatch("A2", null), { zone: "A2" });
  assert.deepEqual(zonePatch("", "A2"), { zone: null });
  assert.equal(zonePatch("A2", "A2"), null);
  assert.equal(zonePatch("", null), null);
});

// --- Incidents and fall alert (D3) -----------------------------------------

const inc = (over) => ({
  id: 1, device_id: "helmet-01", worker_name: "Sam R.", type: "fall", ts: "2026-11-06T15:04:06.010Z",
  zone: "A2", lat: null, lon: null, peak_g: 4.2, status: "new", notes: "", delayed: false, sample: false,
  ...over,
});

test("formatAgo switches to days at 48 hours", () => {
  assert.equal(formatAgo(47 * 3_600_000), "47 h ago");
  assert.equal(formatAgo(50 * 3_600_000), "2 d ago");
});

test("incidentTitle names each type", () => {
  assert.equal(incidentTitle("fall"), "Fall");
  assert.equal(incidentTitle("injury_report"), "Injury report");
  assert.equal(incidentTitle("hazard_report"), "Hazard report");
  assert.equal(incidentTitle("other"), "other");
});

test("incidentBadges shows status, sample data, and late arrival", () => {
  const labels = (i) => incidentBadges(i).map((b) => b.label);
  assert.deepEqual(labels(inc()), ["New"]);
  assert.deepEqual(labels(inc({ status: "confirmed", sample: true, delayed: true })),
    ["Confirmed", "Sample data", "Arrived late"]);
  assert.equal(incidentBadges(inc({ status: "dismissed" }))[0].css, "badge--dismissed");
});

test("incidentWho uses the snapshot name, the device, or says manual report", () => {
  assert.equal(incidentWho(inc()), "Sam R. (helmet-01)");
  assert.equal(incidentWho(inc({ worker_name: "helmet-01" })), "helmet-01");
  assert.equal(incidentWho(inc({ worker_name: null })), "helmet-01");
  assert.equal(incidentWho(inc({ worker_name: "Ana", device_id: null })), "Ana");
  assert.equal(incidentWho(inc({ worker_name: null, device_id: null })), "Manual report");
});

test("incidentPlace shows the zone and GPS when present", () => {
  assert.equal(incidentPlace(inc()), "Zone A2");
  assert.equal(incidentPlace(inc({ zone: null })), "No zone");
  assert.equal(incidentPlace(inc({ lat: 45.123456, lon: -122.5 })), "Zone A2 · GPS 45.12346, -122.50000");
});

test("formatClock shows time today and adds the date for older incidents", () => {
  const opts = { locale: "en-GB", timeZone: "UTC" };
  const now = Date.parse("2026-11-06T15:10:06.000Z");
  assert.equal(formatClock("2026-11-06T15:04:06.010Z", now, opts), "15:04:06 (6 min ago)");
  assert.equal(formatClock("2026-11-05T09:00:00.000Z", now, opts), "5 Nov, 09:00:00 (30 h ago)");
});

test("checkNewFalls: first load sets the baseline and alerts nothing", () => {
  const list = [inc({ id: 7 }), inc({ id: 5 })];
  assert.deepEqual(checkNewFalls(list, null), { baseline: 7, falls: [] });
  assert.deepEqual(checkNewFalls([], null), { baseline: 0, falls: [] });
});

test("checkNewFalls: only new falls above the baseline, newest first", () => {
  const list = [
    inc({ id: 10 }),
    inc({ id: 9, type: "injury_report", peak_g: null }),
    inc({ id: 8, status: "dismissed" }),
    inc({ id: 7 }),
    inc({ id: 5 }),
  ];
  const r = checkNewFalls(list, 5);
  assert.equal(r.baseline, 10);
  assert.deepEqual(r.falls.map((f) => f.id), [10, 7]);
  assert.deepEqual(checkNewFalls(list, 10), { baseline: 10, falls: [] });
});

test("checkNewFalls: a reset database (ids went down) alerts on its new falls", () => {
  const r = checkNewFalls([inc({ id: 2 }), inc({ id: 1, type: "hazard_report" })], 40);
  assert.equal(r.baseline, 2);
  assert.deepEqual(r.falls.map((f) => f.id), [2]);
  assert.deepEqual(checkNewFalls([], 40), { baseline: 0, falls: [] });
});

// --- Site map (D4) ----------------------------------------------------------

const grid = {
  cols: 2, rows: 1,
  zones: [{ id: "A1", label: "Gate", col: 0, row: 0 }, { id: "A2", col: 1, row: 0 }],
};
const dev = (id, zone, name = id) => ({ device_id: id, name, zone, online: true, latest: null });

test("mapLayout puts workers in their zone, sorted by name", () => {
  const m = mapLayout(grid, [dev("h3", "A2", "Zed"), dev("h1", "A2", "amy"), dev("h2", "A1", "Bo")]);
  assert.equal(m.cols, 2);
  assert.equal(m.rows, 1);
  assert.deepEqual(m.cells.map((c) => [c.id, c.label, c.workers.map((w) => w.name)]),
    [["A1", "Gate", ["Bo"]], ["A2", "A2", ["amy", "Zed"]]]);
  assert.deepEqual(m.offMap, []);
  assert.deepEqual(m.problems, []);
});

test("mapLayout lists workers with no zone or an unknown zone as off the map", () => {
  const m = mapLayout(grid, [dev("h1", null), dev("h2", "Z9"), dev("h3", "A1")]);
  assert.deepEqual(m.offMap.map((w) => w.device_id), ["h1", "h2"]);
});

test("mapLayout reports bad zones.json entries and skips them", () => {
  const bad = { cols: 2, rows: 1, zones: [
    { id: "A1", col: 0, row: 0 }, { id: "A1", col: 1, row: 0 }, { id: "X", col: 5, row: 0 }, { col: 1, row: 0 },
  ] };
  const m = mapLayout(bad, [dev("h1", "X")]);
  assert.deepEqual(m.cells.map((c) => c.id), ["A1"]);
  assert.equal(m.problems.length, 3);
  assert.deepEqual(m.offMap.map((w) => w.device_id), ["h1"]);
});

test("mapLayout without a zones file puts everyone off the map", () => {
  const m = mapLayout(null, [dev("h1", "A1")]);
  assert.deepEqual(m.cells, []);
  assert.equal(m.offMap.length, 1);
});

test("dotLabel gives name, heat risk, and offline / GPS details", () => {
  const d = { ...dev("helmet-01", "A1", "Sam"), latest: { heat_level: "danger", gps_fix: false, lat: null, lon: null } };
  assert.equal(dotLabel(d), "Sam: Danger heat risk");
  assert.equal(dotLabel({ ...d, online: false }), "Sam: Danger heat risk, offline");
  assert.equal(dotLabel({ ...d, latest: { heat_level: "normal", gps_fix: true, lat: 45.1, lon: -122.5 } }),
    "Sam: Normal heat risk, GPS 45.10000, -122.50000");
  assert.equal(dotLabel(dev("h", null, "Bo")), "Bo: No reading");
});
