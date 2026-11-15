"""Data-release bookkeeping: what the server is built from, and whether the archive has more. Owner: A.

* `summary()`: releases, collections, and the time span of the pointing index (no network). Served at /api/meta,
  so the UI can say "SPHEREx data through <date>".
* `check()`: fresh S3 listings: release folders not in config, and week folders in configured releases that
  are newer than the index. Used by scripts/check_releases.py (weekly GitHub Action) and /api/meta?check=1.

A new release = add it to config archive.s3_releases (+ collections), bump release_tag, rebuild the index
(scripts/build_coarse_index.py), redeploy, re-run scripts/precompute.py. Cached products are keyed by
release_tag + index fingerprint, so nothing stale is served.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from . import s3_archive
from .config import get_config

RELEASE_RE = re.compile(r"^(dr|qr)\d+/$")
WEEK_RE = re.compile(r"(\d{4})W(\d{2})_")


def mjd_to_iso(mjd: float) -> str:
    return (datetime(1858, 11, 17, tzinfo=timezone.utc) + timedelta(days=float(mjd))).strftime("%Y-%m-%d")


def _week(folder: str) -> tuple[int, int]:
    m = WEEK_RE.search(folder)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def summary() -> dict:
    cfg = get_config()
    arch = cfg["archive"]
    out = {"release_tag": cfg["release_tag"], "collections": arch["collections"], "s3_releases": arch["s3_releases"],
           "detectors": {d: {"lam_min_um": lo, "lam_max_um": hi} for d, (lo, hi) in cfg["bands"].items()},
           "n_channels": 6 * cfg["channels_per_detector"], "image_unit": cfg["image_unit"], "index": None}
    try:
        idx = s3_archive.load_coarse_index()
    except s3_archive.S3Error:
        return out
    mjds = [x["mjd"] for x in idx["samples"]]
    folders = sorted({x["folder"] for x in idx["samples"]}, key=_week)
    out["index"] = {"version": idx.get("version", 1), "n_observations": len(mjds),
                    "first_mjd": round(min(mjds), 4), "last_mjd": round(max(mjds), 4),
                    "data_from": mjd_to_iso(min(mjds)), "data_through": mjd_to_iso(max(mjds)),
                    "first_week": folders[0], "last_week": folders[-1], "n_week_folders": len(folders)}
    return out


def check() -> dict:
    """Live S3 listings. Raises s3_archive.S3Error when the mirror is unreachable."""
    arch = get_config()["archive"]
    known = set(arch["s3_releases"]) | set(arch.get("s3_superseded", []))
    _, top = s3_archive.list_prefix("", fresh=True)
    new_releases = sorted(p.rstrip("/") for p in top if RELEASE_RE.match(p) and p.rstrip("/") not in known)
    s = summary()
    last = _week(s["index"]["last_week"]) if s["index"] else (0, 0)
    latest, new_weeks = None, []
    for rel in arch["s3_releases"]:
        for f in s3_archive.list_prefix(f"{rel}/level2/", fresh=True)[1]:
            w = _week(f)
            latest = max(latest or w, w)
            if w > last:
                new_weeks.append(f)
    fmt = lambda w: f"{w[0]}W{w[1]:02d}" if w else None   # noqa: E731
    return {"new_releases": new_releases, "new_week_folders": sorted(new_weeks, key=_week),
            "index_last_week": fmt(last) if s["index"] else None, "archive_last_week": fmt(latest),
            "up_to_date": not new_releases and not new_weeks}
