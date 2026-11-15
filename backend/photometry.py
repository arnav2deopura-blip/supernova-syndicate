"""Per-exposure forced photometry: spectra (item 1) and the input to light curves (item 4). Owner: B.

IRSA's Spectrophotometry Tool has no batch mode and ignores proper motion, so we measure ourselves:

1. The target is propagated (proper motion) to each exposure's MJD-AVG and placed with that exposure's WCS.
2. The nearest-zone ePSF is fit on the native-pixel stamp (never on the reprojected grid):
   * faint target (S/N < 10 at the predicted position): position fixed, flux + background fitted ("forced");
   * brighter: position free within 1.5 px ("psf"); saturated core: core masked, wings fitted ("wing").
3. Flux in uJy = fitted flux (MJy/sr summed over native pixels) x native pixel solid angle x 1e12.
   An aperture flux (r = 1.8 px, annulus background, ePSF aperture correction) is kept as a cross-check.
4. A point is `flagged` when a photometry_reject flag touches the fitted core, or the fit is a wing fit,
   or the fit failed; `flags` lists every reported flag name, `blend` names Gaia neighbours within 2 px.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Callable, Optional

import numpy as np

from . import catalogs, channels, psf
from .config import get_config
from .fits_processor import PreparedStamp, assign_epochs, epoch_label

FORCED_SNR = 10.0
NEIGHBOUR_QUERY_DEG = 0.02   # Gaia cone for spectra: 72", covers the deblend radius plus a few years of motion
DEBLEND_RADIUS_PX = 5.0   # forced-fit radius (3 px) + ~2 PSF FWHM: farther stars put < 2% of their light in the fit
AP_RADIUS = 1.8     # native px (~1.5 x FWHM)
ANNULUS = (4.0, 7.0)


# ---------------------------------------------------------------- where is the target?

@dataclass
class Track:
    """Target position as a function of time: linear proper motion from (ra, dec) at `epoch` (decimal year).
    pmra includes cos(dec), mas/yr. `source` says where the motion came from."""
    ra: float
    dec: float
    epoch: float
    pmra: float = 0.0
    pmdec: float = 0.0
    parallax: Optional[float] = None
    source: str = "static"
    gaia_id: Optional[str] = None
    gaia: Optional[dict] = None

    def at(self, mjd: float) -> tuple[float, float]:
        return catalogs.propagate(self.ra, self.dec, self.pmra, self.pmdec, self.epoch, catalogs.mjd_to_year(mjd))


def track_for(ra: float, dec: float, pmra: Optional[float] = None, pmdec: Optional[float] = None,
              epoch: Optional[float] = None, match_arcsec: float = 2.0, prefer_gaia: bool = True) -> Track:
    """Where the target is at any time. (ra, dec) is valid at `epoch` (default: now, as /api/resolve returns).

    Gaia DR3 (propagated to `epoch`) within match_arcsec wins when prefer_gaia, since it also gives parallax
    and errors; else the requested pmra/pmdec; else no motion. The match radius is tight (2"): a random faint
    Gaia star 3.4" from WISE 0855 (not in Gaia) must not steal the match. When the request carries a large
    PM, a Gaia match must agree with it to within 20%, for the same reason."""
    epoch = catalogs.current_year() if epoch is None else epoch
    requested = (Track(ra, dec, epoch, pmra, pmdec, source="request")
                 if pmra is not None and pmdec is not None else None)
    if requested is not None and not prefer_gaia:
        return requested
    # The cone is at the Gaia (J2016) position: widen it by the largest plausible motion (12"/yr, > Barnard).
    radius = 0.02 + 12.0 * abs(epoch - catalogs.GAIA_EPOCH) / 3600
    try:
        rows = catalogs.gaia_query(ra, dec, radius)
    except catalogs.ResolverUnavailable:
        rows = []
    best, best_d = None, match_arcsec
    for r in rows:
        if r["pmra"] is None:
            continue
        pra, pdec = catalogs.propagate(r["ra"], r["dec"], r["pmra"], r["pmdec"], catalogs.GAIA_EPOCH, epoch)
        d = math.hypot((pra - ra) * math.cos(math.radians(dec)), pdec - dec) * 3600
        if d < best_d:
            if requested is not None and math.hypot(pmra, pmdec) > 200:
                if math.hypot(r["pmra"] - pmra, r["pmdec"] - pmdec) > 0.2 * math.hypot(pmra, pmdec):
                    continue
            best, best_d = r, d
    if best is None:
        return requested or Track(ra, dec, epoch)
    return Track(best["ra"], best["dec"], catalogs.GAIA_EPOCH, best["pmra"], best["pmdec"], best.get("parallax"),
                 source="gaia_dr3", gaia_id=best["id"], gaia=best)


# ---------------------------------------------------------------- one exposure

@dataclass
class PhotPoint:
    obs_id: str
    detector: int
    mjd: float
    lam_um: float
    bw_um: float
    channel: Optional[str]
    flux: float                 # uJy
    flux_err: float
    flux_ap: Optional[float]    # aperture cross-check, uJy
    x: float                    # fitted (or forced) stamp pixel, 0-based
    y: float
    x_pred: float
    y_pred: float
    x_err: float
    y_err: float
    fit: str                    # forced | psf | wing | failed
    chi2r: float
    flagged: bool
    flags: list[str] = field(default_factory=list)
    epoch_label: str = ""
    blend: list[str] = field(default_factory=list)
    snr: float = 0.0
    n_deblended: int = 0        # neighbours fitted together with the target (forced fits with deblend on)

    def public(self) -> dict:
        d = asdict(self)
        for k in ("flux", "flux_err", "flux_ap"):
            if d[k] is not None and np.isfinite(d[k]):
                d[k] = round(float(d[k]), 3)
        for k in ("x", "y", "x_pred", "y_pred", "x_err", "y_err", "chi2r", "snr"):
            d[k] = round(float(d[k]), 4) if np.isfinite(d[k]) else None
        d["mjd"] = round(d["mjd"], 5)
        d["lam_um"] = round(d["lam_um"], 4)
        d["bw_um"] = round(d["bw_um"], 4)
        return d


def _flag_names(stamp: PreparedStamp, x: float, y: float) -> list[str]:
    """Reported flag names within 1 px of (x, y), from the per-pixel masks kept on the stamp."""
    pol = get_config()["flags"]
    out = set()
    ix, iy = int(round(x)), int(round(y))
    sl = (slice(max(iy - 1, 0), iy + 2), slice(max(ix - 1, 0), ix + 2))
    # target_flags was computed at the predicted position; use it when the fit stayed close
    if math.hypot(x - stamp.x, y - stamp.y) < 1.0:
        out.update(stamp.target_flags)
    if stamp.saturated is not None and stamp.saturated[sl].any():
        out.add("OVERFLOW")
    if stamp.reject is not None and stamp.reject[sl].any() and not out & set(pol["photometry_reject"]):
        out.add("REJECT")
    return sorted(out)


def aperture_flux(stamp: PreparedStamp, model: psf.EPSFModel, x: float, y: float) -> Optional[float]:
    """Aperture sum (r = 1.8 px) minus annulus median, divided by the ePSF fraction inside the aperture.
    None if any aperture pixel is NaN (e.g. a saturated core)."""
    ny, nx = stamp.image.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    r = np.hypot(xx - x, yy - y)
    ap = r <= AP_RADIUS
    ann = (r >= ANNULUS[0]) & (r <= ANNULUS[1]) & np.isfinite(stamp.image)
    if not ap.any() or not np.isfinite(stamp.image[ap]).all() or ann.sum() < 8:
        return None
    frac = float(model.evaluate(xx[ap].astype(float), yy[ap].astype(float), x, y).sum())
    if frac <= 0.2:
        return None
    s = float(stamp.image[ap].sum() - np.median(stamp.image[ann]) * ap.sum())
    return s / frac * stamp.omega_sr * 1e12


def measure(stamp: PreparedStamp, ra: float, dec: float, free: Optional[bool] = None,
            others: Optional[list[tuple[float, float]]] = None) -> PhotPoint:
    """Photometry (and position) of the source expected at (ra, dec) in one stamp. `free`: None = decide by
    S/N; True/False force a free / fixed position. `others`: (ra, dec) of known neighbours at this stamp's
    time, fitted together with the target in the forced fit (see psf.fit_star)."""
    pol = get_config()["flags"]
    xp, yp = (float(v) for v in stamp.wcs.all_world2pix(ra, dec, 0))
    model = psf.model_for(stamp)
    to_ujy = stamp.omega_sr * 1e12 if np.isfinite(stamp.omega_sr) else (get_config()["pixel_scale_arcsec"] ** 2) * (math.pi / 180 / 3600) ** 2 * 1e12
    kw = psf.fit_masks(stamp)

    oxy = [tuple(float(v) for v in stamp.wcs.all_world2pix(ora, odec, 0)) for ora, odec in (others or [])]
    forced = psf.fit_star(stamp.image, stamp.variance, model, xp, yp, fix_position=True, others=oxy, **kw)
    snr = forced.flux / forced.flux_err if forced.ok and forced.flux_err > 0 else 0.0
    go_free = (snr >= FORCED_SNR or forced.wing) if free is None else free
    fit, kind = forced, "forced"
    if go_free:
        cx, cy = psf.centroid(stamp.image, xp, yp, r=1.5)
        if math.hypot(cx - xp, cy - yp) > 1.5:
            cx, cy = xp, yp
        f = psf.fit_star(stamp.image, stamp.variance, model, cx, cy, max_shift=1.5, **kw)
        if f.ok and math.hypot(f.x - xp, f.y - yp) <= 2.5:
            fit, kind = f, ("wing" if f.wing else "psf")
            snr = f.flux / f.flux_err if f.flux_err > 0 else snr
    if not fit.ok or not np.isfinite(fit.flux):
        kind = "failed"
    names = _flag_names(stamp, fit.x, fit.y)
    flagged = kind in ("wing", "failed") or bool(set(names) & (set(pol["photometry_reject"]) | {"REJECT"}))
    ch = channels.assign(stamp.detector, stamp.lam_um, tol_um=0.005)
    ap = aperture_flux(stamp, model, fit.x, fit.y) if kind != "failed" else None
    return PhotPoint(
        obs_id=stamp.obs_id, detector=stamp.detector, mjd=stamp.mjd, lam_um=stamp.lam_um, bw_um=stamp.bw_um,
        channel=ch.label if ch else None, flux=fit.flux * to_ujy, flux_err=fit.flux_err * to_ujy, flux_ap=ap,
        x=fit.x, y=fit.y, x_pred=xp, y_pred=yp, x_err=fit.x_err, y_err=fit.y_err, fit=kind, chi2r=fit.chi2r,
        flagged=flagged, flags=names, snr=float(snr), n_deblended=len(fit.others_flux) if kind == "forced" else 0)


def neighbours_at(track: Track, mjd: float, neighbours: list[dict], radius_arcsec: float) -> list[tuple[str, float, float]]:
    """(id, ra, dec) of Gaia sources other than the target within radius_arcsec of it at this time
    (propagated with their own proper motion)."""
    ra, dec = track.at(mjd)
    out = []
    yr = catalogs.mjd_to_year(mjd)
    for n in neighbours:
        if n["id"] == track.gaia_id:
            continue
        nra, ndec = (catalogs.propagate(n["ra"], n["dec"], n["pmra"], n["pmdec"], catalogs.GAIA_EPOCH, yr)
                     if n.get("pmra") is not None else (n["ra"], n["dec"]))
        if math.hypot((nra - ra) * math.cos(math.radians(dec)), ndec - dec) * 3600 < radius_arcsec:
            out.append((n["id"], nra, ndec))
    return out


def blend_neighbours(track: Track, mjd: float, neighbours: list[dict], radius_arcsec: Optional[float] = None) -> list[str]:
    """Gaia sources (other than the target) within 2 native px of the target at this time."""
    radius_arcsec = radius_arcsec or 2 * get_config()["pixel_scale_arcsec"]
    return [i for i, _, _ in neighbours_at(track, mjd, neighbours, radius_arcsec)]


def photometry_table(stamps: list[PreparedStamp], track: Track, bins: Optional[list[tuple[float, float]]] = None,
                     neighbours: Optional[list[dict]] = None, free: Optional[bool] = None,
                     deblend: bool = False) -> list[PhotPoint]:
    """measure() for every stamp at the track's position at that stamp's time, sorted by time.
    `neighbours` (Gaia rows) fill `blend`; with `deblend`, those within DEBLEND_RADIUS_PX are also fitted
    together with the target in forced fits."""
    out = []
    labels = assign_epochs([s.mjd for s in stamps], bins) if bins else [0] * len(stamps)
    r_deblend = DEBLEND_RADIUS_PX * get_config()["pixel_scale_arcsec"]
    for s, e in zip(stamps, labels):
        ra, dec = track.at(s.mjd)
        others = ([(a, b) for _, a, b in neighbours_at(track, s.mjd, neighbours, r_deblend)]
                  if deblend and neighbours else None)
        p = measure(s, ra, dec, free=free, others=others)
        p.epoch_label = epoch_label(e)
        if neighbours:
            p.blend = blend_neighbours(track, s.mjd, neighbours)
        out.append(p)
    return sorted(out, key=lambda p: p.mjd)


# ---------------------------------------------------------------- item 1: click-for-spectrum

Progress = Optional[Callable[[str, int, int], None]]


def spectrum_points(ra: float, dec: float, dets: list[int], fov: float = 0.1, track: Optional[Track] = None,
                    progress: Progress = None, neighbours: Optional[list[dict]] = None) -> tuple[Track, list[PhotPoint]]:
    """`neighbours`: Gaia rows around the target. None = query Gaia here ([] when it is down: no deblending)."""
    from .pipeline import NoCoverage, load_stamps
    track = track or track_for(ra, dec)
    if neighbours is None:
        try:
            neighbours = catalogs.gaia_query(ra, dec, NEIGHBOUR_QUERY_DEG)
        except catalogs.ResolverUnavailable:
            neighbours = []
    pts: list[PhotPoint] = []
    for d in dets:
        try:
            stamps, bins = load_stamps(ra, dec, fov, f"D{d}", progress)
        except NoCoverage:
            continue
        pts += photometry_table(stamps, track, bins, neighbours=neighbours, deblend=True)
    if not pts:
        raise NoCoverage(f"No SPHEREx exposures cover RA {ra:.5f}, Dec {dec:.5f}.")
    return track, sorted(pts, key=lambda p: (p.lam_um, p.mjd))


def spectrum_at(ra: float, dec: float, dets: Optional[list[int]] = None, **kw) -> list[dict]:
    """Issue #15: one point per exposure, wavelength at the source pixel, uJy."""
    _, pts = spectrum_points(ra, dec, dets or [1, 2, 3, 4, 5, 6], **kw)
    out = []
    for p in pts:
        if p.fit == "failed" or not (np.isfinite(p.flux) and np.isfinite(p.flux_err)):
            continue   # e.g. too few usable pixels at the stamp edge: no measurement, not a zero
        d = p.public()
        out.append({"wavelength_um": d["lam_um"], "flux": d["flux"], "flux_err": d["flux_err"],
                    "epoch_label": p.epoch_label, "flagged": p.flagged, "bandwidth_um": d["bw_um"],
                    "channel": p.channel, "mjd": d["mjd"], "obs_id": p.obs_id, "detector": p.detector,
                    "fit": p.fit, "flags": p.flags, "blend": p.blend, "n_deblended": p.n_deblended})
    return out


def ratio_spectrum(points: list[dict], compare: str, against: Optional[str] = None) -> list[dict]:
    """Item 4 method B: per channel, flux in pass `against` (default: the last pass) / flux in `compare`.

    Works from spectrum points (dicts with channel, epoch_label, flux, flux_err, flagged). Within a
    (channel, pass) cell, unflagged points are averaged (inverse-variance); flagged ones only if nothing else.
    A grey change gives a flat line; a colour-dependent one has a slope."""
    cells: dict[tuple[str, str], list[dict]] = {}
    for p in points:
        if p.get("channel"):
            cells.setdefault((p["channel"], p["epoch_label"]), []).append(p)
    passes = sorted({k[1] for k in cells}, key=lambda s: int(s[1:]))
    against = against or (passes[-1] if passes else None)

    def mean(group):
        good = [g for g in group if not g["flagged"]] or group
        w = np.array([1 / max(g["flux_err"], 1e-9) ** 2 for g in good])
        f = np.array([g["flux"] for g in good])
        return float((w * f).sum() / w.sum()), float(1 / np.sqrt(w.sum())), all(g["flagged"] for g in good)

    out = []
    for ch in sorted({k[0] for k in cells}, key=lambda c: channels.by_label(c).index):
        if (ch, compare) not in cells or (ch, against) not in cells or compare == against:
            continue
        f1, e1, fl1 = mean(cells[(ch, compare)])
        f2, e2, fl2 = mean(cells[(ch, against)])
        if f1 <= 0:
            continue
        r = f2 / f1
        out.append({"channel": ch, "lam_um": channels.by_label(ch).wavelength, "ratio": round(r, 5),
                    "ratio_err": round(abs(r) * math.hypot(e1 / f1, e2 / max(abs(f2), 1e-9)), 5),
                    "passes": [against, compare], "flagged": fl1 or fl2})
    return out
