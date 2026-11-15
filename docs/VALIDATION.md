# Validation — five test targets

Owner: B. Real SPHEREx DR1 + QR3 level-2 data, through the same pipeline the API serves. Positions come from CDS Sesame (SIMBAD) plus proper motion. Figure: `docs/img/presets_check.png` shows the first pass, the last pass, and last − first. Circles mark the proper-motion prediction at each pass's mean exposure time.

| Target | Band (λ at target) | Passes, exposures | Result | Evidence |
|---|---|---|---|---|
| Barnard's Star | D2 (1.35–1.41 µm) | E1 18, E2 18, E3 25 | ✅ **Moves north**: clean +/− dipole in E3 − E1, matching Gaia's +10.4″/yr. Saturated core (OVERFLOW/BLOOM) in every detector, so read position from wing fits/centroids, not the brightest pixel. Measured μ (D5+D6): 10341 ± 210 mas/yr | Diff panel; `test_frames_end_to_end_barnard_moves_north` |
| ε Indi B | D3 (1.97–2.07 µm) | E1 25, E2 23, E3 12, E4 34 | ✅ Detected at 234σ. Shifts along the predicted track between E1 and E4 | Diff panel |
| WISE 0855−0714 | D6 (4.72–4.94 µm) | E1 3, E2 20, E3 21 | ✅ **Detected** at 20σ in E3 (3.6σ in the 3-exposure E1), at the proper-motion-predicted position. Motion visible in E3 − E1 | Diff panel; S/N from `frontend/precomputed/wise-0855` |
| RW Aurigae | D2 (1.35–1.37 µm) | E1 18, E2 18, E3 18 | ✅ **Brightens**: peak 102 → 157 MJy/sr (+54%) E1 → E3, single-sign residual, no dipole. λ_eff differs by only 0.02 µm, so this is very likely real variability; aperture photometry (phase 3) will quantify it | Diff panel |
| R Draconis | D2 (1.34–1.43 µm) | E1 9, E3 10 (7 passes exist across detectors) | ⚠️ Loads and blinks, but only 2 D2 passes. Near the north ecliptic pole there are ~6,600 candidate observations; the 1,500-observation search cap kept 826 exposures, mostly on D3/D6 (~266 each) and only 19 on D2. **Fix (phase 3/4):** pick polar candidates per detector before spending the cap, so each band gets an even time series | `frontend/precomputed/r-dra` |

## Astrometry

- **Stacked frames vs Gaia DR3:** bright field stars (G < 13.5) in Barnard's D2 stacks sit 0.05–0.08 px rms (≈0.2″) from Gaia positions propagated to each pass. Every one of the 15 brightest peaks has a Gaia source within 0.7 px (Barnard itself: 1.8 px, saturated core).
- **Single exposures:** within ~1.3 px (4″) of Gaia, judged from Barnard's flux-weighted centroids.

## Items 3–5: measured results (14 Nov 2026)

Numbers below are from the precomputed products in `frontend/precomputed/<target>/` (`motion_*.json`,
`lightcurve_*.json`, `spectrum_*.json`, `cube_*.json`), made by `python scripts/precompute.py --science`.
Re-run it after any pipeline change and update this table.

### Proper motion (`/api/motion`, item 5)

| Target | Band, exposures used | SPHEREx μ (mas/yr) | PA (°) | Reference | Agreement | χ²/dof |
|---|---|---|---|---|---|---|
| ε Indi B | D3, 80 in 4 passes | **4631 ± 33** | 121.5 ± 0.4 | Gaia DR3 4684, PA 121.8 | **1.2σ** | 0.86 |
| WISE 0855−0714 (not in Gaia) | D6, 40 in 3 passes | **8843 ± 1332** | 282.7 ± 8.6 | SIMBAD 8152, PA 274.7 | **0.7σ** | 0.68 |
| Barnard's Star | D5+D6, 106 in 3 passes | **10341 ± 210** | 351.7 ± 1.2 | Gaia DR3 10393, PA 355.6 | 2.4σ (speed 0.5 %, PA 3.3σ) | 5.1 |

- **ε Indi B is the headline:** a 0.7 % proper motion, independent of Gaia except for registration
  stars. Fitting parallax too (`fit_parallax=1`, measured before the exposure-list refresh) gave
  ϖ = 280 ± 23 mas against Gaia's 270.7: a 12σ parallax, consistent at 0.4σ.
- **WISE 0855:** a brown dwarf Gaia cannot see. Motion detected at 6.6σ from D6 alone. Errors are large
  because the target is S/N ≈ 5 per exposure. The earlier plan expected ~0.3″/yr; ~1.3″/yr is what the
  data support with per-exposure fits.
- **Barnard's Star is saturated in every detector**, not just D1/D2/D4. Its core is OVERFLOW in 75–88 % of exposures
  in D2, D3, D5 and D6. The few clean exposures all fall in one pass, so there is no unsaturated subset
  to fit; every point is an ePSF wing fit (χ²/dof ≈ 4–6, covariance scaled up). Per detector (Gaia fixed parallax):

  | Detector | n | μ (mas/yr) | PA (°) | vs Gaia |
  |---|---|---|---|---|
  | D2 | 48 | 8960 ± 636 | 349.4 ± 4.1 | 2.0σ |
  | D3 | 55 | 8351 ± 624 | 2.4 ± 4.3 | 2.6σ |
  | D5 | 48 | 10560 ± 338 | 351.3 ± 1.8 | 1.7σ |
  | D6 | 58 | 10243 ± 276 | 351.8 ± 1.5 | 1.8σ |
  | **D5+D6 (preset)** | 106 | **10341 ± 210** | 351.7 ± 1.2 | 2.4σ |
  | D2+D3+D5+D6 | 209 | 10007 ± 194 | 352.4 ± 1.1 | 2.5σ |

  The MWIR detectors give 2–3× smaller errors, so the preset uses D5+D6 (`motion_D5-D6.json`). The total speed
  then matches Gaia to 0.5 % (0.25σ). **What remains is a direction bias that every detector shares:** pmra
  comes out ~0.6″/yr too far west (−1490 ± 210 vs Gaia −802; PA 3.9° off). Passes E1 and E3 have the same detector
  orientation (detector +y at PA 181–185°) and the same season (so the same parallax), yet their east offset from
  Gaia differs by 0.9–1.3″ in both D5 and D6. So the bias is neither a fixed detector-frame bias nor parallax.
  It matches the ~0.15–0.25 px per-exposure wing-fit scatter, which three passes can't average down. The
  bootstrap error on pmra (278 mas/yr) is larger than the formal one. Treat Barnard's motion as "speed
  confirmed, direction to ~4°". **ε Indi B (unsaturated) is the precision result.**
- **Fitting parallax does not work for Barnard:** D5+D6 gives 220 ± 83 mas against Gaia's 547. Saturated
  wing fits can't resolve a 0.09 px annual wobble.
- **Single-exposure wing fits:** on the six Barnard fixtures (saturated D1/D4), ePSF positions are 0.17–0.25 px
  rms from Gaia, against ~1.3 px for the old flux-weighted centroid
  (`test_wing_fit_on_saturated_barnard_lands_on_gaia`).
- **Registration:** a median of 3 (Barnard D2) to 5 (ε Indi B D3) Gaia reference stars per stamp, with residual
  rms 0.02–0.04 px.

### Light curves (`/api/lightcurve`, item 4)

| Target | Band | Bins (scale) | χ² / dof | Comparison stars (rms) | Verdict |
|---|---|---|---|---|---|
| RW Aur | D2, 54 points | E1 0.884 → E2 1.125 → E3 1.135 | 75.8 / 2 | 8 Gaia stars, **1.3 %** | **Variable: +28 % E1 → E3**, grey within errors (`shape_changed` false) |
| R Dra | D2, 83 points in 5 bins (3 passes) | (meaningless) | — | 1.5 % | **`reliable: false`**: median point error 64 %. R Dra (~32 Jy at 1.3 µm) is too saturated for wing fits |

- RW Aur's +28 % replaces the earlier peak-pixel +54 %. That number used peak surface brightness on a
  saturated core and a wavelength mix; the template method corrects for the bandpass.
- **R Dra sampling is fixed:** with orientation in the pointing index, D2 coverage went from 19 exposures in
  2 passes to 83 in 3 passes / 5 bins. The photometry is now the limit: no light-curve claim is made.
- **Null check:** comparison stars (G 12–16) are flat to 1.3–1.5 % per bin, the empirical systematic floor.

### Spectral cube (`/api/cube`, item 3) and spectra (item 1)

- **WISE 0855, D6:** 17 channels from 40 exposures (1–4 per channel), shared stretch; the target is in
  every channel. `recommend_per_pass` is true (8″/yr mover), and a per-pass cube is baked too.
- **WISE 0855 flux:** D6 444 ± 28 µJy (inverse-variance mean of unflagged, deblended D6 points, 4.4–5.0 µm).
  WISE W2 (4.6 µm) ≈ 13.9 mag ≈ 480 µJy **[verify W2 mag]**, so the calibration chain (MJy/sr → µJy through
  `OMEGA_MEDIAN`) agrees to ~7 %. The earlier 531 ± 25 µJy was ~20 % high: it included light from a Gaia neighbour
  (see below).
- **WISE 0855 across all 102 channels** (`spectrum_all.json`, 230 points, D1–D6; cubes `cube_D3..D6.json`):

  | Detector | λ (µm) | Mean flux (µJy), deblended | Before deblending |
  |---|---|---|---|
  | D1 | 0.75–1.09 | −18 ± 7 | 197 ± 27 (7σ, fake) |
  | D2 | 1.11–1.63 | −17 ± 6 | 144 ± 24 |
  | D3 | 1.65–2.39 | 0 ± 5 | 148 ± 16 |
  | D4 | 2.44–3.77 | 16 ± 6 | 97 ± 11 |
  | D5 | 3.83–4.41 | 303 ± 15 (20σ) | 381 ± 16 |
  | D6 | 4.44–4.99 | 444 ± 28 (16σ) | 525 ± 25 |

  ✅ **A Y-dwarf spectrum:** nothing below 3.8 µm (H₂O and CH₄ absorption). The flux climbs steeply through D5
  (~100 µJy at 3.85 µm → ~700 at 4.3–4.4 µm), peaks at 4.3–4.7 µm and fades past 4.8 µm (150–300 µJy at 4.95–5.0).
  The CH₄ band at 3.3 µm can't be seen as a separate dip, because the whole 2.4–3.7 µm range is already at zero
  (D4C12–C16: −23 to +22 µJy, all < 1σ). D1/D2 are slightly negative (−2.5σ), which sets a systematic floor of
  ~±20 µJy from imperfect neighbour subtraction.
- **Deblending (why the first numbers were wrong):** WISE 0855 is moving toward a G = 16.3 Gaia star. It is
  11.8″ away in E1, 7.6″ in E2 and 4.8″ in E3, inside the 7.5″ PSF. Fitting the target alone put that star's light
  into every channel: a fake 7σ "detection" at 0.8 µm. Forced fits in `/api/spectrum` now fit Gaia neighbours
  within 5 native px at fixed positions, together with the target (`n_deblended` per point; `blend` lists those
  within 2 px). Synthetic check at the three real separations: the target-only fit is off by −49 %, +130 % and
  +335 %; the joint fit recovers the flux with a mean pull of ≤ 0.1 and a spread of 0.9–1.1
  (`test_forced_fit_deblends_known_neighbour`). Only forced (faint) fits change; the other presets' spectra are PSF
  or wing fits and are unchanged. RW Aur's points now carry `blend` (its companion), which wing fits don't deblend.
- **Channel assignment:** the calibration `CHANNEL_MAP` and per-pixel WCS-WAVE + channel table agree on
  ≥ 90 % of pixels on all six fixtures (`test_channel_map_agrees_with_wcs_wave`).

### Matched-wavelength frames (`/api/frames?matched=1`)

λ at the target, per pass, before (plain) and after (matched). From `frames_matched_<band>.json`, 14 Nov 2026.

| Target | Plain λ_eff by pass (µm) | Matched λ_eff (µm) | Channels kept | Exposures kept |
|---|---|---|---|---|
| Barnard's Star D2 | 1.352 / 1.305 / 1.398 | 1.362 / 1.357 / 1.357 | 9 of 17 | 28 of 48 |
| ε Indi B D3 | 2.016 / 1.960 / 2.065 / 2.014 | 2.038 / 2.056 / 2.038 / 2.054 | 5 | 27 of 85 |
| WISE 0855 D6 | 4.944 / 4.706 / 4.736 | 4.914 / 4.893 / 4.914 | 2 | 6 of 40 |
| RW Aur D2 | 1.352 / 1.363 / 1.327 | 1.307 / 1.326 / 1.327 | 9 | 28 of 41 |
| R Dra D2 | 1.311 / 1.343 / 1.344 | 1.350 / 1.348 / 1.363 | 17 | 82 of 83 |

- The spread between passes drops from up to 0.24 µm to ≤ 0.02 µm (within one channel, since exposures land
  anywhere inside a channel).
- **RW Aur stays variable once matched:** the 3×3 target box goes 64.9 → 96.3 → 99.6 MJy/sr (E1 → E3, +53 %).
  That is consistent with the plain frames (+36 %) and with the template light curve. The peak pixel is
  saturated, so `/api/lightcurve` (+28 %) remains the number to quote.
- Synthetic check: a constant red source sampled in different channel mixes fades by > 40 % in plain frames
  and changes by < 2 % in matched ones (`test_matched_frames_remove_bandpass_mix`). Equal weight per
  channel (`test_matched_frames_equal_weight_per_channel`).

### Not yet validated

- Ensemble proper-motion null test on field stars (needs per-source motion in the field; same code as
  discovery mode).
- R Dra period vs AAVSO: needs an unsaturated band.

## Known limits

- **Passes per position:** 3–4 at mid ecliptic latitude (May 2025 → Oct 2026). Near the ecliptic poles coverage is nearly continuous.
- **Bandpass changes between passes:** a plain detector stack mixes different wavelengths each pass (WISE 0855: E1 4.94 µm, E2 4.71 µm). For a brown dwarf, that alone changes brightness. `/api/frames?matched=1` fixes this (see below); motion comparisons are unaffected either way. The price is S/N: WISE 0855 keeps only 2 of 17 channels (2 exposures per pass), because E1 has just 3 exposures.
- **Saturation:** Barnard's Star (every detector checked: D1–D6), RW Aur (D2) and R Dra (D2) have OVERFLOW cores. Images stay usable. Photometry and astrometry fall back to ePSF wing fits (flagged): fine for RW Aur (~10 % per point), degraded for Barnard, useless for R Dra (`reliable: false`).
- **Faintest detection so far:** WISE 0855 in D5/D6 (~5σ per exposure). It is invisible below 3.8 µm, as expected for a Y dwarf.
- **Blending:** with 6″ pixels, a neighbour within ~30″ biases a faint target's photometry either way: close ones add light; at ~2 px the wing is absorbed into the fitted background and the target comes out low. Forced fits deblend Gaia sources; sources missing from Gaia (other red brown dwarfs, galaxies) are not modelled. CatWISE would close that gap.
