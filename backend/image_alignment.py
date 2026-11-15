"""Reprojection onto one shared north-up grid. Owner: B.

Movers shift only 1-2 SPHEREx pixels per year, so reproject onto a 2x
oversampled grid (~3"/px) and let the browser upscale.
"""
from __future__ import annotations

import numpy as np
from astropy.wcs import WCS
from reproject import reproject_interp


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


def reproject_to(image: np.ndarray, image_wcs: WCS, out_wcs: WCS) -> np.ndarray:
    """Bilinear reprojection of a surface-brightness image (MJy/sr) onto out_wcs.

    Surface brightness is preserved (no flux rescaling): a source's summed pixel values change
    with pixel area, so photometry must use the *output* pixel solid angle. Pixels outside the
    input footprint, or next to NaN input pixels, come back NaN.
    """
    shape = (out_wcs.pixel_shape[1], out_wcs.pixel_shape[0])
    out = reproject_interp((image, image_wcs), out_wcs, shape_out=shape, order="bilinear", return_footprint=False)
    return out.astype(np.float32)


def to_display_rows(arr: np.ndarray) -> np.ndarray:
    """FITS row 0 is south; the API wants row 0 = top = north."""
    return np.ascontiguousarray(arr[::-1])
