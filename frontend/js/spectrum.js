// Spectrum chart (plain canvas, no library). Owner: C.
// Drawn at the device pixel ratio and at the canvas's CSS width, so it stays sharp and fills its panel.
// Passes are an ordered series: a lightness ramp (oldest dimmest) plus a marker shape each, never hue.
// Flagged points (e.g. saturated) are hollow. Detector boundaries are faint vertical rules.
import { DETECTORS } from "./bands.js";
import { tok } from "./tokens.js";

const SHAPES = ["circle", "square", "triangle", "diamond", "down", "plus"];
const last = new WeakMap();   // canvas -> what was drawn, so a resize or a tab switch can redraw it

function setup(canvas, cssH = 220) {
  const dpr = (typeof devicePixelRatio === "number" && devicePixelRatio) || 1;
  const W = Math.max(200, Math.round(canvas.clientWidth || canvas.parentElement?.clientWidth || 360));
  const H = cssH;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return { ctx, W, H };
}

const FONT = '11px "IBM Plex Sans", system-ui, sans-serif';
const MONO = '11px "IBM Plex Mono", ui-monospace, monospace';

/** A one-line message in the chart area (empty state, loading, error). */
export function spectrumMessage(canvas, text) {
  last.set(canvas, { text });
  const { ctx, W, H } = setup(canvas);
  ctx.fillStyle = tok("--ink-3");
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.fillText(text, W / 2, H / 2);
  ctx.textAlign = "start";
  canvas.setAttribute("aria-label", `Spectrum: ${text}`);
}

/** Redraw whatever was last drawn (after the panel becomes visible or changes size). */
export function redrawSpectrum(canvas) {
  const s = last.get(canvas);
  if (!s) return;
  if (s.text != null) spectrumMessage(canvas, s.text);
  else drawSpectrum(canvas, s.points);
}

function niceStep(span, n = 4) {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}
const fmtNum = (v) => (Math.abs(v) >= 1e4 ? v.toExponential(1) : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1).replace(/\.0$/, "") : v.toPrecision(2)).replace("-", "−");

function mark(ctx, shape, x, y, r, hollow) {
  ctx.beginPath();
  if (shape === "circle") ctx.arc(x, y, r, 0, 2 * Math.PI);
  else if (shape === "square") ctx.rect(x - r, y - r, 2 * r, 2 * r);
  else if (shape === "triangle") { ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.1, y + r); ctx.lineTo(x - r * 1.1, y + r); ctx.closePath(); }
  else if (shape === "down") { ctx.moveTo(x, y + r * 1.2); ctx.lineTo(x + r * 1.1, y - r); ctx.lineTo(x - r * 1.1, y - r); ctx.closePath(); }
  else if (shape === "diamond") { ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x + r * 1.1, y); ctx.lineTo(x, y + r * 1.3); ctx.lineTo(x - r * 1.1, y); ctx.closePath(); }
  else { ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.lineWidth = 1.5; ctx.stroke(); return; }
  if (hollow) { ctx.lineWidth = 1.2; ctx.stroke(); } else ctx.fill();
}

/** Lightness ramp from --ink-3 (first pass) to --ink-1 (last). */
function ramp(i, n) {
  const a = hex(tok("--ink-3")), b = hex(tok("--ink-1"));
  const t = n > 1 ? i / (n - 1) : 1;
  return `rgb(${a.map((v, k) => Math.round(v + t * (b[k] - v))).join(",")})`;
}
function hex(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
  const n = m ? parseInt(m[1], 16) : 0x8a8a90;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function drawSpectrum(canvas, points) {
  const pts = (points || []).filter((p) => Number.isFinite(p.wavelength_um) && Number.isFinite(p.flux));
  if (!pts.length) { spectrumMessage(canvas, "Click a star in the image to measure its spectrum."); return; }
  last.set(canvas, { points });
  const { ctx, W, H } = setup(canvas);
  const pad = { l: 48, r: 12, t: 22, b: 30 };
  const ink2 = tok("--ink-2"), ink3 = tok("--ink-3"), line1 = tok("--line-1"), line2 = tok("--line-2");

  const xs = pts.map((p) => p.wavelength_um);
  // the flux scale comes from unflagged points when there are any: a saturated point must not squash the rest
  const scaled = pts.some((p) => !p.flagged) ? pts.filter((p) => !p.flagged) : pts;
  const lo = scaled.map((p) => p.flux - (Number.isFinite(p.flux_err) ? p.flux_err : 0));
  const hi = scaled.map((p) => p.flux + (Number.isFinite(p.flux_err) ? p.flux_err : 0));
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x1 - x0 < 0.05) { x0 -= 0.05; x1 += 0.05; }
  const xpad = (x1 - x0) * 0.03; x0 -= xpad; x1 += xpad;
  const y0 = Math.min(0, Math.min(...lo)), y1 = Math.max(...hi) * 1.06 || 1;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (y) => H - pad.b - ((y - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);

  // detector boundaries
  ctx.font = FONT;
  ctx.textAlign = "center";
  const dets = Object.entries(DETECTORS);
  dets.forEach(([name, d], i) => {
    if (i > 0 && d.lo > x0 && d.lo < x1) {
      ctx.strokeStyle = line2; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(X(d.lo)) + 0.5, pad.t); ctx.lineTo(Math.round(X(d.lo)) + 0.5, H - pad.b); ctx.stroke();
    }
    const cx = X((Math.max(d.lo, x0) + Math.min(d.hi, x1)) / 2);
    if (d.hi > x0 && d.lo < x1) { ctx.fillStyle = ink3; ctx.fillText(name, cx, pad.t - 8); }
  });

  // axes, ticks and labels
  ctx.strokeStyle = line2; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l + 0.5, pad.t); ctx.lineTo(pad.l + 0.5, H - pad.b + 0.5); ctx.lineTo(W - pad.r, H - pad.b + 0.5); ctx.stroke();
  ctx.font = MONO; ctx.fillStyle = ink3;
  const xs0 = niceStep(x1 - x0, Math.max(2, Math.floor((W - pad.l - pad.r) / 70)));
  for (let v = Math.ceil(x0 / xs0) * xs0; v <= x1 + 1e-9; v += xs0) {
    const x = Math.round(X(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, H - pad.b); ctx.lineTo(x, H - pad.b + 4); ctx.stroke();
    ctx.fillText(fmtNum(+v.toFixed(3)), x, H - pad.b + 15);
  }
  ctx.textAlign = "right";
  const ys = niceStep(y1 - y0, 4);
  for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + 1e-9; v += ys) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = line1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(fmtNum(+v.toPrecision(6)), pad.l - 6, y + 4);
  }
  ctx.textAlign = "start";
  ctx.font = FONT; ctx.fillStyle = ink2;
  ctx.fillText("µJy", 6, pad.t - 8);
  ctx.textAlign = "right";
  ctx.fillText("wavelength (µm)", W - pad.r, H - 3);
  ctx.textAlign = "start";

  // points by pass: error bars, then marks (clipped to the plot area)
  ctx.save();
  ctx.beginPath(); ctx.rect(pad.l, pad.t - 4, W - pad.l - pad.r + 4, H - pad.t - pad.b + 8); ctx.clip();
  const epochs = [...new Set(pts.map((p) => p.epoch_label))].sort((a, b) => +String(a).slice(1) - +String(b).slice(1));
  epochs.forEach((e, i) => {
    const col = ramp(i, epochs.length), shape = SHAPES[i % SHAPES.length];
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
    for (const p of pts) {
      if (p.epoch_label !== e || !Number.isFinite(p.flux_err) || p.flux_err <= 0) continue;
      const x = Math.round(X(p.wavelength_um)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, Y(p.flux - p.flux_err)); ctx.lineTo(x, Y(p.flux + p.flux_err)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const p of pts) if (p.epoch_label === e) mark(ctx, shape, X(p.wavelength_um), Y(p.flux), 2.6, !!p.flagged);
  });
  ctx.restore();

  // legend: shape per pass, and what hollow means
  ctx.font = FONT;
  let lx = pad.l + 8;
  const ly = pad.t + 10;
  epochs.forEach((e, i) => {
    const col = ramp(i, epochs.length);
    ctx.fillStyle = col; ctx.strokeStyle = col;
    mark(ctx, SHAPES[i % SHAPES.length], lx + 3, ly - 4, 3, false);
    ctx.fillStyle = ink2;
    ctx.fillText(String(e), lx + 10, ly);
    lx += ctx.measureText(String(e)).width + 22;
  });
  if (pts.some((p) => p.flagged)) {
    ctx.strokeStyle = ink2; mark(ctx, "circle", lx + 3, ly - 4, 3, true);
    ctx.fillStyle = ink3; ctx.fillText("flagged (e.g. saturated)", lx + 10, ly);
  }
  const nFlag = pts.filter((p) => p.flagged).length;
  canvas.setAttribute("aria-label", `Spectrum: ${pts.length} points from ${Math.min(...xs).toFixed(2)} to ${Math.max(...xs).toFixed(2)} µm in passes ${epochs.join(", ")}${nFlag ? `, ${nFlag} flagged` : ""}. Download the CSV in Details for the values.`);
}
