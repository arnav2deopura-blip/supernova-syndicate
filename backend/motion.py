"""Item 5: a measured proper motion (+ optional parallax) with errors, compared with Gaia. Owner: B.

Chain, per exposure:
1. ePSF fit of the target on the native stamp (wing fit if saturated), started from the prior track
   (photometry.measure with a free position).
2. Registration QC: Gaia stars on the same stamp (unsaturated, unblended, S/N >= 20) are fit the same way
   and compared with Gaia propagated to the exposure's MJD. A shift (>= 3 stars) or shift + linear term
   (>= 6 stars) maps the WCS onto Gaia; it is evaluated at the target and removed. The residual rms is the
   exposure's "registration quality"; exposures with < 3 stars or rms > 0.3 px are down-weighted.
3. Pixel -> sky with the exposure's SIP WCS.
Then over all exposures (weighted least squares on tangent-plane offsets, mas):
   xi(t)  = xi0  + pmra  (t - t0) + plx * P_ra(t)
   eta(t) = eta0 + pmdec (t - t0) + plx * P_dec(t)
t0 = weighted mean epoch (decorrelates position and motion). P are the parallax factors from the observer's
barycentric position (Earth from astropy + the spacecraft's geocentric X_SC/Y_SC/Z_SC). Errors come from the
covariance, scaled by sqrt(chi2/dof) when > 1, and are cross-checked by a bootstrap over exposures.
Parallax: "fit" (needs passes on both sides of the orbit), "gaia_fixed" (default when Gaia knows it: removes a
nuisance term, PM still measured independently) or "ignored".
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from . import catalogs, psf
from .fits_processor import PreparedStamp, assign_epochs, epoch_label
from .photometry import Track, measure

AU_KM = 1.495978707e8


class NotEnoughData(LookupError):
    """Too few measured positions (or passes) for a motion fit."""
REG_MAX_RMS_PX = 0.3
POS_FLOOR_PX = 0.02


# ---------------------------------------------------------------- geometry

def tangent_offsets_mas(ra0: float, dec0: float, ra, dec):
    """Gnomonic (xi east, eta north) offsets of (ra, dec) about (ra0, dec0), mas."""
    a0, d0, a, d = map(np.radians, (ra0, dec0, np.asarray(ra, float), np.asarray(dec, float)))
    c = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    xi = np.cos(d) * np.sin(a - a0) / c
    eta = (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / c
    return np.degrees(xi) * 3.6e6, np.degrees(eta) * 3.6e6


def from_tangent_mas(ra0: float, dec0: float, xi, eta):
    x, y = np.radians(np.asarray(xi) / 3.6e6), np.radians(np.asarray(eta) / 3.6e6)
    a0, d0 = math.radians(ra0), math.radians(dec0)
    rho = np.hypot(x, y)
    c = np.arctan(rho)
    with np.errstate(invalid="ignore", divide="ignore"):
        dec = np.where(rho == 0, d0, np.arcsin(np.cos(c) * math.sin(d0) + y * np.sin(c) * math.cos(d0) / np.where(rho == 0, 1, rho)))
        ra = a0 + np.arctan2(x * np.sin(c), rho * math.cos(d0) * np.cos(c) - y * math.sin(d0) * np.sin(c))
    return np.degrees(ra) % 360, np.degrees(dec)


def observer_bary_au(mjd: float, sc_pos_km: Optional[tuple[float, float, float]] = None) -> np.ndarray:
    """Barycentric position of the observer (Earth + spacecraft geocentric offset), AU, ICRS axes."""
    from astropy.coordinates import get_body_barycentric
    from astropy.time import Time
    e = get_body_barycentric("earth", Time(mjd, format="mjd", scale="tdb"))
    v = np.array([e.x.to_value("km"), e.y.to_value("km"), e.z.to_value("km")])
    if sc_pos_km is not None:
        v = v + np.asarray(sc_pos_km, float)
    return v / AU_KM


def parallax_factors(ra: float, dec: float, obs_au: np.ndarray) -> tuple[float, float]:
    """(P_ra*, P_dec): apparent offset per unit parallax. Star appears displaced opposite the observer."""
    a, d = math.radians(ra), math.radians(dec)
    X, Y, Z = obs_au
    return (X * math.sin(a) - Y * math.cos(a),
            X * math.cos(a) * math.sin(d) + Y * math.sin(a) * math.sin(d) - Z * math.cos(d))


def pixel_scale_mas(stamp: PreparedStamp) -> float:
    from astropy.wcs.utils import proj_plane_pixel_scales
    return float(np.mean(proj_plane_pixel_scales(stamp.wcs.celestial))) * 3.6e6


# ---------------------------------------------------------------- registration

def reference_stars(stamp: PreparedStamp, field: list[dict], exclude_id: Optional[str], target_xy: tuple[float, float],
                    mag_range=(9.0, 16.0), edge: int = 5) -> list[tuple[dict, float, float]]:
    """Gaia stars on the stamp, away from the target and from each other, with predicted pixel positions."""
    yr = catalogs.mjd_to_year(stamp.mjd)
    ny, nx = stamp.image.shape
    pos = []
    for g in field:
        if g.get("pmra") is not None:
            ra, dec = catalogs.propagate(g["ra"], g["dec"], g["pmra"], g["pmdec"], catalogs.GAIA_EPOCH, yr)
        else:
            ra, dec = g["ra"], g["dec"]
        x, y = (float(v) for v in stamp.wcs.all_world2pix(ra, dec, 0))
        if -3 <= x < nx + 3 and -3 <= y < ny + 3:
            pos.append((g, x, y))
    out = []
    for g, x, y in pos:
        if g["id"] == exclude_id or g.get("mag") is None or not (mag_range[0] <= g["mag"] <= mag_range[1]):
            continue
        if not (edge <= x < nx - edge and edge <= y < ny - edge):
            continue
        if math.hypot(x - target_xy[0], y - target_xy[1]) < 5:
            continue
        if any(o is not g and math.hypot(ox - x, oy - y) < 3 and (o.get("mag") or 99) < g["mag"] + 3 for o, ox, oy in pos):
            continue
        out.append((g, x, y))
    return out


def register(stamp: PreparedStamp, refs: list[tuple[dict, float, float]], at_xy: tuple[float, float]) -> dict:
    """Fit reference stars; model (measured - predicted) as a shift or shift + linear term; evaluate at at_xy.
    Returns {"dx", "dy", "err_px", "rms_px", "n_ref", "model"}."""
    model = psf.model_for(stamp)
    rows = []
    kw = psf.fit_masks(stamp)
    for g, x, y in refs:
        cx, cy = psf.centroid(stamp.image, x, y, r=1.5)
        if math.hypot(cx - x, cy - y) > 1.5:
            cx, cy = x, y
        f = psf.fit_star(stamp.image, stamp.variance, model, cx, cy, max_shift=1.5, **kw)
        if not f.ok or f.wing or f.flux_err <= 0 or f.flux / f.flux_err < 20:
            continue
        rows.append((x, y, f.x - x, f.y - y, max(math.hypot(f.x_err, f.y_err) / math.sqrt(2), 0.01)))
    n = len(rows)
    if n == 0:
        return {"dx": 0.0, "dy": 0.0, "err_px": float("nan"), "rms_px": float("nan"), "n_ref": 0, "model": "none"}
    a = np.array(rows)
    keep = np.ones(n, bool)
    for _ in range(3):   # reject misfits / unflagged movers / blends
        if keep.sum() < 3:
            break
        mdx, mdy = np.median(a[keep, 2]), np.median(a[keep, 3])
        r = np.hypot(a[:, 2] - mdx, a[:, 3] - mdy)
        mad = 1.4826 * np.median(r[keep]) + 0.03
        new = r < max(4 * mad, 0.15)
        if (new == keep).all():
            break
        keep = new
    a = a[keep]
    n = len(a)
    w = 1 / a[:, 4] ** 2
    if n >= 6:
        A = np.c_[np.ones(n), a[:, 0] - at_xy[0], a[:, 1] - at_xy[1]]
        cov = np.linalg.pinv(A.T @ (A * w[:, None]))
        bx = cov @ (A.T @ (w * a[:, 2]))
        by = cov @ (A.T @ (w * a[:, 3]))
        res = np.hypot(a[:, 2] - A @ bx, a[:, 3] - A @ by)
        dx, dy, kind = bx[0], by[0], "affine"
        dof = max(n - 3, 1)
        base = math.sqrt(cov[0, 0])
    else:
        dx, dy = float((w * a[:, 2]).sum() / w.sum()), float((w * a[:, 3]).sum() / w.sum())
        res = np.hypot(a[:, 2] - dx, a[:, 3] - dy)
        kind = "shift"
        dof = max(n - 1, 1)
        base = 1 / math.sqrt(w.sum())
    rms = float(np.sqrt((res ** 2).sum() / dof / 2)) if n > 1 else float("nan")
    err = math.hypot(base, (rms if np.isfinite(rms) else 0.1) / math.sqrt(n))
    return {"dx": float(dx), "dy": float(dy), "err_px": err, "rms_px": rms, "n_ref": n, "model": kind}


# ---------------------------------------------------------------- per exposure

def measure_exposures(stamps: list[PreparedStamp], track: Track, field: list[dict], bins) -> list[dict]:
    labels = assign_epochs([s.mjd for s in stamps], bins) if bins else [0] * len(stamps)
    out = []
    for s, e in zip(stamps, labels):
        ra_p, dec_p = track.at(s.mjd)
        p = measure(s, ra_p, dec_p, free=True)
        row = {"obs_id": s.obs_id, "det": s.detector, "mjd": round(s.mjd, 5), "label": epoch_label(e),
               "lam_um": round(s.lam_um, 4), "fit": p.fit, "flags": p.flags, "snr": round(p.snr, 1), "used": False}
        if p.fit not in ("psf", "wing"):
            row["reason"] = "target not fitted with a free position (too faint in this exposure)"
            out.append(row)
            continue
        refs = reference_stars(s, field, track.gaia_id, (p.x, p.y))
        reg = register(s, refs, (p.x, p.y))
        x, y = p.x - reg["dx"], p.y - reg["dy"]
        ra, dec = (float(v) for v in s.wcs.all_pix2world(x, y, 0))
        scale = pixel_scale_mas(s)
        err_px = math.sqrt(((p.x_err ** 2 + p.y_err ** 2) / 2) + (reg["err_px"] if np.isfinite(reg["err_px"]) else 0.3) ** 2
                           + POS_FLOOR_PX ** 2)
        weight_note = None
        if reg["n_ref"] < 3 or not np.isfinite(reg["rms_px"]) or reg["rms_px"] > REG_MAX_RMS_PX:
            err_px = math.hypot(err_px, 0.3)
            weight_note = "poor registration: down-weighted"
        row.update({"ra": ra, "dec": dec, "err_mas": err_px * scale, "x": round(x, 4), "y": round(y, 4),
                    "reg_dx_px": round(reg["dx"], 4), "reg_dy_px": round(reg["dy"], 4),
                    "reg_rms_px": None if not np.isfinite(reg["rms_px"]) else round(reg["rms_px"], 4),
                    "n_ref": reg["n_ref"], "reg_model": reg["model"], "used": True, "_sc": s.sc_pos_km})
        if weight_note:
            row["note"] = weight_note
        out.append(row)
    return out


# ---------------------------------------------------------------- the fit

def _solve(t, xi, eta, err, P, fit_plx: bool, plx_fixed: float):
    """Joint WLS for [xi0, eta0, pmra, pmdec(, plx)] given t (yr, relative to t0)."""
    n = len(t)
    cols = 5 if fit_plx else 4
    A = np.zeros((2 * n, cols))
    A[:n, 0] = 1
    A[n:, 1] = 1
    A[:n, 2] = t
    A[n:, 3] = t
    b = np.r_[xi - plx_fixed * P[:, 0], eta - plx_fixed * P[:, 1]]
    if fit_plx:
        A[:n, 4] = P[:, 0]
        A[n:, 4] = P[:, 1]
    w = np.r_[1 / err ** 2, 1 / err ** 2]
    cov = np.linalg.pinv(A.T @ (A * w[:, None]))
    beta = cov @ (A.T @ (w * b))
    r = (b - A @ beta) * np.sqrt(w)
    return beta, cov, r


def fit_motion(rows: list[dict], ref_ra: float, ref_dec: float, parallax_mode: str = "ignored",
               plx_fixed_mas: float = 0.0, clip: float = 4.0, n_boot: int = 200, seed: int = 0) -> dict:
    use = [r for r in rows if r.get("used")]
    if len(use) < 3 or len({r["label"] for r in use}) < 2:
        raise NotEnoughData("The target was measured in fewer than two survey passes in this band; "
                            "try another detector (det=all) or a brighter target.")
    years = np.array([catalogs.mjd_to_year(r["mjd"]) for r in use])
    xi, eta = tangent_offsets_mas(ref_ra, ref_dec, [r["ra"] for r in use], [r["dec"] for r in use])
    err = np.array([r["err_mas"] for r in use])
    P = np.array([parallax_factors(ref_ra, ref_dec, observer_bary_au(r["mjd"], r.get("_sc"))) for r in use])
    w = 1 / err ** 2
    t0 = float((w * years).sum() / w.sum())
    t = years - t0
    fit_plx = parallax_mode == "fit"
    plx_f = plx_fixed_mas if parallax_mode == "gaia_fixed" else 0.0
    keep = np.ones(len(use), bool)
    for _ in range(5):
        beta, cov, r = _solve(t[keep], xi[keep], eta[keep], err[keep], P[keep], fit_plx, plx_f)
        # residuals for all points
        pred_xi = beta[0] + beta[2] * t + (beta[4] if fit_plx else plx_f) * P[:, 0]
        pred_eta = beta[1] + beta[3] * t + (beta[4] if fit_plx else plx_f) * P[:, 1]
        rn = np.hypot(xi - pred_xi, eta - pred_eta) / err / math.sqrt(2)
        dof = 2 * keep.sum() - len(beta)
        chi2 = float((r ** 2).sum())
        s = math.sqrt(max(1.0, chi2 / max(dof, 1)))
        new = rn < clip * s
        if (new == keep).all() or new.sum() < 3:
            break
        keep = new
    cov_s = cov * max(1.0, chi2 / max(dof, 1))
    for i, r_ in enumerate(use):
        r_["used"] = bool(keep[i])
        r_["resid_xi_mas"] = round(float(xi[i] - pred_xi[i]), 2)
        r_["resid_eta_mas"] = round(float(eta[i] - pred_eta[i]), 2)
        if not keep[i]:
            r_["note"] = f"clipped ({rn[i]:.1f} sigma)"

    boot = None
    if n_boot and keep.sum() >= 6:
        rng = np.random.default_rng(seed)
        idx = np.nonzero(keep)[0]
        samples = []
        for _ in range(n_boot):
            pick = rng.choice(idx, len(idx))
            if len(set(np.array([use[i]["label"] for i in pick]))) < 2:
                continue
            b, _, _ = _solve(t[pick], xi[pick], eta[pick], err[pick], P[pick], fit_plx, plx_f)
            samples.append(b)
        if samples:
            sm = np.array(samples)
            boot = {"pmra_err": round(float(sm[:, 2].std()), 2), "pmdec_err": round(float(sm[:, 3].std()), 2), "n": len(sm)}
            if fit_plx:
                boot["parallax_err"] = round(float(sm[:, 4].std()), 2)

    pmra, pmdec = float(beta[2]), float(beta[3])
    e_ra, e_dec = math.sqrt(cov_s[2, 2]), math.sqrt(cov_s[3, 3])
    mu = math.hypot(pmra, pmdec)
    mu_err = math.sqrt((pmra * e_ra) ** 2 + (pmdec * e_dec) ** 2 + 2 * pmra * pmdec * cov_s[2, 3]) / max(mu, 1e-9)
    pa = math.degrees(math.atan2(pmra, pmdec)) % 360
    pa_err = math.degrees(math.sqrt((pmdec * e_ra) ** 2 + (pmra * e_dec) ** 2 - 2 * pmra * pmdec * cov_s[2, 3]) / max(mu, 1e-9) ** 2)
    ra0, dec0 = from_tangent_mas(ref_ra, ref_dec, beta[0], beta[1])
    out = {"t0": round(t0, 4), "ra0": round(float(ra0), 8), "dec0": round(float(dec0), 8),
           "pos_err_mas": round(math.sqrt((cov_s[0, 0] + cov_s[1, 1]) / 2), 2),
           "pmra": round(pmra, 2), "pmra_err": round(e_ra, 2), "pmdec": round(pmdec, 2), "pmdec_err": round(e_dec, 2),
           "pm_corr": round(float(cov_s[2, 3] / (e_ra * e_dec)), 3),
           "pm_total": round(mu, 2), "pm_total_err": round(mu_err, 2), "pa_deg": round(pa, 2), "pa_err_deg": round(pa_err, 2),
           "parallax_mode": parallax_mode,
           "parallax": round(float(beta[4]), 2) if fit_plx else (round(plx_f, 3) if parallax_mode == "gaia_fixed" else None),
           "parallax_err": round(math.sqrt(cov_s[4, 4]), 2) if fit_plx else None,
           "chi2_dof": round(chi2 / max(dof, 1), 3), "n": int(keep.sum()), "n_clipped": int((~keep).sum()),
           "bootstrap": boot}
    return out


def compare(fit: dict, ref: dict, name: str) -> dict:
    """Difference / combined sigma per component and in total, against a catalogue PM (mas/yr)."""
    e_ra = math.hypot(fit["pmra_err"], ref.get("pmra_err") or 0.0)
    e_de = math.hypot(fit["pmdec_err"], ref.get("pmdec_err") or 0.0)
    d_ra, d_de = fit["pmra"] - ref["pmra"], fit["pmdec"] - ref["pmdec"]
    chi2 = (d_ra / e_ra) ** 2 + (d_de / e_de) ** 2
    out = {"catalog": name, "pmra": ref["pmra"], "pmdec": ref["pmdec"],
           "pm_total": round(math.hypot(ref["pmra"], ref["pmdec"]), 2),
           "pa_deg": round(math.degrees(math.atan2(ref["pmra"], ref["pmdec"])) % 360, 2),
           "pmra_sigma_diff": round(d_ra / e_ra, 2), "pmdec_sigma_diff": round(d_de / e_de, 2),
           "pm_sigma_diff": round(math.sqrt(chi2 / 2), 2), "chi2_2dof": round(chi2, 2)}
    for k in ("id", "parallax"):
        if ref.get(k) is not None:
            out[k] = ref[k]
    return out


def pass_positions(rows: list[dict], ref_ra: float, ref_dec: float) -> list[dict]:
    out = []
    for lab in sorted({r["label"] for r in rows if r.get("used")}, key=lambda s: int(s[1:])):
        g = [r for r in rows if r.get("used") and r["label"] == lab]
        xi, eta = tangent_offsets_mas(ref_ra, ref_dec, [r["ra"] for r in g], [r["dec"] for r in g])
        w = 1 / np.array([r["err_mas"] for r in g]) ** 2
        mx, my = float((w * xi).sum() / w.sum()), float((w * eta).sum() / w.sum())
        ra, dec = from_tangent_mas(ref_ra, ref_dec, mx, my)
        out.append({"label": lab, "mjd": round(float(np.mean([r["mjd"] for r in g])), 4), "ra": round(float(ra), 8),
                    "dec": round(float(dec), 8), "err_mas": round(float(1 / math.sqrt(w.sum())), 2), "n": len(g)})
    return out


def build_motion(stamps: list[PreparedStamp], bins, track: Track, field: list[dict], fit_parallax: bool = False,
                 catalog_pm: Optional[dict] = None) -> dict:
    """Everything /api/motion returns, from stamps of one or more detectors."""
    rows = measure_exposures(stamps, track, field, bins)
    mid = float(np.median([s.mjd for s in stamps]))
    ref_ra, ref_dec = track.at(mid)
    if fit_parallax:
        mode = "fit"
    elif track.parallax is not None:
        mode = "gaia_fixed"
    else:
        mode = "ignored"
    fit = fit_motion(rows, ref_ra, ref_dec, mode, track.parallax or 0.0)
    out = {"target": {"ra": ref_ra, "dec": ref_dec, "mjd": round(mid, 4)},
           "prior": {"source": track.source, "pmra": track.pmra, "pmdec": track.pmdec},
           "exposures": [], "passes": pass_positions(rows, ref_ra, ref_dec), "fit": fit,
           "units": {"pm": "mas/yr", "parallax": "mas", "position_err": "mas"}, "gaia": None, "catalog": None}
    for r in rows:
        r = {k: v for k, v in r.items() if not k.startswith("_")}
        if "ra" in r:
            r["ra"], r["dec"], r["err_mas"] = round(r["ra"], 8), round(r["dec"], 8), round(r["err_mas"], 1)
        out["exposures"].append(r)
    if track.gaia is not None:
        g = track.gaia
        out["gaia"] = compare(fit, {"pmra": g["pmra"], "pmdec": g["pmdec"], "id": g["id"], "parallax": g.get("parallax")},
                              "gaia_dr3")
    elif catalog_pm is not None:
        out["catalog"] = compare(fit, catalog_pm, catalog_pm.get("catalog", "simbad"))
    return out
