"""Find exposures covering a position and fetch stamps of them. Owner: A.

Exposure lookup, in order (config archive.prefer):
  1. IRSA TAP (spherex.plane/artifact) -- fast when IRSA is up.
  2. S3 header scan (backend/s3_archive.py) -- slower on a cold position, but needs only the S3 mirror.
Stamps: byte-range cut from S3 when we know the S3 key (always for S3-found records, and for
TAP records whose file name maps to a key); otherwise IRSA's cutout service.
Everything is cached on disk (cache.py), keyed by release_tag.
"""
from __future__ import annotations

import csv
import io
import math
import time
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Optional

import requests
from astropy.io import fits

from . import cache, s3_archive
from .config import get_config

Progress = Optional[Callable[[str, int, int], None]]

# Circuit breaker: after a TAP failure, skip TAP for a while instead of paying its timeout on every
# cold request (IRSA answered trivial queries but timed out on real ones for hours on 14 Nov).
_tap_skip_until = 0.0


class UpstreamError(RuntimeError):
    """IRSA was slow, down, or returned something unusable."""


@dataclass
class ExposureRecord:
    obs_id: str
    mjd: float
    detector: int
    s3_key: str = ""        # empty if only reachable through IRSA
    access_url: str = ""    # IRSA URL, if known
    source: str = "s3"      # which index found it: "tap" or "s3"


def cutout_url(access_url: str, ra: float, dec: float, size_deg: float) -> str:
    sep = "&" if "?" in access_url else "?"
    return f"{access_url}{sep}center={ra},{dec}&size={size_deg}"


# ---------------------------------------------------------------- exposure lookup

def data_version() -> str:
    """Release tag + pointing-index fingerprint. Part of every exposure/product cache key, so adding a
    release or rebuilding the index invalidates cached exposure lists and frames automatically."""
    from .provenance import identity
    return identity()


def query_exposures(ra: float, dec: float, fov: float = 0.0, progress: Progress = None) -> list[ExposureRecord]:
    """All exposures, all six detectors, whose footprint contains (ra, dec). Cached."""
    cfg = get_config()
    ck = cache.cache_key("exposures", ra, dec, fov, "", data_version())
    hit = cache.get_json(ck)
    if hit is not None:
        return [ExposureRecord(**r) for r in hit]

    recs: list[ExposureRecord] = []
    global _tap_skip_until
    if cfg["archive"].get("prefer", "tap") == "tap" and time.time() >= _tap_skip_until:
        try:
            recs = _tap_exposures(ra, dec, fov)
        except UpstreamError:
            _tap_skip_until = time.time() + cfg["archive"].get("tap_cooldown_s", 600)
            recs = []  # fall through to S3
    # IRSA documents point-in-footprint searches. Augment with the exact S3
    # footprint scan for a nonzero FOV rather than issuing unsupported INTERSECTS.
    if not recs or fov > 0:
        try:
            found = s3_archive.find_exposures(ra, dec, progress=progress, margin_px=fov*3600/get_config()["pixel_scale_arcsec"]/2**.5)
        except s3_archive.S3Error as e:
            raise UpstreamError(f"IRSA TAP and the S3 mirror both failed: {e}") from e
        indexed={(r.obs_id,r.detector):r for r in recs}
        for e in found:
            indexed.setdefault((e.obs_id,e.detector),ExposureRecord(e.obs_id,e.mjd,e.detector,s3_key=e.key,source='s3'))
        recs=list(indexed.values())

    recs.sort(key=lambda r: (r.detector, r.mjd))
    cache.put_json(ck, [asdict(r) for r in recs])
    return recs


def _tap_exposures(ra: float, dec: float, fov: float = 0.0) -> list[ExposureRecord]:
    """IRSA TAP query (query shape from the IRSA SPHEREx cutouts tutorial).

    Live integration evidence and upstream failures: docs/NATIVE_ARCHIVE_VALIDATION.json.
    Any failure raises UpstreamError so the caller falls back to the S3 scan.
    """
    cfg = get_config()["archive"]
    query = (
        "SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname "
        "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid "
        f"WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)"
    )
    try:
        r = requests.get(f"{cfg['tap_url']}/sync", params={"REQUEST":"doQuery","LANG": "ADQL", "FORMAT": "csv", "QUERY": query},
                         timeout=cfg.get("tap_timeout_s", 20))
    except requests.RequestException as e:
        raise UpstreamError(f"IRSA TAP unreachable: {e}") from e
    reader=csv.DictReader(io.StringIO(r.text.lstrip('\ufeff')))
    if reader.fieldnames:reader.fieldnames=[key.strip().lower().split('.')[-1] for key in reader.fieldnames]
    if r.status_code != 200 or not {'uri','time_bounds_lower','energy_bandpassname'}.issubset(reader.fieldnames or []):
        raise UpstreamError(f"IRSA TAP returned HTTP {r.status_code} without the expected CSV columns (archive/proxy error).")
    recs = []
    for row in reader:
        url = urljoin("https://irsa.ipac.caltech.edu/",row["uri"])
        fname = url.split("?")[0].rsplit("/", 1)[-1]
        try:
            n = s3_archive.parse_name(fname)
        except ValueError:
            continue
        try:
            key = s3_archive.key_for_filename(fname) or ""
        except s3_archive.S3Error:
            key = ""
        recs.append(ExposureRecord(n["obs_id"], float(row["time_bounds_lower"]), n["det"],
                                   s3_key=key, access_url=url, source="tap"))
    return recs


# ---------------------------------------------------------------- stamps

def stamp_size_px(fov_deg: float) -> int:
    """Native-pixel stamp side covering the FOV plus the centre-snapping margin, multiple of 8."""
    native = get_config()["pixel_scale_arcsec"]
    n = math.ceil((fov_deg * 2**.5 + 0.03) * 3600 / native) + 4
    return int(math.ceil(n / 8) * 8)


def fetch_stamps(records: list[ExposureRecord], ra: float, dec: float, fov: float,
                 progress: Progress = None) -> list[tuple[ExposureRecord, Path]]:
    """Cut (or load from cache) one stamp per record. Off-chip records are dropped."""
    sra, sdec = s3_archive.snap_center(ra, dec)
    size = stamp_size_px(fov)
    done, failures = [0], []

    def one(rec: ExposureRecord) -> Optional[Path]:
        ident = rec.s3_key or rec.access_url
        with cache.key_lock('stamp:'+ident+str((sra,sdec,size))):
            return locked_one(rec)

    def locked_one(rec: ExposureRecord) -> Optional[Path]:
        ident = rec.s3_key or rec.access_url
        ck = cache.cache_key("stamp", sra, sdec, size, ident)
        path = cache.file_path(ck, ".fits")
        miss = cache.file_path(ck, ".offchip")
        if not path.exists() and not miss.exists():
            try:
                hdul = _cut(rec, sra, sdec, size)
            except (s3_archive.S3Error, OSError, ValueError) as e:
                failures.append(f"{ident}: {e}")
                return None
            if hdul is None:
                miss.touch()
            else:
                cache.atomic_fits(path,hdul)
                hdul.close()
        done[0] += 1
        if progress:
            progress("stamps", done[0], len(records))
        return path if cache.retain([path]) else None

    with ThreadPoolExecutor(get_config()["download"]["max_workers"]) as ex:
        paths = list(ex.map(one, records))
    if records and not any(paths) and failures:
        raise UpstreamError(f"every stamp download failed, e.g. {failures[0]}")
    results=[(r,p) for r,p in zip(records,paths) if p is not None]
    report={'selected':len(records),'downloaded_or_cached':len(results),'failed':len(failures),'off_chip':len(records)-len(results)-len(failures),'failures':failures[:10]}
    cache.put_json(cache.cache_key('retrieval',ra,dec,fov,','.join(str(r.detector) for r in records[:1]),data_version()),report)
    return results


def _cut(rec: ExposureRecord, ra: float, dec: float, size_px: int) -> Optional[fits.HDUList]:
    if rec.s3_key:
        return s3_archive.cut_stamp(rec.s3_key, ra, dec, size_px)
    size_deg = size_px * get_config()["pixel_scale_arcsec"] / 3600
    try:
        response=requests.get(cutout_url(rec.access_url,ra,dec,size_deg),timeout=get_config()['download']['timeout_s'])
        response.raise_for_status()
        with fits.open(io.BytesIO(response.content)) as h:
            return fits.HDUList([hdu.copy() for hdu in h])
    except requests.RequestException as exc:
        raise OSError(f"IRSA cutout unavailable: {exc}") from exc
