# SPHEREx Sky Explorer

**A blink comparator for a 102-colour sky.** Type coordinates, watch the infrared sky change between SPHEREx passes, and spot stars that move or flicker.

Built by **Supernova Syndicate** for the 2026 NASA Space Apps Challenge (SPHEREx / Planet X challenge).

> Status: under construction during the hackathon (14–15 Nov 2026).

## Live demo

- **Tool:** _TODO: GitHub Pages link_
- **GIF:** [`docs/img/barnard_blink.gif`](docs/img/barnard_blink.gif): Barnard's Star moving across three SPHEREx passes
- **Backend API:** https://spherex-api.redgrass-773e0da8.canadacentral.azurecontainerapps.io/docs

## Try it

| Target | What to look for | Link |
|---|---|---|
| Barnard's Star | Fast mover, dipole in difference mode | _TODO `?ra=&dec=`_ |
| Epsilon Indi B | Faint mover near a bright star | _TODO_ |
| WISE 0855-0714 | Very faint, very red mover (D6 only) | _TODO_ |
| RW Aurigae | Irregular variable | _TODO_ |
| R Draconis | Mira variable, light curve | _TODO_ |

## How it works

```
IRSA TAP / public S3 mirror ──► byte-range stamps ──► flags + zodi + background ──► λ at the target per exposure
   ──► reproject to one north-up 3.075″ grid ──► co-add per pass × detector (or matched-λ channels)
   ──► float32 blobs + calibrated noise maps ──► browser (stretch, colormap, blink, σ-difference)
```

A single SPHEREx exposure isn't one colour: each detector sits behind a linear variable filter. So we never blink raw exposures. Instead we co-add every exposure in one **epoch** (one ~6-month sky pass) and one **detector band**, then blink epochs within the same band.

## Features

- [ ] RA/Dec or name input, with proper-motion correction
- [ ] Epoch blink per detector band, play/pause, speed
- [ ] Stretch and colormap controls, all in the browser
- [ ] Difference and sum modes
- [ ] Gaia DR3 overlay with proper-motion arrows
- [ ] Click for a quick-look spectrum; light curves
- [ ] Shareable URLs: `?ra=&dec=&fov=&band=`

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

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.server:app --reload
python -m http.server 5500 --directory frontend   # then open http://localhost:5500
```

Add `?mock=1` to the page URL to use the fake data in `frontend/mock/` without a backend.

New SPHEREx release? A weekly GitHub Action opens an issue when one appears; then edit `backend/config.yaml`, rebuild the index and redeploy. No code changes (see [docs/DEPLOY.md](docs/DEPLOY.md#new-spherex-data)).

## Validation

See [docs/VALIDATION.md](docs/VALIDATION.md) for results on all five test targets.

## Limits

- Only ~2–3 epochs for most of the sky, so this is a blink, not a movie.
- Pixels are 6.15″; most movers shift 1–2 pixels per year.
- Very faint targets may sit at the noise level even after co-adding.

## Credits

Data credits and DOIs: [CITATION.md](CITATION.md). API: [docs/API.md](docs/API.md). Deploy: [docs/DEPLOY.md](docs/DEPLOY.md).

## AI use disclosure

We used Anthropic's Claude to help plan the project and scaffold this repository. _TODO: list every AI tool used and how, before submission._

## Team

Supernova Syndicate. _TODO: names and roles (A Data/Backend, B Science, C Frontend/Ship)._

Licence: MIT.
