"""Owner: B. Assumption tests on real SPHEREx stamps (tests/fixtures/, made by scripts/make_fixtures.py).

Offline. These pin down facts the pipeline relies on, so a new data release that changes them
fails CI instead of silently producing wrong images.
"""
import warnings
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from backend.catalogs import mjd_to_year, propagate
from backend.config import band_range, get_config
from backend.fits_processor import group_epochs

warnings.simplefilter("ignore", FITSFixedWarning)

FIX = Path(__file__).resolve().parent / "fixtures"
STAMPS = sorted(FIX.glob("barnard_E*_D*.fits"))
CFG = get_config()

# Gaia DR3 4472832130942575872 (Barnard's Star), epoch J2016.0. [verify against the Gaia archive]
GAIA = dict(ra=269.44850252543836, dec=4.739420051112412, pmra=-801.551, pmdec=10362.394)

pytestmark = pytest.mark.skipif(not STAMPS, reason="run scripts/make_fixtures.py first")


def flag_bits(hdr) -> dict[str, int]:
    return {hdr[k].strip(): hdr["MSKM" + k[4:]] for k in hdr if k.startswith("MSKN")}


def star_pixel(h):
    hdr = h["IMAGE"].header
    ra, dec = propagate(GAIA["ra"], GAIA["dec"], GAIA["pmra"], GAIA["pmdec"], 2016.0, mjd_to_year(hdr["MJD-AVG"]))
    x, y = WCS(hdr).all_world2pix(ra, dec, 0)
    return float(x), float(y)


def test_three_epochs_per_detector():
    for det in (1, 4):
        mjds = [fits.getheader(p, "IMAGE")["MJD-AVG"] for p in STAMPS if p.stem.endswith(f"D{det}")]
        assert len(set(group_epochs(mjds, CFG["epochs"]["gap_days"]))) == 3


@pytest.mark.parametrize("path", STAMPS, ids=lambda p: p.stem)
def test_units_and_flag_names_match_config(path):
    with fits.open(path) as h:
        assert h["IMAGE"].header["BUNIT"].replace(" ", "") == CFG["image_unit"]
        names = set(flag_bits(h["FLAGS"].header))
        for group, wanted in CFG["flags"].items():
            missing = set(wanted) - names
            assert not missing, f"config flags.{group} names not in FLAGS header: {missing}"


@pytest.mark.parametrize("path", STAMPS, ids=lambda p: p.stem)
def test_gaia_position_lands_on_star(path):
    """Stamp WCS + PM propagation put Barnard within ~1.5 native pixels of its brightness peak."""
    with fits.open(path) as h:
        img = h["IMAGE"].data - h["ZODI"].data
        x, y = star_pixel(h)
        ix, iy = int(round(x)), int(round(y))
        box = np.nan_to_num(img[iy - 3:iy + 4, ix - 3:ix + 4])
        yy, xx = np.mgrid[iy - 3:iy + 4, ix - 3:ix + 4]
        w = np.clip(box, 0, None)
        cx, cy = (w * xx).sum() / w.sum(), (w * yy).sum() / w.sum()
        offset_arcsec = np.hypot(cx - x, cy - y) * CFG["pixel_scale_arcsec"]
        assert offset_arcsec < 9.0


@pytest.mark.parametrize("path", STAMPS, ids=lambda p: p.stem)
def test_wavelength_at_star_is_inside_detector_band(path):
    """WCS-WAVE is a [y, x] grid in 1-based full-detector pixels; CUTX0/CUTY0 map stamp -> detector."""
    from scipy.interpolate import RegularGridInterpolator

    with fits.open(path) as h:
        det = h["IMAGE"].header["DETECTOR"]
        t = h["WCS-WAVE"].data
        X, Y, V = t["X"][0], t["Y"][0], t["VALUES"][0]
        x, y = star_pixel(h)
        xd, yd = x + h["IMAGE"].header["CUTX0"] + 1, y + h["IMAGE"].header["CUTY0"] + 1
        lam = float(RegularGridInterpolator((Y, X), V[:, :, 0])((yd, xd)))
        lo, hi = band_range(f"D{det}")
        assert lo <= lam <= hi
        # the linear variable filter runs along detector y, not x
        assert np.ptp(V[:, V.shape[1] // 2, 0]) > 10 * np.ptp(V[V.shape[0] // 2, :, 0])


@pytest.mark.parametrize("path", STAMPS, ids=lambda p: p.stem)
def test_display_mask_keeps_saturated_star(path):
    """Barnard's core is flagged OVERFLOW; the display mask must not remove it."""
    with fits.open(path) as h:
        bits = flag_bits(h["FLAGS"].header)
        flags = h["FLAGS"].data
        x, y = star_pixel(h)
        ix, iy = int(round(x)), int(round(y))
        core = flags[iy - 1:iy + 2, ix - 1:ix + 2]
        display = sum(bits[n] for n in CFG["flags"]["display_mask"])
        reject = sum(bits[n] for n in CFG["flags"]["photometry_reject"])
        assert ((core & reject) != 0).any(), "expected the saturated core to be flagged for photometry"
        assert ((core & display) != 0).mean() < 0.5
