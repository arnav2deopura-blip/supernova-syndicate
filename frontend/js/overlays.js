// Gaia markers and proper-motion arrows. Owner: C.

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

// Marker colours: colour-blind-safe pairs (Okabe–Ito style), and every kind also has its own shape.
export const MARK = {
  brighter: "#2fd6a3",   // ○  appeared / brightened
  fainter: "#ff8b3d",    // ✕  disappeared / faded
  moved: "#ffd84d",      // →  moved (dipole) / known mover
  candidate: "#ff7ad9",  // →  mover candidate (not in Gaia)
  variable: "#b9a3ff",   // ◐  variable star (light curve)
  gaia: "rgba(108,180,255,0.5)",
  select: "#ffffff",
};
export const kindColour = (k) => (k === "appeared" || k === "brightened" ? MARK.brighter
  : k === "disappeared" || k === "faded" ? MARK.fainter
  : k === "candidate" || k === "gaia_pm_mismatch" ? MARK.candidate : k === "variable" ? MARK.variable : MARK.moved);

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

/** Gaia DR3 sources for the current epoch: small circles; fast movers (> pmThreshold) get their track. */
export function drawGaia(o, sources, wcs, epochLabel, { pmThreshold = 100 } = {}) {
  const { ctx, k, map } = o;
  ctx.lineWidth = 1 * k;
  ctx.setLineDash([]);
  for (const s of sources || []) {
    const pm = Math.hypot(s.pmra || 0, s.pmdec || 0);
    const moving = pm > pmThreshold;
    const here = s.positions_by_epoch.find((p) => p.epoch_label === epochLabel) || s;
    const c = map(skyToPixel(here.ra, here.dec, wcs));
    ctx.strokeStyle = moving ? "rgba(255,216,77,0.9)" : MARK.gaia;
    ctx.beginPath();
    ctx.arc(c.x, c.y, (moving ? 9 : 6) * k, 0, 2 * Math.PI);
    ctx.stroke();
    if (moving && s.positions_by_epoch.length > 1) {
      const first = map(skyToPixel(s.positions_by_epoch[0].ra, s.positions_by_epoch[0].dec, wcs));
      const last = s.positions_by_epoch.at(-1);
      ctx.setLineDash([2 * k, 3 * k]);
      arrow(ctx, first, map(skyToPixel(last.ra, last.dec, wcs)), 6 * k);
      ctx.setLineDash([]);
    }
  }
}

/** Change events: ○ brighter/new, ✕ fainter/gone, → moved. Dashed = low confidence. */
export function drawEvents(o, events, { selected = null } = {}) {
  const { ctx, k, map } = o;
  for (const e of events || []) {
    const sel = selected === e.id;
    const c = map(e);
    const r = (sel ? 14 : 11) * k;
    ctx.strokeStyle = kindColour(e.kind);
    ctx.lineWidth = (sel ? 3 : 2) * k;
    ctx.setLineDash(e.confidence === "low" ? [4 * k, 3 * k] : []);
    // dark halo first, so markers read on white stars too
    const strokeTwice = (fn) => {
      const col = ctx.strokeStyle, lw = ctx.lineWidth;
      ctx.strokeStyle = "rgba(0,0,0,0.65)"; ctx.lineWidth = lw + 2 * k; fn();
      ctx.strokeStyle = col; ctx.lineWidth = lw; fn();
    };
    if (e.from && e.to) {
      const a = map(e.from), b = map(e.to);
      strokeTwice(() => arrow(ctx, a, b, 8 * k));
      strokeTwice(() => { ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, 2 * Math.PI); ctx.stroke(); });
    } else if (e.kind === "variable") {
      strokeTwice(() => { ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 2 * Math.PI); ctx.stroke(); });
      ctx.fillStyle = kindColour(e.kind);
      ctx.beginPath(); ctx.arc(c.x, c.y, r, Math.PI / 2, (3 * Math.PI) / 2); ctx.closePath(); ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
    } else if (e.kind === "disappeared" || e.kind === "faded") {
      const d = r * 0.75;
      strokeTwice(() => {
        ctx.beginPath();
        ctx.moveTo(c.x - d, c.y - d); ctx.lineTo(c.x + d, c.y + d);
        ctx.moveTo(c.x + d, c.y - d); ctx.lineTo(c.x - d, c.y + d);
        ctx.stroke();
      });
    } else {
      strokeTwice(() => { ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 2 * Math.PI); ctx.stroke(); });
    }
    if (sel || events.length <= 12) {
      ctx.setLineDash([]);
      ctx.font = `${11 * k}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      const label = e.id;
      const tx = c.x + r + 3 * k, ty = c.y - r;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(tx - 2 * k, ty - 10 * k, tw + 4 * k, 13 * k);
      ctx.fillStyle = kindColour(e.kind);
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
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5 * k; ctx.setLineDash([]);
  ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(c.x + dx * 5 * k, c.y + dy * 5 * k); ctx.lineTo(c.x + dx * 12 * k, c.y + dy * 12 * k);
  }
  ctx.stroke();
}
