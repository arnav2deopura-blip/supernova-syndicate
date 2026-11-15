"""Item 4: light curves that aren't fooled by SPHEREx's moving bandpass. Owner: B.

Every exposure sees the star at a different wavelength, so raw flux vs time mixes spectral shape with
variability. Three honest methods on one photometry table (photometry.photometry_table):

A. channel   flux in one channel vs time. No model; ~1 point per pass per channel.
B. ratio     per channel, F(pass N) / F(pass 1) vs wavelength (photometry.ratio_spectrum). Flat = grey change.
C. template  (default) build the star's mean spectrum T(lam) from all exposures, divide: s_i = F_i / T(lam_i),
             average s_i per time bin. Uses every exposure; assumes the spectral *shape* is constant, which is
             checked (a significant s-vs-lam slope inside a bin sets `shape_changed`).

Errors: photometric (VARIANCE) plus a systematic floor (config lightcurve.floor, raised to the scatter of
comparison stars when that is larger). Variability is claimed only if chi2/dof vs a constant is large AND the
comparison stars of similar brightness in the same field are quiet.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Optional

import numpy as np

from . import catalogs, channels
from .config import get_config
from .fits_processor import PreparedStamp
from .photometry import PhotPoint, Track, photometry_table

MIN_GOOD_FRACTION = 0.5
MAX_MEDIAN_FRAC_ERR = 0.30   # above this the per-point fluxes can't support a light curve (R Dra in D2: 0.64)


def _cfg() -> dict:
    return {"floor": 0.02, "bin_days": 15.0, "n_comparison": 8, **(get_config().get("lightcurve") or {})}


def usable(points: list[PhotPoint]) -> tuple[list[PhotPoint], bool]:
    """Points to build curves from: unflagged ones if they are at least half, else every successful fit
    (a saturated target has only wing fits). Returns (points, used_flagged)."""
    ok = [p for p in points if p.fit != "failed" and np.isfinite(p.flux) and p.flux_err > 0]
    good = [p for p in ok if not p.flagged]
    if len(good) >= MIN_GOOD_FRACTION * max(len(ok), 1) and good:
        return good, False
    return ok, True


# ---------------------------------------------------------------- template spectrum

def _weighted_mean(v: np.ndarray, e: np.ndarray) -> tuple[float, float]:
    w = 1.0 / e ** 2
    return float((w * v).sum() / w.sum()), float(1 / math.sqrt(w.sum()))


def template(points: list[PhotPoint], scale: Optional[dict[int, float]] = None) -> dict[int, list[tuple[float, float]]]:
    """T(lam) per detector, one node per channel with data: (median lam, median flux/scale) of that channel's
    points, in log space. Nodes sit at the points' own median wavelength, not the channel centre: a steep
    spectrum changes by several % across one channel. A running median over 3 neighbouring nodes then removes
    single-channel outliers, applied to the residual from a straight log-log line through the neighbours so a
    smooth slope survives. Returns {detector: [(lam, T), ...]} (interpolated within a detector, never across)."""
    by = defaultdict(list)
    for i, p in enumerate(points):
        ch = channels.assign(p.detector, p.lam_um, tol_um=0.005)
        f = p.flux / (scale.get(i, 1.0) if scale else 1.0)
        if ch is None or not f > 0:
            continue
        by[(p.detector, ch.subchan)].append((p.lam_um, f))
    out = {}
    for det in sorted({d for d, _ in by}):
        subs = sorted(s for d, s in by if d == det)
        nodes = [(float(np.median([a for a, _ in by[(det, s)]])), float(np.median(np.log([b for _, b in by[(det, s)]]))))
                 for s in subs]
        sm = []
        for k, (lam, lf) in enumerate(nodes):
            nb = nodes[max(k - 1, 0):k + 2]
            if len(nb) == 3:
                # median of the 3 log-fluxes after removing the line through the outer two
                (l0, f0), _, (l2, f2) = nb
                line = lambda l: f0 + (f2 - f0) * (np.log(l) - np.log(l0)) / (np.log(l2) - np.log(l0))  # noqa: E731
                lf = float(line(lam) + np.median([f - line(l) for l, f in nb]))
            sm.append((lam, float(np.exp(lf))))
        out[det] = sm
    return out


def template_at(t: dict[int, list[tuple[float, float]]], det: int, lam: float) -> float:
    pts = t.get(det)
    if not pts:
        return float("nan")
    lx = np.array([a for a, _ in pts])
    ly = np.array([b for _, b in pts])
    if len(lx) == 1:
        return float(ly[0])
    # log-log interpolation; beyond the end nodes, extend the end segment's power law by at most half a
    # channel (points sit within their channel), never across a detector gap
    ll, lyl = np.log(lx), np.log(ly)
    x = math.log(lam)
    if x < ll[0]:
        return float(math.exp(lyl[0] + (lyl[1] - lyl[0]) / (ll[1] - ll[0]) * (x - ll[0])))
    if x > ll[-1]:
        return float(math.exp(lyl[-1] + (lyl[-1] - lyl[-2]) / (ll[-1] - ll[-2]) * (x - ll[-1])))
    return float(math.exp(np.interp(x, ll, lyl)))


# ---------------------------------------------------------------- time bins

def time_bins(mjds: list[float], bin_days: float) -> list[int]:
    """Bin index per point: a new bin when the point is more than bin_days after the bin's first point."""
    order = np.argsort(mjds)
    out = [0] * len(mjds)
    b, start = -1, -1e18
    for i in order:
        if mjds[i] - start > bin_days:
            b += 1
            start = mjds[i]
        out[i] = b
    return out


def template_curve(points: list[PhotPoint], bin_days: float, floor: float, labels: Optional[list[str]] = None
                   ) -> dict:
    """Method C. Returns template, per-point scales, per-bin scales, chi2 vs constant, shape check."""
    if not points:
        return {"template": [], "points": [], "bins": [], "chi2_constant": None, "dof": 0, "shape_changed": False}
    mjds = [p.mjd for p in points]
    bidx = time_bins(mjds, bin_days)
    nb = max(bidx) + 1
    scale_pt: dict[int, float] = {}
    prev = None
    for _ in range(12):  # template <-> scales until they agree (passes may share few wavelengths)
        t = template(points, scale_pt or None)
        T = np.array([template_at(t, p.detector, p.lam_um) for p in points])
        s = np.array([p.flux for p in points]) / T
        se = np.hypot(np.array([p.flux_err for p in points]) / T, floor * np.abs(s))
        bins = []
        for b in range(nb):
            m = [i for i in range(len(points)) if bidx[i] == b and np.isfinite(s[i])]
            if not m:
                bins.append(None)
                continue
            sb, eb = _weighted_mean(s[m], se[m])
            bins.append((sb, eb, m))
        scale_pt = {i: bins[bidx[i]][0] for i in range(len(points)) if bins[bidx[i]] is not None}
        # normalise so the template carries the mean brightness and scales average to 1
        good = [x for x in bins if x is not None]
        norm, _ = _weighted_mean(np.array([x[0] for x in good]), np.array([x[1] for x in good]))
        scale_pt = {i: v / norm for i, v in scale_pt.items()}
        cur = np.array([x[0] / norm for x in good])
        if prev is not None and len(prev) == len(cur) and np.max(np.abs(cur - prev)) < 1e-4:
            break
        prev = cur

    good = [(b, x) for b, x in enumerate(bins) if x is not None]
    sb = np.array([x[0] for _, x in good]) / norm
    eb = np.array([x[1] for _, x in good]) / norm
    s, se = s / norm, se / norm
    chi2, dof = None, len(good) - 1
    if len(good) >= 2:
        c, _ = _weighted_mean(sb, eb)
        chi2 = float((((sb - c) / eb) ** 2).sum())

    shape_changed, slopes = False, []
    for (b, x), sbin in zip(good, sb):
        m = x[2]
        lam = np.array([points[i].lam_um for i in m])
        if len(m) >= 4 and np.ptp(lam) > 0.05:
            w = 1 / se[m] ** 2
            A = np.c_[np.ones_like(lam), lam - lam.mean()]
            cov = np.linalg.pinv(A.T @ (A * w[:, None]))
            beta = cov @ (A.T @ (w * s[m]))
            sig = math.sqrt(cov[1, 1])
            slopes.append({"bin": b, "slope_per_um": round(float(beta[1]), 4), "err": round(sig, 4)})
            if abs(beta[1]) > 3 * sig and abs(beta[1]) * np.ptp(lam) > 2 * floor:
                shape_changed = True

    bin_rows = []
    for (b, x), v, e in zip(good, sb, eb):
        m = x[2]
        mj = [points[i].mjd for i in m]
        row = {"mjd": round(float(np.mean(mj)), 4), "mjd_start": round(min(mj), 4), "mjd_end": round(max(mj), 4),
               "scale": round(float(v), 5), "scale_err": round(float(e), 5), "n": len(m),
               "lam_min": round(min(points[i].lam_um for i in m), 4), "lam_max": round(max(points[i].lam_um for i in m), 4)}
        if labels:
            row["label"] = max(set(labels[i] for i in m), key=[labels[i] for i in m].count)
        bin_rows.append(row)
    tmpl = [{"detector": d, "lam_um": round(l, 4), "flux": round(f, 3)} for d, pts in sorted(t.items()) for l, f in pts]
    return {"template": tmpl, "scale": s, "scale_err": se, "bins": bin_rows, "chi2_constant": chi2, "dof": max(dof, 0),
            "shape_changed": shape_changed, "slopes": slopes}


def channel_curve(points: list[PhotPoint], channel: str, bin_days: float, floor: float) -> list[dict]:
    """Method A: one channel's flux vs time, binned."""
    sel = [p for p in points if p.channel == channel]
    if not sel:
        return []
    bidx = time_bins([p.mjd for p in sel], bin_days)
    out = []
    for b in sorted(set(bidx)):
        m = [p for p, i in zip(sel, bidx) if i == b]
        f = np.array([p.flux for p in m])
        e = np.hypot([p.flux_err for p in m], floor * np.abs(f))
        v, ve = _weighted_mean(f, e)
        out.append({"mjd": round(float(np.mean([p.mjd for p in m])), 4), "flux": round(v, 3), "flux_err": round(ve, 3),
                    "n": len(m), "label": m[0].epoch_label})
    return out


# ---------------------------------------------------------------- comparison stars

def comparison_stars(stamps: list[PreparedStamp], target: Track, field: list[dict], target_flux: float,
                     bins: Optional[list[tuple[float, float]]], bin_days: float, floor: float, n_max: int
                     ) -> dict:
    """Run the same template light curve on Gaia stars in the field: unblended, unsaturated, fully on every
    stamp, brightness closest to the target's. Their bin-scale rms is the empirical systematic floor."""
    cands = []
    edge = 6
    yr = catalogs.mjd_to_year(float(np.median([s.mjd for s in stamps])))
    for g in field:
        if g["id"] == target.gaia_id or g.get("mag") is None or not (8.0 <= g["mag"] <= 16.5):
            continue
        tr = Track(g["ra"], g["dec"], catalogs.GAIA_EPOCH, g["pmra"] or 0.0, g["pmdec"] or 0.0, source="gaia_dr3", gaia_id=g["id"])
        ra, dec = tr.at(np.median([s.mjd for s in stamps]))
        tra, tdec = target.at(np.median([s.mjd for s in stamps]))
        if math.hypot((ra - tra) * math.cos(math.radians(dec)), dec - tdec) * 3600 < 30:
            continue
        crowded = False
        for o in field:
            if o["id"] == g["id"]:
                continue
            ora, odec = catalogs.propagate(o["ra"], o["dec"], o["pmra"] or 0, o["pmdec"] or 0, catalogs.GAIA_EPOCH, yr)
            if math.hypot((ora - ra) * math.cos(math.radians(dec)), odec - dec) * 3600 < 3 * get_config()["pixel_scale_arcsec"] \
                    and (o.get("mag") or 99) < g["mag"] + 2.5:
                crowded = True
                break
        if crowded:
            continue
        inside = True
        for s in stamps:
            x, y = s.wcs.all_world2pix(*tr.at(s.mjd), 0)
            if not (edge <= x < s.image.shape[1] - edge and edge <= y < s.image.shape[0] - edge):
                inside = False
                break
        if inside:
            cands.append((g, tr))
    measured = []
    for g, tr in cands[: 4 * n_max]:
        pts = photometry_table(stamps, tr, bins)
        good = [p for p in pts if not p.flagged and p.fit != "failed"]
        if len(good) < 0.8 * len(pts) or len(good) < 4 or np.median([p.snr for p in good]) < 20:
            continue
        measured.append((g, good, float(np.median([p.flux for p in good]))))
    if target_flux > 0:
        measured.sort(key=lambda m: abs(math.log(max(m[2], 1e-9) / target_flux)))
    measured = measured[:n_max]
    stars, devs = [], []
    for g, good, med in measured:
        tc = template_curve(good, bin_days, 0.0)
        sc = np.array([b["scale"] for b in tc["bins"]])
        if len(sc) >= 2:
            devs += list(sc - 1.0)
        stars.append({"id": g["id"], "mag_g": g["mag"], "median_flux": round(med, 2), "n": len(good),
                      "chi2_constant": None if tc["chi2_constant"] is None else round(tc["chi2_constant"], 2),
                      "dof": tc["dof"], "bins": [{"mjd": b["mjd"], "scale": b["scale"], "scale_err": b["scale_err"]} for b in tc["bins"]]})
    rms = float(np.sqrt(np.mean(np.square(devs)))) if devs else None
    return {"n": len(stars), "rms_scale": None if rms is None else round(rms, 5), "stars": stars}


# ---------------------------------------------------------------- periods (R Dra)

def period_search(mjd: np.ndarray, y: np.ndarray, e: np.ndarray, fixed_period: Optional[float] = None) -> Optional[dict]:
    """Lomb-Scargle over 30-1000 d (needs >= 6 points) plus a sinusoid at the best (or a fixed) period."""
    if len(mjd) < 6 or np.ptp(mjd) < 60:
        return None
    from astropy.timeseries import LombScargle
    ls = LombScargle(mjd, y, e)
    freq, power = ls.autopower(minimum_frequency=1 / 1000, maximum_frequency=1 / 30, samples_per_peak=20)
    best = 1 / freq[np.argmax(power)]
    out = {"best_period_days": round(float(best), 2), "power": round(float(power.max()), 4),
           "false_alarm_probability": float(ls.false_alarm_probability(power.max()))}
    for name, P in (("best", best), ("fixed", fixed_period)):
        if not P:
            continue
        w = 2 * np.pi / P
        A = np.c_[np.ones_like(mjd), np.sin(w * mjd), np.cos(w * mjd)]
        W = 1 / e ** 2
        cov = np.linalg.pinv(A.T @ (A * W[:, None]))
        b = cov @ (A.T @ (W * y))
        amp = math.hypot(b[1], b[2])
        amp_err = math.sqrt(max((b[1] ** 2 * cov[1, 1] + b[2] ** 2 * cov[2, 2] + 2 * b[1] * b[2] * cov[1, 2]), 0)) / max(amp, 1e-12)
        t_max = (math.atan2(b[1], b[2]) / w) % P   # phase of maximum, days after MJD 0 mod P
        n_max = math.floor((mjd.min() - t_max) / P) + 1
        out[f"sinusoid_{name}"] = {"period_days": round(float(P), 2), "semi_amplitude": round(amp, 5),
                                   "semi_amplitude_err": round(amp_err, 5), "mean": round(float(b[0]), 5),
                                   "mjd_of_maximum": round(t_max + n_max * P, 2)}
    return out


# ---------------------------------------------------------------- the product

def build_lightcurve(stamps: list[PreparedStamp], bins: list[tuple[float, float]], track: Track,
                     method: str = "template", channel: Optional[str] = None, bin_days: Optional[float] = None,
                     field: Optional[list[dict]] = None, period_days: Optional[float] = None,
                     compare_stars: bool = True) -> dict:
    cfg = _cfg()
    bin_days = bin_days or cfg["bin_days"]
    pts_all = photometry_table(stamps, track, bins, neighbours=field)
    pts, used_flagged = usable(pts_all)
    floor = cfg["floor"]

    comp = None
    if compare_stars and field:
        tflux = float(np.median([p.flux for p in pts])) if pts else 0.0
        comp = comparison_stars(stamps, track, field, tflux, bins, bin_days, floor, int(cfg["n_comparison"]))
        if comp["rms_scale"] is not None:
            floor = max(floor, comp["rms_scale"])

    tc = template_curve(pts, bin_days, floor, [p.epoch_label for p in pts])
    sidx = {id(p): i for i, p in enumerate(pts)}
    point_rows = []
    for p in pts_all:
        d = p.public()
        i = sidx.get(id(p))
        d["scale"] = None if i is None or not np.isfinite(tc["scale"][i]) else round(float(tc["scale"][i]), 5)
        d["scale_err"] = None if i is None or not np.isfinite(tc["scale_err"][i]) else round(float(tc["scale_err"][i]), 5)
        d["used"] = i is not None
        point_rows.append(d)

    frac = [p.flux_err / abs(p.flux) for p in pts if p.flux]
    median_frac_err = float(np.median(frac)) if frac else float("nan")
    reliable = bool(np.isfinite(median_frac_err) and median_frac_err <= MAX_MEDIAN_FRAC_ERR)
    variable = None
    if reliable and tc["chi2_constant"] is not None and tc["dof"] > 0:
        quiet = comp is None or comp["rms_scale"] is None or comp["rms_scale"] < 0.05
        variable = bool(tc["chi2_constant"] / tc["dof"] > 5 and quiet)
    out = {
        "method": method, "units": "uJy", "bin_days": bin_days, "systematic_floor": round(floor, 5),
        "track": {"ra": track.ra, "dec": track.dec, "epoch": track.epoch, "pmra": track.pmra, "pmdec": track.pmdec,
                  "source": track.source, "gaia_id": track.gaia_id},
        "used_flagged": used_flagged,
        "n_points": len(pts_all), "n_used": len(pts),
        "template": tc["template"], "points": point_rows, "bins": tc["bins"],
        "chi2_constant": None if tc["chi2_constant"] is None else round(tc["chi2_constant"], 3), "dof": tc["dof"],
        "variable": variable, "reliable": reliable, "median_frac_err": round(median_frac_err, 4),
        "shape_changed": tc["shape_changed"], "bin_slopes": tc["slopes"],
        "comparison_stars": comp,
    }
    if method == "channel":
        if channel is None:
            counts = defaultdict(int)
            for p in pts:
                counts[p.channel] += 1
            channel = max((c for c in counts if c), key=lambda c: counts[c], default=None)
        out["channel"] = channel
        out["channel_curve"] = channel_curve(pts, channel, bin_days, floor) if channel else []
    if len(tc["bins"]) >= 6:
        out["period"] = period_search(np.array([b["mjd"] for b in tc["bins"]]), np.array([b["scale"] for b in tc["bins"]]),
                                      np.array([b["scale_err"] for b in tc["bins"]]), period_days)
    if not reliable:
        out["note"] = (f"Not reliable: the median point error is {median_frac_err:.0%} (limit "
                       f"{MAX_MEDIAN_FRAC_ERR:.0%}), almost always because the star is deeply saturated in this band. "
                       "No variability claim is made; try a detector where the star is fainter.")
    elif used_flagged:
        out["note"] = ("Most points are saturated-core wing fits; scales are less precise. "
                       "Prefer a longer-wavelength detector where the star is not saturated.")
    return out
