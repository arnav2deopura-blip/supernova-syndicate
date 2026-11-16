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

/** d [pc] = 1000 / ϖ [mas], only when ϖ/σϖ > 5. */
export function distance(plx, plxErr, source) {
  if (!Number.isFinite(plx) || plx <= 0) return { unknown: "No parallax for this source (not in Gaia, or not fitted)." };
  if (!Number.isFinite(plxErr) || plxErr <= 0) return { unknown: `Parallax ϖ = ${plx.toFixed(2)} mas (${source}) but its error isn't reported, so the ϖ/σϖ > 5 reliability check can't be made.` };
  if (plx / plxErr <= 5) return { unknown: `ϖ/σϖ = ${(plx / plxErr).toFixed(1)} ≤ 5: too uncertain for a distance.` };
  return { value: 1000 / plx, err: (1000 / plx) * (plxErr / plx), source };
}

/** v_t [km/s] = 4.74 · μ [″/yr] · d [pc]. */
export function tangentialVelocity(pmMasYr, dist) {
  if (!Number.isFinite(pmMasYr) || pmMasYr < 0) return { unknown: "No proper motion measured." };
  if (!dist || (!dist.unknown && (!Number.isFinite(dist.value) || dist.value <= 0))) return {unknown:"A valid positive distance is required."};
  if (dist.unknown) return { unknown: `Needs a distance: ${dist.unknown}` };
  return { value: 4.74 * (pmMasYr / 1000) * dist.value };
}

/** m_AB = 23.9 − 2.5 log10(f / µJy). */
export const abMag = (fluxUJy) => (Number.isFinite(fluxUJy) && fluxUJy > 0 ? 23.9 - 2.5 * Math.log10(fluxUJy) : null);

/** H = m + 5 log10 μ[″/yr] + 5. */
export function reducedPM(mag, pmMasYr) {
  if (!Number.isFinite(mag)) return { unknown: "No magnitude (no unsaturated spectrum points)." };
  if (!Number.isFinite(pmMasYr) || !(pmMasYr > 0)) return { unknown: "No proper motion measured." };
  return { value: mag + 5 * Math.log10(pmMasYr / 1000) + 5 };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/** Per-pass AB magnitude from the spectrum's unflagged points (median flux), and Δm between first and last pass. */
export function passMagnitudes(points) {
  // Arbitrary spectral samples are not a defined photometric bandpass.
  const good=(points || []).filter(p=>p.flagged===false && Number.isFinite(p.flux) && p.flux>0 && Number.isFinite(p.flux_err) && p.flux_err>0 && p.channel);
  if (!good.length) return {unknown:'No unflagged, positive flux with a valid uncertainty and channel.'};
  const labels=[...new Set(good.map(p=>p.epoch_label))].sort((a,b)=>+a.slice(1)-+b.slice(1));
  const perChannels=labels.map(l=>new Set(good.filter(p=>p.epoch_label===l).map(p=>p.channel)));
  const shared=[...perChannels[0]].filter(c=>perChannels.every(s=>s.has(c)));
  if (shared.length !== 1) return {unknown:'A single shared spectral channel is required; mixed-wavelength spectra are not broadband magnitudes.'};
  const per=labels.map(l=>({epoch_label:l,flux:median(good.filter(p=>p.epoch_label===l && p.channel===shared[0]).map(p=>p.flux))})).map(p=>({...p,mag:abMag(p.flux)}));
  return {value:median(per.map(p=>p.mag)),per,dm:per.length>1?per.at(-1).mag-per[0].mag:null,channel:shared[0]};
}

/** Rough colour temperature: Planck fit (free scale) to the spectrum, grid in log T. */
export function blackbodyT(points) {
  return {unknown:'Temperature estimation is withheld until the spectral model, uncertainties and epoch matching are validated.'};
}

/** Standard normal upper tail, for the false-alarm estimate. */
function tail(z) {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804 * Math.exp(-z * z / 2);
  return d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}
/** Expected number of pure-noise pixels beyond ±thr σ in a field of n pixels. */
export const falseAlarms = (nPix, thr) => nPix * 2 * tail(thr);
