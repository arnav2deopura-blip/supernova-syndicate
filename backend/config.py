"""Load config.yaml and environment variables. Owner: A."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml

CONFIG_PATH = Path(__file__).with_name("config.yaml")


@lru_cache
def get_config() -> dict:
    with CONFIG_PATH.open() as f:
        cfg = yaml.safe_load(f)
    cache_dir = Path(os.environ.get("SPHEREX_CACHE_DIR", cfg["cache"]["dir"]))
    # relative paths are relative to the repo root, not to wherever the server was started
    cfg["cache"]["dir"] = str(cache_dir if cache_dir.is_absolute() else CONFIG_PATH.parent.parent / cache_dir)
    cfg["cache"]["max_mb"] = float(os.environ.get("SPHEREX_CACHE_MAX_MB", cfg["cache"].get("max_mb", 0)))
    cfg["allowed_origins"] = [
        o.strip()
        for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5500,http://127.0.0.1:5500").split(",")
        if o.strip()
    ]
    return cfg


def band_range(band: str) -> tuple[float, float]:
    lo, hi = get_config()["bands"][band]
    return float(lo), float(hi)
