# Backend + physics/visualization plan: prototype → real tool

Scope: everything under `backend/`, `scripts/precompute.py`, the science tests, `docs/API.md` (shared), `docs/VALIDATION.md`, and the *science* side of visualization (what each frame, spectrum and light curve means and how it's computed). C keeps page layout, player controls and URL state.

**Proposed boundary with C (please confirm):** I own `spectrum.js` and the frame-math half of `render.js` (`composeFrame`, stretch limits). C owns everything else in `frontend/`.

Written Sat 14 Nov 2026, ~12:30 ET. **[verify]** marks things not yet checked against a source or real data.

---

## 1. Where the prototype actually is

| Piece | State |
|---|---|
| `server.py` routes, error shapes, CORS | Done. `/frames` and `/exposures` raise 501; `/spectrum`, `/overlay`, `/resolve` call stubs that raise 501 |
| `spherex_client.py` | Only `cutout_url()`. No query, no download |
| `fits_processor.py` | `group_epochs`, `mask_and_subtract`, `coadd` written and unit-tested on fakes. Never run on a real cutout |
| `image_alignment.py` | `target_wcs` only. `reproject_to` is a stub |
| `photometry.py`, `catalogs.resolve_name/gaia_sources` | Stubs (`propagate` exists) |
| `cache.py` | JSON + file paths. No eviction, no in-flight dedupe |
| `precompute.py` | Written, but nothing works yet, so `frontend/precomputed/` is empty |
| Frontend | Runs on `mock/` only |

**Live check at ~12:20:** IRSA TAP (`/TAP/sync`) returned an immediate `502 Proxy Error` on three simple queries. It may be a short outage, but it confirms that the outage fallback is required.

**Phase 0 done (~13:30).** Details in `docs/SPHEREX_DATA_NOTES.md`. What changed in this plan:
- IRSA TAP/SIA/SCS stayed down (502). The **public S3 mirror works**, and partial byte-range reads give stamps without downloading 65 MB files. S3 is now a first-class data path, not a [verify].
- Coverage without TAP: a header scan of ~10 week-folders around a target's visibility window takes a few minutes. Phase 1 builds `query_exposures` with TAP first and the S3 header scan as fallback, cached per position.
- Barnard's Star has **3 passes** (Aug/Sep 2025, Mar 2026, Aug/Sep 2026). It is **saturated** in D1 and D4, but the dipole is clear in a single-exposure difference.
- Flag policy split into display / photometry / contamination groups (`config.yaml`). A single "bad bits" mask hides saturated targets.
- 6 real fixtures and 25 real-data assumption tests are in CI.
- Phase 1 also needs the new `.venv` deps: `scipy`, `fsspec`, `aiohttp` (added to requirements).

**Phase 1 (~15:00).** Built:
- `s3_archive.py`: listings, header range reads, stamps, coarse index, fine scan.
- `spherex_client.py`: TAP first, falling back to the S3 scan; parallel cached stamps.
- `fits_processor.py`: flag decode, wavelength at the target, `prepare_stamp`, `coadd_clipped`.
- `image_alignment.reproject_to`.
- `pipeline.py`.
- `catalogs.resolve_name` (CDS Sesame + PM).
- `/api/frames` returning blob URLs, `/api/blob/{id}.bin`, gzip.

Contract changes are additive only (see `API.md`). The TAP path is written but **untested**: IRSA stayed 502 all afternoon. `/frames` is still synchronous, so a cold position waits for the scan and downloads; phase 2 adds jobs and progress.

**Phase 2.** What was built:
- Jobs: `/api/frames?async=1` returns 202 with a job, polled at `/api/jobs/{id}`. Plain `/api/frames` is unchanged.
- TAP circuit breaker: after a failure, skip TAP for 10 min. IRSA came back for trivial queries but timed out (>120 s) on real ones.
- Shared epoch labels per position, with polar coverage split into ≤45-day bins.
- Gaia DR3 overlay from the ESA archive, propagated to each epoch's mean MJD. VizieR was down, so there is no fallback; results are cached forever.
- Real `/api/exposures`.
- `precompute.py` bakes frames, overlay and exposures.
- Dockerfile pinned to 1 worker; `.dockerignore` added.

Findings:
- **Registration is excellent after stacking.** Bright field stars in Barnard's D2 co-adds match Gaia to 0.05–0.08 px rms (≈0.2″) in every pass.
- **The sky position jumps between consecutive observations** (median 138° for 5 obs apart). A sparse pointing index can't be interpolated, so `coarse_index.json.gz` now covers every observation's detector-1 pointing.

**Deployed (M2 backend):** Azure Container Apps, Azure for Students, `canadacentral`, at https://spherex-api.redgrass-773e0da8.canadacentral.azurecontainerapps.io. Cloud Run was dropped because it needed a card hold.

Azure for Students limits we hit:
- Region policy: 5 allowed regions.
- Cloud builds (ACR Tasks) are blocked, so we build locally with Docker and push.

Fixed during deploy: uvicorn `--proxy-headers`. Without it, job and blob URLs came back `http://`, which browsers block from an `https://` page, and the replica scaled to zero mid-job.

All five presets are precomputed; R Dra has only 2 D2 passes (polar sampling, see `VALIDATION.md`).

---

## 2. Physics corrections to make before writing pipeline code

Each of these is a bug in the current scaffold or contract.

1. **Units are wrong.** SPHEREx `IMAGE` is surface brightness in **MJy/sr**, not µJy. Frames stay in MJy/sr. Spectra convert per pixel:
   `flux_µJy = Σ(I − bkg) · Ω_pix · 10¹²`, with `Ω_pix = (scale″/206265)²`.
   Native 6.15″ pixel: 1 MJy/sr → **889 µJy**. Our 3.075″ output grid: 1 MJy/sr → **222 µJy**. Reprojection preserves surface brightness, so we must use the output pixel's Ω. Using the native Ω here would make every flux 4× too high.
2. **Band edges. (Done.)** `config.yaml` now uses the official channel-table edges: D1 0.743–1.116, D2 1.099–1.651, D3 1.636–2.440, D4 2.422–3.827, D5 3.814–4.426, D6 4.418–5.009 µm.
3. **Zodi is not subtracted in the product.** Subtract the `ZODI` HDU, then a local background (sigma-clipped median of the cutout, or a coarse background mesh at larger FOV). This also removes the offsets between exposures before co-adding.
4. **A detector co-add has a different effective bandpass each epoch.** This is the key problem. Within an epoch, the target lands at different positions on the linear variable filter, so a "D2" co-add averages a different mix of wavelengths each time. A red source can then look variable just because the wavelength sampling changed. Fix:
   - Tag every cutout with the wavelength at the target position, from `WCS-WAVE` (bilinear interpolation of the control points).
   - Bin exposures into the **17 native channels per detector** (6 × 17 = 102 bands).
   - **Matched-λ co-add:** co-add within each channel, then average only the channels present in *every* epoch, with equal weight per channel. Every epoch then has the same effective bandpass, so difference images show real changes only.
5. **Flags. (Done in config.)** Bit names and masks are read from the FLAGS header (`MSKNnnnn`/`MSKMnnnn`). Groups by name are in `config.yaml`:
   - `display_mask` (detector defects only): turned into NaN in shown images.
   - `photometry_reject`: marks spectrum points as flagged. Includes OVERFLOW, which sits on Barnard's core.
   - `contamination`: reported, not masked.
   - `ignore`: includes `SOURCE`, which marks every star.
   Cosmic rays are removed by sigma-clipped stacking instead of masks.
6. **Overlay time.** Propagate Gaia positions from **J2016.0** (DR3 reference epoch) to each frame's *exposure-weighted mean MJD*, not to an epoch label. Change `positions_by_epoch` to carry `mjd`.
7. **Parallax** (Tier 3). The 6-month epochs fall on opposite sides of Earth's orbit, which maximizes the parallax shift. It is still small: Barnard about 0.55″ ≈ 0.09 native px. Ignore it for display. Include it only if we fit motion.

Expected motion, from SIMBAD proper motions **[verify]**: Barnard ≈ 10.4″/yr ≈ 1.7 native px/yr; WISE 0855 ≈ 8.1″/yr ≈ 1.3 px/yr; ε Indi ≈ 4.7″/yr ≈ 0.8 px/yr.

---

## 3. Target backend architecture

```
request ─► resolve (Sesame → PM-propagate to now)
        ─► exposure index    one TAP query per position, all bands, cached (fallback: SIA2)
        ─► cutout fetch      bounded pool, retry+backoff, cache by (obs_id, snapped center, size)
        ─► per-cutout prep   flags mask · zodi + local bkg · λ at target from WCS-WAVE · variance
        ─► reproject         common north-up TAN grid, 2× oversampled
        ─► stack products    per epoch × (detector | channel | λ-range), matched-λ option
        ─► registration QC   centroid bright Gaia stars per frame → offset + rms per frame
        ─► serve             JSON metadata + float32 .bin arrays (gzip)
```

### 3.1 Request model: jobs, not one long GET
A cold position means about 100+ cutouts and can take 30–120 s **[measure]**. Free hosts and browsers time out.
- `GET /api/frames?...` returns **200** with the product when cached. Otherwise it returns **202** `{job_id, status_url}`.
- `GET /api/jobs/{id}` returns `{state, done, total, stage, message}` and, when finished, the result URL. C shows a progress bar.
- Identical in-flight requests share one job (dedupe on cache key).
- Build the detector the user asked for first, then the other five in the background.

### 3.2 Data transport
JSON float arrays are too large. At FOV 0.5° on a 3.075″ grid a frame is 585×585 floats, roughly 3 MB of JSON per epoch. Serve `data` as a URL to `/api/blob/{hash}.bin` (little-endian float32, NaN for masked, gzip). The contract and `api.js` already support this. Precomputed bakes use the same format.

### 3.3 Cache
- Level 1: raw cutouts. Snap the cutout center to a ~1′ grid and request `size = fov + margin`, so nearby or re-centred requests reuse files.
- Level 2: products keyed by `(ra, dec, fov, binning, release_tag)`.
- Size-capped LRU eviction (the container disk is small). Atomic writes already exist.
- `release_tag` comes from `config.yaml`. A new data release invalidates products automatically.

### 3.4 Being a good IRSA client, and surviving its outages
- Global semaphore of about 8 concurrent IRSA requests across all users. Exponential backoff on 5xx.
- Circuit breaker: after N consecutive failures, return `upstream_unavailable` quickly so the frontend falls back to precomputed data.
- **Second data path [verify]:** IRSA mirrors SPHEREx on AWS S3. `astropy.io.fits` with `use_fsspec=True` can read only the cutout section from S3. This is a fallback when the IRSA cutout service is slow. It is the primary path if the backend runs in AWS us-east-1.

### 3.5 Easy to update with new releases
- Collections and `release_tag` live in `config.yaml` (already the case).
- `GET /api/meta` returns the collections in use, the latest observation date found, and the backend version. The UI can show "Data through ⟨date⟩".
- `scripts/check_releases.py`, run by a weekly GitHub Action: list `spherex*` collections from IRSA ObsCore and open an issue if a new one appears.

### 3.6 Endpoint set (contract changes go through one PR: `API.md` + `schemas.py` + `mock/`)
| Endpoint | Change |
|---|---|
| `/api/frames` | Add `bin=detector\|channel\|range`, `lam_min/lam_max`, `matched=1`. Each frame gains `mjd_mean`, `lam_eff_um`, `lam_coverage[]`, `astrometry_rms_arcsec`, `target_flagged`. `data` becomes a `.bin` URL. Add `units: "MJy/sr"` |
| `/api/jobs/{id}` | New: progress polling |
| `/api/exposures` | Real per-exposure listing, including λ at target and flags at target |
| `/api/spectrum` | Forced photometry at the PM-propagated position for each exposure. µJy, with errors, flag reasons and a blend warning |
| `/api/lightcurve?ra&dec&channel` | New: flux vs time at a fixed channel (meaningful for deep fields and variables) |
| `/api/motion?ra&dec` | New (Tier 2b): measured centroid per epoch, fitted PM ± error, Gaia PM for comparison |
| `/api/overlay` | Positions per frame `mjd`. Add `cat=catwise` later |
| `/api/meta` | New: releases, data-through date, version |

---

## 4. Physics and visualization products (what makes it more than a blink)

In priority order:

1. **Epoch blink, per detector, matched-λ.** The baseline. Correct by construction (§2.4).
2. **Difference and sum images**, computed on matched-λ frames. A mover shows as a +/− dipole; a variable shows as a single-sign residual. Send the noise map (√variance) too, so C can scale the difference image in σ units instead of percentiles. This keeps noise from being mistaken for a detection.
3. **Spectrum on click.** Forced aperture photometry at the PM-propagated position for each exposure (that exposure's MJD). Local annulus background. Aperture correction from the `EPSF` HDU. Errors from `VARIANCE`. Each point gets a **blend flag** if a Gaia/CatWISE neighbour is within about 2 native pixels. With 6″ pixels, blending is the main source of bad spectra.
   - Chart (`spectrum.js`, mine): one colour per epoch, error bars, hollow markers for flagged points, detector boundaries shaded. Molecular band markers: H₂O 1.4/1.9/2.7, CH₄ 2.2/3.3, CO₂ 4.27, CO 4.6 µm. These bands are why brown dwarfs look the way they do at these wavelengths.
4. **"102-band scrubber."** A slider over the channels, where each step is the co-add at that channel. It shows *spectral* change (a brown dwarf appearing at 4.5 µm and vanishing at 3.3 µm), alongside the blink for *time* change. This is our main answer to the challenge's "display those 102 bands" consideration.
5. **False-colour RGB.** Three λ ranges (for example D1 / D3 / D6) normalized separately. Cold brown dwarfs show up deep red. Arrays are server-side; compositing is client-side.
6. **Registration QC + motion fit.** Centroid Gaia stars in each frame and report the per-frame offset and rms. Measure the target's centroid per epoch with the ePSF and fit PM ± σ. This turns "it looks like it moved" into "it moved 1.6 ± 0.2 px along the Gaia vector", which is Validity evidence for judges.
7. **Shift-and-stack (Tier 3).** Shift each epoch by a hypothesized PM (default: catalogue PM) before summing, so a faint mover adds up instead of smearing. Aimed at WISE 0855.
8. **Light curve / epoch-ratio spectrum (Tier 2b).** For RW Aur and R Dra, divide the spectrum at epoch N by the spectrum at epoch 1 (per channel). This is the variability signal without bandpass confusion. Plot time series per channel only where enough visits exist (near the ecliptic poles).

---

## 5. Validation built into the tests (CI stays offline)

| Test | Proves |
|---|---|
| Inject a Gaussian of known µJy on a 3.075″ grid → aperture phot recovers it within 5% | Units and Ω are right (§2.1) |
| Inject a mover with known PM across 3 synthetic epochs → motion fit recovers it within 0.2 px | Alignment and centroiding |
| Two epochs with different channel mixes, constant source → matched-λ difference ≈ 0 while the naive one is not | §2.4 actually fixes the problem |
| Flagged pixel with only `SOURCE` set stays unmasked | §2.5 |
| PM propagation of Barnard J2016 → 2026 matches the SIMBAD/astropy `apply_space_motion` result | Overlay positions |
| One real 1–2 small FITS fixture → full pipeline runs end to end | HDU names, WCS, WCS-WAVE parsing |

Live checks on the five targets go into `docs/VALIDATION.md` with screenshots. Cross-check one spectrum against IRSA's Spectrophotometry Tool. For brown dwarfs, compare the spectral shape against arXiv:2607.00543 (SPHEREx spectra of nearby brown dwarfs) **[check which targets it covers]**.

---

## 6. Order of work, mapped to the team milestones

| When | Work | Exit test |
|---|---|---|
| **Now–1:30** | Check IRSA status. If TAP is still down, try SIA2 and the S3 path. Run `spike_one_cutout.py` on Barnard. Dump the real headers (FLAGS bit names, WCS-WAVE layout, units). Save 1–2 tiny fixtures. Fix `config.yaml` band edges and units | A real cutout PNG. Fixtures committed |
| 1:30–5:00 | `query_exposures` (one TAP query, all bands), `download_cutouts` (pool + retry + cache), `reproject_to`, per-detector co-add, `/api/frames` returning `.bin` blobs. `resolve_name` via Sesame + PM | **M1**: Barnard blink in the browser from real data |
| 5:00–9:00 | Jobs + progress, `/exposures`, Gaia overlay at frame MJD, Dockerfile deploy with a warm cache, `precompute.py` for 5 targets | **M2**: public URL works; 5 presets work with the backend off |
| 9:00–12:00 | λ tagging + channel bins, matched-λ difference, σ-scaled difference, `/spectrum` with forced phot, units test | Dipole for Barnard; first real spectrum |
| Sun 8–12 | Registration QC + motion fit, epoch-ratio spectrum / light curve, RGB arrays, `/meta`, 5-target validation write-up | Tier 2 done; VALIDATION.md filled |
| Sun 12–3 | Hardening: circuit breaker, cache cap, error messages, docs. Tier 3 only if time (shift-and-stack, 102-band scrubber polish, CatWISE) | **Freeze 3 PM** |

**Cut order if behind:** shift-and-stack → light curves → motion fit → channel scrubber → jobs (fall back to a long GET + precompute). Never cut: correct units, matched-λ difference, and precomputed fallback.

---

## 7. Open questions

1. Confirm the frontend boundary at the top of this file with C.
2. Backend host: Cloud Run and AWS both allow long requests. AWS us-east-1 is next to the S3 copy of the data **[verify the free-tier limits today]**.
3. The `API.md` changes in §3.6 need one PR that everyone reviews before ~5 PM, so C can build against the new mocks.
