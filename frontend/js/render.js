// Stretch, colormap and frame arithmetic on a canvas. Owner: C.
// The server sends raw floats; everything visual happens here, so controls are instant.

// Small colormap tables (5 stops each), linearly interpolated.
const CMAPS = {
  gray: [[0, 0, 0], [255, 255, 255]],
  inferno: [[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164]],
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  // Diverging map for difference images: blue = fainter, red = brighter.
  diverging: [[33, 102, 172], [247, 247, 247], [178, 24, 43]],
};

function lut(name) {
  const stops = CMAPS[name] || CMAPS.gray;
  const table = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(Math.floor(t), stops.length - 2);
    const f = t - k;
    for (let c = 0; c < 3; c++) table[i * 3 + c] = stops[k][c] + f * (stops[k + 1][c] - stops[k][c]);
  }
  return table;
}

function percentile(values, p) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))))];
}

/** Combine frames according to the display mode. Returns a flat array. */
export function composeFrame(frames, index, mode) {
  if (mode === "blink" || frames.length < 2) return frames[index].data;
  const a = frames[0].data;
  const b = frames[frames.length - 1].data;
  if (mode === "diff") return b.map((v, i) => (v === null || a[i] === null ? null : v - a[i]));
  // sum
  return a.map((_, i) => {
    let s = 0;
    for (const f of frames) {
      if (f.data[i] === null) return null;
      s += f.data[i];
    }
    return s;
  });
}

/**
 * Draw a flat float array to the canvas.
 * Limits come from `limitsFrom` (all frames) so brightness changes between epochs stay visible.
 */
export function draw(canvas, data, width, height, { stretch = "asinh", cmap = "gray", clip = 99.5, limitsFrom = data, diverging = false } = {}) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  const table = lut(diverging ? "diverging" : cmap);

  let lo, hi;
  if (diverging) {
    const m = Math.max(Math.abs(percentile(limitsFrom, 100 - clip)), Math.abs(percentile(limitsFrom, clip))) || 1;
    lo = -m; hi = m;
  } else {
    lo = percentile(limitsFrom, 100 - clip);
    hi = percentile(limitsFrom, clip);
    if (hi <= lo) hi = lo + 1;
  }
  const soft = 0.1; // asinh softening, as a fraction of the range
  const asinhNorm = Math.asinh(1 / soft);

  for (let i = 0; i < width * height; i++) {
    const v = data[i];
    const o = i * 4;
    if (v === null || !Number.isFinite(v)) { img.data[o + 3] = 0; continue; } // masked: transparent
    let t = (v - lo) / (hi - lo);
    t = Math.min(1, Math.max(0, t));
    if (stretch === "asinh" && !diverging) t = Math.asinh(t / soft) / asinhNorm;
    const k = Math.round(t * 255) * 3;
    img.data[o] = table[k];
    img.data[o + 1] = table[k + 1];
    img.data[o + 2] = table[k + 2];
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
