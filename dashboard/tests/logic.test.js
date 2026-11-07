import assert from "node:assert/strict";
import { test } from "node:test";

import { formatAgo, isSimulated, summarize } from "../logic.js";

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
