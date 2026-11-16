"""Flag masking, zodi subtraction, wavelength tagging, epoch grouping, co-adding. Owner: B.

Never blink raw exposures without knowing their wavelength: each detector sits behind a linear
variable filter, so wavelength changes along detector y. One frame = one epoch x one detector,
and every frame records the wavelength the target was seen at in each exposure.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS, FITSFixedWarning
from scipy.interpolate import RegularGridInterpolator

warnings.simplefilter("ignore", FITSFixedWarning)


# ---------------------------------------------------------------- epochs

def group_epochs(mjds: Sequence[float], gap_days: float = 60.0) -> list[int]:
    """Assign an epoch index to each exposure time.

    A new epoch starts whenever the gap to the previous (sorted) exposure exceeds
    gap_days. Returns indices in the same order as the input.
    """
    if len(mjds) == 0:
        return []
    order = np.argsort(mjds)
    labels = np.empty(len(mjds), dtype=int)
    epoch = 0
    prev = mjds[order[0]]
    for i in order:
        if mjds[i] - prev > gap_days:
            epoch += 1
        labels[i] = epoch
        prev = mjds[i]
    return labels.tolist()


def epoch_bins(mjds: Sequence[float], gap_days: float = 60.0, max_span_days: Optional[float] = None
               ) -> list[tuple[float, float]]:
    """Time bins (start, end) for a position's exposures.

    1. Split wherever the gap exceeds gap_days: one bin per survey pass at most sky positions.
    2. A bin longer than max_span_days is split further, at its largest internal gap if that gap
       stands out (>= 3x the median gap and >= 5 d), otherwise into equal-width bins (near the ecliptic
       poles SPHEREx sees a target almost continuously). Repeats until every bin fits.
    A short side-visit a few weeks after a pass stays in that pass (Barnard: 46-day span = 0.4 px motion).
    """
    if len(mjds) == 0:
        return []
    t = np.sort(np.asarray(mjds, float))
    groups = np.split(t, np.where(np.diff(t) > gap_days)[0] + 1)

    def split(g: np.ndarray) -> list[np.ndarray]:
        span = g[-1] - g[0]
        if not max_span_days or span <= max_span_days or len(g) < 2:
            return [g]
        d = np.diff(g)
        i = int(np.argmax(d))
        if d[i] >= 5.0 and d[i] >= 3 * np.median(d):
            return split(g[:i + 1]) + split(g[i + 1:])
        n = int(np.ceil(span / max_span_days))
        edges = np.linspace(g[0], g[-1], n + 1)
        idx = np.clip(np.searchsorted(edges, g, side="right") - 1, 0, n - 1)
        return [g[idx == k] for k in range(n) if np.any(idx == k)]

    return [(float(b[0]), float(b[-1])) for g in groups for b in split(g)]


def assign_epochs(mjds: Sequence[float], bins: list[tuple[float, float]], tol_days: float = 1.0) -> list[int]:
    """Index of the bin containing each time (within tol_days), else the nearest bin."""
    out = []
    for m in mjds:
        dist = [0.0 if a - tol_days <= m <= b + tol_days else min(abs(m - a), abs(m - b)) for a, b in bins]
        out.append(int(np.argmin(dist)))
    return out


def epoch_label(index: int) -> str:
    return f"E{index + 1}"


# ---------------------------------------------------------------- flags

def flag_bits(header: fits.Header) -> dict[str, int]:
    """Flag name -> bitmask, read from the FLAGS header (MSKNnnnn / MSKMnnnn)."""
    return {header[k].strip(): int(header["MSKM" + k[4:]]) for k in header if k.startswith("MSKN")}


def mask_for(bits: dict[str, int], names: Sequence[str]) -> int:
    return int(sum(bits[n] for n in names if n in bits))


def flags_near(flags: np.ndarray, bits: dict[str, int], x: float, y: float, r: int = 1) -> list[str]:
    """Names of flags set anywhere in the (2r+1)^2 box around pixel (x, y)."""
    ix, iy = int(round(x)), int(round(y))
    box = flags[max(iy - r, 0):iy + r + 1, max(ix - r, 0):ix + r + 1]
    if box.size == 0:
        return []
    anyset = int(np.bitwise_or.reduce(box.ravel()))
    return sorted(n for n, b in bits.items() if anyset & b)


def mask_and_subtract(image: np.ndarray, flags: np.ndarray, zodi: np.ndarray | None, bad_bits: int) -> np.ndarray:
    """NaN-out flagged pixels and subtract the ZODI HDU (or a local median)."""
    out = image.astype(np.float32).copy()
    out[(flags & bad_bits) != 0] = np.nan
    if zodi is not None:
        out -= zodi
    else:
        out -= np.nanmedian(out)
    return out


# ---------------------------------------------------------------- wavelength

def wavelength_at(hdul: fits.HDUList, x: float, y: float) -> tuple[float, float]:
    """(central wavelength, bandwidth) in um at 0-based stamp pixel (x, y).

    WCS-WAVE is a [y, x] control-point grid in 1-based full-detector pixels. The IMAGE header's
    'W' alternate WCS maps stamp pixels to those coordinates (CRVAL1W = 1 + stamp origin).
    """
    hdr = hdul["IMAGE"].header
    xd = hdr.get("CRVAL1W", 1) + hdr.get("CDELT1W", 1) * ((x + 1) - hdr.get("CRPIX1W", 1))
    yd = hdr.get("CRVAL2W", 1) + hdr.get("CDELT2W", 1) * ((y + 1) - hdr.get("CRPIX2W", 1))
    t = hdul["WCS-WAVE"].data
    X, Y, V = np.asarray(t["X"][0], float), np.asarray(t["Y"][0], float), np.asarray(t["VALUES"][0], float)
    pt = (np.clip(yd, Y[0], Y[-1]), np.clip(xd, X[0], X[-1]))
    lam = float(RegularGridInterpolator((Y, X), V[:, :, 0])(pt))
    bw = float(RegularGridInterpolator((Y, X), V[:, :, 1])(pt))
    return lam, bw


# ---------------------------------------------------------------- one stamp -> clean image

ARCSEC2_TO_SR = (np.pi / 180 / 3600) ** 2
# Pixels a PSF fit must not trust on a bright star: the core is clipped. On real stamps SUR_ERROR and
# TRANSIENT cover the *whole* PSF of a bright star (Barnard: a 5x5 block around a 4-pixel OVERFLOW core) while
# the values there look smooth, so those are only down-weighted ("suspect"), never masked.
SATURATION_FLAGS = ("OVERFLOW", "NONLINEAR")
SUSPECT_FLAGS = ("SUR_ERROR", "TRANSIENT")

@dataclass
class PreparedStamp:
    image: np.ndarray            # MJy/sr, zodi + local background removed, display-masked (NaN)
    variance: np.ndarray         # (MJy/sr)^2
    wcs: WCS
    mjd: float
    detector: int
    obs_id: str
    x: float                     # target pixel in this stamp (0-based)
    y: float
    lam_um: float                # wavelength at the target
    bw_um: float
    target_flags: list[str] = field(default_factory=list)
    masked_fraction: float = 0.0
    target_in_frame: bool = True
    bkg_rms: float = float("nan")  # robust background noise, MJy/sr
    # For photometry / astrometry (items 4-5). Optional so hand-built stamps in tests stay valid.
    x0: int = 0                  # detector pixel of stamp pixel (0, 0): CUTX0 / CUTY0
    y0: int = 0
    reject: Optional[np.ndarray] = None    # bool: photometry_reject flag set (saturation, cosmic ray, ...)
    saturated: Optional[np.ndarray] = None  # bool: OVERFLOW / NONLINEAR -> masked (wing fit)
    suspect: Optional[np.ndarray] = None    # bool: SUR_ERROR / TRANSIENT -> down-weighted in fits
    contam: Optional[np.ndarray] = None    # bool: contamination flags (ghost, halo, bloom, crosstalk)
    epsf: Optional[np.ndarray] = None      # nearest-zone ePSF, 33x33, oversampled epsf_oversample x
    epsf_oversample: int = 5
    epsf_cwave: float = float("nan")
    omega_sr: float = float("nan")         # native pixel solid angle (OMEGA_MEDIAN), steradian
    sc_pos_km: Optional[tuple[float, float, float]] = None  # X_SC/Y_SC/Z_SC, geocentric km


def detector_xy(header, x, y):
    """Native cutouts shift alternate-WCS CRPIX; S3 stamps record CUTX0/Y0."""
    if 'CUTX0' in header and 'CUTY0' in header:
        return float(header['CUTX0'])+x, float(header['CUTY0'])+y
    if 'CRPIX1A' in header:
        # Keep only alternate A cards: spatial SIP terms do not apply to active pixels.
        keys=('WCSAXES','CTYPE','CUNIT','CRPIX','CRVAL','CDELT','PC','CD','CROTA')
        alternate=fits.Header({key[:-1]:value for key,value in header.items()
                               if key.endswith('A') and key.startswith(keys)})
        return tuple(float(v) for v in WCS(alternate).all_pix2world(x,y,0))
    return x,y


def prepare_stamp(hdul: fits.HDUList, ra: float, dec: float, flag_policy: dict) -> Optional[PreparedStamp]:
    """Zodi-subtract, mask detector defects, remove residual background, tag wavelength.

    Only `display_mask` flags become NaN: masking saturation flags would hide bright targets
    (Barnard's Star's core is OVERFLOW). Cosmic rays are handled by the clipped co-add.
    """
    im = hdul["IMAGE"]
    hdr = im.header
    wcs = WCS(hdr)
    x, y = (float(v) for v in wcs.all_world2pix(ra, dec, 0))
    ny, nx = im.data.shape
    inside = -0.5 <= x < nx-0.5 and -0.5 <= y < ny-0.5
    if not inside and not np.isfinite(im.data).any(): return None

    bits = flag_bits(hdul["FLAGS"].header)
    flags = hdul["FLAGS"].data.astype(np.int64)
    image = im.data.astype(np.float32) - hdul["ZODI"].data.astype(np.float32)
    display = (flags & mask_for(bits, flag_policy["display_mask"])) != 0
    image[display] = np.nan

    finite = np.isfinite(image)
    _, med, std = sigma_clipped_stats(image[finite], sigma=3.0, maxiters=5) if finite.any() else (0, 0.0, np.nan)
    image -= np.float32(med)
    variance = hdul["VARIANCE"].data.astype(np.float32)
    variance[~np.isfinite(image)] = np.nan

    lam, bw = wavelength_at(hdul, x, y) if inside else (float("nan"),float("nan"))
    report = set(flag_policy["photometry_reject"]) | set(flag_policy["contamination"]) | set(flag_policy["display_mask"])
    epsf, os_, cwave = None, 5, float("nan")
    if "EPSF" in hdul:
        e = hdul["EPSF"]
        dx,dy=detector_xy(hdr,x,y)
        row=int(np.argmin((e.data['XCENTER']-dx)**2+(e.data['YCENTER']-dy)**2)) if len(e.data)>1 else 0
        epsf = np.asarray(e.data["EPSF"][row], float)
        os_ = int(e.header.get("OVSMPX", 5))
        cwave = float(e.data["CWAVE"][row]) if "CWAVE" in e.data.columns.names else float("nan")
    sc = tuple(float(hdr[k]) for k in ("X_SC", "Y_SC", "Z_SC")) if all(k in hdr for k in ("X_SC", "Y_SC", "Z_SC")) else None
    return PreparedStamp(
        image=image, variance=variance, wcs=wcs, mjd=float(hdr["MJD-AVG"]), detector=int(hdr["DETECTOR"]),
        obs_id=str(hdr.get("OBSID", "")), x=x, y=y, lam_um=lam, bw_um=bw,
        target_flags=[n for n in flags_near(flags, bits, x, y) if n in report] if inside else [],
        target_in_frame=inside,
        masked_fraction=float(np.mean(~np.isfinite(image))), bkg_rms=float(std),
        x0=int(round(detector_xy(hdr,0,0)[0])), y0=int(round(detector_xy(hdr,0,0)[1])),
        reject=(flags & mask_for(bits, flag_policy["photometry_reject"])) != 0,
        saturated=(flags & mask_for(bits, SATURATION_FLAGS)) != 0,
        suspect=(flags & mask_for(bits, SUSPECT_FLAGS)) != 0,
        contam=(flags & mask_for(bits, flag_policy["contamination"])) != 0,
        epsf=epsf, epsf_oversample=os_, epsf_cwave=cwave,
        omega_sr=float(hdr.get("OMEGA_MEDIAN", np.nan)) * ARCSEC2_TO_SR, sc_pos_km=sc,
    )


# ---------------------------------------------------------------- co-adding

def coadd(images: Sequence[np.ndarray], variances: Sequence[np.ndarray] | None = None) -> np.ndarray:
    """Variance-weighted mean of already-aligned images, ignoring NaNs.

    Falls back to a plain NaN-mean when no variances are given.
    """
    stack = np.stack(images).astype(np.float64)
    if variances is None:
        with np.errstate(invalid="ignore"):
            return np.nanmean(stack, axis=0).astype(np.float32)
    w = 1.0 / np.stack(variances).astype(np.float64)
    w[~np.isfinite(stack) | ~np.isfinite(w)] = 0.0
    stack = np.nan_to_num(stack)
    wsum = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = (stack * w).sum(axis=0) / wsum
    out[wsum == 0] = np.nan
    return out.astype(np.float32)


def coadd_clipped(images: Sequence[np.ndarray], noise: Sequence[float], nsigma: float = 5.0
                  ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Outlier-rejecting weighted mean of aligned images.

    * Weights are one scalar per exposure, 1/noise^2 from its *background* rms. Per-pixel
      inverse-variance weights would down-weight exactly the exposures where a source is bright
      (Poisson variance), biasing star brightness.
    * With >= 3 exposures, a pixel is rejected when it sits more than nsigma robust-sigmas from
      the per-pixel median. The robust sigma is the larger of the stack's own MAD scatter and the
      background noise, so real exposure-to-exposure changes (different wavelength per exposure)
      are kept while single-exposure cosmic rays are removed.

    Returns (coadd, coadd_noise_estimate, n_used_per_pixel).
    """
    stack = np.stack(images).astype(np.float64)
    noise = np.asarray(noise, float)
    noise = np.where(np.isfinite(noise) & (noise > 0), noise, np.nanmedian(noise) if np.isfinite(noise).any() else 1.0)
    good = np.isfinite(stack)
    if len(stack) >= 3:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            med = np.nanmedian(stack, axis=0)
            mad = 1.4826 * np.nanmedian(np.abs(stack - med), axis=0)
        sig = np.maximum(mad, np.median(noise))
        good &= np.abs(stack - med) <= nsigma * sig
    w = np.where(good, (1.0 / noise ** 2)[:, None, None], 0.0)
    wsum = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = (np.where(good, stack, 0.0) * w).sum(axis=0) / wsum
        err = np.sqrt(1.0 / wsum)
    out[wsum == 0] = np.nan
    err[wsum == 0] = np.nan
    return out.astype(np.float32), err.astype(np.float32), good.sum(axis=0).astype(np.int16)
