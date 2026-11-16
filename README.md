# Sphere Shift

**A blink comparator for a 102-colour sky.** Type coordinates, watch the infrared sky change between SPHEREx passes, and spot stars that move or flicker.

Built by **Sphere Shift** for the 2026 NASA Space Apps Challenge (SPHEREx / Planet X challenge).

> Status: under construction during the hackathon (14–15 Nov 2026).

## Live demo

- **Tool:** https://arnav2deopura-blip.github.io/supernova-syndicate/ (GitHub Pages, redeployed on every push to `main`; uses the backend below)
- **GIF:** [`docs/img/barnard_blink.gif`](docs/img/barnard_blink.gif): Barnard's Star moving across three SPHEREx passes
- **Backend API:** https://spherex-api.redgrass-773e0da8.canadacentral.azurecontainerapps.io/docs

## Try it

| Target | What to look for | Link |
|---|---|---|
| Barnard's Star | Fast mover, dipole in difference mode | `?name=Barnard%27s+Star&band=D2` |
| Epsilon Indi B | Faint mover near a bright star | `?name=eps+Indi+B&band=D3` |
| WISE 0855-0714 | Very faint, very red mover (D6 only) | `?name=WISE+J085510.83-071442.5&band=D6` |
| RW Aurigae | Irregular variable | `?name=RW+Aur&band=D2` |
| R Draconis | Mira variable, light curve | `?name=R+Dra&band=D2` |

## Three ways to pick a target

The first screen is a picker with the five test targets as example cards. The search box in the top bar takes a name or coordinates; the picker also has three tabs. All end in the same comparison viewer (blink, difference, sum, Gaia overlay, click-for-spectrum):

| Mode | How | Backend |
|---|---|---|
| **Explore the sky** | Pan and zoom the SPHEREx DR1 all-sky map ([IRSA HiPS cube](https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube), via Aladin Lite), with a slider over the available HiPS spectral slices. Click to drop a box of the chosen FOV, or Shift+drag (or "Draw box" on touch) to draw one, up to 0.5°. A coverage check shows the exposures and passes before you compare | `/api/exposures`, then `/api/frames` |
| **Object name** | Type a name (recent searches and the test targets are suggested). It resolves through SIMBAD and is propagated to now; the proper motion is used for the spectrum | `/api/resolve`, then `/api/frames` |
| **Coordinates** | RA/Dec in decimal degrees or sexagesimal (`17:57:47 +04:46:14`), or both pasted into one box | `/api/frames` |

A position nobody has asked for yet takes 1–10 min to build. The page runs it as a background job (`async=1`), shows the stage and a progress bar, and can cancel; the server keeps building, so the next request is fast. URLs keep the state: `?mode=explore|name|coords&ra=&dec=&fov=&band=&matched=1&name=`.

## How it works

```
IRSA TAP / public S3 mirror ──► byte-range stamps ──► flags + zodi + background ──► λ at the target per exposure
   ──► reproject to one north-up 3.075″ grid ──► co-add per pass × detector (or matched-λ channels)
   ──► float32 blobs + calibrated noise maps ──► browser (stretch, colormap, blink, σ-difference)
```

A single SPHEREx exposure isn't one colour: each detector sits behind a linear variable filter. So we never blink raw exposures. Instead we co-add every exposure in one **epoch** (one ~6-month sky pass) and one **detector band**, then blink epochs within the same band.

## Features

- [x] Three search modes: explore the sky map, object name, RA/Dec
- [x] Progress and cancel for slow first requests (async jobs)
- [x] Instrument layout: the image takes every spare pixel; a wavelength ruler (D1–D6, 17 channels each) and a time ruler (each pass a block on a real date axis, exposures as ticks) carry the other two axes; corner readouts, scale bar, compass, colour bar with units, cursor position and pixel value
- [x] Play passes (blink) per detector band, play/pause/step, speed up to 3 frames per second (faster only after a photosensitivity warning); Smooth (a labelled crossfade) and Side by side views
- [x] Difference and **Changes (σ)** between any two passes, from the calibrated noise maps; Sum
- [x] **"What changed?" markers**: regions ≥ 5σ circled automatically (○ brighter/new, ✕ fainter/gone, → moved, ◐ variable; dashed = uncertain), merged with Gaia known movers, the `/api/movers` search and the `/api/lightcurve` verdict, listed as Events
- [x] Per-event card: each pass at that spot with S/N, one-click "Is it new?" checks (SIMBAD, CatWISE, Gaia, IRSA Finder Chart, SkyBoT), JSON/CSV report
- [x] Skippable guided tour (`?tour=1`, "?" button), "What am I looking at?" field guide, glossary ⓘ tooltips, plain-language controls
- [x] 102 bands browsable: whole detector band, a channel range inside one detector, molecule presets (water ice, PAH/CH₄, CO₂ ice, CO), and a Colours view that plays through a band's 17 channels
- [x] Inspector with Events, Spectrum and Details tabs. Details: per-pass and per-exposure metadata ("No-data pixels %" is the share of pixels without data), SPHEREx-only proper motion, photometry stated in one band, derived physics (Unknown + reason when an input is missing; no colour temperature until its uncertainty is validated), exports, citation
- [x] Gaia DR3 overlay with proper-motion tracks; click for a spectrum (drawn at screen resolution, axes in µm and µJy, error bars, a shape per pass, flagged points hollow)
- [x] States stated: a provenance tag (Saved demo data / Server cache / Processed now / Mock, from the backend's `retrieval` and `completeness` fields), a comparison tag ("Matched at centre" or "Not matched"), a warning strip for saturated cores and incomplete data, the source of the target position in words, and hatching for pixels with no data
- [x] Every channel of a requested range must be covered in every pass, or nothing is drawn and the user chooses; channel-range frames carry their own dates, exposure counts and observation IDs
- [x] Robust client: every response is checked before use, slow jobs poll less often, a job with no progress for 2 minutes asks to keep waiting, retry or cancel, a job the server forgot is sent again once, a busy server is retried after its delay
- [x] Exports carry a reproducibility header (URL, release, provenance, wavelengths, masking, warnings)
- [x] Keyboard map (? in the app), visible focus, colour-vision-safe markers with a shape per kind, reduced motion respected
- [x] Save image / movie, `?embed=1` bare player, reduced-motion respected, phone layout
- [x] Shareable URLs: `?mode=&ra=&dec=&fov=&band=&matched=&name=&view=&a=&b=&ch=`, keeping `api`, `fresh`, `verify`, `mock` and `embed`

**Restored or deferred (decided 15 Nov 2026):**

- Crossfade between passes: **restored** as the Smooth view (a labelled visual blend; Play passes keeps the hard cut). Plain passes under reduced motion.
- Side by side: **restored** with shared placement, stretch and zoom for passes A and B. A linked cursor crosshair is deferred.
- Details split into Measure / Data / Export, a dark-centre diverging map for Changes (σ), and a light theme: **deferred**.
- CatWISE overlay: **deferred**; the per-event checks link to CatWISE in VizieR.

The change detector runs in the browser (`frontend/js/changes.js`); `node scripts/check_changes.mjs --inject` runs it on the five presets and checks that injected fake sources are recovered.

Frontend tests (no browser needed): `node --test frontend/tests/*.mjs`. Offline, the page uses the saved bakes only when they match the request exactly; synthetic data appears only with `?mock`. Fair brightness comparison (matched wavelengths) is on by default; `?matched=0` turns it off.

## Science products (backend API)

Every product is computed from real SPHEREx DR1 + QR3 level-2 images; see [docs/API.md](docs/API.md).

| Endpoint | What it gives |
|---|---|
| `/api/frames` (`matched=1`) | One co-add per pass; matched mode keeps the same bandpass in every pass so brightness changes are real. Noise maps for σ-difference, per-frame registration vs Gaia |
| `/api/frames.fits` | The same frames as multi-extension FITS for DS9 / astropy |
| `/api/cube` | The 102-band view: one image per spectral channel |
| `/api/spectrum` | Click-for-spectrum: forced ePSF photometry in µJy, proper motion followed, Gaia neighbours deblended |
| `/api/lightcurve` | Bandpass-corrected light curves with comparison-star null check |
| `/api/motion` | Proper motion (and parallax) measured from SPHEREx alone, compared with Gaia |
| `/api/movers` | Discovery mode: movers in the field that Gaia doesn't know (rediscovers WISE 0855 blind) |
| `/api/stack` | Shift-and-stack along a proper motion |
| `/api/meta` | Releases in use, "data through" date, live check for new releases |

## Run it yourself

**Just use it:** open https://arnav2deopura-blip.github.io/supernova-syndicate/. Nothing to install.

**Run the frontend on your machine** (to work on it). Needs Python 3 only; the page talks to the deployed backend:

```bash
git clone https://github.com/arnav2deopura-blip/supernova-syndicate.git
cd supernova-syndicate
scripts/run_local.sh
```

Open the address it prints (http://localhost:5500). Edit files in `frontend/` and reload. If changes don't show, hard-reload (Cmd+Shift+R / Ctrl+Shift+R).

**Run the backend too** (to work on it, or when the deployed one is down):

```bash
scripts/run_local.sh --backend
```

The first run creates `.venv` and installs `backend/requirements.txt` (a few minutes). It starts the API on http://localhost:8000 (docs at `/docs`) and opens the page with `?api=local`. On Windows without bash, run the two servers yourself:

```bash
python -m venv .venv && .venv\Scripts\activate        # macOS/Linux: source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.server:app --port 8000
python -m http.server 5500 --directory frontend       # second terminal; open http://localhost:5500/?api=local
```

**Which backend the page uses:** the status bar at the bottom says which one and whether it answers. A shared link keeps a non-default `?api=`.

| URL option | Effect |
|---|---|
| (none) | The deployed backend on Azure |
| `?api=local` | A backend on this machine, port 8000 (remembered in this browser) |
| `?api=https://…` | Any other backend (remembered) |
| `?api=default` | Back to the deployed backend |
| `?fresh=1` | "Backend only" (also a checkbox in the status bar): saved data is never read or used as a fallback, and an outage is an error. Resolved name positions are used as returned. It does not purge backend caches |
| `?verify=1` | Same as `?fresh=1` (kept for older links) |
| `?mock=1` | Fake data from `frontend/mock/`, no backend (layout work only) |

A position nobody has asked for yet takes ~1–10 min to build the first time (the page shows progress), then it is cached. The deployed backend scales to zero when idle and loses its cache, so the first request after a quiet spell is slower.

**Tests:** `node --test frontend/tests/*.mjs` (frontend, Node 18+), `pytest` (backend), `node scripts/check_changes.mjs --inject` (change detector on the five presets). CI runs all three.

New SPHEREx release? A weekly GitHub Action opens an issue when one appears; then edit `backend/config.yaml`, rebuild the index and redeploy. No code changes (see [docs/DEPLOY.md](docs/DEPLOY.md#new-spherex-data)).

## Validation

Current verification and limits: [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md). Real cold-cache builds: [docs/LIVE_VALIDATION.json](docs/LIVE_VALIDATION.json). Earlier measurement studies are archived in [docs/VALIDATION.md](docs/VALIDATION.md); their numbers are not current release certification.

## Limits

- Only ~2–3 epochs for most of the sky, so this is a blink, not a movie.
- Pixels are 6.15″; most movers shift 1–2 pixels per year.
- Very faint targets may sit at the noise level even after co-adding.

## Credits

Data credits and DOIs: [CITATION.md](CITATION.md). API: [docs/API.md](docs/API.md). Deploy: [docs/DEPLOY.md](docs/DEPLOY.md).

Interface: icons from [Lucide](https://lucide.dev) (ISC licence); IBM Plex Sans and Mono (SIL OFL 1.1) when installed, otherwise system fonts; Okabe–Ito marker colours; cividis colour map. Sky map: Aladin Lite (CDS).

## AI use disclosure

Anthropic Claude helped plan the project and scaffold the repository, and Claude Code implemented the frontend redesign (layout, design tokens, wavelength and time rulers, honesty labels, client robustness, tests) from our written plan. OpenAI Codex assisted with frontend implementation, backend reliability fixes, scientific guardrails, documentation, and automated/manual browser audits. AI-generated changes are checked by the repository suites; this does not independently validate every scientific inference. No AI-generated images and no NASA branding are used.

## Team

Sphere Shift: **Chakshu Parnam, Arnav Deopura, and Mohammed Zaid Khan**.

Licence: MIT.

### Browser acceptance checks

The final interaction audit and its limits are recorded in
[docs/ACCEPTANCE_AUDIT.md](docs/ACCEPTANCE_AUDIT.md). With the frontend running on
port 5600, optional Playwright tooling and Google Chrome installed, run
`python tests/browser/acceptance.py` and `python tests/browser/measurements.py`.
These exercise actual saved scientific products, live map selection, exports,
channel controls and failure recovery; they do not replace a deployed-host smoke test.


### Comparison and research behavior

Play passes shows actual dated images. Smooth blends adjacent images for presentation only.
Side by side uses the same WCS, brightness stretch and zoom for two selected passes.
Matched wavelengths apply at the field centre: off-centre brightness residuals remain exploratory.
The Details tab loads optional analyses once per target and exports a research manifest (it also carries the reproducibility header). For the saved test targets the movers search and light curve load at once; for any other position they run when Details is opened.
“No-data pixels %” describes missing output pixels, separately from contamination flags at the target.
Invalid parallax/errors, mixed-channel magnitudes and unvalidated colour temperatures are withheld.

Test targets normally load explicitly labeled saved observations for speed. Add `?fresh=1` to
require the backend and disable saved fallback. The badge distinguishes a backend cache hit from
a new archive build. An empty-cache run of `scripts/validate_live.py` tests retrieval independently
of the saved files. Public archive availability and sampling limits are reported, not hidden.

Python 3.12+ is required for the backend. `scripts/run_local.sh --backend` installs the pinned
requirements even into an existing venv, loads `.env`, and checks server readiness. Install
`scripts/requirements-figures.txt` only for optional plotting scripts.

Dense fields can exceed the per-job image budget even below the maximum FOV. The
service checks this before downloading cutouts and offers a smaller field; it does
not attempt an unbounded allocation. Research fits combining detectors have the same
working-set limit.
