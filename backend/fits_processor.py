"""Flag masking, zodi subtraction, epoch grouping, co-adding. Owner: B.

Never blink raw exposures: each detector sits behind a linear variable filter,
so wavelength changes across the image. One frame = one epoch x one detector.
"""
from __future__ import annotations

from typing import Sequence

import numpy as np


def group_epochs(mjds: Sequence[float], gap_days: float = 60.0) -> list[int]:
    """Assign an epoch index to each exposure time.

    A new epoch starts whenever the gap to the previous (sorted) exposure exceeds
    gap_days. Returns indices in the same order as the input.
    """
    if len(mjds) == 0:
        return []
    order = np.argsort(mjds)
    labels = np.empty(len(mjds), dtype=int)
    epoch = 0
    prev = mjds[order[0]]
    for i in order:
        if mjds[i] - prev > gap_days:
            epoch += 1
        labels[i] = epoch
        prev = mjds[i]
    return labels.tolist()


def epoch_label(index: int) -> str:
    return f"E{index + 1}"


def mask_and_subtract(image: np.ndarray, flags: np.ndarray, zodi: np.ndarray | None, bad_bits: int) -> np.ndarray:
    """Issue #5: NaN-out flagged pixels and subtract the ZODI HDU (or a local median)."""
    out = image.astype(np.float32).copy()
    out[(flags & bad_bits) != 0] = np.nan
    if zodi is not None:
        out -= zodi
    else:
        out -= np.nanmedian(out)
    return out


def coadd(images: Sequence[np.ndarray], variances: Sequence[np.ndarray] | None = None) -> np.ndarray:
    """Variance-weighted mean of already-aligned images, ignoring NaNs.

    Falls back to a plain NaN-mean when no variances are given.
    """
    stack = np.stack(images).astype(np.float64)
    if variances is None:
        with np.errstate(invalid="ignore"):
            return np.nanmean(stack, axis=0).astype(np.float32)
    w = 1.0 / np.stack(variances).astype(np.float64)
    w[~np.isfinite(stack) | ~np.isfinite(w)] = 0.0
    stack = np.nan_to_num(stack)
    wsum = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = (stack * w).sum(axis=0) / wsum
    out[wsum == 0] = np.nan
    return out.astype(np.float32)
