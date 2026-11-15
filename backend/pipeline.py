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

import math
import warnings

import numpy as np
from astropy.io import fits

from . import cache, catalogs, spherex_client
from .config import get_config
from .fits_processor import PreparedStamp, assign_epochs, coadd_clipped, epoch_bins, epoch_label, prepare_stamp
from .image_alignment import reproject_to, target_wcs, to_display_rows

Progress = Optional[Callable[[str, int, int], None]]


class RequestTooLarge(ValueError):
    """Estimated native-image working set exceeds the per-job budget."""


class NoCoverage(LookupError):
    """No SPHEREx exposure covers the requested position/band."""


@dataclass
class FrameProduct:
    meta: dict                 # FramesResponse fields, minus frame data
    arrays: list[np.ndarray]   # one float32 (height, width) array per frame, row 0 = north
    noise: Optional[list[np.ndarray]] = None   # 1-sigma per pixel, same layout (calibrated, see calibrate_noise)

    coverage: Optional[list[np.ndarray]] = None


def calibrate_noise(arrays: list[np.ndarray], noise: list[np.ndarray]) -> tuple[list[np.ndarray], Optional[list[float]]]:
    """Scale each frame's co-add error map so difference images in sigma units have unit scatter.

    coadd_clipped's error is background-only and per native exposure; bilinear reprojection onto the 2x grid
    smooths noise, and clipping/few exposures change it per frame, so the raw maps are not the per-pixel
    scatter. Most pixels of a pass-to-pass difference are pure noise (stars subtract out). For every pair the
    robust variance V_ij of (A - B) is measured and modelled as k_i^2 n_i^2 + k_j^2 n_j^2 (n = median raw map),
    then solved for one factor k per frame (least squares; with 2 frames both share one factor).
    Returns (scaled maps, factors) or (maps, None) with < 2 frames. Bright-star residuals still exceed this
    background noise (Poisson, PSF and wavelength differences): high |sigma| on a bright star is not by itself
    a detection.
    """
    n = len(arrays)
    med = [float(np.nanmedian(x)) if np.isfinite(x).any() else np.nan for x in noise]
    rows, rhs = [], []
    for i in range(n):
        for j in range(i + 1, n):
            d = (arrays[i] - arrays[j])[np.isfinite(arrays[i]) & np.isfinite(arrays[j])]
            if d.size < 50 or not (np.isfinite(med[i]) and np.isfinite(med[j])):
                continue
            v = (1.4826 * float(np.median(np.abs(d - np.median(d))))) ** 2
            r = np.zeros(n)
            r[i], r[j] = med[i] ** 2, med[j] ** 2
            rows.append(r)
            rhs.append(v)
    if not rows:
        return noise, None
    A, b = np.array(rows), np.array(rhs)
    used = A.any(axis=0)
    if n == 2 or np.linalg.matrix_rank(A[:, used]) < used.sum():
        k2 = np.full(n, float(np.median(b / A.sum(axis=1))))      # one shared factor
    else:
        k2 = np.full(n, np.nan)
        k2[used] = np.linalg.lstsq(A[:, used], b, rcond=None)[0]
        k2 = np.where(np.isfinite(k2) & (k2 > 0), k2, np.nanmedian(k2[k2 > 0]) if (k2 > 0).any() else 1.0)
    k = np.clip(np.sqrt(k2), 0.2, 10.0)
    return [(x * f).astype(np.float32) for x, f in zip(noise, k)], [round(float(f), 4) for f in k]


def frame_astrometry(img: np.ndarray, out_wcs, field: list[dict], mjd: float, exclude_ids=(),
                     mag_range=(9.0, 15.5)) -> dict:
    """Registration check of one co-added frame (FITS orientation, row 0 = south) against Gaia DR3 propagated
    to the frame's mean MJD: centroids of bright, isolated, unsaturated Gaia stars vs their predicted pixels.
    Returns {n_ref, dra_arcsec, ddec_arcsec (median offset), rms_arcsec (per star, after clipping)}."""
    scale = abs(float(out_wcs.wcs.cdelt[1])) * 3600
    h, w = img.shape
    yr = catalogs.mjd_to_year(mjd)
    pos = []
    for g in field:
        if g.get("pmra") is not None:
            ra, dec = catalogs.propagate(g["ra"], g["dec"], g["pmra"], g["pmdec"], catalogs.GAIA_EPOCH, yr)
        else:
            ra, dec = g["ra"], g["dec"]
        x, y = (float(v) for v in out_wcs.all_world2pix(ra, dec, 0))
        if -6 <= x < w + 6 and -6 <= y < h + 6:
            pos.append((g, x, y))
    yy, xx = np.mgrid[0:h, 0:w]
    offs = []
    sig = 1.1   # ~ PSF sigma on the 3.075" grid (FWHM 7.5")
    for g, x, y in pos:
        m = g.get("mag")
        if g["id"] in exclude_ids or m is None or not (mag_range[0] <= m <= mag_range[1]):
            continue
        if not (5 <= x < w - 5 and 5 <= y < h - 5):
            continue
        if any(o is not g and math.hypot(ox - x, oy - y) < 6 and (o.get("mag") or 99) < m + 3 for o, ox, oy in pos):
            continue
        r = np.hypot(xx - x, yy - y)
        core, ann = r <= 3.0, (r >= 5) & (r <= 8)
        if not np.isfinite(img[core]).all() or np.isfinite(img[ann]).sum() < 10:
            continue   # saturated / masked core
        bkg = float(np.nanmedian(img[ann]))
        noise = 1.4826 * float(np.nanmedian(np.abs(img[ann] - bkg)))
        if not noise > 0 or (img[core].max() - bkg) < 20 * noise:
            continue
        cx, cy = x, y
        for _ in range(8):   # Gaussian-weighted centroid (robust on a barely sampled PSF)
            wgt = np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sig ** 2)) * np.clip(img - bkg, 0, None)
            wgt = np.where(np.hypot(xx - cx, yy - cy) <= 3.5, np.nan_to_num(wgt), 0.0)
            if wgt.sum() <= 0:
                break
            nx_, ny_ = float((wgt * xx).sum() / wgt.sum()), float((wgt * yy).sum() / wgt.sum())
            if math.hypot(nx_ - cx, ny_ - cy) < 1e-3:
                cx, cy = nx_, ny_
                break
            cx, cy = nx_, ny_
        if math.hypot(cx - x, cy - y) < 2.0:
            offs.append((cx - x, cy - y))
    if not offs:
        return {"n_ref": 0, "dra_arcsec": None, "ddec_arcsec": None, "rms_arcsec": None}
    a = np.array(offs)
    keep = np.ones(len(a), bool)
    for _ in range(3):
        med = np.median(a[keep], axis=0)
        d = np.hypot(*(a - med).T)
        lim = max(3 * 1.4826 * float(np.median(d[keep])), 0.1)
        new = d <= lim
        if new.sum() < 2 or (new == keep).all():
            break
        keep = new
    med = np.median(a[keep], axis=0)
    rms = float(np.sqrt(np.mean(np.sum((a[keep] - med) ** 2, axis=1)) / 2)) if keep.sum() > 1 else None
    # grid is north-up, east-left: +x = west, +y (FITS) = north
    return {"n_ref": int(keep.sum()), "dra_arcsec": round(float(-med[0] * scale), 3),
            "ddec_arcsec": round(float(med[1] * scale), 3),
            "rms_arcsec": None if rms is None else round(rms * scale, 3)}


def target_flagged(flags) -> bool:
    """True when a photometry-reject flag (saturation, cosmic ray, ...) touches the target."""
    return bool(set(flags) & set(get_config()["flags"]["photometry_reject"]))


def add_frame_qc(product: FrameProduct, ra: float, dec: float, fov: float, field: Optional[list[dict]],
                 exclude_ids=()) -> FrameProduct:
    """Per-frame astrometry (needs Gaia; skipped when field is None) and target_flagged, in place."""
    out_wcs = output_grid(ra, dec, fov)
    for f, arr in zip(product.meta["frames"], product.arrays):
        f["target_flagged"] = target_flagged(f.get("target_flags") or [])
        if field:
            a = frame_astrometry(arr[::-1], out_wcs, field, f["mjd_mean"], exclude_ids)
            f["astrometry"] = a
            f["astrometry_rms_arcsec"] = a["rms_arcsec"]
    return product


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
    pixels=len(records)*spherex_client.stamp_size_px(fov)**2
    if pixels > cfg.get('limits',{}).get('max_native_pixels',16_000_000):
        raise RequestTooLarge('This field requires too many large cutouts for one job. Choose a smaller field of view (for example 0.04 degrees).')
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
        {"obs_id": s.obs_id, "detector": s.detector, "mjd": s.mjd, "lam_um": round(s.lam_um, 4) if np.isfinite(s.lam_um) else None,
         "bw_um": round(s.bw_um, 4) if np.isfinite(s.bw_um) else None, "target_flags": s.target_flags if s.target_in_frame else None, "masked_fraction": round(s.masked_fraction, 4)}
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

    frames, arrays, noise, coverage = [], [], [], []
    for n, e in enumerate(sorted(by_epoch)):
        group = by_epoch[e]
        images = [reproject_to(s.image, s.wcs, out_wcs) for s in group]
        img, err, nused = coadd_clipped(images, [s.bkg_rms for s in group])
        if not np.isfinite(img).any(): continue
        coverage.append(to_display_rows(nused.astype(np.float32)))
        noise.append(to_display_rows(err))
        if progress:
            progress("coadd", n + 1, len(by_epoch))
        mjds = [s.mjd for s in group]
        lams = sorted(round(s.lam_um, 4) for s in group if np.isfinite(s.lam_um))
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
            "lam_eff_um": round(float(np.mean(lams)), 4) if lams else None,
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
    from .provenance import manifest
    meta['provenance']=manifest()
    report=cache.get_json(cache.cache_key('retrieval',ra,dec,fov,str(int(band[1])),spherex_client.data_version())) or {}
    meta['completeness']={**report,'selection_policy':'bounded per-detector temporal sampling; not guaranteed exhaustive', 'per_detector_per_window':cfg['archive'].get('scan_per_det_window')}
    noise, k = calibrate_noise(arrays, noise)
    for f, kf in zip(frames, k or []):
        f["noise_scale"] = kf
    return FrameProduct(meta, arrays, noise, coverage)
