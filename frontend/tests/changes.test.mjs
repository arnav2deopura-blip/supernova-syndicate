import test from 'node:test';
import assert from 'node:assert/strict';
import { findChanges, mergeKnown, addVariable, robustStats, sigmaMap } from '../js/changes.js';
import { galactic, distance, falseAlarms } from '../js/astro.js';
import { framesFromCube, suggestRange } from '../js/bands.js';

const W = 40, PS = 3.075;
// deterministic noise so the tests never flake
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
function field(seed, stars = []) {
  const r = rng(seed), data = [], noise = [];
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    let v = gauss(r);
    for (const [sx, sy, amp] of stars) v += amp * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * 1.0 ** 2));
    data.push(v); noise.push(1);
  }
  return { data, noise, mjd_mean: 60000, epoch_label: 'E1' };
}
const opts = { width: W, height: W, pixel_scale_arcsec: PS, matched: true };

test('pure noise gives no events', () => {
  const r = findChanges(field(1), { ...field(2), mjd_mean: 60365, epoch_label: 'E2' }, opts);
  assert.equal(r.events.length, 0);
  const { median, std } = robustStats(r.sigma);
  assert.ok(Math.abs(median) < 0.1 && std <= 1.05);
});

test('a source present only in pass B is found as "appeared"', () => {
  const B = { ...field(2, [[10, 30, 15]]), mjd_mean: 60365, epoch_label: 'E2' };
  const r = findChanges(field(1), B, opts);
  const hit = r.events.find((e) => Math.hypot(e.x - 10.5, e.y - 30.5) < 2);
  assert.equal(hit?.kind, 'appeared');
  assert.equal(hit.confidence, 'high');
});

test('a star that shifts becomes one "moved" event, not two', () => {
  const A = field(1, [[20, 20, 40]]);
  const B = { ...field(2, [[20, 24, 40]]), mjd_mean: 60365, epoch_label: 'E2' };
  const r = findChanges(A, B, opts);
  const moved = r.events.filter((e) => e.kind === 'moved');
  assert.equal(moved.length, 1);
  assert.ok(moved[0].to.y > moved[0].from.y, 'arrow points from the old to the new position');
  assert.ok(!r.events.some((e) => e.kind === 'appeared' || e.kind === 'disappeared'));
});

test('a background offset between passes is not a change', () => {
  const B = field(2); B.data = B.data.map((v) => v + 3); B.mjd_mean = 60365;
  assert.equal(findChanges(field(1), B, opts).events.length, 0);
});

test('unmatched brightness changes are flagged as low confidence', () => {
  const A = field(1, [[20, 20, 40]]), B = { ...field(2, [[20, 20, 200]]), mjd_mean: 60365 };   // 5× brighter: well above the 10 % floor
  const e = findChanges(A, B, { ...opts, matched: false }).events.find((x) => x.kind === 'brightened');
  assert.ok(e.flags.includes('bandpass'));
  assert.equal(e.confidence, 'low');
});

test('missing noise maps give no σ (null), never a guessed value', () => {
  const A = field(1), B = field(2); B.noise = null;
  assert.ok(sigmaMap(A, B).every((v) => v === null));
});

test('known movers absorb the change regions on their track', () => {
  const events = [{ kind: 'faded', x: 10, y: 10, sigma: 9, flags: [] }, { kind: 'brightened', x: 10, y: 14, sigma: 9, flags: [] }, { kind: 'appeared', x: 35, y: 35, sigma: 6, flags: [] }];
  const out = mergeKnown(events, [{ kind: 'known_mover', source: 'gaia', gaia_id: 'Gaia DR3 1', pm_mas_yr: 10000, from: { x: 10, y: 10 }, to: { x: 10, y: 14 } }], opts);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'known_mover');
  assert.deepEqual(out[0].absorbed.sort(), ['brightened', 'faded']);
  assert.deepEqual(out.map((e) => e.id), ['C01', 'C02']);
});

test('a light-curve variable only replaces brightness events on the target', () => {
  const events = [{ kind: 'brightened', x: 20, y: 20, sigma: 8, flags: [] }, { kind: 'appeared', x: 3, y: 3, sigma: 6, flags: [] }];
  assert.equal(addVariable(events, { variable: null }, { x: 20, y: 20 }, opts).length, 2);
  const out = addVariable(events, { variable: true, chi2_constant: 76, dof: 2 }, { x: 20, y: 20 }, opts);
  assert.deepEqual(out.map((e) => e.kind), ['variable', 'appeared']);
  assert.equal(out[0].chi2_dof, 38);
});

test('channel ranges keep only passes that have every chosen channel, and suggest a covered range', () => {
  const ch = (k, labels) => ({ channel: `D6C${String(k).padStart(2, '0')}`, frames: labels.map((l) => ({ epoch_label: l, data: [1, 2, null, 4], n_exposures: 1, mjd_mean: 60000 })) });
  const cube = { det: 'D6', wcs: { width: 2, height: 2 }, channels: [ch(1, ['E1', 'E2']), ch(2, ['E1', 'E2']), ch(3, ['E2'])] };
  const r = framesFromCube(cube, 2, 3);
  assert.deepEqual(r.frames.map((f) => f.epoch_label), ['E2']);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.frames[0].data, [1, 2, null, 4]);
  assert.deepEqual(suggestRange(cube, 2, 3), { lo: 1, hi: 2, passes: ['E1', 'E2'], d: 1 });
});

test('astro helpers: galactic centre, the parallax rule, false alarms', () => {
  const g = galactic(266.40499, -28.93617);
  assert.ok(Math.abs(g.b) < 0.01 && (g.l < 0.01 || g.l > 359.99));
  assert.ok(distance(547, null, 'Gaia').unknown, 'no σϖ, no distance');
  assert.ok(distance(10, 5, 'Gaia').unknown, 'ϖ/σϖ ≤ 5, no distance');
  assert.equal(distance(500, 1, 'Gaia').value, 2);
  assert.ok(falseAlarms(117 * 117, 5) < 0.01);
});


test('a wholly absent requested channel cannot become a narrower comparison',()=>{
 const cube={det:'D6',wcs:{width:1,height:1},channels:[{channel:'D6C01',frames:[{epoch_label:'E1',data:[1],mjd_mean:60000}]}]};
 const result=framesFromCube(cube,1,2);
 assert.deepEqual(result.frames,[]);assert.deepEqual(result.missing,['D6C02']);
});

test('negative parallax and zero or invalid errors do not yield distances',()=>{
 for(const pair of [[-10,-1],[10,0],[Infinity,1],[10,NaN]]) assert.ok(distance(...pair).unknown);
});

test('selected-channel metadata comes from contributing cells, not unrelated base frames',()=>{
 const cube={det:'D6',wcs:{width:1,height:1},channels:[{channel:'D6C01',frames:[{epoch_label:'E1',data:[1],mjd_mean:61000,mjd_start:60999,mjd_end:61001,n_exposures:1,obs_ids:['actual']}]}]};
 const result=framesFromCube(cube,1,1,[{epoch_label:'E1',mjd_start:50000,mjd_end:70000,flag_fraction:.9}]);
 assert.equal(result.frames[0].mjd_start,60999);assert.equal(result.frames[0].flag_fraction,0);assert.deepEqual(result.frames[0].obs_ids,['actual']);
});
