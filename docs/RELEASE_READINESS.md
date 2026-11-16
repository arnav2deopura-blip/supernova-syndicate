# Final frontend and backend repair record — 15 November 2026

The local implementation addresses the code defects in the repository review. This is
not a certification of every possible astronomical field, scientific fit, archive, or
production deployment. The current public deployment has not been updated by this audit.

## Executed evidence

- Python: **144 tests** covering science controls, cache concurrency, queue bounds,
  restart recovery, native detector origin/PSF selection, partial downloads and edge fields.
- JavaScript: **50 tests**, including strict backend-only mode, malformed envelopes,
  oversized arrays, missing channels, stale metadata, stalled jobs, legacy timeouts,
  static-view timer suspension and hidden-tab playback.
- Deterministic browser regression: all seven views, shared zoom, PNG/research exports,
  skippable tour, phone width, source URLs, strict outage and invalid responses.
- Full interaction audit: playback/stepping, display settings, PNG/movie/CSV exports,
  Advanced, guide, tour, map readiness/selection, cancellation and invalid coordinates.
- Measurement audit: all five targets, per-pass channel range, spectral filmstrip,
  click spectrum and spectrum export. These use authentic saved inputs.
- `LIVE_VALIDATION.json`: eight **empty-cache** region builds through real API routes,
  actual archive retrieval and blob decoding, both whole-band and matched images,
  including matched FITS downloads. Targets: Barnard's Star, Epsilon Indi B, WISE 0855,
  RW Aurigae, R Draconis, a nonpreset offset, RA wrap, and a polar field.
- `LIVE_VALIDATION_FINAL.json`: the same eight regions replayed with final processing
  code and authentic downloaded inputs. Its manifest must match the saved-frame manifest.
  This replay is **not** represented as a second empty-cache download test.
- `BROWSER_LIVE_VALIDATION.json`: typed RA 269.47°, Dec +4.79°, FOV 0.04°, followed by
  an actual clicked sky-map region, each through completed real dated images; no saved fallback.
- `NATIVE_ARCHIVE_VALIDATION.json`: independently returned IRSA cutout vs S3, agreeing
  on wavelength, target flags, raw IMAGE-minus-ZODI pixel and EPSF. Local background
  subtraction depends on stamp extent, so processed pixel values are not compared blindly.
- Clean local installation and full launcher readiness verified on this Mac. Linux CI
  jobs are configured; their remote execution is not claimed as a completed local test.

## Resolution of the 26 findings

| Finding | Implementation and verification |
| --- | --- |
| 1. Cold validation | Empty-cache real archive runner and completed browser coordinate/map workflows, separate from saved data. |
| 2. Fresh/provenance | Backend only disables saved fallback; built/server-cache/saved sources are distinct. |
| 3. Missing channels | Every requested channel is required; absent channels give an empty result and an actionable notice. |
| 4. Field footprints | FOV is part of selection identity; S3 search and chip checks include the field extent. TAP point results are augmented by that scan. |
| 5. Stamp races | Bounded keyed locks, unique atomic temporary writes and complete FITS writes. |
| 6. Derived values | Positive finite uncertainty guards; single shared-channel magnitude only; temperature withheld. |
| 7. Spatial bandpass limits | Centre-matched quick-look labels, identical-channel masks, strict cube option and explicit off-centre caveats. |
| 8. Quality semantics | Output/stamp masked percentages are distinct from target contamination; unmeasured values remain null. |
| 9. Range metadata | Actual contributing cell times/IDs/masks and cube provenance; errors never pretend a narrower range succeeded. |
| 10. Epoch/catalogs | Actual resolver epoch retained without PM; fresh names keep resolved coordinates; spherical tangent propagation and expanded Gaia cone. |
| 11. Partial retrieval | Selected/retrieved/failed counts, sampling policy, visible warning and explicit missing-download retry. |
| 12. Resource limits | Bounded queue, per-connection outstanding-work limit, queued expiry, deduplication and bounded direct builds, estimated native-pixel budgets before downloads; 429 with retry guidance. |
| 13. Restarts | Persistent job snapshots, readable interruption and retry, awake-replica default, optional mounted cache configuration. **Volume provisioning remains deployment work.** |
| 14. Pruning | Dependency verification and leases, atomic writes, referenced-blob protection and rebuild on stale metadata. |
| 15. Fresh releases | Index/content/code/config/runtime/calibration fingerprints; reviewed index-refresh workflow and documented release process. |
| 16. Archive compatibility | Authentic native fixture verifies detector origin and nearest PSF; native/S3 live comparison passes. **TAP uptime remains externally limited.** |
| 17. Response validation | Envelope validation before dereference, shape/time/value checks, bounded bytes/pixels and readable errors. |
| 18. Stalled waits | Bounded transfers and polling, legacy-compatible abort, listener cleanup and one bounded expired-job recovery. |
| 19. Shared backend | Non-default API identity survives URL rewrites and fresh browser contexts. |
| 20. Stale overlays | FOV/band/centre changes reset supplementary data; late callbacks check request ownership. |
| 21. Optional work | Images first; research analyses start in Advanced and pending state prevents duplicates; startup metadata is lightweight. |
| 22. CI | Python, Node and portable deterministic Playwright jobs; separate opt-in live workflow. |
| 23. Setup | Supported Python, pinned dependencies/constraints, clean/existing venv repair, `.env`, optional plotting requirements and actual readiness checks. macOS Bash empty arrays fixed. |
| 24. Research reproducibility | FITS manifest/coverage, JSON research export, full input identifiers, processing/config/runtime versions, reliability notes and independent native fixture. Formal precision claims remain exploratory. |
| 25. Documentation | Verified QR3 DOI, acknowledgement source, names/AI credits, historical-study labels, current saved frames/manifests, permitted fixture/data policy. |
| 26. Scope/publication | Smooth and synchronized side-by-side restored; real map completion tested; production release gates below are explicit. |

## Data products and interpretation

`frontend/precomputed/manifest.json` lists the generation time, processing hashes and
actual per-pass exposure counts for the refreshed five saved image datasets. These
numbers supersede the historical tables in `VALIDATION.md`. Older optional fit/spectral
bakes are labeled historical when they lack a processing fingerprint; their numerical
results have not been silently relabeled as freshly validated science.

Matched images remain a field-centre quick look. Off-centre wavelength variation,
blends, saturation, PSF changes, resampling covariance and bounded archive sampling can
produce residuals. A candidate or sigma pixel is not a confirmed discovery. Research
exports record this limitation. Synthetic controls and successful image retrieval do
not independently validate every fitted uncertainty or astrophysical interpretation.

## Required publication actions

1. Commit and deploy this frontend and backend together. Validate the actual deployed
   revision from a clean browser over HTTPS: custom coordinates and clicked map region
   to completed frames, blobs/jobs/CORS, exports and mobile controls. Local evidence
   does not certify the older public deployment.
2. Attach durable cache storage for hosting that must survive container replacement.
   The Azure script supports an existing registered Files volume; it has not been
   provisioned here. Keep one awake replica for active use.
3. IRSA TAP intermittently returned 502/proxy errors or timed out during checks.
   The documented point query and parser are guarded; the tested S3 footprint path
   supplies real observations. Recheck TAP when available. Native cutouts themselves
   passed the recorded compatibility comparison.
4. Before making publication-level measurement claims, independently reproduce the
   fitted science with suitable controls and uncertainty validation. The UI and
   exports intentionally describe these products as exploratory.

No cloud deployment, Git commit, push, external message, or storage purchase was made
by this repair task. Team: Chakshu Parnam, Arnav Deopura, and Mohammed Zaid Khan.

Final check receipt: `RELEASE_CHECKS.json`. File integrity inventory: `RELEASE_INVENTORY.json`. Desktop and phone screenshots: `img/frontend_final.png` and `img/frontend_mobile.png`.
