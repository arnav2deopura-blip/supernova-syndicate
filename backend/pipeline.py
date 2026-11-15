"""Coordinates in, co-added epoch frames out. Owner: B (science) / A (I/O).

    exposures (TAP or S3 scan) -> stamps -> prepare (zodi, display mask, bkg, wavelength)
    -> reproject to one north-up grid -> group by epoch -> clipped co-add per epoch

Pure orchestration: the science lives in fits_processor / image_alignment, the I/O in
spherex_client. `progress(stage, done, total)` lets a job runner report status.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np
from astropy.io import fits

from . import cache, spherex_client
from .config import get_config
from .fits_processor import PreparedStamp, assign_epochs, coadd_clipped, epoch_bins, epoch_label, prepare_stamp
from .image_alignment import reproject_to, target_wcs, to_display_rows

Progress = Optional[Callable[[str, int, int], None]]


class NoCoverage(LookupError):
    """No SPHEREx exposure covers the requested position/band."""


@dataclass
class FrameProduct:
    meta: dict                 # FramesResponse fields, minus frame data
    arrays: list[np.ndarray]   # one float32 (height, width) array per frame, row 0 = north


def output_grid(ra: float, dec: float, fov: float):
    cfg = get_config()
    return target_wcs(ra, dec, fov, cfg["pixel_scale_arcsec"] / cfg["oversample"])


def load_stamps(ra: float, dec: float, fov: float, band: str, progress: Progress = None
                ) -> tuple[list[PreparedStamp], list[tuple[float, float]]]:
    """Prepared stamps of one detector at a position, plus the position's shared pass bins (all detectors).
    Raises NoCoverage. Stamps are disk-cached, so every product built from them (frames, cube, spectra,
    light curves, motion) shares the downloads."""
    cfg = get_config()
    det = int(band[1])
    all_records = spherex_client.query_exposures(ra, dec, fov, progress=progress)
    bins = position_epochs(all_records)
    records = [r for r in all_records if r.detector == det]
    if not records:
        raise NoCoverage(f"No SPHEREx {band} exposures cover RA {ra:.5f}, Dec {dec:.5f} in {cfg['release_tag']}.")
    stamps: list[PreparedStamp] = []
    for _, path in spherex_client.fetch_stamps(records, ra, dec, fov, progress=progress):
        with fits.open(path) as h:
            s = prepare_stamp(h, ra, dec, cfg["flags"])
        if s is not None:
            stamps.append(s)
    if not stamps:
        raise NoCoverage(f"No usable {band} stamps at RA {ra:.5f}, Dec {dec:.5f}.")
    _save_details(ra, dec, band, stamps)
    return stamps, bins


def build_frames(ra: float, dec: float, fov: float, band: str, progress: Progress = None) -> FrameProduct:
    stamps, bins = load_stamps(ra, dec, fov, band, progress)
    return coadd_epochs(stamps, ra, dec, fov, band, progress, bins=bins)


def _details_key(ra: float, dec: float, band: str) -> str:
    return cache.cache_key("expdetail", ra, dec, 0, band, spherex_client.data_version())


def _save_details(ra: float, dec: float, band: str, stamps: list[PreparedStamp]) -> None:
    cache.put_json(_details_key(ra, dec, band), [
        {"obs_id": s.obs_id, "detector": s.detector, "mjd": s.mjd, "lam_um": round(s.lam_um, 4),
         "bw_um": round(s.bw_um, 4), "target_flags": s.target_flags, "masked_fraction": round(s.masked_fraction, 4)}
        for s in stamps])


def exposure_details(ra: float, dec: float) -> dict[tuple[str, int], dict]:
    """Per-exposure wavelength/flags at the target, for every band already processed here."""
    out = {}
    for d in range(1, 7):
        for x in cache.get_json(_details_key(ra, dec, f"D{d}")) or []:
            out[(x["obs_id"], x["detector"])] = x
    return out


def position_epochs(records) -> list[tuple[float, float]]:
    """Epoch bins from ALL detectors' exposures at a position, so E2 means the same months in
    every band and in the catalogue overlay."""
    e = get_config()["epochs"]
    return epoch_bins([r.mjd for r in records], e["gap_days"], e.get("max_span_days"))


def coadd_epochs(stamps: list[PreparedStamp], ra: float, dec: float, fov: float, band: str,
                 progress: Progress = None, bins: Optional[list[tuple[float, float]]] = None) -> FrameProduct:
    cfg = get_config()
    out_wcs = output_grid(ra, dec, fov)
    w, h = out_wcs.pixel_shape
    if bins is None:
        bins = epoch_bins([s.mjd for s in stamps], cfg["epochs"]["gap_days"], cfg["epochs"].get("max_span_days"))
    labels = assign_epochs([s.mjd for s in stamps], bins)
    by_epoch: dict[int, list[PreparedStamp]] = defaultdict(list)
    for s, e in zip(stamps, labels):
        by_epoch[e].append(s)

    frames, arrays = [], []
    for n, e in enumerate(sorted(by_epoch)):
        group = by_epoch[e]
        images = [reproject_to(s.image, s.wcs, out_wcs) for s in group]
        img, _, nused = coadd_clipped(images, [s.bkg_rms for s in group])
        if progress:
            progress("coadd", n + 1, len(by_epoch))
        mjds = [s.mjd for s in group]
        lams = sorted(round(s.lam_um, 4) for s in group)
        target_flags = sorted({f for s in group for f in s.target_flags})
        arrays.append(to_display_rows(img))
        frames.append({
            "epoch_label": epoch_label(e),
            "mjd_start": round(min(mjds), 5),
            "mjd_end": round(max(mjds), 5),
            "mjd_mean": round(float(np.mean(mjds)), 5),
            "n_exposures": len(group),
            "width": w,
            "height": h,
            "flag_fraction": round(float(np.mean(~np.isfinite(img))), 4),
            "lam_um": lams,
            "lam_eff_um": round(float(np.mean(lams)), 4),
            "target_flags": target_flags,
            "obs_ids": [s.obs_id for s in group],
        })

    meta = {
        "ra": ra, "dec": dec, "fov": fov, "band": band,
        "units": cfg["image_unit"], "release": cfg["release_tag"],
        "wcs": {"center_ra": ra, "center_dec": dec,
                "pixel_scale_arcsec": cfg["pixel_scale_arcsec"] / cfg["oversample"], "width": w, "height": h},
        "frames": frames,
    }
    return FrameProduct(meta, arrays)
