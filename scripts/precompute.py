"""Bake the five test targets into frontend/precomputed/<slug>/ (issue #17).

Each folder gets resolve.json, frames.json (+ one float32 .bin per frame), overlay.json, exposures.json in the exact
shapes of docs/API.md, so the frontend can run with the backend down. Endpoints that aren't
built yet are skipped with a note. Keep the total small; check with `du -sh frontend/precomputed`.

    python scripts/precompute.py                    # all targets, everything
    python scripts/precompute.py r-dra              # one target
    python scripts/precompute.py --science wise-0855  # only the science products (matched frames, cube, spectrum, ...)
    python scripts/precompute.py --science --only=frames_matched   # just one kind, every target
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from backend import catalogs, pipeline, server  # noqa: E402

OUT = ROOT / "frontend" / "precomputed"

# Must match PRESETS in frontend/js/app.js. Positions come from catalogs.resolve_name (Sesame + PM).
TARGETS = {
    "barnards-star": {"name": "Barnard's Star", "band": "D2", "fov": 0.1,
                      # saturated in every detector; D5+D6 wing fits give 2-3x smaller PM errors than D2/D3
                      "science": {"frames_matched": "D2", "motion": "D5,D6", "spectrum": "D2", "cube": "D2",
                                  "movers": "D2", "stack": "D5"}},
    "eps-indi-b": {"name": "eps Indi B", "band": "D3", "fov": 0.1,
                   "science": {"frames_matched": "D3", "motion": "D3", "spectrum": "D3", "cube": "D3",
                               "movers": "D3", "stack": "D3"}},
    "wise-0855": {"name": "WISE J085510.83-071442.5", "band": "D6", "fov": 0.1,
                  # D3-D5 cubes + det=all spectrum: dark below 3.8 um, appears through D5 (Y dwarf)
                  "science": {"frames_matched": "D6", "motion": "D6", "spectrum": ["D6", "all"],
                              "cube": ["D3", "D4", "D5", "D6"], "cube_per_pass": "D6", "movers": "D6", "stack": "D6"}},
    "rw-aur": {"name": "RW Aur", "band": "D2", "fov": 0.1,
               "science": {"frames_matched": "D2", "lightcurve": "D2", "spectrum": "D2", "cube": "D2", "movers": "D2"}},
    "r-dra": {"name": "R Dra", "band": "D2", "fov": 0.1,
              "science": {"frames_matched": "D2", "lightcurve": "D2", "spectrum": "D2", "movers": "D2"}},
}
CLIENT = TestClient(server.app)


def get(path: str, **params) -> dict:
    r = CLIENT.get(path, params=params)
    if r.status_code != 200:
        raise RuntimeError(f"{path} {params}: {r.status_code} {r.text[:300]}")
    return r.json()


def bake_science(slug: str, t: dict, only: set | None = None) -> None:
    """Items 1, 3-5, through the real endpoints (exact API shapes). Cube blobs become local .bin files."""
    d = OUT / slug
    pos = json.loads((d / "resolve.json").read_text()) if (d / "resolve.json").exists() else catalogs.resolve_name(t["name"])
    base = {"ra": pos["ra"], "dec": pos["dec"], "epoch": pos["epoch"]}
    if pos.get("pmra") is not None:
        base.update(pmra=pos["pmra"], pmdec=pos["pmdec"])
    sci = t.get("science", {})
    jobs = [(k, d) for k, v in sci.items() for d in ([v] if isinstance(v, str) else v)]
    for kind, det in jobs:
        if only and kind not in only:
            continue
        print(f"  {kind} {det} ...", flush=True)
        try:
            if kind == "frames_matched":
                body = get("/api/frames", band=det, fov=t["fov"], matched=1, ra=pos["ra"], dec=pos["dec"])
                localize_frames(body, d, slug, f"{det}_matched")
                print(f"    channels {body['matched_channels']}; lam_eff "
                      f"{[f['lam_eff_um'] for f in body['frames']]}")
                dump(d / f"frames_matched_{det}.json", body)
            elif kind == "movers":
                body = get("/api/movers", band=det, fov=t["fov"], ra=pos["ra"], dec=pos["dec"])
                from collections import Counter
                print(f"    tracks {dict(Counter(x['status'] for x in body['tracks']))}; candidates {body['candidates']}; "
                      f"null test {body['null_test'] and body['null_test']['pull_robust_std']}")
                dump(d / f"movers_{det}.json", body)
            elif kind == "stack":
                q = {k: v for k, v in base.items()}
                body = get("/api/stack", band=det, fov=t["fov"], **q)
                for which in ("static", "comoving"):
                    name = f"stack_{det}_{which}.bin"
                    (d / name).write_bytes(CLIENT.get(body[which]["data"]).content)
                    body[which]["data"] = f"precomputed/{slug}/{name}"
                print(f"    target S/N static {body['static']['target_snr']} -> co-moving {body['comoving']['target_snr']}")
                dump(d / f"stack_{det}.json", body)
            elif kind == "motion":
                body = get("/api/motion", det=det, **base)
                f = body["fit"]
                ref = body["gaia"] or body["catalog"] or {}
                print(f"    mu = {f['pm_total']:.0f} +- {f['pm_total_err']:.0f} mas/yr, PA {f['pa_deg']:.1f}; "
                      f"catalogue {ref.get('pm_total')} ({ref.get('pm_sigma_diff')} sigma)")
                dump(d / f"motion_{det.replace(',', '-')}.json", body)
            elif kind == "spectrum":
                dump(d / f"spectrum_{det}.json", get("/api/spectrum", det=det, compare="E1", **base))
            elif kind == "lightcurve":
                body = get("/api/lightcurve", det=det, **base)
                print(f"    bins {[b['scale'] for b in body['bins']]}  chi2 {body['chi2_constant']}/{body['dof']}  "
                      f"comparison rms {(body['comparison_stars'] or {}).get('rms_scale')}")
                dump(d / f"lightcurve_{det}.json", body)
            elif kind.startswith("cube"):
                per_pass = kind == "cube_per_pass"
                q = {k: v for k, v in base.items() if k != "epoch"}
                body = get("/api/cube", det=det, fov=t["fov"], per_pass=int(per_pass), **q)
                tag = f"cube{'_pp' if per_pass else ''}_{det}"
                for c in body["channels"]:
                    for item in c.get("frames") or [c]:
                        url = item["data"]
                        name = f"{tag}_{c['channel']}{'_' + item['epoch_label'] if per_pass else ''}.bin"
                        (d / name).write_bytes(CLIENT.get(url).content)
                        item["data"] = f"precomputed/{slug}/{name}"
                dump(d / f"{tag}.json", body)
        except Exception as e:  # noqa: BLE001 - one failed product must not stop the other targets
            print(f"    skipped: {type(e).__name__}: {str(e)[:300]}")


def localize_frames(body: dict, d: Path, slug: str, tag: str) -> None:
    """Download each frame's data (and noise) blob next to the JSON and point the URLs at the local files."""
    for f in body["frames"]:
        for key, suffix in (("data", ""), ("noise", "_noise")):
            if not f.get(key):
                continue
            name = f"{f['epoch_label']}_{tag}{suffix}.bin"
            (d / name).write_bytes(CLIENT.get(f[key]).content)
            f[key] = f"precomputed/{slug}/{name}"   # relative to the frontend root


def dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")))
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


def bake(slug: str, t: dict) -> None:
    print(slug)
    d = OUT / slug
    try:
        pos = catalogs.resolve_name(t["name"])
    except catalogs.ResolverUnavailable as e:
        if not (d / "resolve.json").exists():
            raise
        print(f"  resolver down ({str(e)[:80]}...): keeping the existing resolve.json")
        pos = json.loads((d / "resolve.json").read_text())
    dump(d / "resolve.json", pos)
    ra, dec, fov = pos["ra"], pos["dec"], t["fov"]
    meta = get("/api/frames", ra=ra, dec=dec, fov=fov, band=t["band"])   # same shapes as the live API (noise, QC)
    for stale in d.glob(f"E*_{t['band']}.bin"):
        stale.unlink()                                                  # pass labels can change (e.g. R Dra)
    localize_frames(meta, d, slug, t["band"])
    print(f"  frames {[f['epoch_label'] for f in meta['frames']]}; astrometry rms "
          f"{[f.get('astrometry_rms_arcsec') for f in meta['frames']]}")
    dump(d / "frames.json", meta)
    dump(d / "overlay.json", server.overlay(ra=ra, dec=dec, fov=fov, cat="gaia"))
    dump(d / "exposures.json", server.exposures(ra=ra, dec=dec, fov=fov))
    bake_science(slug, t)


if __name__ == "__main__":
    args = sys.argv[1:]
    science_only = "--science" in args
    only = {k for a in args if a.startswith("--only=") for k in a.split("=", 1)[1].split(",")} or None
    wanted = [a for a in args if not a.startswith("--")] or list(TARGETS)
    for slug in wanted:
        if science_only:
            print(slug)
            bake_science(slug, TARGETS[slug], only)
        else:
            bake(slug, TARGETS[slug])
