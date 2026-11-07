// Talks to the WorkWear server (same origin). Routes: docs/PROTOCOL.md.

// A slow or missing server counts as "can't reach server". With the 1 s refresh in
// app.js, a frozen server is reported within 3 s (D1 target); a stopped one within ~1 s.
const TIMEOUT_MS = 2000;

async function request(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${method} ${path} failed (${res.status}) ${detail.slice(0, 200)}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`${method} ${path} timed out`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const getJSON = (path) => request("GET", path);
export const patchJSON = (path, body) => request("PATCH", path, body);
export const postJSON = (path, body) => request("POST", path, body);
