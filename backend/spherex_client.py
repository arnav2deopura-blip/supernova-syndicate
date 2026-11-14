"""IRSA SIA2/TAP queries and cutout downloads. Owner: A.

Flow (see the IRSA SPHEREx cutouts tutorial):
  1. Query every collection in config.yaml for images covering (ra, dec).
  2. Keep time, detector, access URL.
  3. Download cutouts: <access_url>?center=<ra>,<dec>&size=<deg>
     in parallel (config download.max_workers), with retries and the disk cache.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


class UpstreamError(RuntimeError):
    """IRSA was slow, down, or returned something unusable."""


@dataclass
class ExposureRecord:
    obs_id: str
    mjd: float
    detector: int
    access_url: str
    collection: str


def query_exposures(ra: float, dec: float, fov: float) -> list[ExposureRecord]:
    """Issue #3: SIA2/TAP query across all collections, merged and de-duplicated."""
    raise NotImplementedError("Issue #3: SIA2/TAP query across dr1 + qr3 collections")


def cutout_url(access_url: str, ra: float, dec: float, size_deg: float) -> str:
    sep = "&" if "?" in access_url else "?"
    return f"{access_url}{sep}center={ra},{dec}&size={size_deg}"


def download_cutouts(records: list[ExposureRecord], ra: float, dec: float, fov: float) -> list[Path]:
    """Issue #4: parallel download with retry + cache. Return local FITS paths."""
    raise NotImplementedError("Issue #4: parallel cutout download with retry + cache")
