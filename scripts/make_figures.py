"""Figures for the validation doc and the Space Apps pitch, from the baked presets only (offline).

    python scripts/make_figures.py          # writes docs/img/*.png and docs/img/barnard_blink.gif

Reads frontend/precomputed/<slug>/ (run scripts/precompute.py first). Colours follow one fixed system:
passes take categorical slots in order (E1 blue, E2 orange, E3 aqua, E4 yellow) with a marker shape as the
second cue; difference images use the blue <-> red diverging pair around a neutral gray; sky images use one
gray ramp (faint = light, bright = dark).
"""
from __future__ import annotations

import io
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402
from PIL import Image  # noqa: E402

from backend import catalogs  # noqa: E402
from backend.image_alignment import target_wcs  # noqa: E402

PRE = ROOT / "frontend" / "precomputed"
OUT = ROOT / "docs" / "img"

# ---- design tokens (light; slides are light)
SURFACE, INK, INK2, MUTED, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
PASS_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"]
PASS_MARKERS = ["o", "s", "^", "D", "v", "P", "X"]
BLUE, ORANGE, RED, MID = "#2a78d6", "#eb6834", "#e34948", "#f0efec"
DIVERGING = LinearSegmentedColormap.from_list("bluered", [BLUE, MID, RED])
SIG_SOFT, SIG_MAX = 2.0, float(np.arcsinh(1000 / 2.0))   # difference colour scale: linear to ~2 sigma, log to 1000
SKY = LinearSegmentedColormap.from_list("sky", ["#fcfcfb", "#c3c2b7", "#52514e", "#0b0b0b"])

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "font.family": "sans-serif", "font.sans-serif": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
    "font.size": 10, "text.color": INK, "axes.labelcolor": INK2, "axes.edgecolor": AXIS,
    "xtick.color": MUTED, "ytick.color": MUTED, "axes.titlesize": 11, "axes.titleweight": "bold",
    "axes.titlelocation": "left", "axes.grid": False, "grid.color": GRID, "grid.linewidth": 0.6,
    "axes.spines.top": False, "axes.spines.right": False, "lines.linewidth": 1.5, "legend.frameon": False,
})

PRESETS = [("barnards-star", "Barnard's Star", "D2"), ("eps-indi-b", "ε Indi B", "D3"),
           ("wise-0855", "WISE 0855−0714", "D6"), ("rw-aur", "RW Aur", "D2"), ("r-dra", "R Dra", "D2")]


def jload(slug: str, name: str):
    p = PRE / slug / name
    return json.loads(p.read_text()) if p.exists() else None


def blob(rel: str, shape) -> np.ndarray:
    return np.fromfile(ROOT / "frontend" / rel, dtype="<f4").reshape(shape)


def frames(slug: str, name: str = "frames.json"):
    meta = jload(slug, name)
    if meta is None:
        return None, [], []
    shape = (meta["wcs"]["height"], meta["wcs"]["width"])
    data = [blob(f["data"], shape) for f in meta["frames"]]
    noise = [blob(f["noise"], shape) if f.get("noise") else None for f in meta["frames"]]
    return meta, data, noise


def target_px(meta: dict, resolve: dict, mjd: float) -> tuple[float, float]:
    """Target (column, row) in display orientation (row 0 = north) at mjd, from the resolve PM."""
    w = meta["wcs"]
    grid = target_wcs(w["center_ra"], w["center_dec"], meta["fov"], w["pixel_scale_arcsec"])
    ra, dec = resolve["ra"], resolve["dec"]
    if resolve.get("pmra") is not None:
        ra, dec = catalogs.propagate(ra, dec, resolve["pmra"], resolve["pmdec"], resolve["epoch"], catalogs.mjd_to_year(mjd))
    x, y = (float(v) for v in grid.all_world2pix(ra, dec, 0))
    return x, (w["height"] - 1) - y


def crop(a: np.ndarray, cx: float, cy: float, half: int) -> np.ndarray:
    ix, iy = int(round(cx)), int(round(cy))
    out = np.full((2 * half + 1, 2 * half + 1), np.nan, np.float32)
    h, w = a.shape
    y0, y1, x0, x1 = iy - half, iy + half + 1, ix - half, ix + half + 1
    sy0, sx0 = max(y0, 0), max(x0, 0)
    sy1, sx1 = min(y1, h), min(x1, w)
    out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = a[sy0:sy1, sx0:sx1]
    return out


def asinh_limits(arrs, lo=5.0, hi=99.7):
    v = np.concatenate([a[np.isfinite(a)].ravel() for a in arrs])
    return float(np.percentile(v, lo)), float(np.percentile(v, hi))


def show_sky(ax, a, lim):
    lo, hi = lim
    soft = max((hi - lo) * 0.05, 1e-6)
    z = np.arcsinh((np.clip(np.nan_to_num(a, nan=hi), lo, None) - lo) / soft) / np.arcsinh((hi - lo) / soft)
    ax.imshow(np.clip(z, 0, 1), cmap=SKY, vmin=0, vmax=1, origin="upper", interpolation="nearest")
    ax.set_xticks([]), ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)


def ring(ax, x, y, color, r=2.4, lw=1.6):
    ax.add_patch(plt.Circle((x, y), r, fill=False, ec=SURFACE, lw=lw + 2))   # 2px surface ring keeps it legible
    ax.add_patch(plt.Circle((x, y), r, fill=False, ec=color, lw=lw))


def first_ring(ax, x, y, r=1.6):
    ax.add_patch(plt.Circle((x, y), r, fill=False, ec=SURFACE, lw=3.0))
    ax.add_patch(plt.Circle((x, y), r, fill=False, ec=INK2, lw=1.1, ls=(0, (2, 2))))


def iso(mjd):
    from backend.releases import mjd_to_iso
    return mjd_to_iso(mjd)


# ------------------------------------------------------------------ 1. Barnard blink (slide 2)

def barnard_blink(half: int = 9, scale: int = 12):
    meta, data, _ = frames("barnards-star")
    res = jload("barnards-star", "resolve.json")
    pos = [target_px(meta, res, f["mjd_mean"]) for f in meta["frames"]]
    cx, cy = np.mean([p[0] for p in pos]), np.mean([p[1] for p in pos])
    crops = [crop(a, cx, cy, half) for a in data]
    lim = (asinh_limits(crops, 20, 99.9)[0], float(np.nanmax([np.nanmax(c) for c in crops])))
    images = []
    for k, (f, c) in enumerate(zip(meta["frames"], crops)):
        fig, ax = plt.subplots(figsize=(4.2, 4.6), dpi=110)
        show_sky(ax, c, lim)
        first_ring(ax, pos[0][0] - cx + half, pos[0][1] - cy + half)
        ring(ax, pos[k][0] - cx + half, pos[k][1] - cy + half, PASS_COLORS[k], r=1.6, lw=2.0)
        ax.set_title(f"Barnard's Star · SPHEREx {meta['band']} · {f['epoch_label']}  {iso(f['mjd_mean'])}", fontsize=10)
        ax.text(0.02, 0.02, f"{f['n_exposures']} exp · λ≈{f['lam_eff_um']:.2f} µm · ring: Gaia DR3 now, dashed: E1",
                transform=ax.transAxes, fontsize=7.5, color=INK2, va="bottom",
                bbox=dict(fc=SURFACE, ec="none", alpha=0.85, pad=2))
        ax.text(0.98, 0.98, f"{2 * half * meta['wcs']['pixel_scale_arcsec']:.0f}″", transform=ax.transAxes,
                fontsize=7.5, color=INK2, ha="right", va="top")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight")
        plt.close(fig)
        images.append(Image.open(io.BytesIO(buf.getvalue())).convert("P", palette=Image.ADAPTIVE))
    images[0].save(OUT / "barnard_blink.gif", save_all=True, append_images=images[1:], duration=900, loop=0)
    # static strip for print
    fig, axes = plt.subplots(1, len(crops), figsize=(3 * len(crops), 3.3), dpi=150)
    for k, (ax, f, c) in enumerate(zip(axes, meta["frames"], crops)):
        show_sky(ax, c, lim)
        first_ring(ax, pos[0][0] - cx + half, pos[0][1] - cy + half)
        ring(ax, pos[k][0] - cx + half, pos[k][1] - cy + half, PASS_COLORS[k], r=1.6, lw=2.0)
        ax.set_title(f"{f['epoch_label']} · {iso(f['mjd_mean'])}", fontsize=10)
    fig.suptitle("Barnard's Star moves 10.4″/yr north. Three SPHEREx passes (D2); ring = Gaia DR3 position at "
                 "that pass, dashed = where it was in E1",
                 x=0.01, ha="left", fontsize=11, fontweight="bold")
    fig.savefig(OUT / "barnard_strip.png", bbox_inches="tight")
    plt.close(fig)


# ------------------------------------------------------------------ 2. five presets: first, last, difference in sigma

def presets_difference(half: int = 20):
    fig, axes = plt.subplots(len(PRESETS), 3, figsize=(8.4, 2.9 * len(PRESETS)), dpi=150)
    for row, (slug, label, band) in zip(axes, PRESETS):
        meta, data, noise = frames(slug, f"frames_matched_{band}.json")
        res = jload(slug, "resolve.json")
        if meta is None or len(data) < 2:
            for ax in row:
                ax.axis("off")
            continue
        f0, f1 = meta["frames"][0], meta["frames"][-1]
        p0, p1 = target_px(meta, res, f0["mjd_mean"]), target_px(meta, res, f1["mjd_mean"])
        cx, cy = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
        a0, a1 = crop(data[0], cx, cy, half), crop(data[-1], cx, cy, half)
        lim = asinh_limits([a0, a1], 20, 99.8)
        for ax, a, f, p, c in ((row[0], a0, f0, p0, PASS_COLORS[0]), (row[1], a1, f1, p1, PASS_COLORS[len(data) - 1])):
            show_sky(ax, a, lim)
            ring(ax, p[0] - cx + half, p[1] - cy + half, c)
            ax.set_title(f"{label} · {f['epoch_label']} {iso(f['mjd_mean'])[:7]}", fontsize=9.5)
        n0, n1 = crop(noise[0], cx, cy, half), crop(noise[-1], cx, cy, half)
        with np.errstate(invalid="ignore", divide="ignore"):
            sig = (a1 - a0) / np.sqrt(n0 ** 2 + n1 ** 2)
        ax = row[2]
        im = ax.imshow(np.arcsinh(np.nan_to_num(sig) / SIG_SOFT), cmap=DIVERGING, vmin=-SIG_MAX, vmax=SIG_MAX,
                       origin="upper", interpolation="nearest")
        ring(ax, p0[0] - cx + half, p0[1] - cy + half, PASS_COLORS[0], lw=1.2)
        ring(ax, p1[0] - cx + half, p1[1] - cy + half, PASS_COLORS[len(data) - 1], lw=1.2)
        ax.set_xticks([]), ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
        ax.set_title(f"{f1['epoch_label']} − {f0['epoch_label']} in σ (asinh), λ {f0['lam_eff_um']:.2f} µm matched", fontsize=9.5)
        ticks = [-1000, -30, -5, 0, 5, 30, 1000]
        cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03, ticks=[float(np.arcsinh(t / SIG_SOFT)) for t in ticks])
        cb.ax.set_yticklabels([f"{t:+d}" if t else "0" for t in ticks])
        cb.outline.set_visible(False)
        cb.ax.tick_params(labelsize=7, colors=MUTED)
    fig.suptitle("Five test targets: first pass, last pass, and the difference in noise units\n"
                 "Movers leave a −/+ pair (blue = where it was, red = where it is); variables a single sign. "
                 f"Each crop {2 * half * 3.075:.0f}″.", x=0.01, ha="left", fontsize=10.5, fontweight="bold")
    fig.tight_layout(rect=(0, 0, 1, 0.975))
    fig.savefig(OUT / "presets_check.png", bbox_inches="tight")
    plt.close(fig)


# ------------------------------------------------------------------ 3. WISE 0855: 102-channel SED

BANDS = [(1.4, "H₂O"), (1.9, "H₂O"), (2.2, "CH₄"), (2.7, "H₂O"), (3.3, "CH₄"), (4.27, "CO₂"), (4.6, "CO")]


def channel_means(points):
    by = {}
    for p in points:
        if p.get("channel") and p["flux_err"] and p["flux_err"] > 0:
            by.setdefault(p["channel"], []).append(p)
    rows = []
    for ch, pts in by.items():
        good = [p for p in pts if not p["flagged"]] or pts
        w = np.array([1 / p["flux_err"] ** 2 for p in good])
        f = np.array([p["flux"] for p in good])
        rows.append((float(np.mean([p["wavelength_um"] for p in good])), float((w * f).sum() / w.sum()),
                     float(1 / math.sqrt(w.sum())), ch))
    return sorted(rows)


def wise_sed():
    sp = jload("wise-0855", "spectrum_all.json")
    if sp is None:
        return
    rows = channel_means(sp["points"])
    lam, f, e = (np.array([r[i] for r in rows]) for i in range(3))
    fig, ax = plt.subplots(figsize=(9, 4.2), dpi=150)
    from backend.config import get_config
    for i, (d, (lo, hi)) in enumerate(get_config()["bands"].items()):
        if i % 2 == 0:
            ax.axvspan(lo, hi, color=GRID, alpha=0.45, lw=0)
        ax.text((lo + hi) / 2, 0.97, d, transform=ax.get_xaxis_transform(), ha="center", va="top", fontsize=8, color=MUTED)
    for x, name in BANDS:
        ax.axvline(x, color=MUTED, lw=0.6, ls=(0, (2, 3)))
        ax.text(x, 0.88, name, transform=ax.get_xaxis_transform(), ha="center", va="top", fontsize=7.5, color=INK2,
                bbox=dict(fc=SURFACE, ec="none", pad=1))
    ax.axhline(0, color=AXIS, lw=0.8)
    ax.errorbar(lam, f, yerr=e, fmt="o", ms=4.5, color=BLUE, ecolor=BLUE, elinewidth=1, capsize=0,
                mec=SURFACE, mew=0.8)
    ax.set_xlabel("wavelength (µm)")
    ax.set_ylabel("flux density (µJy)")
    ax.set_xlim(0.72, 5.03)
    ax.set_ylim(min(-80, float(np.nanmin(f - e)) - 20), float(np.nanmax(f + e)) * 1.25)
    ax.grid(axis="y")
    ax.set_title("WISE 0855−0714, the coldest known brown dwarf, across all 102 SPHEREx channels")
    ax.text(0.01, -0.22, "Per-channel mean of forced ePSF photometry (230 exposures, 3 passes), Gaia neighbours "
            "fitted and removed. Dark below 3.8 µm, bright at 4–5 µm: a Y dwarf.", transform=ax.transAxes,
            fontsize=8, color=INK2)
    fig.tight_layout()
    fig.savefig(OUT / "wise0855_sed.png", bbox_inches="tight")
    plt.close(fig)


# ------------------------------------------------------------------ 4. discovery: WISE 0855 found as a mover not in Gaia

def discovery_figure():
    mv = jload("wise-0855", "movers_D6.json")
    meta, data, _ = frames("wise-0855")
    if mv is None or meta is None:
        return
    w = meta["wcs"]
    grid = target_wcs(w["center_ra"], w["center_dec"], meta["fov"], w["pixel_scale_arcsec"])

    def px(ra, dec):
        x, y = (float(v) for v in grid.all_world2pix(ra, dec, 0))
        return x, (w["height"] - 1) - y

    fig = plt.figure(figsize=(11, 4.6), dpi=150)
    gs = fig.add_gridspec(1, 3, width_ratios=[1, 1, 1.15], wspace=0.32)
    lim = asinh_limits([data[0], data[-1]], 20, 99.7)
    for col, k in enumerate((0, len(data) - 1)):
        ax = fig.add_subplot(gs[0, col])
        show_sky(ax, data[k], lim)
        for t in mv["tracks"]:
            p = [q for q in t["passes"] if q["epoch_label"] == meta["frames"][k]["epoch_label"]]
            if not p:
                continue
            x, y = px(p[0]["ra"], p[0]["dec"])
            if t["status"] == "candidate":
                ring(ax, x, y, ORANGE, r=3.2, lw=2.0)
                xs, ys = zip(*[px(q["ra"], q["dec"]) for q in t["passes"]])
                ax.plot(xs, ys, color=ORANGE, lw=1.2)
                ax.annotate("not in Gaia, moving", (x, y), xytext=(x - 4, y + 16), fontsize=8, color=INK,
                            ha="center", bbox=dict(fc=SURFACE, ec="none", alpha=0.9, pad=1.5),
                            arrowprops=dict(arrowstyle="-", color=INK2, lw=0.7))
            elif t["status"] == "known_mover":
                ring(ax, x, y, BLUE, r=3.0, lw=1.6)
            else:
                ax.add_patch(plt.Circle((x, y), 2.2, fill=False, ec=MUTED, lw=0.6))
        f = meta["frames"][k]
        ax.set_title(f"D6 {f['epoch_label']} · {iso(f['mjd_mean'])}", fontsize=10)
    # pulls of Gaia-matched field sources across every preset: the ensemble null test
    pulls = []
    for slug, _, band in PRESETS:
        m = jload(slug, f"movers_{band}.json")
        for t in (m or {}).get("tracks", []):
            g = t.get("gaia")
            if g and g.get("pmra") is not None and t["pm_err"] > 0:
                pulls += [(t["pmra"] - g["pmra"]) / t["pm_err"], (t["pmdec"] - g["pmdec"]) / t["pm_err"]]
    ax = fig.add_subplot(gs[0, 2])
    if pulls:
        pulls = np.clip(pulls, -6, 6)
        ax.hist(pulls, bins=np.arange(-6, 6.01, 0.5), color=BLUE, ec=SURFACE, lw=1.0)
        xs = np.linspace(-6, 6, 200)
        ax.plot(xs, len(pulls) * 0.5 * np.exp(-xs ** 2 / 2) / math.sqrt(2 * math.pi), color=INK, lw=1.2)
        rs = 1.4826 * float(np.median(np.abs(np.asarray(pulls) - np.median(pulls))))
        ax.text(0.97, 0.95, f"{len(pulls) // 2} Gaia stars, 5 fields\nrobust width {rs:.2f}\n(1.00 = honest errors)",
                transform=ax.transAxes, ha="right", va="top", fontsize=8, color=INK2)
        ax.text(1.6, len(pulls) * 0.5 * 0.24 / math.sqrt(2 * math.pi) * 2.0, "unit Gaussian", fontsize=7.5, color=INK)
    ax.set_xlabel("(SPHEREx − Gaia) proper motion / error")
    ax.set_ylabel("components")
    ax.set_title("Null test: field stars", fontsize=10)
    ax.grid(axis="y")
    cand = next((t for t in mv["tracks"] if t["status"] == "candidate"), None)
    sub = (f"Candidate μ = ({cand['pmra'] / 1000:.1f}, {cand['pmdec'] / 1000:.1f}) ± {cand['pm_err'] / 1000:.1f}″/yr, "
           f"{cand['pm_sigma']:.0f}σ; SIMBAD (−8.1, +0.7)″/yr." if cand else "")
    fig.suptitle("Discovery mode rediscovers WISE 0855−0714: the only moving source in the field that Gaia lacks.\n"
                 + sub, x=0.01, ha="left", fontsize=10.5, fontweight="bold", y=1.02)
    fig.savefig(OUT / "discovery_wise0855.png", bbox_inches="tight")
    plt.close(fig)


# ------------------------------------------------------------------ 5. proper motions vs catalogue

def motion_figure():
    rows = []
    for slug, label, fname in (("eps-indi-b", "ε Indi B · D3", "motion_D3.json"),
                               ("wise-0855", "WISE 0855 · D6", "motion_D6.json"),
                               ("barnards-star", "Barnard · D5+D6", "motion_D5-D6.json"),
                               ("barnards-star", "Barnard · D2 (saturated)", "motion_D2.json")):
        m = jload(slug, fname)
        if not m:
            continue
        ref = m.get("gaia") or m.get("catalog")
        if not ref:
            continue
        f = m["fit"]
        rows.append((label, f["pm_total"] / ref["pm_total"], f["pm_total_err"] / ref["pm_total"],
                     ((f["pa_deg"] - ref["pa_deg"] + 180) % 360) - 180, f["pa_err_deg"], ref["catalog"]))
    if not rows:
        return
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(9, 0.75 * len(rows) + 1.4), dpi=150, sharey=True)
    y = np.arange(len(rows))[::-1]
    for ax, i, ei, ref, xl in ((a1, 1, 2, 1.0, "SPHEREx speed / catalogue speed"),
                               (a2, 3, 4, 0.0, "direction difference (°)")):
        ax.axvline(ref, color=AXIS, lw=1)
        ax.errorbar([r[i] for r in rows], y, xerr=[r[ei] for r in rows], fmt="o", ms=6, color=BLUE, ecolor=BLUE,
                    elinewidth=1.4, capsize=0, mec=SURFACE, mew=1)
        ax.set_xlabel(xl)
        ax.grid(axis="x")
        ax.spines["left"].set_visible(False)
        ax.tick_params(axis="y", length=0)
    a1.set_yticks(y, [f"{r[0]}  ({'Gaia DR3' if r[5] == 'gaia_dr3' else 'SIMBAD'})" for r in rows], color=INK, fontsize=9)
    a1.set_title("Proper motion measured from SPHEREx alone (±1σ)")
    fig.tight_layout()
    fig.savefig(OUT / "motion_validation.png", bbox_inches="tight")
    plt.close(fig)


# ------------------------------------------------------------------ 6. matched wavelengths

def matched_figure():
    fig, ax = plt.subplots(figsize=(8.4, 3.6), dpi=150)
    labels = []
    for i, (slug, label, band) in enumerate(PRESETS):
        plain, matched = jload(slug, "frames.json"), jload(slug, f"frames_matched_{band}.json")
        if not plain or not matched:
            continue
        yv = len(PRESETS) - 1 - i
        ref = float(np.mean([f["lam_eff_um"] for f in matched["frames"]]))
        lp = [(f["lam_eff_um"] - ref) * 1000 for f in plain["frames"]]
        lm = [(f["lam_eff_um"] - ref) * 1000 for f in matched["frames"]]
        ax.plot([min(lp), max(lp)], [yv + 0.17] * 2, color=GRID, lw=6, solid_capstyle="round", zorder=1)
        ax.plot([min(lm), max(lm)], [yv - 0.17] * 2, color="#b7d3f6", lw=6, solid_capstyle="round", zorder=1)
        for k, (a, b) in enumerate(zip(lp, lm)):
            ax.plot(a, yv + 0.17, PASS_MARKERS[k], ms=7, mfc=SURFACE, mec=INK2, mew=1.3, zorder=3)
            ax.plot(b, yv - 0.17, PASS_MARKERS[k], ms=7, color=BLUE, mec=SURFACE, mew=0.9, zorder=3)
        labels.append((yv, f"{label} · {band}", f"{max(lp) - min(lp):.0f} nm  →  {max(lm) - min(lm):.0f} nm".replace("→", "to")))
    ax.axvline(0, color=AXIS, lw=0.8, zorder=0)
    ax.set_yticks([v for v, _, _ in labels], [t for _, t, _ in labels], fontsize=9, color=INK)
    ax.tick_params(axis="y", length=0)
    ax.spines["left"].set_visible(False)
    ax.set_ylim(-0.6, len(PRESETS) - 0.4)
    ax2 = ax.twinx()   # right-hand text column only (no second scale): the spread per target
    ax2.set_ylim(ax.get_ylim())
    ax2.set_yticks([v for v, _, _ in labels], [t for _, _, t in labels], fontsize=8.5, color=INK2)
    ax2.tick_params(axis="y", length=0)
    for sp in ax2.spines.values():
        sp.set_visible(False)
    ax.set_xlabel("pass wavelength at the target minus the matched mean (nm)")
    ax.grid(axis="x")
    ax.set_title("Matched-wavelength frames: every pass sees the same colour")
    ax.text(0.0, -0.32, "Gray hollow = plain detector co-add (each pass samples a different channel mix). Blue = matched "
            "(only channels seen in every pass, equal weight).\nMarker shape = pass: circle E1, square E2, triangle E3, "
            "diamond E4. Right: spread between passes, plain to matched.", transform=ax.transAxes, fontsize=7.5, color=INK2)
    fig.tight_layout()
    fig.savefig(OUT / "matched_wavelengths.png", bbox_inches="tight")
    plt.close(fig)


# ------------------------------------------------------------------ 7. RW Aur light curve

def rwaur_lightcurve():
    lc = jload("rw-aur", "lightcurve_D2.json")
    if not lc:
        return
    fig, ax = plt.subplots(figsize=(7.2, 3.6), dpi=150)
    from datetime import datetime, timedelta
    to_dt = lambda m: datetime(1858, 11, 17) + timedelta(days=m)   # noqa: E731
    for s in (lc.get("comparison_stars") or {}).get("stars", []):
        ax.plot([to_dt(b["mjd"]) for b in s["bins"]], [b["scale"] for b in s["bins"]], color=AXIS, lw=1, zorder=1)
    ax.axhline(1.0, color=AXIS, lw=0.8)
    b = lc["bins"]
    ax.errorbar([to_dt(x["mjd"]) for x in b], [x["scale"] for x in b], yerr=[x["scale_err"] for x in b], fmt="-o",
                color=BLUE, ms=7, mec=SURFACE, mew=1, elinewidth=1.4, capsize=0, zorder=3)
    for x in b:
        ax.annotate(x["label"], (to_dt(x["mjd"]), x["scale"]), xytext=(9, -3), textcoords="offset points",
                    ha="left", fontsize=8.5, color=INK2)
    ax.text(to_dt(b[-1]["mjd"]), 0.985, "8 Gaia comparison stars", fontsize=7.5, color=MUTED, ha="right", va="top")
    ax.set_ylabel("brightness / mean (D2, template fit)")
    ax.grid(axis="y")
    ax.set_title(f"RW Aurigae brightens {100 * (b[-1]['scale'] / b[0]['scale'] - 1):.0f}% between passes; "
                 "field stars stay flat")
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(OUT / "rwaur_lightcurve.png", bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for fn in (barnard_blink, presets_difference, wise_sed, discovery_figure, motion_figure, matched_figure,
               rwaur_lightcurve):
        fn()
        print("ok", fn.__name__)
    for p in sorted(OUT.glob("*")):
        print(f"  {p.relative_to(ROOT)}  {p.stat().st_size / 1024:.0f} KB")
