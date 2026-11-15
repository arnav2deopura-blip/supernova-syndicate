"""Item 3: the spectral cube -- one co-added image per SPHEREx channel (17 per detector). Owner: B.

A single exposure is not monochromatic: wavelength runs along detector y. Two modes:

* quick-look (default): every stamp is tagged with the channel at the *target* (field centre) and
  co-added per channel. Exact at the centre; up to ~half a channel off at the edge of a 0.1 deg field.
* strict: each stamp contributes only the pixels whose CHANNEL_MAP value is the channel, so each
  exposure adds a horizontal strip and a channel image fills the field only where strips overlap.

All passes are stacked per channel by default (best S/N). Movers smear across passes, so `per_pass`
returns one image per (channel, pass) instead; `recommend_per_pass` says when the field holds a fast mover.
"""
from __future__ import annotations

import warnings
from collections import defaultdict
from dataclasses import dataclass
from typing import Optional

import numpy as np

from . import catalogs, channels, pipeline
from .config import get_config
from .fits_processor import PreparedStamp, assign_epochs, coadd_clipped, epoch_label
from .image_alignment import reproject_to, to_display_rows
from .pipeline import Progress, output_grid

FAST_MOVER_MAS_YR = 1000.0   # > 1"/yr: smears visibly in an all-passes stack


@dataclass
class CubeProduct:
    meta: dict
    arrays: list[np.ndarray]   # referenced from meta by integer "blob" placeholders


def stamp_channel(s: PreparedStamp) -> Optional[channels.Channel]:
    """Channel at the target. A small tolerance absorbs rounding at the detector's band edges."""
    return channels.assign(s.detector, s.lam_um, tol_um=0.005)


def strict_image(s: PreparedStamp, subchan: int) -> np.ndarray:
    """The stamp with every pixel outside `subchan` set to NaN (CHANNEL_MAP, detector 'sky' coordinates)."""
    m = channels.map_slice(s.x0, s.y0, s.image.shape)
    out = s.image.copy()
    out[m != subchan] = np.nan
    return out


def _target_value(img: np.ndarray, r: int = 1) -> Optional[float]:
    """Mean of the (2r+1)^2 box at the grid centre (the target): the cube's 'spectrum strip'."""
    h, w = img.shape
    box = img[h // 2 - r:h // 2 + r + 1, w // 2 - r:w // 2 + r + 1]
    if not np.isfinite(box).any():
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return round(float(np.nanmean(box)), 5)


def display_range(arrays: list[np.ndarray], lo: float = 1.0, hi: float = 99.5) -> Optional[list[float]]:
    """One stretch for every channel, so brightness changes with wavelength stay visible."""
    vals = np.concatenate([a[np.isfinite(a)].ravel() for a in arrays]) if arrays else np.array([])
    if vals.size == 0:
        return None
    return [round(float(np.percentile(vals, lo)), 5), round(float(np.percentile(vals, hi)), 5)]


def fast_movers(ra: float, dec: float, fov: float) -> Optional[list[dict]]:
    """Gaia sources in the field faster than 1"/yr, or None if Gaia is unreachable."""
    try:
        rows = catalogs.gaia_query(ra, dec, fov / np.sqrt(2) * 1.05)
    except catalogs.ResolverUnavailable:
        return None
    out = []
    for r in rows:
        if r["pmra"] is None or r["pmdec"] is None:
            continue
        pm = float(np.hypot(r["pmra"], r["pmdec"]))
        if pm > FAST_MOVER_MAS_YR:
            out.append({"id": r["id"], "pm_mas_yr": round(pm, 1)})
    return out


def build_cube(ra: float, dec: float, fov: float, band: str, per_pass: bool = False, strict: bool = False,
               progress: Progress = None, stamps: Optional[list[PreparedStamp]] = None,
               bins: Optional[list[tuple[float, float]]] = None, check_movers: bool = True,
               target_pm_mas_yr: Optional[float] = None) -> CubeProduct:
    cfg = get_config()
    det = int(band[1])
    if stamps is None:
        stamps, bins = pipeline.load_stamps(ra, dec, fov, band, progress)
    if bins is None:
        e = cfg["epochs"]
        from .fits_processor import epoch_bins
        bins = epoch_bins([s.mjd for s in stamps], e["gap_days"], e.get("max_span_days"))
    out_wcs = output_grid(ra, dec, fov)
    w, h = out_wcs.pixel_shape
    passes = [epoch_label(i) for i in assign_epochs([s.mjd for s in stamps], bins)]

    # (subchan, pass or None) -> list of (stamp, native image to reproject)
    cells: dict[tuple[int, Optional[str]], list[tuple[PreparedStamp, np.ndarray, str]]] = defaultdict(list)
    for s, p in zip(stamps, passes):
        key_pass = p if per_pass else None
        if strict:
            present = np.unique(channels.map_slice(s.x0, s.y0, s.image.shape))
            for sub in present:
                if 1 <= sub <= channels.N_PER_DET:
                    cells[(int(sub), key_pass)].append((s, strict_image(s, int(sub)), p))
        else:
            c = stamp_channel(s)
            if c is not None:
                cells[(c.subchan, key_pass)].append((s, s.image, p))

    arrays: list[np.ndarray] = []
    by_chan: dict[int, list[dict]] = defaultdict(list)
    keys = sorted(cells, key=lambda k: (k[0], k[1] or ""))
    for n, (sub, p) in enumerate(keys):
        group = cells[(sub, p)]
        imgs = [reproject_to(img, s.wcs, out_wcs) for s, img, _ in group]
        img, _, _ = coadd_clipped(imgs, [s.bkg_rms for s, _, _ in group])
        if progress:
            progress("cube", n + 1, len(keys))
        if not np.isfinite(img).any():
            continue   # empty channels are omitted, never returned as all-NaN
        disp = to_display_rows(img)
        arrays.append(disp)
        lam_t = [s.lam_um for s, _, _ in group]
        by_chan[sub].append({
            "pass": p, "blob": len(arrays) - 1, "n_exposures": len(group),
            "coverage": round(float(np.mean(np.isfinite(img))), 4),
            "lam_target_um": round(float(np.mean(lam_t)), 4),
            "mjd_mean": round(float(np.mean([s.mjd for s, _, _ in group])), 5),
            "passes": sorted({q for _, _, q in group}),
            "target_value": _target_value(disp),
            "target_flags": sorted({f for s, _, _ in group for f in s.target_flags}),
            "obs_ids": [s.obs_id for s, _, _ in group],
        })

    out_channels = []
    for sub in sorted(by_chan):
        c = next(x for x in channels.for_detector(det) if x.subchan == sub)
        entry = {"channel": c.label, "subchan": sub, "lam_um": c.wavelength, "lam_min": c.wl_min,
                 "lam_max": c.wl_max, "R": c.R}
        cells_ = by_chan[sub]
        if per_pass:
            entry["n_exposures"] = sum(x["n_exposures"] for x in cells_)
            entry["frames"] = [{"epoch_label": x.pop("pass"), **{k: v for k, v in x.items() if k != "passes"}}
                               for x in cells_]
        else:
            x = cells_[0]
            x.pop("pass")
            entry.update(x)
        out_channels.append(entry)

    movers = fast_movers(ra, dec, fov) if check_movers else None
    meta = {
        "ra": ra, "dec": dec, "fov": fov, "det": band, "units": cfg["image_unit"], "release": cfg["release_tag"],
        "wcs": {"center_ra": ra, "center_dec": dec,
                "pixel_scale_arcsec": cfg["pixel_scale_arcsec"] / cfg["oversample"], "width": w, "height": h},
        "per_pass": per_pass, "strict": strict,
        "channel_at": "pixel" if strict else "field_centre",
        "display_range": display_range(arrays),
        "fast_movers": movers,
        # Gaia misses the reddest movers (WISE 0855), so the target's own PM counts too
        "recommend_per_pass": (bool(movers) or (target_pm_mas_yr or 0) > FAST_MOVER_MAS_YR) and not per_pass,
        "n_stamps": len(stamps),
        "channels": out_channels,
    }
    return CubeProduct(meta, arrays)


# ------------------------------------------------------------------ matched-wavelength frames (/frames?matched=1)

def build_matched_frames(ra: float, dec: float, fov: float, band: str, progress: Progress = None,
                         stamps: Optional[list[PreparedStamp]] = None,
                         bins: Optional[list[tuple[float, float]]] = None) -> pipeline.FrameProduct:
    """One frame per pass with the SAME effective bandpass in every pass (BACKEND_PLAN §2.4).

    A plain detector co-add averages whatever wavelengths each pass happened to sample at the target, so a red
    source can look variable just because the mix changed. Here every stamp is tagged with the channel at the
    target (as the quick-look cube), co-added per (pass, channel), and each pass's frame is the equal-weight
    mean of only the channels observed in EVERY pass. Exposures in other channels are dropped and counted.

    Pixels masked in some channels average the rest (nanmean); field edges are up to ~half a channel off,
    exactly as in the quick-look cube. Raises pipeline.NoCoverage when no channel is common to all passes.
    """
    cfg = get_config()
    det = int(band[1])
    if stamps is None:
        stamps, bins = pipeline.load_stamps(ra, dec, fov, band, progress)
    if bins is None:
        from .fits_processor import epoch_bins
        e = cfg["epochs"]
        bins = epoch_bins([s.mjd for s in stamps], e["gap_days"], e.get("max_span_days"))
    out_wcs = output_grid(ra, dec, fov)
    w, h = out_wcs.pixel_shape

    cells: dict[int, dict[int, list[PreparedStamp]]] = defaultdict(lambda: defaultdict(list))
    total: dict[int, int] = defaultdict(int)
    for s, e in zip(stamps, assign_epochs([s.mjd for s in stamps], bins)):
        total[e] += 1
        c = stamp_channel(s)
        if c is not None:
            cells[e][c.subchan].append(s)
    passes = sorted(cells)
    common = sorted(set.intersection(*(set(cells[e]) for e in passes))) if passes else []
    if not common:
        seen = "; ".join(f"{epoch_label(e)}: {', '.join(f'C{c:02d}' for c in sorted(cells[e])) or 'none'}"
                         for e in sorted(total))
        raise pipeline.NoCoverage(
            f"No {band} channel is observed in every pass at RA {ra:.5f}, Dec {dec:.5f} ({seen}), so a "
            f"matched-wavelength blink is not possible here. Use matched=0 and compare lam_eff_um between frames.")
    chans = {c.subchan: c for c in channels.for_detector(det)}

    frames, arrays, noise = [], [], []
    n_cells, done = len(passes) * len(common), 0
    for e in passes:
        chan_imgs, chan_errs, chan_meta, used = [], [], [], []
        for sub in common:
            group = cells[e][sub]
            img, err, _ = coadd_clipped([reproject_to(s.image, s.wcs, out_wcs) for s in group],
                                        [s.bkg_rms for s in group])
            chan_imgs.append(img)
            chan_errs.append(err)
            used += group
            chan_meta.append({"channel": chans[sub].label, "n_exposures": len(group),
                              "lam_target_um": round(float(np.mean([s.lam_um for s in group])), 4)})
            done += 1
            if progress:
                progress("coadd", done, n_cells)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)   # all-NaN pixels stay NaN
            img = np.nanmean(np.stack(chan_imgs), axis=0).astype(np.float32)
            ev = np.stack(chan_errs).astype(np.float64)
            nfin = np.isfinite(ev).sum(axis=0)
            err = (np.sqrt(np.nansum(ev ** 2, axis=0)) / np.where(nfin > 0, nfin, np.nan)).astype(np.float32)
        noise.append(to_display_rows(err))
        mjds = [s.mjd for s in used]
        arrays.append(to_display_rows(img))
        frames.append({
            "epoch_label": epoch_label(e),
            "mjd_start": round(min(mjds), 5),
            "mjd_end": round(max(mjds), 5),
            "mjd_mean": round(float(np.mean(mjds)), 5),
            "n_exposures": len(used),
            "n_exposures_dropped": total[e] - len(used),
            "width": w,
            "height": h,
            "flag_fraction": round(float(np.mean(~np.isfinite(img))), 4),
            "lam_um": sorted(round(s.lam_um, 4) for s in used),
            # equal weight per channel, so the frame's effective wavelength is the mean over channels
            "lam_eff_um": round(float(np.mean([c["lam_target_um"] for c in chan_meta])), 4),
            "target_flags": sorted({f for s in used for f in s.target_flags}),
            "obs_ids": [s.obs_id for s in used],
            "channels": chan_meta,
        })

    meta = {
        "ra": ra, "dec": dec, "fov": fov, "band": band,
        "units": cfg["image_unit"], "release": cfg["release_tag"],
        "wcs": {"center_ra": ra, "center_dec": dec,
                "pixel_scale_arcsec": cfg["pixel_scale_arcsec"] / cfg["oversample"], "width": w, "height": h},
        "matched": True,
        "matched_channels": [chans[s].label for s in common],
        "lam_eff_um": round(float(np.mean([chans[s].wavelength for s in common])), 4),
        "frames": frames,
    }
    noise, k = pipeline.calibrate_noise(arrays, noise)
    for f, kf in zip(frames, k or []):
        f["noise_scale"] = kf
    return pipeline.FrameProduct(meta, arrays, noise)
