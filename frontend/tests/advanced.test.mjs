import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAdvanced } from '../js/advanced.js';

function response() {
  return {
    units: 'MJy/sr', matched: true, matched_channels: ['D2C01'],
    wcs: { width: 2, height: 1, pixel_scale_arcsec: 3.075 },
    frames: [
      { epoch_label: 'E1', width: 2, height: 1, mjd_mean: 60000, mjd_start: 59999, mjd_end: 60001, data: [2, null], noiseData: [3, 3], noise_scale: 2, n_exposures: 4, lam_eff_um: 1.3, target_flags: [] },
      { epoch_label: 'E2', width: 2, height: 1, mjd_mean: 60365.25, mjd_start: 60364, mjd_end: 60366, data: [12, 1], noiseData: [4, 4], noise_scale: 3, n_exposures: 5, lam_eff_um: 1.31, target_flags: ['OVERFLOW'] },
    ],
  };
}

test('empty, null and absent values remain unknown rather than becoming zero', () => {
  const d = deriveAdvanced();
  for (const key of ['baselineDays', 'coverage', 'scale', 'pixelDelta', 'pixelPull', 'spectrumSnr', 'totalPm', 'targetFlags', 'exposureCount', 'astrometryRms']) assert.equal(d[key], null, key);
  const r = response();
  r.frames.forEach((frame) => { frame.mjd_mean = null; frame.mjd_start = null; frame.mjd_end = null; });
  assert.equal(deriveAdvanced({frames: r}).baselineDays, null);
});

test('difference uses chronological epochs and already calibrated maps exactly once', () => {
  const r = response();
  r.frames.reverse();
  const d = deriveAdvanced({frames: r, source: 'precomputed', selectedPixel: {x: 0, y: 0}});
  assert.equal(d.baselineDays, 365.25);
  assert.equal(d.pixelDelta, 10);
  assert.equal(d.pixelError, 5);
  assert.equal(d.pixelPull, 2);
  assert.equal(d.pairLabel, 'E2 − E1');
  assert.equal(d.coverage, 0.75);
  assert.equal(d.exposureCount, 9);
  assert.equal(d.resampling, 2);
  assert.deepEqual(d.targetFlags, ['OVERFLOW']);
});

test('masked pixels, out-of-bounds selections and mismatched arrays withhold differences', () => {
  assert.equal(deriveAdvanced({frames: response(), selectedPixel: {index: 1}}).pixelDelta, null);
  assert.equal(deriveAdvanced({frames: response(), selectedPixel: {x: 2, y: 0}}).pixelDelta, null);
  const r = response();
  r.frames[1].data = [12];
  assert.equal(deriveAdvanced({frames: r, selectedPixel: {index: 0}}).pixelDelta, null);
  assert.equal(deriveAdvanced({frames: r}).coverage, null);
});

test('noise ratio requires actual loaded maps, calibration, matching, units and real data', () => {
  const mutations = [
    (r) => { r.frames[0].noiseData = 'missing.bin'; },
    (r) => { r.frames[0].noise_scale = null; },
    (r) => { r.frames[0].noiseData = [3]; },
    (r) => { r.frames[0].noiseData[0] = 0; },
    (r) => { r.units = null; },
    (r) => { r.units = 'uJy'; },
    (r) => { r.matched = false; },
    (r) => { r.matched_channels = []; },
  ];
  for (const mutate of mutations) {
    const r = response(); mutate(r);
    assert.equal(deriveAdvanced({frames: r, source: 'live', selectedPixel: {index: 0}}).pixelPull, null);
  }
  assert.equal(deriveAdvanced({frames: response(), source: 'mock', selectedPixel: {index: 0}}).pixelPull, null);
  assert.equal(deriveAdvanced({frames: response(), selectedPixel: {index: 0}}).pixelPull, null);
});

test('spectral SNR excludes flagged, failed, missing and nonpositive-error measurements', () => {
  const spectrum = {points: [
    {flux: 12, flux_err: 3, flagged: false},
    {flux: -4, flux_err: 2, flagged: false},
    {flux: 1000, flux_err: 1, flagged: true},
    {flux: 1000, flux_err: 1, flagged: false, fit: 'failed'},
    {flux: 1000, flux_err: 0, flagged: false},
    {flux: null, flux_err: 1, flagged: false},
  ]};
  const d = deriveAdvanced({spectrum});
  assert.equal(d.usableSpectrumCount, 2);
  assert.equal(d.spectrumSnr, 1);
});

test('catalog motion prediction keeps mas/year distinct from arcseconds', () => {
  const d = deriveAdvanced({frames: response(), resolved: {pmra: 3000, pmdec: 4000}});
  assert.equal(d.totalPm, 5000);
  assert.equal(d.predictedShift, 5);
});
