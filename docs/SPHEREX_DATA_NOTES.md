# SPHEREx data: what the real files look like

Checked against real DR1/QR3 level-2 files on Sat 14 Nov 2026. Owner: B. Facts here beat anything from memory in the other plan docs.

## Access

| Path | State on 14 Nov, ~12:20–13:30 ET | Use |
|---|---|---|
| IRSA TAP `/TAP/sync`, SIA2 `/SIA`, SCS | **502 Proxy Error**, every request, both `irsa.` and `irsaproxy1.` hosts | Primary for "which files cover this position" once it's back |
| S3 mirror `https://nasa-irsa-spherex.s3.amazonaws.com/` | **Works**: public, no credentials, supports byte ranges | Stamps via partial reads; fallback index |

S3 layout: `<release>/level2/<YYYYWww_nX>/<proc>/<detector>/level2_<YYYYWww_nX>_<obs>_<exp>D<det>_spx_<proc>.fits`
- Releases: `dr1/` covers 2025W17–2026W20; `qr3/` covers 2026W20–2026W40. `qr2/` still exists but is superseded by DR1.
- About 1,800 files per half-week folder per detector, each ~65 MB. Roughly 1.6 M files in total.
- Some folders have a `*_retry-*` proc next to the main one. **Not every exposure exists on every detector** (e.g. `0474_4D1` exists but `0474_4D4` doesn't), so never assume a sibling file.
- Calibration folders sit next to `level2/`: `spectral_channels/` (the 102 channels), `solid_angle_pixel_map/`, `spectral_wcs/`, `epsf/`, `hips5_cube/` (an all-sky HiPS cube, usable as an Aladin layer).
- One parallel scan got a `RemoteDisconnected` from S3. Retries are required.

**No spatial index on S3.** Without TAP, finding coverage means reading headers. Reading the first 40 KB of each file (primary + IMAGE header) runs at about 10–15 s per half-week folder per detector with 48 threads. Scanning the ~10 weeks around a target's expected visibility is practical; scanning everything is not.

## File structure (level-2 spectral image)

| HDU | Contents |
|---|---|
| IMAGE | float32 2040², **BUNIT `MJy / sr`**. Zodi **not** subtracted. Core pixels of saturated stars can be NaN |
| FLAGS | int32 2040², tile-compressed. Bit names in the header: `MSKNnnnn` = name, `MSKMnnnn` = mask |
| VARIANCE | (MJy/sr)² |
| ZODI | Zodiacal model, MJy/sr |
| EPSF | 441 rows = 21×21 zones. Each row: `XCENTER, YCENTER, XWIDTH, YWIDTH, CWAVE, CBAND`, 33×33 ePSF oversampled 5× (`OVSMPX/Y`) |
| WCS-WAVE | 9×9 control-point grid. `VALUES[iy, ix, 0]` = λ (µm), `[..., 1]` = bandwidth. X and Y are **1-based full-detector pixels** |

Useful IMAGE header keys:
- Timing: `MJD-AVG` (exposure midpoint), `XPOSURE` (~114 s).
- `DETECTOR`, `OBSID`.
- WCS: `RA---TAN-SIP`.
- Alternate WCS **A** (0-based detector pixels) and **W** (wavelength lookup).
- `OMEGA_MEDIAN` (pixel solid angle, ~37.69 arcsec² ≈ 6.14″ square), `PSF_FWHM` (~7.5″).
- Spacecraft position `X_SC/Y_SC/Z_SC` (geocentric km).
- Quality: `L2DQAFLG`, plus per-flag pixel counts `L2 N_*`.

Wavelength runs along detector **y**: in D1, λ goes from 1.12 µm at y=1 to 0.74 µm at y=2040. Each observation takes ~4 exposures that step the target ~115 px in y. So one pass samples many channels for the same star.

Detectors: 1–3 SWIR, 4–6 MWIR. **D1/D4, D2/D5 and D3/D6 see the same sky** (same `CRVAL` to about 0.1°). D1, D2 and D3 tile adjacent sky ~3.9° apart.

## The 102 channels

`dr1/spectral_channels/cal-sch-v2-2026-229/...fits` has the table `SPECTRAL_CHANNELS` (`DETECTOR, SUBCHAN, WAVELENGTH, WL_MIN, WL_MAX, R, BANDWIDTH`), 17 per detector:

| Det | λ range (µm) | R |
|---|---|---|
| D1 | 0.743–1.116 | 39 |
| D2 | 1.099–1.651 | 41 |
| D3 | 1.636–2.440 | 41 |
| D4 | 2.422–3.827 | 35 |
| D5 | 3.814–4.426 | 112 |
| D6 | 4.418–5.009 | 128 |

## Flags (bit numbers read from the header)

| Bit | Name | % of pixels in a 48² Barnard stamp | Our policy (`config.yaml`) |
|---|---|---|---|
| 0 | TRANSIENT | 7.4 | photometry_reject |
| 1 | OVERFLOW | 0.2 (**on Barnard's core**) | photometry_reject |
| 2 | SUR_ERROR | 2.1 | photometry_reject |
| 6 | NONFUNC | 0.1 | display_mask |
| 7 | DICHROIC | 0 | display_mask |
| 9 | MISSING_DATA | 0 | display_mask |
| 10/11 | HOT / COLD | 0 | display_mask |
| 12 | FULLSAMPLE | 0 | ignore (informational) |
| 14 | PHANMISS | 0 | ignore |
| 15 | NONLINEAR | 0 | photometry_reject |
| 17 | PERSIST | 0.2 | photometry_reject |
| 19 | OUTLIER | 0 | photometry_reject |
| 20 | CROSSTALK | 0.2 | contamination |
| 21 | SOURCE | 100 | **ignore — marks every star** |
| 22–24 | GHOST, GHOST_FPA, GHOST_EXT | 0 | contamination |
| 25 | STREAK | 0 | photometry_reject |
| 26 | BLOOM | 1.9 | contamination |
| 27 | SNOWBALL | 0 | photometry_reject |
| 28 | HALO | 16.2 | contamination |

Why the split: masking the "hard" flags for display punches a hole exactly where a bright target sits (see `data/barnard_spike.png` vs `data/barnard_spike_display.png`, made locally). Images are shown with only real detector defects masked. Cosmic rays are removed by sigma-clipping when stacking. Photometry marks a point as flagged if any reject bit touches the aperture.

## Coverage found: Barnard's Star (D1, by header scan)

| Pass | Release / weeks | MJD | On-chip D1 exposures |
|---|---|---|---|
| E1 | dr1 2025W35_1A–2025W36_2B | 60914–60923 | 19 |
| E2 | dr1 2026W11_1A | 61110 | 18 |
| E3 | qr3 2026W34_2A–2026W35_2A (+ maybe W36) | 61276–61278 | ≥17 |

So we have **3 passes at a mid-ecliptic-latitude target**, about 6 months apart. Barnard is saturated (OVERFLOW + BLOOM) in D1 (~0.9 µm) and D4 (~2.9 µm). Even so, the last-minus-first difference image shows a clean north-pointing dipole, and Gaia DR3 propagated to each exposure's `MJD-AVG` lands within 3–6″ of the measured peak.

**Astrometry, single exposures (phase 1).** Flux-weighted centroids of Barnard on our 3.075″ grid agree with Gaia (propagated to `MJD-AVG`) to ≤1.3 px (≤4″) per exposure: E1 off by −1.3/+0.9 px, E2 by 0.0/0.0, E3 by +0.1/+0.4. The brightest pixel is off by up to 3 px, because saturated cores contain NaN pixels. **Never locate a bright star by argmax.** Co-adding ~10–20 exposures per pass should tighten this; to be measured in phase 4 (registration QC).

**Finding coverage from S3 (phase 1).** A sampled index of detector-1 pointings (every 5th observation, every week folder) lives in `backend/data/coarse_index.json.gz` and is rebuilt by `scripts/build_coarse_index.py`. The fine scan then reads only the IMAGE headers of observations within ±5 of an index sample that came within 16° of the target. Barnard, March 2026 folders, whole-folder scan (before this narrowing): 56 exposures (D1 18, D2 10, D4 18, D5 10) in 94 s cold. Headers are cached, so a repeat costs only the WCS maths.

Test fixtures: `tests/fixtures/barnard_E{1,2,3}_D{1,4}.fits`, 48×48 stamps (~135 KB each) cut by `scripts/make_fixtures.py`. They mimic IRSA cutouts: `CRPIX` is shifted, `CRVAL1A/2A` and `CRVAL1W/2W` are offset by the stamp origin, and `CUTX0`/`CUTY0` are added. The native IRSA service was checked on 15 Nov 2026: it shifts alternate-WCS CRPIX instead of adding CUTX0/Y0. The processor now supports both forms and selects the nearest EPSF zone from native multi-zone tables. The authentic native fixture and `NATIVE_ARCHIVE_VALIDATION.json` compare wavelength, flags, sky pixel and EPSF against S3.
