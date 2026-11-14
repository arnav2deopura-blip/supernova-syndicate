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
