# Final interaction audit — 15 November 2026

This is an evidence record, not a claim that external archives or every sky position
will always be available. Browser checks use the actual frontend and authentic saved
SPHEREx data; deterministic failure tests intercept requests explicitly inside tests.
No synthetic data is substituted for a failed real search.

## Purpose and acceptance checks

| Area | Purpose | Checked behavior |
| --- | --- | --- |
| Name search | Resolve a source and use a useful band | All five real target names load; recommended preset band is selected unless explicitly overridden |
| Coordinates | Display the requested region | Decimal/sexagesimal parsing and invalid values covered by frontend tests; real coordinate request rendered live frames in the browser |
| Explore | Choose a region, not merely browse a map | Click, drawn box and current-view selection checked; Compare generates a real frames request and brings the viewer into view |
| Map startup | Avoid silent controls and empty maps | Controls wait for initialization; explicit background success/failure; bounded waits, retry, coordinate-search alternative |
| Wavelengths | Display requested spectral samples | Real WISE channel selection, colour images and filmstrip checked |
| Comparison | Inspect dated frames and differences | Playback, stepping, timeline, all five view modes, zoom, colour maps and contrast checked |
| Interpretation | Explain events and limitations | Guide and skippable tour checked; fixed delayed callback crash after tour dismissal |
| Pixel analysis | Measure an actual selected source | Real spectrum and Spectrum CSV checked; unavailable values omitted rather than fabricated |
| Research details | Show supported measurements | Per-frame metadata retained; wholly unavailable columns/metrics/derived sections omitted; unavailable analyses summarized |
| Exports | Produce reusable artifacts | PNG, recorded movie, observation CSV and spectral CSV download checked |
| Cancellation | Stop client waits safely | Deterministic running-job test; progress closes and cancellation is explicit; server work may continue |
| Responsive UI | Remain usable on a phone | 390px viewport tested for page overflow |

## Implementation fixes

- No-op image controls are disabled until data arrives; old badges, filmstrip and
  advanced values are cleared when a new request starts. Old spectra are cancelled.
- Movie export catches failures, closes recording tracks and restores playback/UI state.
- Late name/analysis responses cannot overwrite the newer selection.
- Coverage is not searched automatically for arbitrary map clicks: comparison makes
  the necessary request. This avoids launching two archive scans for one region.
- Heavy object-centre astrometry/light curves are not launched for arbitrary empty fields.
- Colormap lookup tables, sorted percentile samples and common-frame intensity arrays
  are reused. Playback doesn't repeatedly sort the same samples. WeakMap caches permit
  old data to be garbage-collected; canvas sizes aren't reset unnecessarily.
- Only the verified SPHEREx background is offered. Removed unverified alternative
  backgrounds rather than leaving options that could silently fail.

## Repeatable checks

Start the static frontend on port 5600, then:

```
.venv/bin/python tests/browser/acceptance.py
.venv/bin/python tests/browser/measurements.py
node --test frontend/tests/*.mjs
.venv/bin/python -m pytest -q
```

Browser checks require Playwright and installed Google Chrome on macOS. Set
`SPHEREX_PREVIEW_URL` to change the preview origin. These checks create downloads
in the temporary Playwright context; they do not publish anything.

## Practical limits

- A first archive query can take 1–10 minutes. Background processing and the UI
  remain separate; existing matching observations load from cache where available.
- A service outage, unavailable coverage, saturation, or insufficient wavelength
  overlap can prevent a scientific measurement. The UI must explain these cases.
- A public-host smoke test and representative live API requests remain necessary
  after deployment; local checks do not establish production CORS or hosting behavior.
