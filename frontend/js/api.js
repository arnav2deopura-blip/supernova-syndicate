// All network calls live here. Owner: C (safeguards ported from Z's "frontend pass 1").
// Order of fallbacks: live backend -> precomputed/<preset>/ (only when it matches the request exactly).
// Synthetic mock data is shown only when asked for with ?mock: never as a silent stand-in for a failed search.

// Which backend: the deployed one by default. Override with ?api=local (a backend on this machine, port 8000)
// or ?api=https://host; the choice is remembered in this browser until ?api=default.
export const DEPLOYED_API = "https://spherex-api.redgrass-773e0da8.canadacentral.azurecontainerapps.io";
export const LOCAL_API = "http://localhost:8000";
const API_KEY = "sse.apiBase";

function resolveApiBase() {
  if (typeof location === "undefined") return DEPLOYED_API;
  const store = (fn) => { try { return fn(); } catch { return null; } };
  const asked = new URLSearchParams(location.search).get("api");
  if (asked === "default") { store(() => localStorage.removeItem(API_KEY)); return DEPLOYED_API; }
  if (asked) {
    const base = asked === "local" ? LOCAL_API : /^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(asked) ? asked.replace(/\/$/, "") : null;
    if (base) { store(() => localStorage.setItem(API_KEY, base)); return base; }
  }
  return store(() => localStorage.getItem(API_KEY)) || DEPLOYED_API;
}
export const API_BASE = resolveApiBase();
export const apiLabel = () => (API_BASE === DEPLOYED_API ? "the deployed backend (Azure)" : API_BASE === LOCAL_API ? "a local backend (localhost:8000)" : API_BASE);

const params = () => (typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search));
const isDemo = () => params().has("mock");
// The five test targets have saved bakes from the same pipeline and release: use them first so a demo never waits
// on a server rebuild. ?fresh=1 always asks the backend.
const preferSaved = () => !params().has("fresh");
export const BAKE_FOV = 0.1;   // every saved bake is a 0.1° field
const POLL_MS = 1000;
const TIMEOUT_MS = 45000;      // one request (a cold container can take a while to wake); long builds are jobs

/** fn(message, level): level 1 = precomputed bake, 2 = mock. */
let onFallback = () => {};
export function setFallbackHandler(fn) { onFallback = fn; }

export class ApiError extends Error {
  constructor(message, code = "upstream_unavailable", status) { super(message); this.code = code; this.status = status; }
}

/** Errors that are real answers, not outages: never hide them behind a fallback. */
export const isAnswer = (e) => e.name === "AbortError" || ["bad_request", "not_found", "invalid_response"].includes(e.code);

const aborted = (signal) => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };
const withTimeout = (signal, ms = TIMEOUT_MS) => (AbortSignal.any && AbortSignal.timeout
  ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(ms)]) : signal);

async function fetchJSON(url, signal) {
  aborted(signal);
  let res;
  try { res = await fetch(url, { signal: withTimeout(signal) }); }
  catch (e) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    throw new ApiError(e.name === "TimeoutError" ? "The data service took too long to respond. Please retry." : "The data service is unavailable.");
  }
  let body;
  try { body = await res.json(); }
  catch { if (res.ok) throw new ApiError("The data service returned an unreadable response. Please retry.", "invalid_response"); body = {}; }
  if (!res.ok) throw new ApiError(body.message || `No result is available (HTTP ${res.status}).`, body.error || (res.status === 404 ? "not_found" : "upstream_unavailable"), res.status);
  return { status: res.status, body };
}
const getJSON = async (url, signal) => (await fetchJSON(url, signal)).body;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  aborted(signal);
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Cancelled", "AbortError")); }, { once: true });
});

const liveURL = (endpoint, query) => `${API_BASE}/api/${endpoint}?${new URLSearchParams(clean(query))}`;
const clean = (q) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const tag = (data, kind, label) => (data && typeof data === "object" ? Object.assign(data, { _provenance: { kind, label } }) : data);

const separationRA = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
/** A saved bake may stand in only for exactly this field: centre (RA wraps at 0), band and size. */
export function matchesSavedField(data, q) {
  return Number.isFinite(data?.ra) && Number.isFinite(data?.dec)
    && separationRA(data.ra, Number(q.ra)) < 0.00001 && Math.abs(data.dec - Number(q.dec)) < 0.00001
    && (!q.band || data.band === q.band) && (q.fov === undefined || Math.abs(data.fov - Number(q.fov)) < 0.00001);
}

const samePos = (d, q, tolDeg = 0.00001) => Number.isFinite(d?.ra) && Number.isFinite(d?.dec)
  && separationRA(d.ra, Number(q.ra)) * Math.cos((Number(q.dec) * Math.PI) / 180) < tolDeg && Math.abs(d.dec - Number(q.dec)) < tolDeg;
const bakeFov = (q) => Math.abs(Number(q.fov) - BAKE_FOV) < 1e-6;

/**
 * Call the live backend; on an outage try precomputed/<preset>/<file> (first that exists and passes `accept`).
 * mock/<endpoint>.json only with ?mock. `live` may be overridden (the async job flow). `savedOnly` skips the backend.
 */
async function call(endpoint, query, { preset, files = [`${endpoint}.json`], accept = () => true, live, signal, savedOnly = false } = {}) {
  aborted(signal);
  if (isDemo()) {
    onFallback("Showing MOCK data (synthetic, for development: not real observations).", 2);
    return tag(await getJSON(`mock/${endpoint}.json`, signal), "mock", "Synthetic demo · not real observations");
  }
  const trySaved = async (quiet) => {
    if (!preset || !/^[a-z0-9-]+$/.test(preset)) return null;
    for (const file of files) {
      try {
        const data = await getJSON(`precomputed/${preset}/${file}`, signal);
        if (!accept(data)) continue;
        if (!quiet) onFallback("Backend unreachable — showing precomputed data for this target.", 1);
        return tag(data, "precomputed", "Saved SPHEREx observations");
      } catch (e) { if (e.name === "AbortError") throw e; /* not baked */ }
    }
    return null;
  };
  if (!savedOnly && preferSaved()) {
    const saved = await trySaved(true);
    if (saved) return saved;
  }
  let liveError = null;
  if (!savedOnly) {
    try {
      return tag(await (live ? live() : getJSON(liveURL(endpoint, query), signal)), "live", "Live SPHEREx data");
    } catch (e) {
      if (isAnswer(e)) throw e;
      liveError = e;
      console.warn(`/api/${endpoint} failed:`, e.message);
    }
  }
  const saved = await trySaved(savedOnly);
  if (saved) return saved;
  if (savedOnly || !liveError) throw new ApiError("No saved observations match this request. A live backend is needed for it.", "not_found");
  // no saved copy: say what failed, and never invent data
  throw preset ? new ApiError(`/${endpoint} is not available offline for this position.`, "offline") : liveError;
}

// `data` and `noise` in a frame may be a URL instead of an inline array (see docs/API.md).
async function loadArray(ref, signal) {
  if (typeof ref !== "string") return ref;
  aborted(signal);
  const res = await fetch(ref, { signal: withTimeout(signal, 30000) });
  if (!res.ok) throw new ApiError(`An image or noise-map file is unavailable (HTTP ${res.status}). Please retry.`, "invalid_response", res.status);
  if (ref.split("?")[0].endsWith(".bin")) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength % 4) throw new ApiError("An image file has an invalid size.", "invalid_response");
    const view = new DataView(buf);   // little-endian float32, whatever the machine
    const arr = Array.from({ length: buf.byteLength / 4 }, (_, i) => view.getFloat32(i * 4, true));
    return Array.from(arr, (v) => (Number.isFinite(v) ? v : null));
  }
  return res.json();
}

async function inlineFrameData(resp, signal) {
  await Promise.all(resp.frames.map(async (f) => {
    f.data = await loadArray(f.data, signal);
    // the noise map is optional: without it the σ-change view is unavailable, the rest still works
    try {
      f.noise = f.noise ? await loadArray(f.noise, signal) : null;
      if (f.noise && f.noise.length !== f.data.length) f.noise = null;
    } catch (e) { if (e.name === "AbortError") throw e; f.noise = null; }
  }));
  return resp;
}

/** Cube channel images: `data` (all passes) or `frames[].data` (per_pass=1). */
async function inlineCubeData(resp, signal) {
  const jobs = [];
  for (const ch of resp.channels || []) {
    if (ch.data) jobs.push(loadArray(ch.data, signal).then((a) => { ch.data = a; }));
    for (const f of ch.frames || []) jobs.push(loadArray(f.data, signal).then((a) => { f.data = a; }));
  }
  await Promise.all(jobs);
  return resp;
}

/**
 * Check a /frames response before anything is drawn: valid WCS, one array of the right size per frame, finite
 * times, at least one usable pixel. Sorts frames by observation time.
 */
export function validateFrames(response) {
  const wcs = response?.wcs;
  if (!wcs || !Number.isInteger(wcs.width) || !Number.isInteger(wcs.height) || wcs.width < 1 || wcs.height < 1
    || !Number.isFinite(wcs.center_ra) || wcs.center_ra < 0 || wcs.center_ra >= 360 || !Number.isFinite(wcs.center_dec) || Math.abs(wcs.center_dec) > 90
    || !Number.isFinite(wcs.pixel_scale_arcsec) || wcs.pixel_scale_arcsec <= 0) throw new ApiError("The observations have missing or invalid sky coordinates.", "invalid_response");
  if (!Array.isArray(response.frames) || !response.frames.length) throw new ApiError("No observation periods are available for this region and band. Try another band or a nearby region.", "not_found");
  for (const f of response.frames) {
    if (!f || typeof f !== "object" || (f.mjd_mean != null && !Number.isFinite(f.mjd_mean))) throw new ApiError("An observation has missing or invalid metadata.", "invalid_response");
    if (!Array.isArray(f.data) || f.data.length !== wcs.width * wcs.height || f.width !== wcs.width || f.height !== wcs.height
      || !Number.isFinite(f.mjd_start) || !Number.isFinite(f.mjd_end) || f.mjd_end < f.mjd_start) throw new ApiError("An observation has an invalid image size or time range.", "invalid_response");
    if (f.data.some((v) => v !== null && (typeof v !== "number" || !Number.isFinite(v)))) throw new ApiError("An observation contains invalid pixel values.", "invalid_response");
    if (!f.data.some((v) => v !== null)) throw new ApiError("An observation contains no usable pixels. Try a different band or region.", "not_found");
  }
  response.frames.sort((a, b) => (a.mjd_mean ?? a.mjd_start) - (b.mjd_mean ?? b.mjd_start));
  return response;
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
    if (job.state === "done") {
      if (!job.result?.result_url) throw new ApiError("The finished job has no result URL.", "invalid_response");
      return getJSON(job.result.result_url, signal);
    }
    if (job.state === "error") throw new ApiError(job.message || "The backend could not build this product.", job.error || "upstream_unavailable");
    await sleep(POLL_MS, signal);
    job = await getJSON(statusURL, signal);
  }
}

export const api = {
  resolve: (name, opts = {}) => call("resolve", { name }, opts),

  /** Is the configured backend up? {ok, release} or null. */
  health: async () => { try { return await getJSON(`${API_BASE}/api/health`); } catch { return null; } },

  /** Frames for one band. Uses the async job flow so cold positions show progress instead of hanging. */
  frames: (q, { preset, onProgress, signal, savedOnly } = {}) => {
    const query = { ra: q.ra, dec: q.dec, fov: q.fov, band: q.band, matched: q.matched ? 1 : undefined };
    return call("frames", query, {
      preset, signal, savedOnly,
      live: () => runJob(liveURL("frames", query), { onProgress, signal }),
      files: [q.matched ? `frames_matched_${q.band}.json` : "frames.json"],
      // a preset bake covers one field, band and FOV: only use it when it matches the request exactly
      accept: (d) => matchesSavedField(d, q) && !!d.matched === !!q.matched,
    }).then((r) => inlineFrameData(r, signal)).then(validateFrames);
  },

  // the exposures and overlay bakes don't record their field: the app only names a preset for its exact centre,
  // so the size is the one thing left to check
  exposures: (q, opts = {}) => call("exposures", { ra: q.ra, dec: q.dec, fov: q.fov }, { ...opts, accept: () => bakeFov(q) }),

  spectrum: (q, opts = {}) => call("spectrum", q, {
    ...opts,
    live: () => runJob(liveURL("spectrum", q), { onProgress: opts.onProgress, signal: opts.signal }),
    files: [`spectrum_${q.det || "all"}.json`, "spectrum_all.json"],
    // the saved spectrum is the target's: only for a click within 6″ of it
    accept: (d) => samePos(d, q, 6 / 3600),
  }),

  overlay: (q, opts = {}) => call("overlay", { ...q, cat: "gaia" }, { ...opts, accept: () => bakeFov(q) }),

  /** Discovery mode: movers in the field (may be a slow job on a new position; runs silently). */
  movers: (q, { preset, signal } = {}) => {
    const query = { ra: q.ra, dec: q.dec, fov: q.fov, band: q.band };
    return call("movers", query, {
      preset, signal,
      live: () => runJob(liveURL("movers", query), { signal }),
      files: [`movers_${q.band}.json`],
      accept: (d) => matchesSavedField(d, q),
    });
  },

  /** The 102-band view, one detector per call. perPass: one image per channel per pass. */
  cube: (q, { preset, onProgress, signal } = {}) => {
    const query = { ra: q.ra, dec: q.dec, fov: q.fov, det: q.det, per_pass: q.perPass ? 1 : undefined };
    return call("cube", query, {
      preset, signal,
      live: () => runJob(liveURL("cube", query), { onProgress, signal }),
      files: [q.perPass ? `cube_pp_${q.det}.json` : `cube_${q.det}.json`],
      accept: (d) => d.det === q.det && !!d.per_pass === !!q.perPass && Math.abs(d.fov - q.fov) < 1e-6 && samePos(d, q),
    }).then((r) => inlineCubeData(r, signal));
  },

  motion: (q, { preset, signal } = {}) => call("motion", q, {
    preset, signal,
    live: () => runJob(liveURL("motion", q), { signal }),
    files: [`motion_${q.det}.json`],
    accept: (d) => samePos(d, q),
  }),

  lightcurve: (q, { preset, signal } = {}) => call("lightcurve", q, {
    preset, signal,
    live: () => runJob(liveURL("lightcurve", q), { signal }),
    files: [`lightcurve_${q.det}.json`],
    accept: (d) => d.det === q.det && samePos(d, q),
  }),

  /** Direct link to the frames as multi-extension FITS (live backend only). */
  framesFitsURL: (q) => `${API_BASE}/api/frames.fits?${new URLSearchParams(clean({ ra: q.ra, dec: q.dec, fov: q.fov, band: q.band, matched: q.matched ? 1 : undefined }))}`,

  /** Server build info (data span). Live only: no fallback, returns null when unreachable. */
  meta: async ({ check = false } = {}) => {
    if (isDemo()) return null;
    try { return await getJSON(`${API_BASE}/api/meta${check ? "?check=1" : ""}`); } catch { return null; }
  },
};
