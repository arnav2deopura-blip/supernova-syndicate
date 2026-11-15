// Free-explore sky map (Aladin Lite + the SPHEREx DR1 all-sky HiPS cube). Owner: C.
// Pan by dragging, zoom with the wheel/pinch. Click places a comparison box of the chosen FOV;
// Shift+drag (or "Draw box" then drag, for touch) draws one. The selection goes back through onSelect.
import { pixelToSky } from "./overlays.js";

const ALADIN_URL = "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js";
export const SPHEREX_HIPS = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube";
export const BACKGROUNDS = [
  { id: SPHEREX_HIPS, label: "SPHEREx DR1 (0.75–5 µm)", cube: true },
  { id: "CDS/P/allWISE/color", label: "AllWISE colour (3.4–22 µm)" },
  { id: "CDS/P/2MASS/color", label: "2MASS colour (1.2–2.2 µm)" },
  { id: "CDS/P/DSS2/color", label: "DSS2 colour (optical)" },
];
const N_SLICES = 102;
// Dichroic channels D3C17 and D4C01 are blank. Frame 0 (D1C01) has no "_0" tile on the server, and Aladin
// asks for "_0", so the slider starts at frame 1.
const BLANK_SLICES = new Set([50, 51]);
export const FIRST_SLICE = 1;
export const MAX_SIDE = 0.5;                   // backend FOV limit, degrees
const MIN_SIDE = 0.01;

/** Cube frame index (0-based) of a detector's middle channel: frame = 17*(band-1) + (channel-1). */
export const sliceForBand = (band) => 17 * (Number(String(band).slice(1)) - 1) + 8;
export const channelName = (i) => `D${Math.floor(i / 17) + 1}C${String((i % 17) + 1).padStart(2, "0")}`;

let loading;
function loadAladin() {
  // dist/aladin.js is an ES module whose default export is the `A` namespace
  loading ??= import(ALADIN_URL)
    .catch(() => { throw new Error("could not download Aladin Lite (offline?)"); })
    .then(async ({ default: A }) => {
      try { await A.init; } catch (e) { throw new Error(String(e?.message || e)); }  // e.g. no WebGL2
      return A;
    });
  loading.catch(() => { loading = undefined; });  // allow a retry
  return loading;
}

/** Wavelength (µm) of each cube frame, from the HiPS properties file. */
async function sliceWavelengths() {
  try {
    const txt = await (await fetch(`${SPHEREX_HIPS}/properties`)).text();
    const m = txt.match(/^data_cube_crval3_arr\s*=\s*(.+)$/m);
    const lam = m ? m[1].trim().split(/\s+/).map(Number) : [];
    return lam.length === N_SLICES ? lam : null;
  } catch { return null; }
}

/** Corners [ra, dec] of a north-up square of side `side` degrees centred on (ra, dec). */
export function squareCorners(ra, dec, side) {
  const wcs = { center_ra: ra, center_dec: dec, pixel_scale_arcsec: side * 3600, width: 1, height: 1 };
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => {
    const p = pixelToSky(x, y, wcs);
    return [p.ra, p.dec];
  });
}

function separationDeg(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180;
  const s = Math.sin(((dec2 - dec1) * r) / 2) ** 2
    + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(s)))) / r;
}

/**
 * Create the sky map inside `wrap` (which holds `#sky`).
 * callbacks: onSelect({ra, dec, side, clamped}), onCursor({ra, dec} | null), onPreset(slug), onView({fov})
 */
export async function createSky(wrap, { target, fov = 2, presets = [], onSelect, onCursor, onPreset, onView }) {
  const A = await loadAladin();
  const el = wrap.querySelector("#sky");
  const aladin = A.aladin(el, {
    survey: SPHEREX_HIPS, target: target || "269.446 +4.771", fov, cooFrame: "ICRS", projection: "SIN",
    showReticle: false, showCooGridControl: true, showLayersControl: false, showProjectionControl: false,
    showSimbadPointerControl: false, showFrame: false, showStatusBar: true, showContextMenu: false,
    showFullscreenControl: true, showZoomControl: true, showCooLocation: true, log: false,
  });

  // ---- presets: known interesting targets as a clickable catalogue
  const cat = A.catalog({ name: "Test targets", color: "#ffb547", sourceSize: 16, shape: "circle",
    displayLabel: true, labelColumn: "name", labelColor: "#ffb547", labelFont: "12px system-ui" });
  aladin.addCatalog(cat);
  cat.addSources(presets.map((p) => A.source(p.ra, p.dec, { name: p.label, slug: p.slug })));
  aladin.on("objectClicked", (obj) => {
    const slug = obj?.data?.slug;
    if (slug) onPreset?.(slug);
  });

  // ---- footprint of the current selection
  const overlay = A.graphicOverlay({ color: "#6cb4ff", lineWidth: 2 });
  aladin.addOverlay(overlay);
  let selection = null;
  function showFootprint(ra, dec, side) {
    overlay.removeAll();
    overlay.add(A.polygon(squareCorners(ra, dec, side)));
    selection = { ra, dec, side };
  }
  function select(ra, dec, side) {
    const clamped = side > MAX_SIDE;
    side = Math.min(MAX_SIDE, Math.max(MIN_SIDE, side));
    ra = ((ra % 360) + 360) % 360;
    showFootprint(ra, dec, side);
    onSelect?.({ ra, dec, side, clamped });
  }

  // ---- click = box of the chosen FOV; drags are pans and are ignored
  let sideForClick = 0.1;
  aladin.on("click", (e) => {
    if (!e || e.isDragging || drawArmed || e.ra === undefined) return;
    select(e.ra, e.dec, sideForClick);
  });
  aladin.on("mouseMove", (e) => onCursor?.(e && e.ra != null ? { ra: e.ra, dec: e.dec } : null));
  aladin.on("zoomChanged", () => onView?.({ fov: aladin.getFov()[0] }));

  // ---- Shift+drag (or armed "Draw box") draws a box. Capture-phase listeners on the wrapper run before
  // Aladin's own handlers, so the map doesn't pan while drawing.
  const band = document.createElement("div");
  band.className = "rubber-band";
  band.hidden = true;
  wrap.appendChild(band);
  let drawArmed = false, start = null;
  const local = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };

  wrap.addEventListener("pointerdown", (e) => {
    if (!(e.shiftKey || drawArmed) || !el.contains(e.target)) return;
    swallow(e);
    start = local(e);
    wrap.setPointerCapture(e.pointerId);
    Object.assign(band.style, { left: `${start.x}px`, top: `${start.y}px`, width: "0px", height: "0px" });
    band.hidden = false;
  }, true);
  wrap.addEventListener("pointermove", (e) => {
    if (!start) return;
    swallow(e);
    const p = local(e);
    Object.assign(band.style, {
      left: `${Math.min(p.x, start.x)}px`, top: `${Math.min(p.y, start.y)}px`,
      width: `${Math.abs(p.x - start.x)}px`, height: `${Math.abs(p.y - start.y)}px`,
    });
  }, true);
  const finish = (e) => {
    if (!start) return;
    swallow(e);
    const p = local(e), s = start;
    start = null;
    band.hidden = true;
    setDrawArmed(false);
    const mid = { x: (p.x + s.x) / 2, y: (p.y + s.y) / 2 };
    const c = aladin.pix2world(mid.x, mid.y, "icrs");
    if (!c) return;
    if (Math.hypot(p.x - s.x, p.y - s.y) < 6) return select(c[0], c[1], sideForClick);  // a tap, not a drag
    const span = (a, b) => {
      const wa = aladin.pix2world(a.x, a.y, "icrs"), wb = aladin.pix2world(b.x, b.y, "icrs");
      return wa && wb ? separationDeg(wa[0], wa[1], wb[0], wb[1]) : 0;
    };
    const side = Math.max(span({ x: s.x, y: mid.y }, { x: p.x, y: mid.y }), span({ x: mid.x, y: s.y }, { x: mid.x, y: p.y }));
    select(c[0], c[1], side);
  };
  wrap.addEventListener("pointerup", finish, true);
  wrap.addEventListener("pointercancel", () => { start = null; band.hidden = true; }, true);
  for (const t of ["mousedown", "mousemove", "mouseup", "click"]) {
    wrap.addEventListener(t, (e) => { if (start || (t === "mousedown" && (e.shiftKey || drawArmed))) swallow(e); }, true);
  }

  let onArm = () => {};
  function setDrawArmed(v) {
    drawArmed = v;
    wrap.classList.toggle("drawing", v);
    onArm(v);
  }

  const lambdas = await sliceWavelengths();
  let background = BACKGROUNDS[0];

  // Aladin turns a slice number into a wavelength linearly across [em_min, em_max], then picks the tile frame
  // floor((f - f_min) / (f_max - f_min) * depth) linearly in frequency. SPHEREx channels are spaced neither way,
  // so invert that: aim at the middle of frame i in frequency and convert back to Aladin's slice number.
  let wantedSlice = null, retry = null;
  function applySlice() {
    clearTimeout(retry);
    const layer = aladin.getBaseImageLayer();
    if (!background.cube || wantedSlice == null || !layer?.setSliceNumber) return;
    const { emMin, emMax, cubeDepth: n } = layer;
    if (!layer.added || !emMin || !emMax || !n) { retry = setTimeout(applySlice, 250); return; }  // still loading
    const C = 299792458, fMin = C / emMax, fMax = C / emMin;
    const f = fMin + ((wantedSlice + 0.5) / n) * (fMax - fMin);
    layer.setSliceNumber(((C / f - emMin) / (emMax - emMin)) * n);
  }

  return {
    aladin,
    lambdas,
    get selection() { return selection; },
    setClickSide(side) { sideForClick = side; },
    setDrawArmed, onDrawArmed(fn) { onArm = fn; },
    select, showFootprint,
    clearFootprint() { overlay.removeAll(); selection = null; },
    goto(ra, dec, viewFov) {
      aladin.gotoRaDec(ra, dec);
      if (viewFov) aladin.setFoV(viewFov);
    },
    /** The current view as a selection (centre + the visible width), clamped to the backend limit. */
    useCurrentView() {
      const [ra, dec] = aladin.getRaDec();
      const [w, h] = aladin.getFov();
      select(ra, dec, Math.min(w, h));
    },
    viewFov: () => Math.min(...aladin.getFov()),
    center: () => aladin.getRaDec(),
    setBackground(id) {
      background = BACKGROUNDS.find((b) => b.id === id) || BACKGROUNDS[0];
      aladin.setBaseImageLayer(background.id);
      applySlice();
      return background;
    },
    get isCube() { return !!background.cube; },
    setSlice(i) {
      wantedSlice = i;
      applySlice();
    },
    isBlankSlice: (i) => BLANK_SLICES.has(i),
    N_SLICES,
  };
}
