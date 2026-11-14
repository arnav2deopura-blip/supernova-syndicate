"""Name resolution, proper-motion propagation, Gaia queries. Owner: A.

Catalogue positions are years stale (Barnard's Star has moved ~4.6' since J2000),
so every named target is propagated to the current epoch before centring.
"""
from __future__ import annotations

import math

MAS_PER_DEG = 3.6e6


def propagate(ra: float, dec: float, pmra: float, pmdec: float, from_year: float, to_year: float) -> tuple[float, float]:
    """Linear proper-motion propagation.

    pmra is in mas/yr and already includes cos(dec) (Gaia/SIMBAD convention).
    Good to well under a pixel over decades for everything we target; ignores
    parallax and radial velocity.
    """
    dt = to_year - from_year
    ddec = pmdec * dt / MAS_PER_DEG
    cosd = math.cos(math.radians(dec))
    dra = (pmra * dt / MAS_PER_DEG) / cosd if cosd > 1e-9 else 0.0
    return (ra + dra) % 360.0, max(-90.0, min(90.0, dec + ddec))


def mjd_to_year(mjd: float) -> float:
    """Approximate decimal year (J2000 = MJD 51544.5)."""
    return 2000.0 + (mjd - 51544.5) / 365.25


def resolve_name(name: str) -> dict:
    """Issue #12: Sesame/SIMBAD lookup returning ra, dec, pmra, pmdec, ref epoch."""
    raise NotImplementedError("Issue #12: name resolve + proper-motion propagation")


def gaia_sources(ra: float, dec: float, fov: float) -> list[dict]:
    """Issue #14: Gaia DR3 cone search."""
    raise NotImplementedError("Issue #14: Gaia overlay")
