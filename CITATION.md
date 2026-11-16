# Data credits and citation

## SPHEREx

This project uses data from SPHEREx, a NASA mission, obtained from the NASA/IPAC
Infrared Science Archive (IRSA).

- SPHEREx DR1 spectral images: doi:[10.26131/IRSA678](https://doi.org/10.26131/IRSA678)
- SPHEREx DR1 all-sky spectral cube: doi:[10.26131/IRSA679](https://doi.org/10.26131/IRSA679)
- Quick Release 3 (QR3) products are used alongside DR1. **[TODO: add QR3 DOI from the IRSA SPHEREx page]**

> This research has made use of the NASA/IPAC Infrared Science Archive, which is
> funded by the National Aeronautics and Space Administration and operated by the
> California Institute of Technology.

**[TODO: paste the exact SPHEREx acknowledgement text from the IRSA DR1 overview page.]**

## Gaia

> This work has made use of data from the European Space Agency (ESA) mission
> Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing
> and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium).
> Funding for the DPAC has been provided by national institutions, in particular
> the institutions participating in the Gaia Multilateral Agreement.

Gaia Collaboration et al. (2023), *Gaia Data Release 3*, A&A 674, A1.

## Other services

- SIMBAD and Sesame name resolution, CDS, Strasbourg, France.
- Aladin Lite (if used), CDS.
- Astropy, astroquery, pyvo, reproject, photutils.

## Interface

- Icons: [Lucide](https://lucide.dev) (ISC licence), inline SVG, only the icons the interface uses.
- Type: IBM Plex Sans and IBM Plex Mono ([SIL Open Font License 1.1](https://github.com/IBM/plex)) when installed on the
  viewer's machine; otherwise the system interface and monospace fonts. No font files are bundled yet.
- Colour-vision-safe marker colours: the Okabe–Ito palette. Colour map option: cividis (Nuñez, Anderton & Renslow 2018,
  arXiv:1712.01662).

## Prior work we learned from

- WiseView (ascl:1806.004), the blink tool used by Backyard Worlds.
- `xcavation` and `SPIFF` SPHEREx photometry tools. **[TODO: check licences before reusing any code.]**
