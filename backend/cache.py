"""Disk cache keyed by ra/dec/fov/band/release. Owner: A."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional

from .config import get_config


def cache_key(kind: str, ra: float, dec: float, fov: float, band: str = "", release: str = "") -> str:
    """Stable key. Coordinates are rounded so tiny float differences hit the same entry."""
    raw = f"{kind}|{ra:.5f}|{dec:.5f}|{fov:.4f}|{band}|{release}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _path(key: str, suffix: str, root: Optional[Path] = None) -> Path:
    root = Path(root or get_config()["cache"]["dir"])
    return root / key[:2] / f"{key}{suffix}"


def get_json(key: str, root: Optional[Path] = None) -> Optional[Any]:
    p = _path(key, ".json", root)
    return json.loads(p.read_text()) if p.exists() else None


def put_json(key: str, value: Any, root: Optional[Path] = None) -> None:
    p = _path(key, ".json", root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(value))
    tmp.replace(p)  # atomic, so a crash never leaves half a file


def file_path(key: str, suffix: str = ".fits", root: Optional[Path] = None) -> Path:
    """Where a downloaded cutout for this key should live."""
    p = _path(key, suffix, root)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def prune(max_mb: Optional[float] = None, root: Optional[Path] = None, keep_fraction: float = 0.7) -> int:
    """Delete least-recently-modified cache files until the cache is under keep_fraction * max_mb.

    Needed on Cloud Run, where /tmp lives in the instance's memory. Returns the number of files removed.
    Small header/listing JSONs are evicted like everything else; they are cheap to refetch.
    """
    cfg = get_config()["cache"]
    max_mb = max_mb if max_mb is not None else cfg.get("max_mb")
    if not max_mb:
        return 0
    root = Path(root or cfg["dir"])
    if not root.exists():
        return 0
    files = []
    total = 0
    for p in root.rglob("*"):
        if p.is_file():
            st = p.stat()
            files.append((st.st_mtime, st.st_size, p))
            total += st.st_size
    limit = max_mb * 1024 * 1024
    if total <= limit:
        return 0
    removed = 0
    for _, size, p in sorted(files):
        if total <= keep_fraction * limit:
            break
        try:
            p.unlink()
            total -= size
            removed += 1
        except OSError:
            pass
    return removed
