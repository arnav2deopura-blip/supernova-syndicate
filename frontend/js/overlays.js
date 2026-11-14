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

/**
 * Draw catalogue sources for the current epoch. Moving sources (PM > threshold)
 * get an arrow from their first-epoch to last-epoch position.
 */
export function drawOverlay(canvas, sources, wcs, epochLabel, { show = true, pmThreshold = 100 } = {}) {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!show || !sources) return;

  const sx = canvas.width / wcs.width, sy = canvas.height / wcs.height;
  const toCanvas = (p) => ({ x: p.x * sx, y: p.y * sy });
  ctx.lineWidth = 1.5 * devicePixelRatio;

  for (const s of sources) {
    const pm = Math.hypot(s.pmra || 0, s.pmdec || 0);
    const moving = pm > pmThreshold;
    const here = s.positions_by_epoch.find((p) => p.epoch_label === epochLabel) || s;
    const c = toCanvas(skyToPixel(here.ra, here.dec, wcs));
    ctx.strokeStyle = moving ? "#ff6b6b" : "rgba(108,180,255,0.8)";
    ctx.beginPath();
    ctx.arc(c.x, c.y, 8 * devicePixelRatio, 0, 2 * Math.PI);
    ctx.stroke();

    if (moving && s.positions_by_epoch.length > 1) {
      const first = toCanvas(skyToPixel(s.positions_by_epoch[0].ra, s.positions_by_epoch[0].dec, wcs));
      const last = s.positions_by_epoch.at(-1);
      const end = toCanvas(skyToPixel(last.ra, last.dec, wcs));
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      const ang = Math.atan2(end.y - first.y, end.x - first.x), h = 7 * devicePixelRatio;
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - h * Math.cos(ang - 0.4), end.y - h * Math.sin(ang - 0.4));
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - h * Math.cos(ang + 0.4), end.y - h * Math.sin(ang + 0.4));
      ctx.stroke();
    }
  }
}
