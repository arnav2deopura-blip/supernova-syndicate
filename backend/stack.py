"""Shift-and-stack: co-add every exposure in the frame that moves with the target. Owner: B.

A plain all-passes stack smears a fast mover along its track (WISE 0855: ~12" over the survey, 4 output px),
so its light is spread out and it can vanish into the noise. Re-centring every exposure on the target's
predicted position at that exposure's time (proper motion from /api/resolve or Gaia) stacks the mover's light
on one spot instead; stationary stars smear into streaks, which is the visual proof the motion is real.

Returns both stacks on the same-sized grid, so the UI can blink static vs co-moving.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from .config import get_config
from .fits_processor import PreparedStamp, coadd_clipped
from .image_alignment import reproject_to, to_display_rows
from .photometry import Track
from .pipeline import output_grid


def target_snr(img: np.ndarray, r: int = 1) -> Optional[float]:
    """Peak of the (2r+1)^2 box at the grid centre above the median, in units of the image's robust pixel
    scatter. Relative measure: compare stacks of the same data, not different targets."""
    if not np.isfinite(img).any():
        return None
    h, w = img.shape
    box = img[h // 2 - r:h // 2 + r + 1, w // 2 - r:w // 2 + r + 1]
    if not np.isfinite(box).any():
        return None
    v = img[np.isfinite(img)]
    med = float(np.median(v))
    sd = 1.4826 * float(np.median(np.abs(v - med)))
    return round(float((np.nanmax(box) - med) / sd), 2) if sd > 0 else None


def shift_and_stack(stamps: list[PreparedStamp], track: Track, fov: float, ref_mjd: Optional[float] = None) -> dict:
    """{"ref_mjd", "ref_ra", "ref_dec", "static", "comoving"}: each a dict with the array, n and target S/N.
    The static grid is centred on the target at ref_mjd (default: the mean exposure time) as well, so both
    images show the same sky at the reference time."""
    if ref_mjd is None:
        ref_mjd = float(np.mean([s.mjd for s in stamps]))
    ra0, dec0 = track.at(ref_mjd)
    static_wcs = output_grid(ra0, dec0, fov)
    st_imgs, mv_imgs = [], []
    for s in stamps:
        st_imgs.append(reproject_to(s.image, s.wcs, static_wcs))
        ra_t, dec_t = track.at(s.mjd)
        mv_imgs.append(reproject_to(s.image, s.wcs, output_grid(ra_t, dec_t, fov)))
    noise = [s.bkg_rms for s in stamps]
    out = {"ref_mjd": round(ref_mjd, 5), "ref_ra": round(float(ra0), 7), "ref_dec": round(float(dec0), 7)}
    for name, imgs in (("static", st_imgs), ("comoving", mv_imgs)):
        img, _, _ = coadd_clipped(imgs, noise)
        disp = to_display_rows(img)
        out[name] = {"array": disp, "n_exposures": len(imgs), "target_snr": target_snr(disp)}
    w, h = static_wcs.pixel_shape
    cfg = get_config()
    out["wcs"] = {"center_ra": out["ref_ra"], "center_dec": out["ref_dec"],
                  "pixel_scale_arcsec": cfg["pixel_scale_arcsec"] / cfg["oversample"], "width": w, "height": h}
    span_yr = (max(s.mjd for s in stamps) - min(s.mjd for s in stamps)) / 365.25
    out["smear_arcsec"] = round(float(np.hypot(track.pmra, track.pmdec)) / 1000 * span_yr, 2)
    return out
