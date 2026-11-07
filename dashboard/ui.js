// Small DOM helpers shared by the dashboard views.
// All text from the server (names, notes) goes in with textContent, never as HTML.

export const $ = (id) => document.getElementById(id);

export function setText(node, text) {
  if (typeof node === "string") node = $(node);
  if (node.textContent !== text) node.textContent = text;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// An icon from the sprite in index.html (#i-map, #i-helmet, ...).
export function icon(name, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  if (className) svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// Hard-hat avatar colored by status (logic.js workerStatus key; colors in style.css).
export function avatar(statusKey, size = "") {
  const svg = icon("helmet", `avatar${size ? ` avatar--${size}` : ""}`);
  svg.dataset.status = statusKey;
  return svg;
}

export function setAvatar(svg, statusKey, label) {
  if (svg.dataset.status !== statusKey) svg.dataset.status = statusKey;
  if (label !== undefined) {
    svg.setAttribute("role", "img");
    svg.removeAttribute("aria-hidden");
    if (svg.getAttribute("aria-label") !== label) svg.setAttribute("aria-label", label);
  }
}

// One pill style for the whole app: { label, css } from logic.js (statusPill, incidentPills).
export function pill({ label, css }) {
  return el("span", `pill ${css}`, label);
}

// Replace a container's pills only when they change.
export function setPills(container, pills) {
  const key = JSON.stringify(pills);
  if (container.dataset.key === key) return;
  container.replaceChildren(...pills.map(pill));
  container.dataset.key = key;
}

// Keep a container's children in the order of `items`, reusing each node by its key, so a
// row being clicked or focused is never rebuilt by the once-a-second refresh.
// build(item) returns a node or { root, ... }; update(node, item) refreshes it.
export function syncList(container, items, keyOf, build, update, cache) {
  const seen = new Set();
  items.forEach((item, i) => {
    const k = keyOf(item);
    seen.add(k);
    let node = cache.get(k);
    if (!node) { node = build(item); cache.set(k, node); }
    update(node, item);
    const root = node.root ?? node;
    if (container.children[i] !== root) container.insertBefore(root, container.children[i] ?? null);
  });
  for (const [k, node] of cache) {
    if (!seen.has(k)) { (node.root ?? node).remove(); cache.delete(k); }
  }
}

// A definition list of [label, value] pairs. Values are text (or "–" when empty).
export function setFacts(dl, rows) {
  const key = JSON.stringify(rows);
  if (dl.dataset.key === key) return;
  dl.dataset.key = key;
  dl.replaceChildren(...rows.flatMap(([label, value]) => [
    el("dt", null, label),
    el("dd", null, value === null || value === undefined || value === "" ? "–" : String(value)),
  ]));
}

// A short message under a form or action; success messages clear themselves.
export function flash(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle("formmsg--error", isError);
  clearTimeout(node._timer);
  if (text && !isError) node._timer = setTimeout(() => { node.textContent = ""; }, 3000);
}
