import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatAgo, formatReading, heatInfo, isSimulated, lastSeenText, namePatch, summarize,
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
