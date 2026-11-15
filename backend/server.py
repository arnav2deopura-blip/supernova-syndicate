"""FastAPI app. Routes only, no science logic. Owner: A.

Run: uvicorn backend.server:app --reload
"""
from __future__ import annotations

import hashlib
import re
import threading
from collections import defaultdict
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import cache, catalogs, jobs, photometry, pipeline, spherex_client
from .config import get_config
from .schemas import (
    Band,
    ErrorResponse,
    ExposuresResponse,
    FramesResponse,
    JobStatus,
    OverlayResponse,
    ResolveResponse,
    SpectrumResponse,
)

cfg = get_config()
MAX_FOV = cfg["fov"]["max_deg"]
DEFAULT_FOV = cfg["fov"]["default_deg"]

app = FastAPI(title="SPHEREx Sky Explorer API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg["allowed_origins"],
    allow_methods=["GET"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)

ERRORS = {"bad_request": 400, "not_found": 404, "upstream_unavailable": 503, "not_implemented": 501}


def error(code: str, message: str) -> JSONResponse:
    return JSONResponse(ErrorResponse(error=code, message=message).model_dump(), status_code=ERRORS[code])


@app.exception_handler(NotImplementedError)
async def _not_implemented(_: Request, exc: NotImplementedError):
    return error("not_implemented", str(exc) or "Not built yet.")


@app.exception_handler(spherex_client.UpstreamError)
@app.exception_handler(catalogs.ResolverUnavailable)
async def _upstream(_: Request, exc: Exception):
    return error("upstream_unavailable", str(exc) or "The archive is not responding.")


@app.exception_handler(pipeline.NoCoverage)
@app.exception_handler(catalogs.NameNotFound)
async def _not_found(_: Request, exc: Exception):
    return error("not_found", str(exc))


@app.exception_handler(RequestValidationError)
async def _bad_request(_: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", []))
    return error("bad_request", f"{where}: {first.get('msg', 'invalid request')}")


RA = Query(..., ge=0, lt=360, description="ICRS degrees")
DEC = Query(..., ge=-90, le=90, description="ICRS degrees")
FOV = Query(DEFAULT_FOV, gt=0, le=MAX_FOV, description="Cutout side, degrees")

# One lock per product key, so identical concurrent requests build it once.
_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
_locks_guard = threading.Lock()


def _lock(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks[key]


def _blob_dir() -> Path:
    p = Path(cfg["cache"]["dir"]) / "blobs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _save_blob(arr: np.ndarray) -> str:
    raw = np.ascontiguousarray(arr, dtype="<f4").tobytes()
    blob_id = hashlib.sha1(raw).hexdigest()[:24]
    path = _blob_dir() / f"{blob_id}.bin"
    if not path.exists():
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(raw)
        tmp.replace(path)
    return blob_id


@app.get("/api/health")
def health():
    return {"ok": True, "release": cfg["release_tag"]}


@app.get("/api/resolve", response_model=ResolveResponse)
def resolve(name: str = Query(..., min_length=1)):
    return catalogs.resolve_name(name)


JOBS = jobs.JobManager(workers=cfg.get("jobs", {}).get("workers", 2))


def _classify(exc: Exception) -> tuple[str, str]:
    """Exception -> (API error code, message), same mapping as the exception handlers."""
    if isinstance(exc, (pipeline.NoCoverage, catalogs.NameNotFound)):
        return "not_found", str(exc)
    if isinstance(exc, (spherex_client.UpstreamError, catalogs.ResolverUnavailable)):
        return "upstream_unavailable", str(exc)
    return "upstream_unavailable", f"Unexpected error while building frames: {exc}"


def _frames_key(ra, dec, fov, band) -> str:
    e = cfg["epochs"]
    return cache.cache_key("frames", ra, dec, fov, band,
                           f"{spherex_client.data_version()}|ep{e['gap_days']}-{e.get('max_span_days')}")


def _cached_frames(key: str):
    meta = cache.get_json(key)
    if meta and all((_blob_dir() / f"{f['blob']}.bin").exists() for f in meta["frames"]):
        return meta
    return None


def _build_frames(ra, dec, fov, band, progress=None) -> dict:
    key = _frames_key(ra, dec, fov, band)
    with _lock(key):
        meta = _cached_frames(key)
        if meta is None:
            product = pipeline.build_frames(ra, dec, fov, band, progress=progress)
            meta = product.meta
            for f, arr in zip(meta["frames"], product.arrays):
                f["blob"] = _save_blob(arr)
            cache.put_json(key, meta)
            cache.prune()  # after every new product: keeps a memory-backed /tmp from filling up
    return meta


def _with_urls(request: Request, meta: dict) -> dict:
    out = {**meta, "frames": []}
    for f in meta["frames"]:
        f = dict(f)
        f["data"] = str(request.url_for("blob", blob_id=f.pop("blob")))
        out["frames"].append(f)
    return out


@app.get("/api/frames", response_model=FramesResponse, responses={202: {"model": JobStatus}})
def frames(request: Request, ra: float = RA, dec: float = DEC, fov: float = FOV, band: Band = "D2",
           async_: bool = Query(False, alias="async", description="If not cached, return 202 + a job instead of waiting")):
    """Co-added frames, one per survey pass. Cached positions answer at once.

    A cold position needs an archive search and downloads (~1-10 min). Without `async=1` the request
    waits; with `async=1` it returns 202 and a job to poll at /api/jobs/{job_id}.
    """
    key = _frames_key(ra, dec, fov, band)
    meta = _cached_frames(key)
    if meta is None and async_:
        result_url = str(request.url.include_query_params(**{"async": "0"}))

        def work(progress):
            _build_frames(ra, dec, fov, band, progress)
            return {"result_url": result_url}

        job = JOBS.submit(key, work, _classify)
        body = job.public()
        body["status_url"] = str(request.url_for("job_status", job_id=job.id))
        return JSONResponse(body, status_code=202)
    if meta is None:
        meta = _build_frames(ra, dec, fov, band)
    return _with_urls(request, meta)


@app.get("/api/jobs/{job_id}", response_model=JobStatus, name="job_status")
def job_status(request: Request, job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        return error("not_found", "Unknown or expired job. Re-request the data.")
    body = job.public()
    body["status_url"] = str(request.url_for("job_status", job_id=job.id))
    return body


@app.get("/api/blob/{blob_id}.bin", name="blob")
def blob(blob_id: str):
    """Little-endian float32 frame data, row 0 = north, NaN = masked. Content-addressed, so cache forever."""
    if not re.fullmatch(r"[0-9a-f]{24}", blob_id):
        return error("bad_request", "bad blob id")
    path = _blob_dir() / f"{blob_id}.bin"
    if not path.exists():
        return error("not_found", "blob expired; re-request /api/frames")
    return FileResponse(path, media_type="application/octet-stream",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/exposures", response_model=ExposuresResponse)
def exposures(ra: float = RA, dec: float = DEC, fov: float = FOV):
    """Every exposure covering the position, all detectors, with epoch labels. Wavelength and flags at
    the target are filled in for exposures already processed by /api/frames (null otherwise)."""
    recs = spherex_client.query_exposures(ra, dec, fov)
    bins = pipeline.position_epochs(recs)
    labels = pipeline.assign_epochs([r.mjd for r in recs], bins) if recs else []
    detail = pipeline.exposure_details(ra, dec)
    out = []
    for r, e in zip(recs, labels):
        d = detail.get((r.obs_id, r.detector), {})
        out.append({
            "obs_id": r.obs_id, "mjd": round(r.mjd, 5), "detector": r.detector,
            "wavelength_um": d.get("lam_um"), "epoch_label": f"E{e + 1}",
            "flags_summary": {"flag_fraction": d.get("masked_fraction", 0.0), "target_flags": d.get("target_flags")},
            "url": (spherex_client.s3_archive.base_url() + r.s3_key) if r.s3_key else r.access_url,
        })
    return {"exposures": out}


@app.get("/api/spectrum", response_model=SpectrumResponse)
def spectrum(ra: float = RA, dec: float = DEC):
    return {"ra": ra, "dec": dec, "points": photometry.spectrum_at(ra, dec)}


@app.get("/api/overlay", response_model=OverlayResponse)
def overlay(ra: float = RA, dec: float = DEC, fov: float = FOV, cat: str = "gaia"):
    if cat != "gaia":
        return error("bad_request", f"Unknown catalogue '{cat}'. Supported: gaia")
    bins = pipeline.position_epochs(spherex_client.query_exposures(ra, dec, fov))
    epochs = [(f"E{i + 1}", (a + b) / 2) for i, (a, b) in enumerate(bins)]
    return {"catalog": "gaia_dr3", "sources": catalogs.gaia_sources(ra, dec, fov, epochs)}
