"""Owner: B. Offline only: no live IRSA calls."""
import numpy as np

from backend.catalogs import mjd_to_year, propagate
from backend.fits_processor import coadd, epoch_label, group_epochs, mask_and_subtract


def test_group_epochs_splits_on_gap():
    mjds = [60810.0, 60811.5, 60995.0, 60812.0, 61180.0]
    assert group_epochs(mjds, gap_days=60) == [0, 0, 1, 0, 2]


def test_group_epochs_empty():
    assert group_epochs([]) == []


def test_epoch_label():
    assert epoch_label(0) == "E1"


def test_coadd_ignores_nan():
    a = np.array([[1.0, np.nan]])
    b = np.array([[3.0, 4.0]])
    out = coadd([a, b])
    assert out[0, 0] == 2.0 and out[0, 1] == 4.0


def test_coadd_variance_weighting():
    a = np.array([[0.0]])
    b = np.array([[10.0]])
    out = coadd([a, b], [np.array([[1.0]]), np.array([[9.0]])])
    assert np.isclose(out[0, 0], 1.0)  # weights 1 and 1/9


def test_mask_and_subtract():
    img = np.full((2, 2), 5.0)
    flags = np.array([[0, 1], [0, 0]])
    out = mask_and_subtract(img, flags, zodi=np.full((2, 2), 1.0), bad_bits=1)
    assert np.isnan(out[0, 1]) and out[0, 0] == 4.0


def test_propagate_barnards_moves_north():
    # ~10.4"/yr north for 26 years -> ~4.5 arcmin
    ra, dec = propagate(269.452, 4.693, -801.551, 10362.394, 2000.0, 2026.0)
    assert 4.3 < (dec - 4.693) * 60 < 4.7
    assert ra < 269.452


def test_mjd_to_year():
    assert abs(mjd_to_year(51544.5) - 2000.0) < 1e-9
