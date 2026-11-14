"""Owner: A + B. Offline: archive access is monkeypatched to the real fixture stamps."""
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from fastapi.testclient import TestClient

from backend import catalogs, s3_archive, spherex_client
from backend.config import get_config
from backend.fits_processor import coadd_clipped, wavelength_at
from backend.server import app

FIX = Path(__file__).resolve().parent / "fixtures"
CENTER = (269.4463, 4.7660)

SESAME_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Sesame><Target option="SNV"><name>Barnard's Star</name>
<Resolver name="S=Simbad, IDIA (via url)"><oname>NAME Barnard's star</oname>
<jradeg>269.4520769586187</jradeg><jdedeg>4.69336496657667</jdedeg>
<pm><v>10393.349</v><pmRA>-801.551</pmRA><pmDE>10362.394</pmDE></pm>
</Resolver></Target></Sesame>"""


# ------------------------------------------------------------------ parsing

def test_parse_level2_name():
    n = s3_archive.parse_name("dr1/level2/2025W35_2A/l2b-v27-2026-231/4/level2_2025W35_2A_0474_3D4_spx_l2b-v27-2026-231.fits")
    assert (n["week"], n["obs"], n["exp"], n["det"], n["proc"]) == ("2025W35_2A", "0474", 3, 4, "l2b-v27-2026-231")
    assert n["obs_id"] == "2025W35_2A_0474_3"
    with pytest.raises(ValueError):
        s3_archive.parse_name("index.html")


def test_parse_sesame_and_propagate(monkeypatch):
    class R:
        status_code, text = 200, SESAME_XML

    monkeypatch.setattr(catalogs.requests, "get", lambda *a, **k: R())
    out = catalogs.resolve_name("Barnard's Star", to_year=2026.0)
    assert out["source"] == "sesame:simbad" and out["pmdec"] == 10362.394
    # 26 yr x 10.36"/yr north ~ 269"
    assert abs((out["dec"] - 4.69336496657667) * 3600 - 26 * 10.362394) < 0.5


def test_snap_center_is_stable():
    a = s3_archive.snap_center(269.44631, 4.76601)
    b = s3_archive.snap_center(269.44629, 4.76599)
    assert a == b


# ------------------------------------------------------------------ science pieces

def test_wavelength_at_matches_fixture_band():
    with fits.open(FIX / "barnard_E1_D1.fits") as h:
        lam, bw = wavelength_at(h, 24, 24)
        assert 0.85 < lam < 0.95 and 0.015 < bw < 0.035
        # moving up the stamp (+y) moves down in wavelength on D1
        assert wavelength_at(h, 24, 40)[0] < lam


def test_coadd_clipped_rejects_cosmic_ray_but_keeps_real_variation():
    base = np.full((5, 3, 3), 10.0)
    base[4, 1, 1] = 1000.0                      # cosmic ray in one exposure
    out, _, n = coadd_clipped(list(base), [1.0] * 5)
    assert abs(out[1, 1] - 10.0) < 1e-6 and n[1, 1] == 4
    ramp = np.stack([np.full((3, 3), v) for v in (10.0, 12.0, 14.0, 16.0, 18.0)])  # e.g. a spectral slope
    out, _, n = coadd_clipped(list(ramp), [0.5] * 5)
    assert abs(out[1, 1] - 14.0) < 1e-6 and n[1, 1] == 5


def test_coadd_clipped_weights_by_background_noise():
    a, b = np.zeros((2, 2)), np.full((2, 2), 10.0)
    out, _, _ = coadd_clipped([a, b], [1.0, 3.0])  # weights 1 and 1/9
    assert np.isclose(out[0, 0], 1.0)


# ------------------------------------------------------------------ end to end on real stamps

@pytest.fixture
def offline_archive(monkeypatch, tmp_path):
    monkeypatch.setitem(get_config()["cache"], "dir", str(tmp_path))
    stamps = sorted(FIX.glob("barnard_E*_D*.fits"))
    recs = []
    for p in stamps:
        hdr = fits.getheader(p, "IMAGE")
        recs.append((spherex_client.ExposureRecord(hdr["OBSID"], hdr["MJD-AVG"], hdr["DETECTOR"], s3_key=p.name), p))
    monkeypatch.setattr(spherex_client, "query_exposures", lambda *a, **k: [r for r, _ in recs])
    monkeypatch.setattr(spherex_client, "fetch_stamps",
                        lambda records, *a, **k: [(r, p) for r, p in recs if r in records])
    return recs


GAIA = (269.44850252543836, 4.739420051112412, -801.551, 10362.394)  # Barnard, Gaia DR3 J2016.0


def _centroid_vs_gaia(arr, body, mjd, r=5):
    """Flux-weighted centroid in a box around the Gaia-predicted position, in display (row 0 = north) pixels.
    Not argmax: Barnard's saturated core has NaN pixels that shift the brightest pixel by up to 3 px."""
    from backend.catalogs import mjd_to_year, propagate
    from backend.image_alignment import target_wcs

    wcs = body["wcs"]
    w, h = wcs["width"], wcs["height"]
    a = np.clip(np.nan_to_num(np.asarray(arr, np.float32).reshape(h, w)), 0, None)
    grid = target_wcs(wcs["center_ra"], wcs["center_dec"], body["fov"], wcs["pixel_scale_arcsec"])
    ra, dec = propagate(*GAIA, 2016.0, mjd_to_year(mjd))
    ex, ey = (float(v) for v in grid.all_world2pix(ra, dec, 0))
    erow = (h - 1) - ey
    ic, ir = int(round(ex)), int(round(erow))
    box = a[ir - r:ir + r + 1, ic - r:ic + r + 1]
    rr, cc = np.mgrid[ir - r:ir + r + 1, ic - r:ic + r + 1]
    return (box * rr).sum() / box.sum(), (box * cc).sum() / box.sum(), erow, ex


def test_frames_end_to_end_barnard_moves_north(offline_archive):
    client = TestClient(app)
    r = client.get("/api/frames", params={"ra": CENTER[0], "dec": CENTER[1], "fov": 0.04, "band": "D1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["units"] == "MJy/sr"
    assert [f["epoch_label"] for f in body["frames"]] == ["E1", "E2", "E3"]
    w, h = body["wcs"]["width"], body["wcs"]["height"]
    cents = []
    for f in body["frames"]:
        assert f["n_exposures"] == 1 and 0.85 < f["lam_eff_um"] < 0.95
        assert "OVERFLOW" in f["target_flags"]
        blob = client.get(f["data"].replace("http://testserver", ""))
        assert blob.status_code == 200 and len(blob.content) == w * h * 4
        row, col, erow, ecol = _centroid_vs_gaia(np.frombuffer(blob.content, "<f4"), body, f["mjd_mean"])
        # single saturated exposure per epoch here: ~1 px (3") agreement with Gaia is what the data supports
        assert np.hypot(row - erow, col - ecol) < 1.6, (f["epoch_label"], row - erow, col - ecol)
        cents.append((row, col))
    # Barnard: +10.36"/yr in Dec. E1 -> E3 is 0.98 yr -> ~10.2" = 3.3 px of 3.075" north (row 0 = north)
    drow = cents[0][0] - cents[2][0]
    assert 2.3 < drow < 4.3, drow

    # second call is served from the product cache with identical blobs
    again = client.get("/api/frames", params={"ra": CENTER[0], "dec": CENTER[1], "fov": 0.04, "band": "D1"}).json()
    assert [f["data"] for f in again["frames"]] == [f["data"] for f in body["frames"]]


def test_frames_not_found_when_no_coverage(offline_archive):
    r = TestClient(app).get("/api/frames", params={"ra": CENTER[0], "dec": CENTER[1], "fov": 0.04, "band": "D6"})
    assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_blob_rejects_bad_ids():
    assert TestClient(app).get("/api/blob/../../etc.bin").status_code in (400, 404)


def test_candidate_obs_sparse_index_scans_whole_folders(monkeypatch):
    idx = {"every_nth_obs": 5, "samples": [
        {"folder": "dr1/level2/A/", "obs": 100, "ra": 269.5, "dec": 5.0, "mjd": 1},   # near
        {"folder": "dr1/level2/A/", "obs": 105, "ra": 290.0, "dec": 5.0, "mjd": 2},   # far
        {"folder": "dr1/level2/B/", "obs": 7, "ra": 100.0, "dec": -40.0, "mjd": 3},   # far
    ]}
    monkeypatch.setattr(s3_archive, "load_coarse_index", lambda: idx)
    assert s3_archive.candidate_obs(269.45, 4.77, 12.0) == {"dr1/level2/A/": None}


def test_candidate_obs_complete_index_is_exact(monkeypatch):
    idx = {"every_nth_obs": 1, "samples": [
        {"folder": "dr1/level2/A/", "obs": 100, "ra": 269.5, "dec": 5.0, "mjd": 1},
        {"folder": "dr1/level2/A/", "obs": 101, "ra": 89.0, "dec": -5.0, "mjd": 1.01},  # jumped away
        {"folder": "dr1/level2/A/", "obs": 102, "ra": 271.0, "dec": 9.0, "mjd": 1.02},
    ]}
    monkeypatch.setattr(s3_archive, "load_coarse_index", lambda: idx)
    assert s3_archive.candidate_obs(269.45, 4.77, 12.0) == {"dr1/level2/A/": {100, 102}}


# ------------------------------------------------------------------ phase 2: jobs, overlay, exposures, TAP breaker

def test_async_frames_job_then_cached(offline_archive):
    import time as _t

    client = TestClient(app)
    q = {"ra": CENTER[0], "dec": CENTER[1], "fov": 0.04, "band": "D4", "async": 1}
    r = client.get("/api/frames", params=q)
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["state"] in ("queued", "running", "done") and job["status_url"]
    for _ in range(100):
        st = client.get(job["status_url"].replace("http://testserver", "")).json()
        if st["state"] in ("done", "error"):
            break
        _t.sleep(0.05)
    assert st["state"] == "done", st
    again = client.get("/api/frames", params=q)  # now cached: plain 200 even with async=1
    assert again.status_code == 200 and len(again.json()["frames"]) == 3


def test_async_job_reports_not_found(offline_archive):
    import time as _t

    client = TestClient(app)
    r = client.get("/api/frames", params={"ra": CENTER[0], "dec": CENTER[1], "fov": 0.04, "band": "D6", "async": 1})
    url = r.json()["status_url"].replace("http://testserver", "")
    for _ in range(100):
        st = client.get(url).json()
        if st["state"] in ("done", "error"):
            break
        _t.sleep(0.05)
    assert st["state"] == "error" and st["error"] == "not_found"


def test_overlay_propagates_gaia_to_each_epoch(offline_archive, monkeypatch):
    row = {"id": "Gaia DR3 4472832130942575872", "ra": GAIA[0], "dec": GAIA[1], "pmra": GAIA[2], "pmdec": GAIA[3],
           "parallax": 546.976, "mag": 8.19}
    monkeypatch.setattr(catalogs, "gaia_query", lambda *a, **k: [row])
    body = TestClient(app).get("/api/overlay", params={"ra": CENTER[0], "dec": CENTER[1], "fov": 0.04}).json()
    pos = body["sources"][0]["positions_by_epoch"]
    assert [p["epoch_label"] for p in pos] == ["E1", "E2", "E3"]
    assert body["sources"][0]["ref_epoch"] == 2016.0
    # ~10.36"/yr north: E1 -> E3 (~0.99 yr) ~ 10.3"
    assert 9.5 < (pos[2]["dec"] - pos[0]["dec"]) * 3600 < 11.0


def test_exposures_fill_wavelength_after_frames(offline_archive):
    client = TestClient(app)
    q = {"ra": CENTER[0], "dec": CENTER[1], "fov": 0.04}
    before = client.get("/api/exposures", params=q).json()["exposures"]
    assert len(before) == 6 and all(e["wavelength_um"] is None for e in before)
    assert sorted({e["epoch_label"] for e in before}) == ["E1", "E2", "E3"]
    client.get("/api/frames", params={**q, "band": "D1"})
    after = client.get("/api/exposures", params=q).json()["exposures"]
    d1 = [e for e in after if e["detector"] == 1]
    assert all(0.85 < e["wavelength_um"] < 0.95 for e in d1)
    assert all("OVERFLOW" in e["flags_summary"]["target_flags"] for e in d1)


def test_tap_failure_trips_breaker(monkeypatch, tmp_path):
    monkeypatch.setitem(get_config()["cache"], "dir", str(tmp_path))
    monkeypatch.setattr(spherex_client, "_tap_skip_until", 0.0)
    calls = {"tap": 0}

    def bad_tap(*a, **k):
        calls["tap"] += 1
        raise spherex_client.UpstreamError("502")

    monkeypatch.setattr(spherex_client, "_tap_exposures", bad_tap)
    monkeypatch.setattr(s3_archive, "find_exposures", lambda *a, **k: [])
    spherex_client.query_exposures(10.0, 10.0)
    spherex_client.query_exposures(11.0, 11.0)
    assert calls["tap"] == 1


def test_shipped_index_loads_and_covers_barnard():
    """The real backend/data/coarse_index.json.gz, not a stub: shape, completeness, and Barnard coverage."""
    idx = s3_archive.load_coarse_index()
    assert idx["every_nth_obs"] == 1 and len(idx["samples"]) > 90000
    cands = s3_archive.candidate_obs(269.446, 4.7707, 12.0)
    # Barnard's three passes: Aug/Sep 2025 (dr1 W35-36), Mar 2026 (dr1 W11), Aug/Sep 2026 (qr3 W34-35)
    weeks = {f.split("/")[2][:7] for f in cands}
    assert {"2025W35", "2026W11", "2026W35"} <= weeks
    assert all(isinstance(v, set) and v for v in cands.values())


def test_candidate_obs_budget_thins_dense_windows_evenly(monkeypatch):
    # 40 observations in one 10-day window at distances 0..9.75 deg; budget 5 keeps a spread of distances
    samples = [{"folder": "dr1/level2/A/", "obs": i, "ra": 269.45 + i * 0.25, "dec": 4.77, "mjd": 60000.0 + i * 0.1}
               for i in range(40)]
    monkeypatch.setattr(s3_archive, "load_coarse_index", lambda: {"every_nth_obs": 1, "samples": samples})
    kept = s3_archive.candidate_obs(269.45, 4.77, 12.0, window_days=10, max_total=5)["dr1/level2/A/"]
    assert len(kept) == 5 and min(kept) == 0 and max(kept) == 39
    assert len(s3_archive.candidate_obs(269.45, 4.77, 12.0, window_days=10, max_total=50)["dr1/level2/A/"]) == 40
    assert len(s3_archive.candidate_obs(269.45, 4.77, 12.0)["dr1/level2/A/"]) == 40
