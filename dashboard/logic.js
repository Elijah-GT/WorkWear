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
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
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

// --- Incidents and fall alert (D3) -----------------------------------------

const INCIDENT_TITLES = { fall: "Fall", injury_report: "Injury report", hazard_report: "Hazard report" };

export function incidentTitle(type) {
  return INCIDENT_TITLES[type] ?? type;
}

const STATUS_BADGES = {
  new: { label: "New", css: "badge--new" },
  confirmed: { label: "Confirmed", css: "badge--confirmed" },
  dismissed: { label: "Dismissed", css: "badge--dismissed" },
};

// Badges for an incident row: status, then "Sample data" and "Arrived late" when they apply.
export function incidentBadges(inc) {
  const badges = [STATUS_BADGES[inc.status] ?? { label: inc.status, css: "badge--dismissed" }];
  if (inc.sample) badges.push({ label: "Sample data", css: "badge--sample" });
  if (inc.delayed) badges.push({ label: "Arrived late", css: "badge--late" });
  return badges;
}

// Who it happened to. worker_name is the name when the incident was created; it equals
// the device ID when the helmet was never renamed.
export function incidentWho(inc) {
  const name = inc.worker_name;
  const dev = inc.device_id;
  if (name && dev && name !== dev) return `${name} (${dev})`;
  return name || dev || "Manual report";
}

export function incidentPlace(inc) {
  const zone = inc.zone ? `Zone ${inc.zone}` : "No zone";
  if (inc.lat == null || inc.lon == null) return zone;
  return `${zone} · GPS ${inc.lat.toFixed(5)}, ${inc.lon.toFixed(5)}`;
}

// "15:04:06 (6 min ago)" for today, "5 Nov, 09:00:00 (30 h ago)" for older days.
// opts.locale and opts.timeZone are for tests; the page uses the browser's settings.
export function formatClock(ts, nowMs, opts = {}) {
  const at = new Date(ts);
  const { locale, timeZone } = opts;
  const day = (d) => d.toLocaleDateString("en-CA", { timeZone }); // YYYY-MM-DD, for comparing
  const time = at.toLocaleTimeString(locale, {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const ago = formatAgo(nowMs - at.getTime());
  if (day(at) === day(new Date(nowMs))) return `${time} (${ago})`;
  const date = at.toLocaleDateString(locale, { timeZone, day: "numeric", month: "short" });
  return `${date}, ${time} (${ago})`;
}

// Which falls should raise the alert banner. Incident IDs only go up, so `baseline` is the
// highest ID already looked at. On the first load (baseline null) nothing alerts: falls that
// happened before the page was opened are in the list but do not set off the alarm.
// If the highest ID went down, the server's database was reset, so everything in the list is new.
// Returns { baseline, falls } with falls newest first.
export function checkNewFalls(incidents, baseline) {
  const maxId = incidents.reduce((m, i) => Math.max(m, i.id), 0);
  if (baseline === null) return { baseline: maxId, falls: [] };
  const from = maxId < baseline ? 0 : baseline;
  const falls = incidents
    .filter((i) => i.id > from && i.type === "fall" && i.status === "new")
    .sort((a, b) => b.id - a.id);
  return { baseline: maxId, falls };
}

// --- Site map (D4) ----------------------------------------------------------

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

// Places workers on the zone grid from dashboard/zones.json. Workers with no zone, or a zone
// that is not in the file, go in offMap. Bad entries in the file are skipped and listed in
// problems so the page can say what is wrong instead of drawing a broken map.
export function mapLayout(zonesConfig, devices) {
  const cols = Number.isInteger(zonesConfig?.cols) && zonesConfig.cols > 0 ? zonesConfig.cols : 0;
  const rows = Number.isInteger(zonesConfig?.rows) && zonesConfig.rows > 0 ? zonesConfig.rows : 0;
  const problems = [];
  const cells = [];
  const byId = new Map();
  for (const z of zonesConfig?.zones ?? []) {
    if (typeof z?.id !== "string" || !z.id) { problems.push("A zone has no id"); continue; }
    if (byId.has(z.id)) { problems.push(`Zone ${z.id} is listed twice`); continue; }
    const inGrid = Number.isInteger(z.col) && Number.isInteger(z.row)
      && z.col >= 0 && z.col < cols && z.row >= 0 && z.row < rows;
    if (!inGrid) { problems.push(`Zone ${z.id} is outside the ${cols} x ${rows} grid`); continue; }
    const cell = { id: z.id, label: z.label ?? z.id, col: z.col, row: z.row, workers: [] };
    byId.set(z.id, cell);
    cells.push(cell);
  }
  const offMap = [];
  for (const d of devices) {
    const cell = d.zone ? byId.get(d.zone) : undefined;
    (cell ? cell.workers : offMap).push(d);
  }
  for (const c of cells) c.workers.sort(byName);
  offMap.sort(byName);
  return { cols, rows, cells, offMap, problems };
}

// Text for a worker's dot on the map (also its tooltip), so the color is never the only cue.
export function dotLabel(device) {
  const level = device.latest?.heat_level ?? null;
  const info = heatInfo(level);
  const parts = [level ? `${info.label} heat risk` : info.label];
  if (!device.online) parts.push("offline");
  const l = device.latest;
  if (l?.gps_fix && l.lat != null && l.lon != null) parts.push(`GPS ${l.lat.toFixed(5)}, ${l.lon.toFixed(5)}`);
  return `${device.name}: ${parts.join(", ")}`;
}

// --- Stretch: review, reports, hazard map (D5) --------------------------------

const ACTION_LABELS = { confirmed: "Confirm", dismissed: "Dismiss", new: "Mark new" };

// Status buttons for an incident row: every status except the current one.
export function statusActions(status) {
  return ["confirmed", "dismissed", "new"]
    .filter((s) => s !== status)
    .map((s) => ({ status: s, label: ACTION_LABELS[s] }));
}

const MAX_NOTES = 2000; // server limit, server/app/models.py

// What to send when a note is saved. { body }, { error }, or {} when unchanged. Empty clears it.
export function notesPatch(typed, currentNotes) {
  const notes = (typed ?? "").trim();
  if (notes === (currentNotes ?? "")) return {};
  if (notes.length > MAX_NOTES) return { error: `Notes must be ${MAX_NOTES} characters or fewer` };
  return { body: { notes } };
}

const REPORT_TYPES = ["injury_report", "hazard_report"];

// Body for POST /api/incidents from the report form, or { error }. A chosen helmet wins over a
// typed name: the server copies that helmet's current name (PROTOCOL.md section 5).
export function reportBody(form) {
  if (!REPORT_TYPES.includes(form.type)) return { error: "Pick a report type" };
  const zone = (form.zone ?? "").trim();
  if (!zone) return { error: "Pick the zone where it happened" };
  const notes = (form.notes ?? "").trim();
  if (notes.length > MAX_NOTES) return { error: `Notes must be ${MAX_NOTES} characters or fewer` };
  const body = { type: form.type, zone, notes };
  if (form.deviceId) {
    body.device_id = form.deviceId;
  } else {
    const name = (form.workerName ?? "").trim();
    if (name.length > MAX_NAME) return { error: `Name must be ${MAX_NAME} characters or fewer` };
    if (name) body.worker_name = name;
  }
  return { body };
}

// Heat index (°C) to heat level, same bands as the server (PROTOCOL.md section 7).
// Used for the map's heat layer, where /api/hazards gives only the number.
export function heatLevelFor(hi) {
  if (hi == null) return null;
  if (hi < 27) return "normal";
  if (hi < 32) return "caution";
  if (hi < 39) return "extreme_caution";
  if (hi < 51) return "danger";
  return "extreme_danger";
}

// Incident layer for one zone of GET /api/hazards. Only confirmed incidents count. shade 0-3.
export function hazardView(entry) {
  const n = entry?.confirmed_count ?? 0;
  if (n === 0) return { shade: 0, text: "No confirmed incidents" };
  const sample = entry.sample_count ? ` (includes ${entry.sample_count} sample)` : "";
  return { shade: Math.min(n, 3), text: `${n} confirmed incident${n === 1 ? "" : "s"}${sample}` };
}

// Heat layer for one zone: the highest heat index seen there in the time window.
export function zoneHeatView(entry) {
  const hi = entry?.max_heat_index_c ?? null;
  if (hi == null) return { level: null, text: "No heat readings" };
  const level = heatLevelFor(hi);
  return { level, text: `Max heat index ${fmt1(hi)} °C (${heatInfo(level).label})` };
}
