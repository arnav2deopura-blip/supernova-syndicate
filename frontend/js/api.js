// All network calls live here. Owner: C.
// Order of fallbacks: live backend -> precomputed/<preset>/ -> mock/ (with a banner).

// TODO (issue #10): set to the deployed backend URL.
export const API_BASE = "http://localhost:8000";

const params = new URLSearchParams(location.search);
const FORCE_MOCK = params.has("mock");

let onFallback = () => {};
export function setFallbackHandler(fn) { onFallback = fn; }

async function getJSON(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.code = body.error;
    throw err;
  }
  return body;
}

async function call(endpoint, query, preset) {
  if (!FORCE_MOCK) {
    try {
      return await getJSON(`${API_BASE}/api/${endpoint}?${new URLSearchParams(query)}`);
    } catch (e) {
      if (e.code === "bad_request" || e.code === "not_found") throw e; // real answers, not outages
      console.warn(`/api/${endpoint} failed:`, e.message);
    }
    if (preset) {
      try {
        const data = await getJSON(`precomputed/${preset}/${endpoint}.json`);
        onFallback(`Backend unreachable — showing precomputed data for this target.`);
        return data;
      } catch { /* no bake for this target yet */ }
    }
  }
  onFallback(`Showing MOCK data (fake, for development).`);
  return getJSON(`mock/${endpoint}.json`);
}

// `data` in a frame may be a URL instead of an inline array (see docs/API.md).
async function inlineFrameData(resp) {
  await Promise.all(resp.frames.map(async (f) => {
    if (typeof f.data !== "string") return;
    const res = await fetch(f.data);
    if (f.data.endsWith(".bin")) {
      const arr = new Float32Array(await res.arrayBuffer());
      f.data = Array.from(arr, (v) => (Number.isFinite(v) ? v : null));
    } else {
      f.data = await res.json();
    }
  }));
  return resp;
}

export const api = {
  resolve: (name) => call("resolve", { name }),
  frames: (q, preset) => call("frames", q, preset).then(inlineFrameData),
  exposures: (q, preset) => call("exposures", q, preset),
  spectrum: (q, preset) => call("spectrum", q, preset),
  overlay: (q, preset) => call("overlay", { ...q, cat: "gaia" }, preset),
};
