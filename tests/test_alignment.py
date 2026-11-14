"""Owner: B. Offline only."""
import numpy as np
import pytest

from backend.image_alignment import target_wcs


def test_target_wcs_is_north_up_and_centred():
    w = target_wcs(269.45, 4.69, fov_deg=0.04, pixel_scale_arcsec=3.075)
    n = w.pixel_shape[0]
    assert n == 47
    ra, dec = w.wcs_pix2world([[(n - 1) / 2, (n - 1) / 2]], 0)[0]
    assert np.isclose(ra, 269.45) and np.isclose(dec, 4.69)
    # one pixel up (+y) is north
    _, dec_up = w.wcs_pix2world([[(n - 1) / 2, (n - 1) / 2 + 1]], 0)[0]
    assert dec_up > dec


@pytest.mark.skip(reason="Issue #7: needs a fixture FITS cutout in tests/fixtures/")
def test_reproject_shifts_known_star():
    pass
