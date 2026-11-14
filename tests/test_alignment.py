"""Owner: B. Offline only."""
import numpy as np
import pytest

from astropy.wcs import WCS

from backend.image_alignment import reproject_to, target_wcs, to_display_rows


def test_target_wcs_is_north_up_and_centred():
    w = target_wcs(269.45, 4.69, fov_deg=0.04, pixel_scale_arcsec=3.075)
    n = w.pixel_shape[0]
    assert n == 47
    ra, dec = w.wcs_pix2world([[(n - 1) / 2, (n - 1) / 2]], 0)[0]
    assert np.isclose(ra, 269.45) and np.isclose(dec, 4.69)
    # one pixel up (+y) is north
    _, dec_up = w.wcs_pix2world([[(n - 1) / 2, (n - 1) / 2 + 1]], 0)[0]
    assert dec_up > dec


def _rotated_input(ra, dec, scale_arcsec=6.15, angle_deg=28.0, n=40):
    """A SPHEREx-like tilted TAN grid (like the PC matrix in real headers)."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [n / 2 + 0.3, n / 2 - 0.4]
    t = np.radians(angle_deg)
    s = scale_arcsec / 3600
    w.wcs.cd = [[-s * np.cos(t), s * np.sin(t)], [s * np.sin(t), s * np.cos(t)]]
    w.pixel_shape = (n, n)
    return w


def test_reproject_puts_known_star_on_the_right_pixel():
    ra0, dec0 = 269.45, 4.70
    star_ra, star_dec = ra0 + 0.004, dec0 + 0.006  # ~14" E, 22" N of centre
    win = _rotated_input(ra0, dec0)
    sx, sy = win.all_world2pix(star_ra, star_dec, 0)
    yy, xx = np.mgrid[0:40, 0:40]
    img = 100 * np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * 0.55 ** 2))  # FWHM ~ 7.5"

    out_wcs = target_wcs(ra0, dec0, fov_deg=0.05, pixel_scale_arcsec=3.075)
    out = reproject_to(img, win, out_wcs)
    ex, ey = out_wcs.all_world2pix(star_ra, star_dec, 0)
    r, c = np.unravel_index(np.nanargmax(out), out.shape)
    box = np.nan_to_num(out[r - 3:r + 4, c - 3:c + 4])
    by, bx = np.mgrid[r - 3:r + 4, c - 3:c + 4]
    cy, cx = (box * by).sum() / box.sum(), (box * bx).sum() / box.sum()
    assert abs(cx - ex) < 0.25 and abs(cy - ey) < 0.25
    # surface brightness is preserved: peak stays within interpolation smoothing of the input peak
    assert 40 < np.nanmax(out) <= 100


def test_display_rows_put_north_on_top():
    a = np.arange(6).reshape(3, 2)  # FITS row 0 = south
    assert to_display_rows(a)[0].tolist() == [4, 5]
