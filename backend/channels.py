"""The 102 SPHEREx spectral channels (17 per detector): table lookup and per-pixel channel map. Owner: B.

Data: backend/data/spectral_channels.json and channel_map.npy.gz, extracted from the calibration file
named by config archive.spectral_channels (scripts/extract_channels.py).

* `assign(det, lam)`: the channel whose [WL_MIN, WL_MAX] contains lam. Neighbouring channels overlap
  slightly; then the one whose centre is closest wins. Used to tag each exposure by the wavelength at
  the target (quick-look: exact at the target, up to ~half a channel off at the stamp edges).
* `map_slice(x0, y0, shape)`: CHANNEL_MAP values under a stamp (detector "sky" coordinates, the same
  orientation as L2 images and our stamps; CUTX0/CUTY0 give the stamp origin). Used by strict mode.
  One map serves all six detectors (DETECTOR='ALL' in the calibration file).
"""
from __future__ import annotations

import gzip
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np

DATA = Path(__file__).with_name("data")
N_PER_DET = 17
DET_SIZE = 2040


@dataclass(frozen=True)
class Channel:
    detector: int
    subchan: int
    wavelength: float      # centre, um
    wl_min: float
    wl_max: float
    R: float
    bandwidth: float

    @property
    def label(self) -> str:
        return f"D{self.detector}C{self.subchan:02d}"

    @property
    def index(self) -> int:
        """0..101 across all detectors, in wavelength order."""
        return (self.detector - 1) * N_PER_DET + self.subchan - 1


@lru_cache
def table() -> tuple[Channel, ...]:
    rows = json.loads((DATA / "spectral_channels.json").read_text())["channels"]
    out = tuple(sorted((Channel(**r) for r in rows), key=lambda c: (c.detector, c.subchan)))
    if len(out) != 6 * N_PER_DET:
        raise RuntimeError(f"expected 102 channels, got {len(out)}")
    return out


def for_detector(det: int) -> list[Channel]:
    return [c for c in table() if c.detector == det]


def by_label(label: str) -> Channel:
    for c in table():
        if c.label == label.upper():
            return c
    raise KeyError(label)


def assign(det: int, lam_um: float, tol_um: float = 0.0) -> Optional[Channel]:
    """Channel of detector `det` containing lam_um (overlap -> nearest centre). None if outside the
    detector's range by more than tol_um."""
    if lam_um is None or not np.isfinite(lam_um):
        return None
    chans = for_detector(det)
    inside = [c for c in chans if c.wl_min - tol_um <= lam_um <= c.wl_max + tol_um]
    if not inside:
        return None
    return min(inside, key=lambda c: abs(c.wavelength - lam_um))


def nearest(det: int, lam_um: float) -> Channel:
    """Closest channel of the detector by centre wavelength, never None."""
    return min(for_detector(det), key=lambda c: abs(c.wavelength - lam_um))


@lru_cache
def channel_map() -> np.ndarray:
    """2040x2040 uint8: channel number 1-17 per detector pixel; 0 and 18 mean outside every channel."""
    with gzip.open(DATA / "channel_map.npy.gz", "rb") as f:
        m = np.load(f)
    m.setflags(write=False)
    return m


def map_slice(x0: int, y0: int, shape: tuple[int, int]) -> np.ndarray:
    """CHANNEL_MAP under a stamp whose pixel (0, 0) is detector pixel (x0, y0). Pixels off the
    detector come back 0."""
    ny, nx = shape
    out = np.zeros((ny, nx), dtype=np.uint8)
    m = channel_map()
    ys, xs = max(y0, 0), max(x0, 0)
    ye, xe = min(y0 + ny, DET_SIZE), min(x0 + nx, DET_SIZE)
    if ye > ys and xe > xs:
        out[ys - y0:ye - y0, xs - x0:xe - x0] = m[ys:ye, xs:xe]
    return out
