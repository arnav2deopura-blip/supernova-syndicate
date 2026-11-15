"""FastAPI app. Routes only, no science logic. Owner: A.

Run: uvicorn backend.server:app --reload
"""
from __future__ import annotations

import hashlib
import re
import threading
import weakref
import json
import time
from contextlib import contextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import cache, catalogs, cube, discovery, jobs, lightcurve, motion, photometry, pipeline, releases, spherex_client, stack
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

app = FastAPI(title="SPHEREx Sky Explorer API", version="0.4.0")
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


@app.exception_handler(pipeline.RequestTooLarge)
async def _too_large(_: Request, exc:pipeline.RequestTooLarge):
    return error('bad_request',str(exc))


@app.exception_handler(RequestValidationError)
async def _bad_request(_: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", []))
    return error("bad_request", f"{where}: {first.get('msg', 'invalid request')}")


RA = Query(..., ge=0, lt=360, description="ICRS degrees")
DEC = Query(..., ge=-90, le=90, description="ICRS degrees")
FOV = Query(DEFAULT_FOV, gt=0, le=MAX_FOV, description="Cutout side, degrees")

# One lock per product key, so identical concurrent requests build it once.
_locks = weakref.WeakValueDictionary()
_locks_guard = threading.Lock()


def _lock(key: str) -> threading.Lock:
    with _locks_guard:
        lock=_locks.get(key)
        if lock is None:
            lock=threading.Lock();_locks[key]=lock
        return lock


def _blob_dir() -> Path:
    p = Path(cfg["cache"]["dir"]) / "blobs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _save_blob(arr: np.ndarray) -> str:
    raw = np.ascontiguousarray(arr, dtype="<f4").tobytes()
    blob_id = hashlib.sha1(raw).hexdigest()[:24]
    path = _blob_dir() / f"{blob_id}.bin"
    with cache._pins_guard:
        if not path.exists():
            cache.atomic_write(path, raw)
        cache.lease([path])
    return blob_id


@app.get("/api/health")
def health():
    return {"ok": True, "release": cfg["release_tag"]}


_release_check: dict = {}


@app.get("/api/meta")
def meta(check: bool = Query(False, description="Also list the S3 mirror now for releases/weeks not indexed yet")):
    """What the server is built from: releases, collections, detector bands, and the data span of the pointing
    index ("SPHEREx data through <date>"). With check=1, a live archive check (cached 1 h)."""
    import time
    out = {"api_version": app.version, **releases.summary()}
    if check:
        hit = _release_check.get("v")
        if hit is None or time.time() - hit[0] > 3600:
            try:
                hit = (time.time(), releases.check())
            except Exception as e:  # noqa: BLE001 - the mirror being down must not break /meta
                hit = (time.time(), {"error": "upstream_unavailable", "message": str(e)[:200]})
            _release_check["v"] = hit
        out["check"] = hit[1]
    return out


@app.get("/api/resolve", response_model=ResolveResponse)
def resolve(name: str = Query(..., min_length=1)):
    return catalogs.resolve_name(name)


JOBS = jobs.JobManager(workers=cfg.get("jobs", {}).get("workers", 2), capacity=cfg.get('jobs',{}).get('capacity',8))

@app.exception_handler(jobs.QueueFull)
async def _busy(_:Request, exc:jobs.QueueFull):
    return JSONResponse({'error':'busy','message':str(exc)},status_code=429,headers={'Retry-After':'30'})


def _classify(exc: Exception) -> tuple[str, str]:
    """Exception -> (API error code, message), same mapping as the exception handlers."""
    if isinstance(exc,pipeline.RequestTooLarge): return 'bad_request',str(exc)
    if isinstance(exc, (pipeline.NoCoverage, catalogs.NameNotFound, motion.NotEnoughData)):
        return "not_found", str(exc)
    if isinstance(exc, (spherex_client.UpstreamError, catalogs.ResolverUnavailable)):
        return "upstream_unavailable", str(exc)
    return "upstream_unavailable", f"Unexpected error while building the product: {exc}"


_build_slots=threading.BoundedSemaphore(cfg.get('jobs',{}).get('workers',2))
_build_owner=threading.local()
@contextmanager
def _admission():
    nested=getattr(_build_owner,'active',False)
    if not nested and not _build_slots.acquire(blocking=False):
        raise jobs.QueueFull('All processing workers are occupied. Retry in 30 seconds, using async=1 for a queued search.')
    _build_owner.active=True
    try: yield
    finally:
        _build_owner.active=nested
        if not nested: _build_slots.release()


def _frames_key(ra, dec, fov, band, matched: bool = False) -> str:
    e = cfg["epochs"]
    return cache.cache_key("frames_matched" if matched else "frames", ra, dec, fov, band,
                           f"{spherex_client.data_version()}|ep{e['gap_days']}-{e.get('max_span_days')}|v2")


def _cached_frames(key: str):
    meta = cache.get_json(key)
    if meta and cache.retain([_blob_dir()/f"{f[k]}.bin" for f in meta["frames"] for k in ("blob","noise_blob","coverage_blob") if k in f]):
        return meta
    return None


def _build_frames(ra, dec, fov, band, progress=None, matched: bool = False, retry_missing: bool = False) -> dict:
    key = _frames_key(ra, dec, fov, band, matched)
    with _lock(key), _admission():
        meta = _cached_frames(key)
        if retry_missing and meta and meta.get("completeness",{}).get("failed"): meta=None
        if meta is None:
            build = cube.build_matched_frames if matched else pipeline.build_frames
            product = build(ra, dec, fov, band, progress=progress)
            pipeline.add_frame_qc(product, ra, dec, fov, _field(ra, dec, fov))
            meta = json_safe(product.meta)
            used={obs for frame in meta['frames'] for obs in frame.get('obs_ids',[])}
            records=cache.get_json(cache.cache_key('exposures',ra,dec,fov,'',spherex_client.data_version()))
            meta['inputs']=[r for r in records if r['detector']==int(band[1]) and r['obs_id'] in used] if records is not None else None
            for f, arr in zip(meta["frames"], product.arrays):
                f["blob"] = _save_blob(arr)
            for f, arr in zip(meta["frames"], product.noise or []):
                f["noise_blob"] = _save_blob(arr)
            for f, arr in zip(meta['frames'], product.coverage or []):
                f['coverage_blob'] = _save_blob(arr)
            cache.put_json(key, meta)
            cache.prune()  # after every new product: keeps a memory-backed /tmp from filling up
    return meta


def _with_urls(request: Request, meta: dict) -> dict:
    cache.lease([_blob_dir()/f"{f[k]}.bin" for f in meta['frames'] for k in ('blob','noise_blob','coverage_blob') if k in f])
    out = {**meta, "frames": []}
    for f in meta["frames"]:
        f = dict(f)
        f["data"] = str(request.url_for("blob", blob_id=f.pop("blob")))
        if 'coverage_blob' in f:
            f['coverage']=str(request.url_for('blob',blob_id=f.pop('coverage_blob')))
        if "noise_blob" in f:
            f["noise"] = str(request.url_for("blob", blob_id=f.pop("noise_blob")))
        out["frames"].append(f)
    return out


@app.get("/api/frames", response_model=FramesResponse, responses={202: {"model": JobStatus}})
def frames(request: Request, ra: float = RA, dec: float = DEC, fov: float = FOV, band: Band = "D2",
           matched: bool = Query(False, description="Same effective bandpass in every pass: only channels "
                                                     "observed in every pass, equal weight per channel"),
           async_: bool = Query(False, alias="async", description="If not cached, return 202 + a job instead of waiting"),
           retry_missing: bool = Query(False,description="Retry failed downloads in a partial frame product")):
    """Co-added frames, one per survey pass. Cached positions answer at once.

    A cold position needs an archive search and downloads (~1-10 min). Without `async=1` the request
    waits; with `async=1` it returns 202 and a job to poll at /api/jobs/{job_id}.
    """
    key = _frames_key(ra, dec, fov, band, matched)
    meta = _cached_frames(key)
    if retry_missing and meta and meta.get("completeness",{}).get("failed"): meta=None
    cached_at_entry = meta is not None
    if meta is None and async_:
        result_url = str(request.url.include_query_params(**{"async": "0", "retry_missing":"0"}))

        def work(progress):
            _build_frames(ra, dec, fov, band, progress, matched, retry_missing)
            return {"result_url": result_url, "retrieval": {"kind": "built", "processing": spherex_client.data_version()}}

        job = JOBS.submit(key, work, _classify, owner=request.client.host if request.client else "anonymous")
        body = job.public()
        body["status_url"] = str(request.url_for("job_status", job_id=job.id))
        return JSONResponse(body, status_code=202)
    if meta is None:
        meta = _build_frames(ra, dec, fov, band, matched=matched,retry_missing=retry_missing)
    out=_with_urls(request, meta)
    out['retrieval'] = {'kind':'server_cache' if cached_at_entry else 'built', 'processing':spherex_client.data_version()}
    return out


@app.get("/api/frames.fits", response_class=FileResponse,
         responses={200: {"content": {"application/fits": {}}, "description": "Multi-extension FITS"}})
def frames_fits(ra: float = RA, dec: float = DEC, fov: float = FOV, band: Band = "D2",
                matched: bool = Query(False, description="Matched-wavelength frames (see /api/frames)")):
    """The /api/frames product as one FITS file for use in DS9 / astropy: per pass an IMAGE extension (MJy/sr,
    north-up TAN WCS) and a NOISE extension (1 sigma), with times, wavelengths and exposure counts in the headers.
    Builds the frames first if needed (slow for a new position: prefer /api/frames?async=1 first)."""
    from astropy.io import fits as afits

    meta = _build_frames(ra, dec, fov, band, matched=matched)
    cache.lease([_blob_dir()/f"{f[k]}.bin" for f in meta["frames"] for k in ("blob","noise_blob","coverage_blob") if k in f])
    w, h = meta["wcs"]["width"], meta["wcs"]["height"]
    hdr = pipeline.output_grid(ra, dec, fov).to_header()
    prim = afits.PrimaryHDU()
    ph = prim.header
    ph["ORIGIN"] = ("SPHEREx Sky Explorer", "NASA Space Apps 2026")
    ph["TELESCOP"] = "SPHEREx"
    ph["DETECTOR"] = (band, "SPHEREx detector band")
    ph["RELEASE"] = (meta.get("release") or "", "SPHEREx data release tag")
    ph["MATCHED"] = (bool(meta.get("matched")), "same bandpass in every pass")
    if meta.get("matched_channels"):
        ph["NCHAN"] = (len(meta["matched_channels"]), "channels averaged in every pass")
        ph["COMMENT"] = "Matched channels: " + ", ".join(meta["matched_channels"])
    ph["NPASS"] = len(meta["frames"])
    ph["BUNIT"] = meta.get("units", "MJy/sr")
    ph["COMMENT"] = "Built from SPHEREx level-2 images (IRSA / public S3 mirror). Row order: FITS (south up)."
    hdus = [prim]
    for f in meta["frames"]:
        for kind, key in (("IMAGE", "blob"), ("NOISE", "noise_blob"), ("COVERAGE", "coverage_blob")):
            if key not in f:
                continue
            arr = np.fromfile(_blob_dir() / f"{f[key]}.bin", dtype="<f4").reshape(h, w)[::-1]   # back to FITS rows
            e = afits.ImageHDU(arr, header=hdr.copy(), name=f"{kind}_{f['epoch_label']}")
            eh = e.header
            eh["BUNIT"] = "count" if kind == "COVERAGE" else meta.get("units", "MJy/sr")
            eh["EPOCH"] = (f["epoch_label"], "survey pass")
            eh["MJD-BEG"], eh["MJD-END"] = f["mjd_start"], f["mjd_end"]
            eh["MJD-AVG"] = (f.get("mjd_mean"), "mean exposure time")
            eh["NEXP"] = (f["n_exposures"], "exposures co-added")
            if f.get("lam_eff_um") is not None:
                eh["LAMEFF"] = (f["lam_eff_um"], "[um] effective wavelength at the target")
            if f.get("noise_scale") is not None:
                eh["NOISESCL"] = (f["noise_scale"], "factor applied to the co-add error map")
            if f.get("astrometry_rms_arcsec") is not None:
                eh["ASTRMS"] = (f["astrometry_rms_arcsec"], "[arcsec] Gaia star scatter about registration")
            hdus.append(e)
    manifest_bytes = json.dumps(meta, sort_keys=True).encode('utf-8')
    hdus.append(afits.ImageHDU(np.frombuffer(manifest_bytes, dtype=np.uint8), name='MANIFEST'))
    name = f"spherex_{band}{'_matched' if matched else ''}_{ra:.4f}_{dec:+.4f}.fits"
    path = _blob_dir() / f"{cache.cache_key('fits', ra, dec, fov, band + str(matched), meta.get('release') or '')}.fits"
    cache.atomic_fits(path, afits.HDUList(hdus))
    cache.lease([path])
    return FileResponse(path, media_type="application/fits", filename=name)


@app.get("/api/jobs/{job_id}", response_model=JobStatus, name="job_status")
def job_status(request: Request, job_id: str):
    if not re.fullmatch(r'[0-9a-f]{16}',job_id): return error('bad_request','Invalid job identifier')
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
    cache.lease([path])
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
            "flags_summary": {"flag_fraction": d.get("masked_fraction"), "target_flags": d.get("target_flags")},
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
    if meta is not None and cache.retain([_blob_dir()/f"{b}.bin" for b in _blob_ids(meta)]):
        return meta
    return None


def _get_product(key: str, build, progress=None) -> dict:
    """build(progress) -> (meta, arrays) or meta. Built once per key, even under concurrent requests."""
    with _lock(key), _admission():
        meta = _cached_product(key)
        if meta is None:
            res = build(progress)
            meta, arrays = res if isinstance(res, tuple) else (res, [])
            ids = [_save_blob(a) for a in arrays]
            meta = _swap_blobs(meta, lambda i: ("blob", ids[i]))
            from .provenance import manifest
            meta['provenance'] = manifest()
            if 'ra' in meta and 'dec' in meta:
                fov=meta.get('fov',DEFAULT_FOV)
                reports=[cache.get_json(cache.cache_key('retrieval',meta['ra'],meta['dec'],fov,str(d),spherex_client.data_version())) for d in range(1,7)]
                reports=[r for r in reports if r]
                meta['completeness']={'selection_policy':'bounded temporal sampling; not guaranteed exhaustive','detector_reports':reports,'failed':sum(r.get('failed',0) for r in reports) if reports else None}
                records=cache.get_json(cache.cache_key('exposures',meta['ra'],meta['dec'],fov,'',spherex_client.data_version()))
                meta['selected_input_records']=records
            meta['reliability'] = {'status':'exploratory', 'note':'Fits and candidate significance require independent checks; resampled pixels are correlated.'}
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
    cached_at_entry = meta is not None
    if meta is None and async_:
        result_url = str(request.url.include_query_params(**{"async": "0"}))

        def work(progress):
            _get_product(key, build, progress)
            return {"result_url": result_url, "retrieval": {"kind": "built", "processing": spherex_client.data_version()}}

        job = JOBS.submit(key, work, _classify, owner=request.client.host if request.client else "anonymous")
        body = job.public()
        body["status_url"] = str(request.url_for("job_status", job_id=job.id))
        return JSONResponse(body, status_code=202)
    if meta is None:
        meta = _get_product(key, build)
    cache.lease([_blob_dir()/f"{b}.bin" for b in _blob_ids(meta)])
    out = _swap_blobs(meta, lambda b: ("data", str(request.url_for("blob", blob_id=b))))
    out['retrieval'] = {'kind': 'server_cache' if cached_at_entry else 'built', 'processing':spherex_client.data_version()}
    return out


def _field(ra: float, dec: float, fov: float) -> list[dict]:
    """Gaia DR3 around the stamp (stamps are wider than fov), [] when Gaia is down."""
    half = spherex_client.stamp_size_px(fov) * cfg["pixel_scale_arcsec"] / 3600 / np.sqrt(2)
    try:
        return catalogs.gaia_query(ra, dec, round(half, 3),timeout=6)
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
            if sum(s.image.size for s in stamps)+sum(s.image.size for s in st) > cfg.get('limits',{}).get('max_native_pixels',16_000_000):
                raise pipeline.RequestTooLarge('The combined motion fit exceeds the per-job image budget. Select fewer detectors.')
            stamps += st
        if not stamps:
            raise pipeline.NoCoverage(f"No SPHEREx exposures cover RA {ra:.5f}, Dec {dec:.5f} in {det}.")
        track = photometry.track_for(ra, dec, pmra, pmdec, epoch)
        cat = {"pmra": pmra, "pmdec": pmdec, "catalog": "request"} if track.source == "request" else None
        m = motion.build_motion(stamps, bins, track, _field(ra, dec, DEFAULT_FOV), fit_parallax, cat)
        return {"ra": ra, "dec": dec, "det": ",".join(f"D{d}" for d in dets), **m}

    return _serve_product(request, key, build, async_)


@app.get("/api/stack", responses={202: {"model": JobStatus}})
def stack_view(request: Request, ra: float = RA, dec: float = DEC, fov: float = FOV, band: Band = "D6",
               pmra: float | None = PMRA, pmdec: float | None = PMDEC, epoch: float | None = EPOCH, async_: bool = ASYNC):
    """Shift-and-stack: every exposure of the band co-added in the frame moving with the target (proper motion
    from the request, or Gaia DR3 when the target matches it), next to the plain static stack, both centred on
    the target at the mean exposure time. A real mover sharpens (higher target_snr); field stars streak."""
    key = _product_key("stack", ra, dec, fov, band, pmra, pmdec, epoch, "v1")

    def build(progress):
        stamps, _ = pipeline.load_stamps(ra, dec, fov, band, progress)
        track = photometry.track_for(ra, dec, pmra, pmdec, epoch)
        if not (track.pmra or track.pmdec):
            raise pipeline.NoCoverage("No proper motion for this target: pass pmra/pmdec (e.g. from /api/resolve).")
        r = stack.shift_and_stack(stamps, track, fov)
        arrays = [r["static"].pop("array"), r["comoving"].pop("array")]
        r["static"]["blob"], r["comoving"]["blob"] = 0, 1
        return ({"ra": ra, "dec": dec, "fov": fov, "band": band, "units": cfg["image_unit"], "release": cfg["release_tag"],
                 "track": {"source": track.source, "pmra": track.pmra, "pmdec": track.pmdec, "gaia_id": track.gaia_id},
                 **r}, arrays)

    return _serve_product(request, key, build, async_)


@app.get("/api/movers", responses={202: {"model": JobStatus}})
def movers(request: Request, ra: float = RA, dec: float = DEC, fov: float = FOV, band: Band = "D6",
           max_pm: float = Query(12.0, gt=0, le=30, description="Largest proper motion searched, arcsec/yr"),
           snr_min: float = Query(5.0, ge=3, le=50, description="Detection threshold per pass frame, sigma"),
           async_: bool = ASYNC):
    """Discovery mode: every source tracked across passes, its fitted proper motion, and a Gaia DR3 cross-match.
    `candidates` = moving at > 5 sigma with no Gaia counterpart (e.g. WISE 0855 in D6). `null_test` = PM pulls of
    Gaia-matched field sources. Built from the same frames as /api/frames (shares their cache)."""
    key = _product_key("movers", ra, dec, fov, band, max_pm, snr_min, "v1")

    def build(progress):
        meta = _build_frames(ra, dec, fov, band, progress)
        load = lambda b: np.fromfile(_blob_dir() / f"{b}.bin", dtype="<f4").reshape(meta["wcs"]["height"], meta["wcs"]["width"])  # noqa: E731
        arrays = [load(f["blob"]) for f in meta["frames"]]
        noise = [load(f["noise_blob"]) for f in meta["frames"]]
        res = discovery.find_movers(meta["frames"], arrays, noise, pipeline.output_grid(ra, dec, fov), _field(ra, dec, fov),
                                    max_pm_arcsec_yr=max_pm, snr_min=snr_min)
        return {"ra": ra, "dec": dec, "fov": fov, "band": band, "release": cfg["release_tag"], **res}

    return _serve_product(request, key, build, async_)


@app.get("/api/overlay", response_model=OverlayResponse)
def overlay(ra: float = RA, dec: float = DEC, fov: float = FOV, cat: str = "gaia"):
    if cat != "gaia":
        return error("bad_request", f"Unknown catalogue '{cat}'. Supported: gaia")
    bins = pipeline.position_epochs(spherex_client.query_exposures(ra, dec, fov))
    epochs = [(f"E{i + 1}", (a + b) / 2) for i, (a, b) in enumerate(bins)]
    return {"catalog": "gaia_dr3", "sources": catalogs.gaia_sources(ra, dec, fov, epochs)}
