// Wiring, the three search modes, the viewer and URL state. Owner: C.
//   explore: pan/zoom an all-sky map, select a region (js/sky.js)
//   name:    resolve an object name (/api/resolve), then compare
//   coords:  type RA/Dec, then compare
// Every mode ends in loadTarget(), which runs /api/frames as an async job and drives the viewer.
// The viewer: Play passes (blink), Difference and Changes (σ) between any two passes A/B, Sum, and Colours
// (the 17 channels of a band). Changes are circled automatically (js/changes.js) and listed as Events.
// URL: ?mode=&ra=&dec=&fov=&band=&matched=&name=&view=&a=&b=&ch=lo-hi&tour=1&embed=1
import { api, setFallbackHandler } from "./api.js";
import { parseCoord } from "./coordinates.js";
import { Player } from "./player.js";
import { draw, sumFrames } from "./render.js";
import { pixelToSky, skyToPixel, prepareOverlay, drawGaia, drawEvents, drawPick } from "./overlays.js";
import { drawSpectrum } from "./spectrum.js";
import { createSky, BACKGROUNDS, channelName, sliceForBand } from "./sky.js";
import { findChanges, mergeKnown, addVariable, diffMap } from "./changes.js";
import { DETECTORS, MOLECULES, channelLam, rangeFor, framesFromCube, suggestRange, N_CH } from "./bands.js";
import { initGlossary } from "./glossary.js";
import { showNotice, clearNotice, NOTICES } from "./notice.js";
import { startTour, tourDone } from "./tour.js";
import { renderEventList, renderEventDetail, mjdDate, el } from "./events-ui.js";
import { renderAdvanced } from "./advanced.js";
import { tourSteps, renderGuide } from "./guide.js";

// The five challenge test targets. Coordinates are refined at start-up from the precomputed bakes
// (precomputed/<slug>/resolve.json, the exact positions the bakes were built at).
const PRESETS = [
  { slug: "barnards-star", label: "Barnard's Star", name: "Barnard's Star", ra: 269.446074, dec: 4.770711, band: "D2", aliases: ["barnard", "barnards star"] },
  { slug: "eps-indi-b", label: "ε Indi B", name: "eps Indi B", ra: 331.0984021, dec: -56.8012569, band: "D3", aliases: ["epsilon indi b", "ε indi b"] },
  { slug: "wise-0855", label: "WISE 0855−0714", name: "WISE J085510.83-071442.5", ra: 133.7577838, dec: -7.2420232, band: "D6", aliases: ["wise 0855", "wise 0855-0714"] },
  { slug: "rw-aur", label: "RW Aur", name: "RW Aur", ra: 76.9565886, dec: 30.4012864, band: "D2", aliases: ["rw aurigae"] },
  { slug: "r-dra", label: "R Dra", name: "R Dra", ra: 248.1672204, dec: 66.7550253, band: "D2", aliases: ["r draconis"] },
];
const MODES = ["explore", "name", "coords"];
const VIEWS = ["blink", "diff", "changes", "sum", "colours"];
const RECENT_KEY = "sse.recentNames";
const ADV_KEY = "sse.advancedOpen";
const SEEN_KEY = "sse.lastDataThrough";
const THRESHOLD = 5;
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

const $ = (id) => document.getElementById(id);
const ui = {
  tabs: [...document.querySelectorAll('[role="tab"]')],
  panels: { explore: $("panel-explore"), name: $("panel-name"), coords: $("panel-coords") },
  searchBody: $("search-body"), searchSummary: $("search-summary"), searchSummaryText: $("search-summary-text"), searchExpand: $("search-expand"),
  // shared
  fov: $("fov"), band: $("band"), matched: $("matched"),
  wlSeg: [...document.querySelectorAll("[data-wl]")], rangeBox: $("range-box"), chLo: $("ch-lo"), chHi: $("ch-hi"), chLabel: $("ch-label"),
  chApply: $("ch-apply"), molecules: $("molecules"),
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
  viewer: $("viewer"), targetLabel: $("target-label"), badges: $("badges"), showOnSky: $("show-on-sky"),
  views: [...document.querySelectorAll("[data-view]")], ab: $("ab"), passA: $("pass-a"), passB: $("pass-b"), abHint: $("ab-hint"), sensitivity: $("sensitivity"),
  notice: $("viewer-notice"), stage: $("stage"), stageInner: $("stage-inner"), stageEmpty: $("stage-empty"), emptyPreset: $("empty-preset"),
  image: $("image"), overlay: $("overlay"), legend: $("legend"), sigmaScale: $("sigma-scale"),
  play: $("play"), prev: $("prev"), next: $("next"), speed: $("speed"), frameLabel: $("frame-label"),
  timeline: $("timeline"), filmstrip: $("filmstrip"),
  showOverlay: $("show-overlay"), showEvents: $("show-events"), zoom: $("zoom"), savePng: $("save-png"), saveMovie: $("save-movie"),
  stretch: $("stretch"), cmap: $("cmap"), clip: $("clip"),
  // side
  events: $("events"), eventDetail: $("event-detail"), eventsSummary: $("events-summary"), showLow: $("show-low"), lowCount: $("low-count"),
  spectrum: $("spectrum"),
  // advanced, header, dialogs
  advanced: $("advanced"), advBody: $("adv-body"),
  banner: $("banner"), dataSpan: $("data-span"), newData: $("new-data"),
  tourBtn: $("tour-btn"), tourOffer: $("tour-offer"), tourYes: $("tour-offer-yes"), tourNo: $("tour-offer-no"),
  guide: $("guide"), guideBtn: $("guide-btn"), guideClose: $("guide-close"), guideCards: $("guide-cards"),
};

const state = {
  mode: "name",
  base: null,          // /api/frames response for the target (whole detector)
  frames: null,        // what the viewer shows: base, or per-pass channel-range frames from /api/cube
  sources: null, movers: null, preset: null, index: 0,
  target: null,        // {ra, dec, label, name, pm} currently shown in the viewer
  selection: null,     // explore-mode region not yet compared: {ra, dec, side}
  view: "blink", a: 0, b: 0,
  change: null,        // {key, sigma, events} for the current A/B
  events: [], selected: null,
  wl: { kind: "detector" },   // or {kind: "range", lo, hi, molecule}
  cube: null, cubeKey: null, colourIndex: 0,
  zoom: 1, zoomAt: { x: 0.5, y: 0.5 },
  spectrum: null, pick: null,
  adv: {},             // lazily loaded drawer data: exposures, motion, lightcurve
  loadError: null,
  jobAbort: null, spectrumAbort: null, coverageAbort: null, extraAbort: null,
};

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
// case, apostrophes, unicode minus and spacing don't matter ("barnards star", "WISE 0855−0714")
const normName = (v) => v.toLowerCase().replace(/[’']/g, "").replace(/−/g, "-").trim().replace(/\s+/g, " ");
const presetByName = (name) => PRESETS.find((p) => [p.name, p.label, p.slug, ...(p.aliases || [])].some((x) => normName(x) === normName(name))) || null;

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

// ---- viewer: which frames, which passes ----
const passFrames = () => state.frames?.frames || [];
const frameA = () => passFrames()[state.a];
const frameB = () => passFrames()[state.b];
const hasNoise = () => passFrames().length > 1 && !!frameA()?.noise && !!frameB()?.noise;
const isMatched = () => !!state.frames?.matched;

function setView(view, { silent = false } = {}) {
  if (!VIEWS.includes(view)) view = "blink";
  state.view = view;
  for (const b of ui.views) b.setAttribute("aria-checked", String(b.dataset.view === view));
  ui.ab.hidden = !(view === "diff" || view === "changes") || passFrames().length < 2;
  ui.filmstrip.hidden = view !== "colours";
  if (view === "colours") loadColours();
  else player.load(passFrames().length, view === "blink" ? state.index : null);
  updatePlayerUI();
  updateNotice();
  render();
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
    const r = findChanges(A, B, { ...wcs, threshold: THRESHOLD, matched: isMatched(), brightStars, sysFrac: +ui.sensitivity.value });
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

function renderEvents() {
  const ev = state.events;
  const low = ev.filter((e) => e.confidence === "low").length;
  ui.lowCount.textContent = low;
  const shown = ev.filter((e) => e.confidence !== "low" || ui.showLow.checked);
  const A = frameA(), B = frameB();
  if (!state.frames) ui.eventsSummary.textContent = "Events appear once a target has two or more passes.";
  else if (passFrames().length < 2) ui.eventsSummary.textContent = "Only one pass: nothing to compare yet.";
  else if (state.a === state.b) ui.eventsSummary.textContent = "Pick two different passes to compare.";
  else {
    const hi = ev.length - low;
    ui.eventsSummary.textContent = `${A.epoch_label} → ${B.epoch_label}: ${hi} confident event${hi === 1 ? "" : "s"}${low ? `, ${low} uncertain${ui.showLow.checked ? "" : " (hidden)"}` : ""}.`
      + (hasNoise() ? "" : state.wl.kind === "range" ? " Single channels have no noise maps, so no events are computed." : " No noise maps here, so only known movers are listed.")
      + (!isMatched() && hasNoise() ? " Turn on Fair brightness comparison to trust brightness changes." : "");
  }
  renderEventList(ui.events, shown.length || !ev.length ? ev : ev, { selected: state.selected, showLow: ui.showLow.checked, onSelect: (e) => selectEvent(e.id) });
  renderDetail();
}
ui.showLow.addEventListener("change", () => { renderEvents(); render(); });

function renderDetail() {
  const e = state.events.find((x) => x.id === state.selected);
  if (!e || !state.frames) { renderEventDetail(ui.eventDetail, null); return; }
  renderEventDetail(ui.eventDetail, e, {
    frames: passFrames(), wcs: state.frames.wcs, sources: state.sources, A: frameA(), B: frameB(),
    target: state.target, band: ui.band.value, matched: isMatched(), release: state.frames.release,
    fitsURL: fitsURL(),
    onSpectrum: (ev) => measureSpectrum(ev.ra, ev.dec),
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

// ---- zoom ----
function applyZoom() {
  const z = state.zoom;
  const clamp = (v) => Math.min(1 - 0.5 / z, Math.max(0.5 / z, v));
  const cx = z > 1 ? clamp(state.zoomAt.x) : 0.5, cy = z > 1 ? clamp(state.zoomAt.y) : 0.5;
  ui.stageInner.style.transform = z > 1 ? `scale(${z}) translate(${(0.5 - cx) * 100}%, ${(0.5 - cy) * 100}%)` : "";
  ui.zoom.value = String(z);
}
function zoomTo(p, z) {
  if (!state.frames) return;
  const { wcs } = state.frames;
  p = p || { x: wcs.width / 2, y: wcs.height / 2 };   // null = the field centre (the target)
  state.zoom = z;
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
  const saturated = fr.some((f) => f.target_flagged || f.target_flags?.includes("OVERFLOW"));
  if ((state.view === "changes" || state.view === "diff") && !isMatched() && state.wl.kind === "detector") {
    showNotice(ui.notice, {
      tone: "info", title: "Brightness changes here may not be real.",
      why: "Each pass saw a slightly different mix of wavelengths. Motion is fine to judge; for brightness, compare fairly.",
      actions: [{ label: "Use fair brightness comparison", primary: true, onClick: () => { ui.matched.checked = true; ui.matched.dispatchEvent(new Event("change")); } }],
    });
    return;
  }
  if (saturated && (state.view === "changes" || state.view === "diff")) {
    const next = `D${Math.min(6, +ui.band.value.slice(1) + 1)}`;
    showNotice(ui.notice, { ...NOTICES.saturated(ui.band.value), actions: ui.band.value === "D6" ? [] : [{ label: `Try ${next}`, onClick: () => { ui.band.value = next; ui.band.dispatchEvent(new Event("change")); } }] });
    return;
  }
  clearNotice(ui.notice);
}

function renderBadges() {
  const fr = passFrames();
  const out = [];
  if (fr.some((f) => f.target_flagged || f.target_flags?.includes("OVERFLOW"))) {
    const b = el("span", { class: "badge badge-warn", title: "OVERFLOW: the target's core saturates the detector in this band", text: "⚠ Saturated core" });
    out.push(b);
  }
  if (isMatched() && state.wl.kind === "detector") out.push(el("span", { class: "badge badge-ok", title: `Channels in every pass: ${state.frames.matched_channels?.join(", ")}`, text: `Fair comparison${state.frames.lam_eff_um ? ` · ${state.frames.lam_eff_um.toFixed(3)} µm` : ""}` }));
  if (state.wl.kind === "range") out.push(el("span", { class: "badge", text: rangeText(state.wl) }));
  ui.badges.replaceChildren(...out);
}

// ---- rendering ----
function render() {
  ui.stageEmpty.hidden = !!state.frames;
  if (!state.frames) {
    ui.image.getContext("2d").clearRect(0, 0, ui.image.width, ui.image.height);
    ui.overlay.getContext("2d").clearRect(0, 0, ui.overlay.width, ui.overlay.height);
    ui.legend.hidden = true;
    return;
  }
  const { wcs } = state.frames;
  const fr = passFrames();
  const opts = { stretch: ui.stretch.value, cmap: ui.cmap.value, clip: parseFloat(ui.clip.value) };
  let label = "", epoch = fr[state.index]?.epoch_label, showMarks = true;
  const view = fr.length < 2 && state.view !== "colours" ? "blink" : state.view;
  if (view === "colours" && state.cube?.channels?.length) {
    const ch = state.cube.channels[state.colourIndex % state.cube.channels.length];
    draw(ui.image, ch.data, state.cube.wcs.width, state.cube.wcs.height, { ...opts, range: state.cube.display_range });
    label = `${ch.channel} · ${ch.lam_um.toFixed(3)} µm (${state.colourIndex + 1}/${state.cube.channels.length})`;
    epoch = null; showMarks = false;
  } else if (view === "diff" || view === "changes") {
    const A = frameA(), B = frameB();
    if (view === "changes" && state.change) {
      draw(ui.image, state.change.sigma, wcs.width, wcs.height, { ...opts, diverging: true, range: [-THRESHOLD, THRESHOLD] });
      label = `${B.epoch_label} vs ${A.epoch_label}, in σ`;
    } else {
      const d = diffMap(A, B);
      draw(ui.image, d, wcs.width, wcs.height, { ...opts, diverging: true });
      label = `${B.epoch_label} − ${A.epoch_label}`;
    }
    epoch = B.epoch_label;
  } else if (view === "sum") {
    const d = sumFrames(fr);
    draw(ui.image, d, wcs.width, wcs.height, opts);
    label = "all passes added";
  } else {
    const f = fr[state.index];
    draw(ui.image, f.data, wcs.width, wcs.height, { ...opts, limitsFrom: fr.flatMap((x) => x.data) });
    label = `${f.epoch_label} · ${mjdDate(f.mjd_mean ?? f.mjd_start)} (${state.index + 1}/${fr.length})`;
  }
  ui.frameLabel.textContent = label;
  ui.sigmaScale.hidden = view !== "changes" || !state.change;
  ui.legend.hidden = !showMarks || !ui.showEvents.checked || !state.events.length;

  const o = prepareOverlay(ui.overlay, view === "colours" && state.cube ? state.cube.wcs : wcs, state.zoom);
  if (ui.showOverlay.checked && epoch) drawGaia(o, state.sources, wcs, epoch);
  if (showMarks && ui.showEvents.checked) {
    const vis = state.events.filter((e) => e.confidence !== "low" || ui.showLow.checked || e.id === state.selected);
    drawEvents(o, vis, { selected: state.selected });
  }
  if (state.pick) drawPick(o, state.pick);
  highlightTimeline();
}

const player = new Player((i) => {
  if (state.view === "colours") state.colourIndex = i;
  else state.index = i;
  render();
});
if (REDUCED_MOTION) player.playing = false;   // respect "reduced motion": start paused

function updatePlayerUI() {
  ui.play.textContent = player.playing ? "Pause" : "Play";
  const moving = state.view === "blink" || state.view === "colours";
  for (const b of [ui.play, ui.prev, ui.next]) b.disabled = !moving || player.count < 2;
}

// ---- timeline strip: passes on a real time axis ----
function renderTimeline() {
  const fr = passFrames();
  ui.timeline.replaceChildren();
  if (!fr.length) return;
  const t = fr.map((f) => f.mjd_mean ?? (f.mjd_start + f.mjd_end) / 2);
  const t0 = Math.min(...t), t1 = Math.max(...t), span = t1 - t0 || 1;
  const pos = (m) => (fr.length === 1 ? 50 : 6 + ((m - t0) / span) * 88);
  ui.timeline.append(el("div", { class: "axis" }));
  fr.forEach((f, i) => {
    const flagged = f.target_flagged || (f.flag_fraction ?? 0) > 0.05;
    const b = el("button", {
      type: "button", class: "pass", style: `left:${pos(t[i])}%`,
      title: `${f.epoch_label}: ${mjdDate(f.mjd_start)} – ${mjdDate(f.mjd_end)}, ${f.n_exposures} exposures${flagged ? " — ⚠ target flagged (saturated or hit)" : ""}. Click to show; Shift-click = pass A, Alt-click = pass B.`,
      "aria-label": `Show pass ${f.epoch_label}`,
      onclick: (ev) => {
        if (ev.shiftKey) { setAB(i, state.b); return; }
        if (ev.altKey) { setAB(state.a, i); return; }
        if (state.view !== "blink") setView("blink");
        if (player.playing) { player.toggle(); updatePlayerUI(); }
        player.index = i; state.index = i; render();
      },
    }, f.epoch_label, flagged ? el("span", { class: "warn", text: "⚠" }) : null);
    b.dataset.i = i;
    ui.timeline.append(b, el("span", { class: "tick", style: `left:${pos(t[i])}%`, text: mjdDate(f.mjd_mean ?? f.mjd_start).slice(0, 7) }));
  });
  highlightTimeline();
}
function highlightTimeline() {
  for (const b of ui.timeline.querySelectorAll("button.pass")) {
    const i = +b.dataset.i;
    b.classList.toggle("current", state.view === "blink" && i === state.index);
    const ab = state.view === "diff" || state.view === "changes";
    b.classList.toggle("ab-a", ab && i === state.a);
    b.classList.toggle("ab-b", ab && i === state.b);
  }
}

// ---- spectrum ----
function spectrumMessage(text) {
  const ctx = ui.spectrum.getContext("2d");
  ctx.clearRect(0, 0, ui.spectrum.width, ui.spectrum.height);
  ctx.fillStyle = "#8b95a7";
  ctx.font = "11px system-ui";
  ctx.fillText(text, 44, ui.spectrum.height / 2);
}

async function measureSpectrum(ra, dec) {
  if (!state.frames) return;
  state.spectrumAbort?.abort();
  const ac = new AbortController();
  state.spectrumAbort = ac;
  state.pick = skyToPixel(ra, dec, state.frames.wcs);
  render();
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
    if (ac.signal.aborted) return;
    drawSpectrum(ui.spectrum, s.points);
    state.spectrum = { ...s, ra, dec };
    if (ui.advanced.open) refreshAdvanced();
  } catch (err) {
    if (err.name !== "AbortError") spectrumMessage(err.code === "not_found" ? "No source measured here" : "Spectrum unavailable offline here (needs the backend)");
  }
}

ui.image.addEventListener("click", (e) => {
  if (!state.frames) return;
  const r = ui.image.getBoundingClientRect();   // includes the zoom transform, so this maps correctly
  const { wcs } = state.frames;
  const x = ((e.clientX - r.left) / r.width) * wcs.width;
  const y = ((e.clientY - r.top) / r.height) * wcs.height;
  // clicking a marker selects the event
  const hit = state.events.find((ev) => Math.hypot(ev.x - x, ev.y - y) < 3 && (ev.confidence !== "low" || ui.showLow.checked));
  if (hit && ui.showEvents.checked) selectEvent(hit.id);
  const { ra, dec } = pixelToSky(x, y, wcs);
  measureSpectrum(ra, dec);
});

// ---- wavelengths: whole band, channel range, molecules ----
const rangeText = (wl) => {
  const det = ui.band.value;
  return `${det} channels ${wl.lo}–${wl.hi} · ≈${channelLam(det, wl.lo, state.lamTable).toFixed(2)}–${channelLam(det, wl.hi, state.lamTable).toFixed(2)} µm${wl.molecule ? ` (${MOLECULES.find((m) => m.id === wl.molecule)?.label}${wl.cont ? " continuum" : ""})` : ""}`;
};
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
  if (reload && state.target) loadTarget(state.target);
}
ui.wlSeg.forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.wl === "range") { ui.rangeBox.hidden = false; ui.rangeBox.dataset.open = "1"; for (const x of ui.wlSeg) x.setAttribute("aria-checked", String(x === b)); updateRangeLabel(); }
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
      ui.band.value = r.det;
      setSlice(sliceForBand(r.det));
      setWavelengths({ kind: "range", lo: r.lo, hi: r.hi, molecule: m.id, cont }, { reload: true });
    });
    ui.molecules.append(b);
  }
}

async function loadRange(ac) {
  const { lo, hi } = state.wl;
  const t0 = Date.now();
  showProgress("Loading single channels…");
  try {
    const cube = await api.cube({ ra: state.base.ra, dec: state.base.dec, fov: state.base.fov, det: ui.band.value, perPass: true }, {
      preset: state.preset, signal: ac.signal, onProgress: (job) => showProgress(jobText(job, t0), job),
    });
    if (ac.signal.aborted) return null;
    rememberLams(cube);
    const r = framesFromCube(cube, lo, hi, state.base.frames);
    const lams = r.channels.map((c) => channelLam(ui.band.value, +c.slice(-2), state.lamTable));
    return { ...state.base, wcs: cube.wcs, frames: r.frames, matched: true, matched_channels: r.channels,
      lam_eff_um: lams.length ? lams.reduce((a, b) => a + b, 0) / lams.length : null,
      range: { lo, hi, skipped: r.skipped, suggest: r.frames.length < 2 ? suggestRange(cube, lo, hi) : null } };
  } catch (e) {
    if (e.name === "AbortError") return null;
    state.loadError = {
      tone: "error", title: "Single channels aren't available for this target right now.",
      why: e.code === "offline" ? "They need the live backend; offline, only WISE 0855 (D6) has per-pass channels baked in." : e.message,
      actions: [{ label: "Use the whole band", primary: true, onClick: () => setWavelengths({ kind: "detector" }, { reload: true }) }],
    };
    return state.base;
  } finally { hideProgress(); }
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
  const ac = state.extraAbort;
  const t0 = Date.now();
  showProgress("Loading the band's 17 channels…");
  try {
    const cube = await api.cube({ ra: state.base.ra, dec: state.base.dec, fov: state.base.fov, det: ui.band.value }, {
      preset: state.preset, signal: ac?.signal, onProgress: (job) => showProgress(jobText(job, t0), job),
    });
    if (state.cubeKey !== key) return;
    rememberLams(cube);
    cube.channels = cube.channels.filter((c) => Array.isArray(c.data));
    state.cube = cube;
    if (state.view === "colours") startColours();
  } catch (e) {
    if (e.name === "AbortError") return;
    state.cube = { error: {
      tone: "empty", title: "The channel-by-channel view isn't available here yet.",
      why: e.code === "offline" ? "It needs the live backend. Offline it is baked for Barnard's Star (D2), ε Indi B (D3), RW Aur (D2) and WISE 0855 (D3–D6)." : e.message,
      actions: [{ label: "Back to Play passes", primary: true, onClick: () => setView("blink") }],
    } };
    updateNotice();
    render();
  } finally { hideProgress(); }
}
function startColours() {
  const n = state.cube.channels.length;
  player.load(n, Math.min(state.colourIndex, n - 1));
  renderFilmstrip();
  updatePlayerUI();
  updateNotice();
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
  const keep = ["mock", "embed"].filter((k) => url.searchParams.has(k)).map((k) => [k, url.searchParams.get(k)]);
  url.search = "";
  for (const [k, v] of keep) url.searchParams.set(k, v);
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
async function loadTarget({ ra, dec, label, name = null, pm = null }) {
  state.jobAbort?.abort();
  state.extraAbort?.abort();
  const ac = new AbortController();
  state.jobAbort = ac;
  state.extraAbort = new AbortController();
  hideBanner();

  ra = ((ra % 360) + 360) % 360;
  const q = { ra: +ra.toFixed(6), dec: +dec.toFixed(6), fov: fovValue(), band: ui.band.value, matched: ui.matched.checked };
  const sameField = state.target && sepDeg(state.target.ra, state.target.dec, q.ra, q.dec) < 1e-6;
  state.target = { ra: q.ra, dec: q.dec, label: label || fmtDeg(q.ra, q.dec), name, pm };
  state.preset = nearestPreset(q.ra, q.dec)?.slug || null;
  writeURL();
  const title = `${state.target.label} · ${q.band}${q.matched ? " fair" : ""} · ${q.fov}°`;
  ui.showOnSky.hidden = state.mode === "explore";
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
    state.base = state.frames = null;
    state.events = [];
    ui.targetLabel.textContent = title;
    const other = Object.keys(DETECTORS).filter((d) => d !== q.band);
    if (e.code === "not_found") {
      const n = NOTICES.noCoverage(q.band);
      state.loadError = { ...n, why: `${e.message} ${n.why}${dataThrough ? ` Data through ${dataThrough}.` : ""}`,
        actions: other.map((d) => ({ label: `Try ${d}`, onClick: () => { ui.band.value = d; ui.band.dispatchEvent(new Event("change")); } })) };
    } else {
      state.loadError = { ...NOTICES.backendDown(e.message), actions: [
        { label: "Retry", primary: true, onClick: () => loadTarget(state.target) },
        { label: "Try Barnard's Star", onClick: () => choosePreset(PRESETS[0]) }] };
    }
    updateNotice(); renderEvents(); render(); renderTimeline();
    return;
  }
  if (ac.signal.aborted) return;
  hideProgress();
  state.loadError = null;

  state.base = frames;
  if (!sameField) { state.sources = null; state.movers = null; state.spectrum = null; state.pick = null; state.zoom = 1; applyZoom(); spectrumMessage("Click a star to see its spectrum"); }
  state.adv = {};
  state.cube = null; state.cubeKey = null;
  state.selected = null;
  let shown = frames;
  if (state.wl.kind === "range") shown = (await loadRange(ac)) || frames;
  if (ac.signal.aborted) return;
  state.frames = shown;
  ui.targetLabel.textContent = title;   // only now: until frames arrive the viewer still shows the previous target
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
  setView(state.view, { silent: true });
  collapseSearch();
  writeURL();

  // extras: Gaia overlay and the movers search (both feed the events)
  const extra = state.extraAbort;
  if (!state.sources) {
    api.overlay({ ra: q.ra, dec: q.dec, fov: q.fov }, { preset: state.preset, signal: extra.signal })
      .then((o) => { if (!extra.signal.aborted) { state.sources = o.sources; computeEvents(); render(); } })
      .catch(() => { state.sources = null; });
  }
  state.movers = null;
  state.variability = null;
  if (state.mode !== "explore" || state.preset) {
    api.lightcurve({ ra: q.ra, dec: q.dec, det: q.band }, { preset: state.preset, signal: extra.signal })
      .then((lc) => { if (!extra.signal.aborted) { state.variability = lc; state.adv.lightcurve = lc; computeEvents(); render(); } })
      .catch(() => { /* no light curve here: no variability claim */ });
  }
  api.movers({ ra: q.ra, dec: q.dec, fov: q.fov, band: q.band }, { preset: state.preset, signal: extra.signal })
    .then((m) => { if (!extra.signal.aborted) { state.movers = m; computeEvents(); render(); if (ui.advanced.open) refreshAdvanced(); } })
    .catch((e) => { if (e.name !== "AbortError") state.movers = { error: e.code === "offline" ? "The movers search needs the live backend for this position." : e.message }; });
  if (ui.advanced.open) loadAdvanced();
}

ui.cancel.addEventListener("click", () => {
  state.jobAbort?.abort();
  hideProgress();
  showBanner("Cancelled. The server keeps building this position in the background, so asking again later is faster.");
});

// ---- viewer first: after a search, fold the search panel into one line ----
function collapseSearch() {
  if (state.mode === "explore" || document.body.classList.contains("touring")) return;
  ui.searchSummaryText.replaceChildren(el("b", { text: state.target.label }), ` · ${fmtSexa(state.target.ra, state.target.dec)}`);
  ui.searchBody.hidden = true;
  ui.searchSummary.hidden = false;
}
function expandSearch() {
  ui.searchBody.hidden = false;
  ui.searchSummary.hidden = true;
}
ui.searchExpand.addEventListener("click", () => { expandSearch(); ui.tabs.find((t) => t.dataset.mode === state.mode)?.focus(); });

// ---- advanced drawer ----
function loadAdvanced() {
  if (!state.base) return;
  const q = { ra: state.base.ra, dec: state.base.dec };
  const signal = state.extraAbort?.signal;
  const opts = { preset: state.preset, signal };
  const get = (key, fn) => {
    if (state.adv[key]) return;
    state.adv[key] = "loading";
    fn().then((r) => { state.adv[key] = r; }).catch((e) => { if (e.name !== "AbortError") state.adv[key] = { error: e.code === "offline" ? "Needs the live backend for this position." : e.message }; })
      .finally(() => refreshAdvanced());
  };
  get("exposures", () => api.exposures({ ...q, fov: state.base.fov }, opts));
  const det = ui.band.value;
  const pm = state.target?.pm;
  get("motion", () => api.motion({ ...q, det, ...(pm ? { pmra: pm.pmra, pmdec: pm.pmdec, epoch: pm.epoch } : {}) }, opts));
  get("lightcurve", () => api.lightcurve({ ...q, det }, opts));
  refreshAdvanced();
}
function refreshAdvanced() {
  renderAdvanced(ui.advBody, {
    target: state.target, resp: state.frames, band: ui.band.value, matched: isMatched(),
    exposures: state.adv.exposures, motion: state.adv.motion, lightcurve: state.adv.lightcurve,
    movers: state.movers, events: state.events, spectrum: state.spectrum, threshold: THRESHOLD,
    fitsURL: fitsURL(), sexa: state.target ? fmtSexa(state.target.ra, state.target.dec) : "", pick: state.pick,
  });
}
ui.advanced.open = store.get(ADV_KEY) === "1";
ui.advanced.addEventListener("toggle", () => {
  store.set(ADV_KEY, ui.advanced.open ? "1" : "0");
  if (ui.advanced.open) loadAdvanced();
});

// ---- saving: image and movie ----
function composite(scale = 5) {
  const W = ui.image.width * scale, H = ui.image.height * scale;
  const c = document.createElement("canvas");
  c.width = W; c.height = H + 28;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(ui.image, 0, 0, W, H);
  ctx.drawImage(ui.overlay, 0, 0, W, H);
  ctx.fillStyle = "#e6eaf2"; ctx.font = "14px system-ui, sans-serif";
  ctx.fillText(`${ui.targetLabel.textContent} — ${ui.frameLabel.textContent} — SPHEREx (NASA/IPAC)`, 8, H + 19);
  return c;
}
ui.savePng.addEventListener("click", () => {
  if (!state.frames) return;
  const saved = state.zoom; state.zoom = 1; applyZoom(); render();
  composite().toBlob((b) => {
    const a = el("a", { href: URL.createObjectURL(b), download: `spherex-${state.preset || "field"}-${state.view}.png` });
    document.body.append(a); a.click(); a.remove();
    state.zoom = saved; applyZoom(); render();
  });
});
ui.saveMovie.addEventListener("click", async () => {
  if (!state.frames || typeof MediaRecorder === "undefined") {
    showNotice(ui.notice, { tone: "empty", title: "This browser can't record a movie.", why: "Use Save image, or a recent Chrome, Edge or Firefox." });
    return;
  }
  const view = state.view === "colours" && state.cube?.channels ? "colours" : "blink";
  if (state.view !== view) setView(view, { silent: true });
  const n = player.count, fps = +ui.speed.value;
  const wasPlaying = player.playing;
  if (player.playing) player.toggle();
  const canvas = composite(); const ctx = canvas.getContext("2d");
  const type = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(canvas.captureStream(fps), type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise((r) => { rec.onstop = r; });
  ui.saveMovie.disabled = true; ui.saveMovie.textContent = "Recording…";
  rec.start();
  for (let k = 0; k < n * 3; k++) {
    player.index = k % n; player.onFrame(k % n);
    ctx.drawImage(composite(), 0, 0);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  rec.stop(); await done;
  const ext = (type || "video/webm").includes("mp4") ? "mp4" : "webm";
  const a = el("a", { href: URL.createObjectURL(new Blob(chunks, { type: type || "video/webm" })), download: `spherex-${state.preset || "field"}.${ext}` });
  document.body.append(a); a.click(); a.remove();
  ui.saveMovie.disabled = false; ui.saveMovie.textContent = "Save movie";
  if (wasPlaying) { player.toggle(); updatePlayerUI(); }
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
  if (mode === "explore") { expandSearch(); ensureSky(); }
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
  if (r.name) r.name = r.name.replace(/^NAME\s+/, "");
  if (preset) r.name = preset.label;
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
  return searchName(p.name, { band: p.band });
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
  // a channel range belongs to one detector: changing the band goes back to the whole band
  if (state.wl.kind === "range") setWavelengths({ kind: "detector" });
  updateRangeLabel();
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
ui.views.forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
ui.play.addEventListener("click", () => { player.toggle(); updatePlayerUI(); });
ui.prev.addEventListener("click", () => player.step(-1));
ui.next.addEventListener("click", () => player.step(1));
ui.speed.addEventListener("input", () => player.setSpeed(+ui.speed.value));
for (const c of [ui.stretch, ui.cmap, ui.clip, ui.showOverlay, ui.showEvents]) c.addEventListener("input", () => { render(); if (state.view === "colours" && c !== ui.showOverlay && c !== ui.showEvents) renderFilmstrip(); });
ui.emptyPreset.addEventListener("click", () => choosePreset(PRESETS[0]));
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 100); });
document.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("touring") || ui.guide.open) return;
  if (e.target.matches("input, select, textarea, [role=tab], [role=radio]") || e.target.closest("#sky-wrap")) return;
  if (e.key === " " && !e.target.matches("button, a")) { e.preventDefault(); ui.play.click(); }
  if (e.key === "ArrowRight") player.step(1);
  if (e.key === "ArrowLeft") player.step(-1);
});

// ---- tour, field guide, glossary ----
const hooks = {
  presets: PRESETS, state, ui,
  choosePreset: (slug) => {
    const p = PRESETS.find((x) => x.slug === slug);
    const loaded = state.frames && state.preset === slug && ui.band.value === p.band;
    return loaded ? Promise.resolve() : choosePreset(p);
  },
  setView, setMode, expandSearch, selectEvent, zoomTo, measureSpectrum,
  setMatched: async (on) => { if (ui.matched.checked !== on) { ui.matched.checked = on; await loadTarget(state.target); } },
  setBand: async (band) => { if (ui.band.value !== band) { ui.band.value = band; setSlice(sliceForBand(band)); await loadTarget(state.target); } },
  play: (on) => { if (player.playing !== on) { player.toggle(); updatePlayerUI(); } },
  openAdvanced: (on) => { ui.advanced.open = on; },
  closeGuide: () => ui.guide.close(),
};
const runTour = () => { ui.tourOffer.hidden = true; ui.guide.open && ui.guide.close(); startTour(tourSteps(hooks)); };
ui.tourBtn.addEventListener("click", runTour);
ui.tourYes.addEventListener("click", runTour);
ui.tourNo.addEventListener("click", () => { ui.tourOffer.hidden = true; store.set("sse.tourDone", "1"); });
renderGuide(ui.guideCards, hooks);
ui.guideBtn.addEventListener("click", () => ui.guide.showModal());
ui.guideClose.addEventListener("click", () => ui.guide.close());
ui.guide.addEventListener("click", (e) => { if (e.target === ui.guide) ui.guide.close(); });
initGlossary();

// ---- start ----
let dataThrough = null;
fillSuggestions();
api.meta({ check: true }).then((m) => {
  dataThrough = m?.index?.data_through || null;
  if (dataThrough) ui.dataSpan.textContent = `SPHEREx data through ${dataThrough}.`;
  const last = store.get(SEEN_KEY);
  if (dataThrough && last && dataThrough > last) { ui.newData.hidden = false; ui.newData.textContent = `New SPHEREx data since your last visit (through ${dataThrough})`; }
  else if (m?.check?.new_releases?.length) { ui.newData.hidden = false; ui.newData.textContent = "A new SPHEREx release is out"; }
  if (dataThrough) store.set(SEEN_KEY, dataThrough);
});

const qp = new URLSearchParams(location.search);
if (qp.has("embed")) document.body.classList.add("embed");
if (qp.has("fov")) setFov(+qp.get("fov"));
if (qp.has("band") && DETECTORS[qp.get("band")]) ui.band.value = qp.get("band");
ui.matched.checked = qp.get("matched") !== "0";   // fair brightness comparison is the default
if (VIEWS.includes(qp.get("view"))) state.view = qp.get("view");
if (qp.has("a") && qp.has("b")) wantedAB = [qp.get("a"), qp.get("b")];
const ch = /^(\d+)-(\d+)$/.exec(qp.get("ch") || "");
if (ch) { const lo = Math.max(1, Math.min(N_CH, +ch[1])), hi = Math.max(lo, Math.min(N_CH, +ch[2])); ui.rangeBox.dataset.open = "1"; setWavelengths({ kind: "range", lo, hi }); }
updateRangeLabel();
for (const b of ui.views) b.setAttribute("aria-checked", String(b.dataset.view === state.view));
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
updatePlayerUI();
render();

if (qp.get("tour") === "1") runTour();
else if (!tourDone() && !qp.has("embed")) ui.tourOffer.hidden = false;
