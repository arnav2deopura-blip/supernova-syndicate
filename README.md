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

All three end in the same comparison viewer (blink, difference, sum, Gaia overlay, click-for-spectrum):

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
- [x] Play passes (blink) per detector band, play/pause/step, speed, a timeline of passes on a real time axis
- [x] Difference and **Changes (σ)** between any two passes, from the calibrated noise maps; Sum
- [x] **"What changed?" markers**: regions ≥ 5σ circled automatically (○ brighter/new, ✕ fainter/gone, → moved, ◐ variable; dashed = uncertain), merged with Gaia known movers, the `/api/movers` search and the `/api/lightcurve` verdict, listed as Events
- [x] Per-event card: each pass at that spot with S/N, one-click "Is it new?" checks (SIMBAD, CatWISE, Gaia, IRSA Finder Chart, SkyBoT), JSON/CSV report
- [x] Skippable guided tour (`?tour=1`, "?" button), "What am I looking at?" field guide, glossary ⓘ tooltips, plain-language controls
- [x] 102 bands browsable: whole detector band, a channel range inside one detector, molecule presets (water ice, PAH/CH₄, CO₂ ice, CO), and a Colours view that plays through a band's 17 channels
- [x] Advanced drawer: per-pass and per-exposure metadata, SPHEREx-only proper motion, photometry, derived physics (Unknown + reason when an input is missing), exports, citation
- [x] Gaia DR3 overlay with proper-motion tracks; click for a spectrum
- [x] Save image / movie, `?embed=1` bare player, reduced-motion respected, phone layout
- [x] Shareable URLs: `?mode=&ra=&dec=&fov=&band=&matched=&name=&view=&a=&b=&ch=`

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

**Which backend the page uses:** the footer says which one and whether it answers.

| URL option | Effect |
|---|---|
| (none) | The deployed backend on Azure |
| `?api=local` | A backend on this machine, port 8000 (remembered in this browser) |
| `?api=https://…` | Any other backend (remembered) |
| `?api=default` | Back to the deployed backend |
| `?fresh=1` | Ask the backend even for the five test targets (normally they load from `frontend/precomputed/`, the same pipeline and release, so a demo never waits on a rebuild) |
| `?mock=1` | Fake data from `frontend/mock/`, no backend (layout work only) |

A position nobody has asked for yet takes ~1–10 min to build the first time (the page shows progress), then it is cached. The deployed backend scales to zero when idle and loses its cache, so the first request after a quiet spell is slower.

**Tests:** `node --test frontend/tests/*.mjs` (frontend, Node 18+), `pytest` (backend), `node scripts/check_changes.mjs --inject` (change detector on the five presets).

New SPHEREx release? A weekly GitHub Action opens an issue when one appears; then edit `backend/config.yaml`, rebuild the index and redeploy. No code changes (see [docs/DEPLOY.md](docs/DEPLOY.md#new-spherex-data)).

## Validation

Current verification and limits: [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md). Real cold-cache builds: [docs/LIVE_VALIDATION.json](docs/LIVE_VALIDATION.json). Earlier measurement studies are archived in [docs/VALIDATION.md](docs/VALIDATION.md); their numbers are not current release certification.

## Limits

- Only ~2–3 epochs for most of the sky, so this is a blink, not a movie.
- Pixels are 6.15″; most movers shift 1–2 pixels per year.
- Very faint targets may sit at the noise level even after co-adding.

## Credits

Data credits and DOIs: [CITATION.md](CITATION.md). API: [docs/API.md](docs/API.md). Deploy: [docs/DEPLOY.md](docs/DEPLOY.md).

## AI use disclosure

Anthropic Claude helped plan the project and scaffold the repository. OpenAI Codex assisted with frontend implementation, backend reliability fixes, scientific guardrails, documentation, and automated/manual browser audits. AI-generated changes are checked by the repository suites; this does not independently validate every scientific inference.

## Team

Sphere Shift: **Chakshu Parnam, Arnav Deopura, and Zaid Khan**.

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
The Advanced drawer loads optional analyses once per target and exports a research manifest.
“Masked %” describes missing output pixels, separately from contamination flags at the target.
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
