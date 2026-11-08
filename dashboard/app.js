// Dashboard entry point: loads data from the server every second, keeps the address (#/map,
// #/incident/42, ...) in sync with what is shown, and draws the current section.
// All text from the server (names, notes) is inserted with textContent, never as HTML.

import { getJSON, patchJSON, postJSON } from "./api.js";
import {
  SHOW_HEAT, STATUS_FILTERS, alertSummary, checkNewFalls, filterIncidents, formatAgo, formatClock, heatInfo, heatRows,
  incidentPills, incidentTimeline, incidentTitle, incidentWho, isMeasured, isSimulated, lastSeenText, locationText,
  mapLayout, namePatch, notesPatch, parseRoute, reportBody, routeHash, sampleState, searchWorkers, statusActions,
  statusPill, summarize, tableTime, workerStatus, workerZone, zoneName, zoneOptions, zonePatch,
} from "./logic.js";
import { createPlanMap } from "./map.js";
import { $, avatar, el, flash, setAvatar, setFacts, setPills, setText, syncList } from "./ui.js";

const REFRESH_MS = 1000;       // devices and incidents
const INCIDENT_LIMIT = 200;    // most recent incidents to load

const state = {
  zones: null,          // dashboard/zones.json
  site: null,           // GET /api/site: can GPS positions go on the plan?
  devices: [],
  incidents: [],
  hazards: [],          // GET /api/hazards: confirmed counts and highest heat index per zone
  lastOkAt: null,       // Date.now() of the last successful refresh
  error: null,          // message if the last refresh failed
  alertBaseline: null,  // highest incident id already checked for falls (logic.js checkNewFalls)
  alerts: [],           // falls that arrived while the page was open and are not hidden yet, newest first
  alertShownAt: new Map(), // incident id -> when this screen first showed its alert (for the timeline)
  hours: null,          // map time window in hours; null = all time
  route: parseRoute(location.hash),
  query: "",            // worker search
  statusFilter: "",     // incidents table filter ("" = all)
  selectedZone: null,   // zone whose incidents are listed next to the map
  flashId: null,        // incident row to scroll to and highlight ("Show in list")
  sample: { any: false, mixed: false },
};

const BASE_TITLE = document.title;

// --- Loading -----------------------------------------------------------------

async function loadZones() {
  try {
    state.zones = await getJSON("zones.json");
    setText("site-name", state.zones.site ? `${state.zones.site}.` : "");
  } catch (err) {
    setText("site-name", `Could not load zones.json (${err.message}); retrying.`);
    setTimeout(loadZones, 5000); // the rest of the page keeps refreshing meanwhile
  }
  try {
    state.site = await getJSON("/api/site");
  } catch {
    state.site = null; // older server, or not reachable yet: falls are drawn in their zones
  }
  render();
}

// Heat switched off (logic.js SHOW_HEAT): CSS hides every .heat-only part of the page.
document.documentElement.classList.toggle("no-heat", !SHOW_HEAT);

let timer = null;
let inFlight = false;
let againAfter = false;

// The map summary (/api/hazards) is the slowest request (0.5-3 s once the simulator has
// filled the database), and confirmed counts and peak heat change slowly. So it runs on
// its own, at most every HAZARDS_MS, and never holds up worker readings or fall alerts
// (bench, 2026-11-07: waiting on it made every refresh fail and a real fall never showed).
const HAZARDS_MS = 10000;
let hazardsAt = 0;
let hazardsInFlight = false;
function refreshHazards(force = false) {
  if (hazardsInFlight || (!force && Date.now() - hazardsAt < HAZARDS_MS)) return;
  hazardsInFlight = true;
  hazardsAt = Date.now();
  getJSON(`/api/hazards${state.hours ? `?hours=${state.hours}` : ""}`)
    .then((h) => { state.hazards = h; render(); })
    .catch(() => {})  // keep the last map data; the connection status comes from refresh()
    .finally(() => { hazardsInFlight = false; });
}

async function refresh() {
  if (inFlight) { againAfter = true; return; }
  inFlight = true;
  clearTimeout(timer);
  refreshHazards();
  try {
    const [devices, incidents] = await Promise.all([
      getJSON("/api/devices"),
      getJSON(`/api/incidents?limit=${INCIDENT_LIMIT}`),
    ]);
    state.devices = devices;
    state.incidents = incidents;
    // A fall that was confirmed or dismissed has been dealt with, so its alert goes away.
    const statusById = new Map(incidents.map((i) => [i.id, i.status]));
    state.alerts = state.alerts
      .filter((a) => (statusById.get(a.id) ?? "new") === "new")
      .map((a) => incidents.find((i) => i.id === a.id) ?? a);
    const found = checkNewFalls(incidents, state.alertBaseline);
    state.alertBaseline = found.baseline;
    if (found.falls.length) {
      const at = new Date().toISOString();
      for (const f of found.falls) if (!state.alertShownAt.has(f.id)) state.alertShownAt.set(f.id, at);
      state.alerts = [...found.falls, ...state.alerts];
      beep();
    }
    state.sample = sampleState(devices, incidents);
    state.lastOkAt = Date.now();
    state.error = null;
  } catch (err) {
    state.error = err.message || String(err);
  }
  inFlight = false;
  render();
  if (againAfter) { againAfter = false; refresh(); return; }
  timer = setTimeout(refresh, REFRESH_MS);
}

// After a change (confirm, dismiss, time window), update the map summary at once too.
const refreshNow = () => { hazardsAt = 0; refresh(); };

// --- Address: which section or page is showing ---------------------------------

function go(view, id = null) {
  const hash = routeHash(view, id);
  if (location.hash === hash) onRoute();
  else location.hash = hash;
}

function onRoute() {
  const prev = state.route;
  state.route = parseRoute(location.hash);
  document.body.dataset.section = state.route.section;
  document.body.dataset.view = state.route.view;
  for (const a of document.querySelectorAll(".rail__item")) {
    const here = a.dataset.section === state.route.section;
    a.classList.toggle("rail__item--here", here);
    if (here) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  if (prev.view !== state.route.view || prev.id !== state.route.id) {
    $("main").scrollTop = 0;
    closeNoteEditor();
    flash($("ip-msg"), "");
    flash($("wp-msg"), "");
  }
  render();
}
window.addEventListener("hashchange", onRoute);

// --- Header: connection, sample badge, section counts ---------------------------

function connectionText() {
  if (!state.error) return state.lastOkAt ? "Connected" : "Connecting…";
  return state.lastOkAt ? `Can't reach server (last update ${formatAgo(Date.now() - state.lastOkAt)})` : "Can't reach server";
}

function renderHeader() {
  const conn = $("conn");
  conn.className = `conn ${state.error ? "conn--down" : state.lastOkAt ? "conn--up" : "conn--wait"}`;
  setText(conn, connectionText());
  conn.title = state.error ?? "";
  if (state.lastOkAt === null) return;
  $("sample-badge").hidden = !state.sample.any;
  const s = summarize(state.devices, state.incidents);
  setText("count-workers", s.devices ? `${s.online}/${s.devices}` : "");
  setText("count-incidents", s.newIncidents ? String(s.newIncidents) : "");
  $("count-incidents").classList.toggle("rail__count--alert", s.newIncidents > 0);
}

// --- Fall alert: one slim line in a fixed slot ------------------------------------

function renderAlert() {
  const box = $("alert");
  const active = state.alerts.length > 0;
  const want = active ? "active" : "idle";
  if (box.dataset.state !== want) box.dataset.state = want;
  $("alert-summary").hidden = !active;
  $("alert-show").hidden = !active;
  $("alert-hide").hidden = !active;
  if (!active) {
    setText("alert-label", "No fall alerts");
    setText("alert-more", "");
    document.title = BASE_TITLE;
    return;
  }
  const fall = state.alerts[0];
  setText("alert-label", "FALL");
  setText("alert-summary", alertSummary(fall, state.zones));
  $("alert-summary").href = routeHash("incident", fall.id);
  $("alert-summary").title = `Open fall #${fall.id}`;
  const more = state.alerts.length - 1;
  setText("alert-more", more ? `+${more} more new fall${more > 1 ? "s" : ""}` : "");
  document.title = `(${state.alerts.length}) FALL · ${BASE_TITLE}`;
}

$("alert-hide").addEventListener("click", () => {
  state.alerts = [];
  render();
});

$("alert-show").addEventListener("click", (e) => {
  e.preventDefault();
  if (!state.alerts[0]) return;
  state.flashId = state.alerts[0].id;
  state.statusFilter = "";
  $("inc-status").value = "";
  go("incidents");
});

// Optional sound. Browsers only allow audio after a click on the page, so it starts off.
let audio = null;
let soundOn = false;

function beep() {
  if (!audio || audio.state !== "running") return;
  const t0 = audio.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "square";
    osc.frequency.value = i % 2 ? 660 : 880;
    gain.gain.setValueAtTime(0.15, t0 + i * 0.25);
    gain.gain.setValueAtTime(0, t0 + i * 0.25 + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + i * 0.25);
    osc.stop(t0 + i * 0.25 + 0.2);
  }
}

function showSound(text) {
  setText("sound", text ?? `Sound ${soundOn ? "on" : "off"}`);
  setText("sound-2", text ?? `Turn alert sound ${soundOn ? "off" : "on"}`);
  for (const id of ["sound", "sound-2"]) $(id).setAttribute("aria-pressed", String(soundOn));
}

async function toggleSound() {
  const turnOn = !soundOn;
  try {
    if (turnOn) {
      audio ??= new AudioContext();
      await audio.resume();
      beep(); // test sound, so the supervisor knows it works
    } else if (audio) {
      await audio.suspend();
    }
    soundOn = turnOn;
    showSound();
  } catch (err) {
    showSound("Sound not available");
    $("sound").title = err.message;
  }
}
$("sound").addEventListener("click", toggleSound);
$("sound-2").addEventListener("click", toggleSound);

// --- Worker list beside the rail ----------------------------------------------------

const people = new Map();

function buildPerson() {
  const li = el("li");
  const a = el("a", "person");
  const av = avatar("none");
  const text = el("span", "person__text");
  const name = el("span", "person__name");
  const id = el("span", "person__id");
  text.append(name, id);
  const online = el("span", "person__online");
  a.append(av, text, online);
  li.append(a);
  return { root: li, a, av, name, id, online };
}

function updatePerson(p, d) {
  const fallen = new Set(state.alerts.map((x) => x.device_id));
  const st = workerStatus(d, fallen);
  setAvatar(p.av, st.key, st.label);
  setText(p.name, d.name);
  setText(p.id, d.device_id);
  p.online.className = `person__online${d.online ? " person__online--on" : ""}`;
  p.online.title = d.online ? "Online" : "Offline";
  const href = routeHash("worker", d.device_id);
  if (p.a.getAttribute("href") !== href) p.a.setAttribute("href", href);
  const here = state.route.view === "worker" && state.route.id === d.device_id;
  p.a.classList.toggle("person--here", here);
  p.a.title = `${d.name} (${d.device_id}): ${st.label}`;
}

function renderPeople() {
  const list = searchWorkers(state.devices, state.query);
  syncList($("people"), list, (d) => d.device_id, buildPerson, updatePerson, people);
  const empty = $("people-empty");
  empty.hidden = list.length > 0;
  setText(empty, state.devices.length ? `No workers match "${state.query.trim()}".` : "No helmets yet.");
}

for (const id of ["people-q", "workers-q"]) {
  $(id).addEventListener("input", (e) => {
    state.query = e.target.value;
    for (const other of ["people-q", "workers-q"]) if ($(other) !== e.target) $(other).value = state.query;
    render();
  });
}

// --- Map section ------------------------------------------------------------------

const mainMap = createPlanMap($("map-main"), {
  layer: "incidents",
  onZone: (zone) => { state.selectedZone = state.selectedZone === zone ? null : zone; render(); },
  onWorker: (id) => go("worker", id),
  onMarker: (id) => go("incident", id),
});

function sinceMs() {
  return state.hours ? Date.now() - state.hours * 3600 * 1000 : null;
}

// Say honestly where worker locations come from: set by hand, or measured by the helmet.
function renderLocationLabels() {
  const measured = state.devices.some((d) => isMeasured(workerZone(d).source));
  const tag = $("map-loc-tag");
  setText(tag, measured ? "Location: measured where marked" : "Simulated location");
  tag.className = `pill ${measured ? "pill--measured" : "pill--sim"}`;
  setText("map-loc-note", measured
    ? "Workers with a blue ring are located by beacons or GPS; the others are in the zone set on the dashboard (simulated). Click a zone to list its incidents."
    : "Zones are set on the dashboard, not measured. Click a zone to list its incidents.");
}

function renderMapView() {
  const res = mainMap.update({
    zonesConfig: state.zones, devices: state.devices, hazards: state.hazards, alerts: state.alerts,
    selectedZone: state.selectedZone, offList: $("map-off"),
  });
  const issues = [...(res.problems ?? []), ...(state.site?.problems ?? [])];
  $("map-problems").hidden = issues.length === 0;
  setText("map-problems", issues.length ? `Check dashboard/zones.json: ${issues.join("; ")}.` : "");
  $("map-off").parentElement.hidden = !res.layout || res.layout.offMap.length === 0;
  renderLocationLabels();
  renderZonePanel();
}

const zoneRows = new Map();

function renderZonePanel() {
  const panel = $("zonepanel");
  const zone = state.selectedZone;
  panel.hidden = !zone;
  if (!zone) return;
  const list = filterIncidents(state.incidents, { zone, sinceMs: sinceMs() });
  const confirmed = list.filter((i) => i.status === "confirmed").length;
  setText("zp-title", zoneName(state.zones, zone));
  setText("zp-sub", list.length
    ? `${list.length} incident${list.length === 1 ? "" : "s"}${state.hours ? ` in the last ${state.hours} h` : ""}; ${confirmed} confirmed (counted on the map).`
    : `No incidents here${state.hours ? ` in the last ${state.hours} h` : ""}.`);
  syncList($("zp-list"), list, (i) => i.id, () => {
    const li = el("li");
    const a = el("a", "minirow");
    const top = el("span", "minirow__top");
    const what = el("strong");
    const pills = el("span", "pills");
    top.append(what, pills);
    const sub = el("span", "minirow__sub");
    a.append(top, sub);
    li.append(a);
    return { root: li, a, what, pills, sub };
  }, (r, inc) => {
    r.a.setAttribute("href", routeHash("incident", inc.id));
    setText(r.what, `${incidentTitle(inc.type)} · ${inc.worker_name || inc.device_id || "Manual report"}`);
    setPills(r.pills, incidentPills(inc, { showSample: state.sample.mixed }));
    const t = tableTime(inc.ts, Date.now());
    setText(r.sub, `${t.when} (${t.ago})${inc.peak_g != null ? ` · ${inc.peak_g} g` : ""}`);
  }, zoneRows);
}

$("zp-close").addEventListener("click", () => { state.selectedZone = null; render(); });

for (const sel of document.querySelectorAll("[data-hours]")) {
  sel.addEventListener("change", (e) => {
    state.hours = e.target.value ? Number(e.target.value) : null;
    for (const other of document.querySelectorAll("[data-hours]")) other.value = e.target.value;
    refreshNow();
  });
}

// Setting up GPS placement: open the page with ?calibrate and click a spot on the plan (for
// example a building corner) to read its position in image pixels, for zones.json gps_points.
if (new URLSearchParams(location.search).has("calibrate")) {
  const out = el("p", "calibrate", "Calibrate: click a spot on the floor plan to see its x, y in image pixels.");
  $("map-main").after(out);
  mainMap.element.addEventListener("click", (e) => {
    const layout = mapLayout(state.zones, []);
    if (layout.mode !== "plan") return;
    const r = mainMap.element.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * layout.width);
    const y = Math.round(((e.clientY - r.top) / r.height) * layout.height);
    setText(out, `Clicked: "x": ${x}, "y": ${y} (image pixels). Pair it with the spot's lat/lon from a map for gps_points in zones.json.`);
  });
}

// --- Workers section -------------------------------------------------------------------

const workerRows = new Map();

// A zone cell: the zone's name, and under it how the location was found.
function zoneCell(td, zone, source) {
  if (!td.firstChild) td.append(el("span", "cell__main"), el("span", "cell__sub"));
  setText(td.children[0], zone ? zoneName(state.zones, zone) : "No zone");
  setText(td.children[1], zone ? (isMeasured(source) ? locationText(source) : "Simulated location") : "");
}

function renderWorkersView() {
  const list = searchWorkers(state.devices, state.query);
  const now = Date.now();
  const fallen = new Set(state.alerts.map((a) => a.device_id));
  syncList($("workers-rows"), list, (d) => d.device_id, () => {
    const tr = el("tr", "row--link");
    const who = el("td", "cell--who");
    const av = avatar("none");
    const a = el("a", "cell__main");
    const id = el("span", "cell__sub");
    const text = el("span", "who__text");
    text.append(a, id);
    who.append(av, text);
    const status = el("td");
    const pills = el("span", "pills");
    status.append(pills);
    const zone = el("td");
    const hi = el("td", "num");
    const seen = el("td");
    tr.append(who, status, zone, hi, seen);
    tr.addEventListener("click", (e) => { if (!e.target.closest("a")) go("worker", tr.dataset.id); });
    return { root: tr, av, a, id, pills, zone, hi, seen };
  }, (r, d) => {
    r.root.dataset.id = d.device_id;
    const st = workerStatus(d, fallen);
    setAvatar(r.av, st.key, st.label);
    setText(r.a, d.name);
    r.a.setAttribute("href", routeHash("worker", d.device_id));
    setText(r.id, d.device_id);
    const pills = [d.online ? { label: "Online", css: "pill--online" } : { label: "Offline", css: "pill--offline" }];
    if (fallen.has(d.device_id)) pills.unshift({ label: "New fall", css: "pill--pending" });
    if (d.latest && !d.latest.worn) pills.push({ label: "Helmet off", css: "pill--late" });
    if (isSimulated(d.device_id) && state.sample.mixed) pills.push({ label: "Simulated", css: "pill--sample" });
    setPills(r.pills, pills);
    const where = workerZone(d);
    zoneCell(r.zone, where.zone, where.source);
    // Air temperature at the helmet (per worker; no heat section or heat colors while SHOW_HEAT is off).
    const airC = d.latest?.temp_c;
    setText(r.hi, airC == null ? "–" : `${airC.toFixed(1)} °C`);
    r.hi.title = "Air temperature at the helmet, not body temperature";
    setText(r.seen, lastSeenText(d, now));
  }, workerRows);
  const empty = $("workers-empty");
  empty.hidden = list.length > 0;
  setText(empty, state.devices.length ? `No workers match "${state.query.trim()}".` : "No helmets yet. They appear here when they send their first reading.");
}

// --- Incidents table (Incidents section and worker profile) -------------------------------

function buildIncidentRow() {
  const tr = el("tr", "row--link");
  const when = el("td", "cell--when");
  const whenMain = el("span", "cell__main");
  const whenAgo = el("span", "cell__sub");
  when.append(whenMain, whenAgo);
  const who = el("td");
  const zone = el("td");
  const type = el("td");
  const peak = el("td", "num");
  const status = el("td");
  const pills = el("span", "pills");
  status.append(pills);
  const open = el("td", "cell--open");
  const view = el("a", "viewlink", "View");
  open.append(view);
  tr.append(when, who, zone, type, peak, status, open);
  tr.addEventListener("click", (e) => { if (!e.target.closest("a")) go("incident", Number(tr.dataset.id)); });
  return { root: tr, whenMain, whenAgo, who, zone, type, peak, pills, view };
}

function updateIncidentRow(r, inc, now, alerting) {
  r.root.dataset.id = String(inc.id);
  r.root.classList.toggle("row--alert", alerting.has(inc.id));
  const t = tableTime(inc.ts, now);
  setText(r.whenMain, t.when);
  setText(r.whenAgo, t.ago);
  setText(r.who, incidentWho(inc));
  zoneCell(r.zone, inc.zone, inc.zone_source);
  setText(r.type, incidentTitle(inc.type));
  setText(r.peak, inc.peak_g != null ? `${inc.peak_g} g` : "–");
  setPills(r.pills, incidentPills(inc, { showSample: state.sample.mixed }));
  r.view.setAttribute("href", routeHash("incident", inc.id));
  r.view.setAttribute("aria-label", `View ${incidentTitle(inc.type).toLowerCase()} #${inc.id}`);
}

function renderIncidentRows(tbody, list, cache) {
  const now = Date.now();
  const alerting = new Set(state.alerts.map((a) => a.id));
  syncList(tbody, list, (i) => i.id, buildIncidentRow, (r, inc) => updateIncidentRow(r, inc, now, alerting), cache);
}

const incidentRowCache = new Map();

$("inc-status").replaceChildren(...STATUS_FILTERS.map((f) => {
  const o = el("option", null, f.label);
  o.value = f.value;
  return o;
}));
$("inc-status").addEventListener("change", (e) => { state.statusFilter = e.target.value; render(); });

function renderIncidentsView() {
  const list = filterIncidents(state.incidents, { status: state.statusFilter });
  renderIncidentRows($("inc-rows"), list, incidentRowCache);
  const empty = $("inc-empty");
  empty.hidden = list.length > 0;
  setText(empty, state.incidents.length ? "No incidents with this status." : "No incidents yet.");
  if (state.flashId !== null) {
    const row = incidentRowCache.get(state.flashId);
    state.flashId = null;
    if (row) {
      row.root.scrollIntoView({ behavior: "smooth", block: "center" });
      row.root.classList.remove("row--flash");
      void row.root.offsetWidth; // restart the highlight
      row.root.classList.add("row--flash");
    }
  }
  if (!form.hidden) fillReportOptions();
}

// Manual report form: injuries and hazards (e.g. a wet floor); the helmet cannot detect them.
const form = $("report");
let reportKey = null;

function fillReportOptions() {
  const zones = zoneOptions(state.zones, null).slice(1); // every zone, without "No zone"
  const workers = state.devices.map((d) => ({
    value: d.device_id, label: d.name === d.device_id ? d.name : `${d.name} (${d.device_id})`,
  }));
  const key = JSON.stringify([zones, workers]);
  if (key === reportKey || form.contains(document.activeElement)) return;
  const fill = (select, first, options) => {
    const keep = select.value;
    select.replaceChildren(...[first, ...options].map((o) => {
      const opt = el("option", null, o.label);
      opt.value = o.value;
      return opt;
    }));
    select.value = [first, ...options].some((o) => o.value === keep) ? keep : "";
  };
  fill(form.elements.zone, { value: "", label: "Pick a zone" }, zones);
  fill(form.elements.device, { value: "", label: "No helmet / not listed" }, workers);
  reportKey = key;
  updateNameField();
}

function updateNameField() {
  $("report-name-row").hidden = form.elements.device.value !== "";
}

function setReportOpen(open) {
  form.hidden = !open;
  $("report-open").setAttribute("aria-expanded", String(open));
  if (open) {
    reportKey = null;
    fillReportOptions();
    form.elements.type[0].focus();
  }
}

$("report-open").addEventListener("click", () => {
  flash($("report-msg"), "");
  setReportOpen(form.hidden);
});
$("report-cancel").addEventListener("click", () => { form.reset(); setReportOpen(false); $("report-open").focus(); });
form.elements.device.addEventListener("change", updateNameField);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = form.elements;
  const result = reportBody({
    type: f.type.value, zone: f.zone.value, deviceId: f.device.value, workerName: f.name.value, notes: f.notes.value,
  });
  if (result.error) { flash($("report-msg"), result.error, true); return; }
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const inc = await postJSON("/api/incidents", result.body);
    form.reset();
    setReportOpen(false);
    flash($("report-msg"), `${incidentTitle(inc.type)} #${inc.id} saved. Confirm it for it to count on the map.`);
    $("report-open").focus();
    refreshNow();
  } catch (err) {
    flash($("report-msg"), `Couldn't save the report: ${err.message}`, true);
  } finally {
    submit.disabled = false;
  }
});

// --- Incident page ----------------------------------------------------------------------------

const incidentMap = createPlanMap($("map-incident"), { layer: "none", mini: true, onWorker: (id) => go("worker", id) });
let actionsKey = null;
let noteFor = null; // incident id whose note is being edited

function currentIncident() {
  return state.route.view === "incident" ? state.incidents.find((i) => i.id === state.route.id) ?? null : null;
}

async function patchIncident(id, body, what) {
  for (const b of $("ip-actions").querySelectorAll("button")) b.disabled = true;
  try {
    await patchJSON(`/api/incidents/${id}`, body);
    flash($("ip-msg"), `${what} saved`);
    refreshNow();
    return true;
  } catch (err) {
    flash($("ip-msg"), `Couldn't save ${what.toLowerCase()}: ${err.message}`, true);
    return false;
  } finally {
    for (const b of $("ip-actions").querySelectorAll("button")) b.disabled = false;
  }
}

function closeNoteEditor() {
  noteFor = null;
  $("ip-noteedit").hidden = true;
}

$("ip-note-cancel").addEventListener("click", closeNoteEditor);
$("ip-notes").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); closeNoteEditor(); }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("ip-note-save").click(); }
});
$("ip-note-save").addEventListener("click", async () => {
  const inc = state.incidents.find((i) => i.id === noteFor);
  if (!inc) { closeNoteEditor(); return; }
  const result = notesPatch($("ip-notes").value, inc.notes);
  if (result.error) { flash($("ip-msg"), result.error, true); return; }
  if (result.body && !(await patchIncident(inc.id, result.body, "Note"))) return;
  closeNoteEditor();
});

function renderIncidentPage() {
  const inc = currentIncident();
  $("ip-body").hidden = !inc;
  $("ip-pills").hidden = !inc;
  $("ip-missing").hidden = !!inc;
  if (!inc) {
    setText("ip-title", `Incident #${state.route.id}`);
    setText("ip-missing", `Incident #${state.route.id} is not in the latest ${INCIDENT_LIMIT} incidents.`);
    return;
  }
  const now = Date.now();
  setText("ip-title", `${incidentTitle(inc.type)} #${inc.id}`);
  setPills($("ip-pills"), incidentPills(inc, { showSample: true }));

  const res = incidentMap.update({ zonesConfig: state.zones, devices: state.devices, focus: inc });
  const zone = inc.zone ? zoneName(state.zones, inc.zone) : null;
  setText("ip-mapnote", res.focusSpot?.exact ? "Shown at its GPS position."
    : res.focusSpot ? `Marked somewhere in ${zone}; the exact spot is not known. Zone: ${locationText(inc.zone_source).toLowerCase()}.`
      : zone ? `${zone} is not on the floor plan.` : "No zone was recorded, so it is not on the map.");

  const nearby = inc.zone ? searchWorkers(state.devices, "").filter((d) => workerZone(d).zone === inc.zone) : [];
  const ul = $("ip-nearby");
  const key = JSON.stringify(nearby.map((d) => [d.device_id, d.name, workerStatus(d).key]));
  if (ul.dataset.key !== key) {
    ul.dataset.key = key;
    ul.replaceChildren(...(nearby.length ? nearby.map((d) => {
      const li = el("li");
      const a = el("a", "minirow minirow--inline");
      const st = workerStatus(d);
      a.append(avatar(st.key), el("span", null, d.name), el("span", "cell__sub", d.device_id));
      a.setAttribute("href", routeHash("worker", d.device_id));
      li.append(a);
      return li;
    }) : [el("li", "muted", inc.zone ? "Nobody is in this zone now." : "No zone recorded.")]));
  }

  const rows = [
    ["Worker", incidentWho(inc)],
    ["Helmet", inc.device_id ?? "None (entered by hand)"],
    ["When", formatClock(inc.ts, now)],
    ["Zone", zone ?? "No zone"],
    ["Location", locationText(inc.zone_source, !!inc.zone)],
  ];
  if (inc.lat != null && inc.lon != null) rows.push(["GPS", `${inc.lat.toFixed(5)}, ${inc.lon.toFixed(5)}`]);
  if (inc.type === "fall") rows.push(["Peak", inc.peak_g != null ? `${inc.peak_g} g` : null]);
  rows.push(["Status", statusPill(inc.status).label]);
  rows.push(["Notes", inc.notes || "None"]);
  if (inc.sample) rows.push(["Data", "Sample data from a simulated helmet, not a real incident"]);
  setFacts($("ip-facts"), rows);

  const aKey = `${inc.id}|${inc.status}|${!!inc.notes}`;
  if (aKey !== actionsKey) {
    actionsKey = aKey;
    const buttons = statusActions(inc.status).map((a) => {
      const b = el("button", `btn${a.status === "confirmed" ? " btn--primary" : ""}`, a.label);
      b.type = "button";
      b.addEventListener("click", () => patchIncident(inc.id, { status: a.status }, "Status"));
      return b;
    });
    const note = el("button", "btn", inc.notes ? "Edit note" : "Add note");
    note.type = "button";
    note.addEventListener("click", () => {
      const cur = state.incidents.find((i) => i.id === inc.id);
      noteFor = inc.id;
      $("ip-notes").value = cur?.notes ?? "";
      $("ip-noteedit").hidden = false;
      $("ip-notes").focus();
    });
    $("ip-actions").replaceChildren(...buttons, note);
  }

  const steps = incidentTimeline(inc, { alertShownAt: state.alertShownAt.get(inc.id) ?? null });
  const tl = $("ip-timeline");
  const tKey = JSON.stringify(steps) + Math.floor(now / 60000);
  if (tl.dataset.key !== tKey) {
    tl.dataset.key = tKey;
    tl.replaceChildren(...steps.map((s) => {
      const li = el("li", `timeline__step${s.done ? " timeline__step--done" : ""}`);
      li.append(el("span", "timeline__label", s.label));
      if (s.ts) li.append(el("span", "timeline__time", formatClock(s.ts, now)));
      return li;
    }));
  }
}

// --- Worker profile --------------------------------------------------------------------------

const profileRows = new Map();
let zoneKey = null;

function currentWorker() {
  return state.route.view === "worker" ? state.devices.find((d) => d.device_id === state.route.id) ?? null : null;
}

async function patchDevice(id, body, what) {
  try {
    await patchJSON(`/api/devices/${encodeURIComponent(id)}`, body);
    flash($("wp-msg"), `${what} saved`);
    refreshNow();
  } catch (err) {
    flash($("wp-msg"), `Couldn't save ${what.toLowerCase()}: ${err.message}`, true);
    const d = currentWorker();
    if (d && "name" in body) $("wp-name").value = d.name;
    if (d && "zone" in body) $("wp-zone").value = d.zone ?? "";
  }
}

$("wp-name").addEventListener("keydown", (e) => {
  const d = currentWorker();
  if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  if (e.key === "Escape" && d) { e.target.value = d.name; e.target.blur(); }
});
$("wp-name").addEventListener("blur", (e) => {
  const d = currentWorker();
  if (!d) return;
  const result = namePatch(e.target.value, d.name);
  if (result.error) { flash($("wp-msg"), result.error, true); e.target.value = d.name; return; }
  if (result.body) patchDevice(d.device_id, result.body, "Name");
});
$("wp-zone").addEventListener("change", (e) => {
  const d = currentWorker();
  if (!d) return;
  const body = zonePatch(e.target.value, d.zone);
  if (body) patchDevice(d.device_id, body, "Zone");
});

function renderWorkerPage() {
  const d = currentWorker();
  $("wp-body").hidden = !d;
  $("wp-missing").hidden = !!d;
  if (!d) {
    setText("wp-missing", `No helmet with ID "${state.route.id}". A helmet shows up after its first reading.`);
    return;
  }
  const now = Date.now();
  const fallen = new Set(state.alerts.map((a) => a.device_id));
  const st = workerStatus(d, fallen);
  setAvatar($("wp-avatar"), st.key, st.label);
  setText("wp-title", d.name);
  if (document.activeElement !== $("wp-name")) $("wp-name").value = d.name;
  const pills = [d.online ? { label: "Online", css: "pill--online" } : { label: "Offline", css: "pill--offline" }];
  if (fallen.has(d.device_id)) pills.unshift({ label: "New fall", css: "pill--pending" });
  if (d.latest) pills.push(d.latest.worn ? { label: "Helmet on", css: "pill--online" } : { label: "Helmet off", css: "pill--late" });
  if (isSimulated(d.device_id)) pills.push({ label: "Simulated helmet", css: "pill--sample" });
  setPills($("wp-pills"), pills);

  const where = workerZone(d);
  const l = d.latest;
  setFacts($("wp-loc"), [
    ["Zone now", where.zone ? zoneName(state.zones, where.zone) : "No zone"],
    ["How it was found", locationText(where.source, !!where.zone)],
    ["GPS", l?.gps_fix && l.lat != null && l.lon != null ? `${l.lat.toFixed(5)}, ${l.lon.toFixed(5)}` : "No fix (normal indoors)"],
  ]);
  const options = zoneOptions(state.zones, d.zone);
  const key = `${JSON.stringify(options)}|${d.zone ?? ""}|${d.device_id}`;
  if (key !== zoneKey && document.activeElement !== $("wp-zone")) {
    $("wp-zone").replaceChildren(...options.map((o) => {
      const opt = el("option", null, o.label);
      opt.value = o.value;
      return opt;
    }));
    $("wp-zone").value = d.zone ?? "";
    zoneKey = key;
  }

  const fmt = (v, unit, digits = 1) => (v == null ? null : `${v.toFixed(digits)} ${unit}`);
  setFacts($("wp-heat"), [
    ["Air temperature", fmt(l?.temp_c, "°C") ?? "No reading"],
    ...(SHOW_HEAT ? [
      ["Humidity", fmt(l?.humidity_pct, "%", 0)],
      ["Heat index", fmt(l?.heat_index_c, "°C")],
      ["Heat risk", heatInfo(l?.heat_level ?? null).label],
    ] : []),
  ]);
  setFacts($("wp-helmet"), [
    ["Device ID", d.device_id],
    ["Status", d.online ? "Online" : "Offline (nothing for 5 s)"],
    ["Last seen", lastSeenText(d, now)],
    ["Helmet", l ? (l.worn ? "On (worn)" : "Off (not worn)") : null],
  ]);

  const list = filterIncidents(state.incidents, { deviceId: d.device_id }).slice(0, 10);
  renderIncidentRows($("wp-incidents"), list, profileRows);
  $("wp-inc-empty").hidden = list.length > 0;
}

// --- Heat section -------------------------------------------------------------------------------

const heatMap = createPlanMap($("map-heat"), { layer: "heat", onWorker: (id) => go("worker", id) });
const heatRowCache = new Map();

function renderHeatView() {
  heatMap.update({ zonesConfig: state.zones, devices: state.devices, hazards: state.hazards });
  const list = heatRows(state.devices);
  syncList($("heat-rows"), list, (d) => d.device_id, () => {
    const tr = el("tr", "row--link");
    const who = el("td");
    const a = el("a", "cell__main");
    who.append(a);
    const zone = el("td");
    const air = el("td", "num");
    const hum = el("td", "num");
    const hi = el("td", "num");
    const risk = el("td", "cell--risk");
    const sw = el("span", "dot__swatch");
    const label = el("span");
    risk.append(sw, label);
    tr.append(who, zone, air, hum, hi, risk);
    tr.addEventListener("click", (e) => { if (!e.target.closest("a")) go("worker", tr.dataset.id); });
    return { root: tr, a, zone, air, hum, hi, sw, label };
  }, (r, d) => {
    r.root.dataset.id = d.device_id;
    setText(r.a, d.name);
    r.a.setAttribute("href", routeHash("worker", d.device_id));
    const where = workerZone(d);
    zoneCell(r.zone, where.zone, where.source);
    const l = d.latest;
    setText(r.air, l?.temp_c == null ? "–" : `${l.temp_c.toFixed(1)} °C`);
    setText(r.hum, l?.humidity_pct == null ? "–" : `${Math.round(l.humidity_pct)} %`);
    setText(r.hi, l?.heat_index_c == null ? "–" : `${l.heat_index_c.toFixed(1)} °C`);
    const info = heatInfo(l?.heat_level ?? null);
    r.sw.className = `dot__swatch ${info.css}`;
    setText(r.label, info.label);
  }, heatRowCache);
  $("heat-empty").hidden = list.length > 0;
}

// --- Settings -------------------------------------------------------------------------------------

function renderSettings() {
  setText("set-conn", connectionText());
  const layout = mapLayout(state.zones, []);
  const site = state.site;
  setFacts($("set-site"), [
    ["Site", state.zones?.site ?? null],
    ["Zones", layout.cells.length ? String(layout.cells.length) : "None"],
    ["Floor plan", layout.mode === "plan" ? layout.image : "Grid (no image)"],
    ["GPS on the plan", site ? (site.gps_ready ? `Ready (largest error ${site.max_error_px} px)` : "Not set up (no gps_points)") : "Unknown"],
  ]);
  const sims = state.devices.filter((d) => isSimulated(d.device_id)).length;
  const samples = state.incidents.filter((i) => i.sample).length;
  setText("set-sample", state.sample.any
    ? `On: ${sims} simulated helmet${sims === 1 ? "" : "s"} and ${samples} sample incident${samples === 1 ? "" : "s"}.${
      state.sample.mixed ? " Real data is also present, so sample rows carry their own Sample tag." : ""}`
    : "Off: no simulated helmets or sample incidents.");
}

// --- Page --------------------------------------------------------------------------------------

function render() {
  renderHeader();
  renderAlert();
  if (state.lastOkAt === null) return; // nothing loaded yet
  renderPeople();
  switch (state.route.view) {
    case "map": renderMapView(); break;
    case "workers": renderWorkersView(); break;
    case "incidents": renderIncidentsView(); break;
    case "heat": renderHeatView(); break;
    case "settings": renderSettings(); break;
    case "incident": renderIncidentPage(); break;
    case "worker": renderWorkerPage(); break;
    default: break;
  }
}

onRoute();
loadZones();
refresh();
