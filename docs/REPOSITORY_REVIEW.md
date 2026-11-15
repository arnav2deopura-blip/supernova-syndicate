> Implementation follow-up: the fixes, current acceptance evidence, and remaining external
> publication gates are listed in `RELEASE_READINESS.md`. The findings below preserve the
> original audit and its severity; their original “Status” lines describe the reviewed baseline.

# Final repository issue and scenario review

**Snapshot:** `94e10aa`, reviewed 15 November 2026. Application code was not changed by this review.

## Scope and evidence

Inventoried all **395 tracked files** (see `REVIEW_INVENTORY.json`). Static checks covered Python syntax, JSON/notebook parsing, gzip readability, FITS primary-header signatures, float32 byte alignment, and local saved-array references/dimensions. No broken local references or structural errors were found. Binary checks do not prove scientific authenticity, correct calibration or image appearance. Source review concentrated on request/data/processing/UI/deployment paths; this is not a formal verification of every algorithm.

Executed all **40 frontend tests: passed**. Reproduced fault scenarios in isolated Chrome with injected network responses and real repository modules, plus a synchronized concurrent-cache-write test. No new five-target cold archive integration run or production end-to-end validation was performed. Earlier passing backend/browser runs remain historical evidence, not newly repeated results.

P0 = blocks the claim of independently validated core functionality. P1 = address before broad public/research use. P2 = reliability, maintainability or explicit release-scope work. A confirmed code path is distinguished from a reproduced failure and a verification gap.

## 1. [P0] Validation does not prove fresh retrieval for all five required targets

**Status:** Verification gap. **Evidence:** `tests/browser/measurements.py; tests/test_pipeline.py; docs/VALIDATION.md`.

**Issue and scenario:** The browser suite explicitly waits for Saved badges. Pipeline tests replace archive I/O with fixtures. These test the viewer and processing, but are not five independent cold archive-to-browser validations.

**What to do:** Add an opt-in integration suite using a separate empty cache and strict live-only frontend mode. Run every required target plus several arbitrary non-preset fields. Save requested coordinates/epoch, archive records, download counts, processing version, dates, quality warnings and screenshots. A non-detection or saturation limitation is an outcome, not a reason to substitute another field.

**Acceptance condition:** Each run proves real retrieval and processing; failures are recorded. Keep offline unit tests and cached viewer tests as separate test categories.

## 2. [P0] Fresh mode is not strict and Live does not prove an archive download

**Status:** Reproduced. **Evidence:** `frontend/js/api.js: call/preferSaved; backend/server.py: frames/_cached_frames`.

**Issue and scenario:** Injected HTTP 503 with fresh=1 still displayed Saved observations. Even a successful live API request may use the backend cache. The current badge cannot establish a cold retrieval.

**What to do:** Provide distinct saved, server-cached and newly-built provenance. Add strict live-only behavior that never falls back, and use an isolated empty server cache for validation. Explain cached fallback to ordinary users; do not remove useful caches from normal use.

**Acceptance condition:** An outage in strict mode is an error. Ordinary mode can use a clearly labeled exact matching bake. Validation verifies downloads rather than a badge alone.

## 3. [P0] A missing requested channel silently narrows the selected range

**Status:** Reproduced. **Evidence:** `frontend/js/bands.js: framesFromCube/passesWith`.

**Issue and scenario:** A synthetic control cube containing only D2C08 and D2C10 returned a valid frame for the requested range 8–10, with skipped=0. The filter removes globally absent channels before checking completeness.

**What to do:** Construct the complete requested channel list first. Require every requested channel for every retained pass. If impossible, report the missing channels and offer an explicit narrower selection without silently applying it.

**Acceptance condition:** Requesting 8–10 with channel 9 absent never returns a frame described as the full requested range. Test missing entire channels as well as channels missing in only one pass.

## 4. [P1] Larger-field searches discover centre coverage, not all intersecting exposures

**Status:** Confirmed code path. **Evidence:** `backend/spherex_client.py: query_exposures/_tap_exposures; backend/s3_archive.py: find_exposures`.

**Issue and scenario:** The archive query uses a point at RA/Dec; the S3 path checks whether that point is on-chip. fov does not expand discovery. Exposures covering the patch edge but missing its centre are omitted.

**What to do:** Query intersection with the requested celestial footprint in TAP and S3. Include FOV in exposure-list cache keys. Retain partial coverage with per-pixel counts and honest coverage metadata.

**Acceptance condition:** A fixture crossing a detector edge includes both overlapping exposures, even if only one contains the patch centre; large FOV does not silently miss available edge data.

## 5. [P1] Concurrent cache writers share temporary filenames

**Status:** Reproduced. **Evidence:** `backend/cache.py: put_json; backend/server.py: _save_blob; backend/spherex_client.py: fetch_stamps`.

**Issue and scenario:** Two synchronized writes through the actual put_json implementation produced one success and one FileNotFoundError. Different products share downloads, and their product locks do not serialize every lower-level cache key.

**What to do:** Use unique temporary files in the destination directory and atomic replacement, plus per-key single-flight locks where downloads are expensive. Apply equivalent protection to FITS export files and stamp/blob writes.

**Acceptance condition:** Concurrent frame, spectrum and mover jobs sharing a stamp or metadata key all finish with readable, complete files; no writer loses its temporary path.

## 6. [P1] Derived physics accepts invalid values and unsupported spectral comparisons

**Status:** Reproduced numeric guards; scientific validation gap. **Evidence:** `frontend/js/astro.js; frontend/js/advanced.js`.

**Issue and scenario:** distance(-10,-1) returned -100 pc; distance(10,0) returned a zero-error result. passMagnitudes accepted a zero-error flux. It also combines positive samples across changing wavelengths; the colour-temperature fit invents a 5% error when one is absent.

**What to do:** Require finite positive uncertainties and valid parallax/significance. Derive magnitudes only for a defined comparable bandpass; do not merge arbitrary wavelengths into one research magnitude. Remove colour-temperature output until uncertainty, fit quality, epoch mixing and model limitations are validated.

**Acceptance condition:** Invalid values return an unavailable reason. Constant sources with differing spectral sampling do not acquire a spurious magnitude change or research temperature.

## 7. [P1] Matched images are centre-matched approximations across the field

**Status:** Confirmed limitation. **Evidence:** `backend/cube.py: build_matched_frames/build_cube/strict_image; frontend/js/app.js: renderBadges`.

**Issue and scenario:** The backend labels stamps by wavelength at the field centre. It documents an edge-dependent wavelength difference and averages available channels with nanmean. A Fair comparison badge can be read as a guarantee for any clicked off-centre source.

**What to do:** Label this as centre-matched quick-look data. For quantitative off-centre brightness claims use strict per-pixel spectral selection or recompute at the source, require identical channel coverage, and carry masks/coverage into comparisons.

**Acceptance condition:** An off-centre constant source with different channel coverage is warned or excluded from brightness claims. Test across FOV sizes and masked edges.

## 8. [P1] Quality percentages can be mistaken for clean data

**Status:** Confirmed code path. **Evidence:** `backend/pipeline.py: coadd_epochs; backend/cube.py: build_matched_frames; backend/server.py: exposures; frontend/js/advanced.js`.

**Issue and scenario:** Frame flag_fraction is the fraction of non-finite output pixels, while the UI says flagged %. Exposure metadata missing from the processing cache is defaulted to 0.0. Neither means the exposure has no contamination.

**What to do:** Separate masked/output coverage, actual flag fractions and target contamination. Return null for unmeasured exposure quality. Make the labels and schemas agree and retain saturation/contamination warnings.

**Acceptance condition:** Unprocessed exposures never show an invented 0% quality assessment; masked fraction and target flags are distinct.

## 9. [P1] Channel-range metadata and provenance inherit unrelated base-frame values

**Status:** Confirmed code path. **Evidence:** `frontend/js/app.js: loadRange/loadColours; frontend/js/bands.js: framesFromCube`.

**Issue and scenario:** loadRange spreads state.base onto images made from a cube, retaining the base provenance. framesFromCube copies base dates and flag_fraction even though a channel subset contributes different exposures. Colour views also retain base badges.

**What to do:** Build metadata from the actual selected cube cells: source, observation IDs, time bounds, masks, wavelengths and units. Mark unavailable per-range quantities as unavailable. Base badges must reflect the displayed product.

**Acceptance condition:** A live cube over a saved base is labeled correctly; dates, IDs and quality fields describe only contributing selected-channel observations.

## 10. [P1] Position epochs and catalog selection need stronger handling

**Status:** Confirmed limitations. **Evidence:** `backend/catalogs.py: resolve_name/gaia_sources; frontend/js/app.js: searchName`.

**Issue and scenario:** Resolution reports the current year even if no PM was supplied and the J2000 position was not propagated. Preset searches overwrite resolved coordinates with baked positions, including fresh mode. Gaia overlay queries use an unexpanded J2016 cone, which can exclude stars that moved into a small current field.

**What to do:** Preserve the actual position reference epoch and whether propagation occurred. Distinguish saved-demo coordinates from a fresh resolved position. Widen catalog queries for proper motion then filter after epoch propagation.

**Acceptance condition:** Test missing PM, very fast sources, small FOV, RA wrap and polar cases. A fresh name request does not silently substitute baked coordinates.

## 11. [P1] Partial archive failures and search thinning are not exposed as completeness information

**Status:** Confirmed code path. **Evidence:** `backend/spherex_client.py: fetch_stamps; backend/s3_archive.py: candidate_plan; backend/pipeline.py: load_stamps`.

**Issue and scenario:** If some downloads fail, successful ones are used without a failed-download summary. Candidate budgets deliberately thin dense fields. Users cannot tell complete coverage from a partial result.

**What to do:** Return searched/selected/downloaded/failed/rejected counts, sampling limits and incomplete-result status. Distinguish upstream failures from true no-coverage answers; allow retrying missing records.

**Acceptance condition:** Injected partial failures produce a visible warning and reproducible counts, not a fully complete-looking result or a misleading no-coverage answer.

## 12. [P1] Public job submission has no application-level queue bound

**Status:** Confirmed code path. **Evidence:** `backend/jobs.py: JobManager.submit; backend/server.py: _locks/JOBS`.

**Issue and scenario:** The executor limits running workers but accepts an unbounded number of distinct jobs. Job/lock dictionaries can grow; abandoned client searches keep consuming server resources.

**What to do:** Bound queued work, validate request cost, return 429 with retry guidance, and add per-client fairness. Add queued-job cancellation or expiry and a cap/cleanup policy for locks and records. Public access need not require accounts.

**Acceptance condition:** A burst of distinct coordinates stays within resource limits; rejected work gets a readable response, while active users can still finish.

## 13. [P1] Jobs and cached products disappear when the one server process restarts

**Status:** Confirmed deployment constraint. **Evidence:** `backend/jobs.py; Dockerfile; scripts/deploy_azure.sh; docs/DEPLOY.md`.

**Issue and scenario:** Jobs are memory-only and the deployment uses temporary disk and scale-to-zero. Restarted/expired jobs currently become an unknown-job response rather than a recoverable search.

**What to do:** For the event, document and configure an awake replica. Add frontend resubmit/reconnect for expired jobs. For durable hosting, store job state/results persistently and preserve idempotent product keys.

**Acceptance condition:** Restart during a job yields a clear recovery path. Returning to a completed query does not depend entirely on one temporary container.

## 14. [P1] Cache pruning can delete products that are about to be served

**Status:** Confirmed code path; concurrency scenario needs integration test. **Evidence:** `backend/cache.py: prune; backend/server.py: _build_frames/_serve_product/frames_fits`.

**Issue and scenario:** Prune operates on individual files and knows nothing about active jobs, product dependencies or current responses. It runs after writing products and can evict source blobs needed by another request.

**What to do:** Evict complete inactive products, pin active files, ignore in-progress temporary files, and retain a response lease while blobs are fetched. Recover by rebuilding when blob metadata is stale.

**Acceptance condition:** Low-cache-limit concurrent requests do not receive metadata pointing at already deleted arrays; pruning during FITS download remains safe.

## 15. [P1] New releases and cache invalidation remain a manual maintenance path

**Status:** Confirmed limitation. **Evidence:** `backend/releases.py; backend/spherex_client.py: data_version; backend/config.yaml; .github/workflows/check-releases.yml`.

**Issue and scenario:** The weekly workflow opens an issue; it does not rebuild or deploy. Product identity includes a release tag and index length/version rather than a content hash and complete processing/config fingerprint.

**What to do:** Display indexed cutoff accurately. Use reviewed automated refresh or a documented owner-run process. Include index content hash, processing version and relevant configuration in product identity, and regenerate saved products consistently.

**Acceptance condition:** New observations or changed calibrations invalidate affected cached products even when index length is unchanged. New-data notices do not imply automatic ingestion.

## 16. [P1] TAP and native IRSA cutout compatibility are not fully validated

**Status:** Verification gap. **Evidence:** `backend/spherex_client.py: _tap_exposures/_cut; backend/fits_processor.py: wavelength_at; docs/SPHEREX_DATA_NOTES.md`.

**Issue and scenario:** The TAP function still says it was not tested live. Native cutout alternate-WCS conventions remain explicitly marked verify. Fixture stamps were generated by the project, not independently returned by the native cutout endpoint.

**What to do:** Run a small live TAP query and native IRSA cutout in a controlled integration test. Validate relative/absolute URLs, schema, WCS, wavelength, PSF zone and masks against a full file and the S3 path.

**Acceptance condition:** The two archive paths produce matching sky placement and wavelength metadata, with clear handling of HTML/proxy errors.

## 17. [P1] Malformed frame responses fail before the friendly validator

**Status:** Reproduced. **Evidence:** `frontend/js/api.js: inlineFrameData/validateFrames/inlineCubeData`.

**Issue and scenario:** An HTTP-200 {} response produced Cannot read properties of undefined (reading map), displayed as backend unreachable. Frame validation runs only after resp.frames.map; cube payload validation is also weak.

**What to do:** Validate response envelopes before dereferencing fields or fetching arrays. Validate cube shapes, lengths, timestamps, channel IDs, units and finite values. Cap decoded dimensions and byte sizes.

**Acceptance condition:** Malformed metadata or binary data yields a specific invalid-response message, no raw TypeError, no oversized allocation and no misleading archive-outage diagnosis.

## 18. [P2] Polling can run forever and older browsers can lose timeout protection

**Status:** Confirmed code path; stalled-job behavior exercised. **Evidence:** `frontend/js/api.js: runJob/sleep/withTimeout`.

**Issue and scenario:** The job loop has no overall deadline or no-progress policy. In a controlled scenario the frontend kept polling a non-progressing running job. If AbortSignal.any/timeout are unavailable, request timeout protection is simply omitted. Sleep leaves abort listeners after completed delays.

**What to do:** Add total elapsed/no-progress thresholds, adaptive polling, resumable retry, and an AbortController timeout fallback. Clean up delay listeners on completion and validate job states/URLs.

**Acceptance condition:** An indefinitely stalled job offers retry/resume/cancel without endless polling. A legacy browser still gets bounded waits.

## 19. [P2] Shared URLs omit the custom backend configuration

**Status:** Reproduced. **Evidence:** `frontend/js/app.js: writeURL; frontend/js/api.js: resolveApiBase`.

**Issue and scenario:** Opening with api=https://custom.example rewrote the URL without api. It works locally only because localStorage remembers the value; the recipient can contact a different backend.

**What to do:** Preserve non-default backend identity in shared links or provide explicit deployment profiles, with clear validation of allowed URLs. Do not rely on sender-specific browser storage.

**Acceptance condition:** The same copied URL in a fresh browser context uses the same intended data service.

## 20. [P2] Gaia overlays can be stale after a same-centre FOV change

**Status:** Confirmed code path. **Evidence:** `frontend/js/app.js: loadTarget/sameField/state.sources`.

**Issue and scenario:** sameField compares only the centre. Existing sources are retained if the region size grows, so new edge stars need not appear. Rejected mover requests can also write old errors without checking their request signal.

**What to do:** Key supplementary state by centre, FOV, detector where relevant, release and epoch bins. Reset or refetch when those keys change and check request ownership in every success/error callback.

**Acceptance condition:** Expand a region and receive its new edge stars. Rapid target/FOV changes never let old source lists or failures overwrite the current field.

## 21. [P2] Optional analyses duplicate work and can delay basic use

**Status:** Confirmed code path. **Evidence:** `frontend/js/app.js: loadTarget/loadAdvanced; frontend/js/api.js`.

**Issue and scenario:** A named target starts a light-curve request in the background. Opening Advanced before completion can start another because its state was not marked pending. Movers run automatically for each load, and metadata startup requests a live release check.

**What to do:** Use a request registry/single-flight cache and mark pending work immediately. Prioritize frames, lazy-load expensive analyses or give them explicit Run actions, and use lightweight metadata on startup.

**Acceptance condition:** Opening/closing Advanced or changing display settings does not duplicate identical product builds; image requests retain priority.

## 22. [P1] CI does not run the frontend or browser regression suites

**Status:** Confirmed configuration. **Evidence:** `.github/workflows/tests.yml; frontend/tests; tests/browser`.

**Issue and scenario:** The workflow installs Python and runs pytest only. The 40 current frontend tests pass locally, but reproduced missing-channel, numeric-input and strict-fresh issues are not covered. Browser checks hard-code macOS Chrome.

**What to do:** Add a Node job and a Linux-compatible Playwright acceptance job with its own server. Add these reproduced failures as regression tests. Keep scheduled opt-in live archive tests separate from deterministic PR checks.

**Acceptance condition:** An intentionally broken JS interaction or missing-channel case fails CI before merge; browser checks run without a developer laptop.

## 23. [P2] Local setup and dependency reproducibility are fragile

**Status:** Confirmed code path. **Evidence:** `scripts/run_local.sh; backend/requirements.txt; .env.example; scripts/spike_one_cutout.py`.

**Issue and scenario:** The launcher only installs packages when .venv is absent; it does not verify dependencies or server readiness when a venv exists. It can pick macOS Python 3.9 although NumPy>=1.26 needs newer Python. .env is not automatically loaded, dependencies are unpinned, and the spike imports matplotlib without declaring it.

**What to do:** Declare a supported Python version, check/install the environment against pinned dependencies, load documented environment settings explicitly, and wait for frontend/backend health before printing success. Declare optional script dependencies separately.

**Acceptance condition:** A clean supported machine and an existing incomplete venv both start reliably; an import/bind failure does not leave a success-looking preview.

## 24. [P2] Research outputs need stronger reproducibility and uncertainty context

**Status:** Verification gap and confirmed export limitations. **Evidence:** `frontend/js/events-ui.js; frontend/js/advanced.js; backend/pipeline.py; backend/discovery.py; backend/motion.py; backend/lightcurve.py; backend/stack.py`.

**Issue and scenario:** Candidate significance, empirical noise rescaling, saturated-wing fits and fitted science products have documented systematic limits. Current exports do not consistently contain a complete processing/config/source-file manifest. Successful tests are not independent confirmation of every scientific measurement.

**What to do:** Include code/data/config versions, input observation IDs, mask policy, wavelength coverage and reliability flags in exports. Expand validation with independent controls, blank fields, blends, saturation, moving sources and dense/polar fields; label exploratory derived estimates accordingly.

**Acceptance condition:** A researcher can identify exact inputs/methods and limitations for a downloaded result; no candidate or pixel residual is presented as a confirmed discovery.

## 25. [P2] Documentation and submission credits disagree with current products

**Status:** Confirmed. **Evidence:** `CITATION.md; README.md; docs/VALIDATION.md; docs/FRONTEND.md; docs/IMPROVEMENT_PLAN.md; .github/pull_request_template.md`.

**Issue and scenario:** QR3 DOI and mission acknowledgement placeholders remain; AI disclosure and team fields are unfinished. Validation tables mix earlier and refreshed exposure counts/results. Some plans describe superseded interfaces, and the PR checklist forbids all data files despite intentional saved products/fixtures.

**What to do:** Reconcile documentation with generated product manifests, label historical measurements, complete verified citations/acknowledgements and AI/team disclosure, and distinguish allowed fixture/precomputed data from secrets/raw downloads. Include third-party licence/attribution requirements.

**Acceptance condition:** No submission-facing TODOs or conflicting current measurements remain; every claimed feature/result points to current evidence.

## 26. [P2] Publication and previously agreed features need an explicit release gate

**Status:** Verification gap / scope decision. **Evidence:** `docs/DEPLOY.md; docs/ACCEPTANCE_AUDIT.md; frontend/index.html; frontend/js/player.js`.

**Issue and scenario:** Local tests and a public HTTP-200 page do not establish production end-to-end behavior. The current interface has scientific blink but not the earlier agreed smooth-crossfade and synchronized side-by-side modes. The browser suite checks map requests starting, not cold completion for every map region.

**What to do:** Define the release feature list: restore agreed modes with science labels or explicitly defer them. Validate the deployed commit from a fresh browser: real coordinate and map selection through completed frames, HTTPS/CORS/blobs/jobs, downloads, mobile/touch and unavailable services.

**Acceptance condition:** Release sign-off names the deployed code/data versions, executed scenarios and remaining limits. Do not describe omitted features or saved-only runs as a fully validated public workflow.

## Earlier findings that are already addressed

The current code already prevents implicit mock substitution, disables image controls before data, guards late tour placement, adds map readiness/retry handling, surfaces map selection, validates coordinates, restores movie controls, caches playback percentiles, and hides wholly unavailable advanced rows/columns. These should remain regression checks, not be reported as still-broken defects.

## Recommended order

1. Fix strict-live validation and missing-channel selection (1–3).
2. Fix spatial completeness, cache concurrency and scientific readouts (4–11).
3. Bound/recover jobs and make product/cache/release identity reliable (12–18).
4. Resolve supplementary-request state, CI and setup problems (19–23).
5. Complete reproducibility, credits, agreed scope and production validation (24–26).
