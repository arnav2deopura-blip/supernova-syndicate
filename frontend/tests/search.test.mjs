import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoord, validateQuery, mjdDate } from '../js/coordinates.js';
import { ApiError, API_BASE, api, matchesSavedField, validateFrames } from '../js/api.js';

const query = () => ({ ra: 269.4486, dec: 4.7394, fov: 0.04, band: 'D2' });
function frames() {
  return {
    ...query(), units: 'MJy/sr', matched: true, matched_channels: ['D2C01'],
    wcs: { width: 2, height: 2, center_ra: 269.4486, center_dec: 4.7394, pixel_scale_arcsec: 3.075 },
    frames: [
      { epoch_label: 'E2', width: 2, height: 2, mjd_start: 60364, mjd_end: 60366, mjd_mean: 60365, data: [12, 3, null, 5] },
      { epoch_label: 'E1', width: 2, height: 2, mjd_start: 59999, mjd_end: 60001, mjd_mean: 60000, data: [2, 1, null, 4] },
    ],
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiFailure = (code) => (error) => error instanceof ApiError && error.code === code;

function mockBrowser(t, handler, search = '') {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: new URL(`http://localhost:5500/${search}`) });
  t.after(() => {
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete globalThis.location;
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    return handler(String(url), options, calls.length);
  });
  return calls;
}

test('decimal coordinates preserve valid limits, signs and fractional degrees', () => {
  for (const [input, isRA, expected] of [
    ['0', true, 0], ['359.999999', true, 359.999999], ['+12.5', true, 12.5],
    ['.5', true, 0.5], [' 269.4486 ', true, 269.4486],
    ['+90', false, 90], ['−90', false, -90], ['-.5', false, -0.5],
  ]) assert.equal(parseCoord(input, isRA), expected, `${input}, RA=${isRA}`);
  assert.ok(Object.is(parseCoord('-0', false), -0));
});

test('sexagesimal coordinates convert RA hours and preserve a negative-zero declination sign', () => {
  assert.equal(parseCoord('12:30:00', true), 187.5);
  assert.equal(parseCoord('12 30', true), 187.5);
  assert.ok(Math.abs(parseCoord('17h57m48s', true) - 269.45) < 1e-10);
  assert.equal(parseCoord('-00:30:00', false), -0.5);
  assert.equal(parseCoord('−00°30′00″', false), -0.5);
  assert.equal(parseCoord('+90:00:00', false), 90);
  assert.equal(parseCoord('-90:00:00', false), -90);
  assert.ok(parseCoord('23:59:59.999', true) < 360);
});

test('invalid ranges, components and ambiguous non-coordinate text are rejected', () => {
  const invalid = [
    ['360', true], ['-1', true], ['24:00:00', true], ['-00:30:00', true],
    ['12:60:00', true], ['12:59:60', true], ['12:-1:00', true],
    ['90.000001', false], ['-90:00:01', false], ['+90:00:01', false],
    ['01:60:00', false], ['1:2:3:4', false], ['1:2:NaN', false],
    ['', true], [' ', false], ['Infinity', false], ['NaN', true],
    [null, false], [undefined, true], ['269degrees', true], ['1e2', true],
  ];
  for (const [input, isRA] of invalid) assert.ok(Number.isNaN(parseCoord(input, isRA)), `${input}, RA=${isRA}`);
});

test('query validation accepts numeric FOV strings and rejects unsupported requests', () => {
  assert.deepEqual(validateQuery({ ...query(), fov: '0.04' }), query());
  for (const patch of [
    { ra: NaN }, { ra: 360 }, { ra: -0.1 }, { dec: 90.1 }, { dec: -90.1 },
    { dec: Infinity }, { fov: 0 }, { fov: -1 }, { fov: 0.50001 },
    { fov: 'abc' }, { fov: null }, { band: 'D7' }, { band: 'd2' }, { band: '' },
  ]) assert.throws(() => validateQuery({ ...query(), ...patch }), Error, JSON.stringify(patch));
});

test('MJD dates use UTC and unavailable values remain Unknown', () => {
  assert.equal(mjdDate(40587), '1970-01-01');
  assert.equal(mjdDate(0), '1858-11-17');
  for (const value of [null, undefined, NaN, Infinity, '60000']) assert.equal(mjdDate(value), 'Unknown');
});

test('saved observations must match center, band and field size, including across RA zero', () => {
  assert.equal(matchesSavedField(frames(), query()), true);
  for (const patch of [{ ra: 269.45 }, { dec: 4.75 }, { band: 'D6' }, { fov: 0.1 }]) {
    assert.equal(matchesSavedField(frames(), { ...query(), ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(matchesSavedField({ ...frames(), ra: 359.999999 }, { ...query(), ra: 0.000001 }), true);
  assert.equal(matchesSavedField({ ...frames(), ra: 0.000001 }, { ...query(), ra: 359.999999 }), true);
  assert.equal(matchesSavedField({ ...frames(), ra: null }, query()), false);
  assert.equal(matchesSavedField({ ...frames(), dec: NaN }, query()), false);
  assert.equal(matchesSavedField({ ...frames(), fov: undefined }, query()), false);
  assert.equal(matchesSavedField(frames(), { ra: '269.4486', dec: '4.7394' }), true);
});

test('frame validation requires usable images and sorts by observation time', () => {
  const response = frames();
  assert.equal(validateFrames(response), response);
  assert.deepEqual(response.frames.map((f) => f.epoch_label), ['E1', 'E2']);
  response.frames.forEach((frame) => { delete frame.mjd_mean; });
  response.frames.reverse();
  assert.deepEqual(validateFrames(response).frames.map((f) => f.epoch_label), ['E1', 'E2']);
  assert.throws(() => validateFrames({ ...frames(), frames: [] }), apiFailure('not_found'));
  const masked = frames(); masked.frames[0].data = [null, null, null, null];
  assert.throws(() => validateFrames(masked), apiFailure('not_found'));
});

test('frame validation rejects missing WCS, invalid image arrays and invalid time ranges', () => {
  for (const mutate of [
    (r) => { delete r.wcs; },
    (r) => { r.wcs.width = 0; },
    (r) => { r.wcs.height = 1.5; },
    (r) => { r.wcs.pixel_scale_arcsec = 0; },
    (r) => { r.wcs.center_ra = NaN; },
    (r) => { r.frames[0].data = 'missing.bin'; },
    (r) => { r.frames[0].data = [1]; },
    (r) => { r.frames[0].data[0] = '12'; },
    (r) => { r.frames[0].data[0] = Infinity; },
    (r) => { r.frames[0].data[0] = NaN; },
    (r) => { r.frames[0].width = 3; },
    (r) => { r.frames[0].mjd_start = null; },
    (r) => { r.frames[0].mjd_end = r.frames[0].mjd_start - 1; },
  ]) {
    const response = frames(); mutate(response);
    assert.throws(() => validateFrames(response), apiFailure('invalid_response'));
  }
});

test('malformed frame records and mean observation dates produce a readable API error', async (t) => {
  for (const [name, mutate] of [
    ['null frame', (r) => { r.frames[0] = null; }],
    ['NaN mean date', (r) => { r.frames[0].mjd_mean = NaN; }],
    ['infinite mean date', (r) => { r.frames[0].mjd_mean = Infinity; }],
    ['declination above north pole', (r) => { r.wcs.center_dec = 91; }],
    ['RA outside canonical range', (r) => { r.wcs.center_ra = 360; }],
  ]) await t.test(name, () => {
    const response = frames(); mutate(response);
    assert.throws(() => validateFrames(response), apiFailure('invalid_response'));
  });
});

test('saved frames use the requested matched-band file and decode little-endian maps', async (t) => {
  const response = frames();
  response.frames[0].data = 'precomputed/barnards-star/E2.bin';
  response.frames[0].noise = 'precomputed/barnards-star/E2_noise.bin';
  const encoded = (values) => {
    const buffer = new ArrayBuffer(values.length * 4);
    const view = new DataView(buffer);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    return new Response(buffer);
  };
  const calls = mockBrowser(t, (url) => {
    if (url.endsWith('/E2.bin')) return encoded([12, 3, NaN, 5]);
    if (url.endsWith('/E2_noise.bin')) return encoded([2, 2, NaN, 2]);
    assert.equal(url, 'precomputed/barnards-star/frames_matched_D2.json');
    return json(response);
  });
  const result = await api.frames(query(), { preset: 'barnards-star', savedOnly: true });
  assert.equal(result._provenance.kind, 'precomputed');
  assert.deepEqual(result.frames[1].data, [12, 3, null, 5]);
  assert.deepEqual(result.frames[1].noiseData, [2, 2, null, 2]);
  assert.equal(calls.length, 3);
});

test('saved mismatches fail explicitly and never substitute a demo field', async (t) => {
  const calls = mockBrowser(t, () => json({ ...frames(), fov: 0.1 }));
  await assert.rejects(api.frames(query(), { preset: 'barnards-star', savedOnly: true }), apiFailure('not_found'));
  assert.deepEqual(calls, ['precomputed/barnards-star/frames_matched_D2.json']);
  await assert.rejects(api.frames(query(), { preset: '../other', savedOnly: true }), apiFailure('not_found'));
  assert.equal(calls.length, 1);
});

test('jobs progress from queued to running to done before fetching the final images', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const statusUrl = `${API_BASE}/api/jobs/job-1`;
  const resultUrl = `${API_BASE}/api/frames?ra=269.4486&dec=4.7394&fov=0.04&band=D2&matched=1&async=0`;
  const calls = mockBrowser(t, (url, options, number) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (number === 1) {
      const initial = new URL(url);
      assert.equal(initial.searchParams.get('matched'), '1');
      assert.equal(initial.searchParams.get('async'), '1');
      return json({ job_id: 'job-1', state: 'queued', status_url: statusUrl }, 202);
    }
    if (number === 2) { assert.equal(url, statusUrl); return json({ job_id: 'job-1', state: 'running' }); }
    if (number === 3) { assert.equal(url, statusUrl); return json({ job_id: 'job-1', state: 'done', result: { result_url: resultUrl } }); }
    assert.equal(url, resultUrl);
    return json(frames());
  });
  const progress = [];
  const result = await api.frames(query(), { onProgress: (state) => {
    progress.push(state.state);
    queueMicrotask(() => t.mock.timers.tick(1000));
  } });
  assert.deepEqual(progress, ['queued', 'running', 'done']);
  assert.equal(calls.length, 4);
  assert.equal(result._provenance.kind, 'live');
});

test('a failed job and a missing completed result surface clear errors', async (t) => {
  let state = { job_id: 'job-1', state: 'error', error: 'not_found', message: 'No observations cover this position.' };
  mockBrowser(t, () => json(state, 202));
  await assert.rejects(api.frames(query()), (error) => apiFailure('not_found')(error) && /No observations/.test(error.message));
  state = { job_id: 'job-1', state: 'done', result: {} };
  await assert.rejects(api.frames(query()), apiFailure('invalid_response'));
});

test('a real not-found response does not fall back to unrelated saved observations', async (t) => {
  const calls = mockBrowser(t, () => json({ error: 'not_found', message: 'No data here.' }, 404));
  await assert.rejects(api.frames(query(), { preset: 'barnards-star' }), apiFailure('not_found'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(`${API_BASE}/api/frames?`));
});

test('an outage may use matching saved observations, while demo data is explicit', async (t) => {
  const calls = mockBrowser(t, (url) => url.startsWith(API_BASE)
    ? json({ error: 'upstream_unavailable', message: 'Archive is unavailable.' }, 503)
    : json(frames()));
  assert.equal((await api.frames(query(), { preset: 'barnards-star' }))._provenance.kind, 'precomputed');
  assert.equal(calls.length, 2);
  location.search = '?mock=1';
  const result = await api.frames(query());
  assert.equal(calls.at(-1), 'mock/frames.json');
  assert.equal(result._provenance.kind, 'mock');
});

test('an already cancelled search never starts a request', async (t) => {
  const calls = mockBrowser(t, () => { throw new Error('Fetch must not run'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.frames(query(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});
