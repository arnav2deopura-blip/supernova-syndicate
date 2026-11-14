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
                      ("spectrum", spectrum), ("overlay", overlay)]:
        (OUT / f"{name}.json").write_text(json.dumps(obj, separators=(",", ":")))
        print("wrote", OUT / f"{name}.json")


if __name__ == "__main__":
    main()
