"""Disk cache keyed by ra/dec/fov/band/release. Owner: A."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional

from .config import get_config


_stripes = [threading.RLock() for _ in range(128)]
_pins_guard = threading.RLock()
_pins = {}

@contextmanager
def key_lock(key):
    # Bounded lock table; reentrant for nested product/download operations.
    lock = _stripes[int(hashlib.sha256(str(key).encode()).hexdigest()[:8], 16) % len(_stripes)]
    with lock:
        yield

def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.stem + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)

def atomic_fits(path, hdul):
    import io
    buffer = io.BytesIO()
    hdul.writeto(buffer)
    atomic_write(path, buffer.getvalue())

def lease(paths, seconds=900):
    with _pins_guard:
        now=time.time()
        for key in list(_pins):
            if _pins[key] < now: del _pins[key]
        until = now + seconds
        for path in paths:
            _pins[str(Path(path).resolve())] = until


def retain(paths, seconds=900):
    """Atomically verify dependencies and lease them against pruning."""
    with _pins_guard:
        if not all(Path(p).exists() for p in paths): return False
        lease(paths,seconds)
        return True


def cache_key(kind: str, ra: float, dec: float, fov: float, band: str = "", release: str = "") -> str:
    """Stable key. Coordinates are rounded so tiny float differences hit the same entry."""
    raw = f"{kind}|{ra:.5f}|{dec:.5f}|{fov:.4f}|{band}|{release}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _path(key: str, suffix: str, root: Optional[Path] = None) -> Path:
    root = Path(root or get_config()["cache"]["dir"])
    return root / key[:2] / f"{key}{suffix}"


def get_json(key: str, root: Optional[Path] = None) -> Optional[Any]:
    p = _path(key, ".json", root)
    try:
        value = json.loads(p.read_text())
        os.utime(p, None)
        return value
    except (OSError, ValueError):
        return None


def put_json(key: str, value: Any, root: Optional[Path] = None) -> None:
    p = _path(key, ".json", root)
    atomic_write(p, json.dumps(value, allow_nan=False).encode())


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
    protected = set()
    now = time.time()
    with _pins_guard:
        for key in list(_pins):
            if _pins[key] < now: del _pins[key]
        protected.update(_pins)
    def referenced(node):
        if isinstance(node, dict):
            for k,v in node.items():
                if k in ('blob','noise_blob','coverage_blob') and isinstance(v,str):
                    protected.add(str((root/'blobs'/f'{v}.bin').resolve()))
                else: referenced(v)
        elif isinstance(node,list):
            for v in node: referenced(v)
    for meta in root.rglob('*.json'):
        try: referenced(json.loads(meta.read_text()))
        except (OSError,ValueError): pass
    for p in root.rglob("*"):
        if p.is_file():
            try: st = p.stat()
            except OSError: continue
            files.append((st.st_mtime, st.st_size, p))
            total += st.st_size
    limit = max_mb * 1024 * 1024
    if total <= limit:
        return 0
    removed = 0
    for _, size, p in sorted(files):
        if total <= keep_fraction * limit:
            break
        if str(p.resolve()) in protected or p.suffix == '.tmp':
            continue
        with _pins_guard:
            if _pins.get(str(p.resolve()),0) > time.time(): continue
            try:
                p.unlink()
                total -= size
                removed += 1
            except OSError:
                pass
    return removed
