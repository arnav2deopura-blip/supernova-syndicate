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

from . import cache, catalogs, cube, jobs, lightcurve, motion, photometry, pipeline, spherex_client
from .config import get_config
from .schemas import (
    Band,
    CubeResponse,
    ErrorResponse,
    ExposuresResponse,
    FramesResponse,
    JobStatus,
    LightCurveResponse,
    MotionResponse,
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
@app.exception_handler(motion.NotEnoughData)
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
    if isinstance(exc, (pipeline.NoCoverage, catalogs.NameNotFound, motion.NotEnoughData)):
        return "not_found", str(exc)
    if isinstance(exc, (spherex_client.UpstreamError, catalogs.ResolverUnavailable)):
        return "upstream_unavailable", str(exc)
    return "upstream_unavailable", f"Unexpected error while building the product: {exc}"


def _frames_key(ra, dec, fov, band, matched: bool = False) -> str:
    e = cfg["epochs"]
    return cache.cache_key("frames_matched" if matched else "frames", ra, dec, fov, band,
                           f"{spherex_client.data_version()}|ep{e['gap_days']}-{e.get('max_span_days')}")


def _cached_frames(key: str):
    meta = cache.get_json(key)
    if meta and all((_blob_dir() / f"{f['blob']}.bin").exists() for f in meta["frames"]):
        return meta
    return None


def _build_frames(ra, dec, fov, band, progress=None, matched: bool = False) -> dict:
    key = _frames_key(ra, dec, fov, band, matched)
    with _lock(key):
        meta = _cached_frames(key)
        if meta is None:
            build = cube.build_matched_frames if matched else pipeline.build_frames
            product = build(ra, dec, fov, band, progress=progress)
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
           matched: bool = Query(False, description="Same effective bandpass in every pass: only channels "
                                                     "observed in every pass, equal weight per channel"),
           async_: bool = Query(False, alias="async", description="If not cached, return 202 + a job instead of waiting")):
    """Co-added frames, one per survey pass. Cached positions answer at once.

    A cold position needs an archive search and downloads (~1-10 min). Without `async=1` the request
    waits; with `async=1` it returns 202 and a job to poll at /api/jobs/{job_id}.
    """
    key = _frames_key(ra, dec, fov, band, matched)
    meta = _cached_frames(key)
    if meta is None and async_:
        result_url = str(request.url.include_query_params(**{"async": "0"}))

        def work(progress):
            _build_frames(ra, dec, fov, band, progress, matched)
            return {"result_url": result_url}

        job = JOBS.submit(key, work, _classify)
        body = job.public()
        body["status_url"] = str(request.url_for("job_status", job_id=job.id))
        return JSONResponse(body, status_code=202)
    if meta is None:
        meta = _build_frames(ra, dec, fov, band, matched=matched)
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


# ---------------------------------------------------------------- items 1, 3-5: cached products + jobs
#
# Each product is a JSON document cached under a key that includes the data version and every parameter.
# Image arrays inside it are written as content-addressed blobs: a builder puts an integer index under
# "blob", and the URL is filled in per request (as for /frames). Cold products can take minutes (stamp
# downloads), so every endpoint takes async=1 and then answers 202 + a job, like /frames.

PMRA = Query(None, description="Target proper motion in RA*cos(Dec), mas/yr (e.g. from /api/resolve)")
PMDEC = Query(None, description="Target proper motion in Dec, mas/yr")
EPOCH = Query(None, description="Decimal year ra/dec are valid for (default: now, as /api/resolve returns)")
ASYNC = Query(False, alias="async", description="If not cached, return 202 + a job instead of waiting")


def _product_key(kind: str, ra, dec, fov, *params) -> str:
    return cache.cache_key(kind, ra, dec, fov, "|".join(str(p) for p in params), spherex_client.data_version())


def _blob_ids(node) -> list[str]:
    if isinstance(node, dict):
        return ([node["blob"]] if isinstance(node.get("blob"), str) else []) + [b for v in node.values() for b in _blob_ids(v)]
    if isinstance(node, list):
        return [b for v in node for b in _blob_ids(v)]
    return []


def _swap_blobs(node, fn):
    """Copy of node with every {"blob": x} replaced via fn(x) -> (key, value)."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k == "blob":
                nk, nv = fn(v)
                out[nk] = nv
            else:
                out[k] = _swap_blobs(v, fn)
        return out
    if isinstance(node, list):
        return [_swap_blobs(v, fn) for v in node]
    return node


def _cached_product(key: str):
    meta = cache.get_json(key)
    if meta is not None and all((_blob_dir() / f"{b}.bin").exists() for b in _blob_ids(meta)):
        return meta
    return None


def _get_product(key: str, build, progress=None) -> dict:
    """build(progress) -> (meta, arrays) or meta. Built once per key, even under concurrent requests."""
    with _lock(key):
        meta = _cached_product(key)
        if meta is None:
            res = build(progress)
            meta, arrays = res if isinstance(res, tuple) else (res, [])
            ids = [_save_blob(a) for a in arrays]
            meta = _swap_blobs(meta, lambda i: ("blob", ids[i]))
            meta = json_safe(meta)
            cache.put_json(key, meta)
            cache.prune()
    return meta


def json_safe(node):
    """numpy scalars / NaN -> plain JSON (NaN and inf become null)."""
    if isinstance(node, dict):
        return {k: json_safe(v) for k, v in node.items()}
    if isinstance(node, (list, tuple)):
        return [json_safe(v) for v in node]
    if isinstance(node, (np.floating, float)):
        v = float(node)
        return v if np.isfinite(v) else None
    if isinstance(node, np.integer):
        return int(node)
    if isinstance(node, np.bool_):
        return bool(node)
    return node


def _serve_product(request: Request, key: str, build, async_: bool):
    meta = _cached_product(key)
    if meta is None and async_:
        result_url = str(request.url.include_query_params(**{"async": "0"}))

        def work(progress):
            _get_product(key, build, progress)
            return {"result_url": result_url}

        job = JOBS.submit(key, work, _classify)
        body = job.public()
        body["status_url"] = str(request.url_for("job_status", job_id=job.id))
        return JSONResponse(body, status_code=202)
    if meta is None:
        meta = _get_product(key, build)
    return _swap_blobs(meta, lambda b: ("data", str(request.url_for("blob", blob_id=b))))


def _field(ra: float, dec: float, fov: float) -> list[dict]:
    """Gaia DR3 around the stamp (stamps are wider than fov), [] when Gaia is down."""
    half = spherex_client.stamp_size_px(fov) * cfg["pixel_scale_arcsec"] / 3600 / np.sqrt(2)
    try:
        return catalogs.gaia_query(ra, dec, round(half, 3))
    except catalogs.ResolverUnavailable:
        return []


def _dets(det: str) -> list[int]:
    if det.lower() == "all":
        return [1, 2, 3, 4, 5, 6]
    out = []
    for part in det.upper().replace(" ", "").split(","):
        if not re.fullmatch(r"D[1-6]", part):
            raise ValueError(part)
        out.append(int(part[1]))
    return sorted(set(out))


@app.get("/api/spectrum", response_model=SpectrumResponse, responses={202: {"model": JobStatus}})
def spectrum(request: Request, ra: float = RA, dec: float = DEC,
             det: str = Query("all", description="'all' or a comma list, e.g. D2,D3"),
             compare: str | None = Query(None, pattern=r"^E\d+$", description="Add a ratio spectrum: <last pass> / compare"),
             against: str | None = Query(None, pattern=r"^E\d+$", description="Numerator pass for the ratio (default: last)"),
             pmra: float | None = PMRA, pmdec: float | None = PMDEC, epoch: float | None = EPOCH, async_: bool = ASYNC):
    """Per-exposure ePSF photometry at the target (propagated for proper motion), uJy, every exposure in the
    requested detectors. With compare=E1, also the per-channel ratio spectrum between two passes (item 4B)."""
    try:
        dets = _dets(det)
    except ValueError:
        return error("bad_request", "det: use 'all' or a comma list of D1..D6")
    key = _product_key("spectrum", ra, dec, DEFAULT_FOV, dets, pmra, pmdec, epoch, "v3")

    def build(progress):
        track = photometry.track_for(ra, dec, pmra, pmdec, epoch)
        pts = photometry.spectrum_at(ra, dec, dets, fov=DEFAULT_FOV, track=track, progress=progress)
        return {"ra": ra, "dec": dec, "points": pts,
                "track": {"source": track.source, "pmra": track.pmra, "pmdec": track.pmdec, "gaia_id": track.gaia_id}}

    out = _serve_product(request, key, build, async_)
    if isinstance(out, dict) and compare:
        out = {**out, "ratio": photometry.ratio_spectrum(out["points"], compare, against)}
    return out


@app.get("/api/cube", response_model=CubeResponse, responses={202: {"model": JobStatus}})
def cube_view(request: Request, ra: float = RA, dec: float = DEC, fov: float = FOV, det: Band = "D6",
              per_pass: bool = Query(False, description="One image per (channel, pass) instead of all passes stacked"),
              strict: bool = Query(False, description="Use only pixels inside each channel (CHANNEL_MAP)"),
              pmra: float | None = PMRA, pmdec: float | None = PMDEC, async_: bool = ASYNC):
    """Item 3: one co-added image per spectral channel (17 per detector), on the /frames grid."""
    key = _product_key("cube", ra, dec, fov, det, int(per_pass), int(strict), pmra, pmdec, "v1")
    pm = float(np.hypot(pmra, pmdec)) if pmra is not None and pmdec is not None else None

    def build(progress):
        p = cube.build_cube(ra, dec, fov, det, per_pass=per_pass, strict=strict, progress=progress, target_pm_mas_yr=pm)
        return p.meta, p.arrays

    return _serve_product(request, key, build, async_)


@app.get("/api/lightcurve", response_model=LightCurveResponse, responses={202: {"model": JobStatus}})
def lightcurve_view(request: Request, ra: float = RA, dec: float = DEC, det: Band = "D2",
                    method: str = Query("template", pattern="^(template|channel)$"),
                    channel: str | None = Query(None, pattern=r"^D[1-6]C\d{2}$", description="Method 'channel' only"),
                    bin_days: float | None = Query(None, gt=0, le=200),
                    period_days: float | None = Query(None, gt=0, description="Also fit a sinusoid at this period"),
                    pmra: float | None = PMRA, pmdec: float | None = PMDEC, epoch: float | None = EPOCH,
                    async_: bool = ASYNC):
    """Item 4: bandpass-corrected light curve (template method) or a single-channel one, with comparison stars."""
    key = _product_key("lightcurve", ra, dec, DEFAULT_FOV, det, method, channel, bin_days, period_days, pmra, pmdec, epoch, "v2")

    def build(progress):
        stamps, bins = pipeline.load_stamps(ra, dec, DEFAULT_FOV, det, progress)
        track = photometry.track_for(ra, dec, pmra, pmdec, epoch)
        lc = lightcurve.build_lightcurve(stamps, bins, track, method=method, channel=channel, bin_days=bin_days,
                                         field=_field(ra, dec, DEFAULT_FOV), period_days=period_days)
        return {"ra": ra, "dec": dec, "det": det, **lc}

    return _serve_product(request, key, build, async_)


@app.get("/api/motion", response_model=MotionResponse, responses={202: {"model": JobStatus}})
def motion_view(request: Request, ra: float = RA, dec: float = DEC,
                det: str = Query("D2", description="A detector, a comma list, or 'all'"),
                fit_parallax: bool = Query(False), pmra: float | None = PMRA, pmdec: float | None = PMDEC,
                epoch: float | None = EPOCH, async_: bool = ASYNC):
    """Item 5: fitted proper motion (+ parallax) from per-exposure ePSF positions registered to Gaia."""
    try:
        dets = _dets(det)
    except ValueError:
        return error("bad_request", "det: use 'all' or a comma list of D1..D6")
    key = _product_key("motion", ra, dec, DEFAULT_FOV, dets, int(fit_parallax), pmra, pmdec, epoch, "v1")

    def build(progress):
        stamps, bins = [], None
        for d in dets:
            try:
                st, bins = pipeline.load_stamps(ra, dec, DEFAULT_FOV, f"D{d}", progress)
            except pipeline.NoCoverage:
                continue
            stamps += st
        if not stamps:
            raise pipeline.NoCoverage(f"No SPHEREx exposures cover RA {ra:.5f}, Dec {dec:.5f} in {det}.")
        track = photometry.track_for(ra, dec, pmra, pmdec, epoch)
        cat = {"pmra": pmra, "pmdec": pmdec, "catalog": "request"} if track.source == "request" else None
        m = motion.build_motion(stamps, bins, track, _field(ra, dec, DEFAULT_FOV), fit_parallax, cat)
        return {"ra": ra, "dec": dec, "det": ",".join(f"D{d}" for d in dets), **m}

    return _serve_product(request, key, build, async_)


@app.get("/api/overlay", response_model=OverlayResponse)
def overlay(ra: float = RA, dec: float = DEC, fov: float = FOV, cat: str = "gaia"):
    if cat != "gaia":
        return error("bad_request", f"Unknown catalogue '{cat}'. Supported: gaia")
    bins = pipeline.position_epochs(spherex_client.query_exposures(ra, dec, fov))
    epochs = [(f"E{i + 1}", (a + b) / 2) for i, (a, b) in enumerate(bins)]
    return {"catalog": "gaia_dr3", "sources": catalogs.gaia_sources(ra, dec, fov, epochs)}
