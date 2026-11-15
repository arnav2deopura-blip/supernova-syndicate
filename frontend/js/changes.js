// "What changed?" between two passes, computed in the browser from the frames and their noise maps. Owner: C.
// Pure functions (no DOM), so they can be tested under node: see scripts/check_changes.mjs.
//
//   sigma = (B − A) / sqrt(σA² + σB²)       per pixel, using the calibrated noise maps (docs/API.md "Frame extras")
//   events = connected regions with |sigma| ≥ threshold, classified as
//     moved        a fading + brightening pair (a "dipole") closer than the largest plausible motion
//     appeared     brighter in B, and below 2σ in A           (green ○)
//     brightened   brighter in B, already detected in A       (green ○)
//     disappeared  fainter in B, and below 2σ in B            (red ✕)
//     faded        fainter in B, still detected in B          (red ✕)
//   confidence "low" when the region sits on a bright/saturated star (its residuals exceed the noise map),
//   touches a data gap, or the passes do not share a bandpass (matched wavelengths off).

export const PSF_ARCSEC = 7;
export const MAX_PM_ARCSEC_YR = 12;   // same default as /api/movers
export const SYS_FRAC = 0.1;          // systematic floor, fraction of the local brightness (see sigmaMap)

/**
 * Per-pixel significance of B − A. null where either pass has no data or no noise.
 * `sysFrac` adds a systematic floor proportional to the local brightness: the noise maps are background-only,
 * and on stars the PSF, sub-pixel registration and bandpass differences between two co-adds leave residuals of
 * a few % of the peak. Without the floor every bright star becomes a "change". 0 gives the pure noise-map σ.
 */
export function sigmaMap(A, B, sysFrac = 0) {
  const a = A.data, b = B.data, na = A.noise, nb = B.noise;
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === null || b[i] === null || !na || !nb || na[i] == null || nb[i] == null) { out[i] = null; continue; }
    const sys = sysFrac * Math.max(Math.abs(a[i]), Math.abs(b[i]));
    const s = Math.sqrt(na[i] ** 2 + nb[i] ** 2 + sys ** 2);
    out[i] = s > 0 ? (b[i] - a[i]) / s : null;
  }
  return out;
}

/** Median and MAD-based standard deviation of the finite values. */
export function robustStats(arr) {
  const v = arr.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { median: 0, std: 1 };
  const median = v[v.length >> 1];
  const dev = v.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  return { median, std: 1.4826 * dev[dev.length >> 1] || 1 };
}

/** Plain B − A (for the "Difference" view). */
export function diffMap(A, B) {
  return B.data.map((v, i) => (v === null || A.data[i] === null ? null : v - A.data[i]));
}

/** Connected regions (8-neighbour) of one sign above threshold. */
function regions(sig, w, h, sign, thr, minPix) {
  const seen = new Uint8Array(w * h), out = [];
  const hit = (i) => sig[i] !== null && sign * sig[i] >= thr;
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !hit(start)) continue;
    const stack = [start], pix = [];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      pix.push(i);
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && hit(j)) { seen[j] = 1; stack.push(j); }
      }
    }
    if (pix.length < minPix) continue;
    let sw = 0, sx = 0, sy = 0, peak = 0, peakI = pix[0];
    for (const i of pix) {
      const v = Math.abs(sig[i]);
      sw += v; sx += v * (i % w); sy += v * ((i / w) | 0);
      if (v > peak) { peak = v; peakI = i; }
    }
    out.push({ sign, x: sx / sw + 0.5, y: sy / sw + 0.5, npix: pix.length, peak_sigma: sign * peak, peak_index: peakI, pixels: pix });
  }
  return out;
}

/** Signal-to-noise of one pass at a pixel: mean of the 3×3 box over its noise. */
export function boxSNR(frame, i, w, h) {
  const x0 = i % w, y0 = (i / w) | 0;
  let s = 0, n2 = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = x0 + dx, y = y0 + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const j = y * w + x;
    if (frame.data[j] === null || !frame.noise || frame.noise[j] === null) continue;
    s += frame.data[j]; n2 += frame.noise[j] ** 2; n++;
  }
  return n ? (s / n) / (Math.sqrt(n2) / n) : null;
}

function touchesGap(pix, frames, w, h) {
  for (const i of pix) {
    const x0 = i % w, y0 = (i / w) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) return true;   // on the cutout edge
      if (frames.some((f) => f.data[y * w + x] === null)) return true;
    }
  }
  return false;
}

/**
 * Find changes between passes A and B.
 * opts: { width, height, pixel_scale_arcsec, threshold=5, matched=false, brightSNR=150, sysFrac=SYS_FRAC,
 *         brightStars: [{x, y}] pixel positions of bright catalogue stars (optional), dtYears }
 */
export function findChanges(A, B, opts) {
  const { width: w, height: h, pixel_scale_arcsec: ps, threshold = 5, matched = false, brightSNR = 150, brightStars = [], sysFrac = SYS_FRAC } = opts;
  const dtYears = opts.dtYears ?? Math.abs((B.mjd_mean ?? B.mjd_start) - (A.mjd_mean ?? A.mjd_start)) / 365.25;
  const sig = sigmaMap(A, B, sysFrac);
  // the sky background level differs a little between passes (zodiacal light), and the combined noise of two
  // co-adds is not always exactly unit: remove the median and widen (never narrow) to a unit robust scatter
  const { median, std } = robustStats(sig);
  const scale = Math.max(1, std);
  for (let i = 0; i < sig.length; i++) if (sig[i] !== null) sig[i] = (sig[i] - median) / scale;
  const minPix = 2;
  const pos = regions(sig, w, h, +1, threshold, minPix);
  const neg = regions(sig, w, h, -1, threshold, minPix);

  // a saturated core or a very bright star leaves residuals larger than the background-only noise map
  const psfPx = PSF_ARCSEC / ps;
  const nearBright = (r) => {
    const snrA = boxSNR(A, r.peak_index, w, h), snrB = boxSNR(B, r.peak_index, w, h);
    if (Math.max(snrA ?? 0, snrB ?? 0) > brightSNR) return true;
    return brightStars.some((s) => Math.hypot(s.x - r.x, s.y - r.y) < 3 * psfPx);
  };

  // pair dipoles: the faded region is where it was, the brightened one is where it went
  // the two lobes of a dipole sit about one PSF further apart than the shift itself
  const maxSepPx = (MAX_PM_ARCSEC_YR * dtYears + 2 * PSF_ARCSEC) / ps;
  const pairs = [];
  for (const n of neg) for (const p of pos) {
    const d = Math.hypot(p.x - n.x, p.y - n.y);
    if (d <= maxSepPx) pairs.push({ n, p, d });
  }
  pairs.sort((a, b) => a.d - b.d);
  const used = new Set(), events = [];
  for (const { n, p, d } of pairs) {
    if (used.has(n) || used.has(p)) continue;
    used.add(n); used.add(p);
    const bright = nearBright(n) || nearBright(p);
    const gap = touchesGap([...n.pixels, ...p.pixels], [A, B], w, h);
    events.push({
      kind: "moved",
      x: p.x, y: p.y, from: { x: n.x, y: n.y }, to: { x: p.x, y: p.y },
      shift_arcsec: d * ps,
      rate_arcsec_yr: dtYears > 0 ? (d * ps) / dtYears : null,
      sigma: Math.min(Math.abs(n.peak_sigma), p.peak_sigma),
      npix: n.npix + p.npix,
      snr_a: boxSNR(A, n.peak_index, w, h), snr_b: boxSNR(B, p.peak_index, w, h),
      flags: [...(bright ? ["bright_star"] : []), ...(gap ? ["data_gap"] : [])],
    });
  }
  for (const r of [...pos, ...neg]) {
    if (used.has(r)) continue;
    const snrA = boxSNR(A, r.peak_index, w, h), snrB = boxSNR(B, r.peak_index, w, h);
    let kind;
    if (r.sign > 0) kind = snrA !== null && snrA < 2 ? "appeared" : "brightened";
    else kind = snrB !== null && snrB < 2 ? "disappeared" : "faded";
    const bright = nearBright(r);
    const gap = touchesGap(r.pixels, [A, B], w, h);
    events.push({
      kind, x: r.x, y: r.y, sigma: Math.abs(r.peak_sigma), npix: r.npix, snr_a: snrA, snr_b: snrB,
      flags: [...(bright ? ["bright_star"] : []), ...(gap ? ["data_gap"] : [])],
    });
  }
  for (const e of events) {
    // a brightness change in plain (unmatched) frames can come from the bandpass moving between passes
    if (!matched && e.kind !== "moved" && !e.flags.includes("bandpass")) e.flags.push("bandpass");
    e.confidence = e.flags.length ? "low" : "high";
  }
  // high confidence first, then by significance
  events.sort((a, b) => (a.confidence === b.confidence ? b.sigma - a.sigma : a.confidence === "high" ? -1 : 1));
  events.forEach((e, i) => { e.id = `C${String(i + 1).padStart(2, "0")}`; });
  return { sigma: sig, events, threshold, dtYears, offset: median, scale };
}

/** What a beginner should read about each kind (also used for tooltips). */
export const KIND_INFO = {
  moved: { label: "Moved", shape: "→", text: "A fainter spot next to a brighter one: the source shifted between the two passes. A real mover shows up in every pass." },
  appeared: { label: "Appeared", shape: "○", text: "Something is in pass B that was not detected in pass A. With few passes this is most often an asteroid or an artefact: check it." },
  brightened: { label: "Brighter", shape: "○", text: "The source is brighter in pass B than in pass A." },
  disappeared: { label: "Gone", shape: "✕", text: "Something detected in pass A is missing in pass B. Often an asteroid that has moved on, or an artefact." },
  faded: { label: "Fainter", shape: "✕", text: "The source is fainter in pass B than in pass A." },
  candidate: { label: "Mover candidate", shape: "→", text: "Moves across every pass and no Gaia star follows it: the interesting kind (from the backend's movers search). Check it before reporting." },
  known_mover: { label: "Known mover", shape: "→", text: "Moves across the passes and matches a Gaia star with that proper motion: real, but already known." },
  variable: { label: "Variable star", shape: "◐", text: "The target's light curve (all exposures, corrected for the moving bandpass) changes more than its quiet comparison stars do: a real variable." },
  gaia_pm_mismatch: { label: "Moves oddly", shape: "→", text: "Matches a Gaia star, but moves differently from what Gaia says (by more than 5σ). Worth a closer look." },
};

export const FLAG_INFO = {
  bright_star: "On or next to a very bright or saturated star: its leftovers are bigger than the noise map, so this may be fake.",
  data_gap: "Touches a gap in the data or the edge of the cutout: “no data” is not the same as “not there”.",
  two_passes: "Seen in only two passes: a real mover should show up in every pass, so this needs a third pass to confirm.",
  bandpass: "Fair brightness comparison is off, so each pass sees slightly different wavelengths. A red star can look brighter just because of that.",
};

/**
 * Explain changes by things we already know move:
 *   known = [{ id, kind: "known_mover"|"candidate"|"gaia_pm_mismatch"|"unconfirmed_mover", from: {x,y}, to: {x,y},
 *              pm_mas_yr, source: "gaia"|"movers", gaia_id, track }]
 * (from = position in pass A, to = position in pass B, in frame pixels).
 * Every change event within ~2 PSF of a known mover's A or B position (or on the segment between) is absorbed
 * into one mover event, so Barnard's Star is one "known mover", not a pile of rings around a saturated star.
 * Movers-search candidates are kept even when the σ map shows nothing there (they can be faint).
 */
export function mergeKnown(events, known, { pixel_scale_arcsec: ps }) {
  const r = (2 * PSF_ARCSEC) / ps;
  const near = (e, m) => {
    const pts = e.from && e.to ? [e.from, e.to, e] : [e];
    return pts.some((p) => segDist(p, m.from, m.to) < r);
  };
  const out = [], absorbed = new Set();
  for (const m of known) {
    const hits = events.filter((e) => !absorbed.has(e) && near(e, m));
    if (!hits.length && m.source === "gaia") continue;   // a Gaia mover with no visible change: nothing to report
    hits.forEach((e) => absorbed.add(e));
    const unconfirmed = m.kind === "unconfirmed_mover";
    out.push({
      kind: m.kind === "unconfirmed_mover" ? "moved" : m.kind,
      x: m.to.x, y: m.to.y, from: m.from, to: m.to,
      sigma: hits.length ? Math.max(...hits.map((e) => e.sigma)) : (m.pm_sigma ?? 0),
      shift_arcsec: Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) * ps,
      pm_mas_yr: m.pm_mas_yr, known: m.gaia_id ? { gaia: m.gaia_id } : null, track: m.track || null,
      absorbed: hits.map((e) => e.kind),
      flags: unconfirmed ? ["two_passes"] : [],
      confidence: unconfirmed ? "low" : "high",
    });
  }
  const rest = events.filter((e) => !absorbed.has(e));
  const all = [...out, ...rest];
  const rank = (e) => (e.kind === "candidate" ? 0 : e.confidence === "high" ? 1 : 2);
  all.sort((a, b) => rank(a) - rank(b) || b.sigma - a.sigma);
  all.forEach((e, i) => { e.id = `C${String(i + 1).padStart(2, "0")}`; });
  return all;
}

/**
 * The target is a confirmed variable (from /api/lightcurve): absorb brightness events on it into one ◐ event.
 * lc: {variable, chi2_constant, dof, ...}; at: target pixel position.
 */
export function addVariable(events, lc, at, { pixel_scale_arcsec: ps }) {
  if (!lc || lc.variable !== true) return events;
  const r = (2 * PSF_ARCSEC) / ps;
  const hits = events.filter((e) => ["brightened", "faded", "appeared", "disappeared"].includes(e.kind) && Math.hypot(e.x - at.x, e.y - at.y) < r);
  const rest = events.filter((e) => !hits.includes(e));
  const v = {
    kind: "variable", x: at.x, y: at.y, sigma: hits.length ? Math.max(...hits.map((e) => e.sigma)) : 0,
    chi2_dof: lc.dof ? lc.chi2_constant / lc.dof : null, absorbed: hits.map((e) => e.kind), lightcurve: true,
    flags: [], confidence: "high",
  };
  const all = [v, ...rest];
  all.forEach((e, i) => { e.id = `C${String(i + 1).padStart(2, "0")}`; });
  return all;
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
