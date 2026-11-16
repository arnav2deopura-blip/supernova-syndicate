# Data credits and citation

## SPHEREx

This project uses data from SPHEREx, a NASA mission, obtained from the NASA/IPAC
Infrared Science Archive (IRSA).

- SPHEREx DR1 spectral images: doi:[10.26131/IRSA678](https://doi.org/10.26131/IRSA678)
- SPHEREx DR1 all-sky spectral cube: doi:[10.26131/IRSA679](https://doi.org/10.26131/IRSA679)
- SPHEREx Quick Release 3 spectral images: doi:[10.26131/IRSA662](https://www.ipac.caltech.edu/doi/10.26131/IRSA662). Used alongside DR1, which supersedes QR2.

> This research has made use of the NASA/IPAC Infrared Science Archive, which is
> funded by the National Aeronautics and Space Administration and operated by the
> California Institute of Technology.

SPHEREx is a joint Jet Propulsion Laboratory/California Institute of Technology project funded by NASA. Publications must include the full mission acknowledgement supplied on the [official IRSA mission page](https://irsa.ipac.caltech.edu/Missions/spherex.html#). This page is the authoritative source for the required wording.

## Gaia

> This work has made use of data from the European Space Agency (ESA) mission
> Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing
> and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium).
> Funding for the DPAC has been provided by national institutions, in particular
> the institutions participating in the Gaia Multilateral Agreement.

Gaia Collaboration et al. (2023), *Gaia Data Release 3*, A&A 674, A1.

## Other services

- SIMBAD and Sesame name resolution, CDS, Strasbourg, France.
- Aladin Lite 3.8.2, CDS: [project and licence](https://github.com/cds-astro/aladin-lite). Loaded from the CDS distribution; its built-in attribution is retained.
- Astropy, astroquery, pyvo, reproject, photutils.

## Interface

- Icons: [Lucide](https://lucide.dev) (ISC licence), inline SVG, only the icons the interface uses.
- Type: IBM Plex Sans and IBM Plex Mono ([SIL Open Font License 1.1](https://github.com/IBM/plex)) when installed on the
  viewer's machine; otherwise the system interface and monospace fonts. No font files are bundled yet.
- Colour-vision-safe marker colours: the Okabe–Ito palette. Colour map option: cividis (Nuñez, Anderton & Renslow 2018,
  arXiv:1712.01662).

## Prior work we learned from

- WiseView (ascl:1806.004), the blink tool used by Backyard Worlds.
- `xcavation` and `SPIFF` were considered as related work. No code from either is imported or vendored by this repository. Any future reuse needs a separate licence review.

## Interaction audit and optimization

OpenAI Codex assisted with the 15 November 2026 browser audit, interaction fixes,
metadata availability rules, playback caches, and repeatable acceptance tests.
These changes introduce no new scientific data source or astronomical measurements.
See `docs/ACCEPTANCE_AUDIT.md` for verification scope and limitations.


## Team and implementation assistance

Sphere Shift: Chakshu Parnam, Arnav Deopura, and Mohammed Zaid Khan.
Anthropic Claude assisted planning/scaffolding and Claude Code the frontend redesign; OpenAI Codex assisted implementation,
reliability fixes, test automation, and documentation. Generated code is not evidence of
scientific validity; see the current release readiness report and recorded live checks.
The interface uses neutral CSS colours only and adds no image source; the picker thumbnails are rendered from the saved SPHEREx frames (`scripts/make_thumbs.py`).

Sources verified 15 November 2026: the official IRSA mission page above, the QR3 DOI
record, and the [IRSA cutout tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/).
Python dependencies retain their upstream licences; see each package's installed metadata.
