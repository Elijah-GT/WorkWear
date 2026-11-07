// Dashboard entry point: loads data from the server every second and draws the page.
// All text from the server (names, notes) is inserted with textContent, never as HTML.

import { getJSON, patchJSON, postJSON } from "./api.js";
import {
  checkNewFalls, dotLabel, formatAgo, formatClock, formatReading, hazardView, heatInfo,
  incidentBadges, incidentPlace, incidentTitle, incidentWho, isSimulated, lastSeenText, mapLayout,
  namePatch, notesPatch, reportBody, statusActions, summarize, zoneHeatView, zoneOptions, zonePatch,
} from "./logic.js";

const REFRESH_MS = 1000;       // devices and incidents
const INCIDENT_LIMIT = 200;    // most recent incidents to load

const state = {
  zones: null,          // dashboard/zones.json
  devices: [],
  incidents: [],
  lastOkAt: null,       // Date.now() of the last successful refresh
  error: null,          // message if the last refresh failed
  alertBaseline: null,  // highest incident id already checked for falls (logic.js checkNewFalls)
  alerts: [],           // falls that arrived while the page was open and are not hidden yet, newest first
  hazards: [],          // GET /api/hazards for the map (D5)
  layer: "incidents",   // map layer: "incidents" or "heat"
  hours: null,          // map time window in hours; null = all time
};

const $ = (id) => document.getElementById(id);

function setText(el, text) {
  if (typeof el === "string") el = $(el);
  if (el.textContent !== text) el.textContent = text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- Loading -----------------------------------------------------------------

async function loadZones() {
  try {
    state.zones = await getJSON("zones.json");
    setText("site-name", state.zones.site);
  } catch (err) {
    setText("site-name", `Could not load zones.json: ${err.message}`);
  }
  render();
}

let timer = null;
let inFlight = false;
let againAfter = false;

async function refresh() {
  if (inFlight) { againAfter = true; return; }
  inFlight = true;
  clearTimeout(timer);
  try {
    const [devices, incidents, hazards] = await Promise.all([
      getJSON("/api/devices"),
      getJSON(`/api/incidents?limit=${INCIDENT_LIMIT}`),
      getJSON(`/api/hazards${state.hours ? `?hours=${state.hours}` : ""}`),
    ]);
    state.devices = devices;
    state.incidents = incidents;
    state.hazards = hazards;
    // A fall that was confirmed or dismissed has been dealt with, so its alert goes away.
    const statusById = new Map(incidents.map((i) => [i.id, i.status]));
    state.alerts = state.alerts.filter((a) => (statusById.get(a.id) ?? "new") === "new");
    const found = checkNewFalls(incidents, state.alertBaseline);
    state.alertBaseline = found.baseline;
    if (found.falls.length) {
      state.alerts = [...found.falls, ...state.alerts];
      beep();
    }
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

// Refresh right away, e.g. after a change was saved.
const refreshNow = () => refresh();

// --- Header ------------------------------------------------------------------

function renderConnection() {
  const conn = $("conn");
  if (state.error) {
    conn.className = "conn conn--down";
    setText(conn, state.lastOkAt
      ? `Can't reach server (last update ${formatAgo(Date.now() - state.lastOkAt)})`
      : "Can't reach server");
    conn.title = state.error;
  } else {
    conn.className = "conn conn--up";
    setText(conn, "Connected");
    conn.title = "";
  }
}

function renderTiles() {
  const s = summarize(state.devices, state.incidents);
  setText("t-online", `${s.online} / ${s.devices}`);
  setText("t-new", String(s.newIncidents));
  setText("t-incidents", String(s.incidents));
  setText("t-sim", String(s.simulated));
}

// --- Workers (D2) ------------------------------------------------------------
// Each card is built once and then updated in place, so a name being typed or a
// zone list that is open is never wiped out by the once-a-second refresh.

const cards = new Map(); // device_id -> { root, parts..., device }

function showMessage(card, text, isError) {
  card.msg.textContent = text;
  card.msg.className = `worker__msg${isError ? " worker__msg--error" : ""}`;
  clearTimeout(card.msgTimer);
  if (text && !isError) card.msgTimer = setTimeout(() => showMessage(card, "", false), 2500);
}

async function save(card, body, what) {
  card.root.classList.add("worker--saving");
  try {
    await patchJSON(`/api/devices/${encodeURIComponent(card.device.device_id)}`, body);
    showMessage(card, `${what} saved`, false);
    refreshNow();
  } catch (err) {
    showMessage(card, `Couldn't save ${what.toLowerCase()}: ${err.message}`, true);
  } finally {
    card.root.classList.remove("worker--saving");
  }
}

function commitName(card) {
  const result = namePatch(card.name.value, card.device.name);
  if (result.error) {
    showMessage(card, result.error, true);
    card.name.value = card.device.name;
    return;
  }
  if (result.body) save(card, result.body, "Name");
}

function buildCard(device) {
  const root = el("article", "worker");
  root.dataset.id = device.device_id;

  const heat = el("div", "worker__heat");
  const body = el("div", "worker__body");

  const top = el("div", "worker__top");
  const name = el("input", "worker__name");
  name.type = "text";
  name.maxLength = 80;
  name.setAttribute("aria-label", `Worker name for helmet ${device.device_id}`);
  name.title = "Click to rename. Enter to save, Esc to cancel.";
  const online = el("span", "badge");
  top.append(name, online);
  if (isSimulated(device.device_id)) top.append(el("span", "tag tag--sim", "Simulated helmet"));

  const id = el("div", "worker__id");
  const heatLine = el("div", "worker__heatline");
  const heatLabel = el("strong");
  const heatText = el("span");
  heatLine.append(heatLabel, el("span", null, " heat risk · "), heatText);

  const bottom = el("div", "worker__bottom");
  const worn = el("span", "worn");
  const zoneLabel = el("label", "worker__zonelabel", "Zone ");
  const zone = el("select", "worker__zone");
  zone.setAttribute("aria-label", `Zone for helmet ${device.device_id}`);
  zoneLabel.append(zone);
  bottom.append(worn, zoneLabel);

  const msg = el("div", "worker__msg");
  msg.setAttribute("role", "status");

  body.append(top, id, heatLine, bottom, msg);
  root.append(heat, body);

  const card = { root, heat, name, online, id, heatLabel, heatText, worn, zone, msg, device, zoneKey: null };

  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); name.blur(); }
    if (e.key === "Escape") { name.value = card.device.name; name.blur(); }
  });
  name.addEventListener("blur", () => commitName(card));
  zone.addEventListener("change", () => {
    const body = zonePatch(zone.value, card.device.zone);
    if (body) save(card, body, "Zone");
  });
  return card;
}

function updateCard(card, device, now) {
  card.device = device;
  const level = device.latest?.heat_level ?? null;
  const info = heatInfo(level);

  card.root.classList.toggle("worker--offline", !device.online);
  card.heat.className = `worker__heat ${info.css}`;
  card.heat.title = `Heat risk: ${info.label}`;

  if (document.activeElement !== card.name) card.name.value = device.name;

  card.online.className = `badge ${device.online ? "badge--online" : "badge--offline"}`;
  setText(card.online, device.online ? "Online" : "Offline");

  setText(card.id, `${device.device_id} · ${lastSeenText(device, now)}`);
  setText(card.heatLabel, info.label);
  setText(card.heatText, formatReading(device.latest));

  if (device.latest) {
    const on = device.latest.worn;
    card.worn.className = `worn ${on ? "worn--on" : "worn--off"}`;
    setText(card.worn, on ? "Helmet on" : "Helmet off");
  } else {
    card.worn.className = "worn";
    setText(card.worn, "");
  }

  // Rebuild the zone options only when they change, and never while the list is open.
  const options = zoneOptions(state.zones, device.zone);
  const key = JSON.stringify(options) + "|" + (device.zone ?? "");
  if (key !== card.zoneKey && document.activeElement !== card.zone) {
    card.zone.replaceChildren(...options.map((o) => {
      const opt = el("option", null, o.label);
      opt.value = o.value;
      return opt;
    }));
    card.zone.value = device.zone ?? "";
    card.zoneKey = key;
  }
}

function renderWorkers() {
  const container = $("workers");
  if (state.devices.length === 0) {
    cards.clear();
    container.className = "empty";
    setText(container, "No helmets yet. They appear here when they send their first reading.");
    return;
  }
  if (container.className !== "workers") {
    container.className = "workers";
    container.replaceChildren();
  }
  const now = Date.now();
  const seen = new Set();
  state.devices.forEach((device, i) => {
    seen.add(device.device_id);
    let card = cards.get(device.device_id);
    if (!card) {
      card = buildCard(device);
      cards.set(device.device_id, card);
    }
    updateCard(card, device, now);
    if (container.children[i] !== card.root) container.insertBefore(card.root, container.children[i] ?? null);
  });
  for (const [id, card] of cards) {
    if (!seen.has(id)) { card.root.remove(); cards.delete(id); }
  }
}

// --- Fall alert (D3) ----------------------------------------------------------
// A banner for falls that arrive while the page is open. It stays until someone hides it.
// Falls that were already in the list when the page loaded do not raise it.

const BASE_TITLE = document.title;

function badgeEls(badges) {
  return badges.map((b) => el("span", `badge ${b.css}`, b.label));
}

function renderAlert() {
  const box = $("alert");
  if (state.alerts.length === 0) {
    box.hidden = true;
    document.title = BASE_TITLE;
    return;
  }
  const fall = state.alerts[0];
  setText("alert-title", `FALL: ${incidentWho(fall)}`);
  const peak = fall.peak_g != null ? ` · peak ${fall.peak_g} g` : "";
  setText("alert-detail", `${incidentPlace(fall)} · ${formatClock(fall.ts, Date.now())}${peak}`);
  const key = JSON.stringify(incidentBadges(fall));
  if ($("alert-badges").dataset.key !== key) {
    $("alert-badges").replaceChildren(...badgeEls(incidentBadges(fall)));
    $("alert-badges").dataset.key = key;
  }
  const more = state.alerts.length - 1;
  setText("alert-more", more ? `+ ${more} more new fall${more > 1 ? "s" : ""} (see the list)` : "");
  box.hidden = false;
  document.title = `(${state.alerts.length}) FALL · ${BASE_TITLE}`;
}

$("alert-hide").addEventListener("click", () => {
  state.alerts = [];
  renderAlert();
  renderIncidents();
  renderMap();
});

$("alert-show").addEventListener("click", () => {
  const row = state.alerts[0] && rows.get(state.alerts[0].id);
  if (!row) return;
  row.root.scrollIntoView({ behavior: "smooth", block: "center" });
  row.root.focus({ preventScroll: true });
});

// Optional sound. Browsers only allow audio after a click on the page, so it starts off
// and the supervisor turns it on with the button.
let audio = null;

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

$("sound").addEventListener("click", async () => {
  const btn = $("sound");
  const turnOn = btn.getAttribute("aria-pressed") !== "true";
  try {
    if (turnOn) {
      audio ??= new AudioContext();
      await audio.resume();
      beep(); // test sound, so the supervisor knows it works
    } else if (audio) {
      await audio.suspend();
    }
    btn.setAttribute("aria-pressed", String(turnOn));
    setText(btn, `Alert sound: ${turnOn ? "on" : "off"}`);
  } catch (err) {
    setText(btn, "Alert sound: not available");
    btn.title = err.message;
  }
});

// --- Incidents (D3) ------------------------------------------------------------
// Rows are kept by incident id and updated in place, like the worker cards.

const rows = new Map(); // incident id -> { root, parts... }

function buildRow(inc) {
  const root = el("li", "incident");
  root.id = `inc-${inc.id}`;
  root.tabIndex = -1;
  const top = el("div", "incident__top");
  const title = el("strong", "incident__title");
  const badges = el("span", "incident__badges");
  top.append(title, badges);
  const who = el("div", "incident__who");
  const place = el("div", "incident__place");
  const time = el("div", "incident__time");
  const notes = el("div", "incident__notes");

  // Review (D5): status buttons and a note editor.
  const actions = el("div", "incident__actions");
  const statusBtns = el("span", "incident__statusbtns");
  const noteBtn = el("button", "btn btn--small", "Add note");
  noteBtn.type = "button";
  actions.append(statusBtns, noteBtn);
  const editor = el("div", "incident__editor");
  editor.hidden = true;
  const textarea = el("textarea", "incident__textarea");
  textarea.rows = 3;
  textarea.maxLength = 2000;
  textarea.setAttribute("aria-label", `Notes for incident ${inc.id}`);
  const saveNote = el("button", "btn btn--small btn--primary", "Save note");
  saveNote.type = "button";
  const cancelNote = el("button", "btn btn--small", "Cancel");
  cancelNote.type = "button";
  const editorBtns = el("div", "incident__editorbtns");
  editorBtns.append(saveNote, cancelNote);
  editor.append(textarea, editorBtns);
  const msg = el("div", "incident__msg");
  msg.setAttribute("role", "status");

  root.append(top, who, place, time, notes, actions, editor, msg);
  const row = { root, title, badges, who, place, time, notes, statusBtns, noteBtn, editor, textarea, msg,
    inc, badgeKey: null, statusKey: null };

  const closeEditor = () => { editor.hidden = true; noteBtn.hidden = false; noteBtn.focus(); };
  noteBtn.addEventListener("click", () => {
    textarea.value = row.inc.notes;
    editor.hidden = false;
    noteBtn.hidden = true;
    textarea.focus();
  });
  cancelNote.addEventListener("click", closeEditor);
  const commitNote = async () => {
    const result = notesPatch(textarea.value, row.inc.notes);
    if (result.error) { showRowMessage(row, result.error, true); return; }
    if (result.body && !(await saveIncident(row, result.body, "Note"))) return;
    closeEditor();
  };
  saveNote.addEventListener("click", commitNote);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeEditor(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitNote(); }
  });
  return row;
}

function showRowMessage(row, text, isError) {
  row.msg.textContent = text;
  row.msg.className = `incident__msg${isError ? " incident__msg--error" : ""}`;
  clearTimeout(row.msgTimer);
  if (text && !isError) row.msgTimer = setTimeout(() => showRowMessage(row, "", false), 2500);
}

// PATCH an incident. Returns true if it was saved.
async function saveIncident(row, body, what) {
  row.root.classList.add("incident--saving");
  for (const b of row.root.querySelectorAll("button")) b.disabled = true;
  try {
    await patchJSON(`/api/incidents/${row.inc.id}`, body);
    showRowMessage(row, `${what} saved`, false);
    refreshNow();
    return true;
  } catch (err) {
    showRowMessage(row, `Couldn't save ${what.toLowerCase()}: ${err.message}`, true);
    return false;
  } finally {
    row.root.classList.remove("incident--saving");
    for (const b of row.root.querySelectorAll("button")) b.disabled = false;
  }
}

function updateRow(row, inc, now, alerting) {
  row.inc = inc;
  row.root.className = `incident incident--${inc.type}${alerting ? " incident--alerting" : ""}`;
  setText(row.title, `${incidentTitle(inc.type)} #${inc.id}`);
  const badges = incidentBadges(inc);
  const key = JSON.stringify(badges);
  if (key !== row.badgeKey) {
    row.badges.replaceChildren(...badgeEls(badges));
    row.badgeKey = key;
  }
  setText(row.who, incidentWho(inc));
  setText(row.place, inc.peak_g != null ? `${incidentPlace(inc)} · peak ${inc.peak_g} g` : incidentPlace(inc));
  setText(row.time, formatClock(inc.ts, now));
  setText(row.notes, inc.notes ? `Notes: ${inc.notes}` : "");
  row.notes.hidden = !inc.notes;
  setText(row.noteBtn, inc.notes ? "Edit note" : "Add note");
  if (row.statusKey !== inc.status) {
    row.statusBtns.replaceChildren(...statusActions(inc.status).map((a) => {
      const b = el("button", `btn btn--small btn--${a.status}`, a.label);
      b.type = "button";
      b.addEventListener("click", () => saveIncident(row, { status: a.status }, "Status"));
      return b;
    }));
    row.statusKey = inc.status;
  }
}

function renderIncidents() {
  const container = $("incidents");
  const empty = state.incidents.length === 0;
  $("incidents-empty").hidden = !empty;
  container.hidden = empty;
  const now = Date.now();
  const alerting = new Set(state.alerts.map((a) => a.id));
  const seen = new Set();
  state.incidents.forEach((inc, i) => {
    seen.add(inc.id);
    let row = rows.get(inc.id);
    if (!row) {
      row = buildRow(inc);
      rows.set(inc.id, row);
    }
    updateRow(row, inc, now, alerting.has(inc.id));
    if (container.children[i] !== row.root) container.insertBefore(row.root, container.children[i] ?? null);
  });
  for (const [id, row] of rows) {
    if (!seen.has(id)) { row.root.remove(); rows.delete(id); }
  }
}

// --- Manual report form (D5) ---------------------------------------------------
// Injuries and hazards (e.g. a wet floor) are entered by hand; the helmet cannot detect them.

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

// The typed name is only used when no helmet is picked.
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
  setText("report-msg", "");
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
  const msg = $("report-msg");
  if (result.error) {
    msg.className = "report__msg report__msg--error";
    setText(msg, result.error);
    return;
  }
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const inc = await postJSON("/api/incidents", result.body);
    form.reset();
    setReportOpen(false);
    msg.className = "report__msg";
    setText(msg, `${incidentTitle(inc.type)} #${inc.id} saved. Confirm it in the list for it to count on the hazard map.`);
    $("report-open").focus();
    refreshNow();
  } catch (err) {
    msg.className = "report__msg report__msg--error";
    setText(msg, `Couldn't save the report: ${err.message}`);
  } finally {
    submit.disabled = false;
  }
});

// --- Site map (D4) --------------------------------------------------------------
// The zone grid is built once from zones.json. Each worker has one dot element that is moved
// to its zone's cell when the zone changes, so it moves on the next refresh (within ~1 s).

const dots = new Map(); // device_id -> { root, swatch, name }
let mapKey = null;      // rebuild the grid only when zones.json gives a different layout
const zoneLists = new Map(); // zone id -> { cell, list, count }

function buildGrid(layout) {
  const map = $("map");
  zoneLists.clear();
  if (layout.cells.length === 0) {
    map.className = "map empty";
    map.style.gridTemplateColumns = "";
    map.replaceChildren(el("p", null, state.zones
      ? "zones.json has no usable zones, so there is no map."
      : "No map: zones.json could not be loaded."));
    return;
  }
  map.className = "map";
  map.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
  map.replaceChildren(...layout.cells.map((c) => {
    const cell = el("section", "zone");
    cell.dataset.zone = c.id;
    cell.style.gridColumn = String(c.col + 1);
    cell.style.gridRow = String(c.row + 1);
    const head = el("div", "zone__head");
    const count = el("span", "zone__count");
    head.append(el("strong", "zone__label", c.label), count);
    const layer = el("div", "zone__layer");
    const list = el("ul", "dots");
    list.setAttribute("aria-label", `Workers in zone ${c.label}`);
    cell.append(head, layer, list);
    zoneLists.set(c.id, { cell, list, count, layer });
    return cell;
  }));
}

function buildDot() {
  const root = el("li", "dot");
  const swatch = el("span", "dot__swatch");
  swatch.setAttribute("aria-hidden", "true");
  const name = el("span", "dot__name");
  root.append(swatch, name);
  return { root, swatch, name };
}

function placeDots(list, workers, fallen) {
  workers.forEach((d, i) => {
    let dot = dots.get(d.device_id);
    if (!dot) { dot = buildDot(); dots.set(d.device_id, dot); }
    const level = d.latest?.heat_level ?? null;
    const fell = fallen.has(d.device_id);
    dot.root.className = `dot${d.online ? "" : " dot--offline"}${fell ? " dot--fall" : ""}`;
    dot.swatch.className = `dot__swatch ${heatInfo(level).css}`;
    setText(dot.name, d.name);
    const label = fell ? `${dotLabel(d)}, NEW FALL` : dotLabel(d);
    if (dot.root.title !== label) { dot.root.title = label; dot.root.setAttribute("aria-label", label); }
    if (list.children[i] !== dot.root) list.insertBefore(dot.root, list.children[i] ?? null);
  });
}

function renderMap() {
  const layout = mapLayout(state.zones, state.devices);
  const key = JSON.stringify([layout.cols, layout.rows, layout.cells.map((c) => [c.id, c.label, c.col, c.row]), !!state.zones]);
  if (key !== mapKey) { buildGrid(layout); mapKey = key; }

  const problems = $("map-problems");
  problems.hidden = layout.problems.length === 0;
  setText(problems, layout.problems.length ? `Check dashboard/zones.json: ${layout.problems.join("; ")}.` : "");

  const fallen = new Set(state.alerts.map((a) => a.device_id));
  const hazards = new Map(state.hazards.map((h) => [h.zone, h]));
  let sample = 0;
  for (const c of layout.cells) {
    const z = zoneLists.get(c.id);
    if (!z) continue;
    placeDots(z.list, c.workers, fallen);
    setText(z.count, c.workers.length === 1 ? "1 worker" : `${c.workers.length} workers`);
    z.cell.classList.toggle("zone--fall", c.workers.some((d) => fallen.has(d.device_id)));
    // Layer (D5): confirmed incidents shade the zone, or heat colors it.
    const h = hazards.get(c.id);
    sample += h?.sample_count ?? 0;
    let cls = "zone";
    let text;
    if (state.layer === "heat") {
      const v = zoneHeatView(h);
      cls += ` zone--heat zone--heat-${v.level ?? "none"}`;
      text = v.text;
    } else {
      const v = hazardView(h);
      cls += ` zone--shade-${v.shade}`;
      text = v.text;
    }
    if (z.cell.classList.contains("zone--fall")) cls += " zone--fall";
    if (z.cell.className !== cls) z.cell.className = cls;
    setText(z.layer, text);
  }
  setText("map-layer-note", state.layer === "heat"
    ? "Colored by the highest heat index measured in each zone (heat risk from air conditions, not body temperature)."
    : `Shaded by confirmed incidents (falls and reports). New and dismissed incidents do not count.${
      sample ? " Counts include sample data from simulated helmets." : ""}`);
  placeDots($("map-off"), layout.offMap, fallen);
  $("map-off").parentElement.hidden = layout.offMap.length === 0;

  // Remove dots of helmets that are gone, and trim leftovers at the end of each list.
  const ids = new Set(state.devices.map((d) => d.device_id));
  for (const [id, dot] of dots) if (!ids.has(id)) { dot.root.remove(); dots.delete(id); }
  for (const [, z] of zoneLists) {
    const want = layout.cells.find((c) => c.id === z.cell.dataset.zone).workers.length;
    while (z.list.children.length > want) z.list.lastElementChild.remove();
  }
  const off = $("map-off");
  while (off.children.length > layout.offMap.length) off.lastElementChild.remove();
}

for (const b of document.querySelectorAll("#map-layers button")) {
  b.addEventListener("click", () => {
    state.layer = b.dataset.layer;
    for (const o of document.querySelectorAll("#map-layers button")) o.setAttribute("aria-pressed", String(o === b));
    renderMap();
  });
}
$("map-hours").addEventListener("change", (e) => {
  state.hours = e.target.value ? Number(e.target.value) : null;
  refreshNow();
});

// --- Page --------------------------------------------------------------------

function render() {
  renderConnection();
  renderAlert();
  if (state.lastOkAt === null) return; // nothing loaded yet
  renderTiles();
  renderWorkers();
  renderIncidents();
  renderMap();
  if (!form.hidden) fillReportOptions();
}

loadZones();
refresh();
