"""Direct access to the public SPHEREx S3 mirror. Owner: A.

Why this exists: IRSA's TAP/SIA services were down for hours on 14 Nov 2026, while the S3
mirror stayed up. S3 has no spatial index, so we provide two things here:

1. A *coarse pointing index* (backend/data/coarse_index.json.gz, built by
   scripts/build_coarse_index.py): a sample of detector-1 pointings for every week folder.
   It tells us which folders could cover a position.
2. A *fine scan*: read only the IMAGE headers (first ~40 KB, one range request) of the
   candidate folders' files to find the exposures that put the target on-chip.

Stamps are cut with byte-range reads of IMAGE/FLAGS/VARIANCE/ZODI, never the whole 65 MB file.
See docs/SPHEREX_DATA_NOTES.md for the file layout this relies on.
"""
from __future__ import annotations

import gzip
import json
import math
import re
import threading
import warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from . import cache
from .config import get_config

warnings.simplefilter("ignore", FITSFixedWarning)

COARSE_INDEX = Path(__file__).with_name("data") / "coarse_index.json.gz"
DET_SIZE = 2040
FNAME_RE = re.compile(r"level2_(?P<week>\d{4}W\d{2}_\w{2})_(?P<obs>\d{4})_(?P<exp>\d)D(?P<det>\d)_spx_(?P<proc>[\w.-]+)\.fits$")

Progress = Optional[Callable[[str, int, int], None]]


class S3Error(RuntimeError):
    pass


# ---------------------------------------------------------------- HTTP plumbing

_session_lock = threading.Lock()
_shared: Optional[requests.Session] = None
_pool: Optional[ThreadPoolExecutor] = None


def _session() -> requests.Session:
    """One process-wide session: connections (and TLS handshakes) are reused across threads and calls.
    Per-thread sessions in short-lived pools made every folder re-handshake ~50 connections."""
    global _shared
    with _session_lock:
        if _shared is None:
            d = get_config()["download"]
            retry = Retry(total=d["retries"], connect=d["retries"], read=d["retries"], backoff_factor=0.5,
                          status_forcelist=(429, 500, 502, 503, 504), allowed_methods=("GET", "HEAD"))
            s = requests.Session()
            n = max(d.get("header_workers", 32), d.get("max_workers", 16)) + 8
            s.mount("https://", HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=n))
            _shared = s
        return _shared


def _workers() -> ThreadPoolExecutor:
    global _pool
    with _session_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(get_config()["download"].get("header_workers", 32), thread_name_prefix="s3hdr")
        return _pool


def base_url() -> str:
    return get_config()["archive"]["s3_http"]


def _get(url: str, **kw) -> requests.Response:
    try:
        r = _session().get(url, timeout=get_config()["download"]["timeout_s"], **kw)
    except requests.RequestException as e:
        raise S3Error(f"S3 request failed: {e}") from e
    if r.status_code >= 400:
        raise S3Error(f"S3 {r.status_code} for {url}")
    return r


# ---------------------------------------------------------------- listings (cached)

def list_prefix(prefix: str, fresh: bool = False) -> tuple[list[str], list[str]]:
    """(keys, sub-prefixes) directly under prefix. Cached on disk: release folders don't change.
    `fresh` skips the cache read (release checks need to see folders added since)."""
    ck = cache.cache_key("s3ls", 0, 0, 0, prefix)
    hit = None if fresh else cache.get_json(ck)
    if hit is not None:
        return hit["keys"], hit["prefixes"]
    keys, prefixes, token = [], [], None
    while True:
        params = {"list-type": "2", "prefix": prefix, "delimiter": "/", "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        text = _get(base_url(), params=params).text
        keys += re.findall(r"<Key>([^<]+)</Key>", text)
        prefixes += [p for p in re.findall(r"<Prefix>([^<]+)</Prefix>", text) if p != prefix]
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", text)
        if not m:
            break
        token = m.group(1)
    cache.put_json(ck, {"keys": keys, "prefixes": prefixes})
    return keys, prefixes


def week_folders() -> list[str]:
    """All level-2 week folders across configured releases, e.g. 'dr1/level2/2025W35_2A/'."""
    out = []
    for rel in get_config()["archive"]["s3_releases"]:
        out += list_prefix(f"{rel}/level2/")[1]
    return out


def detector_keys(week_folder: str, det: int) -> list[str]:
    """Every level-2 file of one detector in a week folder, main and *_retry procs combined.
    A file that exists in both procs is taken from the retry proc."""
    by_name: dict[str, str] = {}
    for proc in sorted(list_prefix(week_folder)[1], key=lambda p: "retry" in p):
        for k in list_prefix(f"{proc}{det}/")[0]:
            if k.endswith(".fits"):
                by_name[k.rsplit("/", 1)[1]] = k
    return list(by_name.values())


def parse_name(key_or_name: str) -> dict:
    m = FNAME_RE.search(key_or_name)
    if not m:
        raise ValueError(f"not a SPHEREx level-2 file name: {key_or_name}")
    d = m.groupdict()
    d["det"], d["exp"] = int(d["det"]), int(d["exp"])
    d["obs_id"] = f"{d['week']}_{d['obs']}_{d['exp']}"
    return d


# ---------------------------------------------------------------- headers

def _image_header_text(key: str) -> str:
    """Raw text of the IMAGE (first extension) header via one (rarely two) range requests."""
    nbytes = 31680  # primary (1 block) + a ~300-card IMAGE header (10 blocks)
    for _ in range(3):
        raw = _get(base_url() + key, headers={"Range": f"bytes=0-{nbytes - 1}"}).content.decode("latin-1")
        try:
            p = _end_of_header(raw, 0)
            return raw[p:_end_of_header(raw, p)]
        except ValueError:
            nbytes *= 2
    raise S3Error(f"could not find IMAGE header in {key}")


def image_header(key: str) -> fits.Header:
    return fits.Header.fromstring(_image_header_text(key))


_PC_KEYS = ("PC1_1", "PC1_2", "PC2_1", "PC2_2", "CDELT1", "CDELT2", "CRPIX1", "CRPIX2")
_CARD = {k: re.compile(r"^%s\s*=\s*'?([^/']+)" % re.escape(k.ljust(8)))
         for k in ("CRVAL1", "CRVAL2", "MJD-AVG", "DETECTOR") + _PC_KEYS}


def _orientation(vals: dict) -> Optional[dict]:
    """PC matrix (times CDELT) in arcsec/px, rounded to 1 mas/px, plus CRPIX, from header card values."""
    try:
        c1, c2 = float(vals.get("CDELT1", 1.0)), float(vals.get("CDELT2", 1.0))
        pc = [float(vals["PC1_1"]) * c1, float(vals["PC1_2"]) * c1, float(vals["PC2_1"]) * c2, float(vals["PC2_2"]) * c2]
    except (KeyError, ValueError):
        return None
    out = {"pc": [round(v * 3600, 3) for v in pc]}
    if "CRPIX1" in vals and "CRPIX2" in vals:
        out["crpix"] = [round(float(vals["CRPIX1"]), 2), round(float(vals["CRPIX2"]), 2)]
    return out


def _parse_cards(text: str) -> dict:
    vals = {}
    for i in range(0, len(text), 80):
        card = text[i:i + 80]
        for k, rx in _CARD.items():
            m = rx.match(card)
            if m:
                vals[k] = m.group(1).strip()
    return vals


def pointing_summary(key: str) -> dict:
    """Detector centre, orientation (PC, CRPIX) and time, parsed straight from header text. ~100x cheaper
    than building the SIP WCS, which made index builds CPU-bound (~19 headers/s) rather than network-bound."""
    vals = _parse_cards(_image_header_text(key))
    try:
        out = {"key": key, "ra": float(vals["CRVAL1"]), "dec": float(vals["CRVAL2"]), "mjd": float(vals["MJD-AVG"]),
               "det": int(vals.get("DETECTOR", 0))}
    except KeyError as e:
        raise S3Error(f"pointing keywords missing in {key}: {e}") from e
    out.update(_orientation(vals) or {})
    return out


def _with_orientation(summary: dict) -> dict:
    """A full header digest ("hdr", WCS as header text) also carries PC/CRPIX: add them in index form."""
    if "pc" in summary or "wcs" not in summary:
        return summary
    return {**summary, **(_orientation(_parse_cards(summary["wcs"])) or {})}


def _end_of_header(raw: str, start: int) -> int:
    for i in range(start, len(raw), 80):
        if raw[i:i + 8] == "END     ":
            return ((i + 80 + 2879) // 2880) * 2880
    raise ValueError("END card not found")


def wcs_summary(key: str) -> dict:
    """Small, cacheable header digest: time + the celestial WCS (incl. SIP) as a header string."""
    h = image_header(key)
    w = WCS(h)
    return {"key": key, "mjd": h["MJD-AVG"], "det": h["DETECTOR"], "obs_id": h.get("OBSID"),
            "ra": h["CRVAL1"], "dec": h["CRVAL2"], "wcs": w.to_header(relax=True).tostring()}


def _summaries(keys: list[str], progress: Progress = None, stage: str = "headers", full_wcs: bool = True,
               orientation: bool = False) -> list[dict]:
    """Header digests for many keys, cached per key, fetched in parallel.
    full_wcs=False: centre + time (+ PC/CRPIX) only (fast); a cached full digest also satisfies it.
    orientation=True: old centre-only digests ("ptg", cached before PC was parsed) don't count."""
    kinds = ("hdr",) if full_wcs else (("hdr", "ptg2") if orientation else ("hdr", "ptg2", "ptg"))
    fetch = wcs_summary if full_wcs else pointing_summary
    out, todo = {}, []
    for k in keys:
        hit = next((h for kind in kinds if (h := cache.get_json(cache.cache_key(kind, 0, 0, 0, k))) is not None), None)
        if hit is not None:
            out[k] = hit if full_wcs else _with_orientation(hit)
        else:
            todo.append(k)
    done = [len(out)]

    def one(k):
        try:
            s = fetch(k)
        except S3Error:
            return None
        cache.put_json(cache.cache_key(kinds[-1], 0, 0, 0, k), s)
        done[0] += 1
        if progress and done[0] % 50 == 0:
            progress(stage, done[0], len(keys))
        return s

    for k, s in zip(todo, _workers().map(one, todo)):
        if s is not None:
            out[k] = s
    return [out[k] for k in keys if k in out]


def pixel_of(summary: dict, ra: float, dec: float) -> tuple[float, float]:
    w = WCS(fits.Header.fromstring(summary["wcs"]))
    x, y = w.all_world2pix(ra, dec, 0)
    return float(x), float(y)


# ---------------------------------------------------------------- geometry helpers

def separation_deg(ra1, dec1, ra2, dec2):
    r1, d1, r2, d2 = map(np.radians, (ra1, dec1, ra2, dec2))
    c = np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(r1 - r2)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


# ---------------------------------------------------------------- coarse index

_index_cache: Optional[dict] = None


def load_coarse_index() -> dict:
    """{"every_nth_obs": int, "releases": [...], "samples": [{folder, obs, mjd, ra, dec}, ...]}. Loaded once."""
    global _index_cache
    if _index_cache is None:
        if not COARSE_INDEX.exists():
            raise S3Error("coarse index missing: run scripts/build_coarse_index.py")
        with gzip.open(COARSE_INDEX, "rt") as f:
            _index_cache = json.load(f)
    return _index_cache


INDEX_VERSION = 2   # 2: samples carry the detector-1 PC matrix (arcsec/px) and CRPIX


def build_coarse_index(every_nth_obs: int = 5, progress: Progress = None) -> dict:
    """Sample exposure 1 of every Nth observation on detector 1, in every week folder: centre, time and
    orientation (PC in arcsec/px, CRPIX), so the detector a target lands on can be predicted without reads."""
    samples = []
    folders = week_folders()
    for i, wf in enumerate(folders):
        keys = sorted(k for k in detector_keys(wf, 1) if parse_name(k)["exp"] == 1)
        pick = keys[::every_nth_obs]
        for s in _summaries(pick, full_wcs=False, orientation=True):
            row = {"folder": wf, "obs": int(parse_name(s["key"])["obs"]), "mjd": round(s["mjd"], 4),
                   "ra": round(s["ra"], 4), "dec": round(s["dec"], 4)}
            if "pc" in s:
                row["pc"] = s["pc"]
            if s.get("crpix") and s["crpix"] != [1020.5, 1020.5]:
                row["crpix"] = s["crpix"]
            samples.append(row)
        if progress:
            progress("coarse_index", i + 1, len(folders))
    return {"version": INDEX_VERSION, "every_nth_obs": every_nth_obs,
            "releases": get_config()["archive"]["s3_releases"], "samples": samples}


def index_has_orientation(idx: Optional[dict] = None) -> bool:
    idx = idx or load_coarse_index()
    return idx.get("version", 1) >= 2 and idx.get("every_nth_obs") == 1


# ---------------------------------------------------------------- detector prediction (no reads)

def tan_offsets_arcsec(ra0, dec0, ra, dec):
    """Gnomonic standard coordinates (xi east, eta north) of (ra, dec) about (ra0, dec0), arcsec.
    Vectorised over ra0/dec0. NaN for points more than 90 deg away."""
    a0, d0, a, d = map(np.radians, (ra0, dec0, ra, dec))
    cosc = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    with np.errstate(divide="ignore", invalid="ignore"):
        xi = np.cos(d) * np.sin(a - a0) / cosc
        eta = (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / cosc
    bad = cosc <= 0
    xi, eta = np.where(bad, np.nan, xi), np.where(bad, np.nan, eta)
    return np.degrees(xi) * 3600, np.degrees(eta) * 3600


def d1_pixel(sample_ra, sample_dec, pc_arcsec, ra, dec, crpix=(1020.5, 1020.5)):
    """0-based detector-1 pixel of (ra, dec) for an observation with D1 centre (sample_ra, sample_dec) and
    PC (arcsec/px, [PC1_1, PC1_2, PC2_1, PC2_2]). Pure TAN, SIP ignored (a few px at most)."""
    xi, eta = tan_offsets_arcsec(sample_ra, sample_dec, ra, dec)
    pc = np.asarray(pc_arcsec, float).reshape(-1, 2, 2)
    inv = np.linalg.inv(pc)
    dx = inv[:, 0, 0] * xi + inv[:, 0, 1] * eta
    dy = inv[:, 1, 0] * xi + inv[:, 1, 1] * eta
    cr = np.asarray(crpix, float).reshape(-1, 2)
    return cr[:, 0] - 1 + dx, cr[:, 1] - 1 + dy


def predict_detectors(x1, y1, y_margin: Optional[float] = None) -> list[set[int]]:
    """Which SWIR detectors (1-3) can a target at D1 pixel (x1, y1) land on, for any exposure of the
    observation? Boxes come from config archive.focal_plane (detector outlines in D1 pixels, measured from
    real headers). The ~4 exposures of an observation step ~115 px along y; y_margin covers that."""
    fp = get_config()["archive"]["focal_plane"]
    ym = fp["y_margin_px"] if y_margin is None else y_margin
    xm = fp["x_margin_px"]
    x1, y1 = np.atleast_1d(x1), np.atleast_1d(y1)
    out = [set() for _ in range(len(x1))]
    for det in (1, 2, 3):
        x0, xe, y0, ye = fp[f"D{det}"]
        hit = (x1 >= x0 - xm) & (x1 <= xe + xm) & (y1 >= y0 - ym) & (y1 <= ye + ym)
        for i in np.nonzero(hit)[0]:
            out[i].add(det)
    return out


def candidate_plan(ra: float, dec: float, radius_deg: float, window_days: Optional[float] = None,
                   max_total: Optional[int] = None, per_det_window: Optional[int] = None
                   ) -> dict[str, Optional[dict[int, Optional[set[int]]]]]:
    """Folder -> {observation number -> detectors to header-scan (None = D1-D3)}; folder -> None = scan it all.

    SPHEREx jumps across the sky between consecutive observations (index samples 5 obs apart are
    a median 138 deg apart), so nothing can be interpolated between samples:
      * sparse index: whole folders that had any nearby sample (may miss rare passes);
      * complete index: exact set of nearby observations;
      * complete index with orientation (v2): each observation's detector-1 PC matrix predicts which
        detector(s) the target lands on, so only those headers are read (~10x fewer) and the budget is
        per (detector, window_days window): at most per_det_window observations each. Near the
        ecliptic poles (R Dra: ~6600 candidates) every band then gets an even time series.
    Without orientation the old global budget applies: above max_total candidates, keep an equal share per
    window, spread evenly over distance from the target. Typical targets (Barnard: ~980) stay complete.
    """
    idx = load_coarse_index()
    complete = idx.get("every_nth_obs", 5) == 1
    s = idx["samples"]
    sep = separation_deg(ra, dec, np.array([x["ra"] for x in s]), np.array([x["dec"] for x in s]))
    out: dict[str, Optional[dict[int, Optional[set[int]]]]] = {}
    near = []
    for x, d in zip(s, sep):
        if d >= radius_deg:
            continue
        if complete and "obs" in x:
            near.append((x, float(d)))
        else:
            out[x["folder"]] = None

    if near and index_has_orientation(idx) and all("pc" in x for x, _ in near):
        xs = [x for x, _ in near]
        px, py = d1_pixel(np.array([x["ra"] for x in xs]), np.array([x["dec"] for x in xs]),
                          np.array([x["pc"] for x in xs]), ra, dec,
                          np.array([x.get("crpix", (1020.5, 1020.5)) for x in xs]))
        dets = predict_detectors(px, py)
        cells: dict[tuple[int, int], list] = {}
        for x, d, dd in zip(xs, [n[1] for n in near], dets):
            for det in dd:
                cells.setdefault((det, int(x["mjd"] // (window_days or 1e9))), []).append((x, d))
        for (det, _), group in cells.items():
            if per_det_window and len(group) > per_det_window:
                group = sorted(group, key=lambda g: g[0]["mjd"])
                group = [group[i] for i in sorted(set(np.linspace(0, len(group) - 1, per_det_window).round().astype(int)))]
            for x, _ in group:
                if out.get(x["folder"], {}) is not None:
                    out.setdefault(x["folder"], {}).setdefault(int(x["obs"]), set()).add(det)
        return out

    if near and window_days and max_total and len(near) > max_total:
        windows: dict[int, list] = {}
        for x, d in near:
            windows.setdefault(int(x["mjd"] // window_days), []).append((x, d))
        per_window = max(1, int(np.ceil(max_total / len(windows))))
        near = []
        for group in windows.values():
            if len(group) > per_window:
                group = sorted(group, key=lambda g: g[1])
                group = [group[i] for i in sorted(set(np.linspace(0, len(group) - 1, per_window).round().astype(int)))]
            near += group
    for x, _ in near:
        if out.get(x["folder"], {}) is not None:
            out.setdefault(x["folder"], {})[int(x["obs"])] = None
    return out


def candidate_obs(ra: float, dec: float, radius_deg: float, window_days: Optional[float] = None,
                  max_total: Optional[int] = None, per_det_window: Optional[int] = None
                  ) -> dict[str, Optional[set[int]]]:
    """Folder -> observation numbers worth header-scanning (None = scan the whole folder)."""
    plan = candidate_plan(ra, dec, radius_deg, window_days, max_total, per_det_window)
    return {f: (None if p is None else set(p)) for f, p in plan.items()}


def candidate_folders(ra: float, dec: float, radius_deg: float) -> list[str]:
    return sorted(candidate_obs(ra, dec, radius_deg))


# ---------------------------------------------------------------- fine scan

@dataclass
class S3Exposure:
    key: str
    obs_id: str
    mjd: float
    detector: int
    x: float  # target pixel (0-based) on the detector, from the header WCS
    y: float


def find_exposures(ra: float, dec: float, progress: Progress = None, margin_px: float = 0) -> list[S3Exposure]:
    """Every exposure (all 6 detectors) whose footprint contains (ra, dec).

    SWIR detectors 1-3 are header-scanned. MWIR detectors 4-6 see the same sky as their
    SWIR partner (D1/D4, D2/D5, D3/D6), so their keys are paired by name and their exact
    pixel position is checked later, when the stamp is cut.
    """
    cfg = get_config()["archive"]
    plan = candidate_plan(ra, dec, cfg.get("coarse_radius_deg", 12.0), window_days=cfg.get("scan_window_days"),
                          max_total=cfg.get("max_candidate_obs"), per_det_window=cfg.get("scan_per_det_window"))
    folders = sorted(plan)
    found: list[S3Exposure] = []
    for i, wf in enumerate(folders):
        if progress:
            progress("scan_folders", i, len(folders))
        obs_plan = plan[wf]
        # observations whose detectors are already predicted (v2 index) skip the detector-1 search
        known = {f"{o:04d}": d for o, d in (obs_plan or {}).items() if d is not None}
        unknown = None if obs_plan is None else {o for o, d in obs_plan.items() if d is None}
        near_obs: dict[str, set[int]] = dict(known)
        if unknown is None or unknown:
            # 1) detector-1 exposure-1 headers locate the observations that pass near the target
            d1 = [k for k in detector_keys(wf, 1) if parse_name(k)["exp"] == 1
                  and (unknown is None or int(parse_name(k)["obs"]) in unknown)]
            for s in _summaries(d1, full_wcs=False):
                if separation_deg(ra, dec, s["ra"], s["dec"]) < cfg.get("fine_radius_deg", 11.0):
                    near_obs[parse_name(s["key"])["obs"]] = {1, 2, 3}
        if not near_obs:
            continue
        # 2) all exposures of those observations on the predicted detectors: exact on-chip test
        for det in (1, 2, 3):
            keys = [k for k in detector_keys(wf, det) if det in near_obs.get(parse_name(k)["obs"], ())]
            for s in _summaries(keys):
                x, y = pixel_of(s, ra, dec)
                if -margin_px <= x < DET_SIZE + margin_px and -margin_px <= y < DET_SIZE + margin_px:
                    found.append(S3Exposure(s["key"], s["obs_id"], s["mjd"], det, x, y))
    # 3) MWIR partners by file name
    by_name = {}
    for e in found:
        n = parse_name(e.key)
        by_name[(n["week"], n["obs"], n["exp"], e.detector + 3)] = e
    for det in (4, 5, 6):
        for wf in {"/".join(e.key.split("/")[:3]) + "/" for e in found}:
            for k in detector_keys(wf, det):
                n = parse_name(k)
                e = by_name.get((n["week"], n["obs"], n["exp"], det))
                if e:
                    found.append(S3Exposure(k, e.obs_id, e.mjd, det, e.x, e.y))
    if progress:
        progress("scan_folders", len(folders), len(folders))
    return sorted(found, key=lambda e: (e.detector, e.mjd))


def key_for_filename(fname: str) -> Optional[str]:
    """Map an IRSA file name (e.g. from a TAP access URL) to its S3 key, or None."""
    n = parse_name(fname)
    for wf in week_folders():
        if f"/{n['week']}/" in wf:
            for k in detector_keys(wf, n["det"]):
                if k.endswith("/" + fname):
                    return k
    return None


# ---------------------------------------------------------------- stamps

_STRIP = ("XTENSION", "BITPIX", "NAXIS", "NAXIS1", "NAXIS2", "PCOUNT", "GCOUNT", "ZIMAGE", "ZBITPIX", "ZNAXIS",
          "ZNAXIS1", "ZNAXIS2", "ZTILE1", "ZTILE2", "ZCMPTYPE", "ZNAME1", "ZVAL1", "ZNAME2", "ZVAL2", "ZSIMPLE",
          "ZTENSION", "ZEXTEND", "ZQUANTIZ")


def cut_stamp(key: str, ra: float, dec: float, size_px: int) -> Optional[fits.HDUList]:
    """Stamp of IMAGE/FLAGS/VARIANCE/ZODI (+ nearest EPSF zone, WCS-WAVE) around (ra, dec).

    Mimics IRSA cutout output: CRPIX shifted; alternate WCS 'A' (detector pixels) and 'W'
    (wavelength lookup) offset by the stamp origin; CUTX0/CUTY0 record the origin.
    Returns None if (ra, dec) is not on this detector.
    """
    url = base_url() + key
    try:
        h = fits.open(url, use_fsspec=True, fsspec_kwargs={"block_size": 1 << 16, "cache_type": "readahead"})
    except (OSError, ValueError) as e:
        raise S3Error(f"cannot open {key}: {e}") from e
    with h:
        hdr = h["IMAGE"].header
        ny, nx = h["IMAGE"].shape
        x, y = WCS(hdr).all_world2pix(ra, dec, 0)
        if not (0 <= x < nx and 0 <= y < ny):
            return None
        size = min(size_px, nx, ny)
        x0 = int(np.clip(round(float(x)) - size // 2, 0, nx - size))
        y0 = int(np.clip(round(float(y)) - size // 2, 0, ny - size))
        sl = (slice(y0, y0 + size), slice(x0, x0 + size))

        out = fits.HDUList([fits.PrimaryHDU(header=h[0].header)])
        for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI"):
            src = h[name]
            newh = src.header.copy()
            for k in _STRIP:
                newh.remove(k, ignore_missing=True, remove_all=True)
            if "CRPIX1" in newh:  # SIP is relative to CRPIX, so a plain shift is exact
                newh["CRPIX1"] -= x0
                newh["CRPIX2"] -= y0
            if "CRVAL1A" in newh:
                newh["CRVAL1A"] = float(x0)
                newh["CRVAL2A"] = float(y0)
            if "CRVAL1W" in newh:
                newh["CRVAL1W"] = 1 + x0
                newh["CRVAL2W"] = 1 + y0
            newh["CUTX0"] = (x0, "0-based detector x of stamp pixel 0")
            newh["CUTY0"] = (y0, "0-based detector y of stamp pixel 0")
            newh["S3KEY"] = key.rsplit("/", 1)[1][:68]
            out.append(fits.ImageHDU(data=np.asarray(src.section[sl]), header=newh, name=name))

        epsf = h["EPSF"]
        d2 = (epsf.data["XCENTER"] - x) ** 2 + (epsf.data["YCENTER"] - y) ** 2
        i = int(np.argmin(d2))
        out.append(fits.BinTableHDU(data=epsf.data[i:i + 1], header=epsf.header, name="EPSF"))
        out.append(fits.BinTableHDU(data=h["WCS-WAVE"].data, header=h["WCS-WAVE"].header, name="WCS-WAVE"))
    return out


def snap_center(ra: float, dec: float, step_deg: float = 0.01) -> tuple[float, float]:
    """Snap stamp centres to a grid so nearby requests reuse cached stamps."""
    d = round(dec / step_deg) * step_deg
    ra_step = step_deg / max(math.cos(math.radians(d)), 1e-3)
    return (round(ra / ra_step) * ra_step) % 360.0, d


def records_to_json(recs: Iterable[S3Exposure]) -> list[dict]:
    return [asdict(r) for r in recs]
