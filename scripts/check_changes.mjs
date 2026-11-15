// Run the browser change detector (frontend/js/changes.js) on the five precomputed presets.
//   node scripts/check_changes.mjs            summary per preset, plain and matched frames
//   node scripts/check_changes.mjs --inject   also inject fake point sources into one pass and check they are found
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findChanges } from "../frontend/js/changes.js";
import { skyToPixel } from "../frontend/js/overlays.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend");
const PRESETS = { "barnards-star": "D2", "eps-indi-b": "D3", "wise-0855": "D6", "rw-aur": "D2", "r-dra": "D2" };
const INJECT = process.argv.includes("--inject");

const bin = (p) => {
  const b = readFileSync(join(root, p));
  return Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4), (v) => (Number.isFinite(v) ? v : null));
};
function load(slug, band, matched) {
  const d = JSON.parse(readFileSync(join(root, "precomputed", slug, matched ? `frames_matched_${band}.json` : "frames.json")));
  for (const f of d.frames) { f.data = bin(f.data); f.noise = f.noise ? bin(f.noise) : null; }
  return d;
}
function brightStars(slug, wcs, label) {
  try {
    const o = JSON.parse(readFileSync(join(root, "precomputed", slug, "overlay.json")));
    return o.sources.filter((s) => s.mag != null && s.mag < 11).map((s) => {
      const p = s.positions_by_epoch.find((q) => q.epoch_label === label) || s;
      return skyToPixel(p.ra, p.dec, wcs);
    });
  } catch { return []; }
}
const count = (ev) => {
  const c = {};
  for (const e of ev) { const k = `${e.kind}${e.confidence === "low" ? "?" : ""}`; c[k] = (c[k] || 0) + 1; }
  return JSON.stringify(c);
};

let failures = 0;
for (const [slug, band] of Object.entries(PRESETS)) {
  for (const matched of [false, true]) {
    const d = load(slug, band, matched);
    const A = d.frames[0], B = d.frames.at(-1);
    const opts = { ...d.wcs, matched, brightStars: brightStars(slug, d.wcs, B.epoch_label) };
    const r = findChanges(A, B, opts);
    const hi = r.events.filter((e) => e.confidence === "high");
    console.log(`${slug.padEnd(14)} ${band} ${matched ? "matched" : "plain  "} ${A.epoch_label}→${B.epoch_label}  ${r.events.length} events, ${hi.length} high  ${count(r.events)}`);
    for (const e of r.events.slice(0, 4)) console.log(`    ${e.id} ${e.kind.padEnd(11)} ${e.confidence.padEnd(4)} σ=${e.sigma.toFixed(1)} at (${e.x.toFixed(1)},${e.y.toFixed(1)}) ${e.flags.join(",")}${e.rate_arcsec_yr ? ` ${e.rate_arcsec_yr.toFixed(1)}″/yr` : ""}`);

    if (INJECT && matched) {
      // fake sources: Gaussian PSF (peak 12σ) into B only, at empty spots: valid data in both passes,
      // nothing detected in A, and no existing change within 10 px
      const w = d.wcs.width, sPx = 7 / 2.355 / d.wcs.pixel_scale_arcsec;
      const empty = (cx, cy) => {
        for (let y = cy - 10; y <= cy + 10; y++) for (let x = cx - 10; x <= cx + 10; x++) {
          if (x < 0 || y < 0 || x >= w || y >= w) return false;
          const i = y * w + x;
          if (A.data[i] === null || B.data[i] === null || A.noise[i] == null) return false;
          const near = Math.abs(x - cx) <= 5 && Math.abs(y - cy) <= 5;
          if ((near && Math.abs(A.data[i] / A.noise[i]) > 3) || Math.abs(r.sigma[i] ?? 0) > 3) return false;
        }
        return true;
      };
      const spots = [];
      for (let cy = 12; cy < w - 12 && spots.length < 3; cy += 3) for (let cx = 12; cx < w - 12 && spots.length < 3; cx += 3) {
        if (empty(cx, cy) && spots.every(([x, y]) => Math.hypot(x - cx, y - cy) > 20)) spots.push([cx, cy]);
      }
      const B2 = { ...B, data: B.data.slice() };
      for (const [cx, cy] of spots) {
        for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 6; x <= cx + 6; x++) {
          const i = y * w + x;
          if (B2.data[i] === null) continue;
          const amp = 12 * Math.hypot(A.noise[i], B.noise[i]);
          B2.data[i] += amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sPx ** 2));
        }
      }
      const r2 = findChanges(A, B2, opts);
      const found = spots.filter(([cx, cy]) => r2.events.some((e) => (e.kind === "appeared" || e.kind === "brightened") && Math.hypot(e.x - cx - 0.5, e.y - cy - 0.5) < 3));
      console.log(`    inject: ${found.length}/${spots.length} recovered`);
      if (found.length < spots.length) for (const [cx, cy] of spots) console.log("      near", cx, cy, JSON.stringify(r2.events.filter((e) => Math.hypot(e.x - cx, e.y - cy) < 8).map((e) => [e.kind, e.confidence, +e.sigma.toFixed(1), +e.x.toFixed(1), +e.y.toFixed(1), e.flags])));
      if (found.length < spots.length) failures++;
    }
  }
}
process.exit(failures ? 1 : 0);
