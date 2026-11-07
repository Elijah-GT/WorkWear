// Dashboard entry point: loads data from the server every second and draws the page.
// All text from the server (names, notes) is inserted with textContent, never as HTML.

import { getJSON, patchJSON } from "./api.js";
import {
  checkNewFalls, formatAgo, formatClock, formatReading, heatInfo, incidentBadges, incidentPlace,
  dotLabel, incidentTitle, incidentWho, isSimulated, lastSeenText, mapLayout, namePatch, summarize,
  zoneOptions, zonePatch,
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
    const [devices, incidents] = await Promise.all([
      getJSON("/api/devices"),
      getJSON(`/api/incidents?limit=${INCIDENT_LIMIT}`),
    ]);
    state.devices = devices;
    state.incidents = incidents;
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
  root.append(top, who, place, time, notes);
  return { root, title, badges, who, place, time, notes, badgeKey: null };
}

function updateRow(row, inc, now, alerting) {
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
    const list = el("ul", "dots");
    list.setAttribute("aria-label", `Workers in zone ${c.label}`);
    cell.append(head, list);
    zoneLists.set(c.id, { cell, list, count });
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
  for (const c of layout.cells) {
    const z = zoneLists.get(c.id);
    if (!z) continue;
    placeDots(z.list, c.workers, fallen);
    setText(z.count, c.workers.length === 1 ? "1 worker" : `${c.workers.length} workers`);
    z.cell.classList.toggle("zone--fall", c.workers.some((d) => fallen.has(d.device_id)));
  }
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

// --- Page --------------------------------------------------------------------

function render() {
  renderConnection();
  renderAlert();
  if (state.lastOkAt === null) return; // nothing loaded yet
  renderTiles();
  renderWorkers();
  renderIncidents();
  renderMap();
}

loadZones();
refresh();
