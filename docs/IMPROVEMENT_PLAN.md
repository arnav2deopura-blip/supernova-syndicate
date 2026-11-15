# Improvement plan: make discoveries easy (recommendations, not built yet)

**Status:** the frontend parts of §1–§7 are implemented (σ-change view with auto-markers and Events, any two passes, tour + glossary + field guide, channel ranges and molecule presets, Colours view, Advanced drawer, one notice component, timeline, save image/movie, embed mode). Still open: the backend `/api/changes` endpoint (§1 step 2; the browser detector in `frontend/js/changes.js` covers the frontend half), exposing exposure time / PSF FWHM / parallax errors (§4), CatWISE overlay, discovery feed. It builds on branch `c/search-modes` (the three search modes, async jobs).

**Browser detector as built:** σ = (B − A) / √(σA² + σB² + (f·max(|A|,|B|))²), with the field median removed and the scatter widened (never narrowed) to unit robust std; regions ≥ 5σ. f = 10 % ("Careful") or 5 % ("Sensitive"): without this brightness floor every bright star becomes a change, because the noise maps are background-only. Fading + brightening pairs within (12″/yr·Δt + 2 PSF) become one "moved" event. Events near a Gaia high-proper-motion star or an `/api/movers` track merge into one known-mover / candidate event; a target with `/api/lightcurve` `variable: true` gets one ◐ event. On the presets: Barnard's Star → one known mover (10.4″/yr), WISE 0855 → the movers candidate (8.4″/yr), RW Aur → variable. `node scripts/check_changes.mjs --inject` recovers every injected 12σ source on empty sky.

**Goal:** the whole point of the tool is finding **changes** between SPHEREx passes: things that move, appear, disappear or change brightness. Everything below is ranked by how much it helps a beginner find a real change, and how much it helps a scientist trust it.

**Why user-friendliness matters for winning:** the Space Apps judging guide scores five criteria: Impact, Creativity, Validity, Relevance and Presentation. **Validity explicitly includes "usability and user-friendliness"**. Relevance rewards using NASA data "as a core component", not decoration. ([Judging & Awards Guide](https://www.spaceappschallenge.org/resources/judging-awards-guide))

---

## 0. Summary and priorities

| # | Recommendation | Who asked | Effort | Backend change? | Priority |
|---|---|---|---|---|---|
| 1 | **"What changed?" markers**: circle sources that appear, disappear, brighten/fade or move | Chakshu | M (frontend σ-map) + L (`/api/changes`) | yes, new endpoint | **P0** |
| 2 | **Skippable guided tour** + glossary tooltips | Chakshu | S–M | no | **P0** |
| 3 | **Pick any two passes** to difference, plus a σ-significance view | challenge text | S | no (noise maps exist) | **P0** |
| 4 | **102 bands made browsable**: detector bands → channel ranges → molecule presets | Chakshu | M | no (`/api/cube` exists) | P1 |
| 5 | **Advanced drawer** for professionals: per-exposure metadata, derived physics, "Unknown" when missing | Chakshu | M | small (expose header fields) | P1 |
| 6 | **One error/empty-state system** used everywhere | Chakshu | S | no | P1 |
| 7 | Layout, "is it new?" checker, GIF export, embeds, discovery feed… | Chakshu | varies | some | P2 (pick after demo-critical items) |

S = a few hours, M = about half a day, L = a day or more.

---

## 1. Discovery: circle what appeared, disappeared or changed (P0)

### What exists today
- `/api/movers` already finds **moving** sources across passes and labels them `candidate` (moves, and no Gaia source follows it), `known_mover`, `stationary`, and so on (`backend/discovery.py`).
- Every frame has a calibrated **noise map**, so `(B − A) / sqrt(σA² + σB²)` is a true significance per pixel (docs/API.md, "Frame extras").
- **Missing:** nothing detects a source that is present in one pass and absent in another, and the frontend shows no markers at all.

### Step 1 (frontend only, quick win): change-significance view
- New display mode **"Changes (σ)"**: compute the σ-difference between two chosen passes from `data` and `noise` (both already downloaded as blobs), and show it with a diverging map clipped at ±5σ.
- Auto-circle connected regions with |σ| ≥ 5: green ring = brighter or new, red ring = fainter or gone. A red+green pair next to each other (a "dipole") is drawn as one arrow and labelled "moved".
- Caveat shown in the UI: bright stars leave residuals larger than the noise map (documented in API.md), so rings near saturated stars are dashed, "low confidence".

### Step 2 (backend): `GET /api/changes?ra=&dec=&fov=&band=[&matched=1][&snr_min=5][&async=1]`
Built from parts that already exist: `discovery.detect`, the noise maps, `frame_astrometry` registration, and the Gaia field.

1. Detect sources in every pass frame (as `find_movers` does).
2. For every detection, **force-measure** the same sky position in every other pass (shifted by Gaia proper motion when matched), giving S/N per pass.
3. Classify each source:

| `kind` | Rule (starting point, tune on the 5 presets) |
|---|---|
| `appeared` | ≥ 5σ in a later pass, < 2σ in every earlier pass that has valid pixels there |
| `disappeared` | the reverse |
| `brightened` / `faded` | present in all passes, σ-difference ≥ 5 **and** flux ratio beyond the systematic floor (2 %, as `/lightcurve` uses) |
| `single_pass` | in exactly one pass: most likely an asteroid or comet. Cross-match with **IMCCE SkyBoT** (known solar-system objects at that time and place) and label it |
| `moved` | merged in from `/api/movers`. An "appeared" plus a "disappeared" within `max_pm × Δt` of each other is one mover, not two events |

4. **False-positive guards.** These matter more than the detector: a fake discovery in the demo would hurt Validity.
   - Use **matched wavelengths** (`matched=1`) by default. A plain SPHEREx pass samples different channels each time, so a red star can "brighten" just because the bandpass moved (WISE 0855 spans 4.71–4.94 µm across passes).
   - **No data ≠ absent**: if the position is masked or off the cutout in a pass, report `no_data` for that pass.
   - Check the L2 `FLAGS` plane near the position: `TRANSIENT`, `GHOST`, `PERSIST`, `SNOWBALL`, `XTALK`, `OVERFLOW`. The headers count these per exposure (`L2 N_TRANSIENT`, `L2 N_GHOST`, …).
   - Reuse the existing artefact radius around saturated stars, and the frame registration offset.
   - The PSF is ~6–7″, so two neighbours can blend and unblend; flag events within one PSF of a Gaia source.
5. **Output per event:** `id, kind, ra, dec, passes[] {epoch_label, snr, flux, flux_err, state: detected|absent|no_data}, sigma_change, flags[], known: {gaia|skybot|simbad|null}, confidence: high|low`.

### Frontend for events
- Rings on the viewer, coloured **and** shaped by kind, so they work for colour-blind users: ○ appeared, ✕ disappeared, ◐ variable, → moved, □ single-pass. Unconfirmed events get dashed rings.
- An **"Events" list** beside the viewer, sorted by confidence. Clicking an event zooms the blink to that source, shows its per-pass S/N strip and spectrum, and shows one-click checks (section 7).
- **"Report this"** exports JSON/CSV plus the FITS cutout (`/api/frames.fits`), so a volunteer can send a candidate to a professional.

### Validation before the demo
- Inject fake point sources into one pass of a cached frame and check they come back as `appeared`.
- Run all 5 presets. Barnard's Star, ε Indi B and WISE 0855 must come out as `moved` (not appear/disappear pairs). RW Aur and R Dra must come out as `brightened`/`faded`. Stationary field stars must give (almost) zero events.
- Be honest in the UI: with only 2–3 passes per position so far, most single-pass events will be asteroids or artefacts. Say so in the event tooltip.

---

## 2. Beginner friendliness and a skippable tutorial (P0)

### What we can borrow from Backyard Worlds (the challenge cites it)
The Backyard Worlds Zooniverse FAQ teaches beginners mostly through recognising patterns ([FAQ](https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq)):
- A **real mover is in every frame**. One seen in only 2 frames is probably a ghost.
- **Dipoles** (black-and-white "cookies") mean slow motion. Stars that "dance" all together mean a pointing artefact.
- Black patches are data gaps, long stripes are diffraction spikes from bright stars, and big blobs are often variable red giants.
- The **quadrant method**: watch one quarter of the image at a time.
- **Check SIMBAD/VizieR before reporting.**

So beginners need **examples of what real vs fake looks like** more than they need instructions. Our 5 presets give us real examples of each.

### Tutorial design
- **6–8 coach-mark steps** (an anchored popover with a dimmed backdrop; hand-written, ~150 lines, no library needed):
  1. *Pick a patch of sky* — the three tabs; starts on Barnard's Star, which is precomputed so the tour never waits.
  2. *This is a little movie* — each frame is one six-month pass; Play/Pause; arrow keys step frames.
  3. *Spot the mover* — switch to Difference; the black/white pair is Barnard's Star moving 10″/yr.
  4. *Circles* — what the event rings and Gaia circles mean.
  5. *Colours of light* — bands, µm, why a brown dwarf is bright in D6.
  6. *Click a star* — the spectrum.
  7. *Is it new?* — the check buttons and the report flow.
  8. *For scientists* — where the Advanced drawer is.
- **Skippable everywhere**: Skip and ✕ on every step, Esc closes. "Don't show again" is stored in `localStorage` (inside try/catch). A **"?" button** in the header restarts it, and `?tour=1` deep-links to it.
- **Field-guide panel** ("What am I looking at?"): small looping GIFs from our presets — mover (Barnard's), faint red mover (WISE 0855), dipole, variable star (R Dra), artefact (saturated-star halo), data gap.

### Glossary tooltips (ⓘ next to the term, one sentence each, plain language first)
RA/Dec · field of view · pass/epoch · band/detector · channel · µm · MJy/sr vs µJy · proper motion (mas/yr, ″/yr) · σ and S/N · matched wavelengths · co-add · difference image · dipole · flags (OVERFLOW = saturated, …) · Gaia.

### Plain-language controls
- Rename for beginners and keep the technical name in the tooltip: "Stretch" → **Contrast**, "Clip %" → **Brightness cap**, "Blink" → **Play passes**, "Matched wavelengths" → **Fair brightness comparison**.
- Default view = viewer, Play, Difference toggle and Events. Colormap, stretch and clip move into "Display options" (collapsed).

---

## 3. Make the 102 bands browsable (P1)

**What we show today:** 6 detector bands. Each is a co-add of its 17 channels, which is exactly what the challenge suggests for signal-to-noise. In Explore mode the sky-map slider already steps through all 102 channels (IRSA all-sky cube). Individual channels are not shown in the comparison viewer yet, though `/api/cube` already serves them.

**On Chakshu's idea of ranges like 1–20, 20–41, … 102:** the instinct is right (group channels so they are easy to scan), but fixed blocks of 20 would cross detector boundaries. Channels 1–17 are detector D1, 18–34 are D2, and so on. A block like 1–20 would mix two different detectors, each with its own noise, PSF and coverage, and blocks would also straddle the blank dichroic channels (D3C17, D4C01). Differences inside such an image could come from the instrument rather than the sky. Recommended instead, three levels:

1. **Detector bands (default, best S/N):** D1 … D6, labelled with wavelength and colour, e.g. "D4 · 2.4–3.8 µm".
2. **Channel ranges inside one detector:** a two-handle range slider over that detector's 17 channels (e.g. "D6 channels 5–9, 4.55–4.66 µm"). Data: `/api/cube?per_pass=1` gives one image per channel per pass; the **frontend sums the chosen range per pass**, so no backend change is needed. Show "fewer exposures → noisier" next to the slider.
3. **Molecule presets** (one click, matching what the challenge says SPHEREx is sensitive to): water ice ~3.05 µm (D4), PAH/CH₄ ~3.3 µm (D4), CO₂ ice ~4.27 µm (D5), CO ~4.67 µm (D6), plus a "continuum" neighbour range for comparison.

Plus a **spectral filmstrip**: 17 thumbnails per detector (up to all 102 across six `/api/cube` calls) that you can scrub, so differences between wavelengths jump out. Also an **RGB composite** of three bands (already issue #21).

---

## 4. Advanced drawer for professionals (P1)

A collapsible **"Advanced"** drawer under the viewer (closed by default, remembered per visitor).

**Rule: never fabricate.** Every value has a source. If it is missing for this target, show **Unknown** with a tooltip saying why ("no Gaia parallax", "only 2 passes", "saturated core"). Only include fields that essentially every SPHEREx L2 file carries. Checked against our fixture headers, these are present: `OBSID, DETECTOR, MJD-BEG/END/AVG, XPOSURE, PSF_FWHM, WCHANNEL/NCHANNEL, SPS_ELAT/SPS_ELON (ecliptic), X_SC/Y_SC/Z_SC (spacecraft position), L2 N_* flag counts, L2DQAFLG`, plus our own `noise_scale, astrometry_rms_arcsec, lam_eff_um, matched_channels, release`.

| Section | Contents | Source |
|---|---|---|
| Passes | MJD range and mean, N exposures (used/dropped), λ_eff, matched channels, noise scale, registration offset and rms, flagged %, release | `/api/frames` (exists) |
| Exposures | obs_id, MJD, detector, channel, λ at target, exposure time, PSF FWHM, per-flag counts, link to the L2 file | `/api/exposures` + 3–4 header fields to expose (small backend change) |
| Astrometry | μα*, μδ, total μ and PA ± errors, χ²/dof, bootstrap errors, Gaia comparison in σ, parallax when fitted | `/api/motion` (exists) |
| Photometry | spectrum (µJy), AB magnitudes, pass ratio spectrum, light-curve χ²/dof, period, `variable` / `reliable` | `/api/spectrum`, `/api/lightcurve` (exist) |
| Movers / events | track table, null-test pull widths | `/api/movers` (+ `/api/changes`) |
| Coordinates | ICRS, galactic, ecliptic | computed in the browser |

**Derived physics.** Show each formula on hover, and give Unknown when an input is missing:
- Distance: d [pc] = 1000 / ϖ [mas], only when ϖ/σϖ > 5 (Gaia or our parallax fit).
- Tangential velocity: v_t [km/s] = 4.74 · μ [″/yr] · d [pc].
- AB magnitude from flux: m_AB = 23.9 − 2.5·log₁₀(f_ν / µJy), and Δm between passes.
- Reduced proper motion: H = m + 5·log₁₀ μ[″/yr] + 5 (separates nearby dwarfs from distant giants without a parallax).
- Colour temperature from a blackbody fit to the spectrum, labelled "rough: brown dwarfs are not blackbodies".
- Event significance in σ and its false-alarm expectation for the field size.

**Exports:** FITS (`/api/frames.fits`, exists), CSV/JSON of spectrum, light curve, tracks and events, and a "copy citation" block (CITATION.md).

---

## 5. One error and empty-state system (P1)

One component with **what happened → why → what to do**, used by every mode and the Advanced drawer:

| Situation | Message (short) | Action offered |
|---|---|---|
| No SPHEREx coverage | "SPHEREx hasn't imaged this spot in this band yet." | other band · data-through date |
| Only 1 pass | "Only one pass so far — nothing to compare yet." | show the single image · next-pass estimate |
| Saturated target | "Too bright: the core is saturated (OVERFLOW)." | use a redder band, wing-fit note |
| Name not found / lookup down | (exists) | Coordinates tab |
| Slow first request | (exists: progress + cancel) | — |
| Backend down | (exists: precomputed / mock banner) | retry |
| Missing advanced field | **Unknown** + reason tooltip | — |

---

## 6. Layout ideas (P2, for the team to pick from)

- **Viewer first:** after a search, collapse the search panel to a one-line "RW Aur · D2 · 0.1° — change" bar, so the movie fills the screen.
- **Timeline strip** instead of the frames table: passes as dots on a real time axis, the current frame highlighted, and a ⚠ on flagged passes.
- **Compare tools:** pick any two passes (A/B), a swipe slider between them, side-by-side panels with synced zoom and pan, and a crosshair that follows the cursor across frames.
- **Big obvious Play**, keyboard hints shown on hover, and "reduced motion" respected (start paused).
- A colour-blind-safe palette, and shapes as well as colours for every marker.

## 7. Feature ideas, spectacular or practical (P2, recommendations only)

- **"Is it new?" checker:** one click opens SIMBAD, VizieR (CatWISE), the IRSA Finder Chart, Gaia and SkyBoT at that position, and our backend can pre-check Gaia/SkyBoT itself. This mirrors Backyard Worlds' "check before you report".
- **Discovery feed:** precompute a handful of fields with the most passes (near the ecliptic poles SPHEREx revisits constantly) and show a gallery of `candidate` and `appeared` events for volunteers to vote "real / artefact". Strong Impact and Presentation story.
- **GIF / MP4 export** of the blink (issue #21), for sharing on social media and in the demo video.
- **Embed mode:** `embed.html?ra=&dec=&band=` — a bare player for other websites (the challenge mentions embedding).
- **CatWISE overlay** for very red sources Gaia misses (WISE 0855 is invisible to Gaia).
- **Spectral scrub animation:** play through the 102 channels instead of through time. Visually striking for the demo.
- **"New data" badge:** `/api/meta?check=1` already detects new releases; show "New SPHEREx data since your last visit".
- **Sonification** (optional, accessibility and wow factor): map brightness change to pitch while blinking.

---

## 8. Suggested order

1. **P0, demo-critical:** σ-change view with auto-rings (frontend), any-two-pass difference, tour + glossary.
2. **P1:** `/api/changes` (backend) wired into the rings and Events list, band ranges and molecule presets, Advanced drawer, unified errors.
3. **P2:** feed, GIF export, embed, CatWISE, layout polish.

Each step ships on its own branch with the existing verification loop (all 5 presets, mock mode, phone width).

## Sources
- Space Apps judging criteria: https://www.spaceappschallenge.org/resources/judging-awards-guide
- Backyard Worlds FAQ (beginner guidance, artefacts): https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9/about/faq
- Space Apps 2024 global winners: https://www.nasa.gov/learning-resources/stem-engagement-at-nasa/nasa-international-space-apps-challenge-announces-2024-global-winners/
- SPHEREx DR1 all-sky HiPS cube (IRSA): https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube
