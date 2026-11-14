# Validation — five test targets

Owner: B. Real SPHEREx DR1 + QR3 level-2 data, through the same pipeline the API serves. Positions come from CDS Sesame (SIMBAD) plus proper motion. Figure: `docs/img/presets_check.png` shows the first pass, the last pass, and last − first. Circles mark the proper-motion prediction at each pass's mean exposure time.

| Target | Band (λ at target) | Passes, exposures | Result | Evidence |
|---|---|---|---|---|
| Barnard's Star | D2 (1.35–1.41 µm) | E1 18, E2 18, E3 25 | ✅ **Moves north**: clean +/− dipole in E3 − E1, matching Gaia's +10.4″/yr. Saturated core (OVERFLOW/BLOOM), so read position from centroids, not the brightest pixel | Diff panel; `test_frames_end_to_end_barnard_moves_north` |
| ε Indi B | D3 (1.97–2.07 µm) | E1 25, E2 23, E3 12, E4 34 | ✅ Detected at 234σ. Shifts along the predicted track between E1 and E4 | Diff panel |
| WISE 0855−0714 | D6 (4.72–4.94 µm) | E1 3, E2 20, E3 21 | ✅ **Detected** at 20σ in E3 (3.6σ in the 3-exposure E1), at the proper-motion-predicted position. Motion visible in E3 − E1 | Diff panel; S/N from `frontend/precomputed/wise-0855` |
| RW Aurigae | D2 (1.35–1.37 µm) | E1 18, E2 18, E3 18 | ✅ **Brightens**: peak 102 → 157 MJy/sr (+54%) E1 → E3, single-sign residual, no dipole. λ_eff differs by only 0.02 µm, so this is very likely real variability; aperture photometry (phase 3) will quantify it | Diff panel |
| R Draconis | D2 (1.34–1.43 µm) | E1 9, E3 10 (7 passes exist across detectors) | ⚠️ Loads and blinks, but only 2 D2 passes. Near the north ecliptic pole there are ~6,600 candidate observations; the 1,500-observation search cap kept 826 exposures, mostly on D3/D6 (~266 each) and only 19 on D2. **Fix (phase 3/4):** pick polar candidates per detector before spending the cap, so each band gets an even time series | `frontend/precomputed/r-dra` |

## Astrometry

- **Stacked frames vs Gaia DR3:** bright field stars (G < 13.5) in Barnard's D2 stacks sit 0.05–0.08 px rms (≈0.2″) from Gaia positions propagated to each pass. Every one of the 15 brightest peaks has a Gaia source within 0.7 px (Barnard itself: 1.8 px, saturated core).
- **Single exposures:** within ~1.3 px (4″) of Gaia, judged from Barnard's flux-weighted centroids.

## Known limits

- **Passes per position:** 3–4 at mid ecliptic latitude (May 2025 → Oct 2026). Near the ecliptic poles coverage is nearly continuous.
- **Bandpass changes between passes:** a detector stack mixes different wavelengths each pass. WISE 0855: E1 averages 4.94 µm, E3 4.72 µm. For a brown dwarf that alone changes brightness. Compare brightness only after matched-wavelength stacking (phase 3); motion comparisons are unaffected.
- **Saturation:** Barnard's Star (D1, D2, D4) and RW Aur (D2) have OVERFLOW cores. Images stay usable, but their photometry is flagged.
- **Faintest detection so far:** WISE 0855 in D6. It is invisible at short wavelengths, as expected for a Y dwarf.
