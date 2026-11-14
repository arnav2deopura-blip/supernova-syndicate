"""Reprojection onto one shared north-up grid. Owner: B.

Movers shift only 1-2 SPHEREx pixels per year, so reproject onto a 2x
oversampled grid (~3"/px) and let the browser upscale.
"""
from __future__ import annotations

from astropy.wcs import WCS


def target_wcs(ra: float, dec: float, fov_deg: float, pixel_scale_arcsec: float) -> WCS:
    """North-up, east-left TAN grid centred on (ra, dec) covering fov_deg square."""
    n = max(1, int(round(fov_deg * 3600 / pixel_scale_arcsec)))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-pixel_scale_arcsec / 3600, pixel_scale_arcsec / 3600]
    w.pixel_shape = (n, n)
    return w


def reproject_to(image, image_wcs: WCS, out_wcs: WCS):
    """Issue #6: reproject one cutout onto out_wcs (use reproject.reproject_interp)."""
    raise NotImplementedError("Issue #6: reprojection to common grid")
