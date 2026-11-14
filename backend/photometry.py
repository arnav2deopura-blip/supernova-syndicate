"""Quick-look spectrum and light curves. Owner: B.

IRSA's Spectrophotometry Tool has no batch mode and ignores proper motion, so we
do simple aperture photometry ourselves at the propagated position per exposure.
"""
from __future__ import annotations


def spectrum_at(ra: float, dec: float) -> list[dict]:
    """Issue #15: per-exposure aperture flux with wavelength at the source pixel."""
    raise NotImplementedError("Issue #15: click-for-spectrum")


def light_curve(ra: float, dec: float, band: str) -> list[dict]:
    """Issue #16: flux vs time within one detector band."""
    raise NotImplementedError("Issue #16: light curves")
