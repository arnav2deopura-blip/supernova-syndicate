// Wiring, the three search modes, the viewer and URL state. Owner: C.
//   explore: pan/zoom an all-sky map, select a region (js/sky.js)
//   name:    resolve an object name (/api/resolve), then compare
//   coords:  type RA/Dec, then compare
// Every mode ends in loadTarget(), which runs /api/frames as an async job and drives the viewer.
// The viewer: Play passes (blink), Difference and Changes (σ) between any two passes A/B, Sum, and Colours
// (the 17 channels of a band). Changes are circled automatically (js/changes.js) and listed as Events.
// Layout (FRONTEND_UPGRADE_PLAN §6): A top bar · B context bar · C view tabs · D stage · E inspector ·
// F time dock · G status bar. The target picker is a sheet over the viewer.
// URL: ?mode=&ra=&dec=&fov=&band=&matched=&name=&view=&a=&b=&ch=lo-hi&tour=1&embed=1&api=&fresh=1&verify=1&mock=1
import { api, setFallbackHandler, apiLabel, apiParam, strictFresh, API_BASE, DEPLOYED_API } from "./api.js";
import { parseCoord } from "./coordinates.js";
import { Player } from "./player.js";
import { draw, sumFrames, gradientCSS } from "./render.js";
import { pixelToSky, skyToPixel, prepareOverlay, drawGaia, drawEvents, drawPick } from "./overlays.js";
import { drawSpectrum, spectrumMessage, redrawSpectrum } from "./spectrum.js";
import { createSky, BACKGROUNDS, channelName, sliceForBand } from "./sky.js";
import { findChanges, mergeKnown, addVariable, diffMap } from "./changes.js";
import { DETECTORS, MOLECULES, channelLam, rangeFor, framesFromCube, suggestRange, coveredRuns, N_CH } from "./bands.js";
import { initGlossary } from "./glossary.js";
import { showNotice, clearNotice, NOTICES } from "./notice.js";
import { startTour, tourDone } from "./tour.js";
import { renderEventList, renderEventDetail, mjdDate, el } from "./events-ui.js";
import { renderAdvanced } from "./advanced.js";
import { tourSteps, renderGuide } from "./guide.js";
import { icon, iconEl } from "./icons.js";
import { fovSkin, wavelengthSkin } from "./skins.js";
import { tok } from "./tokens.js";

// The five challenge test targets, at the exact positions their saved bakes were built at
// (precomputed/<slug>/resolve.json: SIMBAD J2000 moved to 2026.871 with the catalogue proper motion).
const PRESETS = [
  { slug: "barnards-star", label: "Barnard's Star", name: "Barnard's Star", ra: 269.446074, dec: 4.770711, band: "D2", aliases: ["barnard", "barnards star"], hint: "Fastest star in the sky: watch it jump north." },
  { slug: "eps-indi-b", label: "ε Indi B", name: "eps Indi B", ra: 331.0984021, dec: -56.8012569, band: "D3", aliases: ["epsilon indi b", "ε indi b"], hint: "Brown-dwarf pair crawling past a bright star." },
  { slug: "wise-0855", label: "WISE 0855−0714", name: "WISE J085510.83-071442.5", ra: 133.7577838, dec: -7.2420232, band: "D6", aliases: ["wise 0855", "wise 0855-0714"], hint: "Coldest brown dwarf: faint, red, only in D6." },
  { slug: "rw-aur", label: "RW Aur", name: "RW Aur", ra: 76.9565886, dec: 30.4012864, band: "D2", aliases: ["rw aurigae"], hint: "Young star that flickers: brightness changes." },
  { slug: "r-dra", label: "R Dra", name: "R Dra", ra: 248.1672204, dec: 66.7550253, band: "D2", aliases: ["r draconis"], hint: "Pulsating giant: a big, slow brightness swing." },
];
const PRESET_EPOCH = 2026.871;
const MODES = ["explore", "name", "coords"];
const VIEWS = ["blink", "smooth", "pair", "diff", "changes", "sum", "colours"];
const VIEW_NAMES = { blink: "Play passes", smooth: "Smooth", pair: "Side by side", diff: "Difference", changes: "Changes (σ)", sum: "Sum", colours: "Colours" };
const PLAYING_VIEWS = ["blink", "smooth", "colours"];   // views that step through frames on a timer
const AB_VIEWS = ["pair", "diff", "changes"];            // views that compare pass A with pass B
const RECENT_KEY = "sse.recentNames";
const ADV_KEY = "sse.advancedOpen";
const SEEN_KEY = "sse.lastDataThrough";
const THRESHOLD = 5;
const MATCH_RADIUS_ARCSEC = 180;   // wavelengths are matched at the centre; brightness changes beyond 3′ need the spectrum
const SAFE_FPS = 3;                // no more than three flashes a second without an explicit opt-in (WCAG 2.3.1)
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const qp0 = new URLSearchParams(location.search);
// "Backend only" (?fresh=1, alias ?verify=1): never substitute saved data or the saved demo positions
const liveOnly = () => strictFresh();
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

const $ = (id) => document.getElementById(id);
const ui = {
  tabs: [...document.querySelectorAll('#search-body [role="tab"]')],
  panels: { explore: $("panel-explore"), name: $("panel-name"), coords: $("panel-coords") },
  picker: $("picker"), pickerClose: $("picker-close"),
  searchBody: $("search-body"), searchSummary: $("search-summary"), searchSummaryText: $("search-summary-text"), searchExpand: $("search-expand"),
  q: $("q"), qEcho: $("q-echo"), topSearch: $("top-search"), skyBtn: $("sky-btn"),
  // shared
  fov: $("fov"), fovSeg: $("fov-seg"), band: $("band"), wlRuler: $("wl-ruler"), wlLabel: $("wl-label"), matched: $("matched"),
  wlSeg: [...document.querySelectorAll("[data-wl]")], rangeBox: $("range-box"), chLo: $("ch-lo"), chHi: $("ch-hi"), chLabel: $("ch-label"),
  chApply: $("ch-apply"), molecules: $("molecules"),
  provPop: $("prov-pop"), provTag: $("prov-tag"), provBody: $("prov-body"), cmpPop: $("cmp-pop"), cmpTag: $("cmp-tag"), cmpBody: $("cmp-body"),
  progress: $("progress"), progressBar: $("progress-bar"), progressTitle: $("progress-title"), progressText: $("progress-text"), progressHint: $("progress-hint"),
  cancel: $("progress-cancel"), progressWait: $("progress-wait"), progressRetry: $("progress-retry"),
  // name
  name: $("name"), suggest: $("name-suggest"), nameResult: $("name-result"), presets: $("presets"),
  // coords
  ra: $("ra"), dec: $("dec"), echo: $("coord-echo"),
  // explore
  skyWrap: $("sky-wrap"), skyMsg: $("sky-msg"), skyBg: $("sky-bg"), skySlice: $("sky-slice"), skySliceLabel: $("sky-slice-label"),
  skyDraw: $("sky-draw"), skyView: $("sky-view"), skyCursor: $("sky-cursor"), skySel: $("sky-sel"), skyCov: $("sky-cov"),
  skyCompare: $("sky-compare"),
  // viewer
  viewer: $("viewer"), targetLabel: $("target-label"), badges: $("badges"), showOnSky: $("show-on-sky"),
  views: [...document.querySelectorAll("[data-view]")], ab: $("ab"), passA: $("pass-a"), passB: $("pass-b"), abHint: $("ab-hint"), sensitivity: $("sensitivity"),
  warnStrip: $("warn-strip"), notice: $("viewer-notice"), stageArea: $("stage-area"), stage: $("stage"), stageInner: $("stage-inner"),
  stageEmpty: $("stage-empty"), emptyPreset: $("empty-preset"), stageEmptyMsg: $("stage-empty-msg"), stageEmptyPick: $("stage-empty-pick"),
  pairStage: $("pair-stage"), pairA: $("pair-a"), pairB: $("pair-b"), pairOverlayA: $("pair-overlay-a"), pairOverlayB: $("pair-overlay-b"),
  pairLabelA: $("pair-label-a"), pairLabelB: $("pair-label-b"), liveOnly: $("live-only"), badgeExtra: $("badge-extra"),
  image: $("image"), imagePrev: $("image-prev"), overlay: $("overlay"), reticle: $("reticle"), legend: $("legend"), sigmaScale: $("sigma-scale"),
  cornerTL: $("corner-tl"), cornerTR: $("corner-tr"), cornerBL: $("corner-bl"), cornerBR: $("corner-br"), scalebar: $("scalebar"), scalebarLabel: $("scalebar-label"),
  cbar: $("cbar"), cbarHi: $("cbar-hi"), cbarLo: $("cbar-lo"), cbarRamp: $("cbar-ramp"), cbarUnit: $("cbar-unit"), cursor: $("cursor-readout"),
  play: $("play"), prev: $("prev"), next: $("next"), speed: $("speed"), speedLabel: $("speed-label"), smooth: $("smooth"), frameLabel: $("frame-label"),
  timeline: $("timeline"), timelineCaption: $("timeline-caption"), filmstrip: $("filmstrip"), embedCaption: $("embed-caption"),
  showOverlay: $("show-overlay"), showEvents: $("show-events"), zoom: $("zoom"), savePng: $("save-png"), saveMovie: $("save-movie"),
  stretch: $("stretch"), cmap: $("cmap"), clip: $("clip"), fastBlink: $("fast-blink"), displayOpts: $("display-opts"),
  // inspector
  itabs: [...document.querySelectorAll('#inspector [role="tab"]')],
  events: $("events"), eventDetail: $("event-detail"), eventsSummary: $("events-summary"), showLow: $("show-low"), lowCount: $("low-count"),
  spectrum: $("spectrum"), spectrumNote: $("spectrum-note"),
  // advanced, header, dialogs
  advanced: $("advanced"), advBody: $("adv-body"),
  banner: $("banner"), dataSpan: $("data-span"), newData: $("new-data"), releaseTag: $("release-tag"), backendStatus: $("backend-status"),
  tourBtn: $("tour-btn"), tourOffer: $("tour-offer"), tourYes: $("tour-offer-yes"), tourNo: $("tour-offer-no"),
  guide: $("guide"), guideBtn: $("guide-btn"), guideClose: $("guide-close"), guideCards: $("guide-cards"),
  help: $("help"), helpBtn: $("help-btn"), helpClose: $("help-close"), helpTour: $("help-tour"), helpGuide: $("help-guide"),
  about: $("about"), aboutBtn: $("about-btn"), aboutClose: $("about-close"),
};

const state = {
  mode: "name",
  base: null,          // /api/frames response for the target (whole detector)
  frames: null,        // what the viewer shows: base, or per-pass channel-range frames from /api/cube
  sources: null, sourcesKey: null, movers: null, preset: null, index: 0,
  target: null,        // {ra, dec, label, name, pm, posNote} currently shown in the viewer
  title: "",           // target · band · field, for saved images
  selection: null,     // explore-mode region not yet compared: {ra, dec, side}
  view: "blink", a: 0, b: 0,
  change: null,        // {key, sigma, events} for the current A/B
  events: [], selected: null,
  wl: { kind: "detector" },   // or {kind: "range", lo, hi, molecule, skipOk}
  coverage: null,      // {det, gaps: Set(k)} channels missing from some pass, once a per-pass cube is known
  cube: null, cubeKey: null, colourIndex: 0,
  zoom: 1, zoomAt: { x: 0.5, y: 0.5 },
  spectrum: null, spectrumBand: null, pick: null,
  adv: {},             // lazily loaded drawer data: exposures, motion, lightcurve
  loadError: null,
  shown: null,         // what the stage shows now: {data, width, height, unit, limits, diverging}
  lastDrawn: null,     // key of the last frame drawn, for the crossfade
  apiVersion: null,
  recording: false,    // a movie is being recorded: controls are locked
  intensityValues: null, limitsFor: null,   // all pixel values of the shown passes, cached for the shared stretch
  jobAbort: null, spectrumAbort: null, coverageAbort: null, extraAbort: null, colourAbort: null,
};

let ruler = null, fovUI = null;   // the control skins (set up at start; the native controls work without them)
let fallbackLevel = 0;   // worst data fallback shown for the current target (1 precomputed, 2 mock)
function showBanner(msg) { ui.banner.textContent = msg; ui.banner.hidden = false; }
function hideBanner() { ui.banner.hidden = true; fallbackLevel = 0; }
// a later, milder fallback (e.g. a precomputed overlay) must not hide that the frames are mock
setFallbackHandler((msg, level) => { if (level >= fallbackLevel) { fallbackLevel = level; showBanner(msg); } });

// ---- coordinates: parsing and formatting ----
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
      const i = t.findIndex((x, k) => k > 0 && /^[+-−]/.test(x));
      if (i > 0) { a = t.slice(0, i).join(" "); b = t.slice(i).join(" "); }
    }
  }
  if (!a || !b) return null;
  return { ra: parseCoord(a, true), dec: parseCoord(b, false) };
}

function sexa(v, hours) {
  const sign = v < 0 ? "−" : hours ? "" : "+";
  let x = Math.abs(hours ? v / 15 : v);
  // round first, so 59.996″ never prints as 60.00
  const unit = hours ? 1 / 360000 : 1 / 36000;
  x = Math.round(x / unit) * unit;
  const d = Math.floor(x + 1e-12); x = (x - d) * 60;
  const m = Math.floor(x + 1e-9); const s = Math.max(0, (x - m) * 60);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ss = s.toFixed(hours ? 2 : 1).padStart(hours ? 5 : 4, "0");
  return `${sign}${pad(d)}:${pad(m)}:${ss}`;
}
const fmtDeg = (ra, dec) => `${ra.toFixed(4)}°, ${dec >= 0 ? "+" : "−"}${Math.abs(dec).toFixed(4)}°`;
const fmtSexa = (ra, dec) => `${sexa(ra, true)} ${sexa(dec, false)}`;
const validRA = (ra) => Number.isFinite(ra) && ra >= 0 && ra < 360;
const validDec = (dec) => Number.isFinite(dec) && dec >= -90 && dec <= 90;

function sepDeg(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180;
  const h = Math.sin(((dec2 - dec1) * r) / 2) ** 2 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / r;
}
/** The preset whose bake sits at this position (so the offline fallback works in every mode). */
// within 1″: only then are the saved bakes for exactly this field (they are not used for a field merely nearby)
const nearestPreset = (ra, dec) => PRESETS.find((p) => sepDeg(ra, dec, p.ra, p.dec) < 1 / 3600) || null;
// case, apostrophes, unicode minus and spacing don't matter ("barnards star", "WISE 0855−0714")
const normName = (v) => v.toLowerCase().replace(/[’']/g, "").replace(/−/g, "-").trim().replace(/\s+/g, " ");
const presetByName = (name) => PRESETS.find((p) => [p.name, p.label, p.slug, ...(p.aliases || [])].some((x) => normName(x) === normName(name))) || null;
const sourceName = (s) => (/simbad/i.test(s || "") ? "SIMBAD" : /ned/i.test(s || "") ? "NED" : /vizier/i.test(s || "") ? "VizieR" : s || "catalogue");

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
  fovUI?.render();
}

// ---- "Backend only": strict ?fresh=1, the backend or a visible error, never a saved substitute ----
ui.liveOnly.checked = strictFresh();
ui.liveOnly.addEventListener("change", () => {
  const url = new URL(location.href);
  url.searchParams.delete("verify");
  if (ui.liveOnly.checked) url.searchParams.set("fresh", "1"); else url.searchParams.delete("fresh");
  history.replaceState(null, "", url);
  if (state.target?.name) searchName(state.target.name, { band: ui.band.value });   // re-resolve the name live too
  else if (state.target) loadTarget(state.target);
});

// ---- progress for long backend jobs (replaces the stage content) ----
const STAGE_TEXT = {
  search: "Searching the archive", query: "Searching the archive", scan_folders: "Searching the archive", headers: "Reading image headers",
  stamps: "Downloading image cutouts", coadd: "Co-adding passes", qc: "Checking registration", cube: "Stacking each spectral channel",
};
const STAGE_COUNT = { stamps: "Downloading", headers: "Reading", coadd: "Co-adding", cube: "Stacking" };
let stallAnswer = null;
function showProgress(title, job = null, t0 = null) {
  ui.progress.hidden = false;
  ui.viewer.setAttribute("aria-busy", "true");
  if (job && job.total) { ui.progressBar.max = job.total; ui.progressBar.value = job.done; }
  else ui.progressBar.removeAttribute("value");   // indeterminate
  ui.progressTitle.textContent = title;
  const secs = t0 ? Math.round((Date.now() - t0) / 1000) : null;
  const count = job?.total ? `${STAGE_COUNT[job.stage] || "Step"} ${job.done} of ${job.total}` : job?.state === "queued" ? "Waiting for a free worker" : "";
  ui.progressText.textContent = [count, secs != null ? `${secs} s elapsed` : ""].filter(Boolean).join(" · ") || "Working…";
  ui.progressHint.hidden = !job;
  ui.progressWait.hidden = ui.progressRetry.hidden = true;
}
function hideProgress() { ui.progress.hidden = true; ui.viewer.setAttribute("aria-busy", "false"); ui.progressWait.hidden = ui.progressRetry.hidden = true; stallAnswer?.("cancel"); stallAnswer = null; }
function jobTitle(job) {
  if (job.restarted) return "The server restarted; your request was sent again.";
  return job.message || STAGE_TEXT[job.stage] || (job.state === "queued" ? "Waiting for a free worker" : "Working");
}
/** Called by a job with no progress for 2 minutes: Keep waiting, Retry or Cancel. */
function askStalled(retry) {
  return () => new Promise((resolve) => {
    const n = NOTICES.stalled();
    ui.progressTitle.textContent = n.title;
    ui.progressText.textContent = n.why;
    ui.progressWait.hidden = ui.progressRetry.hidden = false;
    stallAnswer = (a) => { stallAnswer = null; ui.progressWait.hidden = ui.progressRetry.hidden = true; resolve(a); if (a === "retry") retry(); };
    ui.progressWait.focus();
  });
}
ui.progressWait.addEventListener("click", () => stallAnswer?.("wait"));
ui.progressRetry.addEventListener("click", () => stallAnswer?.("retry"));

// ---- viewer: which frames, which passes ----
const passFrames = () => state.frames?.frames || [];
const ready = () => passFrames().length > 0;
const frameA = () => passFrames()[state.a];
const frameB = () => passFrames()[state.b];
const hasNoise = () => passFrames().length > 1 && !!frameA()?.noise && !!frameB()?.noise;
const isMatched = () => !!state.frames?.matched;
const isSaturated = () => passFrames().some((f) => f.target_flagged || f.target_flags?.includes("OVERFLOW"));

function setView(view, { silent = false } = {}) {
  if (!VIEWS.includes(view)) view = "blink";
  state.view = view;
  for (const b of ui.views) b.setAttribute("aria-checked", String(b.dataset.view === view));
  ui.ab.hidden = !AB_VIEWS.includes(view) || passFrames().length < 2;
  ui.filmstrip.hidden = view !== "colours";
  if (view !== "colours" && state.colourAbort) state.colourAbort.abort();
  if (view === "colours") loadColours();
  // static comparisons (Side by side, Difference, …) do not redraw on a timer
  else player.load(passFrames().length, ["blink", "smooth"].includes(view) ? state.index : null, ["blink", "smooth"].includes(view));
  updatePlayerUI();
  updateNotice();
  renderBadges();
  render();
  scheduleSize();
  if (!silent) writeURL();
}

function fillAB() {
  const fr = passFrames();
  for (const sel of [ui.passA, ui.passB]) {
    sel.replaceChildren(...fr.map((f, i) => new Option(`${f.epoch_label} · ${mjdDate(f.mjd_mean ?? f.mjd_start)}`, i)));
  }
  state.a = Math.min(state.a, Math.max(0, fr.length - 1));
  state.b = Math.min(state.b, Math.max(0, fr.length - 1));
  ui.passA.value = state.a; ui.passB.value = state.b;
  updateABHint();
}
function updateABHint() {
  const A = frameA(), B = frameB();
  if (!A || !B) { ui.abHint.textContent = ""; return; }
  const days = Math.abs((B.mjd_mean ?? B.mjd_start) - (A.mjd_mean ?? A.mjd_start));
  ui.abHint.textContent = state.a === state.b ? "Pick two different passes" : `${(days / 365.25).toFixed(2)} yr apart`;
}
function setAB(a, b) {
  state.a = a; state.b = b;
  ui.passA.value = a; ui.passB.value = b;
  updateABHint();
  computeEvents();
  renderTimeline();
  render();
  writeURL();
}
ui.passA.addEventListener("change", () => setAB(+ui.passA.value, state.b));
ui.passB.addEventListener("change", () => setAB(state.a, +ui.passB.value));
ui.sensitivity.addEventListener("change", () => { computeEvents(); render(); });

// ---- change events: σ map + known movers (Gaia, /api/movers) ----
function knownMovers(A, B, wcs) {
  const out = [];
  for (const s of state.sources || []) {
    const pm = Math.hypot(s.pmra || 0, s.pmdec || 0);
    if (pm <= 100) continue;
    const pa = s.positions_by_epoch.find((p) => p.epoch_label === A.epoch_label);
    const pb = s.positions_by_epoch.find((p) => p.epoch_label === B.epoch_label);
    if (!pa || !pb) continue;
    out.push({ kind: "known_mover", source: "gaia", gaia_id: s.id, pm_mas_yr: pm, from: skyToPixel(pa.ra, pa.dec, wcs), to: skyToPixel(pb.ra, pb.dec, wcs) });
  }
  for (const t of state.movers?.tracks || []) {
    if (!["candidate", "known_mover", "gaia_pm_mismatch", "unconfirmed_mover"].includes(t.status)) continue;
    const pa = t.passes.find((p) => p.epoch_label === A.epoch_label) || t.passes[0];
    const pb = t.passes.find((p) => p.epoch_label === B.epoch_label) || t.passes.at(-1);
    // a Gaia mover already explains it: keep one event, enriched with the track
    const g = out.find((m) => m.source === "gaia" && Math.hypot(m.to.x - skyToPixel(pb.ra, pb.dec, wcs).x, m.to.y - skyToPixel(pb.ra, pb.dec, wcs).y) < 4);
    if (g) { g.track = t; continue; }
    out.push({ kind: t.status, source: "movers", pm_mas_yr: t.pm, pm_sigma: t.pm_sigma, track: t, gaia_id: t.gaia?.id || null,
      from: skyToPixel(pa.ra, pa.dec, wcs), to: skyToPixel(pb.ra, pb.dec, wcs) });
  }
  return out;
}

function computeEvents() {
  const fr = passFrames();
  state.change = null;
  state.events = [];
  if (fr.length < 2 || state.a === state.b) { renderEvents(); return; }
  const A = frameA(), B = frameB(), { wcs } = state.frames;
  let events = [];
  if (hasNoise()) {
    const brightStars = (state.sources || []).filter((s) => s.mag != null && s.mag < 11).map((s) => {
      const p = s.positions_by_epoch.find((q) => q.epoch_label === B.epoch_label) || s;
      return skyToPixel(p.ra, p.dec, wcs);
    });
    const r = findChanges(A, B, { ...wcs, threshold: THRESHOLD, matched: isMatched(), brightStars, sysFrac: +ui.sensitivity.value,
      matchRadiusPx: MATCH_RADIUS_ARCSEC / wcs.pixel_scale_arcsec });
    state.change = { sigma: r.sigma, dtYears: r.dtYears, offset: r.offset, scale: r.scale };
    events = r.events;
  }
  // movers tracks are found on the frames of the whole detector: only overlay them there
  const known = state.wl.kind === "detector" ? knownMovers(A, B, wcs) : [];
  events = mergeKnown(events, known, wcs);
  // the target's light curve (all exposures) is a better variability test than two co-adds
  if (state.variability && state.target) events = addVariable(events, state.variability, skyToPixel(state.target.ra, state.target.dec, wcs), wcs);
  for (const e of events) Object.assign(e, pixelToSky(e.x, e.y, wcs));
  state.events = events;
  if (state.selected && !events.some((e) => e.id === state.selected)) state.selected = null;
  renderEvents();
}

/** The target's light curve came back unusable (e.g. a saturated star): say why no variable event is listed. */
function lightcurveCaveat() {
  const lc = state.variability;
  if (!lc || lc.reliable !== false || lc.variable === true) return "";
  // our own words: the backend note guesses a cause (saturation) that is wrong for faint targets
  const err = Number.isFinite(lc.median_frac_err) ? ` (typical error ${Math.round(lc.median_frac_err * 100)}%)` : "";
  return ` No variability verdict for the target: its light curve is too noisy in ${ui.band.value}${err}.`;
}

function renderEvents() {
  const ev = state.events;
  const low = ev.filter((e) => e.confidence === "low").length;
  ui.lowCount.textContent = low;
  const A = frameA(), B = frameB();
  if (!state.frames) ui.eventsSummary.textContent = "Events appear once a target has two or more passes.";
  else if (passFrames().length < 2) ui.eventsSummary.textContent = "Only one pass: nothing to compare yet.";
  else if (state.a === state.b) ui.eventsSummary.textContent = "Pick two different passes to compare.";
  else {
    const hi = ev.length - low;
    ui.eventsSummary.textContent = `${A.epoch_label} → ${B.epoch_label}: ${hi} confident event${hi === 1 ? "" : "s"}${low ? `, ${low} uncertain${ui.showLow.checked ? "" : " (hidden)"}` : ""}.`
      + (hasNoise() ? "" : state.wl.kind === "range" ? " Single channels have no noise maps, so no events are computed." : " No noise maps here, so only known movers are listed.")
      + (!isMatched() && hasNoise() ? " Turn on matched wavelengths to trust brightness changes." : "")
      + lightcurveCaveat();
  }
  renderEventList(ui.events, ev, { selected: state.selected, showLow: ui.showLow.checked, onSelect: (e) => selectEvent(e.id) });
  renderDetail();
}
ui.showLow.addEventListener("change", () => { renderEvents(); render(); });

function renderDetail() {
  const e = state.events.find((x) => x.id === state.selected);
  if (!e || !state.frames) { renderEventDetail(ui.eventDetail, null); return; }
  renderEventDetail(ui.eventDetail, e, {
    frames: passFrames(), wcs: state.frames.wcs, sources: state.sources, A: frameA(), B: frameB(),
    target: state.target, band: ui.band.value, matched: isMatched(), release: state.frames.release,
    fitsURL: fitsURL(), repro: reproLines(),
    onSpectrum: (ev) => { showInspector("spectrum"); measureSpectrum(ev.ra, ev.dec); },
    onZoom: (ev) => zoomTo(ev, 3),
  });
}

function selectEvent(id, { zoom = false } = {}) {
  state.selected = state.selected === id && !zoom ? null : id;
  const e = state.events.find((x) => x.id === state.selected);
  if (e && zoom) zoomTo(e, 3);
  renderEvents();
  render();
}

// ---- reproducibility lines carried by every export (item 24, minimal header) ----
function reproLines() {
  const f = state.frames, p = f?._provenance || {};
  const wl = state.wl.kind === "range" ? `channels ${state.wl.lo}–${state.wl.hi} of ${ui.band.value} (${f?.matched_channels?.join(" ") || "?"})`
    : f?.matched ? `matched at the field centre: ${f.matched_channels?.join(" ") || "?"} (λ_eff ${f.lam_eff_um?.toFixed(4) ?? "?"} µm)` : `${ui.band.value}, all channels, not matched`;
  const counts = p.counts ? Object.entries(p.counts).map(([k, v]) => `${v} ${k}`).join(", ") : "not reported by this backend version";
  const obs = passFrames().reduce((a, x) => a + (Array.isArray(x.obs_ids) ? x.obs_ids.length : 0), 0);
  const warnings = [isSaturated() ? "target core saturated (OVERFLOW)" : null, !f?.matched && state.wl.kind === "detector" ? "wavelengths not matched: brightness not comparable" : null,
    p.complete === false ? "incomplete downloads" : null, p.kind === "mock" ? "SYNTHETIC mock data" : null].filter(Boolean);
  return [
    ["tool", "Sphere Shift (NASA Space Apps 2026)"],
    ["exported", new Date().toISOString()],
    ["url", location.href],
    ["data_release", f?.release || "unknown"],
    ["provenance", provLabel(p).text],
    ["backend", p.kind === "live" ? API_BASE : "none (data bundled with the site)"],
    ["pipeline_version", p.pipeline_version || (p.kind === "live" && state.apiVersion ? `API ${state.apiVersion}` : "unknown")],
    ["access_path", p.access_path || "not reported"],
    ["completeness", counts],
    ["band", ui.band.value],
    ["wavelengths", wl],
    ["masking", "masked pixels are null; nothing is interpolated"],
    ["observation_ids", obs ? `${obs} in the frames shown` : "not in this response"],
    ["warnings", warnings.join("; ") || "none"],
  ];
}

// ---- zoom and pan ----
function zoomCentre() {
  const z = state.zoom;
  const clamp = (v) => Math.min(1 - 0.5 / z, Math.max(0.5 / z, v));
  return z > 1 ? { x: clamp(state.zoomAt.x), y: clamp(state.zoomAt.y) } : { x: 0.5, y: 0.5 };
}
function applyZoom() {
  const z = state.zoom;
  const c = zoomCentre();
  ui.stageInner.style.transform = z > 1 ? `scale(${z}) translate(${(0.5 - c.x) * 100}%, ${(0.5 - c.y) * 100}%)` : "";
  // Side by side shares the zoom and placement
  for (const inner of ui.pairStage.querySelectorAll(".pair-inner")) inner.style.transform = ui.stageInner.style.transform;
  ui.zoom.value = String(z);
  ui.image.classList.toggle("pannable", z > 1);
}
function zoomTo(p, z) {
  if (!state.frames) return;
  const { wcs } = state.frames;
  p = p || { x: wcs.width / 2, y: wcs.height / 2 };   // null = the field centre (the target)
  state.zoom = Math.max(1, Math.min(4, z));
  state.zoomAt = { x: p.x / wcs.width, y: p.y / wcs.height };
  applyZoom();
  render();
}
ui.zoom.addEventListener("change", () => {
  state.zoom = +ui.zoom.value;
  const e = state.events.find((x) => x.id === state.selected);
  if (e && state.frames) state.zoomAt = { x: e.x / state.frames.wcs.width, y: e.y / state.frames.wcs.height };
  applyZoom();
  render();
});

// ---- notices (one place decides what to tell the user about the current view) ----
function updateNotice() {
  if (state.loadError) { showNotice(ui.notice, state.loadError); return; }
  const fr = passFrames();
  if (!state.frames) { clearNotice(ui.notice); return; }
  if (state.view === "colours") {
    if (state.cube?.error) { showNotice(ui.notice, state.cube.error); return; }
    clearNotice(ui.notice); return;
  }
  const rg = state.frames.range;
  if (fr.length < 2 && rg) {
    const sg = rg.suggest;
    showNotice(ui.notice, {
      tone: "empty", title: `Only ${fr.length ? `pass ${fr[0].epoch_label}` : "no pass"} has data in all of channels ${rg.lo}–${rg.hi} here.`,
      why: `SPHEREx sees a different set of channels at this spot in each pass (${state.base.frames.length} passes in the whole band). A fair comparison needs the same channels in every pass.${sg ? ` Channels ${sg.lo}–${sg.hi} are covered by ${sg.passes.join(", ")}.` : ""}`,
      actions: [
        ...(sg ? [{ label: `Try channels ${sg.lo}–${sg.hi}`, primary: true, onClick: () => setWavelengths({ kind: "range", lo: sg.lo, hi: sg.hi }, { reload: true }) }] : []),
        { label: "Use the whole band", primary: !sg, onClick: () => setWavelengths({ kind: "detector" }, { reload: true }) }],
    });
    return;
  }
  if (fr.length < 2) { showNotice(ui.notice, NOTICES.onePass(fr[0]?.epoch_label || "–")); return; }
  if (state.view === "changes" && !hasNoise()) {
    showNotice(ui.notice, { ...NOTICES.noNoise(), actions: [
      ...(state.wl.kind === "range" ? [{ label: "Use the whole band", primary: true, onClick: () => setWavelengths({ kind: "detector" }, { reload: true }) }] : []),
      { label: "Show Difference instead", onClick: () => setView("diff") }] });
    return;
  }
  if (state.view === "smooth") {
    showNotice(ui.notice, { tone: "info", title: "Smooth blends two observations.", why: "The in-between images are a visual transition, not extra observations. Use Play passes to judge motion or brightness." });
    return;
  }
  if (AB_VIEWS.includes(state.view) && !isMatched() && state.wl.kind === "detector") {
    showNotice(ui.notice, {
      tone: "info", title: "Brightness changes here may not be real.",
      why: "Wavelengths are not matched, so each pass saw a slightly different mix of wavelengths. Motion is fine to judge; for brightness, match the wavelengths.",
      actions: [{ label: "Match wavelengths", primary: true, onClick: () => { ui.matched.checked = true; ui.matched.dispatchEvent(new Event("change")); } }],
    });
    return;
  }
  clearNotice(ui.notice);
}

/** One line per limitation of the result shown, with an action: saturation, incomplete data, skipped passes. */
function renderWarnings() {
  const lines = [];
  const line = (text, action) => el("div", { class: "wline" }, iconEl("alert"), el("span", { text }),
    action ? el("button", { type: "button", text: action.label, onclick: action.onClick }) : null);
  if (ready()) {
    if (isSaturated()) {
      const next = `D${Math.min(6, +ui.band.value.slice(1) + 1)}`;
      lines.push(line(`Saturated core in ${ui.band.value}: the target's centre overflows the detector, so its brightness and position there are less precise.`,
        ui.band.value === "D6" ? null : { label: `Try ${next}`, onClick: () => { ui.band.value = next; ui.band.dispatchEvent(new Event("change")); } }));
    }
    const p = shownProduct()?._provenance || {};
    if (p.complete === false) {
      const c = p.counts ? ` (${Object.entries(p.counts).map(([k, v]) => `${v} ${k}`).join(" · ")})` : "";
      lines.push(line(`Incomplete: some input downloads failed${c}. Retry them before interpreting changes.`,
        p.kind === "live" ? { label: "Retry missing downloads", onClick: () => loadTarget({ ...state.target, retryMissing: true }) } : null));
    }
    const rg = state.frames.range;
    if (rg?.skipped && passFrames().length >= 2) lines.push(line(`Compared only ${passFrames().map((f) => f.epoch_label).join(", ")}: ${rg.skipped} pass${rg.skipped === 1 ? " lacks" : "es lack"} a chosen channel.`, null));
  }
  ui.warnStrip.replaceChildren(...lines);
  ui.warnStrip.hidden = !lines.length;
}

// ---- tags in the context bar: provenance, comparison, channel range ----
function provLabel(p) {
  if (!p?.kind) return { text: "–", tone: "" };
  if (p.kind === "precomputed") return { text: "Saved demo data", tone: "" };
  if (p.kind === "mock") return { text: "Mock data", tone: "tag-bad" };
  if (p.origin === "processed_now") return { text: `Processed now${p.job?.files ? ` · ${p.job.files} files` : ""}`, tone: "tag-ok" };
  if (p.origin === "server_cache") return { text: "Server cache", tone: "tag-ok" };
  return { text: "From the server", tone: "tag-ok" };
}
/** The product on screen: the Colours cube in the Colours view, else the comparison frames. */
const shownProduct = () => (state.view === "colours" && state.cube?.channels ? state.cube : state.frames);
function renderProvenance() {
  const product = ready() ? shownProduct() : null;
  const p = product?._provenance;
  ui.provPop.hidden = !p;
  if (!p) return;
  const l = provLabel(p);
  ui.provTag.className = `tag ${l.tone}`;
  ui.provTag.replaceChildren(iconEl(p.kind === "mock" ? "alert" : p.kind === "live" ? "check" : "info", 14), l.text);
  const why = {
    precomputed: "Bundled with this website: built earlier by the same pipeline and release as the live backend, so a demo never waits on a rebuild. It is not a new download.",
    mock: "Synthetic data for layout work. Not real observations: nothing here can support a discovery.",
    live: p.origin === "processed_now" ? "The backend searched the archive and built this view for your request." : p.origin === "server_cache" ? "The backend answered at once from work it had already done for this exact request." : "The backend answered this request.",
  }[p.kind];
  const counts = p.counts ? Object.entries(p.counts).map(([k, v]) => `${v} ${k}`).join(" · ") : null;
  ui.provBody.replaceChildren(
    el("p", { text: why }),
    el("dl", {},
      el("dt", { text: "Source" }), el("dd", { text: p.kind === "live" ? `${apiLabel()} backend` : p.kind === "precomputed" ? "precomputed/ (this site)" : "mock/ (this site)" }),
      el("dt", { text: "Release" }), el("dd", { text: product.release || "unknown" }),
      ...(p.job?.seconds != null ? [el("dt", { text: "Built in" }), el("dd", { text: `${p.job.seconds} s` })] : []),
      ...(p.job?.files ? [el("dt", { text: "Files" }), el("dd", { text: `${p.job.files} downloaded` })] : []),
      el("dt", { text: "Completeness" }), el("dd", { text: counts || "not reported for this product" }),
      el("dt", { text: "Selection" }), el("dd", { text: product.completeness?.selection_policy || "bounded temporal sampling; not an exhaustive list of every exposure" }),
      ...(p.pipeline_version ? [el("dt", { text: "Pipeline" }), el("dd", { text: `${p.pipeline_version}${p.config ? ` · config ${p.config}` : ""}` })]
        : p.kind === "precomputed" ? [el("dt", { text: "Pipeline" }), el("dd", { text: "not recorded in this older saved product" })] : []),
      el("dt", { text: "Access path" }), el("dd", { text: p.access_path || "not reported" }),
      el("dt", { text: "Mode" }), el("dd", { text: strictFresh() ? "Backend only: saved data never used" : "default: saved test targets first" })),
    strictFresh() ? null : el("button", { type: "button", text: "Reload from the backend only", onclick: () => { ui.liveOnly.checked = true; ui.liveOnly.dispatchEvent(new Event("change")); } }));
}
function renderComparison() {
  const f = state.frames;
  const range = state.wl.kind === "range";
  const matched = f ? !!f.matched : ui.matched.checked;
  let text, tone, body;
  if (range && f?.range) {
    text = `Channels ${state.wl.lo}–${state.wl.hi}${f.lam_eff_um ? ` · ${f.lam_eff_um.toFixed(3)} µm` : ""}`;
    tone = "tag-ok";
    body = `The same channels (${f.matched_channels?.join(", ") || "?"}) in every pass compared. Channel wavelengths are matched at the field centre; near the edge they can differ by up to about half a channel.`;
  } else if (matched) {
    text = `Matched at centre${f?.lam_eff_um ? ` · ${f.lam_eff_um.toFixed(3)} µm` : ""}`;
    tone = "tag-ok";
    body = `Wavelengths are matched at the field centre${f?.matched_channels ? ` (channels ${f.matched_channels.join(", ")})` : ""}. Sources near the edge can differ by up to about half a channel. Confirm an off-centre brightness change with its spectrum.`;
  } else {
    text = "Not matched: brightness not comparable";
    tone = "tag-warn";
    body = "Each pass sees a slightly different mix of wavelengths, so a red star can look brighter or fainter for that reason alone. Motion is still fine to judge.";
  }
  ui.cmpTag.className = `tag ${tone}`;
  ui.cmpTag.replaceChildren(iconEl(tone === "tag-ok" ? "check" : "alert", 14), text);
  ui.cmpBody.textContent = body;
}
const rangeText = (wl) => {
  const det = ui.band.value;
  return `${det} channels ${wl.lo}–${wl.hi} · ≈${channelLam(det, wl.lo, state.lamTable).toFixed(2)}–${channelLam(det, wl.hi, state.lamTable).toFixed(2)} µm${wl.molecule ? ` (${MOLECULES.find((m) => m.id === wl.molecule)?.label}${wl.cont ? " continuum" : ""})` : ""}`;
};
function renderBadges() {
  // tags describe a result, so they only show while there is one (#badges is empty otherwise)
  const out = [];
  const colours = state.view === "colours" && state.cube?.channels;
  if (ready() && colours) out.push(el("span", { class: "badge", text: `${state.cube.channels.length} spectral channels · passes combined` }));
  else if (ready() && state.wl.kind === "range") out.push(el("span", { class: "badge", text: rangeText(state.wl) }));
  ui.badgeExtra.replaceChildren(...out);
  ui.cmpPop.hidden = !ready() || !!colours;
  renderProvenance();
  renderComparison();
  renderWarnings();
  renderWavelengthLabel();
}
function renderWavelengthLabel() {
  const d = DETECTORS[ui.band.value];
  ui.wlLabel.textContent = state.wl.kind === "range"
    ? `${ui.band.value} ch ${state.wl.lo}–${state.wl.hi} · ${channelLam(ui.band.value, state.wl.lo, state.lamTable).toFixed(2)}–${channelLam(ui.band.value, state.wl.hi, state.lamTable).toFixed(2)} µm`
    : `${ui.band.value} · ${d.lo.toFixed(2)}–${d.hi.toFixed(2)} µm`;
  ruler?.update({ band: ui.band.value, range: state.wl.kind === "range" ? { lo: state.wl.lo, hi: state.wl.hi } : null,
    gaps: state.coverage?.gaps || null, gapsDet: state.coverage?.det || null, proposal: null });
}

// ---- rendering ----
const UNIT = { blink: "MJy/sr", sum: "MJy/sr", diff: "Δ MJy/sr", changes: "σ", colours: "MJy/sr" };
function render() {
  const ok = ready();
  const pairing = ok && state.view === "pair" && passFrames().length > 1;
  ui.stageEmpty.hidden = ok;
  ui.stageEmptyMsg.hidden = !state.loadError;
  ui.stageEmptyPick.hidden = !!state.loadError;
  ui.pairStage.hidden = !pairing;
  ui.stage.hidden = pairing;
  for (const c of [ui.savePng, ui.saveMovie]) c.disabled = !ok || state.recording;
  for (const c of [ui.cornerTL, ui.cornerTR, ui.cornerBL, ui.cornerBR]) c.hidden = !ok;
  if (!ok) {
    ui.image.getContext("2d").clearRect(0, 0, ui.image.width, ui.image.height);
    ui.overlay.getContext("2d").clearRect(0, 0, ui.overlay.width, ui.overlay.height);
    ui.reticle.getContext("2d").clearRect(0, 0, ui.reticle.width, ui.reticle.height);
    ui.legend.hidden = true;
    ui.cbar.hidden = true;
    state.shown = null;
    highlightTimeline();
    return;
  }
  const { wcs } = state.frames;
  const fr = passFrames();
  const opts = { stretch: ui.stretch.value, cmap: ui.cmap.value, clip: parseFloat(ui.clip.value) };
  let label = "", epoch = fr[state.index]?.epoch_label, showMarks = true, tl = "", tr = "";
  const view = fr.length < 2 && state.view !== "colours" ? "blink" : state.view;
  let shown = null, drawnKey = null;
  // one stretch for every pass, so brightness changes stay visible (cached: the values change only with the frames)
  if (state.limitsFor !== fr) { state.limitsFor = fr; state.intensityValues = fr.flatMap((x) => x.data); }
  const limitsFrom = state.intensityValues;
  if (view === "pair") {
    const A = frameA(), B = frameB();
    for (const [f, cv, ov, lab, letter] of [[A, ui.pairA, ui.pairOverlayA, ui.pairLabelA, "A"], [B, ui.pairB, ui.pairOverlayB, ui.pairLabelB, "B"]]) {
      draw(cv, f.data, wcs.width, wcs.height, { ...opts, limitsFrom });
      lab.textContent = `${letter} · ${f.epoch_label} · ${mjdDate(f.mjd_mean ?? f.mjd_start)}`;
      const po = prepareOverlay(ov, wcs, state.zoom);
      if (ui.showOverlay.checked) drawGaia(po, state.sources, wcs, f.epoch_label);
      if (ui.showEvents.checked) drawEvents(po, state.events.filter((e) => e.confidence !== "low" || ui.showLow.checked || e.id === state.selected), { selected: state.selected });
      if (state.pick) drawPick(po, state.pick);
    }
    const lim = draw(ui.image, A.data, wcs.width, wcs.height, { ...opts, limitsFrom });
    shown = { data: A.data, limits: lim, diverging: false, unit: UNIT.blink };
    label = `A ${A.epoch_label} · B ${B.epoch_label} · shared stretch and zoom`;
    epoch = null; showMarks = false;
  } else if (view === "colours" && state.cube?.channels?.length) {
    const ch = state.cube.channels[state.colourIndex % state.cube.channels.length];
    const lim = draw(ui.image, ch.data, state.cube.wcs.width, state.cube.wcs.height, { ...opts, range: state.cube.display_range });
    shown = { data: ch.data, width: state.cube.wcs.width, height: state.cube.wcs.height, limits: lim, diverging: false, unit: UNIT.colours };
    label = `${ch.channel} · ${ch.lam_um.toFixed(3)} µm (${state.colourIndex + 1}/${state.cube.channels.length})`;
    tl = `${ch.channel} · ${ch.lam_um.toFixed(3)} µm`; tr = "Colours · all passes";
    epoch = null; showMarks = false;
  } else if (view === "diff" || view === "changes") {
    const A = frameA(), B = frameB();
    if (view === "changes" && state.change) {
      const lim = draw(ui.image, state.change.sigma, wcs.width, wcs.height, { ...opts, diverging: true, range: [-THRESHOLD, THRESHOLD] });
      shown = { data: state.change.sigma, limits: lim, diverging: true, unit: UNIT.changes };
      label = `${B.epoch_label} vs ${A.epoch_label}, in σ`;
    } else {
      const d = diffMap(A, B);
      const lim = draw(ui.image, d, wcs.width, wcs.height, { ...opts, diverging: true });
      shown = { data: d, limits: lim, diverging: true, unit: UNIT.diff };
      label = `${B.epoch_label} − ${A.epoch_label}`;
    }
    tl = `${B.epoch_label} − ${A.epoch_label}`;
    tr = `${VIEW_NAMES[view]} · A ${A.epoch_label} → B ${B.epoch_label}`;
    epoch = B.epoch_label;
  } else if (view === "sum") {
    const d = sumFrames(fr);
    const lim = draw(ui.image, d, wcs.width, wcs.height, opts);
    shown = { data: d, limits: lim, diverging: false, unit: UNIT.sum };
    label = "all passes added";
    tl = `Sum of ${fr.length} passes`; tr = "Sum";
  } else {
    const f = fr[state.index];
    drawnKey = `${state.frames.release}|${state.frames.ra}|${state.frames.dec}|${ui.band.value}|${f.epoch_label}`;
    crossfadeFrom(drawnKey, view);
    const lim = draw(ui.image, f.data, wcs.width, wcs.height, { ...opts, limitsFrom });
    shown = { data: f.data, limits: lim, diverging: false, unit: UNIT.blink };
    label = `${f.epoch_label} · ${mjdDate(f.mjd_mean ?? f.mjd_start)} (${state.index + 1}/${fr.length})`;
    tl = `${f.epoch_label} · ${mjdDate(f.mjd_mean ?? f.mjd_start)}`;
    tr = fr.length > 1 && state.a !== state.b ? `${VIEW_NAMES[view] || "Play passes"} · A ${frameA().epoch_label} → B ${frameB().epoch_label}` : VIEW_NAMES[view] || "Play passes";
  }
  state.lastDrawn = drawnKey;
  if (view !== "smooth") ui.imagePrev.style.opacity = "0";
  if (shown) { shown.width ??= wcs.width; shown.height ??= wcs.height; }
  state.shown = shown;
  ui.frameLabel.textContent = label;
  ui.cornerTL.textContent = tl;
  ui.cornerTR.textContent = tr;
  ui.sigmaScale.hidden = view !== "changes" || !state.change;

  const o = prepareOverlay(ui.overlay, view === "colours" && state.cube ? state.cube.wcs : wcs, state.zoom);
  if (ui.showOverlay.checked && epoch) drawGaia(o, state.sources, wcs, epoch);
  let vis = [];
  if (showMarks && ui.showEvents.checked) {
    vis = state.events.filter((e) => e.confidence !== "low" || ui.showLow.checked || e.id === state.selected);
    drawEvents(o, vis, { selected: state.selected });
  }
  if (state.pick) drawPick(o, state.pick);
  renderLegend(vis, shown);
  renderColourBar(shown, view);
  drawReticle(view === "colours" && state.cube ? state.cube.wcs : wcs);
  highlightTimeline();
  updateEmbedCaption();
}

/** Marker key: only the kinds present in this field, plus "no data" when the image has masked pixels. */
function renderLegend(vis, shown) {
  const kinds = new Set(vis.map((e) => (["appeared", "brightened"].includes(e.kind) ? "brighter" : ["disappeared", "faded"].includes(e.kind) ? "fainter"
    : ["candidate", "gaia_pm_mismatch"].includes(e.kind) ? "candidate" : e.kind === "variable" ? "variable" : "moved")));
  if (vis.some((e) => e.confidence === "low")) kinds.add("low");
  if (shown?.data?.some((v) => v === null)) kinds.add("nodata");
  let any = false;
  for (const s of ui.legend.querySelectorAll("[data-kind]")) { s.hidden = !kinds.has(s.dataset.kind); any ||= !s.hidden; }
  ui.legend.hidden = !any && ui.sigmaScale.hidden;
}

const fmtVal = (v) => (v == null || !Number.isFinite(v) ? "–" : Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : v.toPrecision(3)).replace("-", "−");
function renderColourBar(shown, view) {
  if (!shown?.limits) { ui.cbar.hidden = true; return; }
  ui.cbar.hidden = false;
  ui.cbarRamp.style.background = `linear-gradient(to top, ${gradientCSS(ui.cmap.value, shown.diverging)})`;
  const { lo, hi } = shown.limits;
  const sig = view === "changes";
  ui.cbarHi.textContent = sig ? `+${THRESHOLD}σ` : fmtVal(hi);
  ui.cbarLo.textContent = sig ? `−${THRESHOLD}σ` : fmtVal(lo);
  ui.cbarUnit.textContent = sig ? "σ" : shown.unit;
  ui.cbar.title = `Colour bar: ${fmtVal(lo)} to ${fmtVal(hi)} ${shown.unit}${!shown.diverging && ui.stretch.value === "asinh" ? " (asinh stretch: not linear between the ends)" : ""}`;
}

/** Edge ticks every 30″ / 1′ / 2′ / 5′, and the scale bar, following the zoom. */
function drawReticle(wcs) {
  const side = ui.stage.clientWidth;
  const dpr = devicePixelRatio || 1;
  ui.reticle.width = Math.round(side * dpr); ui.reticle.height = Math.round(side * dpr);
  const ctx = ui.reticle.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, side, side);
  if (!wcs || !side) return;
  const z = state.zoom, c = zoomCentre();
  const ps = wcs.pixel_scale_arcsec;
  const fieldArcsec = (wcs.width * ps) / z;
  const step = fieldArcsec <= 480 ? 30 : fieldArcsec <= 960 ? 60 : fieldArcsec <= 2400 ? 120 : 300;
  const x0 = (c.x - 0.5 / z) * wcs.width, span = wcs.width / z;   // visible image-pixel window (square field)
  const toScreen = (px) => ((px - x0) / span) * side;
  ctx.strokeStyle = tok("--ink-3"); ctx.lineWidth = 1;
  ctx.beginPath();
  for (let n = -Math.ceil(wcs.width * ps / step); n <= Math.ceil(wcs.width * ps / step); n++) {
    const px = wcs.width / 2 + (n * step) / ps;
    const s = Math.round(toScreen(px)) + 0.5;
    if (s < 0 || s > side) continue;
    const len = n % 2 === 0 ? 7 : 4;
    ctx.moveTo(s, 0); ctx.lineTo(s, len); ctx.moveTo(s, side); ctx.lineTo(s, side - len);
    ctx.moveTo(0, s); ctx.lineTo(len, s); ctx.moveTo(side, s); ctx.lineTo(side - len, s);
  }
  ctx.stroke();
  // scale bar: the largest round length that stays under a quarter of the stage
  const pxPerArcsec = (side / span) / ps;
  const lens = [5, 10, 15, 30, 60, 120, 300, 600];
  const L = [...lens].reverse().find((l) => l * pxPerArcsec <= side / 4) || lens[0];
  ui.scalebar.style.width = `${Math.round(L * pxPerArcsec)}px`;
  ui.scalebarLabel.textContent = L >= 60 ? `${L / 60}′` : `${L}″`;
}

/**
 * Smooth view: a crossfade from the previous pass over most of the frame time. The blend is a visual transition,
 * not an observation; Play passes keeps the hard cut that makes a mover jump. Never under reduced motion.
 */
function crossfadeFrom(key, view) {
  if (view !== "smooth" || REDUCED_MOTION || !state.lastDrawn || state.lastDrawn === key) return;
  const p = ui.imagePrev;
  p.width = ui.image.width; p.height = ui.image.height;
  p.getContext("2d").drawImage(ui.image, 0, 0);
  p.style.transition = "none";
  p.style.opacity = "1";
  void p.offsetWidth;   // commit the opaque state before fading
  p.style.transition = `opacity ${Math.round(Math.min(700, 700 / player.fps))}ms linear`;
  p.style.opacity = "0";
}

const player = new Player((i) => {
  if (state.view === "colours") state.colourIndex = i;
  else state.index = i;
  render();
  if (state.view === "colours") highlightFilmstrip();
});
if (REDUCED_MOTION) player.playing = false;   // respect "reduced motion": start paused
// no animation in a hidden tab; the position and the play/pause choice are kept
document.addEventListener("visibilitychange", () => { player.setSuspended(document.hidden); if (!document.hidden) render(); });

function updatePlayerUI() {
  ui.play.innerHTML = icon(player.playing ? "pause" : "play");
  ui.play.setAttribute("aria-label", player.playing ? "Pause" : "Play");
  const moving = PLAYING_VIEWS.includes(state.view);
  for (const b of [ui.play, ui.prev, ui.next]) b.disabled = state.recording || !moving || player.count < 2;
  // announce frames only while paused: a live region that changes twice a second is noise
  ui.frameLabel.setAttribute("aria-live", player.playing ? "off" : "polite");
}

// ---- time dock: passes as blocks on a real date axis ----
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mjdToDate = (m) => new Date((m - 40587) * 86400000);
const dateToMjd = (d) => d.getTime() / 86400000 + 40587;
const monthYear = (m) => { const d = mjdToDate(m); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
function passCaveats(f) {
  const why = [];
  if (f.target_flagged || f.target_flags?.includes("OVERFLOW")) why.push("the target's core is saturated (OVERFLOW)");
  else if (f.target_flags?.length) why.push(`pipeline flags on the target: ${f.target_flags.join(", ")}`);
  if ((f.flag_fraction ?? 0) > 0.05) why.push(`${(f.flag_fraction * 100).toFixed(0)} % of the pixels have no data`);
  return why;
}
function renderTimeline() {
  const fr = passFrames();
  ui.timeline.replaceChildren();
  ui.timelineCaption.textContent = "";
  if (!fr.length) return;
  const mid = (f) => f.mjd_mean ?? (f.mjd_start + f.mjd_end) / 2;
  const starts = fr.map((f) => (Number.isFinite(f.mjd_start) ? f.mjd_start : mid(f)));
  const ends = fr.map((f) => (Number.isFinite(f.mjd_end) ? f.mjd_end : mid(f)));
  let t0 = Math.min(...starts), t1 = Math.max(...ends);
  const pad = Math.max(12, (t1 - t0) * 0.04);
  t0 -= pad; t1 += pad;
  const X = (m) => ((m - t0) / (t1 - t0)) * 100;
  ui.timeline.append(el("div", { class: "axis" }));
  // month ticks, labelled sparsely
  const first = mjdToDate(t0);
  const months = [];
  for (let d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)); dateToMjd(d) < t1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d);
  const every = Math.max(1, Math.ceil(months.length / 6));
  months.forEach((d, i) => {
    const x = X(dateToMjd(d));
    ui.timeline.append(el("i", { class: "month", style: `left:${x}%` }));
    if (i % every === 0) ui.timeline.append(el("span", { class: "tick", style: `left:${x}%`, text: d.getUTCMonth() === 0 || i === 0 ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : MONTHS[d.getUTCMonth()] }));
  });
  // individual exposures, once the exposure list has loaded (Details)
  const ex = state.adv.exposures;
  if (ex?.exposures) {
    const det = +ui.band.value.slice(1);
    for (const e of ex.exposures) if (e.detector === det && Number.isFinite(e.mjd) && e.mjd >= t0 && e.mjd <= t1) ui.timeline.append(el("i", { class: "exp", style: `left:${X(e.mjd)}%` }));
  }
  fr.forEach((f, i) => {
    const why = passCaveats(f);
    const w = Math.max(0, X(ends[i]) - X(starts[i]));
    const b = el("button", {
      type: "button", class: "pass", style: `left:${X(starts[i])}%;width:${w}%`,
      title: `${f.epoch_label}: ${mjdDate(f.mjd_start)} to ${mjdDate(f.mjd_end)}, ${f.n_exposures ?? "?"} exposures${why.length ? `. Caveat: ${why.join("; ")}` : ""}. Click to show; Shift-click = pass A, Alt-click = pass B.`,
      "aria-label": `Show pass ${f.epoch_label}, ${mjdDate(f.mjd_mean ?? f.mjd_start)}${why.length ? `, caveat: ${why.join("; ")}` : ""}`,
      onclick: (ev) => {
        if (ev.shiftKey) { setAB(i, state.b); return; }
        if (ev.altKey) { setAB(state.a, i); return; }
        if (state.view !== "blink") setView("blink");
        if (player.playing) { player.toggle(); updatePlayerUI(); }
        player.index = i; state.index = i; render();
      },
    }, f.epoch_label, why.length ? el("span", { class: "warn", "aria-hidden": "true" }, iconEl("alert", 11)) : null);
    b.dataset.i = i;
    ui.timeline.append(b);
  });
  const nexp = fr.reduce((a, f) => a + (Number.isFinite(f.n_exposures) ? f.n_exposures : 0), 0);
  ui.timelineCaption.textContent = `${fr.length} pass${fr.length === 1 ? "" : "es"}, ${nexp} exposures, ${monthYear(Math.min(...starts))} to ${monthYear(Math.max(...ends))}`;
  highlightTimeline();
}
function highlightTimeline() {
  for (const b of ui.timeline.querySelectorAll("button.pass")) {
    const i = +b.dataset.i;
    const cur = state.view === "blink" && i === state.index;
    b.classList.toggle("current", cur);
    b.setAttribute("aria-current", cur ? "true" : "false");
    const ab = state.view === "diff" || state.view === "changes" || state.view === "blink";
    b.classList.toggle("ab-a", ab && passFrames().length > 1 && state.a !== state.b && i === state.a);
    b.classList.toggle("ab-b", ab && passFrames().length > 1 && state.a !== state.b && i === state.b);
  }
}

// ---- spectrum ----
async function measureSpectrum(ra, dec) {
  if (!state.frames) return;
  state.spectrumAbort?.abort();
  const ac = new AbortController();
  state.spectrumAbort = ac;
  state.pick = skyToPixel(ra, dec, state.frames.wcs);
  render();
  const det = ui.band.value;
  const q = { ra: ra.toFixed(6), dec: dec.toFixed(6), det };
  // the target's own proper motion (from /resolve) only applies when the click is on the target
  const t = state.target;
  if (t?.pm && sepDeg(ra, dec, t.ra, t.dec) < 15 / 3600) Object.assign(q, { pmra: t.pm.pmra, pmdec: t.pm.pmdec, epoch: t.pm.epoch });
  spectrumMessage(ui.spectrum, "Measuring the spectrum…");
  ui.spectrumNote.textContent = `At ${fmtSexa(ra, dec)}, ${det}.`;
  try {
    const s = await api.spectrum(q, {
      preset: state.preset, signal: ac.signal,
      onProgress: (job) => {
        spectrumMessage(ui.spectrum, `Measuring… ${job.total ? `${job.done} of ${job.total}` : jobTitle(job)}`);
        // only a live job reports progress: a spot nobody has measured yet is slow the first time
        ui.spectrumNote.textContent = `At ${fmtSexa(ra, dec)}, ${det}. A new spot can take a few minutes the first time, then it is cached. A test target's own star is instant.`;
      },
    });
    if (ac.signal.aborted) return;
    drawSpectrum(ui.spectrum, s.points);
    state.spectrum = { ...s, ra, dec };
    state.spectrumBand = det;
    const nFlag = s.points.filter((p) => p.flagged).length;
    ui.spectrumNote.textContent = `${s.points.length} points at ${fmtSexa(ra, dec)}, ${det}, µJy. Shapes mark passes (first dimmest).`
      + (nFlag ? ` ${nFlag} hollow points are flagged (e.g. saturated): their values come from wing fits, candidate values not independently verified.` : "");
    if (ui.advanced.open) refreshAdvanced();
  } catch (err) {
    if (err.name === "AbortError") return;
    if (ac.signal.aborted) return;
    spectrumMessage(ui.spectrum, err.code === "not_found" ? "No source measured here." : err.code === "invalid_response" ? "The service returned a spectrum this page cannot read."
      : err.code === "offline" ? "Spectrum unavailable here offline (it needs the backend)." : "Spectrum unavailable right now.");
    ui.spectrumNote.textContent = err.message || "";
  }
}

// image: click = spectrum (or select a marker), double-click = zoom, drag = pan when zoomed, move = readout
const imagePoint = (e, canvas = ui.image) => {
  const r = canvas.getBoundingClientRect();   // includes the zoom transform, so this maps correctly
  const w = state.shown?.width ?? state.frames.wcs.width, h = state.shown?.height ?? state.frames.wcs.height;
  return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h, w, h };
};
let pan = null, suppressClick = false;
ui.image.addEventListener("pointerdown", (e) => {
  if (!state.frames || state.zoom <= 1 || e.button !== 0) return;
  pan = { x: e.clientX, y: e.clientY, at: { ...zoomCentre() }, moved: false };
  ui.image.setPointerCapture?.(e.pointerId);
});
ui.image.addEventListener("pointermove", (e) => {
  if (pan) {
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) < 4) return;
    pan.moved = true;
    ui.image.classList.add("panning");
    ui.stageInner.classList.add("no-anim");
    const r = ui.image.getBoundingClientRect();
    state.zoomAt = { x: pan.at.x - dx / r.width, y: pan.at.y - dy / r.height };
    applyZoom();
    drawReticle(state.frames.wcs);
    return;
  }
  updateCursor(e);
});
const endPan = () => {
  if (!pan) return;
  if (pan.moved) { suppressClick = true; render(); }
  pan = null;
  ui.image.classList.remove("panning");
  ui.stageInner.classList.remove("no-anim");
};
ui.image.addEventListener("pointerup", endPan);
ui.image.addEventListener("pointercancel", endPan);
ui.image.addEventListener("pointerleave", () => { if (!pan) ui.cursor.textContent = "Point at the image for position and value"; });
function clickImage(e, canvas) {
  if (!ready()) return;
  if (suppressClick) { suppressClick = false; return; }
  const { x, y } = imagePoint(e, canvas);
  const { wcs } = state.frames;
  // clicking a marker selects the event
  const hit = state.events.find((ev) => Math.hypot(ev.x - x, ev.y - y) < 3 && (ev.confidence !== "low" || ui.showLow.checked));
  if (hit && ui.showEvents.checked) { selectEvent(hit.id); showInspector("events"); return; }
  const { ra, dec } = pixelToSky(x, y, wcs);
  showInspector("spectrum");
  measureSpectrum(ra, dec);
}
ui.image.addEventListener("click", (e) => clickImage(e, ui.image));
for (const cv of [ui.pairA, ui.pairB]) {
  cv.addEventListener("click", (e) => clickImage(e, cv));
  cv.addEventListener("pointermove", (e) => updateCursor(e, cv));
  cv.addEventListener("pointerleave", () => { ui.cursor.textContent = "Point at the image for position and value"; });
}
ui.image.addEventListener("dblclick", (e) => {
  if (!ready()) return;
  const { x, y } = imagePoint(e);
  zoomTo({ x, y }, state.zoom >= 4 ? 1 : state.zoom + 1);
});
function updateCursor(e, canvas = ui.image) {
  if (!ready() || !state.shown) return;
  const { x, y, w, h } = imagePoint(e, canvas);
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const wcs = state.view === "colours" && state.cube ? state.cube.wcs : state.frames.wcs;
  const { ra, dec } = pixelToSky(x, y, wcs);
  const data = canvas === ui.pairB ? frameB().data : state.shown.data;
  const v = data[Math.floor(y) * w + Math.floor(x)];
  const value = v == null ? "no data" : `${fmtVal(v)} ${state.shown.unit}`;
  ui.cursor.textContent = `${fmtSexa(ra, dec)}  ·  ${fmtDeg(ra, dec)}  ·  ${value}`;
}

// ---- wavelengths: whole band, channel range, molecules ----
function updateRangeLabel() {
  let lo = +ui.chLo.value, hi = +ui.chHi.value;
  if (lo > hi) [lo, hi] = [hi, lo];
  ui.chLabel.textContent = rangeText({ lo, hi });
}
ui.chLo.addEventListener("input", updateRangeLabel);
ui.chHi.addEventListener("input", updateRangeLabel);
function setWavelengths(wl, { reload = false } = {}) {
  state.wl = wl;
  for (const b of ui.wlSeg) b.setAttribute("aria-checked", String(b.dataset.wl === wl.kind));
  ui.rangeBox.hidden = wl.kind !== "range" && !ui.rangeBox.dataset.open;
  if (wl.kind === "range") { ui.chLo.value = wl.lo; ui.chHi.value = wl.hi; updateRangeLabel(); }
  for (const b of ui.molecules.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mol === wl.molecule && !!b.dataset.cont === !!wl.cont));
  renderBadges();
  if (reload && state.target) loadTarget(state.target);
}
function openRangeBox() {
  ui.rangeBox.hidden = false; ui.rangeBox.dataset.open = "1";
  for (const x of ui.wlSeg) x.setAttribute("aria-checked", String(x.dataset.wl === "range"));
  updateRangeLabel();
}
ui.wlSeg.forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.wl === "range") openRangeBox();
  else { delete ui.rangeBox.dataset.open; setWavelengths({ kind: "detector" }, { reload: state.wl.kind !== "detector" }); }
}));
ui.chApply.addEventListener("click", () => {
  let lo = +ui.chLo.value, hi = +ui.chHi.value;
  if (lo > hi) [lo, hi] = [hi, lo];
  setWavelengths({ kind: "range", lo, hi }, { reload: true });
});
for (const m of MOLECULES) {
  for (const cont of [false, true]) {
    const lam = cont ? m.cont : m.lam;
    const r = rangeFor(lam);
    const b = el("button", { type: "button", title: `${m.text} ${r.det} channels ${r.lo}–${r.hi}.`, text: cont ? `${m.label} continuum (${lam} µm)` : `${m.label} ${lam} µm` });
    b.dataset.mol = m.id;
    if (cont) b.dataset.cont = "1";
    b.addEventListener("click", () => {
      ui.rangeBox.dataset.open = "1";
      const changedBand = ui.band.value !== r.det;
      ui.band.value = r.det;
      setSlice(sliceForBand(r.det));
      if (changedBand) state.coverage = null;
      setWavelengths({ kind: "range", lo: r.lo, hi: r.hi, molecule: m.id, cont }, { reload: true });
    });
    ui.molecules.append(b);
  }
}

/**
 * Per-pass channel images for state.wl. Every requested channel must be present in every pass: if one is
 * missing, nothing is drawn and the user chooses (item 3). Returns the frames to show, a {blocked} report,
 * or null when cancelled.
 */
async function loadRange(ac) {
  const { lo, hi } = state.wl;
  const t0 = Date.now();
  showProgress("Loading single channels…");
  try {
    const cube = await api.cube({ ra: state.base.ra, dec: state.base.dec, fov: state.base.fov, det: ui.band.value, perPass: true }, {
      preset: state.preset, signal: ac.signal, onProgress: (job) => showProgress(jobTitle(job), job, t0),
      onStall: askStalled(() => { ac.abort(); loadTarget(state.target); }),
    });
    if (ac.signal.aborted) return null;
    rememberLams(cube);
    const r = framesFromCube(cube, lo, hi, state.base.frames);
    // coverage of the whole detector, for the hollow ticks on the ruler
    const gaps = framesFromCube(cube, 1, N_CH).gaps.map((m) => m.k);
    state.coverage = { det: cube.det, gaps: new Set(gaps) };
    if (r.missing.length && !state.wl.skipOk) return { blocked: { r, cube, lo, hi } };
    const lams = r.channels.map((c) => channelLam(ui.band.value, +c.slice(-2), state.lamTable));
    // everything about this product comes from the cube it was cut from, nothing from the whole-band frames
    const used = new Set(r.frames.flatMap((f) => f.obs_ids || []));
    return { ra: cube.ra, dec: cube.dec, fov: cube.fov, band: cube.det, units: cube.units, release: cube.release,
      inputs: cube.selected_input_records?.filter((rec) => used.has(rec.obs_id)),
      comparison_scope: cube.channel_at === "pixel" ? "pixel" : "field_centre_quicklook",
      wcs: cube.wcs, frames: r.frames, matched: true, matched_channels: r.channels,
      lam_eff_um: lams.length ? lams.reduce((a, b) => a + b, 0) / lams.length : null,
      _provenance: cube._provenance, retrieval: cube.retrieval, provenance: cube.provenance, completeness: cube.completeness,
      range: { lo, hi, missing: r.missing, skipped: r.skipped, suggest: r.frames.length < 2 ? suggestRange(cube, lo, hi) : null } };
  } catch (e) {
    if (e.name === "AbortError") return null;
    state.loadError = {
      tone: "error", title: e.code === "invalid_response" ? "The service returned channel data this page cannot read." : "Single channels aren't available for this target right now.",
      why: e.code === "offline" ? "They need the live backend; offline, only WISE 0855 (D6) has per-pass channels baked in." : e.message,
      actions: [{ label: "Use the whole band", primary: true, onClick: () => setWavelengths({ kind: "detector" }, { reload: true }) }],
    };
    // nothing is drawn: the whole band is not what was asked for
    return { ra: state.base.ra, dec: state.base.dec, fov: state.base.fov, band: ui.band.value, wcs: state.base.wcs, frames: [], range: { lo, hi } };
  } finally { if (!ac.signal.aborted) hideProgress(); }
}

/** The notice for a channel range with a gap: explicit choices, never a silent substitute. */
function gapNotice({ r, cube, lo, hi }) {
  const m = r.gaps;
  const desc = m.length === 1
    ? `Channel ${m[0].k} has no coverage in pass${m[0].passes.length === 1 ? "" : "es"} ${m[0].passes.join(", ")}.`
    : `Channels ${m.map((x) => x.k).join(", ")} are missing from at least one pass (${[...new Set(m.flatMap((x) => x.passes))].join(", ")}).`;
  const runs = coveredRuns(cube, lo, hi);
  const sg = suggestRange(cube, lo, hi);
  const actions = runs.map((run, i) => ({ label: run.lo === run.hi ? `Channel ${run.lo} only` : `Channels ${run.lo}–${run.hi} only`, primary: i === 0,
    onClick: () => setWavelengths({ kind: "range", lo: run.lo, hi: run.hi }, { reload: true }) }));
  if (r.frames.length >= 2) actions.push({ label: `Compare only ${r.frames.map((f) => f.epoch_label).join(", ")}`, primary: !actions.length,
    onClick: () => setWavelengths({ ...state.wl, skipOk: true }, { reload: true }) });
  if (sg && !(sg.lo === lo && sg.hi === hi)) actions.push({ label: `Try channels ${sg.lo}–${sg.hi}`, onClick: () => setWavelengths({ kind: "range", lo: sg.lo, hi: sg.hi }, { reload: true }) });
  actions.push({ label: "Pick another range", onClick: () => { openRangeBox(); ui.chLo.focus(); } });
  actions.push({ label: "Use the whole band", onClick: () => setWavelengths({ kind: "detector" }, { reload: true }) });
  return { tone: "warn", title: desc, why: `You asked for ${ui.band.value} channels ${lo}–${hi}. Nothing is drawn until you choose: dropping a channel or a pass changes what the image means.`, actions };
}

function rememberLams(cube) {
  state.lamTable = state.lamTable || {};
  for (const c of cube.channels || []) if (c.lam_um) state.lamTable[c.channel] = c.lam_um;
}

// ---- colours view: play through the channels of the band ----
async function loadColours() {
  if (!state.base) return;
  const key = `${state.base.ra},${state.base.dec},${state.base.fov},${ui.band.value}`;
  if (state.cubeKey === key && state.cube && !state.cube.error) { startColours(); return; }
  state.cubeKey = key;
  state.cube = null;
  player.load(0);
  // its own cancel: leaving the Colours view, a new target or Cancel stops it (and its progress overlay)
  state.colourAbort?.abort();
  const ac = new AbortController();
  state.colourAbort = ac;
  state.extraAbort?.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const t0 = Date.now();
  showProgress("Loading the band's 17 channels…");
  try {
    const cube = await api.cube({ ra: state.base.ra, dec: state.base.dec, fov: state.base.fov, det: ui.band.value }, {
      preset: state.preset, signal: ac.signal, onProgress: (job) => { if (!ac.signal.aborted) showProgress(jobTitle(job), job, t0); },
    });
    if (state.cubeKey !== key || ac.signal.aborted) return;
    rememberLams(cube);
    cube.channels = cube.channels.filter((c) => Array.isArray(c.data));
    if (!cube.channels.length) throw Object.assign(new Error("This cube has no channel images."), { code: "not_found" });
    state.cube = cube;
    if (state.view === "colours") startColours();
  } catch (e) {
    if (e.name === "AbortError" || ac.signal.aborted) { if (state.cubeKey === key) state.cubeKey = null; return; }
    if (state.cubeKey !== key) return;
    state.cube = { error: {
      tone: "empty", title: e.code === "invalid_response" ? "The service returned channel data this page cannot read." : "The channel-by-channel view isn't available here yet.",
      why: e.code === "offline" ? "It needs the live backend. Offline it is baked for Barnard's Star (D2), ε Indi B (D3), RW Aur (D2) and WISE 0855 (D3–D6)." : e.message,
      actions: [{ label: "Back to Play passes", primary: true, onClick: () => setView("blink") }],
    } };
    updateNotice();
    render();
  } finally { if (state.colourAbort === ac) { state.colourAbort = null; hideProgress(); } }
}
function startColours() {
  const n = state.cube.channels.length;
  player.load(n, Math.min(state.colourIndex, n - 1));
  renderFilmstrip();
  updatePlayerUI();
  updateNotice();
  scheduleSize();
}
function renderFilmstrip() {
  const c = state.cube;
  ui.filmstrip.replaceChildren();
  if (!c?.channels) return;
  c.channels.forEach((ch, i) => {
    const cv = el("canvas", { width: c.wcs.width, height: c.wcs.height, "aria-hidden": "true" });
    draw(cv, ch.data, c.wcs.width, c.wcs.height, { range: c.display_range, stretch: ui.stretch.value, cmap: ui.cmap.value });
    const b = el("button", { type: "button", title: `${ch.channel} · ${ch.lam_um.toFixed(3)} µm · ${ch.n_exposures} exposures`, "aria-label": `Show ${ch.channel}`,
      onclick: () => { if (player.playing) { player.toggle(); updatePlayerUI(); } player.index = i; state.colourIndex = i; render(); highlightFilmstrip(); } },
    cv, el("span", { text: `${ch.lam_um.toFixed(2)}` }));
    ui.filmstrip.append(b);
  });
  highlightFilmstrip();
}
function highlightFilmstrip() {
  [...ui.filmstrip.children].forEach((b, i) => b.classList.toggle("current", i === state.colourIndex));
}

// ---- URL state ----
function writeURL() {
  const url = new URL(location.href);
  const keep = ["mock", "embed", "fresh", "verify"].filter((k) => url.searchParams.has(k)).map((k) => [k, url.searchParams.get(k)]);
  url.search = "";
  for (const [k, v] of keep) url.searchParams.set(k, v);
  // a shared link must open against the same backend (item 19)
  const apiP = apiParam();
  if (apiP) url.searchParams.set("api", apiP);
  url.searchParams.set("mode", state.mode);
  const t = state.target;
  if (t) {
    url.searchParams.set("ra", +t.ra.toFixed(6));
    url.searchParams.set("dec", +t.dec.toFixed(6));
    url.searchParams.set("fov", ui.fov.value);
    url.searchParams.set("band", ui.band.value);
    if (!ui.matched.checked) url.searchParams.set("matched", "0");
    if (t.name) url.searchParams.set("name", t.name);
    if (state.view !== "blink") url.searchParams.set("view", state.view);
    if ((state.view === "diff" || state.view === "changes") && passFrames().length > 1) {
      url.searchParams.set("a", passFrames()[state.a]?.epoch_label);
      url.searchParams.set("b", passFrames()[state.b]?.epoch_label);
    }
    if (state.wl.kind === "range") url.searchParams.set("ch", `${state.wl.lo}-${state.wl.hi}`);
  }
  history.replaceState(null, "", url);
}
let wantedAB = null;   // ?a=&b= epoch labels from the URL, applied once frames arrive

const fitsURL = () => (state.base?._provenance?.kind === "live" && state.target && state.wl.kind === "detector"
  ? api.framesFitsURL({ ra: state.base.ra, dec: state.base.dec, fov: state.base.fov, band: ui.band.value, matched: ui.matched.checked }) : null);

// ---- the one loader every mode ends in ----
async function loadTarget({ ra, dec, label, name = null, pm = null, posNote = null, retryMissing = false }) {
  if (state.recording) { showBanner("A movie is recording. Wait until its download is ready before changing targets."); return; }
  nameAbort?.abort();
  state.jobAbort?.abort();
  state.extraAbort?.abort();
  state.spectrumAbort?.abort();
  const ac = new AbortController();
  state.jobAbort = ac;
  state.extraAbort = new AbortController();
  hideBanner();

  ra = ((ra % 360) + 360) % 360;
  const q = { ra: +ra.toFixed(6), dec: +dec.toFixed(6), fov: fovValue(), band: ui.band.value, matched: ui.matched.checked, retryMissing };
  const prev = state.target;
  const sameField = prev && sepDeg(prev.ra, prev.dec, q.ra, q.dec) < 1e-6;
  state.target = { ra: q.ra, dec: q.dec, label: label || fmtDeg(q.ra, q.dec), name, pm, posNote: posNote ?? (sameField ? prev.posNote : null) };
  state.preset = nearestPreset(q.ra, q.dec)?.slug || null;
  state.title = `${state.target.label} · ${q.band}${q.matched ? " matched" : ""} · ${q.fov}°`;
  writeURL();
  ui.showOnSky.hidden = state.mode === "explore";
  syncSky();

  const t0 = Date.now();
  showProgress(state.preset && !liveOnly() ? "Loading saved observations…" : "Asking the backend for frames…");
  let frames;
  try {
    frames = await api.frames(q, {
      preset: state.preset, signal: ac.signal,
      onProgress: (job) => showProgress(jobTitle(job), job, t0),
      onStall: askStalled(() => { ac.abort(); loadTarget(state.target); }),
    });
  } catch (e) {
    if (e.name === "AbortError" || ac.signal.aborted) return;
    hideProgress();
    state.base = state.frames = null;
    state.events = [];
    ui.targetLabel.textContent = state.target.label;
    renderTargetSummary();
    const other = Object.keys(DETECTORS).filter((d) => d !== q.band);
    if (e.code === "not_found") {
      const n = NOTICES.noCoverage(q.band);
      state.loadError = { ...n, why: `${e.message} ${n.why}${dataThrough ? ` Data through ${dataThrough}.` : ""}`,
        actions: other.map((d) => ({ label: `Try ${d}`, onClick: () => { ui.band.value = d; ui.band.dispatchEvent(new Event("change")); } })) };
    } else if (e.code === "invalid_response") {
      state.loadError = { ...NOTICES.badResponse(e.message), actions: [{ label: "Retry", primary: true, onClick: () => loadTarget(state.target) }] };
    } else if (e.code === "stalled") {
      state.loadError = { ...NOTICES.stalled(), why: e.message, actions: [{ label: "Retry", primary: true, onClick: () => loadTarget(state.target) }] };
    } else if (e.code === "bad_request" || e.code === "busy") {
      state.loadError = { tone: "error", title: e.code === "busy" ? "The processing queue is busy." : "This request needs different settings.", why: e.message, actions: [
        ...(e.code === "bad_request" && q.fov > 0.04 ? [{ label: "Try 0.04°", primary: true, onClick: () => { setFov(0.04); loadTarget(state.target); } }] : []),
        { label: "Retry", primary: e.code !== "bad_request" || q.fov <= 0.04, onClick: () => loadTarget(state.target) }] };
    } else {
      state.loadError = { ...NOTICES.backendDown(e.message, strictFresh()), actions: [
        { label: "Retry", primary: true, onClick: () => loadTarget(state.target) },
        ...(strictFresh() ? [] : [{ label: "Try Barnard's Star", onClick: () => choosePreset(PRESETS[0]) }])] };
    }
    updateNotice(); renderEvents(); renderBadges(); render(); renderTimeline(); closePicker();
    return;
  }
  if (ac.signal.aborted) return;
  hideProgress();
  state.loadError = null;

  state.base = frames;
  if (!sameField) { state.pick = null; state.zoom = 1; applyZoom(); }
  if (!sameField || state.spectrumBand !== q.band) {
    state.spectrum = null; state.spectrumBand = null;
    spectrumMessage(ui.spectrum, "Click a star in the image to measure its spectrum.");
    ui.spectrumNote.textContent = "One point per exposure, in µJy, at the wavelength SPHEREx saw at the star. Shapes mark passes; hollow points are flagged.";
  }
  if (!sameField || state.coverage?.det !== q.band) state.coverage = null;
  state.adv = {};
  state.cube = null; state.cubeKey = null;
  state.selected = null;
  let shown = frames;
  if (state.wl.kind === "range") {
    const r = await loadRange(ac);
    if (ac.signal.aborted) return;
    if (r?.blocked) {
      state.frames = null; state.events = [];
      state.loadError = gapNotice(r.blocked);
      ui.targetLabel.textContent = state.target.label;
      renderTargetSummary();
      updateNotice(); renderEvents(); renderBadges(); render(); renderTimeline(); closePicker();
      return;
    }
    shown = r || frames;
  }
  if (ac.signal.aborted) return;
  state.frames = shown;
  ui.targetLabel.textContent = state.target.label;   // only now: until frames arrive the viewer still shows the previous target
  renderTargetSummary();
  const n = shown.frames.length;
  state.index = 0;
  state.a = 0; state.b = Math.max(0, n - 1);
  if (wantedAB) {
    const ia = shown.frames.findIndex((f) => f.epoch_label === wantedAB[0]), ib = shown.frames.findIndex((f) => f.epoch_label === wantedAB[1]);
    if (ia >= 0) state.a = ia;
    if (ib >= 0) state.b = ib;
    wantedAB = null;
  }
  fillAB();
  renderTimeline();
  renderBadges();
  computeEvents();
  scheduleSize();
  setView(state.view, { silent: true });
  closePicker();
  writeURL();

  // extras: the Gaia overlay always (small). The movers search and the light curve also feed the events: they run
  // now for the saved test targets (bundled files, nothing to build), and for any other position only when Details
  // is opened, so a new field does not start three slow backend builds at once. Every late answer checks that its
  // request is still the current one before it writes state.
  const extra = state.extraAbort;
  const fieldKey = `${q.ra},${q.dec},${q.fov}`;
  if (state.sourcesKey !== fieldKey) {
    state.sources = null;
    api.overlay({ ra: q.ra, dec: q.dec, fov: q.fov }, { preset: state.preset, signal: extra.signal })
      .then((o) => { if (!extra.signal.aborted) { state.sources = o.sources; state.sourcesKey = fieldKey; computeEvents(); render(); } })
      .catch((e) => { if (e.name !== "AbortError" && !extra.signal.aborted) state.sources = null; });
  }
  state.movers = null;
  state.variability = null;
  const savedTarget = state.preset && frames._provenance?.kind === "precomputed";
  if (savedTarget || ui.advanced.open) loadAnalyses();
  if (ui.advanced.open) loadAdvanced();
}

/**
 * Movers search and light curve: both feed the change events. Requested once per target (shared with Details).
 * A light curve only means something for a named object at the field centre, not an arbitrary patch of sky.
 */
function loadAnalyses() {
  if (!state.base) return;
  const extra = state.extraAbort, adv = state.adv;
  const q = { ra: state.base.ra, dec: state.base.dec, fov: state.base.fov, band: ui.band.value };
  const opts = { preset: state.preset, signal: extra.signal };
  const offline = (e, what) => (e.code === "offline" ? `${what} needs the live backend for this position.` : e.message);
  if (!adv.movers) {
    adv.movers = "loading";
    api.movers(q, opts)
      .then((m) => { if (!extra.signal.aborted && state.adv === adv) { adv.movers = m; state.movers = m; computeEvents(); render(); if (ui.advanced.open) refreshAdvanced(); } })
      .catch((e) => { if (e.name !== "AbortError" && !extra.signal.aborted && state.adv === adv) { adv.movers = { error: offline(e, "The movers search") }; state.movers = adv.movers; if (ui.advanced.open) refreshAdvanced(); } });
  }
  if (!adv.lightcurve && (state.target?.name || state.preset)) {
    adv.lightcurve = "loading";
    api.lightcurve({ ra: q.ra, dec: q.dec, det: q.band }, opts)
      .then((lc) => { if (!extra.signal.aborted && state.adv === adv) { adv.lightcurve = lc; state.variability = lc; computeEvents(); render(); if (ui.advanced.open) refreshAdvanced(); } })
      .catch((e) => { if (e.name !== "AbortError" && !extra.signal.aborted && state.adv === adv) { adv.lightcurve = { error: offline(e, "The light curve") }; if (ui.advanced.open) refreshAdvanced(); } });
  }
}

ui.cancel.addEventListener("click", () => {
  const wasStalled = !!stallAnswer;
  state.jobAbort?.abort();
  state.colourAbort?.abort();
  hideProgress();
  showBanner(wasStalled ? "Cancelled." : "Cancelled. The server keeps building this position in the background, so asking again later is faster.");
});

// ---- the target picker (a sheet over the viewer) and the target line in the context bar ----
function renderTargetSummary() {
  const t = state.target;
  ui.searchSummary.hidden = !t;
  if (!t) return;
  ui.searchSummaryText.replaceChildren(fmtSexa(t.ra, t.dec), t.posNote ? el("span", { class: "pos-note", text: t.posNote }) : null);
}
function openPicker({ focus = true } = {}) {
  ui.picker.hidden = false;
  ui.viewer.classList.add("picking");
  ui.pickerClose.hidden = !state.target;
  if (state.mode === "explore") ensureSky().then(() => setTimeout(() => window.dispatchEvent(new Event("resize")), 50));
  if (focus) ui.tabs.find((t) => t.dataset.mode === state.mode)?.focus();
}
function closePicker() {
  if (document.body.classList.contains("touring") && !closePicker.force) return;
  ui.picker.hidden = true;
  ui.viewer.classList.remove("picking");
  scheduleSize();
}
// old names, used by the tour hooks
const expandSearch = () => openPicker({ focus: false });
const collapseSearch = () => { closePicker.force = true; closePicker(); closePicker.force = false; };
ui.searchExpand.addEventListener("click", () => openPicker());
ui.pickerClose.addEventListener("click", () => { closePicker(); ui.viewer.focus(); });

// ---- inspector tabs: Events, Spectrum, Details ----
function showInspector(name, { focus = false } = {}) {
  for (const t of ui.itabs) {
    const on = t.id === `itab-${name}`;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")).hidden = !on;
    if (on && focus) t.focus();
  }
  if (name === "spectrum") requestAnimationFrame(() => redrawSpectrum(ui.spectrum));
  if (name === "details" && !ui.advanced.open) ui.advanced.open = true;   // fires "toggle", which loads it
}
ui.itabs.forEach((t, i) => {
  t.addEventListener("click", () => showInspector(t.id.slice(5)));
  t.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d) showInspector(ui.itabs[(i + d + ui.itabs.length) % ui.itabs.length].id.slice(5), { focus: true });
  });
});

// ---- advanced drawer (the Details tab) ----
function loadAdvanced() {
  if (!state.base) return;
  const q = { ra: state.base.ra, dec: state.base.dec };
  const signal = state.extraAbort?.signal;
  const opts = { preset: state.preset, signal };
  const get = (key, fn, after) => {
    if (state.adv[key]) return;
    state.adv[key] = "loading";
    const adv = state.adv;
    fn().then((r) => { if (state.adv === adv) { adv[key] = r; after?.(); } })
      .catch((e) => { if (e.name !== "AbortError" && state.adv === adv) adv[key] = { error: e.code === "offline" ? "Needs the live backend for this position." : e.message }; })
      .finally(() => { if (state.adv === adv) refreshAdvanced(); });
  };
  loadAnalyses();
  get("exposures", () => api.exposures({ ...q, fov: state.base.fov }, opts), renderTimeline);
  const det = ui.band.value;
  const pm = state.target?.pm;
  // the proper-motion fit is for a named object at the centre, like the light curve
  if (state.target?.name || state.preset) get("motion", () => api.motion({ ...q, det, ...(pm ? { pmra: pm.pmra, pmdec: pm.pmdec, epoch: pm.epoch } : {}) }, opts));
  refreshAdvanced();
}
function refreshAdvanced() {
  renderAdvanced(ui.advBody, {
    displayedCube: state.view === "colours" && state.cube?.channels ? state.cube : null,
    target: state.target, resp: state.frames, band: ui.band.value, matched: isMatched(),
    exposures: state.adv.exposures, motion: state.adv.motion, lightcurve: state.adv.lightcurve,
    movers: state.adv.movers || state.movers, events: state.events, spectrum: state.spectrum, threshold: THRESHOLD,
    fitsURL: fitsURL(), sexa: state.target ? fmtSexa(state.target.ra, state.target.dec) : "", pick: state.pick,
    repro: state.frames ? reproLines() : [],
  });
}
ui.advanced.open = store.get(ADV_KEY) === "1";
ui.advanced.addEventListener("toggle", () => {
  store.set(ADV_KEY, ui.advanced.open ? "1" : "0");
  // opening the drawer from anywhere (a link, a test, the tour) shows its tab
  if (ui.advanced.open && $("ipanel-details").hidden) showInspector("details");
  if (ui.advanced.open) loadAdvanced();
});

// ---- saving: image and movie ----
function composite(scale = 5) {
  if (state.view === "pair" && !ui.pairStage.hidden) {
    // both passes next to each other, with their overlays and the A/B labels
    const W = ui.pairA.width * scale, H = ui.pairA.height * scale;
    const c = document.createElement("canvas");
    c.width = W * 2 + 8; c.height = H + 48;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    [[ui.pairA, ui.pairOverlayA], [ui.pairB, ui.pairOverlayB]].forEach(([img, ov], i) => { ctx.drawImage(img, i * (W + 8), 0, W, H); ctx.drawImage(ov, i * (W + 8), 0, W, H); });
    ctx.fillStyle = tok("--ink-1"); ctx.font = '14px "IBM Plex Sans", system-ui, sans-serif';
    ctx.fillText(ui.frameLabel.textContent, 8, H + 20);
    ctx.fillText(`${state.title} — SPHEREx (NASA/IPAC)`, 8, H + 40);
    return c;
  }
  const W = ui.image.width * scale, H = ui.image.height * scale;
  const c = document.createElement("canvas");
  c.width = W; c.height = H + 28;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(ui.image, 0, 0, W, H);
  ctx.drawImage(ui.overlay, 0, 0, W, H);
  ctx.fillStyle = tok("--ink-1"); ctx.font = '14px "IBM Plex Sans", system-ui, sans-serif';
  ctx.fillText(`${state.title} — ${ui.frameLabel.textContent} — SPHEREx (NASA/IPAC)`, 8, H + 19);
  return c;
}
ui.savePng.addEventListener("click", () => {
  if (!ready()) return;
  const saved = state.zoom; state.zoom = 1; applyZoom(); render();
  composite().toBlob((b) => {
    const url = URL.createObjectURL(b);
    const a = el("a", { href: url, download: `spherex-${state.preset || "field"}-${state.view}.png` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    state.zoom = saved; applyZoom(); render();
  });
});
ui.saveMovie.addEventListener("click", async () => {
  if (!ready()) return;
  if (typeof MediaRecorder === "undefined" || !ui.image.captureStream) {
    showNotice(ui.notice, { tone: "empty", title: "This browser can't record a movie.", why: "Use Save image, or a recent Chrome, Edge or Firefox." });
    return;
  }
  const original = { view: state.view, index: player.index, playing: player.playing };
  let recorder = null, stream = null, locked = [];
  try {
    // a movie is the blink (or the channels in Colours); the view on screen comes back afterwards
    const view = state.view === "colours" && state.cube?.channels ? "colours" : "blink";
    if (state.view !== view) setView(view, { silent: true });
    if (!player.count) throw new Error("No frames to record.");
    if (player.playing) player.toggle();
    state.recording = true;
    locked = [...document.querySelectorAll("main button, main input, main select")].map((c) => [c, c.disabled]);
    for (const [c] of locked) c.disabled = true;
    ui.saveMovie.textContent = "Recording…";
    const fps = +ui.speed.value;
    const canvas = composite(), ctx = canvas.getContext("2d");
    const type = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) throw new Error("No supported movie format; save an image instead.");
    stream = canvas.captureStream(Math.max(1, Math.round(fps)));
    recorder = new MediaRecorder(stream, { mimeType: type });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = (e) => reject(e.error || new Error("Recording failed")); });
    recorder.start();
    for (let k = 0; k < player.count * 3; k++) {
      player.index = k % player.count; player.onFrame(player.index);
      ctx.drawImage(composite(), 0, 0);
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }
    recorder.stop(); await done;
    const url = URL.createObjectURL(new Blob(chunks, { type }));
    const a = el("a", { href: url, download: `spherex-${state.preset || "field"}.${type.includes("mp4") ? "mp4" : "webm"}` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) {
    showBanner(`Movie export failed: ${e.message}`);
  } finally {
    if (recorder?.state === "recording") recorder.stop();
    stream?.getTracks().forEach((t) => t.stop());
    state.recording = false;
    for (const [c, was] of locked) c.disabled = was;
    ui.saveMovie.textContent = "Save movie";
    setView(original.view, { silent: true });
    if (PLAYING_VIEWS.includes(original.view) && original.view !== "colours") player.load(player.count, original.index, true);
    if (player.playing !== original.playing) player.toggle();
    updatePlayerUI(); render();
  }
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
  if (mode === "explore") { openPicker({ focus: false }); ensureSky(); }
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
    sky.select(state.target.ra, state.target.dec, fovValue());   // the loaded field is the selection to adjust
  });
});
ui.skyBtn.addEventListener("click", () => { setMode("explore"); openPicker(); });

// ---- the top-bar search: a name or coordinates in one field ----
function readTopQuery() {
  const s = ui.q.value.trim();
  if (!s) return null;
  const pair = parsePair(s);
  if (pair && validRA(pair.ra) && validDec(pair.dec)) return { kind: "coords", ...pair };
  if (pair && /^[\d\s:+\-−.,hdms°′″'"]+$/i.test(s)) return { kind: "bad", why: !validRA(pair.ra) ? "RA must be 0–360° or 0–24h." : "Dec must be between −90° and +90°." };
  if (/^[\d\s:+\-−.,]+$/.test(s)) return { kind: "bad", why: "Give both RA and Dec, e.g. 269.446 +4.771 or 17:57:47 +04:46:14." };
  return { kind: "name", name: s };
}
function echoTop() {
  const r = readTopQuery();
  ui.qEcho.classList.toggle("bad", r?.kind === "bad");
  ui.qEcho.textContent = !r ? "" : r.kind === "coords" ? `RA ${r.ra.toFixed(4)}°  Dec ${r.dec >= 0 ? "+" : "−"}${Math.abs(r.dec).toFixed(4)}°  ICRS  ·  ${fmtSexa(r.ra, r.dec)}`
    : r.kind === "bad" ? r.why : `Object name: look up “${r.name}” in SIMBAD`;
}
ui.q.addEventListener("input", echoTop);
ui.q.addEventListener("focus", echoTop);
ui.q.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== ui.q) ui.qEcho.textContent = ""; }, 150));
ui.topSearch.addEventListener("submit", (e) => {
  e.preventDefault();
  const r = readTopQuery();
  if (!r || r.kind === "bad") { echoTop(); ui.q.focus(); return; }
  ui.qEcho.textContent = "";
  if (r.kind === "coords") {
    ui.ra.value = ui.q.value.trim(); ui.dec.value = "";
    setMode("coords");
    echoCoords();
    const p = nearestPreset(r.ra, r.dec);
    loadTarget({ ra: r.ra, dec: r.dec, label: p ? p.label : `RA ${sexa(r.ra, true)}, Dec ${sexa(r.dec, false)}`, posNote: p && !liveOnly() ? "Typed position; saved demo data exists for it" : "Typed position (ICRS), used as given" });
  } else {
    ui.name.value = r.name;
    setMode("name");
    searchName(r.name);
  }
  ui.q.blur();
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

/**
 * Where a resolved position comes from, in words (item 10). Never prints an epoch unless a proper-motion
 * correction was applied to reach it.
 */
function positionNote(r, { savedDemo = false } = {}) {
  const pos = r.position && typeof r.position === "object" ? r.position : {};
  const src = sourceName(pos.source || r.source);
  const pmApplied = pos.pm_applied ?? (r.pmra != null && r.pmdec != null && Number.isFinite(r.epoch));
  const ref = Number.isFinite(pos.ref_epoch) ? pos.ref_epoch : 2000;
  const refTxt = ref === 2000 ? "J2000" : `epoch ${ref.toFixed(2)}`;
  if (r.source === "preset") return "Saved demo position (offline fallback)";
  const core = pmApplied ? `${src} ${refTxt}, moved to ${Number(r.epoch).toFixed(2)} using proper motion` : `${src} catalogue position, ${refTxt}, no proper motion applied`;
  return savedDemo ? `Saved demo position: ${core}` : core;
}

let nameAbort = null;   // a newer lookup (or target) cancels an older one, so a slow answer can't win
async function searchName(name, { band } = {}) {
  nameAbort?.abort();
  const lookup = new AbortController();
  nameAbort = lookup;
  name = name.trim();
  if (!name) return;
  const preset = presetByName(name);
  if (band) ui.band.value = band;
  else if (preset) ui.band.value = preset.band;
  showResult([["", `Looking up “${name}”…`]]);
  const bannerBefore = { level: fallbackLevel, text: ui.banner.textContent, hidden: ui.banner.hidden };
  let r;
  try {
    r = await api.resolve(name, { preset: preset?.slug, signal: lookup.signal });
    if (lookup.signal.aborted) return;
  } catch (e) {
    if (lookup.signal.aborted || e.name === "AbortError") return;
    if (e.code === "not_found") {
      showResult([["", `No object called “${name}” was found. Check the spelling, or use Coordinates.`]]);
    } else if (preset && !strictFresh()) {
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
  if (r.name) r.name = r.name.replace(/^NAME\s+/, "");
  // a test target found by name uses its baked position, so the saved observations apply exactly. Not in
  // ?fresh / ?verify: there the resolved position is used as returned (item 10).
  const savedDemo = !!preset && !liveOnly();
  if (savedDemo) {
    const fromBake = r._provenance?.kind === "precomputed";
    r.name = preset.label;
    if (!fromBake && r.source !== "preset") { r.epoch = PRESET_EPOCH; }
    r.ra = preset.ra; r.dec = preset.dec;
  }
  const pmTotal = Math.hypot(r.pmra || 0, r.pmdec || 0);
  const note = positionNote(r, { savedDemo: savedDemo && r.source !== "preset" });
  showResult([
    ["Object", r.name || name],
    ["RA, Dec", fmtDeg(r.ra, r.dec)],
    ["", fmtSexa(r.ra, r.dec)],
    ...(r.pmra != null ? [["Proper motion", `${(pmTotal / 1000).toFixed(pmTotal > 1000 ? 2 : 3)}″/yr`]] : []),
    ["Position", note],
  ]);
  const pm = r.pmra != null ? { pmra: r.pmra, pmdec: r.pmdec, epoch: r.epoch } : null;
  await loadTarget({ ra: r.ra, dec: r.dec, label: r.name || name, name, pm, posNote: note });
}

ui.panels.name.addEventListener("submit", (e) => { e.preventDefault(); searchName(ui.name.value); });

function choosePreset(p) {
  ui.name.value = p.name;
  if (state.mode !== "explore") setMode("name");
  return searchName(p.name, { band: p.band });
}
// example cards in the picker: a thumbnail, the name and what to look for
for (const p of PRESETS) {
  const b = el("button", { type: "button", class: "example", "aria-label": `${p.label}: ${p.hint}` },
    el("img", { src: `img/thumbs/${p.slug}.png`, alt: "", width: "56", height: "56", loading: "lazy" }),
    el("b", { text: p.label }), el("span", { text: `${p.hint} ${p.band}.` }));
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
  if (validRA(ra) && validDec(dec)) ui.echo.textContent = `→ RA ${ra.toFixed(4)}°  Dec ${dec >= 0 ? "+" : "−"}${Math.abs(dec).toFixed(4)}°  ICRS  =  ${fmtSexa(ra, dec)}`;
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
  loadTarget({ ra, dec, label: p ? p.label : `RA ${sexa(ra, true)}, Dec ${sexa(dec, false)}`, posNote: "Typed position (ICRS), used as given" });
});

// ---- mode 1: free exploration ----
let sky = null, skyLoading = null;

function sliceLabel(i) {
  if (!sky) return "–";
  if (sky.isBlankSlice(i)) return `${channelName(i)} (blank)`;
  const lam = sky.lambdas?.[i];
  return `${channelName(i)} · ${lam ? lam.toFixed(3) + " µm" : ""}`;
}
const skyControls = () => [ui.skyDraw, ui.skyView, ui.skyBg, ui.skySlice];
function ensureSky() {
  if (skyLoading) return skyLoading;
  for (const c of skyControls()) c.disabled = true;   // usable once the map is there
  ui.skyMsg.hidden = false;
  ui.skyMsg.textContent = "Loading the SPHEREx sky map…";
  const t = state.target || PRESETS[0];
  skyLoading = (async () => {
    if (!ui.skyBg.options.length) for (const b of BACKGROUNDS) ui.skyBg.appendChild(new Option(b.label, b.id));
    sky = await createSky(ui.skyWrap, {
      target: `${t.ra} ${t.dec}`, fov: 2, presets: PRESETS,
      onSelect: onSkySelect,
      onCursor: (c) => { ui.skyCursor.textContent = c ? `${fmtDeg(c.ra, c.dec)}  (${fmtSexa(c.ra, c.dec)})` : "–"; },
      // a test-target circle selects its field; "Compare this region" loads it
      onPreset: (slug) => { const p = PRESETS.find((x) => x.slug === slug); if (p) sky?.select(p.ra, p.dec, fovValue()); },
      onView: ({ fov }) => { ui.skyView.textContent = `Use current view (${fov < 1 ? fov.toFixed(2) : fov.toFixed(1)}°)`; },
    });
    sky.setClickSide(fovValue());
    sky.onDrawArmed((on) => ui.skyDraw.setAttribute("aria-pressed", on));
    for (const c of skyControls()) c.disabled = false;
    ui.skyBg.closest("label").hidden = BACKGROUNDS.length < 2;
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
    const retry = document.createElement("button");
    retry.type = "button"; retry.textContent = "Retry sky map";
    retry.addEventListener("click", () => { $("sky").replaceChildren(); ensureSky(); });
    const box = document.createElement("div");
    box.className = "sky-msg-actions";
    box.append(p, b, retry);
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
  // a quick exposure lookup is free for the saved test targets; anywhere else it would start a slow archive
  // search, so it is left to the comparison itself
  if (nearestPreset(ra, dec) && !liveOnly()) checkCoverage(ra, dec, side);
  else ui.skyCov.textContent = "Checked when you compare. A first search can take 1–10 minutes; the rest of the site stays usable.";
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
  loadTarget({ ra: s.ra, dec: s.dec, label: p ? p.label : `Sky region ${fmtSexa(s.ra, s.dec)}`, posNote: "Chosen on the sky map (ICRS)" });
});

// ---- shared control changes ----
ui.band.addEventListener("change", () => {
  setSlice(sliceForBand(ui.band.value));
  // a channel range belongs to one detector: changing the band goes back to the whole band
  if (state.wl.kind === "range") setWavelengths({ kind: "detector" });
  if (state.coverage?.det !== ui.band.value) state.coverage = null;
  updateRangeLabel();
  renderBadges();
  if (state.selection && state.mode === "explore") checkCoverage(state.selection.ra, state.selection.dec, state.selection.side);
  if (state.target) loadTarget(state.target);
});
ui.matched.addEventListener("change", () => { renderComparison(); if (state.target) loadTarget(state.target); });
ui.fov.addEventListener("change", () => {
  sky?.setClickSide(fovValue());
  if (state.mode === "explore" && state.selection && !ui.picker.hidden) {
    sky.select(state.selection.ra, state.selection.dec, fovValue());   // resize the pending box
    return;
  }
  if (state.target) loadTarget(state.target);
});

// ---- viewer events ----
ui.views.forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
ui.play.addEventListener("click", () => { player.toggle(); updatePlayerUI(); });
ui.prev.addEventListener("click", () => player.step(-1));
ui.next.addEventListener("click", () => player.step(1));
function setSpeed() {
  const fps = Math.min(+ui.speed.value, +ui.speed.max);
  player.setSpeed(fps);
  ui.speedLabel.textContent = `${fps} fps`;
}
ui.speed.addEventListener("input", setSpeed);
ui.fastBlink.addEventListener("change", () => {
  if (ui.fastBlink.checked) {
    const ok = confirm("Fast blink can flash more than three times a second, which can trigger seizures in people with photosensitive epilepsy. Allow blink speeds up to 10 frames per second?");
    if (!ok) { ui.fastBlink.checked = false; return; }
    ui.speed.max = "10"; ui.speed.step = "1";
  } else {
    ui.speed.max = String(SAFE_FPS); ui.speed.step = "0.5";
    if (+ui.speed.value > SAFE_FPS) ui.speed.value = String(SAFE_FPS);
  }
  setSpeed();
});
if (REDUCED_MOTION) document.querySelector('[data-view="smooth"]').title = "Unavailable as motion: your system asks for reduced motion, so Smooth shows plain passes.";
for (const c of [ui.stretch, ui.cmap, ui.clip, ui.showOverlay, ui.showEvents]) c.addEventListener("input", () => { render(); if (state.view === "colours" && c !== ui.showOverlay && c !== ui.showEvents) renderFilmstrip(); });
ui.emptyPreset.addEventListener("click", () => choosePreset(PRESETS[0]));

// close popovers (details) on an outside click or Esc
const popovers = () => [...document.querySelectorAll("details.tag-pop[open], details.display-opts[open]")];
document.addEventListener("click", (e) => { for (const d of popovers()) if (!d.contains(e.target)) d.open = false; });

// ---- keyboard map (Help lists it) ----
const toggle = (input) => { input.checked = !input.checked; input.dispatchEvent(new Event("input")); };
document.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("touring") || ui.guide.open || ui.help.open || ui.about.open) return;
  if (e.key === "Escape") {
    const open = popovers();
    if (open.length) { open.forEach((d) => { d.open = false; }); open[0].querySelector("summary")?.focus(); return; }
    if (!ui.picker.hidden && state.target) { closePicker(); ui.viewer.focus(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches("input, select, textarea, [contenteditable]") || e.target.closest("#sky-wrap")) return;
  if (e.key === "/") { e.preventDefault(); ui.q.focus(); return; }
  if (e.key === "?") { e.preventDefault(); ui.help.showModal(); return; }
  if (e.target.matches("[role=tab], [role=radio]") && ["ArrowLeft", "ArrowRight", " ", "Enter"].includes(e.key)) return;
  if (!ui.picker.hidden) return;   // the picker owns the keys while it is open
  if (e.key === " " && !e.target.matches("button, a, summary")) { e.preventDefault(); ui.play.click(); }
  else if (e.key === "ArrowRight") player.step(1);
  else if (e.key === "ArrowLeft") player.step(-1);
  else if (/^[1-7]$/.test(e.key) && ready()) setView(VIEWS[+e.key - 1]);
  else if ((e.key === "a" || e.key === "A") && passFrames().length > 1) setAB(state.index, state.b);
  else if ((e.key === "b" || e.key === "B") && passFrames().length > 1) setAB(state.a, state.index);
  else if ((e.key === "d" || e.key === "D") && ready()) setView(state.view === "diff" ? "blink" : "diff");
  else if (e.key === "g" || e.key === "G") toggle(ui.showOverlay);
  else if (e.key === "m" || e.key === "M") toggle(ui.showEvents);
  else if ((e.key === "+" || e.key === "=") && state.frames) zoomTo(state.zoom > 1 ? { x: zoomCentre().x * state.frames.wcs.width, y: zoomCentre().y * state.frames.wcs.height } : null, state.zoom + 1);
  else if ((e.key === "-" || e.key === "_") && state.frames) { state.zoom = Math.max(1, state.zoom - 1); applyZoom(); render(); }
});

// ---- stage size: the image takes every spare pixel (§6.1) ----
const DESKTOP = matchMedia("(min-width: 1200px) and (min-height: 600px)");
let sizeQueued = false;
function scheduleSize() {
  if (sizeQueued) return;
  sizeQueued = true;
  requestAnimationFrame(() => { sizeQueued = false; sizeStage(); });
}
function sizeStage() {
  const area = ui.stageArea;
  const cs = getComputedStyle(area);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const cbarW = getComputedStyle(ui.cbar).display === "none" || !ready() ? 0 : 68;
  const desktop = DESKTOP.matches && !document.body.classList.contains("embed");
  const w = area.clientWidth - padX - cbarW;
  const h = desktop ? area.clientHeight - padY : Math.max(280, innerHeight * 0.72);
  // snap to a whole multiple of the image width when that is within 10 %, so pixels are even
  const img = state.view === "colours" && state.cube?.wcs ? state.cube.wcs.width : state.frames?.wcs?.width;
  const snap = (side) => {
    side = Math.floor(Math.max(120, side));
    const k = img ? Math.floor(side / img) : 0;
    return k >= 1 && side - k * img <= side * 0.1 ? k * img : side;
  };
  const side = snap(Math.min(w, h));
  const pane = snap(Math.min((w - 8) / 2, h));   // Side by side: two squares across the same width
  let changed = false;
  if (ui.stage.style.width !== `${side}px`) { ui.stage.style.width = ui.stage.style.height = `${side}px`; changed = true; }
  for (const p of ui.pairStage.querySelectorAll(".pair-pane")) {
    if (p.style.width !== `${pane}px`) { p.style.width = p.style.height = `${pane}px`; changed = true; }
  }
  if (changed) render();
}
new ResizeObserver(scheduleSize).observe(ui.stageArea);
window.addEventListener("resize", scheduleSize);

// ---- embed caption ----
function updateEmbedCaption() {
  if (!document.body.classList.contains("embed")) return;
  const full = new URL(location.href); full.searchParams.delete("embed");
  const prov = provLabel(state.frames?._provenance).text;
  ui.embedCaption.hidden = false;
  ui.embedCaption.replaceChildren(`${state.target?.label || ""} · ${ui.band.value} · ${prov} · `, el("a", { href: full.href, target: "_blank", rel: "noopener", text: "Open in Sphere Shift" }));
}

// ---- tour, field guide, help, glossary ----
const hooks = {
  presets: PRESETS, state, ui,
  choosePreset: (slug) => {
    const p = PRESETS.find((x) => x.slug === slug);
    const loaded = state.frames && state.preset === slug && ui.band.value === p.band;
    return loaded ? Promise.resolve() : choosePreset(p);
  },
  setView, setMode, expandSearch, collapseSearch, selectEvent, zoomTo, measureSpectrum, showInspector,
  setMatched: async (on) => { if (ui.matched.checked !== on) { ui.matched.checked = on; renderComparison(); await loadTarget(state.target); } },
  setBand: async (band) => { if (ui.band.value !== band) { ui.band.value = band; setSlice(sliceForBand(band)); renderBadges(); await loadTarget(state.target); } },
  play: (on) => { if (player.playing !== on) { player.toggle(); updatePlayerUI(); } },
  openAdvanced: (on) => { if (on) showInspector("details"); else ui.advanced.open = false; },
  closeGuide: () => ui.guide.close(),
};
const runTour = () => { ui.tourOffer.hidden = true; for (const d of [ui.guide, ui.help, ui.about]) if (d.open) d.close(); startTour(tourSteps(hooks)); };
ui.tourBtn.addEventListener("click", runTour);
ui.tourYes.addEventListener("click", runTour);
ui.tourNo.addEventListener("click", () => { ui.tourOffer.hidden = true; store.set("sse.tourDone", "1"); });
renderGuide(ui.guideCards, hooks);
ui.guideBtn.addEventListener("click", () => ui.guide.showModal());
ui.guideClose.addEventListener("click", () => ui.guide.close());
ui.helpBtn.addEventListener("click", () => ui.help.showModal());
ui.helpClose.addEventListener("click", () => ui.help.close());
ui.helpTour.addEventListener("click", () => { ui.help.close(); runTour(); });
ui.helpGuide.addEventListener("click", () => { ui.help.close(); ui.guide.showModal(); });
ui.aboutBtn.addEventListener("click", () => ui.about.showModal());
ui.aboutClose.addEventListener("click", () => ui.about.close());
for (const d of [ui.guide, ui.help, ui.about]) d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
initGlossary();

// skins over the native controls (the native ones stay underneath and work without them)
try {
  fovUI = fovSkin(ui.fov, ui.fovSeg);
  ruler = wavelengthSkin(ui.band, ui.wlRuler, {
    chLo: ui.chLo, chHi: ui.chHi,
    onPropose: () => { openRangeBox(); ui.chApply.focus(); },
  });
  document.body.classList.add("js-skins");
} catch (e) { console.warn("control skins unavailable:", e); }

// ---- start ----
let dataThrough = null;
fillSuggestions();
// which backend this page talks to, and whether it answers
ui.backendStatus.textContent = `Backend: ${apiLabel()}, checking…`;
api.health().then((h) => {
  const switchHint = API_BASE === DEPLOYED_API ? "" : " (add ?api=default to switch back)";
  ui.backendStatus.textContent = h?.ok ? `Backend: ${apiLabel()}, answering${switchHint}`
    : `Backend: ${apiLabel()}, not reachable. ${strictFresh() ? "Verify mode: saved data is off, so nothing can load" : "The five test targets still work from saved data"}${switchHint}.`;
  ui.backendStatus.classList.toggle("ok", !!h?.ok);
  ui.backendStatus.classList.toggle("bad", !h?.ok);
  if (h?.release) ui.releaseTag.textContent = h.release.toUpperCase().replace("-", " ");
});
api.meta().then((m) => {
  state.apiVersion = m?.api_version || null;
  if (state.apiVersion) ui.releaseTag.textContent = `${ui.releaseTag.textContent}${ui.releaseTag.textContent ? " · " : ""}API ${state.apiVersion}`;
  dataThrough = m?.index?.data_through || null;
  if (dataThrough) ui.dataSpan.textContent = `Data through ${dataThrough}`;
  const last = store.get(SEEN_KEY);
  if (dataThrough && last && dataThrough > last) { ui.newData.hidden = false; ui.newData.textContent = `New SPHEREx data since your last visit (through ${dataThrough})`; }
  else if (m?.check?.new_releases?.length) { ui.newData.hidden = false; ui.newData.textContent = "A new SPHEREx release is out"; }
  if (dataThrough) store.set(SEEN_KEY, dataThrough);
});

const qp = qp0;
if (qp.has("embed")) document.body.classList.add("embed");
if (qp.has("fov")) setFov(+qp.get("fov"));
if (qp.has("band") && DETECTORS[qp.get("band")]) ui.band.value = qp.get("band");
ui.matched.checked = qp.get("matched") !== "0";   // matched wavelengths are the default
if (VIEWS.includes(qp.get("view"))) state.view = qp.get("view");
if (qp.has("a") && qp.has("b")) wantedAB = [qp.get("a"), qp.get("b")];
const ch = /^(\d+)-(\d+)$/.exec(qp.get("ch") || "");
if (ch) { const lo = Math.max(1, Math.min(N_CH, +ch[1])), hi = Math.max(lo, Math.min(N_CH, +ch[2])); ui.rangeBox.dataset.open = "1"; setWavelengths({ kind: "range", lo, hi }); }
updateRangeLabel();
renderBadges();
for (const b of ui.views) b.setAttribute("aria-checked", String(b.dataset.view === state.view));
setSpeed();
spectrumMessage(ui.spectrum, "Click a star in the image to measure its spectrum.");
const startMode = MODES.includes(qp.get("mode")) ? qp.get("mode") : qp.has("ra") ? "coords" : "name";
const ra0 = parseCoord(qp.get("ra") ?? "", true), dec0 = parseCoord(qp.get("dec") ?? "", false);
const hasCoords = validRA(ra0) && validDec(dec0);

if (hasCoords) {
  const name = qp.get("name");
  if (name) ui.name.value = name;
  ui.ra.value = qp.get("ra"); ui.dec.value = qp.get("dec"); echoCoords();
  const p = nearestPreset(ra0, dec0);
  ui.picker.hidden = true;
  loadTarget({ ra: ra0, dec: dec0, name, label: name || p?.label || `RA ${sexa(ra0, true)}, Dec ${sexa(dec0, false)}`, posNote: "Position from the shared link (ICRS)" });
} else if (qp.get("name")) {
  ui.name.value = qp.get("name");
  ui.picker.hidden = true;
  searchName(qp.get("name"), { band: DETECTORS[qp.get("band")] ? qp.get("band") : undefined });
} else if (qp.has("embed")) {
  choosePreset(PRESETS[0]);
}
// first visit: the picker, with the five examples (§6.2)
setMode(startMode);
if (state.target || hasCoords || qp.get("name") || qp.has("embed")) closePicker();
else openPicker({ focus: false });
updatePlayerUI();
render();
scheduleSize();

if (qp.get("tour") === "1") runTour();
else if (!tourDone() && !qp.has("embed")) ui.tourOffer.hidden = false;
