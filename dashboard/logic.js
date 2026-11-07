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
