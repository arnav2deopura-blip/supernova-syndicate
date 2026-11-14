# SPHEREx Sky Explorer

**A blink comparator for a 102-colour sky.** Type coordinates, watch the infrared sky change between SPHEREx passes, and spot stars that move or flicker.

Built by **Supernova Syndicate** for the 2026 NASA Space Apps Challenge (SPHEREx / Planet X challenge).

> Status: under construction during the hackathon (14–15 Nov 2026).

## Live demo

- **Tool:** _TODO: GitHub Pages link_
- **GIF:** _TODO: `docs/img/barnards.gif` of Barnard's Star moving_

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
IRSA (SIA2/TAP) ──► cutouts ──► mask + zodi subtract ──► group by epoch × detector
   ──► reproject to one north-up grid ──► co-add ──► float arrays ──► browser
                                                                (stretch, colormap, blink)
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

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.server:app --reload
python -m http.server 5500 --directory frontend   # then open http://localhost:5500
```

Add `?mock=1` to the page URL to use the fake data in `frontend/mock/` without a backend.

New SPHEREx release? Edit `backend/config.yaml` only (collection names, band edges). No code changes needed.

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
