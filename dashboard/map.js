// The floor-plan map, used by the Map and Heat sections and (small) on each incident page.
//
// Layers:
//   "incidents" - each zone is shaded by its number of CONFIRMED incidents (1, 2, 3+) with the
//                 count on it. Past incidents are not drawn one by one. An active fall alert is
//                 one marker with a ring, and its zone gets a red outline.
//   "heat"      - each zone is tinted by the highest heat index measured there.
//   "none"      - plain plan (incident page): one zone highlighted and the incident's spot.
// Worker dots sit in their zone, colored by heat risk; a zone too small for the names shows
// initials, then a single "N workers" tag, so nothing spills into the next zone.

import {
  SHOW_HEAT, dotLabel, formatClock, hazardView, heatInfo, incidentSpot, incidentWho, initials, isMeasured,
  mapLayout, markerWhere, workerZone, zoneHeatView,
} from "./logic.js";
import { el, setText } from "./ui.js";

const KEYS = {
  incidents: [
    ["Confirmed incidents", [["shade shade-1", "1"], ["shade shade-2", "2"], ["shade shade-3", "3+"]]],
    ["Fall alert", [["mk mk--alert", "Active fall (ring)"], ["zoneline", "Its zone"]]],
  ],
  heat: [
    ["Highest heat index (air, not body temperature)", [["sw heat--normal", "Normal"], ["sw heat--caution", "Caution"],
      ["sw heat--extreme-caution", "Extreme caution"], ["sw heat--danger", "Danger"],
      ["sw heat--extreme-danger", "Extreme danger"], ["sw heat--none", "No reading"]]],
  ],
  workers: ["Workers", [
    SHOW_HEAT ? ["sw heat--normal", "Dot color = heat risk"] : ["sw heat--normal", "Online"],
    ["ring", "Located by beacons or GPS"]]],
};

function buildKey(layer) {
  const panel = el("div", "mapkey");
  for (const [title, items] of [...(KEYS[layer] ?? []), KEYS.workers]) {
    panel.append(el("div", "mapkey__title", title));
    const ul = el("ul", "mapkey__list");
    for (const [cls, text] of items) {
      const li = el("li");
      li.append(el("span", `mapkey__sw ${cls}`), document.createTextNode(text));
      ul.append(li);
    }
    panel.append(ul);
  }
  return panel;
}

export function createPlanMap(host, { layer = "incidents", mini = false, onZone = null, onWorker = null, onMarker = null } = {}) {
  const box = el("div", "mapbox");
  const frame = el("div", "mapframe");
  const map = el("div", "map");
  frame.append(map);
  box.append(frame);
  if (!mini) {
    const btn = el("button", "mapkey__btn", "Key");
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    const panel = buildKey(layer);
    panel.hidden = true;
    btn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      btn.setAttribute("aria-expanded", String(!panel.hidden));
    });
    frame.append(btn, panel);
  }
  host.replaceChildren(box);

  let mapKey = null;
  let layout = null;
  let planFailed = false;
  let markerLayer = null;
  const zones = new Map();   // zone id -> { cell, list, badge, count }
  const dots = new Map();    // device id -> { root, swatch, name, short }
  const markers = new Map(); // incident id -> button
  let lastData = null;

  // Clicks: a worker dot opens the worker, a marker its incident, anywhere else in a zone the zone.
  const activate = (target) => {
    const dot = target.closest(".dot");
    if (dot && onWorker) { onWorker(dot.dataset.id); return true; }
    const mk = target.closest(".marker");
    if (mk && onMarker) { onMarker(Number(mk.dataset.id)); return true; }
    const zone = target.closest(".zone");
    if (zone && onZone) { onZone(zone.dataset.zone); return true; }
    return false;
  };
  map.addEventListener("click", (e) => activate(e.target));
  map.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && activate(e.target)) e.preventDefault();
  });

  function build() {
    zones.clear();
    markers.clear();
    markerLayer = null;
    map.style.gridTemplateColumns = "";
    map.style.aspectRatio = "";
    if (layout.cells.length === 0) {
      map.className = "map map--empty";
      map.replaceChildren(el("p", null, lastData.zonesConfig
        ? "zones.json has no usable zones, so there is no map."
        : "No map: zones.json could not be loaded."));
      return;
    }
    const plan = layout.mode === "plan";
    box.classList.toggle("mapbox--plan", plan);
    const parts = [];
    if (plan) {
      map.className = "map map--plan";
      map.style.aspectRatio = `${layout.width} / ${layout.height}`;
      box.style.setProperty("--plan-aspect", String(layout.width / layout.height));
      planFailed = false;
      const img = el("img", "map__img");
      img.alt = ""; // decorative: the zones carry the names
      img.addEventListener("error", () => { planFailed = true; if (lastData) update(lastData); });
      img.src = layout.image;
      parts.push(img);
    } else {
      map.className = "map map--grid";
      map.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
    }
    for (const c of layout.cells) {
      const cell = el("section", "zone");
      cell.dataset.zone = c.id;
      if (plan) {
        Object.assign(cell.style, { left: `${c.left}%`, top: `${c.top}%`, width: `${c.width}%`, height: `${c.height}%` });
      } else {
        cell.style.gridColumn = String(c.col + 1);
        cell.style.gridRow = String(c.row + 1);
      }
      if (onZone) { cell.tabIndex = 0; cell.setAttribute("role", "button"); }
      const label = el("strong", "zone__label", c.label);
      const badge = el("span", "zone__badge");
      const count = el("span", "zone__count");
      const list = el("ul", "dots");
      list.setAttribute("aria-label", `Workers in ${c.label}`);
      cell.append(label, badge, count, list);
      zones.set(c.id, { cell, list, badge, count });
      parts.push(cell);
    }
    if (plan) {
      markerLayer = el("div", "map__markers");
      parts.push(markerLayer);
    }
    map.replaceChildren(...parts);
  }

  function buildDot() {
    const root = el("li", "dot");
    const swatch = el("span", "dot__swatch");
    swatch.setAttribute("aria-hidden", "true");
    const name = el("span", "dot__name");
    const short = el("span", "dot__initials");
    short.setAttribute("aria-hidden", "true");
    root.append(swatch, name, short);
    if (onWorker) { root.tabIndex = 0; root.setAttribute("role", "button"); }
    return { root, swatch, name, short };
  }

  // Put worker dots into a list (a zone, or the "Not on the map" list outside the plan).
  function placeDots(list, workers, fallen, near) {
    workers.forEach((d, i) => {
      let dot = dots.get(d.device_id);
      if (!dot) { dot = buildDot(); dots.set(d.device_id, dot); }
      const level = d.latest?.heat_level ?? null;
      const fell = fallen.has(d.device_id);
      const measured = isMeasured(workerZone(d).source);
      const cls = `dot${d.online ? "" : " dot--offline"}${fell ? " dot--fall" : ""}${measured ? " dot--measured" : ""}${
        near && near(d) ? " dot--near" : ""}`;
      if (dot.root.className !== cls) dot.root.className = cls;
      // Heat off: every dot is the "online" green; offline and fall have their own classes.
      const color = SHOW_HEAT ? heatInfo(level).css : "heat--normal";
      dot.swatch.className = `dot__swatch ${color}`;
      dot.short.className = `dot__initials ${color}`;
      dot.root.dataset.id = d.device_id;
      setText(dot.name, d.name);
      setText(dot.short, initials(d.name));
      const label = `${fell ? `${dotLabel(d)}, NEW FALL` : dotLabel(d)}${onWorker ? ". Opens the worker's profile." : ""}`;
      if (dot.root.title !== label) { dot.root.title = label; dot.root.setAttribute("aria-label", label); }
      if (list.children[i] !== dot.root) list.insertBefore(dot.root, list.children[i] ?? null);
    });
    while (list.children.length > workers.length) list.lastElementChild.remove();
  }

  function setMarkers(items, nowMs) {
    if (!markerLayer) return;
    const keep = new Set();
    items.forEach(({ spot, inc, cls }, i) => {
      keep.add(spot.id);
      let b = markers.get(spot.id);
      if (!b) {
        b = el("button", "marker");
        b.type = "button";
        b.dataset.id = String(spot.id);
        markers.set(spot.id, b);
      }
      const want = `marker ${cls}${spot.exact ? "" : " marker--approx"}`;
      if (b.className !== want) b.className = want;
      b.style.left = `${spot.left}%`;
      b.style.top = `${spot.top}%`;
      const label = `${inc.type === "fall" ? "Fall" : "Incident"} #${inc.id}: ${incidentWho(inc)}, ${formatClock(inc.ts, nowMs)}${
        inc.peak_g != null ? `, peak ${inc.peak_g} g` : ""}. Drawn ${markerWhere(spot, lastData.zonesConfig)}.`;
      if (b.title !== label) { b.title = label; b.setAttribute("aria-label", label); }
      if (markerLayer.children[i] !== b) markerLayer.insertBefore(b, markerLayer.children[i] ?? null);
    });
    for (const [id, b] of markers) if (!keep.has(id)) { b.remove(); markers.delete(id); }
  }

  // A zone too small for its name tags shows initials, then one "N workers" tag.
  function spills(cell) {
    const r0 = cell.getBoundingClientRect();
    return [...cell.querySelectorAll(".zone__label, .zone__badge, .zone__count, .dot")].some((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && (r.bottom > r0.bottom - 2 || r.right > r0.right - 2);
    });
  }

  function fit() {
    if (layout?.mode !== "plan") return;
    for (const [, z] of zones) {
      const cell = z.cell;
      cell.classList.remove("zone--compact", "zone--tight");
      if (!cell.getBoundingClientRect().height) continue; // not showing right now
      if (!spills(cell)) continue;
      cell.classList.add("zone--compact");
      if (spills(cell)) cell.classList.add("zone--tight");
    }
  }
  window.addEventListener("resize", fit);

  // data: { zonesConfig, devices, hazards, alerts, focus, selectedZone, offList }
  // focus (incident page) = the incident to show; selectedZone = zone picked in the zone list.
  function update(data) {
    lastData = data;
    const { zonesConfig, devices, hazards = [], alerts = [], focus = null, selectedZone = null, offList = null } = data;
    layout = mapLayout(zonesConfig, devices);
    const key = JSON.stringify([layout.mode, layout.image, layout.width, layout.height, layout.cols, layout.rows,
      layout.cells.map((c) => [c.id, c.label, c.col, c.row, c.left, c.top, c.width, c.height]), !!zonesConfig]);
    if (key !== mapKey) { build(); mapKey = key; }
    if (layout.cells.length === 0) return { layout, problems: layout.problems };

    const nowMs = Date.now();
    const fallen = new Set(alerts.map((a) => a.device_id));
    const alertZones = new Set(alerts.map((a) => a.zone).filter(Boolean));
    const byZone = new Map(hazards.map((h) => [h.zone, h]));
    const near = focus?.zone ? (d) => workerZone(d).zone === focus.zone : null;

    for (const c of layout.cells) {
      const z = zones.get(c.id);
      if (!z) continue;
      placeDots(z.list, c.workers, fallen, near);
      const n = c.workers.length;
      setText(z.count, n === 1 ? "1 worker" : `${n} workers`);
      let cls = "zone";
      let badge = "";
      let text = "";
      if (layer === "incidents") {
        const v = hazardView(byZone.get(c.id));
        cls += ` zone--shade-${v.shade}`;
        const count = byZone.get(c.id)?.confirmed_count ?? 0;
        badge = count ? String(count) : "";
        text = v.text;
      } else if (layer === "heat") {
        const v = zoneHeatView(byZone.get(c.id));
        cls += ` zone--heat zone--heat-${v.level ?? "none"}`;
        badge = v.badge ? v.badge.split(" · ")[0] : "";
        text = v.text;
      }
      if (layer === "incidents" && alertZones.has(c.id)) { cls += " zone--fall"; text = `NEW FALL. ${text}`; }
      if (focus && focus.zone === c.id) cls += " zone--focus";
      if (selectedZone === c.id) cls += " zone--selected";
      if (onZone) cls += " zone--click";
      for (const f of ["zone--compact", "zone--tight"]) if (z.cell.classList.contains(f)) cls += ` ${f}`; // fit() decides
      if (z.cell.className !== cls) z.cell.className = cls;
      setText(z.badge, badge);
      const label = `${c.label}: ${text ? `${text}, ` : ""}${n === 1 ? "1 worker" : `${n} workers`}${onZone ? ". Click to list its incidents." : ""}`;
      if (z.cell.title !== label) { z.cell.title = label; z.cell.setAttribute("aria-label", label); }
    }

    // Markers: active fall alerts (one ringed marker each), or the incident being shown.
    let items = [];
    if (focus) {
      const spot = incidentSpot(focus, layout);
      if (spot) items = [{ spot, inc: focus, cls: `marker--focus marker--${focus.status}` }];
    } else if (layer === "incidents") {
      items = alerts.map((a) => ({ spot: incidentSpot(a, layout), inc: a, cls: "marker--alert" })).filter((m) => m.spot);
    }
    setMarkers(items, nowMs);
    if (offList) placeDots(offList, layout.offMap, fallen, near);
    fit();

    const problems = [...layout.problems];
    if (layout.mode === "plan" && planFailed) problems.push(`the floor plan image "${layout.image}" could not be loaded`);
    return { layout, problems, focusSpot: items[0]?.spot ?? null };
  }

  return { update, fit, element: map };
}
