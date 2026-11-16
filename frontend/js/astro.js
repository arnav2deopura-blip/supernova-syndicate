// Coordinate conversions and derived physics for the Advanced drawer. Pure functions. Owner: C.
// Rule: never fabricate. Every function returns {value, ...} or {unknown: "why"}.

const D2R = Math.PI / 180;

// ICRS -> Galactic rotation (Hipparcos / Gaia convention)
const G = [
  [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669],
];
const vec = (ra, dec) => [Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)];
const sph = ([x, y, z]) => ({ lon: ((Math.atan2(y, x) / D2R) + 360) % 360, lat: Math.asin(Math.max(-1, Math.min(1, z))) / D2R });

export function galactic(ra, dec) {
  const v = vec(ra, dec);
  const r = sph(G.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]));
  return { l: r.lon, b: r.lat };
}

export function ecliptic(ra, dec) {
  const e = 23.4392911 * D2R;   // J2000 mean obliquity
  const [x, y, z] = vec(ra, dec);
  const r = sph([x, Math.cos(e) * y + Math.sin(e) * z, -Math.sin(e) * y + Math.cos(e) * z]);
  return { lon: r.lon, lat: r.lat };
}

/** d [pc] = 1000 / ϖ [mas], only when ϖ and σϖ are finite and positive and ϖ/σϖ > 5. */
export function distance(plx, plxErr, source) {
  if (plx == null || !Number.isFinite(plx)) return { unknown: "No parallax for this source (not in Gaia, or not fitted)." };
  if (plx <= 0) return { unknown: `Parallax ϖ = ${plx.toFixed(2)} mas (${source}) is not positive: no distance can be derived from it.` };
  if (plxErr == null || !Number.isFinite(plxErr)) return { unknown: `Parallax ϖ = ${plx.toFixed(2)} mas (${source}) but its error isn't reported, so the ϖ/σϖ > 5 reliability check can't be made.` };
  if (plxErr <= 0) return { unknown: `The parallax error (${plxErr}) is not positive, so the measurement can't be trusted.` };
  if (plx / plxErr <= 5) return { unknown: `ϖ/σϖ = ${(plx / plxErr).toFixed(1)} ≤ 5: too uncertain for a distance.` };
  return { value: 1000 / plx, err: (1000 / plx) * (plxErr / plx), source };
}

/** v_t [km/s] = 4.74 · μ [″/yr] · d [pc]. */
export function tangentialVelocity(pmMasYr, dist) {
  if (pmMasYr == null || !Number.isFinite(pmMasYr) || pmMasYr < 0) return { unknown: "No proper motion measured." };
  if (dist.unknown) return { unknown: `Needs a distance: ${dist.unknown}` };
  return { value: 4.74 * (pmMasYr / 1000) * dist.value };
}

/** m_AB = 23.9 − 2.5 log10(f / µJy). Only for a finite, positive flux. */
export const abMag = (fluxUJy) => (Number.isFinite(fluxUJy) && fluxUJy > 0 ? 23.9 - 2.5 * Math.log10(fluxUJy) : null);

/** H = m + 5 log10 μ[″/yr] + 5. */
export function reducedPM(mag, pmMasYr) {
  if (mag == null || !Number.isFinite(mag)) return { unknown: "No magnitude (no unsaturated spectrum points)." };
  if (!(pmMasYr > 0)) return { unknown: "No proper motion measured." };
  return { value: mag + 5 * Math.log10(pmMasYr / 1000) + 5 };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/**
 * Per-pass AB magnitude from the spectrum's usable points (median flux), and Δm between first and last pass.
 * Usable: unflagged, finite positive flux and finite positive error. `band` = {name, lo, hi} (µm) restricts the
 * points to one detector band, so every magnitude and Δm is stated in one wavelength band.
 */
export function passMagnitudes(points, band = null) {
  const inBand = (p) => !band || (p.wavelength_um >= band.lo && p.wavelength_um <= band.hi);
  const all = (points || []).filter(inBand);
  const good = all.filter((p) => !p.flagged && Number.isFinite(p.flux) && p.flux > 0 && Number.isFinite(p.flux_err) && p.flux_err > 0);
  if (!good.length) {
    return { unknown: !points?.length ? "Click the target to measure its spectrum first."
      : !all.length ? `No spectrum points in ${band?.name || "this band"}.`
      : "Every spectrum point is flagged (saturated) or has no positive flux and error: no reliable magnitude." };
  }
  const labels = [...new Set(good.map((p) => p.epoch_label))].sort((a, b) => +String(a).slice(1) - +String(b).slice(1));
  const per = labels.map((l) => {
    const f = median(good.filter((p) => p.epoch_label === l).map((p) => p.flux));
    return { epoch_label: l, flux: f, mag: abMag(f) };
  });
  const m = abMag(median(good.map((p) => p.flux)));
  return { value: m, per, dm: per.length > 1 && per.at(-1).mag != null && per[0].mag != null ? per.at(-1).mag - per[0].mag : null, band: band?.name || null };
}

// No colour temperature: a free-scale Planck fit has no validated uncertainty and brown dwarfs are not
// blackbodies, so it is not shown until both are established (FRONTEND_UPGRADE_PLAN item 6).

/** Standard normal upper tail, for the false-alarm estimate. */
function tail(z) {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804 * Math.exp(-z * z / 2);
  return d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}
/** Expected number of pure-noise pixels beyond ±thr σ in a field of n pixels. */
export const falseAlarms = (nPix, thr) => nPix * 2 * tail(thr);
