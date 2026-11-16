"""Thumbnails for the picker's example cards: the first pass of each test target's saved frames.

    python scripts/make_thumbs.py      (writes frontend/img/thumbs/<slug>.png)
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "frontend"
PRESETS = {"barnards-star": "D2", "eps-indi-b": "D3", "wise-0855": "D6", "rw-aur": "D2", "r-dra": "D2"}

for slug, band in PRESETS.items():
    meta = json.loads((ROOT / "precomputed" / slug / f"frames_matched_{band}.json").read_text())
    w, h = meta["wcs"]["width"], meta["wcs"]["height"]
    f = meta["frames"][0]
    a = np.fromfile(ROOT / f["data"], dtype="<f4").reshape(h, w)
    good = a[np.isfinite(a)]
    lo, hi = np.percentile(good, 0.5), np.percentile(good, 99.5)
    t = np.clip((a - lo) / max(hi - lo, 1e-12), 0, 1)
    t = np.arcsinh(t / 0.1) / np.arcsinh(1 / 0.1)
    img = np.where(np.isfinite(a), t * 255, 42).astype(np.uint8)   # no data: the --nodata grey
    out = ROOT / "img" / "thumbs" / f"{slug}.png"
    Image.fromarray(img, "L").save(out, optimize=True)
    print(out.relative_to(ROOT), out.stat().st_size, "bytes")
