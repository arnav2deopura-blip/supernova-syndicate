# API contract

**Source of truth.** The backend (`backend/schemas.py`) and the fake data (`frontend/mock/`) must match this file.
Changing it = one PR that updates all three together, reviewed by everyone.

Base URL: the deployed backend by default (`DEPLOYED_API` in `frontend/js/api.js`); the page can be pointed elsewhere with `?api=local` or `?api=<url>`. All responses are JSON.

## Conventions

| Thing | Unit / format |
|---|---|
| Coordinates | ICRS degrees (`ra` 0–360, `dec` −90–90) |
| Proper motion | mas/yr (`pmra` includes the cos δ factor) |
| Wavelength | µm |
| Image pixels (`/frames`) | **MJy/sr** surface brightness (SPHEREx `BUNIT`), zodi and local background removed |
| Flux (`/spectrum`, `/lightcurve`) | µJy |
| Spectral channel | `D<det>C<nn>`, e.g. `D6C03` (17 per detector, 102 in all) |
| Time | MJD (float) |
| Field of view `fov` | degrees, square cutout side. Default 0.1, max 0.5 |
| Band `band` | `D1` … `D6` (detector). Edges in `backend/config.yaml` |
| Image arrays | flat, row-major, **row 0 = top of image** (north up, east left), `null` = masked pixel |

## Errors

Every error, on every endpoint, has the same shape and a matching HTTP status:

```json
{ "error": "not_found", "message": "No SPHEREx images cover this position." }
```

| `error` | HTTP |
|---|---|
| `bad_request` | 400 |
| `not_found` | 404 |
| `upstream_unavailable` | 503 (IRSA slow or down) |
| `not_implemented` | 501 |

---

## `GET /api/resolve?name=`

Resolve a target name and propagate its position to the current epoch.

```json
{
  "name": "Barnard's Star",
  "ra": 269.4486,
  "dec": 4.7394,
  "epoch": 2026.0,
  "pmra": -801.551,
  "pmdec": 10362.394,
  "source": "simbad"
}
```

## `GET /api/frames?ra=&dec=&fov=&band=[&matched=1][&async=1]`

One co-added frame per epoch for one detector band, all on the same grid.

```json
{
  "ra": 269.4486,
  "dec": 4.7394,
  "fov": 0.04,
  "band": "D2",
  "wcs": {
    "center_ra": 269.4486,
    "center_dec": 4.7394,
    "pixel_scale_arcsec": 3.075,
    "width": 48,
    "height": 48
  },
  "frames": [
    {
      "epoch_label": "E1",
      "mjd_start": 60810.2,
      "mjd_end": 60824.9,
      "n_exposures": 12,
      "width": 48,
      "height": 48,
      "data": [0.12, 0.08, null, "..."],
      "flag_fraction": 0.03
    }
  ]
}
```

`data` is either the flat float array or a string URL to a `.json`/`.bin` file with the same array (used by `frontend/precomputed/` for large cutouts). For `.bin`: little-endian float32, NaN for masked.

**Live backend (phase 1):** `data` is always an absolute URL to `GET /api/blob/<id>.bin` (content-addressed, cacheable forever, gzip on the wire). Optional fields added to every frame and the response (all additive, mocks stay valid):

| Field | Meaning |
|---|---|
| `units` (response) | `"MJy/sr"` |
| `release` (response) | Data release tag the frames were built from, e.g. `dr1+qr3-2026W40` |
| `mjd_mean` | Mean MJD of the frame's exposures. Propagate overlays to this, not to the label |
| `lam_um` | Wavelength (µm) at the target in each exposure. A SPHEREx detector sees a different wavelength at every position, so a frame's colour mix is listed here |
| `lam_eff_um` | Mean of `lam_um` |
| `target_flags` | Flag names touching the target in any exposure (e.g. `OVERFLOW` = saturated). Show as a warning, not an error |
| `obs_ids` | Exposure IDs in the frame |

**Slow first requests (phase 2).** A position nobody has asked for before needs an archive search plus downloads: ~1–10 min. Cached positions answer in well under a second. Two ways to call:

- `GET /api/frames?...` (default) waits for the result. Simple, but a browser may time out.
- `GET /api/frames?...&async=1` returns at once: **200** with frames if cached, otherwise **202** with a job:

```json
{ "job_id": "3f9c0a1b2c3d4e5f", "state": "running", "stage": "stamps", "message": "Downloading image cutouts",
  "done": 12, "total": 46, "error": null, "created": 1794680000.1, "finished": null, "result": null,
  "status_url": "http://host/api/jobs/3f9c0a1b2c3d4e5f" }
```

Poll `GET /api/jobs/{job_id}` (every ~1 s) until `state` is `done` (then `result.result_url` is the frames URL, now cached) or `error` (`error` is an error code from the table above, `message` explains). `stage`/`done`/`total` drive a progress bar.

**Matched wavelengths (`matched=1`).** Use this for any brightness comparison between frames (blink, difference
image). A detector covers 17 channels, and each pass samples a different mix of them at the target. In a plain
frame, a red source can look brighter or fainter only because the wavelengths changed: WISE 0855's plain D6
frames sit at 4.71–4.94 µm. With `matched=1`, every exposure is tagged with the channel at the target. Each
frame is then the equal-weight mean of only the channels observed in **every** pass, so all frames share one
bandpass (WISE 0855: 4.89–4.91 µm). Exposures in other channels are left out, which costs S/N. Same grid, blobs and
async behaviour as the plain frames; cached separately. Extra fields:

| Field | Meaning |
|---|---|
| `matched` (response) | `true` |
| `matched_channels` (response) | Channels in every pass, e.g. `["D6C13", "D6C16"]` |
| `lam_eff_um` (response) | Mean centre wavelength of `matched_channels` |
| `channels` (frame) | `[{channel, n_exposures, lam_target_um}]` averaged into this frame |
| `n_exposures_dropped` (frame) | Exposures of this pass left out (their channel is missing from some other pass) |

`lam_eff_um` per frame is still reported. It now differs between frames by at most ~half a channel (~0.02 µm).
If no channel is common to every pass, the response is **404 `not_found`**, and the message lists each pass's
channels. Precomputed: `frontend/precomputed/<slug>/frames_matched_<band>.json`.

**Epoch labels are per position, shared by all bands and the overlay.** `E2` means the same months in D1 and D6. A band with no data in a pass skips that label (e.g. `E1, E3`). A pass longer than 90 days (near the ecliptic poles coverage is nearly continuous) is split at its largest gap, or into equal ≤90-day bins, so polar targets get more frames.

## `GET /api/exposures?ra=&dec=&fov=`

Every individual exposure covering the position, all six detectors (for the metadata panel). `wavelength_um` and `flags_summary.target_flags` are `null` until that detector's frames have been built once (they come from the image cutout). `url` is the full level-2 file (S3 or IRSA).

```json
{
  "exposures": [
    {
      "obs_id": "2025W21_1A_0123_1",
      "mjd": 60812.4,
      "detector": 2,
      "wavelength_um": 1.31,
      "epoch_label": "E1",
      "flags_summary": { "flag_fraction": 0.02 },
      "url": "https://irsa.ipac.caltech.edu/..."
    }
  ]
}
```

## `GET /api/spectrum?ra=&dec=[&det=all][&compare=E1][&against=E3][&pmra=&pmdec=][&epoch=][&async=1]`

Per-exposure ePSF photometry of the source at `ra`/`dec`, every exposure in the requested detectors (`det`: `all`
or a comma list such as `D2,D3`), µJy, with the wavelength at the source pixel. The position is propagated to
each exposure's time: with the Gaia DR3 proper motion when the source matches Gaia within 2″, else `pmra`/`pmdec`
from the request (pass them from `/api/resolve`), else no motion. `epoch` = decimal year `ra`/`dec` are valid
for (default now, as `/resolve` returns). `track` says which was used.

`fit`: `forced` (faint: position fixed), `psf` (position free), `wing` (saturated: core masked, wings fitted;
always `flagged`), `failed`.

**Neighbours.** Forced fits also fit every Gaia DR3 source within 5 native px (31″) of the target at that exposure's
time, at fixed positions with free fluxes. Without this, a star a few arcsec away puts its light into the target
(WISE 0855 showed a fake 7σ signal at 0.8 µm). `n_deblended` = neighbours fitted; `blend` = Gaia IDs within 2 native
px (12″): show these points as less certain. When Gaia is unreachable there is no deblending (`n_deblended: 0`). `flagged` also when a photometry-reject flag touches the core.

With `compare=E1`: `ratio`, per channel present in both passes, flux(`against`, default the last pass) /
flux(`compare`). Flat = the star changed by the same factor at every wavelength.

Cold requests download every detector requested (~1–5 min): use `async=1` (→ 202 + job, as `/frames`).

```json
{
  "ra": 76.9566, "dec": 30.4013,
  "track": { "source": "gaia_dr3", "pmra": 7.2, "pmdec": -20.3, "gaia_id": "Gaia DR3 156900..." },
  "points": [
    { "wavelength_um": 1.31, "flux": 1520.0, "flux_err": 35.0, "epoch_label": "E1", "flagged": false,
      "bandwidth_um": 0.032, "channel": "D2C08", "mjd": 60926.3, "obs_id": "2025W38_1B_0123_2", "detector": 2,
      "fit": "psf", "flags": [], "blend": [], "n_deblended": 0 }
  ],
  "ratio": [ { "channel": "D2C08", "lam_um": 1.31, "ratio": 1.29, "ratio_err": 0.04, "passes": ["E3", "E1"], "flagged": false } ]
}
```

---

## `GET /api/cube?ra=&dec=&fov=&det=D6[&per_pass=1][&strict=1][&pmra=&pmdec=][&async=1]`

The 102-band view, one detector (17 channels) per call: one co-added image per spectral channel on the **same
grid as `/frames`** (same `wcs`), MJy/sr, blobs as in `/frames`. Channels with no data are omitted.

* Default: every exposure is assigned to the channel at the **field centre** (`channel_at: "field_centre"`;
  up to ~½ channel off at the edge of a 0.1° field), all passes stacked (best S/N).
* `strict=1`: each exposure contributes only the pixels inside the channel (`channel_at: "pixel"`), so
  `coverage` can be < 1.
* `per_pass=1`: instead of `data`, each channel has `frames` (one per pass, keyed by `epoch_label`).
  `recommend_per_pass` is true when a Gaia source in the field or the target itself (`pmra`/`pmdec`) moves
  > 1″/yr: movers smear in the all-passes stack.
* `display_range`: one `[lo, hi]` stretch for every channel; use it so brightness changes with wavelength stay visible.
* `target_value`: mean of the 3×3 pixels at the target in that channel: a free "spectrum strip".

```json
{
  "ra": 133.7578, "dec": -7.2420, "fov": 0.1, "det": "D6", "units": "MJy/sr", "release": "dr1+qr3-2026W40",
  "wcs": { "center_ra": 133.7578, "center_dec": -7.2420, "pixel_scale_arcsec": 3.075, "width": 117, "height": 117 },
  "per_pass": false, "strict": false, "channel_at": "field_centre",
  "display_range": [-0.064, 0.549], "fast_movers": [], "recommend_per_pass": true, "n_stamps": 44,
  "channels": [
    { "channel": "D6C01", "subchan": 1, "lam_um": 4.435, "lam_min": 4.418, "lam_max": 4.452, "R": 128.0,
      "n_exposures": 2, "data": "https://.../api/blob/....bin", "coverage": 1.0, "lam_target_um": 4.4371,
      "mjd_mean": 61073.9, "passes": ["E2", "E3"], "target_value": 0.094, "target_flags": [], "obs_ids": ["..."] }
  ]
}
```

---

## `GET /api/lightcurve?ra=&dec=&det=D2[&method=template|channel][&channel=D2C07][&bin_days=15][&period_days=][&pmra=&pmdec=][&epoch=][&async=1]`

A light curve that is not fooled by the moving bandpass (every exposure sees the star at a different λ).

* `method=template` (default): the star's mean spectrum `template` is built from all exposures; each point's
  `scale` = flux / template(λ); `bins` average `scale` per `bin_days` (default 15). Scale 1 = average brightness.
* `method=channel`: also returns `channel_curve`, flux vs time in one `channel` (default: the best-sampled one).
* `chi2_constant` / `dof`: against a constant. `variable` is true only when χ²/dof > 5 **and** the comparison stars
  are quiet (`comparison_stars.rms_scale` < 5 %). `systematic_floor` = max(2 %, comparison-star rms).
* `reliable` false (with `note`): the median point error (`median_frac_err`) exceeds 30 %, almost always deep
  saturation (R Dra in D2). Then `variable` is null: no claim either way.
* `shape_changed`: scale depends on λ within a pass (the template assumption fails; look at `/spectrum?compare=`).
* `used_flagged`: most points are saturated wing fits (`note` explains). `points[].used` false = left out.
* `period` (≥ 6 bins): Lomb–Scargle best period, plus a sinusoid at it and at `period_days` if given.

```json
{
  "ra": 76.9566, "dec": 30.4013, "det": "D2", "method": "template", "units": "uJy", "bin_days": 15.0,
  "systematic_floor": 0.02, "track": { "source": "gaia_dr3", "pmra": 7.2, "pmdec": -20.3, "...": "..." },
  "used_flagged": true, "n_points": 54, "n_used": 54,
  "template": [ { "detector": 2, "lam_um": 1.12, "flux": 41500.0 } ],
  "points": [ { "mjd": 60926.3, "lam_um": 1.231, "flux": 39800.0, "flux_err": 900.0, "scale": 0.96, "scale_err": 0.03,
                "flagged": true, "flags": ["OVERFLOW"], "fit": "wing", "used": true, "epoch_label": "E1", "...": "..." } ],
  "bins": [ { "mjd": 60927.4, "mjd_start": 60926.3, "mjd_end": 60928.8, "scale": 0.888, "scale_err": 0.017, "n": 18,
              "lam_min": 1.105, "lam_max": 1.623, "label": "E1" } ],
  "chi2_constant": 93.3, "dof": 2, "variable": true, "shape_changed": false, "bin_slopes": [],
  "comparison_stars": { "n": 8, "rms_scale": 0.0126, "stars": [ { "id": "Gaia DR3 ...", "mag_g": 14.8, "median_flux": 6734.1,
                        "n": 54, "chi2_constant": 3.7, "dof": 2, "bins": [ { "mjd": 60927.4, "scale": 1.01, "scale_err": 0.01 } ] } ] }
}
```

---

## `GET /api/motion?ra=&dec=[&det=D2|D2,D3|all][&fit_parallax=1][&pmra=&pmdec=][&epoch=][&async=1]`

A measured proper motion with errors. Per exposure: ePSF fit of the target (wing fit if saturated), corrected
by registering Gaia stars on the same stamp (`reg_*`, `n_ref`), then a weighted least-squares fit over all
exposures of position + proper motion (+ parallax). Units in `units`: mas/yr, mas.

* `fit.parallax_mode`: `fit` (`fit_parallax=1`), `gaia_fixed` (default when Gaia has a parallax: the known
  parallax is removed, proper motion is still measured independently), `ignored`.
* `fit.bootstrap`: errors from resampling exposures (a cross-check of `pmra_err` / `pmdec_err`).
* `gaia`: our PM vs Gaia DR3 (`pm_sigma_diff` = combined difference in σ). When the target is not in Gaia,
  `catalog` compares with the `pmra`/`pmdec` you passed (e.g. SIMBAD via `/resolve`).
* `exposures[].used` false: not fitted with a free position (too faint), or clipped (`note`).
  `resid_xi_mas` / `resid_eta_mas`: measured − fitted (east, north). `passes[]`: weighted mean position per pass.
* Draw `passes` as dots with error circles and two arrows: `fit` (pmra, pmdec) and Gaia's.

```json
{
  "ra": 331.0975, "dec": -56.8010, "det": "D3",
  "target": { "ra": 331.0975, "dec": -56.8010, "mjd": 61050.3 },
  "prior": { "source": "gaia_dr3", "pmra": 3981.98, "pmdec": -2466.83 },
  "exposures": [ { "obs_id": "2025W19_1A_0412_2", "det": 3, "mjd": 60796.9, "label": "E1", "lam_um": 1.93, "fit": "psf",
                   "flags": [], "snr": 85.0, "used": true, "ra": 331.0955, "dec": -56.8003, "err_mas": 158.0,
                   "reg_dx_px": 0.04, "reg_dy_px": -0.02, "reg_rms_px": 0.023, "n_ref": 5, "reg_model": "shift",
                   "resid_xi_mas": 35.0, "resid_eta_mas": -12.0 } ],
  "passes": [ { "label": "E1", "mjd": 60796.9, "ra": 331.0955078, "dec": -56.8003147, "err_mas": 39.2, "n": 22 } ],
  "fit": { "t0": 2026.03, "ra0": 331.09, "dec0": -56.80, "pos_err_mas": 18.0, "pmra": 3959.2, "pmra_err": 31.5,
           "pmdec": -2421.8, "pmdec_err": 31.5, "pm_corr": 0.01, "pm_total": 4641.2, "pm_total_err": 31.5,
           "pa_deg": 121.45, "pa_err_deg": 0.39, "parallax_mode": "gaia_fixed", "parallax": 270.66, "parallax_err": null,
           "chi2_dof": 0.83, "n": 89, "n_clipped": 0, "bootstrap": { "pmra_err": 28.0, "pmdec_err": 25.4, "n": 200 } },
  "units": { "pm": "mas/yr", "parallax": "mas", "position_err": "mas" },
  "gaia": { "catalog": "gaia_dr3", "pmra": 3981.98, "pmdec": -2466.83, "pm_total": 4684.16, "pa_deg": 121.78,
            "pmra_sigma_diff": -0.72, "pmdec_sigma_diff": 1.43, "pm_sigma_diff": 1.13, "chi2_2dof": 2.57,
            "id": "Gaia DR3 6412596012146801152", "parallax": 270.66 },
  "catalog": null
}
```

## `GET /api/overlay?ra=&dec=&fov=&cat=gaia`

Gaia DR3 sources in the field (G < 18, plus every source with proper motion > 100 mas/yr at any magnitude), with positions propagated from J2016.0 (`ref_epoch`) to each epoch's mean exposure time (`positions_by_epoch[].mjd`). Draw `positions_by_epoch`, not `ra`/`dec`. Not in Gaia: very red faint objects such as WISE 0855 (CatWISE planned).

```json
{
  "catalog": "gaia_dr3",
  "sources": [
    {
      "id": "Gaia DR3 4472832130942575872",
      "ra": 269.4486,
      "dec": 4.7394,
      "pmra": -801.551,
      "pmdec": 10362.394,
      "mag": 8.19,
      "positions_by_epoch": [
        { "epoch_label": "E1", "ra": 269.44861, "dec": 4.73901 }
      ]
    }
  ]
}
```


---

## Frame extras: noise maps and registration check (all `/api/frames`, plain and matched)

| Field (frame) | Meaning |
|---|---|
| `noise` | URL of the 1σ map, same layout/units as `data`. Difference in σ: `(B − A) / sqrt(noiseA² + noiseB²)`. Calibrated per frame so that this has unit scatter over the field (`noise_scale` = factor applied to the co-add error). Background noise only: bright-star residuals (Poisson, PSF, wavelength) exceed it, so a large σ on a bright star is not by itself a detection |
| `noise_scale` | See above (absent with a single frame) |
| `astrometry` | `{n_ref, dra_arcsec, ddec_arcsec, rms_arcsec}`: bright isolated Gaia DR3 stars centroided in this frame vs Gaia at `mjd_mean`. Offset = frame registration error; rms = per-star scatter. Absent when Gaia is unreachable |
| `astrometry_rms_arcsec` | Shortcut for `astrometry.rms_arcsec` |
| `target_flagged` | A photometry-reject flag (OVERFLOW, …) touches the target: show a "saturated" badge |

## `GET /api/frames.fits?ra=&dec=&fov=&band=[&matched=1]`

The frames as one multi-extension FITS file for DS9 / astropy: `IMAGE_E1`, `NOISE_E1`, `IMAGE_E2`, … (MJy/sr,
north-up TAN WCS, FITS row order). Headers carry `EPOCH`, `MJD-BEG/END/AVG`, `NEXP`, `LAMEFF`, `NOISESCL`, `ASTRMS`;
the primary header `RELEASE`, `MATCHED`, `NCHAN`. Builds the frames first if needed: for a new position call
`/api/frames?async=1` first.

## `GET /api/movers?ra=&dec=&fov=&band=D6[&max_pm=12][&snr_min=5][&async=1]`

Discovery mode. Every source detected in the pass frames is linked across passes, its proper motion fitted, and
cross-matched with Gaia DR3 (propagated to each pass). Frames are registered onto Gaia first, so whole-frame
shifts can't look like motion.

* `status`: `candidate` (moves at > 5σ, no Gaia source follows it: **the interesting ones**), `known_mover`,
  `gaia_pm_mismatch` (in Gaia, PM disagrees by > 5σ), `stationary`, `unconfirmed_mover` (only 2 passes),
  `artefact_near_bright_star` (secondary peaks of a saturated star; not reported as candidates).
* A pass where a faint source is below `snr_min` can still confirm a track with a ≥ 3σ peak on the predicted line
  (`passes[].forced`), e.g. WISE 0855's 3-exposure E1.
* `null_test`: (SPHEREx − Gaia) PM / error for Gaia-matched field sources; robust std ≈ 1 means the errors are honest.
* Needs ≥ 3 passes for candidates.

```json
{ "ra": 133.7578, "dec": -7.242, "fov": 0.1, "band": "D6", "n_passes": 3,
  "candidates": ["T012"],
  "tracks": [ { "id": "T012", "status": "candidate", "ra": 133.7558, "dec": -7.2418, "pmra": -7960.0, "pmdec": 2638.0,
                "pm": 8386.0, "pm_err": 774.0, "pm_sigma": 10.8, "chi2_dof": 0.94, "snr_min": 3.5, "n_forced": 1,
                "saturated": false, "gaia": null,
                "passes": [ { "epoch_label": "E1", "ra": 133.7561, "dec": -7.2419, "snr": 3.5, "err_arcsec": 0.97, "forced": true } ] } ],
  "null_test": { "n": 10, "pull_median": [0.02, -0.2], "pull_robust_std": [0.45, 0.17], "dpm_median_mas_yr": [22.7, -153.0],
                 "dpm_robust_std_mas_yr": [577.7, 239.6] },
  "passes": [ { "epoch_label": "E1", "mjd_mean": 60800.7, "n_detections": 10, "registration": { "n_ref": 4, "dra_arcsec": 0.02 } } ] }
```

## `GET /api/stack?ra=&dec=&fov=&band=[&pmra=&pmdec=][&epoch=][&async=1]`

Shift-and-stack: all exposures of the band co-added in the frame that moves with the target (PM from the request,
or Gaia when the target matches it), next to the plain static stack. Both are centred on the target at the mean
exposure time (`ref_mjd`, `ref_ra`, `ref_dec`, `wcs`). A real mover sharpens (`comoving.target_snr` >
`static.target_snr`) while field stars streak. `smear_arcsec` = how far the target moves over the data. The gain
is large only when the smear exceeds the 7.5″ PSF.

```json
{ "band": "D6", "track": { "source": "request", "pmra": -8123.7, "pmdec": 673.2 }, "smear_arcsec": 8.27,
  "static": { "n_exposures": 40, "target_snr": 17.6, "data": "https://.../api/blob/....bin" },
  "comoving": { "n_exposures": 40, "target_snr": 20.6, "data": "https://.../api/blob/....bin" },
  "wcs": { "center_ra": 133.7581, "center_dec": -7.2421, "pixel_scale_arcsec": 3.075, "width": 117, "height": 117 } }
```

## `GET /api/meta[?check=1]`

What the server is built from: `release_tag`, `collections`, `s3_releases`, detector bands, `n_channels` (102),
and `index` = the pointing index's span (`data_from`, `data_through`, `last_week`, `n_observations`): show
"SPHEREx data through 2026-10-04". `check=1` also lists the S3 mirror now (cached 1 h) and reports
`check.new_releases` / `check.new_week_folders` / `check.up_to_date`.

---

## Frontend: sky map (not part of this API)

Explore mode reads the SPHEREx DR1 all-sky HiPS cube straight from IRSA:
`https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube` (PNG tiles, CORS open, 102 frames, frame =
`17*(det-1) + (channel-1)`, frames 50/51 blank). Aladin Lite maps a slice number to a frame through a linear
frequency model, which does not match the SPHEREx channel spacing; `frontend/js/sky.js` (`applySlice`) inverts it so
each slider position shows exactly one channel. Frame 0 (D1C01) has no `_0` tile, so the slider starts at frame 1.

Mock files: `frontend/mock/{resolve,frames,exposures,spectrum,overlay,cube,lightcurve,motion}.json`, regenerated by `python scripts/make_mock.py`. Mock values are fake; they only show the shape.


## Reliability and reproducibility fields (November 2026)

Frames and research products may include `provenance` (release plus SHA-256 hashes of
index contents, processing source, and scientific configuration), `retrieval.kind`
(`built` or `server_cache`), and an exploratory reliability note. Frame `flag_fraction`
is the fraction of masked/nonfinite output pixels, not an exposure contamination rate.
Exposure quality is nullable until measured. `coverage` on frames is an optional
float32 URL giving the number of contributing samples per output pixel.
`comparison_scope=field_centre_quicklook` explicitly limits matched-channel claims.
`completeness` records selected/retrieved/failed counts when available and the sampling
policy; bounded archive sampling is never an exhaustive-coverage guarantee.

The async queue is bounded (default eight jobs, two workers, at most four outstanding
jobs per client connection). Busy responses use HTTP 429 and Retry-After. Identical
active product keys share a job. Queued work expires after five minutes. Job snapshots
are written in the configured cache; after restart, interrupted jobs explain how to
repeat the query and reuse downloads. Persistent storage is a deployment choice.
Client polling has a twenty-minute overall limit and a five-minute no-progress limit.
`?fresh=1` is a frontend policy that disables saved-file fallback; it does not purge
backend caches. A true cold retrieval test uses a new SPHEREX_CACHE_DIR.

FITS exports include IMAGE/NOISE (and COVERAGE where available) extensions plus a
MANIFEST uint8 extension containing UTF-8 JSON with processing and source observation
IDs. The browser's research-manifest export records displayed sources and limitations.

Image requests also have a configured native-pixel working-set budget (default
16 million pixels). Dense, large fields that exceed it are rejected before stamp
downloads with `bad_request` and a smaller-FOV suggestion. Combined motion fits use
the same budget and may require fewer detectors. This bounds per-job memory as well
as the number of concurrent jobs.
