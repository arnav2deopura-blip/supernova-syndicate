"""Discovery mode: find what moved between passes, and what moved that Gaia doesn't know about. Owner: B.

This is the Planet X / Backyard Worlds use of the blink: a cold brown dwarf like WISE 0855 is invisible to
Gaia (optical) but bright at 4-5 um and moves several arcsec per year.

Per field and detector, from the co-added pass frames and their calibrated noise maps (pipeline):
1. detect: local maxima >= `snr_min` sigma above a local background in every pass frame; Gaussian-weighted
   centroid; position error = PSF sigma / SNR (+ the frame's registration scatter);
2. register: subtract each frame's median offset from Gaia (frame_astrometry), so pass-to-pass shifts of
   the whole frame cannot look like motion;
3. link: every pairing of a first-pass and a last-pass detection within max_pm * dt is a hypothesis; the
   intermediate passes must each have a detection near the predicted line. Weighted linear fit of position
   vs time per track; the best (lowest chi2) tracks win, each detection used once;
4. classify each track against Gaia DR3 propagated to each pass:
   `stationary` (motion < 5 sigma), `known_mover` (moves, matches a Gaia source with consistent PM),
   `gaia_pm_mismatch` (matches Gaia but the PM disagrees by > 5 sigma), `candidate` (moves at > 5 sigma and
   no Gaia source follows it: the interesting ones).
The Gaia-matched tracks double as the ensemble null test: their (measured - Gaia) PM pulls should scatter
with unit width if the errors are right.

Needs >= 3 passes for candidates: with two passes any nearby pair of sources is a possible "track".
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from . import catalogs
from .pipeline import frame_astrometry

PSF_SIGMA_ARCSEC = 7.5 / 2.355
POS_FLOOR_ARCSEC = 0.25      # centroid + registration systematics on the 3.075" grid (frame QC: 0.1-0.5")
ARTEFACT_RADIUS_ARCSEC = 15.0   # ~2 PSF FWHM
BRIGHT_SNR = 500.0           # a real new mover this bright would already be catalogued
BRIGHT_GAIA_MAG = 12.0
FORCED_SNR = 3.0             # a pass without a catalogued detection confirms a track at >= 3 sigma on the line
SEP_GAIA_ARCSEC = 3.5        # Gaia match radius at each pass
MOVE_SIGMA = 5.0


def _fill_nan_cores(img: np.ndarray, iters: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """Saturated cores are NaN: fill them with the max of their finite neighbours so a peak exists there."""
    from scipy.ndimage import maximum_filter

    out = img.copy()
    holes = ~np.isfinite(out)
    for _ in range(iters):
        nanm = ~np.isfinite(out)
        if not nanm.any():
            break
        m = maximum_filter(np.where(nanm, -np.inf, out), size=3)
        fill = nanm & np.isfinite(m)
        out[fill] = m[fill]
    return out, holes


def _centroid(sub: np.ndarray, x0: float, y0: float, sig: float = 1.1) -> tuple[float, float]:
    h, w = sub.shape
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = float(x0), float(y0)
    for _ in range(8):
        r2 = (xx - cx) ** 2 + (yy - cy) ** 2
        wgt = np.where(r2 <= 3.5 ** 2, np.exp(-r2 / (2 * sig ** 2)) * sub, 0.0)
        if wgt.sum() <= 0:
            break
        nx_, ny_ = float((wgt * xx).sum() / wgt.sum()), float((wgt * yy).sum() / wgt.sum())
        done = math.hypot(nx_ - cx, ny_ - cy) < 1e-3
        cx, cy = nx_, ny_
        if done:
            break
    if math.hypot(cx - x0, cy - y0) > 1.5:
        return float(x0), float(y0)
    return cx, cy


def detect(img: np.ndarray, noise: np.ndarray, snr_min: float = 5.0, max_sources: int = 400):
    """Local maxima of (img - local background) / noise (FITS orientation), Gaussian-weighted centroids.
    Returns (detections in pixel coords, S/N map, background-subtracted image)."""
    from scipy.ndimage import maximum_filter, median_filter

    filled, holes = _fill_nan_cores(img)
    nz, _ = _fill_nan_cores(noise)
    with np.errstate(invalid="ignore", divide="ignore"):
        bkg = median_filter(np.nan_to_num(filled, nan=float(np.nanmedian(filled))), size=15)
        snr = (filled - bkg) / nz
    s = np.nan_to_num(snr, nan=-np.inf)
    peaks = (s == maximum_filter(s, size=5)) & (s >= snr_min)
    h, w = img.shape
    ys, xs = np.nonzero(peaks)
    order = np.argsort(-s[ys, xs])[:max_sources]
    sub = np.clip(np.nan_to_num(filled - bkg), 0, None)
    out = []
    for k in order:
        y0, x0 = int(ys[k]), int(xs[k])
        if not (3 <= x0 < w - 3 and 3 <= y0 < h - 3):
            continue
        cx, cy = _centroid(sub, x0, y0)
        out.append({"x": cx, "y": cy, "snr": float(s[y0, x0]), "saturated": bool(holes[y0 - 1:y0 + 2, x0 - 1:x0 + 2].any())})
    return out, s, sub


def _tangent(ra0, dec0, ra, dec):
    from .motion import tangent_offsets_mas
    xi, eta = tangent_offsets_mas(ra0, dec0, ra, dec)
    return np.asarray(xi) / 1000.0, np.asarray(eta) / 1000.0   # arcsec


def _fit(t, xi, eta, err):
    """Weighted linear fit per axis. Returns (x0, y0, vx, vy, cov_v (2x2 diag), chi2, dof)."""
    w = 1 / err ** 2
    A = np.c_[np.ones_like(t), t]
    cov = np.linalg.pinv(A.T @ (A * w[:, None]))
    bx, by = cov @ (A.T @ (w * xi)), cov @ (A.T @ (w * eta))
    chi2 = float((w * (xi - A @ bx) ** 2).sum() + (w * (eta - A @ by) ** 2).sum())
    dof = 2 * len(t) - 4
    return bx, by, cov, chi2, dof


from .motion import from_tangent_mas  # noqa: E402


def find_movers(frames: list[dict], arrays: list[np.ndarray], noise: list[np.ndarray], out_wcs, field: Optional[list[dict]],
                max_pm_arcsec_yr: float = 12.0, snr_min: float = 5.0, link_tol_arcsec: float = 4.0) -> dict:
    """frames: FramesResponse frame dicts (epoch_label, mjd_mean). arrays/noise: display orientation (row 0 = north)."""
    field = field or []
    npass = len(frames)
    ra0, dec0 = (float(v) for v in out_wcs.wcs.crval)
    scale = abs(float(out_wcs.wcs.cdelt[1])) * 3600
    years = np.array([catalogs.mjd_to_year(f["mjd_mean"]) for f in frames])
    t_ref = float(years.mean())

    dets: list[list[dict]] = []
    reg, maps = [], []
    for f, a, n in zip(frames, arrays, noise):
        img, nz = a[::-1], n[::-1]   # FITS orientation for WCS
        qc = frame_astrometry(img, out_wcs, field, f["mjd_mean"]) if field else {"n_ref": 0}
        reg.append(qc)
        dra = qc.get("dra_arcsec") or 0.0
        ddec = qc.get("ddec_arcsec") or 0.0
        floor = max(qc.get("rms_arcsec") or 0.3, POS_FLOOR_ARCSEC)
        d, smap, sub = detect(img, nz, snr_min)
        maps.append((smap, sub, dra, ddec, floor))
        if d:
            ra, dec = out_wcs.all_pix2world([x["x"] for x in d], [x["y"] for x in d], 0)
            xi, eta = _tangent(ra0, dec0, ra, dec)
            for x, a_, b_ in zip(d, xi, eta):
                x["xi"], x["eta"] = float(a_) - dra, float(b_) - ddec       # registered onto Gaia
                x["err"] = math.hypot(PSF_SIGMA_ARCSEC / max(x["snr"], 1.0), floor)
        dets.append(d)

    out = {"n_passes": npass, "passes": [{"epoch_label": f["epoch_label"], "mjd_mean": f["mjd_mean"],
                                          "n_detections": len(d), "registration": r}
                                         for f, d, r in zip(frames, dets, reg)],
           "params": {"max_pm_arcsec_yr": max_pm_arcsec_yr, "snr_min": snr_min, "link_tol_arcsec": link_tol_arcsec,
                      "move_sigma": MOVE_SIGMA},
           "tracks": [], "candidates": [], "null_test": None,
           "note": None if npass >= 3 else "Fewer than 3 passes: motion cannot be confirmed, no candidates are reported."}
    if npass < 2:
        return out

    # ---- link: hypotheses from any two passes; every other pass needs a detection on the line, or a forced
    #      >= FORCED_SNR peak there (faint passes, e.g. WISE 0855's 3-exposure E1)
    arr = [np.array([[x["xi"], x["eta"]] for x in d]) if d else np.zeros((0, 2)) for d in dets]

    def forced(k, xi, eta):
        smap, sub, dra, ddec, floor = maps[k]
        ra, dec = from_tangent_mas(ra0, dec0, (xi + dra) * 1000, (eta + ddec) * 1000)
        x, y = (float(v) for v in out_wcs.all_world2pix(ra, dec, 0))
        h, w = smap.shape
        ix, iy = int(round(x)), int(round(y))
        if not (3 <= ix < w - 3 and 3 <= iy < h - 3):
            return None
        win = smap[iy - 1:iy + 2, ix - 1:ix + 2]
        if not np.isfinite(win).any() or win.max() < FORCED_SNR:
            return None
        dy, dx = np.unravel_index(int(np.nanargmax(win)), win.shape)
        cx, cy = _centroid(sub, ix + dx - 1, iy + dy - 1)
        r, d_ = out_wcs.all_pix2world(cx, cy, 0)
        a_, b_ = _tangent(ra0, dec0, r, d_)
        sn = float(win.max())
        return {"xi": float(a_) - dra, "eta": float(b_) - ddec, "snr": sn, "forced": True,
                "err": math.hypot(PSF_SIGMA_ARCSEC / sn, floor)}

    hyps = []
    for a in range(npass):
        for b in range(a + 1, npass):
            dt = years[b] - years[a]
            if dt <= 0.05 or not len(arr[a]) or not len(arr[b]):
                continue
            rmax = max_pm_arcsec_yr * dt + link_tol_arcsec
            for i in range(len(arr[a])):
                dist = np.hypot(*(arr[b] - arr[a][i]).T)
                for j in np.nonzero(dist <= rmax)[0]:
                    v = (arr[b][j] - arr[a][i]) / dt
                    members, pts, ok = [], [], True
                    for k in range(npass):
                        if k == a:
                            members.append((k, i)); pts.append(dets[k][i]); continue
                        if k == b:
                            members.append((k, int(j))); pts.append(dets[k][int(j)]); continue
                        pred = arr[a][i] + v * (years[k] - years[a])
                        if len(arr[k]):
                            dk = np.hypot(*(arr[k] - pred).T)
                            m = int(np.argmin(dk))
                            if dk[m] <= link_tol_arcsec + 3 * dets[k][m]["err"]:
                                members.append((k, m)); pts.append(dets[k][m]); continue
                        f = forced(k, *pred)
                        if f is not None and math.hypot(f["xi"] - pred[0], f["eta"] - pred[1]) <= link_tol_arcsec + 3 * f["err"]:
                            members.append((k, None)); pts.append(f); continue
                        ok = False
                        break
                    if not ok:
                        continue
                    t = years - t_ref
                    bx, by, cov, chi2, dof = _fit(t, np.array([p["xi"] for p in pts]), np.array([p["eta"] for p in pts]),
                                                  np.array([p["err"] for p in pts]))
                    nforced = sum(1 for _, m in members if m is None)
                    hyps.append((nforced, chi2 / max(dof, 1) if dof > 0 else 0.0, -min(p["snr"] for p in pts),
                                 members, pts, bx, by, cov, chi2, dof))
    hyps.sort(key=lambda h: (h[0], h[1], h[2]))
    used: set[tuple[int, int]] = set()
    tracks = []
    for nforced, red, _, members, pts, bx, by, cov, chi2, dof in hyps:
        real = [m for m in members if m[1] is not None]
        if any(m in used for m in real):
            continue
        if dof > 0 and red > 25.0:
            continue
        used.update(real)
        s_ = math.sqrt(max(1.0, red)) if dof > 0 else 1.0
        e = math.sqrt(cov[1, 1]) * s_
        pmra, pmdec = float(bx[1]) * 1000, float(by[1]) * 1000        # mas/yr (xi includes cos dec)
        mu = math.hypot(pmra, pmdec)
        tracks.append({"members": members, "pmra": pmra, "pmdec": pmdec, "pm_err": e * 1000, "pm": mu,
                       "pm_sigma": mu / (e * 1000) if e > 0 else 0.0, "chi2_dof": round(red, 3) if dof > 0 else None,
                       "snr_min": min(p["snr"] for p in pts), "pts": pts, "n_forced": nforced,
                       "saturated": any(p.get("saturated") for p in pts)})

    # ---- classify against Gaia
    gaia_at = []
    for k, f in enumerate(frames):
        yr = years[k]
        g = []
        for row in field:
            if row.get("pmra") is not None:
                ra, dec = catalogs.propagate(row["ra"], row["dec"], row["pmra"], row["pmdec"], catalogs.GAIA_EPOCH, yr)
            else:
                ra, dec = row["ra"], row["dec"]
            g.append((ra, dec))
        if g:
            xi, eta = _tangent(ra0, dec0, [a for a, _ in g], [b for _, b in g])
            gaia_at.append(np.c_[xi, eta])
        else:
            gaia_at.append(np.zeros((0, 2)))
    pulls, dpm = [], []
    for n, tr in enumerate(tracks):
        gid = None
        if field:
            votes: dict[int, int] = {}
            for (k, m), p in zip(tr["members"], tr["pts"]):
                d = np.hypot(*(gaia_at[k] - [p["xi"], p["eta"]]).T)
                if len(d) and d.min() <= SEP_GAIA_ARCSEC + 2 * p["err"]:
                    votes[int(np.argmin(d))] = votes.get(int(np.argmin(d)), 0) + 1
            best = max(votes.items(), key=lambda kv: kv[1]) if votes else None
            if best and best[1] == npass:
                gid = best[0]
        moving = tr["pm_sigma"] >= MOVE_SIGMA
        g = field[gid] if gid is not None else None
        if g is not None and g.get("pmra") is not None:
            gp = (float(g["pmra"]), float(g["pmdec"]))
            pull = ((tr["pmra"] - gp[0]) / tr["pm_err"], (tr["pmdec"] - gp[1]) / tr["pm_err"])
            pulls.append(pull)
            dpm.append((tr["pmra"] - gp[0], tr["pmdec"] - gp[1]))
            gmu = math.hypot(*gp)
            mismatch = math.hypot(*pull) / math.sqrt(2) > MOVE_SIGMA
            status = "gaia_pm_mismatch" if mismatch else ("known_mover" if gmu / tr["pm_err"] >= MOVE_SIGMA else "stationary")
        elif g is not None:
            status = "known_mover" if moving else "stationary"     # Gaia 2-parameter source: no PM to compare
        else:
            status = "candidate" if (moving and npass >= 3) else ("stationary" if not moving else "unconfirmed_mover")
        mid = tr["pts"][len(tr["pts"]) // 2]
        ra_m, dec_m = from_tangent_mas(ra0, dec0, mid["xi"] * 1000, mid["eta"] * 1000)
        entry = {"id": f"T{n + 1:03d}", "status": status, "ra": round(float(ra_m), 6), "dec": round(float(dec_m), 6),
                 "pmra": round(tr["pmra"], 1), "pmdec": round(tr["pmdec"], 1), "pm": round(tr["pm"], 1),
                 "pm_err": round(tr["pm_err"], 1), "pm_sigma": round(tr["pm_sigma"], 2), "chi2_dof": tr["chi2_dof"],
                 "snr_min": round(tr["snr_min"], 1), "n_forced": tr["n_forced"], "saturated": tr["saturated"],
                 "gaia": None if g is None else {"id": g["id"], "pmra": g.get("pmra"), "pmdec": g.get("pmdec"), "mag": g.get("mag")},
                 "passes": []}
        for (k, m), p in zip(tr["members"], tr["pts"]):
            r, d = from_tangent_mas(ra0, dec0, p["xi"] * 1000, p["eta"] * 1000)
            entry["passes"].append({"epoch_label": frames[k]["epoch_label"], "ra": round(float(r), 6),
                                    "dec": round(float(d), 6), "snr": round(p["snr"], 1), "err_arcsec": round(p["err"], 3),
                                    "forced": bool(p.get("forced"))})
        out["tracks"].append(entry)
    # Saturated stars throw secondary peaks (bloom, halo, PSF wings) that can link into a fake "mover" a few
    # arcsec from the star. A candidate that sits within ARTEFACT_RADIUS (every pass) of a >= 20x brighter track,
    # or that is itself saturated next to a similarly bright Gaia-matched track (a split saturated core), is
    # relabelled, not reported. Anything bright enough to saturate SPHEREx and real would be in Gaia anyway.
    for t in out["tracks"]:
        if t["status"] != "candidate":
            continue
        for o in out["tracks"]:
            if o is t:
                continue
            brighter = o["snr_min"] >= 20 * t["snr_min"]
            split_core = t["saturated"] and o["gaia"] is not None and o["snr_min"] >= 0.3 * t["snr_min"]
            if not (brighter or split_core):
                continue
            close = all(math.hypot((a["ra"] - b["ra"]) * math.cos(math.radians(a["dec"])), a["dec"] - b["dec"]) * 3600
                        <= ARTEFACT_RADIUS_ARCSEC for a, b in zip(t["passes"], o["passes"]))
            if close:
                t["status"] = "artefact_near_bright_star"
                t["near"] = o["id"]
                break
        if t["status"] == "candidate" and (t["saturated"] or t["snr_min"] >= BRIGHT_SNR):
            # saturated star whose own track failed to match Gaia (e.g. a Mira's distorted core)
            yr = float(years.mean())
            for row in field:
                if (row.get("mag") or 99) >= BRIGHT_GAIA_MAG:
                    continue
                gra, gdec = (catalogs.propagate(row["ra"], row["dec"], row["pmra"], row["pmdec"], catalogs.GAIA_EPOCH, yr)
                             if row.get("pmra") is not None else (row["ra"], row["dec"]))
                if math.hypot((gra - t["ra"]) * math.cos(math.radians(t["dec"])), gdec - t["dec"]) * 3600 <= 20.0:
                    t["status"] = "artefact_near_bright_star"
                    t["near"] = row["id"]
                    break
    out["tracks"].sort(key=lambda t: ({"candidate": 0, "gaia_pm_mismatch": 1, "known_mover": 2, "unconfirmed_mover": 3,
                                       "artefact_near_bright_star": 4, "stationary": 5}[t["status"]], -t["pm_sigma"]))
    out["candidates"] = [t["id"] for t in out["tracks"] if t["status"] == "candidate"]
    if len(pulls) >= 5:
        P, D = np.array(pulls), np.array(dpm)
        rs = lambda v: float(1.4826 * np.median(np.abs(v - np.median(v))))   # noqa: E731
        out["null_test"] = {"n": len(P), "pull_median": [round(float(np.median(P[:, 0])), 2), round(float(np.median(P[:, 1])), 2)],
                            "pull_robust_std": [round(rs(P[:, 0]), 2), round(rs(P[:, 1]), 2)],
                            "dpm_median_mas_yr": [round(float(np.median(D[:, 0])), 1), round(float(np.median(D[:, 1])), 1)],
                            "dpm_robust_std_mas_yr": [round(rs(D[:, 0]), 1), round(rs(D[:, 1]), 1)],
                            "note": "Gaia-matched field sources: (SPHEREx - Gaia) PM / error. Unit robust std = honest errors."}
    out["pixel_scale_arcsec"] = scale
    return out
