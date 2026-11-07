import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  checkNewFalls, dotLabel, formatAgo, formatClock, formatReading, hazardView, heatInfo, heatLevelFor,
  incidentBadges, incidentPlace, incidentTitle, incidentWho, isSimulated, lastSeenText, mapLayout,
  namePatch, notesPatch, reportBody, statusActions, summarize, zoneHeatView, zoneName, zoneOptions, zonePatch,
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

test("incidentPlace and zoneName use the zones.json label when there is one", () => {
  const cfg = { zones: [{ id: "A2", label: "1520 West" }, { id: "B1" }, { id: "B2", label: "" }] };
  assert.equal(incidentPlace(inc(), cfg), "Zone 1520 West");
  assert.equal(zoneName(cfg, "B1"), "B1");      // no label
  assert.equal(zoneName(cfg, "B2"), "B2");      // empty label
  assert.equal(zoneName(cfg, "Z9"), "Z9");      // not in the file (an old zone)
  assert.equal(zoneName(null, "A2"), "A2");     // file not loaded
  assert.equal(zoneName({ zones: "oops" }, "A2"), "A2");
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

// --- Stretch: review, reports, hazard map (D5) --------------------------------

test("statusActions offers the two other statuses", () => {
  assert.deepEqual(statusActions("new").map((a) => a.status), ["confirmed", "dismissed"]);
  assert.deepEqual(statusActions("confirmed").map((a) => a.label), ["Dismiss", "Mark new"]);
  assert.deepEqual(statusActions("dismissed").map((a) => a.label), ["Confirm", "Mark new"]);
});

test("notesPatch trims, allows clearing, and limits length", () => {
  assert.deepEqual(notesPatch("  wet floor ", ""), { body: { notes: "wet floor" } });
  assert.deepEqual(notesPatch("same", "same"), {});
  assert.deepEqual(notesPatch("   ", "old"), { body: { notes: "" } });
  assert.ok(notesPatch("x".repeat(2001), "").error);
});

test("reportBody builds a manual report and checks it", () => {
  assert.deepEqual(reportBody({ type: "hazard_report", zone: "A2", deviceId: "", workerName: "", notes: " wet floor " }),
    { body: { type: "hazard_report", zone: "A2", notes: "wet floor" } });
  assert.deepEqual(reportBody({ type: "injury_report", zone: "B1", deviceId: "helmet-01", workerName: "ignored", notes: "" }),
    { body: { type: "injury_report", zone: "B1", notes: "", device_id: "helmet-01" } });
  assert.deepEqual(reportBody({ type: "injury_report", zone: "B1", deviceId: "", workerName: " Alex P. ", notes: "" }),
    { body: { type: "injury_report", zone: "B1", notes: "", worker_name: "Alex P." } });
  assert.match(reportBody({ type: "injury_report", zone: "", deviceId: "", workerName: "", notes: "" }).error, /zone/i);
  assert.match(reportBody({ type: "fall", zone: "A1", deviceId: "", workerName: "", notes: "" }).error, /type/i);
  assert.ok(reportBody({ type: "injury_report", zone: "A1", deviceId: "", workerName: "x".repeat(81), notes: "" }).error);
  assert.ok(reportBody({ type: "injury_report", zone: "A1", deviceId: "", workerName: "", notes: "x".repeat(2001) }).error);
});

test("heatLevelFor uses the protocol bands", () => {
  assert.equal(heatLevelFor(null), null);
  assert.equal(heatLevelFor(26.9), "normal");
  assert.equal(heatLevelFor(27), "caution");
  assert.equal(heatLevelFor(32), "extreme_caution");
  assert.equal(heatLevelFor(39), "danger");
  assert.equal(heatLevelFor(51), "extreme_danger");
});

test("hazardView: shade by confirmed count, say when sample data is included", () => {
  const none = { shade: 0, text: "No confirmed incidents", badge: null };
  assert.deepEqual(hazardView(undefined), none);
  assert.deepEqual(hazardView({ confirmed_count: 0, sample_count: 0 }), none);
  assert.deepEqual(hazardView({ confirmed_count: 1, sample_count: 0 }),
    { shade: 1, text: "1 confirmed incident", badge: "1 incident" });
  assert.deepEqual(hazardView({ confirmed_count: 2, sample_count: 2 }),
    { shade: 2, text: "2 confirmed incidents (includes 2 sample)", badge: "2 incidents · sample" });
  assert.deepEqual(hazardView({ confirmed_count: 3, sample_count: 1 }),
    { shade: 3, text: "3 confirmed incidents (includes 1 sample)", badge: "3 incidents · incl. sample" });
  assert.equal(hazardView({ confirmed_count: 9, sample_count: 0 }).shade, 3);
});

test("zoneHeatView shows the highest heat index in the window", () => {
  assert.deepEqual(zoneHeatView({ max_heat_index_c: 33.26 }), {
    level: "extreme_caution", text: "Max heat index 33.3 °C (Extreme caution)", badge: "33.3 °C · Extreme caution",
  });
  const none = { level: null, text: "No heat readings", badge: null };
  assert.deepEqual(zoneHeatView({ max_heat_index_c: null }), none);
  assert.deepEqual(zoneHeatView(undefined), none);
});

// --- Floor-plan map -----------------------------------------------------------

const plan = {
  image: "floorplan.png", width: 500, height: 400,
  zones: [
    { id: "W", label: "West", x: 0, y: 0, w: 250, h: 400 },
    { id: "E", x: 250, y: 100, w: 250, h: 300 },
  ],
};

test("mapLayout with a floor plan places zones in percent of the image", () => {
  const m = mapLayout(plan, [dev("h1", "E", "Bo"), dev("h2", null)]);
  assert.equal(m.mode, "plan");
  assert.equal(m.image, "floorplan.png");
  assert.deepEqual([m.width, m.height], [500, 400]);
  assert.deepEqual(m.cells.map(({ workers, ...c }) => ({ ...c, workers: workers.map((w) => w.name) })), [
    { id: "W", label: "West", left: 0, top: 0, width: 50, height: 100, workers: [] },
    { id: "E", label: "E", left: 50, top: 25, width: 50, height: 75, workers: ["Bo"] },
  ]);
  assert.deepEqual(m.offMap.map((w) => w.device_id), ["h2"]);
  assert.deepEqual(m.problems, []);
});

test("mapLayout keeps percentages to 3 decimals", () => {
  const m = mapLayout({ image: "p.png", width: 555, height: 505, zones: [{ id: "Z", x: 122, y: 95, w: 115, h: 334 }] }, []);
  assert.deepEqual(m.cells[0], { id: "Z", label: "Z", left: 21.982, top: 18.812, width: 20.721, height: 66.139, workers: [] });
});

test("mapLayout reports floor-plan zones that are missing numbers or outside the image", () => {
  const bad = { ...plan, zones: [
    { id: "ok", x: 0, y: 0, w: 10, h: 10 },
    { id: "wide", x: 400, y: 0, w: 200, h: 10 },   // runs off the right edge
    { id: "neg", x: -1, y: 0, w: 10, h: 10 },
    { id: "flat", x: 0, y: 0, w: 10, h: 0 },
    { id: "text", x: "0", y: 0, w: 10, h: 10 },
    { id: "grid", col: 0, row: 0 },                  // grid fields in a plan file
  ] };
  const m = mapLayout(bad, [dev("h1", "wide")]);
  assert.deepEqual(m.cells.map((c) => c.id), ["ok"]);
  assert.equal(m.problems.length, 5);
  assert.match(m.problems[0], /wide needs x, y, w, h inside the 500 x 400 plan/);
  assert.deepEqual(m.offMap.map((w) => w.device_id), ["h1"]);
});

test("mapLayout says once when a floor plan has no width or height", () => {
  const m = mapLayout({ image: "p.png", zones: plan.zones }, [dev("h1", "W")]);
  assert.deepEqual(m.cells, []);
  assert.deepEqual(m.problems, ["Add the floor plan's width and height in pixels"]);
  assert.equal(m.offMap.length, 1);
});

test("mapLayout still draws a grid when there is no image", () => {
  const m = mapLayout(grid, []);
  assert.equal(m.mode, "grid");
  assert.equal(m.image, null);
  assert.equal(m.cells.length, 2);
});

test("the shipped zones.json is a valid floor plan with labeled zones", () => {
  const cfg = JSON.parse(readFileSync(new URL("../zones.json", import.meta.url), "utf8"));
  const m = mapLayout(cfg, []);
  assert.equal(m.mode, "plan");
  assert.deepEqual(m.problems, []);
  assert.equal(m.cells.length, cfg.zones.length);
  readFileSync(new URL(`../${cfg.image}`, import.meta.url)); // the image exists
  for (const z of cfg.zones) {
    assert.ok(z.label && z.label !== z.id, `zone ${z.id} has a readable label`);
    assert.ok(z.id.length <= 32, `zone ${z.id} fits the server's 32-character limit`);
    assert.ok(!/\s/.test(z.id), `zone ${z.id} has no spaces`);
  }
});
