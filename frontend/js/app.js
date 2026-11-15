// Wiring, the three search modes and URL state (?mode=&ra=&dec=&fov=&band=&matched=&name=). Owner: C.
//   explore: pan/zoom an all-sky map, select a region (js/sky.js)
//   name:    resolve an object name (/api/resolve), then compare
//   coords:  type RA/Dec, then compare
// Every mode ends in loadTarget(), which runs /api/frames as an async job and drives the viewer.
import { api, setFallbackHandler } from "./api.js";
import { Player } from "./player.js";
import { composeFrame, draw } from "./render.js";
import { drawOverlay, pixelToSky } from "./overlays.js";
import { drawSpectrum } from "./spectrum.js";
import { createSky, BACKGROUNDS, channelName, sliceForBand } from "./sky.js";

// The five challenge test targets. Coordinates are refined at start-up from the precomputed bakes
// (precomputed/<slug>/resolve.json, the exact positions the bakes were built at).
const PRESETS = [
  { slug: "barnards-star", label: "Barnard's Star", name: "Barnard's Star", ra: 269.446074, dec: 4.770711, band: "D2" },
  { slug: "eps-indi-b", label: "ε Indi B", name: "eps Indi B", ra: 331.0984021, dec: -56.8012569, band: "D3" },
  { slug: "wise-0855", label: "WISE 0855−0714", name: "WISE J085510.83-071442.5", ra: 133.7577838, dec: -7.2420232, band: "D6" },
  { slug: "rw-aur", label: "RW Aur", name: "RW Aur", ra: 76.9565886, dec: 30.4012864, band: "D2" },
  { slug: "r-dra", label: "R Dra", name: "R Dra", ra: 248.1672204, dec: 66.7550253, band: "D2" },
];
const MODES = ["explore", "name", "coords"];
const RECENT_KEY = "sse.recentNames";

const $ = (id) => document.getElementById(id);
const ui = {
  tabs: [...document.querySelectorAll('[role="tab"]')],
  panels: { explore: $("panel-explore"), name: $("panel-name"), coords: $("panel-coords") },
  // shared
  fov: $("fov"), band: $("band"), matched: $("matched"),
  progress: $("progress"), progressBar: $("progress-bar"), progressText: $("progress-text"), cancel: $("progress-cancel"),
  // name
  name: $("name"), suggest: $("name-suggest"), nameResult: $("name-result"), presets: $("presets"),
  // coords
  ra: $("ra"), dec: $("dec"), echo: $("coord-echo"),
  // explore
  skyWrap: $("sky-wrap"), skyMsg: $("sky-msg"), skyBg: $("sky-bg"), skySlice: $("sky-slice"), skySliceLabel: $("sky-slice-label"),
  skyDraw: $("sky-draw"), skyView: $("sky-view"), skyCursor: $("sky-cursor"), skySel: $("sky-sel"), skyCov: $("sky-cov"),
  skyCompare: $("sky-compare"),
  // viewer
  targetLabel: $("target-label"), showOnSky: $("show-on-sky"),
  image: $("image"), overlay: $("overlay"), play: $("play"), speed: $("speed"),
  frameLabel: $("frame-label"), mode: $("mode"), stretch: $("stretch"), cmap: $("cmap"), clip: $("clip"),
  showOverlay: $("show-overlay"), meta: document.querySelector("#meta tbody"), spectrum: $("spectrum"), banner: $("banner"),
  dataSpan: $("data-span"),
};

const state = {
  mode: "name",
  frames: null, sources: null, preset: null, index: 0,
  target: null,        // {ra, dec, label, pm} currently shown in the viewer
  selection: null,     // explore-mode region not yet compared: {ra, dec, side}
  jobAbort: null, spectrumAbort: null, coverageAbort: null,
};

let fallbackLevel = 0;   // worst data fallback shown for the current target (1 precomputed, 2 mock)
function showBanner(msg) { ui.banner.textContent = msg; ui.banner.hidden = false; }
function hideBanner() { ui.banner.hidden = true; fallbackLevel = 0; }
// a later, milder fallback (e.g. a precomputed overlay) must not hide that the frames are mock
setFallbackHandler((msg, level) => { if (level >= fallbackLevel) { fallbackLevel = level; showBanner(msg); } });

// ---- coordinates: parsing and formatting ----
/** Decimal degrees, or sexagesimal (RA in hours). Returns NaN when unreadable. */
export function parseCoord(text, isRA) {
  const s = String(text).trim();
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.replace(/[hdms°'"′″]/g, " ").split(/[\s:]+/).filter(Boolean).map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(Number.isNaN)) return NaN;
  const sign = s.startsWith("-") ? -1 : 1;
  const [a, b, c = 0] = parts.map(Math.abs);
  if (b >= 60 || c >= 60) return NaN;
  const val = sign * (a + b / 60 + c / 3600);
  return isRA ? val * 15 : val;
}

/** "ra dec" in one string: "269.4 4.7", "269.4, +4.7", "17:57:47 +04:46:14", "17 57 47 +04 46 14". */
export function parsePair(text) {
  const s = String(text).trim();
  let a, b;
  if (s.includes(",")) [a, b] = s.split(",", 2);
  else {
    const t = s.split(/\s+/);
    if (t.length === 2) [a, b] = t;
    else if (t.length === 6) { a = t.slice(0, 3).join(" "); b = t.slice(3).join(" "); }
    else {
      const i = t.findIndex((x, k) => k > 0 && /^[+-]/.test(x));
      if (i > 0) { a = t.slice(0, i).join(" "); b = t.slice(i).join(" "); }
    }
  }
  if (!a || !b) return null;
  return { ra: parseCoord(a, true), dec: parseCoord(b, false) };
}

function sexa(v, hours) {
  const sign = v < 0 ? "-" : hours ? "" : "+";
  let x = Math.abs(hours ? v / 15 : v);
  const d = Math.floor(x); x = (x - d) * 60;
  const m = Math.floor(x); const s = (x - m) * 60;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ss = s.toFixed(hours ? 2 : 1).padStart(hours ? 5 : 4, "0");
  return `${sign}${pad(d)}:${pad(m)}:${ss}`;
}
const fmtDeg = (ra, dec) => `${ra.toFixed(4)}°, ${dec >= 0 ? "+" : ""}${dec.toFixed(4)}°`;
const fmtSexa = (ra, dec) => `${sexa(ra, true)} ${sexa(dec, false)}`;
const validRA = (ra) => Number.isFinite(ra) && ra >= 0 && ra < 360;
const validDec = (dec) => Number.isFinite(dec) && dec >= -90 && dec <= 90;

function sepDeg(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180;
  const h = Math.sin(((dec2 - dec1) * r) / 2) ** 2 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / r;
}
/** The preset whose bake sits at this position (so the offline fallback works in every mode). */
const nearestPreset = (ra, dec) => PRESETS.find((p) => sepDeg(ra, dec, p.ra, p.dec) < 0.01) || null;
const presetByName = (name) => {
  const n = name.trim().toLowerCase().replace(/[’']/g, "'");
  return PRESETS.find((p) => [p.name, p.label, p.slug].some((x) => x.toLowerCase() === n)) || null;
};

// ---- shared controls ----
function fovValue() { return parseFloat(ui.fov.value); }
/** Select an FOV, adding a custom option for drawn boxes (e.g. 0.37°). */
function setFov(side) {
  const v = String(+side.toFixed(3));
  let opt = [...ui.fov.options].find((o) => +o.value === +v);
  if (!opt) {
    ui.fov.querySelector("option[data-custom]")?.remove();
    opt = new Option(`${v}° (drawn)`, v);
    opt.dataset.custom = "";
    const after = [...ui.fov.options].find((o) => +o.value > +v);
    ui.fov.add(opt, after || null);
  }
  ui.fov.value = opt.value;
}

// ---- progress for long backend jobs ----
const STAGE_TEXT = {
  search: "Searching the archive", query: "Searching the archive", headers: "Reading image headers",
  stamps: "Downloading image cutouts", coadd: "Co-adding passes", qc: "Checking registration",
};
function showProgress(text, job) {
  ui.progress.hidden = false;
  if (job && job.total) { ui.progressBar.max = job.total; ui.progressBar.value = job.done; }
  else ui.progressBar.removeAttribute("value");   // indeterminate
  ui.progressText.textContent = text;
}
function hideProgress() { ui.progress.hidden = true; }
function jobText(job, t0) {
  const what = job.message || STAGE_TEXT[job.stage] || (job.state === "queued" ? "Waiting for a free worker" : "Working");
  const n = job.total ? ` (${job.done}/${job.total})` : "";
  const secs = Math.round((Date.now() - t0) / 1000);
  return `${what}${n} · ${secs}s — a first look at a position takes 1–10 min, then it's cached.`;
}

// ---- rendering ----
function render() {
  if (!state.frames) return;
  const { frames, wcs } = state.frames;
  const mode = ui.mode.value;
  const data = composeFrame(frames, state.index, mode);
  const all = mode === "blink" ? frames.flatMap((f) => f.data) : data;
  draw(ui.image, data, wcs.width, wcs.height, {
    stretch: ui.stretch.value, cmap: ui.cmap.value, clip: parseFloat(ui.clip.value),
    limitsFrom: all, diverging: mode === "diff",
  });
  const f = frames[mode === "blink" ? state.index : frames.length - 1];
  ui.frameLabel.textContent = mode === "blink"
    ? `${f.epoch_label} (${state.index + 1}/${frames.length})`
    : mode === "diff" ? `${frames.at(-1).epoch_label} − ${frames[0].epoch_label}` : "all epochs";
  drawOverlay(ui.overlay, state.sources, wcs, f.epoch_label, { show: ui.showOverlay.checked });
}

const player = new Player((i) => { state.index = i; render(); });

function renderMeta(frames) {
  ui.meta.innerHTML = "";
  for (const f of frames) {
    const tr = document.createElement("tr");
    for (const v of [f.epoch_label, `${f.mjd_start.toFixed(1)}–${f.mjd_end.toFixed(1)}`, f.n_exposures, `${(f.flag_fraction * 100).toFixed(1)}%`]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    }
    ui.meta.appendChild(tr);
  }
}

function spectrumMessage(text) {
  drawSpectrum(ui.spectrum, []);
  const ctx = ui.spectrum.getContext("2d");
  ctx.clearRect(0, 0, ui.spectrum.width, ui.spectrum.height);
  ctx.fillStyle = "#8b95a7";
  ctx.font = "11px system-ui";
  ctx.fillText(text, 44, ui.spectrum.height / 2);
}

// ---- URL state ----
function writeURL() {
  const url = new URL(location.href);
  const keep = url.searchParams.has("mock");
  url.search = "";
  if (keep) url.searchParams.set("mock", "");
  url.searchParams.set("mode", state.mode);
  const t = state.target;
  if (t) {
    url.searchParams.set("ra", +t.ra.toFixed(6));
    url.searchParams.set("dec", +t.dec.toFixed(6));
    url.searchParams.set("fov", ui.fov.value);
    url.searchParams.set("band", ui.band.value);
    if (ui.matched.checked) url.searchParams.set("matched", "1");
    if (t.name) url.searchParams.set("name", t.name);
  }
  history.replaceState(null, "", url);
}

// ---- the one loader every mode ends in ----
async function loadTarget({ ra, dec, label, name = null, pm = null }) {
  state.jobAbort?.abort();
  const ac = new AbortController();
  state.jobAbort = ac;
  hideBanner();

  ra = ((ra % 360) + 360) % 360;
  const q = { ra: +ra.toFixed(6), dec: +dec.toFixed(6), fov: fovValue(), band: ui.band.value, matched: ui.matched.checked };
  state.target = { ra: q.ra, dec: q.dec, label: label || fmtDeg(q.ra, q.dec), name, pm };
  state.preset = nearestPreset(q.ra, q.dec)?.slug || null;
  writeURL();
  const title = `${state.target.label} · ${q.band}${q.matched ? " matched" : ""} · ${q.fov}°`;
  ui.showOnSky.hidden = false;
  syncSky();

  const t0 = Date.now();
  showProgress("Asking the backend for frames…");
  let frames;
  try {
    frames = await api.frames(q, {
      preset: state.preset, signal: ac.signal,
      onProgress: (job) => showProgress(jobText(job, t0), job),
    });
  } catch (e) {
    if (e.name === "AbortError") return;
    hideProgress();
    const msg = e.code === "not_found" ? e.message : `Could not load frames: ${e.message}`;
    showBanner(msg);
    return;
  }
  if (ac.signal.aborted) return;
  hideProgress();

  state.frames = frames;
  ui.targetLabel.textContent = title;   // only now: until frames arrive the viewer still shows the previous target
  state.sources = null;
  renderMeta(frames.frames);
  player.load(frames.frames.length);
  spectrumMessage("Click a star to see its spectrum");
  api.overlay({ ra: q.ra, dec: q.dec, fov: q.fov }, { preset: state.preset, signal: ac.signal })
    .then((o) => { if (!ac.signal.aborted) { state.sources = o.sources; render(); } })
    .catch(() => { state.sources = null; });
}

ui.cancel.addEventListener("click", () => {
  state.jobAbort?.abort();
  hideProgress();
  showBanner("Cancelled. The server keeps building this position in the background, so asking again later is faster.");
});

/** Keep the sky map on the loaded target: draw its box, and move there if it is out of view. */
function syncSky() {
  const t = state.target;
  if (!sky || !t) return;
  sky.showFootprint(t.ra, t.dec, fovValue());
  const [cra, cdec] = sky.center();
  if (sepDeg(cra, cdec, t.ra, t.dec) > sky.viewFov() / 2) sky.goto(t.ra, t.dec, Math.max(0.6, fovValue() * 4));
}

// ---- mode switching ----
function setMode(mode, { focus = false } = {}) {
  if (!MODES.includes(mode)) mode = "name";
  state.mode = mode;
  for (const tab of ui.tabs) {
    const on = tab.dataset.mode === mode;
    tab.setAttribute("aria-selected", on);
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const [m, panel] of Object.entries(ui.panels)) panel.hidden = m !== mode;
  ui.showOnSky.hidden = mode === "explore" || !state.target;
  if (mode === "explore") ensureSky();
  if (mode === "coords" && state.target && !ui.ra.value) {
    ui.ra.value = state.target.ra; ui.dec.value = state.target.dec; echoCoords();
  }
  writeURL();
}
ui.tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
  tab.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d) setMode(ui.tabs[(i + d + ui.tabs.length) % ui.tabs.length].dataset.mode, { focus: true });
  });
});
ui.showOnSky.addEventListener("click", () => {
  setMode("explore");
  ensureSky().then(() => {
    if (!sky || !state.target) return;
    sky.goto(state.target.ra, state.target.dec, Math.max(0.6, fovValue() * 4));
    sky.showFootprint(state.target.ra, state.target.dec, fovValue());
  });
});

// ---- mode 2: object name ----
function recentNames() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}
function rememberName(name) {
  const list = [name, ...recentNames().filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
  fillSuggestions();
}
function fillSuggestions() {
  ui.suggest.innerHTML = "";
  const names = [...new Set([...recentNames(), ...PRESETS.map((p) => p.name)])];
  for (const n of names) ui.suggest.appendChild(new Option(n));
}

function showResult(parts) {
  ui.nameResult.hidden = false;
  ui.nameResult.replaceChildren(...parts.map(([k, v]) => {
    const span = document.createElement("span");
    if (k) { const b = document.createElement("span"); b.className = "k"; b.textContent = k; span.append(b); }
    const s = document.createElement("strong"); s.textContent = v; span.append(s);
    return span;
  }));
}

async function searchName(name, { band } = {}) {
  name = name.trim();
  if (!name) return;
  const preset = presetByName(name);
  if (band) ui.band.value = band;
  showResult([["", `Looking up “${name}”…`]]);
  const bannerBefore = { level: fallbackLevel, text: ui.banner.textContent, hidden: ui.banner.hidden };
  let r;
  try {
    r = await api.resolve(name, { preset: preset?.slug });
  } catch (e) {
    if (e.code === "not_found") {
      showResult([["", `No object called “${name}” was found. Check the spelling, or use Coordinates.`]]);
    } else if (preset) {
      r = { name: preset.label, ra: preset.ra, dec: preset.dec, source: "preset" };
    } else {
      showResult([["", `Name lookup is unavailable right now (${e.message}). Try again, or use Coordinates.`]]);
    }
    if (!r) return;
  }
  if (r.source === "mock") {
    if (!preset) {
      // the mock answer is not used, so put back whatever the banner said about the data on screen
      fallbackLevel = bannerBefore.level; ui.banner.textContent = bannerBefore.text; ui.banner.hidden = bannerBefore.hidden;
      showResult([["", "Name lookup needs the backend, which is unreachable. Use Coordinates instead."]]);
      return;
    }
    r = { name: preset.label, ra: preset.ra, dec: preset.dec, source: "preset" };
  }
  rememberName(name);
  const pmTotal = Math.hypot(r.pmra || 0, r.pmdec || 0);
  showResult([
    ["Object", r.name || name],
    ["RA, Dec", fmtDeg(r.ra, r.dec)],
    ["", fmtSexa(r.ra, r.dec)],
    ...(r.pmra != null ? [["Proper motion", `${(pmTotal / 1000).toFixed(pmTotal > 1000 ? 2 : 3)}″/yr`]] : []),
    ["Source", r.source === "preset" ? "built-in preset" : `${r.source}${r.epoch ? ` (epoch ${r.epoch.toFixed(2)})` : ""}`],
  ]);
  const pm = r.pmra != null ? { pmra: r.pmra, pmdec: r.pmdec, epoch: r.epoch } : null;
  await loadTarget({ ra: r.ra, dec: r.dec, label: r.name || name, name, pm });
}

ui.panels.name.addEventListener("submit", (e) => { e.preventDefault(); searchName(ui.name.value); });

function choosePreset(p) {
  ui.name.value = p.name;
  if (state.mode !== "explore") setMode("name");
  searchName(p.name, { band: p.band });
}
for (const p of PRESETS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = p.label;
  b.addEventListener("click", () => choosePreset(p));
  ui.presets.appendChild(b);
}

// ---- mode 3: coordinates ----
function readCoords() {
  let ra = parseCoord(ui.ra.value, true), dec = parseCoord(ui.dec.value, false);
  if (!ui.dec.value.trim()) {
    const pair = parsePair(ui.ra.value);
    if (pair) ({ ra, dec } = pair);
  }
  return { ra, dec };
}
function echoCoords() {
  const { ra, dec } = readCoords();
  const raBad = ui.ra.value.trim() && !validRA(ra), decBad = (ui.dec.value.trim() || ui.ra.value.trim()) && !validDec(dec);
  ui.ra.setAttribute("aria-invalid", !!raBad);
  ui.dec.setAttribute("aria-invalid", !!(ui.dec.value.trim() && !validDec(dec)));
  ui.echo.classList.toggle("bad", !!(raBad || decBad));
  if (!ui.ra.value.trim()) { ui.echo.textContent = ""; return; }
  if (validRA(ra) && validDec(dec)) ui.echo.textContent = `→ ${fmtDeg(ra, dec)}  =  ${fmtSexa(ra, dec)}`;
  else if (raBad) ui.echo.textContent = "RA must be 0–360° (or 0–24h).";
  else ui.echo.textContent = "Dec must be between −90° and +90°.";
}
ui.ra.addEventListener("input", echoCoords);
ui.dec.addEventListener("input", echoCoords);
ui.panels.coords.addEventListener("submit", (e) => {
  e.preventDefault();
  const { ra, dec } = readCoords();
  if (!validRA(ra) || !validDec(dec)) {
    echoCoords();
    ui.echo.classList.add("bad");
    ui.echo.textContent ||= "Enter RA and Dec as decimal degrees or sexagesimal (17:57:47 +04:46:14).";
    (validRA(ra) ? ui.dec : ui.ra).focus();
    return;
  }
  const p = nearestPreset(ra, dec);
  loadTarget({ ra, dec, label: p ? p.label : `RA ${sexa(ra, true)}, Dec ${sexa(dec, false)}` });
});

// ---- mode 1: free exploration ----
let sky = null, skyLoading = null;

function sliceLabel(i) {
  if (!sky) return "–";
  if (sky.isBlankSlice(i)) return `${channelName(i)} (blank)`;
  const lam = sky.lambdas?.[i];
  return `${channelName(i)} · ${lam ? lam.toFixed(3) + " µm" : ""}`;
}
function ensureSky() {
  if (skyLoading) return skyLoading;
  ui.skyMsg.hidden = false;
  ui.skyMsg.textContent = "Loading the SPHEREx sky map…";
  const t = state.target || PRESETS[0];
  skyLoading = (async () => {
    if (!ui.skyBg.options.length) for (const b of BACKGROUNDS) ui.skyBg.appendChild(new Option(b.label, b.id));
    sky = await createSky(ui.skyWrap, {
      target: `${t.ra} ${t.dec}`, fov: 2, presets: PRESETS,
      onSelect: onSkySelect,
      onCursor: (c) => { ui.skyCursor.textContent = c ? `${fmtDeg(c.ra, c.dec)}  (${fmtSexa(c.ra, c.dec)})` : "–"; },
      onPreset: (slug) => choosePreset(PRESETS.find((p) => p.slug === slug)),
      onView: ({ fov }) => { ui.skyView.textContent = `Use current view (${fov < 1 ? fov.toFixed(2) : fov.toFixed(1)}°)`; },
    });
    sky.setClickSide(fovValue());
    sky.onDrawArmed((on) => ui.skyDraw.setAttribute("aria-pressed", on));
    setSlice(sliceForBand(ui.band.value));
    ui.skyMsg.hidden = true;
    syncSky();
  })().catch((e) => {
    console.error(e);
    skyLoading = null;
    ui.skyMsg.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = `The sky map could not load (${e.message}). You can still search by name or coordinates.`;
    const b = document.createElement("button");
    b.type = "button"; b.textContent = "Use coordinates instead";
    b.addEventListener("click", () => setMode("coords"));
    const box = document.createElement("div");
    box.append(p, b);
    ui.skyMsg.append(box);
  });
  return skyLoading;
}
function setSlice(i) {
  if (!sky) return;
  ui.skySlice.value = i;
  sky.setSlice(i);
  ui.skySliceLabel.textContent = sky.isCube ? sliceLabel(i) : "(cube only)";
}
ui.skySlice.addEventListener("input", () => setSlice(+ui.skySlice.value));
ui.skyBg.addEventListener("change", () => {
  if (!sky) return;
  const bg = sky.setBackground(ui.skyBg.value);
  ui.skySlice.disabled = !bg.cube;
  // the new layer needs a moment to be added before a slice can be set
  setTimeout(() => setSlice(+ui.skySlice.value), 300);
  setSlice(+ui.skySlice.value);
});
ui.skyDraw.addEventListener("click", () => sky?.setDrawArmed(ui.skyDraw.getAttribute("aria-pressed") !== "true"));
ui.skyView.addEventListener("click", () => sky?.useCurrentView());

async function onSkySelect({ ra, dec, side, clamped }) {
  state.selection = { ra, dec, side };
  if (Math.abs(side - fovValue()) > 1e-4) setFov(side);
  ui.skySel.textContent = `${fmtDeg(ra, dec)} · ${side.toFixed(3)}° box${clamped ? " (clamped to the 0.5° limit)" : ""}`;
  ui.skyCompare.disabled = false;
  checkCoverage(ra, dec, side);
}

/** Quick look at what SPHEREx has here before starting a (possibly slow) frames job. */
async function checkCoverage(ra, dec, side) {
  state.coverageAbort?.abort();
  const ac = new AbortController();
  state.coverageAbort = ac;
  const band = ui.band.value, det = +band.slice(1);
  ui.skyCov.textContent = "checking…";
  try {
    const r = await api.exposures({ ra: +ra.toFixed(6), dec: +dec.toFixed(6), fov: side },
      { preset: nearestPreset(ra, dec)?.slug, signal: ac.signal });
    if (ac.signal.aborted) return;
    const mine = r.exposures.filter((e) => e.detector === det);
    const passes = [...new Set(mine.map((e) => e.epoch_label))].sort();
    if (!r.exposures.length) { ui.skyCov.textContent = "no SPHEREx exposures here"; return; }
    ui.skyCov.textContent = mine.length
      ? `${mine.length} ${band} exposures in ${passes.length} pass${passes.length === 1 ? "" : "es"} (${passes.join(", ")})${passes.length < 2 ? " — need 2+ passes to compare" : ""}`
      : `no ${band} exposures here (${r.exposures.length} in other bands)`;
  } catch (e) {
    if (e.name === "AbortError") return;
    ui.skyCov.textContent = e.code === "not_found" ? "no SPHEREx exposures here" : "could not check (you can still compare)";
  }
}

ui.skyCompare.addEventListener("click", () => {
  const s = state.selection;
  if (!s) return;
  const p = nearestPreset(s.ra, s.dec);
  loadTarget({ ra: s.ra, dec: s.dec, label: p ? p.label : `Sky region ${fmtSexa(s.ra, s.dec)}` });
});

// ---- shared control changes ----
ui.band.addEventListener("change", () => {
  setSlice(sliceForBand(ui.band.value));
  if (state.selection && state.mode === "explore") checkCoverage(state.selection.ra, state.selection.dec, state.selection.side);
  if (state.target) loadTarget(state.target);
});
ui.matched.addEventListener("change", () => { if (state.target) loadTarget(state.target); });
ui.fov.addEventListener("change", () => {
  sky?.setClickSide(fovValue());
  if (state.mode === "explore" && state.selection) {
    sky.select(state.selection.ra, state.selection.dec, fovValue());   // resize the pending box
    return;
  }
  if (state.target) loadTarget(state.target);
});

// ---- viewer events ----
ui.play.addEventListener("click", () => { ui.play.textContent = player.toggle() ? "Pause" : "Play"; });
ui.speed.addEventListener("input", () => player.setSpeed(+ui.speed.value));
for (const el of [ui.mode, ui.stretch, ui.cmap, ui.clip, ui.showOverlay]) el.addEventListener("input", render);
window.addEventListener("resize", render);
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea, [role=tab]") || e.target.closest("#sky-wrap")) return;
  if (e.key === " ") { e.preventDefault(); ui.play.click(); }
  if (e.key === "ArrowRight") player.step(1);
  if (e.key === "ArrowLeft") player.step(-1);
});

ui.image.addEventListener("click", async (e) => {
  if (!state.frames) return;
  const r = ui.image.getBoundingClientRect();
  const { wcs } = state.frames;
  const x = ((e.clientX - r.left) / r.width) * wcs.width;
  const y = ((e.clientY - r.top) / r.height) * wcs.height;
  const { ra, dec } = pixelToSky(x, y, wcs);
  state.spectrumAbort?.abort();
  const ac = new AbortController();
  state.spectrumAbort = ac;
  const q = { ra: ra.toFixed(6), dec: dec.toFixed(6), det: ui.band.value };
  // the target's own proper motion (from /resolve) only applies when the click is on the target
  const t = state.target;
  if (t?.pm && sepDeg(ra, dec, t.ra, t.dec) < 15 / 3600) Object.assign(q, { pmra: t.pm.pmra, pmdec: t.pm.pmdec, epoch: t.pm.epoch });
  spectrumMessage("Measuring the spectrum…");
  try {
    const s = await api.spectrum(q, {
      preset: state.preset, signal: ac.signal,
      onProgress: (job) => spectrumMessage(`Measuring… ${job.total ? `${job.done}/${job.total}` : job.stage || ""}`),
    });
    if (!ac.signal.aborted) drawSpectrum(ui.spectrum, s.points);
  } catch (err) {
    if (err.name !== "AbortError") spectrumMessage(err.code === "not_found" ? "No source measured here" : "Spectrum unavailable");
  }
});

// ---- start ----
fillSuggestions();
api.meta().then((m) => { if (m?.index?.data_through) ui.dataSpan.textContent = `SPHEREx data through ${m.index.data_through}.`; });

const qp = new URLSearchParams(location.search);
if (qp.has("fov")) setFov(+qp.get("fov"));
if (qp.has("band")) ui.band.value = qp.get("band");
ui.matched.checked = qp.get("matched") === "1";
const startMode = MODES.includes(qp.get("mode")) ? qp.get("mode") : qp.has("ra") ? "coords" : "name";
const ra0 = parseCoord(qp.get("ra") ?? "", true), dec0 = parseCoord(qp.get("dec") ?? "", false);
const hasCoords = validRA(ra0) && validDec(dec0);

if (hasCoords) {
  const name = qp.get("name");
  if (name) ui.name.value = name;
  ui.ra.value = qp.get("ra"); ui.dec.value = qp.get("dec"); echoCoords();
  const p = nearestPreset(ra0, dec0);
  loadTarget({ ra: ra0, dec: dec0, name, label: name || p?.label || `RA ${sexa(ra0, true)}, Dec ${sexa(dec0, false)}` });
} else if (qp.get("name")) {
  ui.name.value = qp.get("name");
  searchName(qp.get("name"));
} else if (startMode !== "explore") {
  choosePreset(PRESETS[0]);
}
setMode(startMode);
