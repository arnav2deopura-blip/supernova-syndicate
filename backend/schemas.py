"""Response models: the API contract in code. Owner: A.

Must match docs/API.md and frontend/mock/. Change all three in one PR.
"""
from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import BaseModel, Field

Band = Literal["D1", "D2", "D3", "D4", "D5", "D6"]
ErrorCode = Literal["bad_request", "not_found", "upstream_unavailable", "not_implemented"]


class ErrorResponse(BaseModel):
    error: ErrorCode
    message: str


class ResolveResponse(BaseModel):
    name: str
    ra: float
    dec: float
    epoch: float = Field(description="Decimal year the position is valid for")
    pmra: Optional[float] = None
    pmdec: Optional[float] = None
    source: str


class WCSInfo(BaseModel):
    center_ra: float
    center_dec: float
    pixel_scale_arcsec: float
    width: int
    height: int


class Frame(BaseModel):
    epoch_label: str
    mjd_start: float
    mjd_end: float
    n_exposures: int
    width: int
    height: int
    data: Union[list[Optional[float]], str] = Field(
        description="Flat row-major array (row 0 = top, null = masked) or a URL to one"
    )
    flag_fraction: float
    # Additive (phase 1); optional so mocks without them stay valid.
    mjd_mean: Optional[float] = Field(None, description="Mean MJD of the exposures in this frame")
    lam_um: Optional[list[float]] = Field(None, description="Wavelength at the target in each exposure, um")
    lam_eff_um: Optional[float] = Field(None, description="Mean of lam_um")
    target_flags: Optional[list[str]] = Field(None, description="Flag names touching the target in any exposure")
    obs_ids: Optional[list[str]] = None


class FramesResponse(BaseModel):
    ra: float
    dec: float
    fov: float
    band: Band
    wcs: WCSInfo
    frames: list[Frame]
    units: str = "MJy/sr"
    release: Optional[str] = None


class FlagsSummary(BaseModel):
    flag_fraction: float
    target_flags: Optional[list[str]] = None


class Exposure(BaseModel):
    obs_id: str
    mjd: float
    detector: int = Field(ge=1, le=6)
    wavelength_um: Optional[float] = Field(None, description="At the target; null until the band is processed")
    epoch_label: str
    flags_summary: FlagsSummary
    url: str


class ExposuresResponse(BaseModel):
    exposures: list[Exposure]


class SpectrumPoint(BaseModel):
    wavelength_um: float
    flux: float
    flux_err: float
    epoch_label: str
    flagged: bool


class SpectrumResponse(BaseModel):
    ra: float
    dec: float
    points: list[SpectrumPoint]


class EpochPosition(BaseModel):
    epoch_label: str
    ra: float
    dec: float
    mjd: Optional[float] = Field(None, description="Time the position was propagated to (epoch mean MJD)")


class OverlaySource(BaseModel):
    id: str
    ra: float
    dec: float
    pmra: Optional[float] = None
    pmdec: Optional[float] = None
    mag: Optional[float] = None
    ref_epoch: Optional[float] = Field(None, description="Decimal year of ra/dec (Gaia DR3: 2016.0)")
    positions_by_epoch: list[EpochPosition]


class OverlayResponse(BaseModel):
    catalog: str
    sources: list[OverlaySource]


class JobStatus(BaseModel):
    job_id: str
    state: Literal["queued", "running", "done", "error"]
    stage: str = ""
    message: str = ""
    done: int = 0
    total: int = 0
    error: Optional[ErrorCode] = None
    created: float
    finished: Optional[float] = None
    result: Optional[dict] = None
    status_url: Optional[str] = None
