// Dashboard entry point: loads data from the server every second and draws the page.
// All text from the server (names, notes) is inserted with textContent, never as HTML.

import { getJSON, patchJSON } from "./api.js";
import {
  formatAgo, formatReading, heatInfo, isSimulated, lastSeenText, namePatch, summarize,
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

// --- Page --------------------------------------------------------------------

function render() {
  renderConnection();
  if (state.lastOkAt === null) return; // nothing loaded yet
  renderTiles();
  renderWorkers();
}

loadZones();
refresh();
