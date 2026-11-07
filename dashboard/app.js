// Dashboard entry point: loads data from the server every second and draws the page.

import { getJSON } from "./api.js";
import { formatAgo, summarize } from "./logic.js";

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

function setText(id, text) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

async function loadZones() {
  try {
    state.zones = await getJSON("zones.json");
    setText("site-name", state.zones.site);
  } catch (err) {
    setText("site-name", `Could not load zones.json: ${err.message}`);
  }
}

async function refresh() {
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
  render();
  setTimeout(refresh, REFRESH_MS); // next refresh only after this one finishes
}

function renderConnection() {
  const conn = $("conn");
  if (state.error) {
    conn.className = "conn conn--down";
    conn.textContent = state.lastOkAt
      ? `Can't reach server (last update ${formatAgo(Date.now() - state.lastOkAt)})`
      : "Can't reach server";
    conn.title = state.error;
  } else {
    conn.className = "conn conn--up";
    conn.textContent = "Connected";
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

function render() {
  renderConnection();
  if (state.lastOkAt === null) return; // nothing loaded yet
  renderTiles();
}

loadZones();
refresh();
