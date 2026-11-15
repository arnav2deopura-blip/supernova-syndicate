"""Build backend/data/coarse_index.json.gz: sampled detector-1 pointings for every S3 week folder.

Lets the backend find SPHEREx coverage for any position without IRSA's TAP service.
Re-run after adding a release to config.yaml (archive.s3_releases). Takes a few minutes;
listings and headers are cached in data/cache, so a re-run only reads new folders.

    python scripts/build_coarse_index.py [every_nth_obs]     # 1 = complete; v2 stores orientation (PC)
"""
import gzip
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import s3_archive  # noqa: E402


def main():
    nth = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    t = time.time()
    idx = s3_archive.build_coarse_index(nth, progress=lambda s, i, n: print(f"\r{s} {i}/{n}  {time.time() - t:.0f}s", end="", flush=True))
    s3_archive.COARSE_INDEX.parent.mkdir(parents=True, exist_ok=True)
    # write next to the live index, then swap: a crash or a half-finished run never leaves a broken index
    tmp = s3_archive.COARSE_INDEX.with_suffix(".tmp")
    with gzip.open(tmp, "wt") as f:
        json.dump(idx, f, separators=(",", ":"))
    tmp.replace(s3_archive.COARSE_INDEX)
    print(f"\n{len(idx['samples'])} samples -> {s3_archive.COARSE_INDEX.relative_to(ROOT)} "
          f"({s3_archive.COARSE_INDEX.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
