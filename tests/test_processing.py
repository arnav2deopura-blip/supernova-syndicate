"""Owner: B. Offline only: no live IRSA calls."""
import numpy as np

from backend.catalogs import mjd_to_year, propagate
from backend.fits_processor import assign_epochs, coadd, epoch_bins, epoch_label, group_epochs, mask_and_subtract


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


def test_epoch_bins_gap_split_like_three_survey_passes():
    mjds = [60912.7, 60917.6, 61114.0, 61116.7, 61273.4, 61280.2]  # Barnard D2 pass dates
    assert epoch_bins(mjds, 60, 45) == [(60912.7, 60917.6), (61114.0, 61116.7), (61273.4, 61280.2)]


def test_epoch_bins_keep_side_visit_in_its_pass():
    # Barnard, all detectors: main pass + a 5-exposure visit ~25 d later must stay one epoch
    mjds = [60902.9, 60910.0, 60923.1, 60948.6, 60949.3, 61110.1, 61124.9, 61140.0, 61165.1, 61268.6, 61305.6]
    assert len(epoch_bins(mjds, 60, 90)) == 3


def test_epoch_bins_split_continuous_polar_coverage():
    mjds = list(np.arange(60800.0, 60980.0, 2.0))  # every 2 days for ~6 months, no gaps
    bins = epoch_bins(mjds, 60, 90)
    assert len(bins) == 2 and all(b - a <= 90 for a, b in bins)
    assert bins[0][0] == 60800.0 and bins[-1][1] == 60978.0


def test_epoch_bins_split_long_run_at_its_real_gap():
    mjds = list(np.arange(60800.0, 60850.0, 1.0)) + list(np.arange(60890.0, 60950.0, 1.0))  # 40 d gap < 60
    bins = epoch_bins(mjds, 60, 90)
    assert bins == [(60800.0, 60849.0), (60890.0, 60949.0)]


def test_assign_epochs_uses_shared_bins():
    bins = [(100.0, 105.0), (300.0, 310.0)]
    assert assign_epochs([100.5, 305.0, 310.4, 200.0], bins) == [0, 1, 1, 0]
