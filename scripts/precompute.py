"""Bake the five test targets into frontend/precomputed/<slug>/ (issue #16).

Each folder gets frames.json, overlay.json, spectrum.json, exposures.json in the
exact shapes of docs/API.md, so the frontend can run with the backend down.
Keep the total under ~5 MB; check with `du -sh frontend/precomputed`.

    python scripts/precompute.py            # all targets
    python scripts/precompute.py r-dra      # one target
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import server  # noqa: E402  (reuse the same route functions as the live API)

OUT = ROOT / "frontend" / "precomputed"

# Must match PRESETS in frontend/js/app.js. Positions should come from catalogs.resolve_name
# once issue #11 lands; these are approximate placeholders. [verify on SIMBAD]
TARGETS = {
    "barnards-star": {"name": "Barnard's Star", "band": "D2", "fov": 0.1},
    "eps-indi-b": {"name": "eps Indi B", "band": "D3", "fov": 0.1},
    "wise-0855": {"name": "WISE J085510.83-071442.5", "band": "D6", "fov": 0.1},
    "rw-aur": {"name": "RW Aur", "band": "D2", "fov": 0.1},
    "r-dra": {"name": "R Dra", "band": "D2", "fov": 0.1},
}


def dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if hasattr(obj, "model_dump"):
        obj = obj.model_dump()
    path.write_text(json.dumps(obj, separators=(",", ":")))
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


def bake(slug: str, t: dict) -> None:
    print(slug)
    pos = server.resolve(t["name"])
    ra, dec, fov = pos["ra"], pos["dec"], t["fov"]
    d = OUT / slug
    dump(d / "resolve.json", pos)
    dump(d / "frames.json", server.frames(ra=ra, dec=dec, fov=fov, band=t["band"]))
    dump(d / "overlay.json", server.overlay(ra=ra, dec=dec, fov=fov, cat="gaia"))
    dump(d / "exposures.json", server.exposures(ra=ra, dec=dec, fov=fov))
    dump(d / "spectrum.json", server.spectrum(ra=ra, dec=dec))


if __name__ == "__main__":
    wanted = sys.argv[1:] or list(TARGETS)
    for slug in wanted:
        bake(slug, TARGETS[slug])
