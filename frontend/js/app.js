// Wiring and URL state (?ra=&dec=&fov=&band=). Owner: C.
import { api, setFallbackHandler } from "./api.js";
import { Player } from "./player.js";
import { composeFrame, draw } from "./render.js";
import { drawOverlay, pixelToSky } from "./overlays.js";
import { drawSpectrum } from "./spectrum.js";

// The five challenge test targets. Coordinates are APPROXIMATE (J2000, from memory) and only
// a fallback: presets resolve by name first so proper motion is applied. [verify on SIMBAD]
const PRESETS = [
  { slug: "barnards-star", label: "Barnard's Star", name: "Barnard's Star", ra: 269.452, dec: 4.693, band: "D2" },
  { slug: "eps-indi-b", label: "ε Indi B", name: "eps Indi B", ra: 331.04, dec: -56.78, band: "D3" },
  { slug: "wise-0855", label: "WISE 0855−0714", name: "WISE J085510.83-071442.5", ra: 133.795, dec: -7.245, band: "D6" },
  { slug: "rw-aur", label: "RW Aur", name: "RW Aur", ra: 76.955, dec: 30.401, band: "D2" },
  { slug: "r-dra", label: "R Dra", name: "R Dra", ra: 248.167, dec: 66.75, band: "D2" },
];

const $ = (id) => document.getElementById(id);
const ui = {
  form: $("target-form"), name: $("name"), ra: $("ra"), dec: $("dec"), fov: $("fov"), band: $("band"),
  presets: $("presets"), image: $("image"), overlay: $("overlay"), play: $("play"), speed: $("speed"),
  frameLabel: $("frame-label"), mode: $("mode"), stretch: $("stretch"), cmap: $("cmap"), clip: $("clip"),
  showOverlay: $("show-overlay"), meta: document.querySelector("#meta tbody"), spectrum: $("spectrum"), banner: $("banner"),
};

const state = { frames: null, sources: null, preset: null, index: 0 };

setFallbackHandler((msg) => { ui.banner.textContent = msg; ui.banner.hidden = false; });

// ---- coordinate parsing: decimal degrees or sexagesimal ----
export function parseCoord(text, isRA) {
  const s = String(text).trim();
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.replace(/[hdms°'"]/g, " ").split(/[\s:]+/).filter(Boolean).map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return NaN;
  const sign = s.startsWith("-") ? -1 : 1;
  const [a, b, c = 0] = parts.map(Math.abs);
  const val = sign * (a + b / 60 + c / 3600);
  return isRA ? val * 15 : val;
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

// ---- loading ----
async function load({ ra, dec, fov, band }) {
  ui.banner.hidden = true;
  const q = { ra, dec, fov, band };
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  history.replaceState(null, "", url);

  try {
    state.frames = await api.frames(q, state.preset);
    renderMeta(state.frames.frames);
    player.load(state.frames.frames.length);
    api.overlay({ ra, dec, fov }, state.preset)
      .then((o) => { state.sources = o.sources; render(); })
      .catch(() => { state.sources = null; });
    drawSpectrum(ui.spectrum, []);
  } catch (e) {
    ui.banner.textContent = `Could not load: ${e.message}`;
    ui.banner.hidden = false;
  }
}

function loadFromInputs() {
  const ra = parseCoord(ui.ra.value, true);
  const dec = parseCoord(ui.dec.value, false);
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
    ui.banner.textContent = "Enter RA/Dec as decimal degrees or sexagesimal (17:57:48 +04:41:36).";
    ui.banner.hidden = false;
    return;
  }
  load({ ra: +ra.toFixed(6), dec: +dec.toFixed(6), fov: ui.fov.value, band: ui.band.value });
}

async function choosePreset(p) {
  state.preset = p.slug;
  ui.name.value = p.name;
  ui.band.value = p.band;
  let { ra, dec } = p;
  try {
    const r = await api.resolve(p.name);
    if (r.source !== "mock") ({ ra, dec } = r);
  } catch { /* fall back to approximate preset coords */ }
  ui.ra.value = ra; ui.dec.value = dec;
  loadFromInputs();
}

// ---- events ----
ui.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  state.preset = null;
  if (ui.name.value.trim() && !ui.ra.value.trim()) {
    try {
      const r = await api.resolve(ui.name.value.trim());
      ui.ra.value = r.ra; ui.dec.value = r.dec;
    } catch (err) {
      ui.banner.textContent = `Name not found: ${err.message}`;
      ui.banner.hidden = false;
      return;
    }
  }
  loadFromInputs();
});
ui.name.addEventListener("input", () => { ui.ra.required = ui.dec.required = !ui.name.value.trim(); });

for (const p of PRESETS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = p.label;
  b.addEventListener("click", () => choosePreset(p));
  ui.presets.appendChild(b);
}

ui.play.addEventListener("click", () => { ui.play.textContent = player.toggle() ? "Pause" : "Play"; });
ui.speed.addEventListener("input", () => player.setSpeed(+ui.speed.value));
for (const el of [ui.mode, ui.stretch, ui.cmap, ui.clip, ui.showOverlay]) el.addEventListener("input", render);
window.addEventListener("resize", render);
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select")) return;
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
  try {
    const s = await api.spectrum({ ra: ra.toFixed(6), dec: dec.toFixed(6) }, state.preset);
    drawSpectrum(ui.spectrum, s.points);
  } catch (err) {
    drawSpectrum(ui.spectrum, []);
  }
});

// ---- start: URL params, else first preset ----
const qp = new URLSearchParams(location.search);
if (qp.has("ra") && qp.has("dec")) {
  ui.ra.value = qp.get("ra");
  ui.dec.value = qp.get("dec");
  if (qp.has("fov")) ui.fov.value = qp.get("fov");
  if (qp.has("band")) ui.band.value = qp.get("band");
  loadFromInputs();
} else {
  choosePreset(PRESETS[0]);
}
