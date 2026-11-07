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

// A zone's display name from zones.json ("1520 West"), or its ID when the file has no label.
export function zoneName(zonesConfig, id) {
  const zones = Array.isArray(zonesConfig?.zones) ? zonesConfig.zones : [];
  const z = zones.find((zone) => zone?.id === id);
  return typeof z?.label === "string" && z.label ? z.label : id;
}

// --- Location: beacons, GPS, or set by hand (2026-11-07) -----------------------
// The server says where each zone came from (zone_source): "beacon" (the helmet located itself
// with BLE beacons), "gps" (its GPS fix is inside a zone), or "manual" (set on a worker card).

const MEASURED = new Set(["beacon", "gps"]);
const SOURCE_TEXT = { beacon: "beacons", gps: "GPS", manual: "set by hand" };

export function isMeasured(source) {
  return MEASURED.has(source);
}

export function zoneSourceText(source) {
  return SOURCE_TEXT[source] ?? SOURCE_TEXT.manual; // older data has no source: it was by hand
}

// Where to put a worker: a zone the helmet measured wins over the one set by hand.
export function workerZone(device) {
  const l = device.latest;
  if (l && isMeasured(l.zone_source) && l.zone) return { zone: l.zone, source: l.zone_source };
  return { zone: device.zone ?? null, source: device.zone ? "manual" : null };
}

export function incidentPlace(inc, zonesConfig = null) {
  const how = isMeasured(inc.zone_source) ? ` (${zoneSourceText(inc.zone_source)})` : "";
  const zone = inc.zone ? `Zone ${zoneName(zonesConfig, inc.zone)}${how}` : "No zone";
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

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const positive = (v) => (isNum(v) && v > 0 ? v : 0);
const pct = (part, whole) => Math.round((part / whole) * 100000) / 1000; // percent, 3 decimals

// Places workers on the site map from dashboard/zones.json. Two kinds of map:
// - plan: zones.json has "image" (a floor plan), "width" and "height" (its size in pixels), and
//   each zone is a rectangle x, y, w, h in those pixels. Cells get left/top/width/height in %.
// - grid: zones.json has "cols" and "rows", and each zone a "col" and "row" (0 = top left).
// Workers with no zone, or a zone not in the file, go in offMap. Bad entries are skipped and
// listed in problems, so the page can say what is wrong instead of drawing a broken map.
export function mapLayout(zonesConfig, devices) {
  const plan = typeof zonesConfig?.image === "string" && zonesConfig.image !== "";
  const width = plan ? positive(zonesConfig.width) : 0;
  const height = plan ? positive(zonesConfig.height) : 0;
  const cols = !plan && Number.isInteger(zonesConfig?.cols) && zonesConfig.cols > 0 ? zonesConfig.cols : 0;
  const rows = !plan && Number.isInteger(zonesConfig?.rows) && zonesConfig.rows > 0 ? zonesConfig.rows : 0;
  const problems = [];
  if (plan && (!width || !height)) problems.push("Add the floor plan's width and height in pixels");
  const cells = [];
  const byId = new Map();
  const zones = Array.isArray(zonesConfig?.zones) ? zonesConfig.zones : [];
  for (const z of zones) {
    if (typeof z?.id !== "string" || !z.id) { problems.push("A zone has no id"); continue; }
    if (byId.has(z.id)) { problems.push(`Zone ${z.id} is listed twice`); continue; }
    const label = typeof z.label === "string" && z.label ? z.label : z.id;
    let cell;
    if (plan) {
      if (!width || !height) continue; // already reported once above
      const inside = [z.x, z.y, z.w, z.h].every(isNum) && z.w > 0 && z.h > 0
        && z.x >= 0 && z.y >= 0 && z.x + z.w <= width && z.y + z.h <= height;
      if (!inside) { problems.push(`Zone ${z.id} needs x, y, w, h inside the ${width} x ${height} plan`); continue; }
      cell = { id: z.id, label, left: pct(z.x, width), top: pct(z.y, height),
        width: pct(z.w, width), height: pct(z.h, height), workers: [] };
    } else {
      const inGrid = Number.isInteger(z.col) && Number.isInteger(z.row)
        && z.col >= 0 && z.col < cols && z.row >= 0 && z.row < rows;
      if (!inGrid) { problems.push(`Zone ${z.id} is outside the ${cols} x ${rows} grid`); continue; }
      cell = { id: z.id, label, col: z.col, row: z.row, workers: [] };
    }
    byId.set(z.id, cell);
    cells.push(cell);
  }
  const offMap = [];
  for (const d of devices) {
    const { zone } = workerZone(d);
    const cell = zone ? byId.get(zone) : undefined;
    (cell ? cell.workers : offMap).push(d);
  }
  for (const c of cells) c.workers.sort(byName);
  offMap.sort(byName);
  return {
    mode: plan ? "plan" : "grid", image: plan ? zonesConfig.image : null,
    width, height, cols, rows, cells, offMap, problems,
  };
}

// Text for a worker's dot on the map (also its tooltip), so the color is never the only cue.
export function dotLabel(device) {
  const level = device.latest?.heat_level ?? null;
  const info = heatInfo(level);
  const parts = [level ? `${info.label} heat risk` : info.label];
  if (!device.online) parts.push("offline");
  const where = workerZone(device);
  if (isMeasured(where.source)) parts.push(`located by ${zoneSourceText(where.source)}`);
  const l = device.latest;
  if (l?.gps_fix && l.lat != null && l.lon != null) parts.push(`GPS ${l.lat.toFixed(5)}, ${l.lon.toFixed(5)}`);
  return `${device.name}: ${parts.join(", ")}`;
}

// --- Fall markers on the floor plan (2026-11-07) -------------------------------

// A steady spot inside a zone for an incident (fractions of the zone's width and height), so
// its dot does not jump on every refresh. Kept to the lower part of the zone, because the
// zone's label and worker names sit at the top.
export function zoneSpot(id) {
  const a = (Math.imul(id, 2654435761) >>> 0) / 2 ** 32;
  const b = (Math.imul(id ^ 0x5bd1e995, 0x27d4eb2d) >>> 0) / 2 ** 32;
  return [Math.round((0.15 + 0.7 * a) * 1000) / 1000, Math.round((0.5 + 0.38 * b) * 1000) / 1000];
}

// Red dots for falls on the floor plan. A fall whose GPS position is on the plan (plan_x and
// plan_y, worked out by the server from zones.json gps_points) is drawn exactly there. Any
// other fall is drawn at a steady spot inside the zone it was recorded in, marked approximate.
// Dismissed falls, falls outside the time window, and falls with no place are left out.
// Returns markers oldest first, so newer ones are drawn on top.
export function fallMarkers(incidents, layout, { nowMs = Date.now(), hours = null } = {}) {
  if (layout?.mode !== "plan") return [];
  const cells = new Map(layout.cells.map((c) => [c.id, c]));
  const since = hours ? nowMs - hours * 3600 * 1000 : null;
  const out = [];
  for (const inc of incidents) {
    if (inc.type !== "fall" || inc.status === "dismissed") continue;
    if (since !== null && Date.parse(inc.ts) < since) continue;
    const base = { id: inc.id, status: inc.status, zone: inc.zone ?? null };
    const onPlan = isNum(inc.plan_x) && isNum(inc.plan_y)
      && inc.plan_x >= 0 && inc.plan_x <= layout.width && inc.plan_y >= 0 && inc.plan_y <= layout.height;
    if (onPlan) {
      out.push({ ...base, exact: true, source: "gps",
        left: pct(inc.plan_x, layout.width), top: pct(inc.plan_y, layout.height) });
      continue;
    }
    const cell = inc.zone ? cells.get(inc.zone) : undefined;
    if (!cell) continue;
    const [u, v] = zoneSpot(inc.id);
    out.push({ ...base, exact: false, source: inc.zone_source ?? "manual",
      left: Math.round((cell.left + cell.width * u) * 1000) / 1000,
      top: Math.round((cell.top + cell.height * v) * 1000) / 1000 });
  }
  return out.sort((a, b) => a.id - b.id);
}

// Tooltip text for a fall marker: where the dot is and how sure we are.
export function markerWhere(marker, zonesConfig) {
  if (marker.exact) return "at its GPS position";
  const zone = zoneName(zonesConfig, marker.zone);
  return `approximate: somewhere in ${zone} (zone ${marker.source === "manual" ? "set by hand" : `from ${zoneSourceText(marker.source)}`})`;
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
// text is the full description (tooltip, screen readers); badge is the short tag drawn on the
// map, or null when there is nothing to show, so empty zones stay quiet.
export function hazardView(entry) {
  const n = entry?.confirmed_count ?? 0;
  if (n === 0) return { shade: 0, text: "No confirmed incidents", badge: null };
  const s = entry.sample_count ?? 0;
  const sample = s ? ` (includes ${s} sample)` : "";
  const tag = s === 0 ? "" : s >= n ? " · sample" : " · incl. sample";
  return {
    shade: Math.min(n, 3),
    text: `${n} confirmed incident${n === 1 ? "" : "s"}${sample}`,
    badge: `${n} incident${n === 1 ? "" : "s"}${tag}`,
  };
}

// Heat layer for one zone: the highest heat index seen there in the time window.
export function zoneHeatView(entry) {
  const hi = entry?.max_heat_index_c ?? null;
  if (hi == null) return { level: null, text: "No heat readings", badge: null };
  const level = heatLevelFor(hi);
  return {
    level,
    text: `Max heat index ${fmt1(hi)} °C (${heatInfo(level).label})`,
    badge: `${fmt1(hi)} °C · ${heatInfo(level).label}`,
  };
}
