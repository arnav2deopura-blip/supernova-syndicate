"""Bake the five test targets into frontend/precomputed/<slug>/ (issue #17).

Each folder gets resolve.json, frames.json (+ one float32 .bin per frame), overlay.json, exposures.json in the exact
shapes of docs/API.md, so the frontend can run with the backend down. Endpoints that aren't
built yet are skipped with a note. Keep the total small; check with `du -sh frontend/precomputed`.

    python scripts/precompute.py            # all targets
    python scripts/precompute.py r-dra      # one target
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import catalogs, pipeline, server  # noqa: E402

OUT = ROOT / "frontend" / "precomputed"

# Must match PRESETS in frontend/js/app.js. Positions come from catalogs.resolve_name (Sesame + PM).
TARGETS = {
    "barnards-star": {"name": "Barnard's Star", "band": "D2", "fov": 0.1},
    "eps-indi-b": {"name": "eps Indi B", "band": "D3", "fov": 0.1},
    "wise-0855": {"name": "WISE J085510.83-071442.5", "band": "D6", "fov": 0.1},
    "rw-aur": {"name": "RW Aur", "band": "D2", "fov": 0.1},
    "r-dra": {"name": "R Dra", "band": "D2", "fov": 0.1},
}


def dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")))
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


def bake(slug: str, t: dict) -> None:
    print(slug)
    d = OUT / slug
    pos = catalogs.resolve_name(t["name"])
    dump(d / "resolve.json", pos)
    ra, dec, fov = pos["ra"], pos["dec"], t["fov"]
    product = pipeline.build_frames(ra, dec, fov, t["band"],
                                    progress=lambda s, i, n: print(f"\r  {s} {i}/{n}   ", end="", flush=True))
    print()
    meta = product.meta
    for f, arr in zip(meta["frames"], product.arrays):
        name = f"{f['epoch_label']}_{t['band']}.bin"
        (d / name).write_bytes(np.ascontiguousarray(arr, dtype="<f4").tobytes())
        f["data"] = f"precomputed/{slug}/{name}"  # relative to the frontend root
    dump(d / "frames.json", meta)
    dump(d / "overlay.json", server.overlay(ra=ra, dec=dec, fov=fov, cat="gaia"))
    dump(d / "exposures.json", server.exposures(ra=ra, dec=dec, fov=fov))
    # spectrum: added once /api/spectrum is built (phase 3)


if __name__ == "__main__":
    wanted = sys.argv[1:] or list(TARGETS)
    for slug in wanted:
        bake(slug, TARGETS[slug])
