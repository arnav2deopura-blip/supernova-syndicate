"""ePSF model and star fitting on native-pixel SPHEREx stamps. Owner: B. Shared by photometry (items 1, 4)
and astrometry (item 5).

The EPSF HDU holds 33x33 effective PSFs oversampled OVSMPX=5x relative to *native* pixels, so one ePSF
sample is 6.15"/5 = 1.23" (checked: the ePSF's FWHM is ~5-6 samples = ~1.1 native px ~ PSF_FWHM 7.5").
An ePSF value at offset (dx, dy) is proportional to the fraction of a star's flux landing in a native pixel
whose centre is (dx, dy) native px from the star; `EPSFModel` normalises that to unit total flux.
Orientation: ePSF, CHANNEL_MAP and L2 images are all in 'sky' detector coordinates (DETCOORD='sky').

The PSF is barely sampled (FWHM ~1.2 px), so:
* never locate a star with argmax (saturated cores hold NaNs); start from a flux-weighted centroid;
* a saturated star is fit on its wings with the core masked (OVERFLOW / SUR_ERROR / NONLINEAR / NaN).
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy.interpolate import RectBivariateSpline
from scipy.optimize import least_squares

MODEL_ERROR_FRAC = 0.03   # PSF-model error, as a fraction of each pixel's model value (added in quadrature)
SUSPECT_ERROR_FRAC = 0.10  # extra error on SUR_ERROR / TRANSIENT pixels, as a fraction of the pixel value


class EPSFModel:
    def __init__(self, epsf: np.ndarray, oversample: int = 5):
        d = np.asarray(epsf, float)
        d = np.where(np.isfinite(d), d, 0.0)
        self.n = d.shape[0]
        self.os = int(oversample)
        self.c = (self.n - 1) / 2.0
        g = np.arange(self.n, dtype=float)
        self._spl = RectBivariateSpline(g, g, d, kx=3, ky=3)   # (y, x)
        self.half_native = self.c / self.os                      # model support radius, native px
        # unit total flux: average native-grid sum over sub-pixel phases
        sums = []
        for py in np.linspace(-0.4, 0.4, 3):
            for px in np.linspace(-0.4, 0.4, 3):
                k = np.arange(-int(self.half_native) - 1, int(self.half_native) + 2)
                yy, xx = np.meshgrid(k + py, k + px, indexing="ij")
                sums.append(self._raw(xx, yy).sum())
        self._norm = float(np.mean(sums)) or 1.0

    def _raw(self, dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
        u = self.c + np.asarray(dx, float) * self.os
        v = self.c + np.asarray(dy, float) * self.os
        out = self._spl.ev(v, u)
        out[(u < 0) | (u > self.n - 1) | (v < 0) | (v > self.n - 1)] = 0.0
        return out

    def evaluate(self, xx: np.ndarray, yy: np.ndarray, x: float, y: float) -> np.ndarray:
        """Fraction of a unit-flux star at (x, y) falling in native pixels centred at (xx, yy)."""
        return self._raw(xx - x, yy - y) / self._norm

    def fwhm_native(self) -> float:
        """FWHM of the ePSF in native px (mean of x and y cuts through the peak)."""
        k = np.linspace(-3, 3, 601)
        cx = self._raw(k, np.zeros_like(k))
        cy = self._raw(np.zeros_like(k), k)
        f = [np.ptp(k[c >= c.max() / 2]) for c in (cx, cy)]
        return float(np.mean(f))

    @classmethod
    def gaussian(cls, fwhm_px: float = 1.22, oversample: int = 5, n: int = 33) -> "EPSFModel":
        """Stand-in when a stamp has no EPSF HDU (and for tests): pixel-integrated Gaussian."""
        s = fwhm_px / 2.3548
        k = (np.arange(n) - (n - 1) / 2) / oversample
        from scipy.special import erf
        def integ(c):  # noqa: E306 - flux in a unit native pixel centred at offset c
            return 0.5 * (erf((c + 0.5) / (np.sqrt(2) * s)) - erf((c - 0.5) / (np.sqrt(2) * s)))
        g = np.outer(integ(k), integ(k))
        return cls(g / g.sum(), oversample)


def fit_masks(stamp) -> dict:
    """fit_star keyword masks for a PreparedStamp: hard-bad pixels (rejected for reasons other than saturation
    or the suspect flags), the saturated core, and suspect pixels. Missing masks are treated as clean."""
    def m(name):
        a = getattr(stamp, name, None)
        return np.zeros(stamp.image.shape, bool) if a is None else a
    return {"bad": m("reject") & ~m("saturated") & ~m("suspect"), "saturated": m("saturated"),
            "suspect": m("suspect"), "noise": stamp.bkg_rms}


def model_for(stamp) -> EPSFModel:
    if getattr(stamp, "epsf", None) is not None:
        return EPSFModel(stamp.epsf, getattr(stamp, "epsf_oversample", 5))
    return EPSFModel.gaussian()


def centroid(image: np.ndarray, x: float, y: float, r: float = 2.0) -> tuple[float, float]:
    """Flux-weighted centroid of positive pixels within r of (x, y); NaNs ignored. Falls back to (x, y)."""
    ny, nx = image.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    m = (np.hypot(xx - x, yy - y) <= r) & np.isfinite(image)
    w = np.clip(np.where(m, image, 0.0), 0, None)
    if w.sum() <= 0:
        return x, y
    return float((w * xx).sum() / w.sum()), float((w * yy).sum() / w.sum())


@dataclass
class StarFit:
    x: float
    y: float
    flux: float              # image units x pixels (MJy/sr summed); multiply by pixel solid angle for Jy
    bkg: float
    x_err: float
    y_err: float
    flux_err: float
    chi2r: float
    npix: int
    wing: bool               # core masked (saturated star)
    fixed_position: bool
    ok: bool = True
    cov_xy: float = 0.0
    n_core_masked: int = 0
    notes: list[str] = field(default_factory=list)
    others_flux: list[float] = field(default_factory=list)   # fitted fluxes of `others` that overlap the fit


def fit_star(image: np.ndarray, variance: Optional[np.ndarray], model: EPSFModel, x0: float, y0: float,
             bad: Optional[np.ndarray] = None, saturated: Optional[np.ndarray] = None, radius: float = 3.0,
             fix_position: bool = False, max_shift: float = 2.0, noise: Optional[float] = None,
             suspect: Optional[np.ndarray] = None, dilate_core: bool = False,
             others: Optional[list[tuple[float, float]]] = None) -> StarFit:
    """Fit flux + local background (+ position unless fix_position) of one star near (x0, y0).

    * Pixels within `radius` native px are used, minus NaNs and `bad` pixels.
    * `saturated` pixels within 1.5 px of the star make this a wing fit: those are masked, the radius grows
      by 1 px, and the result is marked `wing`.
    * Weights: VARIANCE (or `noise`^2) plus a 3% PSF-model error; `suspect` pixels get another 10% of their
      value. The position fit uses a soft-L1 loss, so a cosmic ray in the box can't drag the star.
      Errors come from the covariance, scaled by sqrt(chi2r) when chi2r > 1.
    * `others` (fix_position only): known neighbours at fixed pixel positions, fitted at the same time with free
      fluxes, so light from a star a few arcsec away is not counted as the target's. The target's flux error
      then includes the degeneracy between the two (a neighbour < 1 px away inflates it honestly).
    """
    ny, nx = image.shape
    img = np.asarray(image, float)
    var = np.asarray(variance, float) if variance is not None else np.full(img.shape, np.nan)
    floor = noise ** 2 if noise is not None and np.isfinite(noise) and noise > 0 else np.nanmedian(var[np.isfinite(var)]) if np.isfinite(var).any() else 1.0
    var = np.where(np.isfinite(var) & (var > 0), var, floor)
    if suspect is not None:
        var = var + np.where(suspect, (SUSPECT_ERROR_FRAC * np.nan_to_num(np.abs(img))) ** 2, 0.0)

    yy, xx = np.mgrid[0:ny, 0:nx]
    wing = False
    core = np.zeros(img.shape, bool)
    if saturated is not None:
        core = saturated & (np.hypot(xx - x0, yy - y0) <= 1.6)
    nan_core = ~np.isfinite(img) & (np.hypot(xx - x0, yy - y0) <= 1.6)
    if core.any() or nan_core.any():
        wing = True
        radius += 1.0
        if dilate_core:  # the ring next to a clipped core is often nonlinear without being flagged
            from scipy.ndimage import binary_dilation
            core = binary_dilation(core | nan_core) & (np.hypot(xx - x0, yy - y0) <= 2.6)
    use = (np.hypot(xx - x0, yy - y0) <= radius) & np.isfinite(img) & ~core
    if bad is not None:
        use &= ~bad
    if saturated is not None:
        use &= ~saturated
    n_core = int(core.sum() + nan_core.sum())
    xs, ys, d, v = xx[use].astype(float), yy[use].astype(float), img[use], var[use]
    npar = 2 if fix_position else 4
    if len(d) < npar + 3:
        return StarFit(x0, y0, np.nan, np.nan, np.nan, np.nan, np.nan, np.nan, int(len(d)), wing, fix_position,
                       ok=False, n_core_masked=n_core, notes=["too few usable pixels"])

    def linear(x, y):
        p = model.evaluate(xs, ys, x, y)
        A = np.c_[p, np.ones_like(p)]
        sig = np.sqrt(v)
        sol, *_ = np.linalg.lstsq(A / sig[:, None], d / sig, rcond=None)
        return sol, p

    if fix_position:
        p = model.evaluate(xs, ys, x0, y0)
        # neighbours that put >= 2% of their light into the fitted pixels; the rest can't bias the target
        cols = [q for q in (model.evaluate(xs, ys, ox, oy) for ox, oy in (others or [])) if q.sum() >= 0.02]
        M = np.c_[[p] + cols].T if cols else p[:, None]               # model columns: target, neighbours
        X = np.c_[M, np.ones_like(p)]
        sig2 = v
        for _ in range(3):  # solve, then re-weight with the model error term
            A = X / np.sqrt(sig2)[:, None]
            sol, *_ = np.linalg.lstsq(A, d / np.sqrt(sig2), rcond=None)
            sig2 = v + (MODEL_ERROR_FRAC * np.clip(M @ sol[:-1], 0, None)) ** 2
        A = X / np.sqrt(sig2)[:, None]
        sol, *_ = np.linalg.lstsq(A, d / np.sqrt(sig2), rcond=None)
        flux, bkg = sol[0], sol[-1]
        resid = (d - X @ sol) / np.sqrt(sig2)
        cov = np.linalg.pinv(A.T @ A)
        chi2r = float((resid ** 2).sum() / max(len(d) - X.shape[1], 1))
        s = max(1.0, chi2r)
        return StarFit(x0, y0, float(flux), float(bkg), 0.0, 0.0, float(np.sqrt(cov[0, 0] * s)), chi2r, len(d),
                       wing, True, n_core_masked=n_core, others_flux=[float(f) for f in sol[1:-1]])

    (f0, b0), _ = linear(x0, y0)
    f0 = max(f0, 1e-6)
    sig2_holder = [v.copy()]

    def resid(q):
        x, y, f, b = q
        p = model.evaluate(xs, ys, x, y)
        return (d - f * p - b) / np.sqrt(sig2_holder[0])

    lo = [x0 - max_shift, y0 - max_shift, -np.inf, -np.inf]
    hi = [x0 + max_shift, y0 + max_shift, np.inf, np.inf]
    q = np.array([x0, y0, f0, b0])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for _ in range(2):
            r = least_squares(resid, q, bounds=(lo, hi), x_scale=[0.1, 0.1, abs(f0) + 1e-6, np.sqrt(np.median(v))],
                              loss="soft_l1", f_scale=3.0)
            q = r.x
            p = model.evaluate(xs, ys, q[0], q[1])
            sig2_holder[0] = v + (MODEL_ERROR_FRAC * np.clip(q[2] * p, 0, None)) ** 2
        r = least_squares(resid, q, bounds=(lo, hi), x_scale=[0.1, 0.1, abs(q[2]) + 1e-6, np.sqrt(np.median(v))],
                          loss="soft_l1", f_scale=3.0)
    J = r.jac
    chi2r = float((resid(r.x) ** 2).sum() / max(len(d) - 4, 1))
    try:
        cov = np.linalg.inv(J.T @ J) * max(1.0, chi2r)
    except np.linalg.LinAlgError:
        cov = np.full((4, 4), np.nan)
    x, y, f, b = r.x
    notes = []
    at_edge = abs(x - x0) > max_shift - 1e-3 or abs(y - y0) > max_shift - 1e-3
    if at_edge:
        notes.append("position hit the search limit")
    return StarFit(float(x), float(y), float(f), float(b), float(np.sqrt(cov[0, 0])), float(np.sqrt(cov[1, 1])),
                   float(np.sqrt(cov[2, 2])), chi2r, len(d), wing, False, ok=bool(r.success) and not at_edge,
                   cov_xy=float(cov[0, 1]), n_core_masked=n_core, notes=notes)


def render(model: EPSFModel, shape: tuple[int, int], x: float, y: float, flux: float) -> np.ndarray:
    """Image of a star (for synthetic tests and residual checks)."""
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    return flux * model.evaluate(xx.astype(float), yy.astype(float), x, y).reshape(shape)
