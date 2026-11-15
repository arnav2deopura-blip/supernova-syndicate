// All network calls live here. Owner: C.
// Order of fallbacks: live backend -> precomputed/<preset>/ -> mock/ (with a banner).

// TODO (issue #11): set to the deployed backend URL.
export const API_BASE = "http://localhost:8000";

const params = new URLSearchParams(location.search);
const FORCE_MOCK = params.has("mock");
const POLL_MS = 1000;

/** fn(message, level): level 1 = precomputed bake, 2 = mock. */
let onFallback = () => {};
export function setFallbackHandler(fn) { onFallback = fn; }

export class ApiError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

/** Errors that are real answers from the backend, not outages: never hide them behind a fallback. */
const isAnswer = (e) => e.name === "AbortError" || e.code === "bad_request" || e.code === "not_found";

async function fetchJSON(url, signal) {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.message || `HTTP ${res.status}`, body.error, res.status);
  return { status: res.status, body };
}
const getJSON = async (url, signal) => (await fetchJSON(url, signal)).body;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

const liveURL = (endpoint, query) => `${API_BASE}/api/${endpoint}?${new URLSearchParams(clean(query))}`;
const clean = (q) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/**
 * Call the live backend; on an outage try precomputed/<preset>/<file> (first that exists and passes
 * `accept`), then mock/<endpoint>.json. `live` may be overridden (used by the async job flow).
 */
async function call(endpoint, query, { preset, files = [`${endpoint}.json`], accept = () => true, live, signal } = {}) {
  if (!FORCE_MOCK) {
    try {
      return await (live ? live() : getJSON(liveURL(endpoint, query), signal));
    } catch (e) {
      if (isAnswer(e)) throw e;
      console.warn(`/api/${endpoint} failed:`, e.message);
    }
    if (preset) {
      for (const file of files) {
        try {
          const data = await getJSON(`precomputed/${preset}/${file}`, signal);
          if (!accept(data)) continue;
          onFallback("Backend unreachable — showing precomputed data for this target.", 1);
          return data;
        } catch (e) { if (e.name === "AbortError") throw e; /* not baked */ }
      }
    }
  }
  onFallback("Showing MOCK data (fake, for development).", 2);
  return getJSON(`mock/${endpoint}.json`, signal);
}

// `data` (and `noise`) in a frame may be a URL instead of an inline array (see docs/API.md).
async function inlineFrameData(resp, signal) {
  await Promise.all(resp.frames.map(async (f) => {
    if (typeof f.data !== "string") return;
    const res = await fetch(f.data, { signal });
    if (!res.ok) throw new ApiError(`Frame data missing (HTTP ${res.status})`, "upstream_unavailable", res.status);
    if (f.data.endsWith(".bin")) {
      const arr = new Float32Array(await res.arrayBuffer());
      f.data = Array.from(arr, (v) => (Number.isFinite(v) ? v : null));
    } else {
      f.data = await res.json();
    }
  }));
  return resp;
}

/**
 * Ask for a product with async=1. 200 = cached, use it. 202 = a job: poll its status_url every second,
 * reporting progress, until done (then fetch result.result_url) or error.
 */
async function runJob(url, { onProgress = () => {}, signal } = {}) {
  const sep = url.includes("?") ? "&" : "?";
  const first = await fetchJSON(`${url}${sep}async=1`, signal);
  if (first.status !== 202) return first.body;
  let job = first.body;
  const statusURL = job.status_url || `${API_BASE}/api/jobs/${job.job_id}`;
  for (;;) {
    onProgress(job);
    if (job.state === "done") return getJSON(job.result?.result_url || url, signal);
    if (job.state === "error") throw new ApiError(job.message || "The backend could not build this product.", job.error || "upstream_unavailable");
    await sleep(POLL_MS, signal);
    job = await getJSON(statusURL, signal);
  }
}

export const api = {
  resolve: (name, opts = {}) => call("resolve", { name }, opts),

  /** Frames for one band. Uses the async job flow so cold positions show progress instead of hanging. */
  frames: (q, { preset, onProgress, signal } = {}) => {
    const query = { ra: q.ra, dec: q.dec, fov: q.fov, band: q.band, matched: q.matched ? 1 : undefined };
    return call("frames", query, {
      preset, signal,
      live: () => runJob(liveURL("frames", query), { onProgress, signal }),
      files: [q.matched ? `frames_matched_${q.band}.json` : "frames.json"],
      // a preset bake covers one band and one FOV: only use it when it matches the request
      accept: (d) => d.band === q.band && Math.abs(d.fov - q.fov) < 1e-6,
    }).then((r) => inlineFrameData(r, signal));
  },

  exposures: (q, opts = {}) => call("exposures", { ra: q.ra, dec: q.dec, fov: q.fov }, opts),

  spectrum: (q, opts = {}) => call("spectrum", q, {
    ...opts,
    live: () => runJob(liveURL("spectrum", q), { onProgress: opts.onProgress, signal: opts.signal }),
    files: [`spectrum_${q.det || "all"}.json`, "spectrum_all.json"],
  }),

  overlay: (q, opts = {}) => call("overlay", { ...q, cat: "gaia" }, opts),

  /** Server build info (data span). Live only: no fallback, returns null when unreachable. */
  meta: async () => {
    if (FORCE_MOCK) return null;
    try { return await getJSON(`${API_BASE}/api/meta`); } catch { return null; }
  },
};
