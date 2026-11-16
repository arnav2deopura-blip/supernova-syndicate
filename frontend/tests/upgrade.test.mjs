// Checks for FRONTEND_UPGRADE_PLAN items 2, 3, 6, 7, 9, 13, 17, 18 and the busy (429) path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, API_BASE, api, withTimeout, STALL_MS } from '../js/api.js';
import { framesFromCube, coveredRuns } from '../js/bands.js';
import { distance, passMagnitudes, abMag, tangentialVelocity } from '../js/astro.js';
import { findChanges } from '../js/changes.js';

const query = () => ({ ra: 269.4486, dec: 4.7394, fov: 0.04, band: 'D2', matched: true });
function frames() {
  return {
    ra: 269.4486, dec: 4.7394, fov: 0.04, band: 'D2', units: 'MJy/sr', matched: true, matched_channels: ['D2C01'],
    wcs: { width: 2, height: 2, center_ra: 269.4486, center_dec: 4.7394, pixel_scale_arcsec: 3.075 },
    frames: [
      { epoch_label: 'E1', width: 2, height: 2, mjd_start: 59999, mjd_end: 60001, mjd_mean: 60000, data: [2, 1, null, 4] },
      { epoch_label: 'E2', width: 2, height: 2, mjd_start: 60364, mjd_end: 60366, mjd_mean: 60365, data: [12, 3, null, 5] },
    ],
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failsWith = (code) => (e) => e instanceof ApiError && e.code === code;

function mockBrowser(t, handler, search = '') {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: new URL(`http://localhost:5500/${search}`) });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'location', original); else delete globalThis.location; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push(String(url)); return handler(String(url), options, calls.length); });
  return calls;
}

// ---- item 2: provenance and ?verify=1 ----
test('verify mode never reads saved data and shows an outage as an error', async (t) => {
  const calls = mockBrowser(t, (url) => (url.startsWith(API_BASE) ? json({ error: 'upstream_unavailable', message: 'down' }, 503) : json(frames())), '?verify=1');
  await assert.rejects(api.frames(query(), { preset: 'barnards-star' }), failsWith('upstream_unavailable'));
  assert.ok(calls.every((u) => !u.includes('precomputed/')), calls.join(' '));
  await assert.rejects(api.overlay({ ra: 1, dec: 1, fov: 0.1 }, { preset: 'barnards-star' }), failsWith('upstream_unavailable'));
  assert.ok(calls.every((u) => !u.includes('precomputed/')));
});

test('a cached answer and a newly built one are told apart', async (t) => {
  mockBrowser(t, () => json(frames()), '?fresh=1');
  const cached = await api.frames(query());
  assert.equal(cached._provenance.kind, 'live');
  assert.equal(cached._provenance.origin, 'server_cache');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const status = `${API_BASE}/api/jobs/j1`, result = `${API_BASE}/api/frames?x=1`;
  t.mock.method(globalThis, 'fetch', async (url) => {
    url = String(url);
    if (url.includes('async=1')) return json({ job_id: 'j1', state: 'running', stage: 'stamps', done: 3, total: 41, status_url: status }, 202);
    if (url === status) return json({ job_id: 'j1', state: 'done', stage: 'stamps', done: 41, total: 41, result: { result_url: result } });
    return json(frames());
  });
  const built = await api.frames(query(), { onProgress: () => queueMicrotask(() => t.mock.timers.tick(1000)) });
  assert.equal(built._provenance.origin, 'processed_now');
  assert.equal(built._provenance.job.files, 41);
});

// ---- item 17: malformed responses ----
test('an HTTP 200 with an empty object is unreadable, not an outage, for every endpoint', async (t) => {
  mockBrowser(t, () => json({}), '?fresh=1');
  await assert.rejects(api.frames(query()), failsWith('invalid_response'));
  await assert.rejects(api.cube({ ra: 1, dec: 1, fov: 0.1, det: 'D2' }), failsWith('invalid_response'));
  await assert.rejects(api.spectrum({ ra: 1, dec: 1, det: 'D2' }), failsWith('invalid_response'));
  await assert.rejects(api.overlay({ ra: 1, dec: 1, fov: 0.1 }), failsWith('invalid_response'));
  await assert.rejects(api.movers({ ra: 1, dec: 1, fov: 0.1, band: 'D2' }), failsWith('invalid_response'));
  await assert.rejects(api.exposures({ ra: 1, dec: 1, fov: 0.1 }), failsWith('invalid_response'));
  await assert.rejects(api.resolve('x'), failsWith('invalid_response'));
});

test('a binary image whose length does not match the grid is rejected before drawing', async (t) => {
  const r = frames();
  r.frames[0].data = `${API_BASE}/api/blob/a.bin`;
  const bin = (n) => new Response(new Float32Array(n).buffer);
  mockBrowser(t, (url) => (url.endsWith('.bin') ? bin(3) : json(r)), '?fresh=1');
  await assert.rejects(api.frames(query()), failsWith('invalid_response'));
});

test('a cube with a bad channel name or image size is rejected', async (t) => {
  const cube = { det: 'D2', fov: 0.1, ra: 1, dec: 1, wcs: { width: 2, height: 1, center_ra: 1, center_dec: 1, pixel_scale_arcsec: 3 },
    channels: [{ channel: 'D2C01', lam_um: 1.1, data: [1, 2] }] };
  mockBrowser(t, () => json(cube), '?fresh=1');
  assert.equal((await api.cube({ ra: 1, dec: 1, fov: 0.1, det: 'D2' })).channels.length, 1);
  cube.channels[0].channel = 'nonsense';
  await assert.rejects(api.cube({ ra: 1, dec: 1, fov: 0.1, det: 'D2' }), failsWith('invalid_response'));
  cube.channels[0].channel = 'D2C01'; cube.channels[0].data = [1, 2, 3];
  await assert.rejects(api.cube({ ra: 1, dec: 1, fov: 0.1, det: 'D2' }), failsWith('invalid_response'));
});

test('overlay sources without per-epoch positions get an empty list instead of crashing the drawing', async (t) => {
  mockBrowser(t, () => json({ sources: [{ id: 'a', ra: 1, dec: 2 }, { id: 'bad', ra: 'x', dec: 2 }] }), '?fresh=1');
  const o = await api.overlay({ ra: 1, dec: 1, fov: 0.1 });
  assert.equal(o.sources.length, 1);
  assert.deepEqual(o.sources[0].positions_by_epoch, []);
});

// ---- item 18: stalled jobs and timeouts ----
test('a job with no progress asks what to do, and fails when the answer is not "wait"', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const job = { job_id: 'j1', state: 'running', stage: 'stamps', done: 1, total: 10, status_url: `${API_BASE}/api/jobs/j1` };
  mockBrowser(t, () => json(job, 202), '?fresh=1');
  let asked = 0;
  const p = api.frames(query(), {
    onProgress: () => queueMicrotask(() => t.mock.timers.tick(5000)),
    onStall: async (j) => { asked++; assert.equal(j.job_id, 'j1'); return 'give up'; },
  });
  await assert.rejects(p, failsWith('stalled'));
  assert.equal(asked, 1);
});

test('the request timeout works without AbortSignal.any and clears its timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  const w = withTimeout(parent.signal, 1000);
  assert.equal(w.signal.aborted, false);
  t.mock.timers.tick(1000);
  assert.equal(w.signal.aborted, true);
  assert.equal(w.state.timedOut, true);
  const w2 = withTimeout(parent.signal, 1000);
  parent.abort();
  assert.equal(w2.signal.aborted, true);
  assert.equal(w2.state.timedOut, false);
  w.done(); w2.done();
  assert.ok(STALL_MS >= 60000);
});

// ---- item 13: a lost job is sent again once ----
test('a job the server forgot is submitted again once, with a message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s1 = `${API_BASE}/api/jobs/j1`, s2 = `${API_BASE}/api/jobs/j2`, result = `${API_BASE}/api/frames?r=1`;
  let submits = 0;
  mockBrowser(t, (url) => {
    if (url.includes('async=1')) { submits++; return json({ job_id: `j${submits}`, state: 'queued', status_url: submits === 1 ? s1 : s2 }, 202); }
    if (url === s1) return json({ error: 'not_found', message: 'Unknown or expired job.' }, 404);
    if (url === s2) return json({ job_id: 'j2', state: 'done', result: { result_url: result } });
    return json(frames());
  }, '?fresh=1');
  const seen = [];
  const r = await api.frames(query(), { onProgress: (j) => { seen.push(j.message || j.state); queueMicrotask(() => t.mock.timers.tick(1000)); } });
  assert.equal(submits, 2);
  assert.ok(seen.some((m) => /restarted/.test(m)));
  assert.equal(r.frames.length, 2);
});

test('a job lost twice fails with job_lost', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  mockBrowser(t, (url) => (url.includes('async=1') ? json({ job_id: 'j', state: 'queued', status_url: `${API_BASE}/api/jobs/j` }, 202) : json({ error: 'not_found' }, 404)), '?fresh=1');
  await assert.rejects(api.frames(query(), { onProgress: () => queueMicrotask(() => t.mock.timers.tick(1000)) }), failsWith('job_lost'));
});

// ---- busy server (item 12, client side) ----
test('a busy server (429) is retried after its delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  mockBrowser(t, () => (++n === 1 ? json({ error: 'busy', message: 'Busy', retry_after: 2, ahead: 4 }, 429) : json(frames())), '?fresh=1');
  const msgs = [];
  const r = await api.frames(query(), { onProgress: (j) => { msgs.push(j.message); queueMicrotask(() => t.mock.timers.tick(1000)); } });
  assert.equal(r._provenance.origin, 'server_cache');
  assert.ok(msgs.some((m) => /4 requests ahead/.test(m)));
});

// ---- items 3 and 9: channel ranges ----
const ch = (k, passes) => ({ channel: `D6C${String(k).padStart(2, '0')}`, frames: passes.map(([l, mjd, nexp, obs]) => ({ epoch_label: l, data: [1, 2, null, 4], n_exposures: nexp, mjd_mean: mjd, lam_target_um: 4.5 + k / 100, obs_ids: obs, target_flags: [] })) });

test('every requested channel is required: a gap is reported, never silently dropped', () => {
  const cube = { det: 'D6', wcs: { width: 2, height: 2 }, channels: [
    ch(8, [['E1', 60000, 1, ['a']], ['E2', 60200, 1, ['b']]]),
    ch(9, [['E2', 60201, 1, ['c']]]),
    ch(10, [['E1', 60001, 1, ['d']], ['E2', 60202, 1, ['e']]]),
  ] };
  const r = framesFromCube(cube, 8, 10);
  assert.deepEqual(r.missing.map((m) => [m.k, m.passes]), [[9, ['E1']]]);
  assert.deepEqual(r.frames.map((f) => f.epoch_label), ['E2']);
  assert.deepEqual(coveredRuns(cube, 8, 10), [{ lo: 8, hi: 8 }, { lo: 10, hi: 10 }]);
  // a channel with no data at all in the range is missing from every pass
  const r2 = framesFromCube({ ...cube, channels: cube.channels.filter((c) => c.channel !== 'D6C09') }, 8, 10);
  assert.deepEqual(r2.missing.map((m) => m.k), [9]);
  assert.equal(r2.frames.length, 0);
});

test('channel-range frames carry only the metadata of the channels averaged', () => {
  const cube = { det: 'D6', wcs: { width: 2, height: 2 }, channels: [
    ch(1, [['E1', 60000, 2, ['a', 'b']], ['E2', 60300, 1, ['c']]]),
    ch(2, [['E1', 60010, 1, ['d']], ['E2', 60310, 3, ['e', 'f', 'g']]]),
  ] };
  const base = [{ epoch_label: 'E1', mjd_start: 59000, mjd_end: 61000, n_exposures: 99, obs_ids: ['zzz'], flag_fraction: 0.9 }];
  const [e1] = framesFromCube(cube, 1, 2, base).frames;
  assert.deepEqual(e1.obs_ids, ['a', 'b', 'd']);
  assert.equal(e1.n_exposures, 3);
  assert.equal(e1.mjd_start, 60000);
  assert.equal(e1.mjd_end, 60010);
  assert.ok(Math.abs(e1.mjd_mean - (60000 * 2 + 60010) / 3) < 1e-9);
  assert.equal(e1.flag_fraction, 0.25);   // one of four pixels has no data
  assert.ok(e1.from_channels);
});

// ---- item 6: science inputs ----
test('distance needs a finite, positive parallax and error', () => {
  assert.ok(distance(-10, 1, 'Gaia').unknown);
  assert.ok(distance(-10, -1, 'Gaia').unknown, 'negative over negative is not a distance');
  assert.ok(distance(10, 0, 'Gaia').unknown);
  assert.ok(distance(NaN, 1, 'Gaia').unknown);
  assert.equal(distance(100, 1, 'Gaia').value, 10);
  assert.ok(tangentialVelocity(NaN, { value: 1 }).unknown);
});

test('magnitudes need positive flux and error, and stay within one named band', () => {
  assert.equal(abMag(-1), null);
  assert.equal(abMag(NaN), null);
  const pts = [
    { wavelength_um: 1.2, flux: 1000, flux_err: 10, epoch_label: 'E1', flagged: false },
    { wavelength_um: 1.3, flux: 1000, flux_err: 0, epoch_label: 'E1', flagged: false },
    { wavelength_um: 4.6, flux: 9, flux_err: 1, epoch_label: 'E2', flagged: false },
    { wavelength_um: 1.25, flux: 500, flux_err: 10, epoch_label: 'E2', flagged: false },
  ];
  const d2 = passMagnitudes(pts, { name: 'D2', lo: 1.1, hi: 1.65 });
  assert.equal(d2.band, 'D2');
  assert.deepEqual(d2.per.map((p) => p.epoch_label), ['E1', 'E2']);
  assert.ok(Math.abs(d2.dm - 2.5 * Math.log10(2)) < 1e-9);
  assert.ok(passMagnitudes(pts, { name: 'D1', lo: 0.75, hi: 1.09 }).unknown);
});

// ---- item 7: matching holds at the centre only ----
test('a brightness change far from the field centre is flagged off_centre and uncertain', () => {
  const W = 40, mk = (amp) => {
    const data = [], noise = [];
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { data.push(amp * Math.exp(-((x - 4) ** 2 + (y - 4) ** 2) / 2)); noise.push(1); }
    return { data, noise, mjd_mean: 60000 };
  };
  const opts = { width: W, height: W, pixel_scale_arcsec: 3.075, matched: true };
  const near = findChanges(mk(0), mk(60), opts);
  assert.ok(near.events.some((e) => e.confidence === 'high'));
  const far = findChanges(mk(0), mk(60), { ...opts, matchRadiusPx: 10 });
  assert.ok(far.events.length && far.events.every((e) => e.flags.includes('off_centre') && e.confidence === 'low'));
});
