// The 102 SPHEREx channels made browsable: detector bands -> channel ranges -> molecule presets. Owner: C.
// Channels never cross a detector: D1 is channels 1–17, D2 is 18–34, … Each detector has its own noise, PSF
// and coverage, so a range that mixed two would show instrument differences as if they were sky changes.

export const DETECTORS = {
  D1: { lo: 0.75, hi: 1.09, colour: "#7aa2ff", name: "near-infrared, just past red light" },
  D2: { lo: 1.10, hi: 1.65, colour: "#6cd0ff", name: "near-infrared (J/H)" },
  D3: { lo: 1.64, hi: 2.42, colour: "#7ee787", name: "near-infrared (K)" },
  D4: { lo: 2.42, hi: 3.82, colour: "#f2cc60", name: "water-ice and PAH region" },
  D5: { lo: 3.82, hi: 4.42, colour: "#ffa657", name: "CO₂-ice region" },
  D6: { lo: 4.42, hi: 5.00, colour: "#ff7b72", name: "CO region, brown dwarfs glow here" },
};
export const N_CH = 17;

/**
 * Approximate channel centre (µm). SPHEREx channels have about constant resolving power, so they are evenly
 * spaced in log λ. Replaced by the real values from /api/cube when it has been loaded (`lamTable`).
 */
export function channelLam(det, k, lamTable) {
  const real = lamTable?.[`${det}C${String(k).padStart(2, "0")}`];
  if (real) return real;
  const { lo, hi } = DETECTORS[det];
  return lo * (hi / lo) ** ((k - 0.5) / N_CH);
}

export function channelAt(det, lam) {
  const { lo, hi } = DETECTORS[det];
  const k = Math.round((N_CH * Math.log(lam / lo)) / Math.log(hi / lo) + 0.5);
  return Math.min(N_CH, Math.max(1, k));
}

export const detectorFor = (lam) => Object.keys(DETECTORS).find((d) => lam >= DETECTORS[d].lo && lam < DETECTORS[d].hi) || null;
export const chName = (det, k) => `${det}C${String(k).padStart(2, "0")}`;

/** One-click wavelength presets for what SPHEREx is built to see; each has a neighbouring continuum range. */
export const MOLECULES = [
  { id: "h2o", label: "Water ice", lam: 3.05, cont: 2.65, text: "Icy grains in cold clouds absorb near 3.05 µm." },
  { id: "pah", label: "PAH / CH₄", lam: 3.3, cont: 3.62, text: "Organic molecules (PAHs) glow near 3.3 µm; methane in cool brown dwarfs absorbs here." },
  { id: "co2", label: "CO₂ ice", lam: 4.27, cont: 4.05, text: "Frozen carbon dioxide absorbs near 4.27 µm." },
  { id: "co", label: "CO", lam: 4.67, cont: 4.47, text: "Carbon monoxide absorbs near 4.67 µm (strong in brown dwarfs and young stars)." },
];

/** Channel range [lo, hi] centred on a wavelength (±1 channel), in the detector that holds it. */
export function rangeFor(lam) {
  const det = detectorFor(lam);
  const k = channelAt(det, lam);
  return { det, lo: Math.max(1, k - 1), hi: Math.min(N_CH, k + 1) };
}

/**
 * Per-pass images for a channel range, from /api/cube?per_pass=1: the mean of the chosen channels in each pass
 * (equal weight, like matched frames). Returns frames shaped like /api/frames (no noise maps).
 */
export function framesFromCube(cube, lo, hi, passFrames = []) {
  const det = cube.det;
  const chans = cube.channels.filter((c) => {
    const k = +c.channel.slice(-2);
    return c.channel.startsWith(det) && k >= lo && k <= hi && c.frames?.length;
  });
  const labels = [...new Set(chans.flatMap((c) => c.frames.map((f) => f.epoch_label)))].sort((a, b) => +a.slice(1) - +b.slice(1));
  const n = cube.wcs.width * cube.wcs.height;
  const frames = [];
  for (const label of labels) {
    const parts = chans.map((c) => c.frames.find((f) => f.epoch_label === label)).filter(Boolean);
    // a pass is only fair to compare when it has every chosen channel
    if (parts.length < chans.length) continue;
    const data = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, m = 0;
      for (const p of parts) { if (p.data[i] !== null) { s += p.data[i]; m++; } }
      data[i] = m === parts.length ? s / m : null;
    }
    const meta = passFrames.find((f) => f.epoch_label === label) || {};
    const mjds = parts.map((p) => p.mjd_mean).filter(Number.isFinite);
    const mjd = mjds.length ? mjds.reduce((a, b) => a + b, 0) / mjds.length : meta.mjd_mean;
    frames.push({
      epoch_label: label, data, noise: null, width: cube.wcs.width, height: cube.wcs.height,
      mjd_start: meta.mjd_start ?? mjd, mjd_end: meta.mjd_end ?? mjd, mjd_mean: mjd,
      n_exposures: parts.reduce((a, p) => a + (p.n_exposures || 0), 0),
      flag_fraction: meta.flag_fraction ?? null,
      lam_eff_um: parts.reduce((a, p) => a + (p.lam_target_um || 0), 0) / parts.length || null,
      target_flags: [...new Set(parts.flatMap((p) => p.target_flags || []))],
    });
  }
  const skipped = labels.length - frames.length;
  return { frames, channels: chans.map((c) => c.channel), skipped };
}

/** Passes that have every channel lo..hi of this per-pass cube. */
export function passesWith(cube, lo, hi) {
  let common = null;
  for (let k = lo; k <= hi; k++) {
    const ch = cube.channels.find((c) => c.channel === chName(cube.det, k));
    const labels = new Set((ch?.frames || []).map((f) => f.epoch_label));
    common = common ? new Set([...common].filter((l) => labels.has(l))) : labels;
  }
  return [...(common || [])].sort((a, b) => +a.slice(1) - +b.slice(1));
}

/** The nearest window of the same width that at least two passes fully cover, or null. */
export function suggestRange(cube, lo, hi) {
  const w = hi - lo;
  let best = null;
  for (let a = 1; a + w <= N_CH; a++) {
    const p = passesWith(cube, a, a + w);
    if (p.length < 2) continue;
    const d = Math.abs(a - lo);
    if (!best || d < best.d || (d === best.d && p.length > best.passes.length)) best = { lo: a, hi: a + w, passes: p, d };
  }
  return best;
}
