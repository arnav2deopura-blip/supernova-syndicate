// All network calls live here. Owner: C (safeguards ported from Z's "frontend pass 1").
// Order of fallbacks: live backend -> precomputed/<preset>/ (only when it matches the request exactly).
// Synthetic mock data is shown only when asked for with ?mock: never as a silent stand-in for a failed search.
// ?fresh=1 ("Backend only", alias ?verify=1) proves the live path: saved data is never read and never used as a
// fallback; an outage is a visible error.

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
export const apiLabel = () => (API_BASE === DEPLOYED_API ? "Azure" : API_BASE === LOCAL_API ? "local (localhost:8000)" : API_BASE);
/** The value of ?api= that reproduces this backend in a shared link, or null for the default one. */
export const apiParam = () => (API_BASE === DEPLOYED_API ? null : API_BASE === LOCAL_API ? "local" : API_BASE);

const params = () => (typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search));
const isDemo = () => params().has("mock");
/** ?fresh=1 or ?verify=1: never read precomputed/, never fall back; an outage is a visible error. */
export const strictFresh = () => params().has("fresh") || params().has("verify");
export const isVerify = strictFresh;
// The five test targets have saved bakes from the same pipeline and release: use them first so a demo never waits
// on a server rebuild. Strict mode always asks the backend.
const preferSaved = () => !strictFresh();
export const BAKE_FOV = 0.1;   // every saved bake is a 0.1° field
const TIMEOUT_MS = 45000;      // one request (a cold container can take a while to wake); long builds are jobs
export const STALL_MS = 120000;           // a job with no progress for this long asks the user what to do
export const STALL_LIMIT_MS = 5 * 60000;  // ...and fails after this long when nobody can be asked (docs/API.md)
export const JOB_LIMIT_MS = 20 * 60000;   // no job is waited on longer than this (docs/API.md)
const MAX_PIXELS = 1024 * 1024;  // a 0.5° field at 3.075″ is 586² ≈ 343k pixels; anything far larger is malformed
const MAX_FRAMES = 200;
const MAX_BYTES = 64 * 1024 * 1024;
/** Poll every second at first, then less often: a long build does not need 1 Hz polling. */
export const pollDelay = (elapsedMs) => (elapsedMs < 20000 ? 1000 : elapsedMs < 120000 ? 2000 : 4000);

/** fn(message, level): level 1 = precomputed bake, 2 = mock. */
let onFallback = () => {};
export function setFallbackHandler(fn) { onFallback = fn; }

export class ApiError extends Error {
  constructor(message, code = "upstream_unavailable", status) { super(message); this.code = code; this.status = status; }
}
const unreadable = (what) => new ApiError(`The service returned data this page cannot read (${what}).`, "invalid_response");

/** Errors that are real answers, not outages: never hide them behind a fallback. */
export const isAnswer = (e) => e.name === "AbortError" || ["bad_request", "not_found", "invalid_response"].includes(e.code);

const aborted = (signal) => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };

/**
 * A signal that aborts when `signal` does or after `ms`. Timer based, so it works on browsers without
 * AbortSignal.any / AbortSignal.timeout. Call done() when the wait ends: it clears the timer and the listener.
 */
export function withTimeout(signal, ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => { state.timedOut = true; ac.abort(); }, ms);
  const onAbort = () => ac.abort();
  if (signal?.aborted) ac.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return { signal: ac.signal, state, done: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
}

/**
 * Read a response body with a size cap and a transfer deadline: a stalled or oversized download fails instead of
 * hanging or exhausting memory.
 */
async function readBody(response, signal, maxBytes = MAX_BYTES) {
  aborted(signal);
  const reader = response.body?.getReader?.();
  let timer, cancel;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { reader?.cancel().catch(() => {}); reject(new ApiError("The data transfer stalled. Please retry.")); }, TIMEOUT_MS);
    cancel = () => { reader?.cancel().catch(() => {}); reject(new DOMException("Cancelled", "AbortError")); };
    signal?.addEventListener("abort", cancel, { once: true });
  });
  const read = async () => {
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new ApiError("The data response is too large.", "invalid_response");
      return bytes;
    }
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new ApiError("The data response is too large. Choose a smaller field of view.", "invalid_response"); }
      chunks.push(value);
    }
    aborted(signal);
    const bytes = new Uint8Array(total); let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
    return bytes;
  };
  try { return await Promise.race([read(), deadline]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

async function fetchJSON(url, signal) {
  aborted(signal);
  const t = withTimeout(signal);
  try {
    let res;
    try { res = await fetch(url, { signal: t.signal }); }
    catch (e) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      throw new ApiError(t.state.timedOut || e.name === "TimeoutError" ? "The data service took too long to respond. Please retry." : "The data service is unavailable.");
    }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(await readBody(res, signal))); }
    catch (e) {
      if (e instanceof ApiError || e.name === "AbortError") throw e;
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (t.state.timedOut) throw new ApiError("The data service took too long to respond. Please retry.");
      if (res.ok) throw new ApiError("The data service returned an unreadable response. Please retry.", "invalid_response");
      body = {};
    }
    if (!res.ok) {
      const b = body && typeof body === "object" ? body : {};
      const code = res.status === 429 ? "busy" : b.error || (res.status === 404 ? "not_found" : "upstream_unavailable");
      const err = new ApiError(b.message || `No result is available (HTTP ${res.status}).`, code, res.status);
      if (code === "busy") {
        const after = Number(b.retry_after ?? res.headers?.get?.("retry-after"));
        err.retryAfter = Number.isFinite(after) && after > 0 ? Math.min(after, 120) : 10;
        err.ahead = Number.isFinite(b.ahead) ? b.ahead : null;
      }
      throw err;
    }
    return { status: res.status, body };
  } finally { t.done(); }
}
const getJSON = async (url, signal) => (await fetchJSON(url, signal)).body;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  aborted(signal);
  const onAbort = () => { clearTimeout(t); reject(new DOMException("Cancelled", "AbortError")); };
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

const liveURL = (endpoint, query) => `${API_BASE}/api/${endpoint}?${new URLSearchParams(clean(query))}`;
const clean = (q) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/**
 * Record where data came from. kind: precomputed | live | mock. For live data, origin says whether the server
 * answered from its cache (HTTP 200) or built the product for this request (a job, HTTP 202). The backend's own
 * provenance block, when it sends one, wins.
 */
function tag(data, kind, label) {
  if (!data || typeof data !== "object") return data;
  const own = data.provenance && typeof data.provenance === "object" ? data.provenance : {};
  const fromBackend = data.retrieval?.kind === "built" ? "processed_now" : data.retrieval?.kind === "server_cache" ? "server_cache" : null;
  const origin = kind === "live" ? own.origin || fromBackend || data._origin || null : null;
  const job = data._job || null;
  delete data._origin; delete data._job;
  // completeness counts: the backend's `completeness` block (docs/API.md), else a proposed `provenance.counts`
  const c = data.completeness && typeof data.completeness === "object" ? data.completeness : null;
  const counts = c ? Object.fromEntries(Object.entries({ selected: c.selected, retrieved: c.downloaded_or_cached, failed: c.failed, "off chip": c.off_chip })
    .filter(([, v]) => Number.isFinite(v))) : own.counts || null;
  const complete = c && Number.isFinite(c.failed) ? c.failed === 0 : own.complete ?? null;
  return Object.assign(data, { _provenance: { kind, label, origin, job, counts: counts && Object.keys(counts).length ? counts : null, complete,
    access_path: own.access_path || null, built_at: own.built_at || null,
    pipeline_version: own.pipeline_version || (own.processing_sha256 ? `processing ${String(own.processing_sha256).slice(0, 12)}` : null),
    config: own.config_sha256 ? String(own.config_sha256).slice(0, 12) : null } });
}

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
  const getLive = () => (live ? live() : getJSON(liveURL(endpoint, query), signal));
  if (isVerify() && !savedOnly) return tag(await getLive(), "live", "Live SPHEREx data");
  const trySaved = async (quiet) => {
    if (isVerify() || !preset || !/^[a-z0-9-]+$/.test(preset)) return null;
    for (const file of files) {
      try {
        const data = await getJSON(`precomputed/${preset}/${file}`, signal);
        if (!data || typeof data !== "object" || !accept(data)) continue;
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
      return tag(await getLive(), "live", "Live SPHEREx data");
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

// ---- structure checks: every response is checked before any array is touched ----
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** A valid image grid, not absurdly large. Returns width × height. */
function checkWCS(wcs) {
  if (!wcs || !Number.isInteger(wcs.width) || !Number.isInteger(wcs.height) || wcs.width < 1 || wcs.height < 1
    || !Number.isFinite(wcs.center_ra) || wcs.center_ra < 0 || wcs.center_ra >= 360 || !Number.isFinite(wcs.center_dec) || Math.abs(wcs.center_dec) > 90
    || !Number.isFinite(wcs.pixel_scale_arcsec) || wcs.pixel_scale_arcsec <= 0) throw new ApiError("The observations have missing or invalid sky coordinates.", "invalid_response");
  if (wcs.width * wcs.height > MAX_PIXELS) throw unreadable("image larger than this page accepts");
  return wcs.width * wcs.height;
}

// `data` and `noise` in a frame may be a URL instead of an inline array (see docs/API.md).
// `expected` = the number of pixels the grid says the array must have.
async function loadArray(ref, signal, expected) {
  if (typeof ref !== "string") {
    if (ref != null && (!Array.isArray(ref) || (expected && ref.length !== expected))) throw unreadable("inline image of the wrong size");
    return ref;
  }
  aborted(signal);
  const t = withTimeout(signal, 30000);
  try {
    let res;
    try { res = await fetch(ref, { signal: t.signal }); }
    catch (e) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      throw new ApiError(t.state.timedOut ? "An image file took too long to download. Please retry." : "An image file could not be downloaded. Please retry.", "upstream_unavailable");
    }
    if (!res.ok) throw new ApiError(`An image or noise-map file is unavailable (HTTP ${res.status}). Please retry.`, "invalid_response", res.status);
    if (ref.split("?")[0].endsWith(".bin")) {
      const declared = Number(res.headers?.get?.("content-length"));
      // a gzip transfer reports the compressed size, so only an over-large declared size is a reliable error
      if (Number.isFinite(declared) && declared > MAX_PIXELS * 4) throw unreadable("image file too large");
      const buf = (await readBody(res, signal, MAX_PIXELS * 4 + 4)).buffer;
      if (buf.byteLength % 4) throw new ApiError("An image file has an invalid size.", "invalid_response");
      if (expected && buf.byteLength !== expected * 4) throw unreadable(`image file has ${buf.byteLength / 4} pixels, the grid needs ${expected}`);
      if (buf.byteLength > MAX_PIXELS * 4) throw unreadable("image file too large");
      const view = new DataView(buf);   // little-endian float32, whatever the machine
      const out = new Array(buf.byteLength / 4);
      for (let i = 0; i < out.length; i++) { const v = view.getFloat32(i * 4, true); out[i] = Number.isFinite(v) ? v : null; }
      return out;
    }
    let arr;
    try { arr = JSON.parse(new TextDecoder().decode(await readBody(res, signal, MAX_PIXELS * 24))); }
    catch (e) { if (e instanceof ApiError || e.name === "AbortError") throw e; throw unreadable("image file is not JSON"); }
    if (!Array.isArray(arr) || (expected && arr.length !== expected)) throw unreadable("image array of the wrong size");
    return arr;
  } finally { t.done(); }
}

/** Shape checks a /frames response must pass before its images are downloaded. */
export function validateEnvelope(resp) { precheckFrames(resp); return resp; }
function precheckFrames(resp) {
  if (!isObj(resp)) throw unreadable("frames: not an object");
  const n = checkWCS(resp.wcs);
  if (!Array.isArray(resp.frames)) throw unreadable("frames: no frame list");
  if (resp.frames.length > MAX_FRAMES || resp.frames.length * n > 16 * MAX_PIXELS) throw unreadable("frames: more images than this page accepts");
  for (const f of resp.frames) if (!isObj(f)) throw new ApiError("An observation has missing or invalid metadata.", "invalid_response");
  return n;
}

async function inlineFrameData(resp, signal) {
  const n = precheckFrames(resp);
  await Promise.all(resp.frames.map(async (f) => {
    f.data = await loadArray(f.data, signal, n);
    // the noise map is optional: without it the σ-change view is unavailable, the rest still works
    try {
      f.noise = f.noise ? await loadArray(f.noise, signal, n) : null;
      if (f.noise && f.noise.length !== f.data?.length) f.noise = null;
      // a noise value must be a positive number; anything else is "no noise known" for that pixel
      if (f.noise) f.noise = f.noise.map((v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null));
    } catch (e) { if (e.name === "AbortError") throw e; f.noise = null; }
  }));
  return resp;
}

/** Cube channel images: `data` (all passes) or `frames[].data` (per_pass=1). */
async function inlineCubeData(resp, signal) {
  if (!isObj(resp)) throw unreadable("cube: not an object");
  const n = checkWCS(resp.wcs);
  if (!Array.isArray(resp.channels)) throw unreadable("cube: no channel list");
  if (resp.channels.length > 17) throw unreadable("cube: more than 17 channels in one detector");
  const images = resp.channels.reduce((a, ch) => a + (Array.isArray(ch?.frames) ? ch.frames.length : 1), 0);
  if (images * n > 16 * MAX_PIXELS) throw unreadable("this spectral cube is too large for the browser; choose a smaller field of view");
  const jobs = [];
  for (const ch of resp.channels) {
    if (!isObj(ch)) throw unreadable("cube: a channel entry is not an object");
    if (ch.data) jobs.push(loadArray(ch.data, signal, n).then((a) => { ch.data = a; }));
    if (ch.frames != null && !Array.isArray(ch.frames)) throw unreadable("cube: per-pass list is not a list");
    for (const f of ch.frames || []) {
      if (!isObj(f)) throw unreadable("cube: a per-pass entry is not an object");
      jobs.push(loadArray(f.data, signal, n).then((a) => { f.data = a; }));
    }
  }
  await Promise.all(jobs);
  return resp;
}

/** A /cube response after its images are loaded: detector, channel names, image sizes. */
export function validateCube(c) {
  if (!isObj(c)) throw unreadable("cube: not an object");
  const n = checkWCS(c.wcs);
  if (typeof c.det !== "string" || !/^D[1-6]$/.test(c.det)) throw unreadable("cube: unknown detector");
  if (!Array.isArray(c.channels)) throw unreadable("cube: no channel list");
  if (!c.channels.length) throw new ApiError("No spectral channels are available for this region.", "not_found");
  const seen = new Set();
  for (const ch of c.channels) {
    if (!isObj(ch) || typeof ch.channel !== "string" || !new RegExp(`^${c.det}C(0[1-9]|1[0-7])$`).test(ch.channel) || seen.has(ch.channel)) throw unreadable("cube: a channel has no valid or a repeated identifier");
    seen.add(ch.channel);
    if (!fin(ch.lam_um) || ch.lam_um <= 0) throw unreadable(`cube: ${ch.channel} has an invalid wavelength`);
    if (ch.data != null && (!Array.isArray(ch.data) || ch.data.length !== n)) throw unreadable(`cube: ${ch.channel} image has the wrong size`);
    for (const f of ch.frames || []) {
      if (typeof f.epoch_label !== "string" || !Array.isArray(f.data) || f.data.length !== n) throw unreadable(`cube: ${ch.channel} per-pass image is invalid`);
      if (c.per_pass && !fin(f.mjd_mean)) throw unreadable(`cube: ${ch.channel} per-pass entry has no time`);
    }
  }
  return c;
}

/**
 * Check a /frames response before anything is drawn: valid WCS, one array of the right size per frame, finite
 * times, at least one usable pixel. Sorts frames by observation time.
 */
export function validateFrames(response) {
  const wcs = response?.wcs;
  checkWCS(wcs);
  if (!Array.isArray(response.frames) || !response.frames.length) throw new ApiError("No observation periods are available for this region and band. Try another band or a nearby region.", "not_found");
  for (const f of response.frames) {
    if (!f || typeof f !== "object" || (f.mjd_mean != null && !Number.isFinite(f.mjd_mean))) throw new ApiError("An observation has missing or invalid metadata.", "invalid_response");
    if (!Array.isArray(f.data) || f.data.length !== wcs.width * wcs.height || f.width !== wcs.width || f.height !== wcs.height
      || !Number.isFinite(f.mjd_start) || !Number.isFinite(f.mjd_end) || f.mjd_end < f.mjd_start) throw new ApiError("An observation has an invalid image size or time range.", "invalid_response");
    if (typeof f.epoch_label !== "string" || !f.epoch_label) throw new ApiError("An observation has no pass label.", "invalid_response");
    if (f.data.some((v) => v !== null && (typeof v !== "number" || !Number.isFinite(v)))) throw new ApiError("An observation contains invalid pixel values.", "invalid_response");
    if (!f.data.some((v) => v !== null)) throw new ApiError("An observation contains no usable pixels. Try a different band or region.", "not_found");
  }
  response.frames.sort((a, b) => (a.mjd_mean ?? a.mjd_start) - (b.mjd_mean ?? b.mjd_start));
  return response;
}

export function validateSpectrum(s) {
  if (!isObj(s) || !Array.isArray(s.points)) throw unreadable("spectrum: no point list");
  for (const p of s.points) {
    if (!isObj(p) || !fin(p.wavelength_um) || p.wavelength_um <= 0) throw unreadable("spectrum: a point has no valid wavelength");
    if (p.flux != null && !fin(p.flux)) throw unreadable("spectrum: a point has an invalid flux");
    if (p.flux_err != null && !fin(p.flux_err)) throw unreadable("spectrum: a point has an invalid error");
  }
  return s;
}

/** Gaia overlay: a list of sources with finite positions; per-epoch positions default to none. */
export function validateOverlay(o) {
  if (!isObj(o) || !Array.isArray(o.sources)) throw unreadable("overlay: no source list");
  o.sources = o.sources.filter((s) => isObj(s) && fin(s.ra) && fin(s.dec)).map((s) => ({
    ...s, positions_by_epoch: Array.isArray(s.positions_by_epoch) ? s.positions_by_epoch.filter((p) => isObj(p) && fin(p.ra) && fin(p.dec)) : [],
  }));
  return o;
}

export function validateMovers(m) {
  if (!isObj(m) || !Array.isArray(m.tracks)) throw unreadable("movers: no track list");
  for (const t of m.tracks) {
    if (!isObj(t) || !Array.isArray(t.passes) || !t.passes.length || t.passes.some((p) => !isObj(p) || !fin(p.ra) || !fin(p.dec))) throw unreadable("movers: a track has no valid positions");
  }
  return m;
}

const validateObject = (what, extra = () => true) => (r) => {
  if (!isObj(r) || !extra(r)) throw unreadable(what);
  return r;
};
export const validateLightcurve = validateObject("light curve", (r) => r.points == null || Array.isArray(r.points));
export const validateMotion = validateObject("motion", (r) => r.fit == null || isObj(r.fit));
export const validateExposures = validateObject("exposures", (r) => Array.isArray(r.exposures) && r.exposures.every(isObj));
export const validateResolve = validateObject("name lookup", (r) => fin(r.ra) && r.ra >= 0 && r.ra < 360 && fin(r.dec) && Math.abs(r.dec) <= 90);
const checkJob = (j) => {
  if (!isObj(j) || !["queued", "running", "done", "error"].includes(j.state)) throw unreadable("job status");
  return j;
};

/** Job status and result URLs must stay on the backend that issued them. */
function sameOrigin(u) {
  try { const url = new URL(u, API_BASE); if (url.origin === new URL(API_BASE).origin) return url.href; } catch { /* invalid */ }
  throw new ApiError("The service returned a job link to another site.", "invalid_response");
}

/** Mark a live body with how it was produced (read by tag()). */
const withOrigin = (body, origin, job = null) => {
  if (isObj(body)) Object.defineProperty(body, "_origin", { value: origin, configurable: true, writable: true, enumerable: false });
  if (isObj(body) && job) Object.defineProperty(body, "_job", { value: job, configurable: true, writable: true, enumerable: false });
  return body;
};

/**
 * Ask for a product with async=1. 200 = cached, use it. 202 = a job: poll its status_url, reporting progress,
 * until done (then fetch result.result_url) or error.
 *   - polling slows down as the job runs (pollDelay)
 *   - a job with no progress for STALL_MS calls onStall(job): resolve "wait" to keep polling; without onStall
 *     (or any other answer) it fails with code "stalled"
 *   - no job is waited on for more than JOB_LIMIT_MS
 *   - a job the server forgot (404: it restarted) is submitted again once
 *   - HTTP 429 "busy": wait the server's retry delay and ask again
 */
async function runJob(url, { onProgress = () => {}, onStall = null, signal } = {}) {
  const sep = url.includes("?") ? "&" : "?";
  const submit = async () => {
    for (let tries = 0; ; tries++) {
      try { return await fetchJSON(`${url}${sep}async=1`, signal); }
      catch (e) {
        if (e.code !== "busy" || tries >= 10) throw e;
        for (let s = e.retryAfter; s > 0; s--) {
          onProgress({ state: "busy", message: `Busy${e.ahead ? `: ${e.ahead} request${e.ahead === 1 ? "" : "s"} ahead of yours` : ""}. Trying again in ${s} s`, done: 0, total: 0 });
          await sleep(1000, signal);
        }
      }
    }
  };
  const t0 = Date.now();
  let first = await submit();
  if (first.status !== 202) return withOrigin(first.body, "server_cache");
  let job = checkJob(first.body);
  let statusURL = sameOrigin(job.status_url || `${API_BASE}/api/jobs/${job.job_id}`);
  let resubmitted = false, sig = null, lastChange = Date.now(), files = 0;
  for (;;) {
    const s = `${job.state}|${job.stage}|${job.done}|${job.total}|${job.message}`;
    if (s !== sig) { sig = s; lastChange = Date.now(); }
    if (job.stage === "stamps" && job.total) files = job.total;
    onProgress(job);
    if (job.state === "done") {
      if (!job.result?.result_url) throw new ApiError("The finished job has no result URL.", "invalid_response");
      const body = await getJSON(sameOrigin(job.result.result_url), signal);
      if (isObj(body) && job.result.retrieval) body.retrieval = job.result.retrieval;
      return withOrigin(body, "processed_now", { files: files || null, seconds: Math.round((Date.now() - t0) / 1000) });
    }
    if (job.state === "error") throw new ApiError(job.message || "The backend could not build this product.", job.error || "upstream_unavailable");
    const now = Date.now();
    if (now - t0 > JOB_LIMIT_MS) throw new ApiError("The server has worked on this for over 30 minutes without finishing. Please try again later.", "timeout");
    if (now - lastChange > (onStall ? STALL_MS : STALL_LIMIT_MS)) {
      const answer = onStall ? await onStall(job) : null;
      aborted(signal);
      if (answer !== "wait") throw new ApiError("Processing stopped reporting progress. Retry this search to resume from cached downloads.", "stalled");
      lastChange = Date.now();
    }
    await sleep(pollDelay(now - t0), signal);
    try { job = checkJob(await getJSON(statusURL, signal)); }
    catch (e) {
      if (e.status !== 404) throw e;
      if (resubmitted) throw new ApiError("The server lost this request twice (it may be restarting). Please retry in a minute.", "job_lost", 404);
      resubmitted = true;
      onProgress({ state: "queued", message: "The server restarted; your request was sent again.", restarted: true, done: 0, total: 0 });
      first = await submit();
      if (first.status !== 202) return withOrigin(first.body, "server_cache");
      job = checkJob(first.body);
      statusURL = sameOrigin(job.status_url || `${API_BASE}/api/jobs/${job.job_id}`);
      sig = null;
    }
  }
}

export const api = {
  resolve: (name, opts = {}) => call("resolve", { name }, opts).then(validateResolve),

  /** Is the configured backend up? {ok, release} or null. */
  health: async () => { try { return await getJSON(`${API_BASE}/api/health`); } catch { return null; } },

  /** Frames for one band. Uses the async job flow so cold positions show progress instead of hanging. */
  frames: (q, { preset, onProgress, onStall, signal, savedOnly } = {}) => {
    const query = { ra: q.ra, dec: q.dec, fov: q.fov, band: q.band, matched: q.matched ? 1 : undefined, retry_missing: q.retryMissing ? 1 : undefined };
    return call("frames", query, {
      preset, signal, savedOnly,
      live: () => runJob(liveURL("frames", query), { onProgress, onStall, signal }),
      files: [q.matched ? `frames_matched_${q.band}.json` : "frames.json"],
      // a preset bake covers one field, band and FOV: only use it when it matches the request exactly
      accept: (d) => matchesSavedField(d, q) && !!d.matched === !!q.matched,
    }).then((r) => {
      precheckFrames(r);
      // a well-formed answer for another field, band or size is still the wrong answer
      if (!isDemo() && (!matchesSavedField(r, q) || !!r.matched !== !!q.matched)) throw unreadable("the images do not match the requested coordinates, band or field of view");
      return inlineFrameData(r, signal);
    }).then(validateFrames);
  },

  // the exposures and overlay bakes don't record their field: the app only names a preset for its exact centre,
  // so the size is the one thing left to check
  exposures: (q, opts = {}) => call("exposures", { ra: q.ra, dec: q.dec, fov: q.fov }, { ...opts, accept: () => bakeFov(q) }).then(validateExposures),

  spectrum: (q, opts = {}) => call("spectrum", q, {
    ...opts,
    live: () => runJob(liveURL("spectrum", q), { onProgress: opts.onProgress, signal: opts.signal }),
    files: [`spectrum_${q.det || "all"}.json`, "spectrum_all.json"],
    // the saved spectrum is the target's: only for a click within 6″ of it
    accept: (d) => samePos(d, q, 6 / 3600),
  }).then(validateSpectrum),

  overlay: (q, opts = {}) => call("overlay", { ...q, cat: "gaia" }, { ...opts, accept: () => bakeFov(q) }).then(validateOverlay),

  /** Discovery mode: movers in the field (may be a slow job on a new position; runs silently). */
  movers: (q, { preset, signal } = {}) => {
    const query = { ra: q.ra, dec: q.dec, fov: q.fov, band: q.band };
    return call("movers", query, {
      preset, signal,
      live: () => runJob(liveURL("movers", query), { signal }),
      files: [`movers_${q.band}.json`],
      accept: (d) => matchesSavedField(d, q),
    }).then(validateMovers);
  },

  /** The 102-band view, one detector per call. perPass: one image per channel per pass. */
  cube: (q, { preset, onProgress, onStall, signal } = {}) => {
    const query = { ra: q.ra, dec: q.dec, fov: q.fov, det: q.det, per_pass: q.perPass ? 1 : undefined };
    return call("cube", query, {
      preset, signal,
      live: () => runJob(liveURL("cube", query), { onProgress, onStall, signal }),
      files: [q.perPass ? `cube_pp_${q.det}.json` : `cube_${q.det}.json`],
      accept: (d) => d.det === q.det && !!d.per_pass === !!q.perPass && Math.abs(d.fov - q.fov) < 1e-6 && samePos(d, q),
    }).then((r) => inlineCubeData(r, signal)).then(validateCube);
  },

  motion: (q, { preset, signal } = {}) => call("motion", q, {
    preset, signal,
    live: () => runJob(liveURL("motion", q), { signal }),
    files: [`motion_${q.det}.json`],
    accept: (d) => samePos(d, q),
  }).then(validateMotion),

  lightcurve: (q, { preset, signal } = {}) => call("lightcurve", q, {
    preset, signal,
    live: () => runJob(liveURL("lightcurve", q), { signal }),
    files: [`lightcurve_${q.det}.json`],
    accept: (d) => d.det === q.det && samePos(d, q),
  }).then(validateLightcurve),

  /** Direct link to the frames as multi-extension FITS (live backend only). */
  framesFitsURL: (q) => `${API_BASE}/api/frames.fits?${new URLSearchParams(clean({ ra: q.ra, dec: q.dec, fov: q.fov, band: q.band, matched: q.matched ? 1 : undefined }))}`,

  /** Server build info (data span). Live only: no fallback, returns null when unreachable. */
  meta: async ({ check = false } = {}) => {
    if (isDemo()) return null;
    try { return await getJSON(`${API_BASE}/api/meta${check ? "?check=1" : ""}`); } catch { return null; }
  },
};
