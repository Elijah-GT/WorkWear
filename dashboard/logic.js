// Pure functions used by the dashboard. No DOM access here, so `node --test` can test them.
// Field names and rules come from docs/PROTOCOL.md.

export const SIM_PREFIX = "sim-"; // PROTOCOL.md section 1

export function isSimulated(deviceId) {
  return typeof deviceId === "string" && deviceId.startsWith(SIM_PREFIX);
}

// Counts for the header tiles.
export function summarize(devices, incidents) {
  return {
    devices: devices.length,
    online: devices.filter((d) => d.online).length,
    simulated: devices.filter((d) => isSimulated(d.device_id)).length,
    incidents: incidents.length,
    newIncidents: incidents.filter((i) => i.status === "new").length,
  };
}

// "12 s ago", "3 min ago", "2 h ago".
export function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

// --- Workers (D2) -----------------------------------------------------------

// Heat risk levels, PROTOCOL.md section 7. Wording is "heat risk", never heat stress.
export const HEAT_LEVELS = {
  normal: { label: "Normal", css: "heat--normal" },
  caution: { label: "Caution", css: "heat--caution" },
  extreme_caution: { label: "Extreme caution", css: "heat--extreme-caution" },
  danger: { label: "Danger", css: "heat--danger" },
  extreme_danger: { label: "Extreme danger", css: "heat--extreme-danger" },
};
const NO_HEAT = { label: "No reading", css: "heat--none" };

export function heatInfo(level) {
  return HEAT_LEVELS[level] ?? NO_HEAT;
}

const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

// "Heat index 30.1 °C (air 29.4 °C, 41 % humidity)", using whatever readings exist.
export function formatReading(latest) {
  if (!latest) return "No readings yet";
  const parts = [];
  if (latest.temp_c != null) parts.push(`air ${fmt1(latest.temp_c)} °C`);
  if (latest.humidity_pct != null) parts.push(`${Math.round(latest.humidity_pct)} % humidity`);
  const extra = parts.length ? ` (${parts.join(", ")})` : "";
  if (latest.heat_index_c == null) return parts.length ? `No heat index${extra}` : "No temperature reading";
  return `Heat index ${fmt1(latest.heat_index_c)} °C${extra}`;
}

export function lastSeenText(device, nowMs) {
  if (!device.last_seen) return "No readings yet";
  return `Last seen ${formatAgo(nowMs - Date.parse(device.last_seen))}`;
}

// Options for a worker's zone picker: "No zone", every zone in zones.json, and the
// device's current zone if it is not in the file (so it is never silently changed).
export function zoneOptions(zonesConfig, currentZone) {
  const zones = zonesConfig?.zones ?? [];
  const options = [{ value: "", label: "No zone" }];
  for (const z of zones) options.push({ value: z.id, label: z.label ?? z.id });
  if (currentZone && !zones.some((z) => z.id === currentZone)) {
    options.push({ value: currentZone, label: `${currentZone} (not on map)` });
  }
  return options;
}

const MAX_NAME = 80; // server limit, server/app/models.py

// What to send when the name box is committed. Returns { body } to save,
// { error } to show, or {} when nothing changed.
export function namePatch(typed, currentName) {
  const name = (typed ?? "").trim();
  if (name === currentName) return {};
  if (!name) return { error: "Name can't be empty" };
  if (name.length > MAX_NAME) return { error: `Name must be ${MAX_NAME} characters or fewer` };
  return { body: { name } };
}

// What to send when a zone is picked ("" means no zone). null when unchanged.
export function zonePatch(selected, currentZone) {
  const zone = selected === "" ? null : selected;
  return zone === (currentZone ?? null) ? null : { zone };
}
