// Gaia markers and proper-motion arrows. Owner: C.
import { tok, alpha } from "./tokens.js";

const D2R = Math.PI / 180;

/** Sky -> pixel on the frame grid (gnomonic projection, north up, east left, row 0 = top). */
export function skyToPixel(ra, dec, wcs) {
  const a0 = wcs.center_ra * D2R, d0 = wcs.center_dec * D2R;
  const a = ra * D2R, d = dec * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  const scale = wcs.pixel_scale_arcsec / 3600 * D2R;
  return { x: wcs.width / 2 - xi / scale, y: wcs.height / 2 - eta / scale };
}

/** Pixel -> sky (inverse of skyToPixel). */
export function pixelToSky(x, y, wcs) {
  const scale = wcs.pixel_scale_arcsec / 3600 * D2R;
  const xi = -(x - wcs.width / 2) * scale;
  const eta = -(y - wcs.height / 2) * scale;
  const a0 = wcs.center_ra * D2R, d0 = wcs.center_dec * D2R;
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return { ra: wcs.center_ra, dec: wcs.center_dec };
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(d0) + (eta * Math.sin(c) * Math.cos(d0)) / rho);
  const ra = a0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
  return { ra: ((ra / D2R) % 360 + 360) % 360, dec: dec / D2R };
}

// Marker colours: the Okabe–Ito palette (distinct under the common colour-vision deficiencies), and every kind
// also has its own shape. Warm = brighter, cool = fainter, matching the σ map (red = brighter).
export const MARK = {
  brighter: "#E69F00",   // ○  appeared / brightened (orange)
  fainter: "#56B4E9",    // ✕  disappeared / faded (sky blue)
  moved: "#F0E442",      // →  moved (dipole) / known mover (yellow)
  candidate: "#CC79A7",  // ◇→ mover candidate, not in Gaia (reddish purple)
  variable: "#009E73",   // ◐  variable star (bluish green)
  select: "#FFFFFF",
};
export const kindColour = (k) => (k === "appeared" || k === "brightened" ? MARK.brighter
  : k === "disappeared" || k === "faded" ? MARK.fainter
  : k === "candidate" || k === "gaia_pm_mismatch" ? MARK.candidate : k === "variable" ? MARK.variable : MARK.moved);
const CASING = "rgba(0,0,0,0.6)";

/** Size the overlay canvas to its CSS box (ignoring zoom transforms) and return a context + pixel mapper. */
export function prepareOverlay(canvas, wcs, zoom = 1) {
  const w = canvas.offsetWidth || canvas.getBoundingClientRect().width;
  const h = canvas.offsetHeight || canvas.getBoundingClientRect().height;
  const k = devicePixelRatio * zoom;
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sx = canvas.width / wcs.width, sy = canvas.height / wcs.height;
  return { ctx, k: devicePixelRatio, map: (p) => ({ x: p.x * sx, y: p.y * sy }) };
}

function arrow(ctx, a, b, head) {
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
  ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
  ctx.stroke();
}

/** Gaia DR3 sources for the current epoch: quiet 1 px rings (reference stars); fast movers (> pmThreshold) get
 * their track as a dotted line. Deliberately low-key so the change markers lead. */
export function drawGaia(o, sources, wcs, epochLabel, { pmThreshold = 100 } = {}) {
  const { ctx, k, map } = o;
  ctx.lineWidth = 1 * k;
  ctx.setLineDash([]);
  const quiet = alpha(tok("--ink-2"), 0.45), mover = alpha(tok("--ink-1"), 0.7);
  for (const s of sources || []) {
    const pm = Math.hypot(s.pmra || 0, s.pmdec || 0);
    const moving = pm > pmThreshold;
    const pos = s.positions_by_epoch || [];
    const here = pos.find((p) => p.epoch_label === epochLabel) || s;
    const c = map(skyToPixel(here.ra, here.dec, wcs));
    ctx.strokeStyle = moving ? mover : quiet;
    ctx.beginPath();
    ctx.arc(c.x, c.y, (moving ? 8 : 5) * k, 0, 2 * Math.PI);
    ctx.stroke();
    if (moving && pos.length > 1) {
      const first = map(skyToPixel(pos[0].ra, pos[0].dec, wcs));
      const last = pos.at(-1);
      ctx.setLineDash([2 * k, 3 * k]);
      arrow(ctx, first, map(skyToPixel(last.ra, last.dec, wcs)), 5 * k);
      ctx.setLineDash([]);
    }
  }
}

/**
 * Change events: ○ brighter/new, ✕ fainter/gone, → moved, ◇→ candidate, ◐ variable. Dashed = low confidence.
 * Every mark is drawn over a 3 px black casing so it survives a bright stellar halo. Selected: a 2 px white ring.
 */
export function drawEvents(o, events, { selected = null } = {}) {
  const { ctx, k, map } = o;
  for (const e of events || []) {
    const sel = selected === e.id;
    const c = map(e);
    const r = 10 * k;
    const col = kindColour(e.kind);
    const dash = e.confidence === "low" ? [4 * k, 3 * k] : [];
    // casing first, then the coloured stroke
    const cased = (fn, lw = 2) => {
      ctx.setLineDash(dash);
      ctx.strokeStyle = CASING; ctx.lineWidth = (lw + 3) * k; fn();
      ctx.strokeStyle = col; ctx.lineWidth = lw * k; fn();
    };
    const ring = (p, rad) => () => { ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 2 * Math.PI); ctx.stroke(); };
    const diamond = (p, rad) => () => { ctx.beginPath(); ctx.moveTo(p.x, p.y - rad); ctx.lineTo(p.x + rad, p.y); ctx.lineTo(p.x, p.y + rad); ctx.lineTo(p.x - rad, p.y); ctx.closePath(); ctx.stroke(); };
    let at = c;
    if (e.from && e.to) {
      const a = map(e.from), b = map(e.to);
      at = b;
      cased(() => arrow(ctx, a, b, 7 * k));
      const cand = e.kind === "candidate" || e.kind === "gaia_pm_mismatch";
      if (cand) cased(diamond(b, r * 1.15));
    } else if (e.kind === "variable") {
      cased(ring(c, r));
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, Math.PI / 2, (3 * Math.PI) / 2); ctx.closePath(); ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
    } else if (e.kind === "disappeared" || e.kind === "faded") {
      const d = r * 0.75;
      cased(() => {
        ctx.beginPath();
        ctx.moveTo(c.x - d, c.y - d); ctx.lineTo(c.x + d, c.y + d);
        ctx.moveTo(c.x + d, c.y - d); ctx.lineTo(c.x - d, c.y + d);
        ctx.stroke();
      });
    } else if (e.kind === "candidate" || e.kind === "gaia_pm_mismatch") {
      cased(diamond(c, r * 1.15));
    } else {
      cased(ring(c, r));
    }
    ctx.setLineDash([]);
    if (sel) {
      ctx.strokeStyle = CASING; ctx.lineWidth = 5 * k; ring(at, r + 5 * k)();
      ctx.strokeStyle = MARK.select; ctx.lineWidth = 2 * k; ring(at, r + 5 * k)();
    }
    if (sel || events.length <= 12) {
      ctx.font = `500 ${11 * k}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      const label = e.id;
      const tx = at.x + r + 4 * k, ty = at.y - r;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(tx - 2 * k, ty - 10 * k, tw + 4 * k, 13 * k);
      ctx.fillStyle = col;
      ctx.fillText(label, tx, ty);
    }
  }
  ctx.setLineDash([]);
}

/** A crosshair where the spectrum was last measured. */
export function drawPick(o, p) {
  if (!p) return;
  const { ctx, k, map } = o;
  const c = map(p);
  ctx.setLineDash([]);
  const cross = () => {
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(c.x + dx * 5 * k, c.y + dy * 5 * k); ctx.lineTo(c.x + dx * 12 * k, c.y + dy * 12 * k);
    }
    ctx.stroke();
  };
  ctx.strokeStyle = CASING; ctx.lineWidth = 4 * k; cross();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5 * k; cross();
}
