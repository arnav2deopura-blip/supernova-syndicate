"""FastAPI app. Routes only, no science logic. Owner: A.

Run: uvicorn backend.server:app --reload
"""
from __future__ import annotations

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import catalogs, photometry, spherex_client
from .config import get_config
from .schemas import (
    Band,
    ErrorResponse,
    ExposuresResponse,
    FramesResponse,
    OverlayResponse,
    ResolveResponse,
    SpectrumResponse,
)

cfg = get_config()
MAX_FOV = cfg["fov"]["max_deg"]
DEFAULT_FOV = cfg["fov"]["default_deg"]

app = FastAPI(title="SPHEREx Sky Explorer API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg["allowed_origins"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

ERRORS = {"bad_request": 400, "not_found": 404, "upstream_unavailable": 503, "not_implemented": 501}


def error(code: str, message: str) -> JSONResponse:
    return JSONResponse(ErrorResponse(error=code, message=message).model_dump(), status_code=ERRORS[code])


@app.exception_handler(NotImplementedError)
async def _not_implemented(_: Request, exc: NotImplementedError):
    return error("not_implemented", str(exc) or "Not built yet.")


@app.exception_handler(spherex_client.UpstreamError)
async def _upstream(_: Request, exc: spherex_client.UpstreamError):
    return error("upstream_unavailable", str(exc) or "IRSA is not responding.")


@app.exception_handler(RequestValidationError)
async def _bad_request(_: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", []))
    return error("bad_request", f"{where}: {first.get('msg', 'invalid request')}")


RA = Query(..., ge=0, lt=360, description="ICRS degrees")
DEC = Query(..., ge=-90, le=90, description="ICRS degrees")
FOV = Query(DEFAULT_FOV, gt=0, le=MAX_FOV, description="Cutout side, degrees")


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/resolve", response_model=ResolveResponse)
def resolve(name: str = Query(..., min_length=1)):
    return catalogs.resolve_name(name)


@app.get("/api/frames", response_model=FramesResponse)
def frames(ra: float = RA, dec: float = DEC, fov: float = FOV, band: Band = "D2"):
    raise NotImplementedError("Issue #7: /api/frames end to end")


@app.get("/api/exposures", response_model=ExposuresResponse)
def exposures(ra: float = RA, dec: float = DEC, fov: float = FOV):
    raise NotImplementedError("Issue #3: exposure listing")


@app.get("/api/spectrum", response_model=SpectrumResponse)
def spectrum(ra: float = RA, dec: float = DEC):
    return {"ra": ra, "dec": dec, "points": photometry.spectrum_at(ra, dec)}


@app.get("/api/overlay", response_model=OverlayResponse)
def overlay(ra: float = RA, dec: float = DEC, fov: float = FOV, cat: str = "gaia"):
    if cat != "gaia":
        return error("bad_request", f"Unknown catalogue '{cat}'. Supported: gaia")
    return {"catalog": "gaia_dr3", "sources": catalogs.gaia_sources(ra, dec, fov)}
