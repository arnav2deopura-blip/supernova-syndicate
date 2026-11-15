"""Extract the SPHEREx spectral-channel table and CHANNEL_MAP into small files under backend/data/.

    python scripts/extract_channels.py [path/to/spectral_channels_spx_*.fits]

Without a path the file named by config archive.spectral_channels is downloaded from the S3 mirror.
Outputs (committed; both tiny):
  backend/data/spectral_channels.json   102 rows: detector, subchan, wavelength, wl_min, wl_max, R, bandwidth
  backend/data/channel_map.npy.gz       2040x2040 uint8, channel 1-17 per pixel, 0/18 = outside ("sky" coords)
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.config import get_config  # noqa: E402

OUT = ROOT / "backend" / "data"


def main(path: str | None) -> None:
    if path is None:
        cfg = get_config()["archive"]
        dest = Path(get_config()["cache"]["dir"]) / "calib" / "spectral_channels.fits"
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            r = requests.get(cfg["s3_http"] + cfg["spectral_channels"], timeout=120)
            r.raise_for_status()
            dest.write_bytes(r.content)
        path = str(dest)
    with fits.open(path) as h:
        t = h["SPECTRAL_CHANNELS"].data
        rows = [{"detector": int(r["DETECTOR"]), "subchan": int(r["SUBCHAN"]),
                 "wavelength": round(float(r["WAVELENGTH"]), 4), "wl_min": round(float(r["WL_MIN"]), 4),
                 "wl_max": round(float(r["WL_MAX"]), 4), "R": float(r["R"]),
                 "bandwidth": round(float(r["BANDWIDTH"]), 4)} for r in t]
        cmap = np.asarray(h["CHANNEL_MAP"].data, dtype=np.uint8)
        assert h["CHANNEL_MAP"].header.get("DETCOORD", "sky").strip() == "sky"
    OUT.mkdir(exist_ok=True)
    (OUT / "spectral_channels.json").write_text(json.dumps(
        {"source": get_config()["archive"]["spectral_channels"], "channels": rows}, indent=1))
    with gzip.open(OUT / "channel_map.npy.gz", "wb", compresslevel=9) as f:
        np.save(f, cmap)
    print(f"{len(rows)} channels; map {cmap.shape} -> {OUT}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
