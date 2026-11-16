# Project page text (NASA Space Apps 2026, Planet X and SPHEREx)

Copy-paste text for the Space Apps project page. Written 15 Nov 2026.

- Project link: https://arnav2deopura-blip.github.io/supernova-syndicate/
- Demo link: https://arnav2deopura-blip.github.io/supernova-syndicate/demo/Sphere_Shift_Demo.pdf
- Code: https://github.com/arnav2deopura-blip/supernova-syndicate

## High-level summary (185 words; limit 50–200)

Since 2025, NASA's SPHEREx mission has mapped the whole sky every six months in 102 infrared colours. Objects that move or change between those passes, such as nearby stars, brown dwarfs and asteroids, are how new discoveries get made, but the raw data is too large and too technical for most people to search.

Our team, Supernova Syndicate, built Sphere Shift, a public website that turns any patch of that sky into a short time-lapse. Type an object name or coordinates, or pick a spot on a sky map, and the site plays the SPHEREx passes back like a flipbook. It can also subtract one pass from another, circle what changed, overlay known Gaia stars, and measure a spectrum of any star you click.

We tested it on the challenge's five targets. Barnard's Star visibly steps across the image, and the tool flags the faint brown dwarf WISE 0855 as a candidate moving object without being told where it is.

Sphere Shift lets students and citizen scientists do what professional astronomers do: compare the sky with itself and notice what is different.

## Project details

**What it does.** Sphere Shift is a website for comparing NASA's SPHEREx images of the same patch of sky taken months apart. You choose a target three ways: an object name, RA/Dec coordinates, or a box drawn on an all-sky map. The site then shows each SPHEREx pass of that region as one frame and plays them in sequence, so anything that moved or changed brightness stands out.

**How it works.** The hard part is that a single SPHEREx exposure is not one colour. Each detector sits behind a filter whose wavelength changes across the image, so the same star is seen at a different wavelength every time. Blinking raw exposures would show fake changes. Our backend therefore gathers every exposure covering the target, removes flagged pixels and background light, lines them all up on one north-up grid, and adds them together per pass and per detector. For brightness comparisons it keeps only the wavelength channels seen in every pass. The browser receives the real pixel values and does the rest instantly.

**Ways to look.** There are seven views: play the passes, a smooth blend, side by side, difference, a significance map, a sum of all passes for the faintest objects, and a view that steps through the 17 wavelength channels of a band. Changes above five times the noise are circled automatically and sorted into brighter, fainter, moved or variable, with uncertain ones drawn dashed. Each one links to SIMBAD, Gaia, CatWISE and an asteroid check, so users can tell a known object from a possible new one. Clicking any star measures its spectrum. Gaia stars can be overlaid with their expected motion.

**Results on the five test targets.** Barnard's Star shifts about 10 arcseconds across three passes and matches its Gaia motion. Epsilon Indi B is tracked beside its bright neighbour. WISE 0855 is flagged as a moving candidate in the longest-wavelength band, the only one where it is visible. RW Aurigae is flagged as variable from its light curve. R Draconis is so bright it saturates the detector, and the tool says so instead of making a claim.

**Benefits and intended impact.** Volunteers found most known brown dwarfs by blinking images in projects like Backyard Worlds. SPHEREx has no tool like that yet. Sphere Shift is meant to be that entry point: nothing to install, every view has a shareable link, and it can be embedded in other websites. Images, movies, spreadsheets and FITS files can be exported for further study.

**How it is creative.** Pluto was discovered by blinking two photographs. We built that same idea for a sky with 102 colours, added automatic "what changed?" markers, and included a field guide that teaches real changes from false ones using real examples.

**Factors we considered.**

- Most of the sky has only two to four passes so far, so the design is a blink, not a long movie.
- SPHEREx pixels are large, so fast stars move only one or two pixels a year. That is why difference images matter.
- Catalogue positions are decades old. We move each named star to today's position before centring.
- The archive can be slow, so results are cached and the five test targets are saved with the site.
- New data arrives often, so releases are set in one settings file and checked weekly.
- The site labels saturated stars, missing pixels, and whether data is saved or freshly built.
- Markers use colour-blind-safe colours and shapes, blink speed is capped for photosensitivity, and the site works by keyboard and on phones.

**Tools.** Frontend: HTML, CSS and JavaScript with no framework, and Aladin Lite for the sky map. Backend: Python, FastAPI, Astropy, NumPy, SciPy, reproject, photutils, astroquery and pyvo, in a Docker container on Microsoft Azure. GitHub hosts the code, runs the automated tests and serves the website through GitHub Pages. AI tools helped with coding, debugging and documentation (see the README's AI use disclosure).

## NASA data

| Data | Used for | Reference |
|---|---|---|
| SPHEREx DR1 spectral images (Level 2) | All images, spectra, light curves | NASA/IPAC IRSA, doi:10.26131/IRSA678 |
| SPHEREx Quick Release 3 spectral images | Newer passes, combined with DR1 | doi:10.26131/IRSA662 |
| SPHEREx DR1 all-sky spectral cube (HiPS) | Background of the sky map | doi:10.26131/IRSA679 |
| NASA/IPAC Infrared Science Archive (IRSA) | Image search (TAP/SIA), cutouts, and the public SPHEREx copy on Amazon S3 | https://irsa.ipac.caltech.edu |
| IRSA SPHEREx documentation and tutorials | Flag meanings, cutout method, data format | SPHEREx Archive User Guide; IRSA cutout tutorial |
| CatWISE2020 (from NASA's WISE/NEOWISE) | Linked per event to check for known red, moving objects (link only) | VizieR II/365 |
| IRSA Finder Chart | Linked per event for images from other surveys (link only) | https://irsa.ipac.caltech.edu |

## Space agency partner data

| Data | Used for | Reference |
|---|---|---|
| Gaia DR3 (ESA) | Star positions, proper motions and parallaxes for the overlay, known-mover matching and alignment checks | ESA Gaia Archive; Gaia Collaboration et al. 2023, A&A 674, A1 |

## Other data, services and references

- CDS, Strasbourg: SIMBAD and Sesame (name lookup and proper motions), VizieR (catalogue links), Aladin Lite 3.8.2 (sky map).
- SkyBoT, IMCCE / Paris Observatory: linked per event to check for known asteroids.
- Python libraries: Astropy, astroquery, pyvo, reproject, photutils, NumPy, SciPy, FastAPI, Uvicorn, Pydantic, requests, httpx, aiohttp, fsspec, PyYAML, pytest.
- Interface: Lucide icons (ISC licence), IBM Plex fonts (SIL OFL), Okabe–Ito colour palette, cividis colour map (Nuñez, Anderton & Renslow 2018).
- Prior work that inspired it: WiseView and Backyard Worlds: Planet 9 (no code reused).
- Hosting and tooling: GitHub, GitHub Pages, GitHub Actions, Docker, Microsoft Azure Container Apps.

Full credits and required acknowledgement wording: [CITATION.md](../CITATION.md).
