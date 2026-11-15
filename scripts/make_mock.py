"""Generate fake API responses in frontend/mock/ that match docs/API.md.

Fake data only: a synthetic "fast mover" drifting across three epochs plus a few
static stars and one variable, so the frontend can be built before the backend.

    python scripts/make_mock.py
"""
import json
import math
import random
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "frontend" / "mock"
RA, DEC = 269.4486, 4.7394
SIZE = 48
SCALE = 3.075  # arcsec / px (2x oversampled SPHEREx)
FOV = round(SIZE * SCALE / 3600, 4)
EPOCHS = [("E1", 60810.2, 60824.9, 12), ("E2", 60993.1, 61007.6, 11), ("E3", 61176.0, 61190.3, 13)]

random.seed(42)
STATIC = [(10, 12, 40), (35, 8, 25), (30, 38, 60), (6, 30, 15)]
MOVER_START = (20.0, 26.0)  # x, y in pixels at E1
MOVER_STEP = (-0.15, -1.6)  # px per epoch (north is up, so dec increase = smaller y)
VARIABLE = (40, 22)


def gaussian(img, x0, y0, amp, sigma=1.3):
    for y in range(SIZE):
        for x in range(SIZE):
            img[y][x] += amp * math.exp(-((x - x0) ** 2 + (y - y0) ** 2) / (2 * sigma**2))


def make_frame(i):
    img = [[random.gauss(0, 0.6) for _ in range(SIZE)] for _ in range(SIZE)]
    for x, y, a in STATIC:
        gaussian(img, x, y, a)
    gaussian(img, MOVER_START[0] + MOVER_STEP[0] * i, MOVER_START[1] + MOVER_STEP[1] * i, 80)
    gaussian(img, *VARIABLE, [20, 45, 28][i])
    flat = [round(v, 3) for row in img for v in row]
    flat[5] = None  # one masked pixel, to exercise null handling
    return flat


def pix_to_sky(x, y):
    dra = -(x - SIZE / 2) * SCALE / 3600 / math.cos(math.radians(DEC))
    ddec = -(y - SIZE / 2) * SCALE / 3600
    return round(RA + dra, 6), round(DEC + ddec, 6)


def make_cube():
    """17 channels of D6, all passes stacked; the mover brightens toward long wavelengths."""
    rng = random.Random(7)
    chans = []
    for k in range(17):
        lam = round(4.435 + 0.0345 * k, 3)
        img = [[rng.gauss(0, 0.6) for _ in range(SIZE)] for _ in range(SIZE)]
        for x, y, a in STATIC:
            gaussian(img, x, y, a * (1 - 0.02 * k))
        gaussian(img, *MOVER_START, 10 + 6 * k)
        flat = [round(v, 3) for row in img for v in row]
        chans.append({"channel": f"D6C{k + 1:02d}", "subchan": k + 1, "lam_um": lam, "lam_min": round(lam - 0.017, 3),
                      "lam_max": round(lam + 0.017, 3), "R": 128.0, "n_exposures": 2 + k % 3, "data": flat,
                      "coverage": 1.0, "lam_target_um": round(lam + 0.004, 4), "mjd_mean": 61000.0 + 30 * (k % 3),
                      "passes": ["E1", "E3"] if k % 2 else ["E2", "E3"], "target_value": round(0.05 + 0.03 * k, 4),
                      "target_flags": [], "obs_ids": [f"MOCK_{k}_a", f"MOCK_{k}_b"]})
    return {"ra": RA, "dec": DEC, "fov": FOV, "det": "D6", "units": "MJy/sr", "release": "mock",
            "wcs": {"center_ra": RA, "center_dec": DEC, "pixel_scale_arcsec": SCALE, "width": SIZE, "height": SIZE},
            "per_pass": False, "strict": False, "channel_at": "field_centre", "display_range": [-1.0, 60.0],
            "fast_movers": [{"id": "Mock mover", "pm_mas_yr": 10393.3}], "recommend_per_pass": True, "n_stamps": 51,
            "channels": chans}


def make_lightcurve():
    """Template-method light curve: a +30% brightening by the third pass, quiet comparison stars."""
    rng = random.Random(11)
    scales = [0.89, 1.13, 1.14]
    points, bins = [], []
    for (lab, s, e, n), sc in zip(EPOCHS, scales):
        mj = []
        for k in range(n):
            lam = round(1.10 + 0.54 * k / (n - 1), 4)
            mjd = round(s + (e - s) * k / n, 4)
            mj.append(mjd)
            f = 3.0e5 * lam ** -1.5 * sc
            points.append({"obs_id": f"MOCK_{lab}_{k}", "detector": 2, "mjd": mjd, "lam_um": lam, "bw_um": 0.03,
                           "channel": f"D2C{min(17, 1 + int((lam - 1.10) / 0.032)):02d}", "flux": round(f, 1),
                           "flux_err": round(0.03 * f, 1), "flux_ap": None, "x": 44.0, "y": 44.0, "x_pred": 44.0,
                           "y_pred": 44.0, "x_err": 0.03, "y_err": 0.03, "fit": "wing", "chi2r": 9.0, "flagged": True,
                           "flags": ["OVERFLOW"], "epoch_label": lab, "blend": [], "snr": 30.0,
                           "scale": round(sc * (1 + rng.gauss(0, 0.02)), 4), "scale_err": 0.035, "used": True})
        bins.append({"mjd": round(sum(mj) / len(mj), 4), "mjd_start": mj[0], "mjd_end": mj[-1], "scale": sc,
                     "scale_err": 0.02, "n": n, "lam_min": 1.10, "lam_max": 1.64, "label": lab})
    return {"ra": RA, "dec": DEC, "det": "D2", "method": "template", "units": "uJy", "bin_days": 15.0,
            "systematic_floor": 0.02, "track": {"ra": RA, "dec": DEC, "epoch": 2016.0, "pmra": 7.2, "pmdec": -20.3,
                                                "source": "gaia_dr3", "gaia_id": "Gaia DR3 0"},
            "used_flagged": True, "n_points": len(points), "n_used": len(points),
            "template": [{"detector": 2, "lam_um": round(1.113 + 0.0325 * k, 4), "flux": round(3.0e5 * (1.113 + 0.0325 * k) ** -1.5, 1)}
                         for k in range(17)],
            "points": points, "bins": bins, "chi2_constant": 93.3, "dof": 2, "variable": True, "reliable": True, "median_frac_err": 0.097,
            "shape_changed": False,
            "bin_slopes": [], "comparison_stars": {"n": 2, "rms_scale": 0.0126, "stars": [
                {"id": "Mock 0", "mag_g": 12.6, "median_flux": 27692.6, "n": 54, "chi2_constant": 2.1, "dof": 2,
                 "bins": [{"mjd": b["mjd"], "scale": 1.0, "scale_err": 0.01} for b in bins]},
                {"id": "Mock 1", "mag_g": 14.8, "median_flux": 6734.1, "n": 54, "chi2_constant": 1.4, "dof": 2,
                 "bins": [{"mjd": b["mjd"], "scale": 1.0, "scale_err": 0.012} for b in bins]}]},
            "note": "Most points are saturated-core wing fits; scales are less precise. "
                    "Prefer a longer-wavelength detector where the star is not saturated."}


def make_motion():
    """Barnard-like mover: per-pass positions and a fit consistent with Gaia."""
    exposures, passes = [], []
    for i, (lab, s, e, n) in enumerate(EPOCHS):
        ra, dec = pix_to_sky(MOVER_START[0] + MOVER_STEP[0] * i, MOVER_START[1] + MOVER_STEP[1] * i)
        for k in range(3):
            exposures.append({"obs_id": f"MOCK_{lab}_{k}", "det": 2, "mjd": s + k, "label": lab, "lam_um": 1.2 + 0.1 * k,
                              "fit": "wing", "flags": ["OVERFLOW"], "snr": 25.0, "used": True, "ra": ra, "dec": dec,
                              "err_mas": 900.0, "x": 44.0, "y": 44.0, "reg_dx_px": 0.05, "reg_dy_px": -0.03,
                              "reg_rms_px": 0.04, "n_ref": 5, "reg_model": "shift", "resid_xi_mas": 0.0, "resid_eta_mas": 0.0})
        passes.append({"label": lab, "mjd": s + 1, "ra": ra, "dec": dec, "err_mas": 180.0, "n": n})
    return {"ra": RA, "dec": DEC, "det": "D2", "target": {"ra": RA, "dec": DEC, "mjd": 61000.0},
            "prior": {"source": "gaia_dr3", "pmra": -801.551, "pmdec": 10362.394}, "exposures": exposures,
            "passes": passes,
            "fit": {"t0": 2026.1, "ra0": RA, "dec0": DEC, "pos_err_mas": 90.0, "pmra": -790.0, "pmra_err": 120.0,
                    "pmdec": 10350.0, "pmdec_err": 115.0, "pm_corr": 0.05, "pm_total": 10380.1, "pm_total_err": 115.0,
                    "pa_deg": 355.6, "pa_err_deg": 0.7, "parallax_mode": "gaia_fixed", "parallax": 546.976,
                    "parallax_err": None, "chi2_dof": 1.3, "n": 9, "n_clipped": 0,
                    "bootstrap": {"pmra_err": 130.0, "pmdec_err": 120.0, "n": 200}},
            "units": {"pm": "mas/yr", "parallax": "mas", "position_err": "mas"},
            "gaia": {"catalog": "gaia_dr3", "pmra": -801.551, "pmdec": 10362.394, "pm_total": 10393.35, "pa_deg": 355.58,
                     "pmra_sigma_diff": 0.07, "pmdec_sigma_diff": -0.11, "pm_sigma_diff": 0.09, "chi2_2dof": 0.02,
                     "id": "Gaia DR3 4472832130942575872", "parallax": 546.976},
            "catalog": None}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    frames = {
        "ra": RA, "dec": DEC, "fov": FOV, "band": "D2",
        "wcs": {"center_ra": RA, "center_dec": DEC, "pixel_scale_arcsec": SCALE,
                "width": SIZE, "height": SIZE},
        "frames": [
            {"epoch_label": lab, "mjd_start": s, "mjd_end": e, "n_exposures": n,
             "width": SIZE, "height": SIZE, "data": make_frame(i), "flag_fraction": 0.02 + 0.01 * i}
            for i, (lab, s, e, n) in enumerate(EPOCHS)
        ],
    }
    resolve = {"name": "Mock Mover", "ra": RA, "dec": DEC, "epoch": 2026.0,
               "pmra": -801.551, "pmdec": 10362.394, "source": "mock"}
    exposures = {"exposures": [
        {"obs_id": f"MOCK_{lab}_{d}_{k}", "mjd": s + k, "detector": d,
         "wavelength_um": round([0.9, 1.3, 2.0, 3.1, 4.1, 4.7][d - 1] + 0.02 * k, 3),
         "epoch_label": lab, "flags_summary": {"flag_fraction": 0.02}, "url": "https://example.invalid/mock.fits"}
        for lab, s, _, _ in EPOCHS for d in range(1, 7) for k in range(2)
    ]}
    spectrum = {"ra": RA, "dec": DEC, "points": [
        {"wavelength_um": round(w, 3),
         "flux": round(3000 * w ** -1.5 * (1 + 0.05 * j) + random.gauss(0, 20), 1),
         "flux_err": 30.0, "epoch_label": lab, "flagged": False}
        for j, (lab, *_rest) in enumerate(EPOCHS) for w in [0.75 + 0.08 * k for k in range(54)]
    ]}
    sources = []
    for n, (x, y, a) in enumerate(STATIC):
        ra, dec = pix_to_sky(x, y)
        sources.append({"id": f"Mock {n}", "ra": ra, "dec": dec, "pmra": 0.0, "pmdec": 0.0,
                        "mag": round(15 - math.log10(a), 2),
                        "positions_by_epoch": [{"epoch_label": e[0], "ra": ra, "dec": dec} for e in EPOCHS]})
    pos = [pix_to_sky(MOVER_START[0] + MOVER_STEP[0] * i, MOVER_START[1] + MOVER_STEP[1] * i)
           for i in range(len(EPOCHS))]
    sources.append({"id": "Mock mover", "ra": pos[0][0], "dec": pos[0][1], "pmra": -801.551,
                    "pmdec": 10362.394, "mag": 8.19,
                    "positions_by_epoch": [{"epoch_label": e[0], "ra": p[0], "dec": p[1]}
                                           for e, p in zip(EPOCHS, pos)]})
    overlay = {"catalog": "gaia_dr3", "sources": sources}

    for name, obj in [("frames", frames), ("resolve", resolve), ("exposures", exposures),
                      ("spectrum", spectrum), ("overlay", overlay),
                      ("cube", make_cube()), ("lightcurve", make_lightcurve()), ("motion", make_motion())]:
        (OUT / f"{name}.json").write_text(json.dumps(obj, separators=(",", ":")))
        print("wrote", OUT / f"{name}.json")


if __name__ == "__main__":
    main()
