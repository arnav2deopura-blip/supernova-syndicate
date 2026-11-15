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


class FrameChannel(BaseModel):
    channel: str = Field(description="e.g. D6C13")
    n_exposures: int
    lam_target_um: float = Field(description="Mean wavelength at the target of this channel's exposures in this pass")


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
    # matched=1 only
    n_exposures_dropped: Optional[int] = Field(None, description="Exposures in this pass whose channel is not "
                                               "observed in every pass, left out to keep the bandpass the same")
    channels: Optional[list[FrameChannel]] = Field(None, description="Channels averaged (equal weight) into this frame")


class FramesResponse(BaseModel):
    ra: float
    dec: float
    fov: float
    band: Band
    wcs: WCSInfo
    frames: list[Frame]
    units: str = "MJy/sr"
    release: Optional[str] = None
    matched: Optional[bool] = Field(None, description="True when built with matched=1")
    matched_channels: Optional[list[str]] = Field(None, description="Channels present in every pass (matched=1)")
    lam_eff_um: Optional[float] = Field(None, description="Mean centre wavelength of matched_channels (matched=1)")


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
    # Additive (item 1); optional so the mock stays valid.
    bandwidth_um: Optional[float] = None
    channel: Optional[str] = Field(None, description="e.g. D2C07, from the wavelength at the target")
    mjd: Optional[float] = None
    obs_id: Optional[str] = None
    detector: Optional[int] = None
    fit: Optional[Literal["forced", "psf", "wing", "failed"]] = None
    flags: Optional[list[str]] = None
    blend: Optional[list[str]] = Field(None, description="Gaia sources within 2 native px (12\") of the target")
    n_deblended: Optional[int] = Field(None, description="Gaia neighbours fitted together with the target (forced fits)")


class RatioPoint(BaseModel):
    channel: str
    lam_um: float
    ratio: float
    ratio_err: float
    passes: list[str] = Field(description="[numerator pass, denominator pass]")
    flagged: bool


class SpectrumResponse(BaseModel):
    ra: float
    dec: float
    points: list[SpectrumPoint]
    track: Optional[dict] = None
    ratio: Optional[list[RatioPoint]] = None


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


# ---------------------------------------------------------------- items 3-5 (additive)

class CubeFrame(BaseModel):
    epoch_label: str
    data: Union[list[Optional[float]], str] = Field(description="Flat row-major array (row 0 = top) or a URL to one")
    n_exposures: int
    coverage: float = Field(description="Fraction of the output grid with data")
    lam_target_um: float
    mjd_mean: float
    target_value: Optional[float] = Field(None, description="Mean of the 3x3 box at the target, MJy/sr")
    target_flags: list[str] = []
    obs_ids: list[str] = []


class CubeChannel(BaseModel):
    channel: str = Field(description="e.g. D6C03")
    subchan: int
    lam_um: float = Field(description="Channel centre wavelength")
    lam_min: float
    lam_max: float
    R: float
    n_exposures: int
    # all-passes cube (per_pass=0)
    data: Union[list[Optional[float]], str, None] = Field(None, description="Flat array or URL, as in /frames")
    coverage: Optional[float] = None
    lam_target_um: Optional[float] = None
    mjd_mean: Optional[float] = None
    passes: Optional[list[str]] = None
    target_value: Optional[float] = None
    target_flags: Optional[list[str]] = None
    obs_ids: Optional[list[str]] = None
    # per-pass cube (per_pass=1)
    frames: Optional[list[CubeFrame]] = None


class CubeResponse(BaseModel):
    ra: float
    dec: float
    fov: float
    det: Band
    units: str
    release: Optional[str] = None
    wcs: WCSInfo
    per_pass: bool
    strict: bool
    channel_at: Literal["field_centre", "pixel"]
    display_range: Optional[list[float]] = Field(None, description="[lo, hi] stretch shared by every channel")
    fast_movers: Optional[list[dict]] = None
    recommend_per_pass: bool
    n_stamps: int
    channels: list[CubeChannel]


class LightCurveBin(BaseModel):
    mjd: float
    mjd_start: float
    mjd_end: float
    scale: float
    scale_err: float
    n: int
    lam_min: float
    lam_max: float
    label: Optional[str] = None


class LightCurveResponse(BaseModel):
    ra: float
    dec: float
    det: Band
    method: Literal["template", "channel"]
    units: str = "uJy"
    bin_days: float
    systematic_floor: float
    track: dict
    used_flagged: bool
    n_points: int
    n_used: int
    template: list[dict]
    points: list[dict]
    bins: list[LightCurveBin]
    chi2_constant: Optional[float] = None
    dof: int
    variable: Optional[bool] = None
    reliable: Optional[bool] = Field(None, description="False when point errors are too large (deep saturation)")
    median_frac_err: Optional[float] = None
    shape_changed: bool
    bin_slopes: list[dict] = []
    comparison_stars: Optional[dict] = None
    channel: Optional[str] = None
    channel_curve: Optional[list[dict]] = None
    period: Optional[dict] = None
    note: Optional[str] = None


class MotionFit(BaseModel):
    t0: float
    ra0: float
    dec0: float
    pos_err_mas: float
    pmra: float
    pmra_err: float
    pmdec: float
    pmdec_err: float
    pm_corr: float
    pm_total: float
    pm_total_err: float
    pa_deg: float
    pa_err_deg: float
    parallax_mode: Literal["fit", "gaia_fixed", "ignored"]
    parallax: Optional[float] = None
    parallax_err: Optional[float] = None
    chi2_dof: float
    n: int
    n_clipped: int
    bootstrap: Optional[dict] = None


class MotionResponse(BaseModel):
    ra: float
    dec: float
    det: str
    target: dict
    prior: dict
    exposures: list[dict]
    passes: list[dict]
    fit: MotionFit
    units: dict
    gaia: Optional[dict] = None
    catalog: Optional[dict] = None
