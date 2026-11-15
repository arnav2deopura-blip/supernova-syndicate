"""Owner: B. Items 3-5 (channels, cube, index orientation, ePSF fitting, light curves, motion). Offline.

Synthetic tests inject a known answer and check it comes back; fixture tests pin facts about real stamps.
"""
import math
import warnings
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from fastapi.testclient import TestClient

from backend import catalogs, channels, cube, discovery, lightcurve, motion, photometry, pipeline, psf, s3_archive
from backend.config import get_config
from backend.fits_processor import PreparedStamp, prepare_stamp, wavelength_at
from backend.photometry import PhotPoint
from backend.server import app

warnings.simplefilter("ignore", FITSFixedWarning)
FIX = Path(__file__).resolve().parent / "fixtures"
CFG = get_config()
GAIA_BARNARD = dict(ra=269.44850252543836, dec=4.739420051112412, pmra=-801.551, pmdec=10362.394)
BARNARD_MJDS = [60917.95, 61110.4, 61277.0]   # E1 / E2 / E3 (docs/SPHEREX_DATA_NOTES.md)


# ------------------------------------------------------------------ helpers

def tan_wcs(ra, dec, n, scale_arcsec=6.15, rot_deg=0.0):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    c, s = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
    w.wcs.cd = np.array([[-c, s], [s, c]]) * scale_arcsec / 3600
    w.pixel_shape = (n, n)
    return w


def synth_stamp(ra=150.0, dec=10.0, n=48, mjd=61000.0, det=2, lam=1.3, stars=(), noise=1.0, seed=0, x0=1000, y0=1000,
                rot_deg=0.0, sat_core=None):
    """stars: [(ra, dec, flux)] in image units x pixels. sat_core: (ra, dec) of a star whose core is clipped."""
    rng = np.random.default_rng(seed)
    w = tan_wcs(ra, dec, n, rot_deg=rot_deg)
    model = psf.EPSFModel.gaussian()
    img = rng.normal(0, noise, (n, n))
    for sra, sdec, f in stars:
        x, y = w.all_world2pix(sra, sdec, 0)
        img += psf.render(model, (n, n), float(x), float(y), f)
    sat = np.zeros((n, n), bool)
    if sat_core is not None:
        x, y = w.all_world2pix(*sat_core, 0)
        yy, xx = np.mgrid[0:n, 0:n]
        sat = np.hypot(xx - x, yy - y) < 1.0
        img[sat] = np.nan
    tx, ty = w.all_world2pix(ra, dec, 0)
    z = np.zeros((n, n), bool)
    return PreparedStamp(image=img.astype(np.float32), variance=np.full((n, n), noise ** 2, np.float32), wcs=w, mjd=mjd,
                         detector=det, obs_id=f"S{seed}", x=float(tx), y=float(ty), lam_um=lam, bw_um=0.03,
                         bkg_rms=noise, x0=x0, y0=y0, reject=sat.copy(), saturated=sat, suspect=z, contam=z,
                         epsf=None, omega_sr=37.69 * (math.pi / 180 / 3600) ** 2)


def point(mjd, lam, flux, err, det=2, label="E1"):
    ch = channels.assign(det, lam, 0.005)
    return PhotPoint(obs_id="x", detector=det, mjd=mjd, lam_um=lam, bw_um=0.03, channel=ch.label if ch else None,
                     flux=flux, flux_err=err, flux_ap=None, x=0, y=0, x_pred=0, y_pred=0, x_err=0, y_err=0, fit="psf",
                     chi2r=1.0, flagged=False, epoch_label=label, snr=flux / err)


def fixture_stamp(path):
    with fits.open(path) as h:
        hdr = h["IMAGE"].header
        ra, dec = catalogs.propagate(GAIA_BARNARD["ra"], GAIA_BARNARD["dec"], GAIA_BARNARD["pmra"], GAIA_BARNARD["pmdec"],
                                     2016.0, catalogs.mjd_to_year(hdr["MJD-AVG"]))
        return prepare_stamp(h, ra, dec, CFG["flags"]), h["WCS-WAVE"].data, (ra, dec)


# ------------------------------------------------------------------ channels

def test_channel_table_is_complete_and_ordered():
    t = channels.table()
    assert len(t) == 102
    for det in range(1, 7):
        ch = channels.for_detector(det)
        assert [c.subchan for c in ch] == list(range(1, 18))
        assert all(a.wavelength < b.wavelength for a, b in zip(ch, ch[1:]))
        lo, hi = CFG["bands"][f"D{det}"]
        assert abs(ch[0].wl_min - lo) < 0.002 and abs(ch[-1].wl_max - hi) < 0.002


def test_assign_inside_and_overlap_goes_to_nearest_centre():
    c = channels.assign(1, 0.904)
    assert c.wl_min <= 0.904 <= c.wl_max and c.label == "D1C09"
    a, b = channels.for_detector(2)[3], channels.for_detector(2)[4]
    assert a.wl_max > b.wl_min       # neighbouring channels overlap
    mid = (b.wl_min + a.wl_max) / 2
    want = min((a, b), key=lambda c: abs(c.wavelength - mid))
    assert channels.assign(2, mid) == want
    assert channels.assign(2, 0.5) is None


@pytest.mark.parametrize("path", sorted(FIX.glob("barnard_E*_D*.fits")), ids=lambda p: p.stem)
def test_channel_map_agrees_with_wcs_wave(path):
    """CHANNEL_MAP (strict mode) and WCS-WAVE + table (quick-look) pick the same channel almost everywhere."""
    with fits.open(path) as h:
        hdr = h["IMAGE"].header
        m = channels.map_slice(hdr["CUTX0"], hdr["CUTY0"], h["IMAGE"].shape)
        agree = total = 0
        for y in range(0, 48, 4):
            for x in range(0, 48, 4):
                c = channels.assign(hdr["DETECTOR"], wavelength_at(h, x, y)[0])
                if c:
                    total += 1
                    agree += c.subchan == m[y, x]
        assert agree >= 0.9 * total


def test_barnard_fixture_passes_land_in_neighbouring_channels():
    subs = []
    for e in (1, 2, 3):
        with fits.open(FIX / f"barnard_E{e}_D1.fits") as h:
            subs.append(channels.assign(1, wavelength_at(h, 24, 24)[0]).subchan)
    assert max(subs) - min(subs) <= 2


def test_map_slice_off_detector_is_zero():
    m = channels.map_slice(2030, -5, (20, 20))
    assert m.shape == (20, 20) and (m[:5] == 0).all() and (m[:, 10:] == 0).all()


# ------------------------------------------------------------------ cube

def _cube_stamps(per_channel=2):
    out = []
    for c in channels.for_detector(6):
        for k in range(per_channel):
            out.append(synth_stamp(det=6, lam=c.wavelength, mjd=60800 + 200 * k, seed=c.subchan * 10 + k,
                                   stars=[(150.0, 10.0, 50.0 * c.subchan)]))
    return out


def test_cube_all_channels_and_target_brightens_with_channel():
    st = _cube_stamps()
    p = cube.build_cube(150.0, 10.0, 0.06, "D6", stamps=st, bins=[(60790, 60810), (60990, 61010)], check_movers=False)
    m = p.meta
    assert [c["subchan"] for c in m["channels"]] == list(range(1, 18))
    assert all(c["n_exposures"] == 2 and c["passes"] == ["E1", "E2"] for c in m["channels"])
    vals = [c["target_value"] for c in m["channels"]]
    assert vals[-1] > 5 * vals[0]
    assert len(p.arrays) == 17 and m["display_range"][0] < m["display_range"][1]
    # same grid as /frames for the same request
    g = pipeline.output_grid(150.0, 10.0, 0.06)
    assert (m["wcs"]["width"], m["wcs"]["height"]) == g.pixel_shape and p.arrays[0].shape == g.pixel_shape[::-1]


def test_cube_omits_empty_channels_and_per_pass_splits():
    st = [s for s in _cube_stamps() if channels.assign(6, s.lam_um).subchan in (3, 9)]
    m = cube.build_cube(150.0, 10.0, 0.06, "D6", stamps=st, bins=[(60790, 60810), (60990, 61010)], check_movers=False,
                        per_pass=True, target_pm_mas_yr=8000).meta
    assert [c["channel"] for c in m["channels"]] == ["D6C03", "D6C09"]
    assert [f["epoch_label"] for f in m["channels"][0]["frames"]] == ["E1", "E2"]
    assert m["recommend_per_pass"] is False   # already per pass
    m2 = cube.build_cube(150.0, 10.0, 0.06, "D6", stamps=st, bins=[(60790, 61010)], check_movers=False,
                         target_pm_mas_yr=8000).meta
    assert m2["recommend_per_pass"] is True


def test_strict_mode_keeps_only_matching_half(monkeypatch):
    s = synth_stamp(n=20)
    half = np.zeros((20, 20), np.uint8)
    half[:10], half[10:] = 5, 6
    monkeypatch.setattr(channels, "map_slice", lambda x0, y0, shape: half)
    img = cube.strict_image(s, 5)
    assert np.isfinite(img[:10]).all() and np.isnan(img[10:]).all()



# ------------------------------------------------------------------ matched-wavelength frames

def _red_star_stamps(mix):
    """mix: {mjd: [subchan, ...]}. A constant source that is 50 x subchan bright: redder channel = brighter."""
    out, seed = [], 0
    chans = channels.for_detector(6)
    for mjd, subs in mix.items():
        for sub in subs:
            seed += 1
            out.append(synth_stamp(det=6, lam=chans[sub - 1].wavelength, mjd=mjd, seed=seed, noise=0.02,
                                   stars=[(150.0, 10.0, 50.0 * sub)]))
    return out


MIX_BINS = [(60790, 60810), (60990, 61010)]


def test_matched_frames_remove_bandpass_mix():
    # Pass 1 also samples red C15 twice, pass 2 blue C01: the plain co-add makes the star "fade", matched doesn't.
    st = _red_star_stamps({60800: [3, 9, 15, 15], 61000: [3, 9, 1]})
    naive = pipeline.coadd_epochs(st, 150.0, 10.0, 0.06, "D6", bins=MIX_BINS)
    m = cube.build_matched_frames(150.0, 10.0, 0.06, "D6", stamps=st, bins=MIX_BINS)
    nv = [cube._target_value(a) for a in naive.arrays]
    mv = [cube._target_value(a) for a in m.arrays]
    assert nv[1] < 0.6 * nv[0]                         # naive: a constant star looks variable
    assert abs(mv[1] - mv[0]) < 0.02 * mv[0]          # matched: same bandpass, same brightness
    assert m.meta["matched"] is True and m.meta["matched_channels"] == ["D6C03", "D6C09"]
    f1, f2 = m.meta["frames"]
    assert (f1["n_exposures"], f1["n_exposures_dropped"]) == (2, 2)
    assert (f2["n_exposures"], f2["n_exposures_dropped"]) == (2, 1)
    assert f1["lam_eff_um"] == f2["lam_eff_um"]
    assert [c["channel"] for c in f1["channels"]] == ["D6C03", "D6C09"]
    assert m.arrays[0].shape == naive.arrays[0].shape   # same grid as the plain frames


def test_matched_frames_equal_weight_per_channel():
    # Three C03 exposures must not outweigh one C09 exposure, or the bandpass would follow the sampling.
    st = _red_star_stamps({60800: [3, 3, 3, 9], 61000: [3, 9]})
    m = cube.build_matched_frames(150.0, 10.0, 0.06, "D6", stamps=st, bins=MIX_BINS)
    a, b = (cube._target_value(x) for x in m.arrays)
    assert abs(a - b) < 0.02 * b


def test_matched_frames_need_a_channel_common_to_every_pass():
    st = _red_star_stamps({60800: [3, 4], 61000: [9]})
    with pytest.raises(pipeline.NoCoverage, match="E1: C03, C04; E2: C09"):
        cube.build_matched_frames(150.0, 10.0, 0.06, "D6", stamps=st, bins=MIX_BINS)


# ------------------------------------------------------------------ noise maps + frame QC

def _field_stamps(shift_px=0.0, n_per_pass=3, seed0=0):
    """Two passes of a field with 6 bright stars; pass 2's WCS is off by shift_px native px in x."""
    rng = np.random.default_rng(42)
    stars = [(150.0 + dx / 3600, 10.0 + dy / 3600, 400.0) for dx, dy in rng.uniform(-80, 80, (6, 2))]
    out = []
    for k, mjd in enumerate([60800.0, 61000.0]):
        for j in range(n_per_pass):
            s = synth_stamp(stars=stars, noise=1.0, seed=seed0 + 10 * k + j, mjd=mjd + j)
            if k == 1 and shift_px:
                s.wcs.wcs.crpix = s.wcs.wcs.crpix + [shift_px, 0]
            out.append(s)
    field = [{"id": f"G{i}", "ra": a, "dec": d, "pmra": 0.0, "pmdec": 0.0, "mag": 12.0} for i, (a, d, _) in enumerate(stars)]
    return out, field


def test_noise_maps_give_unit_scatter_sigma_difference():
    st, _ = _field_stamps()
    p = pipeline.coadd_epochs(st, 150.0, 10.0, 0.06, "D2", bins=MIX_BINS)
    assert p.noise is not None and len(p.noise) == 2 and all(f["noise_scale"] > 0 for f in p.meta["frames"])
    r = (p.arrays[1] - p.arrays[0]) / np.sqrt(p.noise[0] ** 2 + p.noise[1] ** 2)
    r = r[np.isfinite(r)]
    assert 0.85 < 1.4826 * np.median(np.abs(r - np.median(r))) < 1.15


def test_frame_astrometry_detects_a_registration_error():
    good, field = _field_stamps()
    p = pipeline.add_frame_qc(pipeline.coadd_epochs(good, 150.0, 10.0, 0.06, "D2", bins=MIX_BINS), 150.0, 10.0, 0.06, field)
    for f in p.meta["frames"]:
        a = f["astrometry"]
        assert a["n_ref"] >= 4 and abs(a["dra_arcsec"]) < 0.5 and abs(a["ddec_arcsec"]) < 0.5
        assert f["astrometry_rms_arcsec"] < 0.5 and f["target_flagged"] is False
    bad, _ = _field_stamps(shift_px=0.5)   # 0.5 native px = 3.1" WCS error in pass 2
    p = pipeline.add_frame_qc(pipeline.coadd_epochs(bad, 150.0, 10.0, 0.06, "D2", bins=MIX_BINS), 150.0, 10.0, 0.06, field)
    off = [math.hypot(f["astrometry"]["dra_arcsec"], f["astrometry"]["ddec_arcsec"]) for f in p.meta["frames"]]
    assert off[0] < 0.5 and 2.0 < off[1] < 4.2


# ------------------------------------------------------------------ discovery (movers not in Gaia)

DISC_MJDS = [60800.0, 61000.0, 61200.0]
DISC_BINS = [(m - 10, m + 10) for m in DISC_MJDS]


def _discovery_field(mjds=DISC_MJDS):
    """6 stationary Gaia stars, a Gaia-listed mover (+6"/yr east) and a mover Gaia lacks (8"/yr, to the
    north-west, faint: S/N ~ 10 per pass), 3 exposures per pass."""
    rng = np.random.default_rng(7)
    cosd = math.cos(math.radians(10.0))
    fixed = [(150.0 + dx / 3600 / cosd, 10.0 + dy / 3600, 400.0) for dx, dy in rng.uniform(-90, 90, (6, 2))]
    gm0, nm0 = (150.0 - 40 / 3600 / cosd, 10.0 + 30 / 3600), (150.0 + 35 / 3600 / cosd, 10.0 - 45 / 3600)
    stamps = []
    for k, mjd in enumerate(mjds):
        yr = (mjd - mjds[0]) / 365.25
        gm = (gm0[0] + 6.0 * yr / 3600 / cosd, gm0[1], 300.0)
        nm = (nm0[0] - 5.6 * yr / 3600 / cosd, nm0[1] + 5.6 * yr / 3600, 60.0)
        for j in range(3):
            stamps.append(synth_stamp(stars=fixed + [gm, nm], noise=1.0, seed=100 * k + j, mjd=mjd + j * 0.5))
    y0 = catalogs.mjd_to_year(mjds[0])
    field = [{"id": f"G{i}", "ra": a, "dec": d, "pmra": 0.0, "pmdec": 0.0, "mag": 13.0} for i, (a, d, _) in enumerate(fixed)]
    # Gaia mover: position at J2016 so that propagation lands on gm0 at the first pass
    g_ra, g_dec = catalogs.propagate(gm0[0], gm0[1], 6000.0, 0.0, y0, catalogs.GAIA_EPOCH)
    field.append({"id": "GMOVER", "ra": g_ra, "dec": g_dec, "pmra": 6000.0, "pmdec": 0.0, "mag": 14.0})
    return stamps, field, nm0


def _movers(stamps, field, bins):
    p = pipeline.coadd_epochs(stamps, 150.0, 10.0, 0.06, "D6", bins=bins)
    return discovery.find_movers(p.meta["frames"], p.arrays, p.noise, pipeline.output_grid(150.0, 10.0, 0.06), field)


def test_discovery_finds_the_mover_gaia_lacks():
    stamps, field, nm0 = _discovery_field()
    r = _movers(stamps, field, DISC_BINS)
    by = {t["status"]: [] for t in r["tracks"]}
    for t in r["tracks"]:
        by[t["status"]].append(t)
    assert len(by.get("candidate", [])) == 1, [(t["status"], t["pm"]) for t in r["tracks"]]
    c = by["candidate"][0]
    assert c["gaia"] is None and c["pm_sigma"] > 5
    assert abs(c["pmra"] - (-5600)) < 3 * c["pm_err"] and abs(c["pmdec"] - 5600) < 3 * c["pm_err"]
    km = [t for t in by.get("known_mover", []) if t["gaia"]["id"] == "GMOVER"]
    assert len(km) == 1 and abs(km[0]["pmra"] - 6000) < 3 * km[0]["pm_err"]
    assert len(by.get("stationary", [])) == 6
    assert r["candidates"] == [c["id"]]


def test_discovery_needs_three_passes_for_candidates():
    stamps, field, _ = _discovery_field(DISC_MJDS[:2])
    r = _movers(stamps, field, DISC_BINS[:2])
    assert r["candidates"] == [] and r["note"]
    assert all(t["status"] != "candidate" for t in r["tracks"])
    assert any(t["status"] == "known_mover" and t["gaia"]["id"] == "GMOVER" for t in r["tracks"])

# ------------------------------------------------------------------ index orientation (R Dra fix)

@pytest.mark.parametrize("path", sorted(FIX.glob("barnard_E*_D1.fits")), ids=lambda p: p.stem)
def test_d1_pixel_matches_full_wcs(path):
    """Index-style prediction (TAN + PC, no SIP) vs the real SIP WCS on detector 1."""
    hdr = fits.getheader(path, "IMAGE")
    o = s3_archive._with_orientation({"wcs": WCS(hdr).to_header(relax=True).tostring()})
    w = WCS(hdr)
    for sx, sy in [(5, 5), (40, 30), (24, 24)]:
        ra, dec = w.all_pix2world(sx, sy, 0)
        # CRPIX/CRVAL of the stamp header are relative to the stamp; shift back to detector pixels
        cr = (hdr["CRPIX1"] + hdr["CUTX0"], hdr["CRPIX2"] + hdr["CUTY0"])
        px, py = s3_archive.d1_pixel(hdr["CRVAL1"], hdr["CRVAL2"], o["pc"], float(ra), float(dec), cr)
        assert math.hypot(px[0] - (sx + hdr["CUTX0"]), py[0] - (sy + hdr["CUTY0"])) < 15


def test_predict_detectors_boxes():
    fp = CFG["archive"]["focal_plane"]
    assert s3_archive.predict_detectors([1000], [1000])[0] == {1}
    assert s3_archive.predict_detectors([3300], [1000])[0] == {2}
    assert s3_archive.predict_detectors([5500], [1000])[0] == {3}
    assert s3_archive.predict_detectors([2150], [1000])[0] == set()        # the ~220 px gap between D1 and D2
    assert s3_archive.predict_detectors([2090], [1000])[0] == {1}          # x margin
    assert s3_archive.predict_detectors([9000], [1000])[0] == set()
    assert s3_archive.predict_detectors([1000], [fp["D1"][3] + 400])[0] == {1}  # y margin: exposure steps


def test_candidate_plan_per_detector_budget(monkeypatch):
    """v2 index: each observation is routed to its detector, and every detector keeps <= N per window."""
    ra, dec = 269.45, 4.77
    pc = [-6.15, 0.0, 0.0, 6.15]   # RA increases to -x
    samples = []
    for i in range(60):
        # target at D1 x ~1000 (i%3==0), D2 x ~3300 (1), D3 x ~5500 (2): put the D1 centre east/west of it
        dx = [0, 2300, 4500][i % 3] - 1000 + 19.5
        samples.append({"folder": "dr1/level2/A/", "obs": i, "mjd": 61000 + i * 0.1,
                        "ra": ra + dx * 6.15 / 3600 / math.cos(math.radians(dec)), "dec": dec, "pc": pc})
    monkeypatch.setattr(s3_archive, "load_coarse_index", lambda: {"version": 2, "every_nth_obs": 1, "samples": samples})
    plan = s3_archive.candidate_plan(ra, dec, 12.0, window_days=10, per_det_window=8)["dr1/level2/A/"]
    by_det = {d: [o for o, ds in plan.items() if d in ds] for d in (1, 2, 3)}
    assert {d: len(v) for d, v in by_det.items()} == {1: 8, 2: 8, 3: 8}
    assert all(o % 3 == d - 1 for d, v in by_det.items() for o in v)
    # back-compat view
    assert set(s3_archive.candidate_obs(ra, dec, 12.0, window_days=10, per_det_window=8)["dr1/level2/A/"]) == set(plan)


# ------------------------------------------------------------------ ePSF fitting

def test_fixture_epsf_is_the_documented_scale():
    """OVSMPX=5 means 1.23" ePSF samples: the ePSF FWHM is ~1.1 native px (~7"), not ~0.55 px."""
    e = fits.open(FIX / "barnard_E1_D1.fits")["EPSF"]
    m = psf.EPSFModel(e.data["EPSF"][0], e.header["OVSMPX"])
    assert 0.9 < m.fwhm_native() < 1.4
    k = np.arange(-6, 7)
    yy, xx = np.meshgrid(k + 0.3, k - 0.2, indexing="ij")
    assert abs(m.evaluate(xx, yy, 0.0, 0.0).sum() - 1.0) < 0.02


def test_fit_recovers_position_and_flux():
    m = psf.EPSFModel.gaussian()
    rng = np.random.default_rng(3)
    for _ in range(20):
        x, y = 15 + rng.uniform(-.5, .5), 15 + rng.uniform(-.5, .5)
        im = psf.render(m, (31, 31), x, y, 2000.0) + rng.normal(0, 1, (31, 31))
        f = psf.fit_star(im, np.ones_like(im), m, x + 0.5, y - 0.4)
        assert f.ok and abs(f.x - x) < 0.05 and abs(f.y - y) < 0.05 and abs(f.flux / 2000 - 1) < 0.03


def test_wing_fit_with_masked_core_recovers_flux_and_position():
    m = psf.EPSFModel.gaussian()
    x, y = 15.3, 14.8
    im = psf.render(m, (31, 31), x, y, 5000.0) + np.random.default_rng(4).normal(0, 1, (31, 31))
    yy, xx = np.mgrid[0:31, 0:31]
    sat = np.hypot(xx - x, yy - y) < 1.0
    im[sat] = np.nan
    f = psf.fit_star(im, np.ones_like(im), m, 15.0, 15.0, saturated=sat)
    assert f.wing and abs(f.flux / 5000 - 1) < 0.05 and math.hypot(f.x - x, f.y - y) < 0.1


@pytest.mark.parametrize("path", sorted(FIX.glob("barnard_E*_D*.fits")), ids=lambda p: p.stem)
def test_wing_fit_on_saturated_barnard_lands_on_gaia(path):
    """Saturated real stamps: the ePSF wing fit is within 0.6 native px of Gaia (the old centroid: ~1.3 px)."""
    s, _, (ra, dec) = fixture_stamp(path)
    p = photometry.measure(s, ra, dec, free=True)
    assert p.fit == "wing" and p.flagged
    assert math.hypot(p.x - p.x_pred, p.y - p.y_pred) < 0.6
    assert 1e6 < p.flux < 3e7   # a few Jy, as Barnard's Star is at 1-3 um


# ------------------------------------------------------------------ deblending (forced fits)

@pytest.mark.parametrize("sep_arcsec", [11.8, 7.6, 4.8])   # WISE 0855's neighbour in E1 / E2 / E3
def test_forced_fit_deblends_known_neighbour(sep_arcsec):
    """A faint target next to a 5x brighter Gaia star: fitting the target alone takes the neighbour's light,
    fitting both at fixed positions recovers the target within its (honestly larger) error."""
    nra = 150.0 + sep_arcsec / 3600 / math.cos(math.radians(10.0))
    errs_alone, errs_both = [], []
    for seed in range(20):
        s = synth_stamp(stars=[(150.0, 10.0, 20.0), (nra, 10.0, 100.0)], noise=1.0, seed=seed)
        alone = photometry.measure(s, 150.0, 10.0, free=False)
        both = photometry.measure(s, 150.0, 10.0, free=False, others=[(nra, 10.0)])
        assert both.n_deblended == 1 and alone.n_deblended == 0
        to = s.omega_sr * 1e12
        errs_alone.append(alone.flux / to - 20.0)
        errs_both.append((both.flux / to - 20.0) / (both.flux_err / to))
    # blended: biased by > 25%. Close neighbours add light; at ~2 px the wing lands in the fitted background
    # instead and the target comes out LOW. Either way the single-star fit can't be trusted.
    assert abs(np.mean(errs_alone)) > 5.0
    assert abs(np.mean(errs_both)) < 0.6            # deblended: unbiased ...
    assert 0.5 < np.std(errs_both) < 1.6            # ... with errors that describe the scatter


def test_photometry_table_deblends_only_when_asked():
    nra = 150.0 + 6 / 3600 / math.cos(math.radians(10.0))
    s = synth_stamp(stars=[(150.0, 10.0, 20.0), (nra, 10.0, 100.0)])
    nb = [{"id": "Gaia DR3 1", "ra": nra, "dec": 10.0, "pmra": 0.0, "pmdec": 0.0}]
    tr = photometry.Track(150.0, 10.0, 2016.0, 0.0, 0.0, source="request")
    plain = photometry.photometry_table([s], tr, neighbours=nb, free=False)[0]
    deb = photometry.photometry_table([s], tr, neighbours=nb, free=False, deblend=True)[0]
    assert plain.blend == ["Gaia DR3 1"] and plain.n_deblended == 0
    assert deb.n_deblended == 1 and deb.flux < plain.flux

# ------------------------------------------------------------------ light curves

def _spectrum(lam):
    return 1e5 * lam ** -3        # steep: the wavelength mix alone would fake variability


def _lc_points(scales, slope=0.0, seed=0):
    rng = np.random.default_rng(seed)
    pts = []
    mixes = [(1.10, 1.30), (1.35, 1.64), (1.10, 1.64)]   # different wavelength mix per pass
    for k, (s, (lo, hi)) in enumerate(zip(scales, mixes)):
        for lam in rng.uniform(lo, hi, 20):
            f = _spectrum(lam) * s * (1 + slope * (lam - 1.37) * k)
            pts.append(point(61000 + 180 * k + rng.uniform(0, 5), lam, f * (1 + rng.normal(0, 0.005)), 0.005 * f,
                             label=f"E{k + 1}"))
    return pts


def test_template_method_ignores_bandpass_mix_for_constant_star():
    pts = _lc_points([1.0, 1.0, 1.0])
    raw = [np.mean([p.flux for p in pts if p.epoch_label == f"E{k}"]) for k in (1, 2, 3)]
    assert max(raw) / min(raw) > 1.5          # naive light curve: fake variability
    tc = lightcurve.template_curve(pts, 15.0, 0.01)
    assert all(abs(b["scale"] - 1) < 0.02 for b in tc["bins"])
    assert tc["chi2_constant"] / tc["dof"] < 3 and not tc["shape_changed"]


def test_template_method_grey_variable_and_flat_ratio():
    pts = _lc_points([1.0, 1.0, 1.5])
    tc = lightcurve.template_curve(pts, 15.0, 0.01)
    s = [b["scale"] for b in tc["bins"]]
    assert abs(s[2] / s[0] - 1.5) < 0.03 and abs(s[1] / s[0] - 1) < 0.02
    assert tc["chi2_constant"] > 100
    spec = [{"channel": p.channel, "epoch_label": p.epoch_label, "flux": p.flux, "flux_err": p.flux_err, "flagged": False}
            for p in pts]
    r = photometry.ratio_spectrum(spec, "E1", "E3")
    assert r and all(abs(x["ratio"] / 1.5 - 1) < 0.25 for x in r)   # flat (channel-mean noise from the lam spread)
    slope = np.polyfit([x["lam_um"] for x in r], [x["ratio"] for x in r], 1)[0]
    assert abs(slope) < 0.5


def test_colour_dependent_variable_is_flagged():
    pts = _lc_points([1.0, 1.0, 1.0], slope=1.5)
    assert lightcurve.template_curve(pts, 15.0, 0.01)["shape_changed"]


def test_period_search_finds_injected_mira_period():
    t = np.sort(np.random.default_rng(1).uniform(60800, 61500, 40))
    y = 1 + 0.3 * np.sin(2 * np.pi * t / 245.0)
    out = lightcurve.period_search(t, y, np.full_like(t, 0.02), 245.0)
    assert abs(out["best_period_days"] - 245) < 10 and abs(out["sinusoid_fixed"]["semi_amplitude"] - 0.3) < 0.03


# ------------------------------------------------------------------ motion

def _rows(pm=(-801.6, 10362.4), plx=547.0, mjds=None, noise_mas=150.0, seed=0, ra0=269.4485, dec0=4.7394):
    rng = np.random.default_rng(seed)
    rows = []
    mjds = mjds or [m + d for m in BARNARD_MJDS for d in np.linspace(0, 5, 18)]
    for k, mjd in enumerate(mjds):
        t = catalogs.mjd_to_year(mjd) - 2026.0
        P = motion.parallax_factors(ra0, dec0, motion.observer_bary_au(mjd))
        xi = pm[0] * t + plx * P[0] + rng.normal(0, noise_mas)
        eta = pm[1] * t + plx * P[1] + rng.normal(0, noise_mas)
        ra, dec = motion.from_tangent_mas(ra0, dec0, xi, eta)
        lab = "E%d" % (1 + min(range(3), key=lambda i: abs(mjd - BARNARD_MJDS[i])))
        rows.append({"ra": float(ra), "dec": float(dec), "mjd": mjd, "err_mas": noise_mas, "used": True, "label": lab})
    return rows, ra0, dec0


def test_tangent_round_trip():
    ra, dec = motion.from_tangent_mas(269.4, 4.7, 12345.0, -6789.0)
    xi, eta = motion.tangent_offsets_mas(269.4, 4.7, ra, dec)
    assert abs(xi - 12345) < 0.01 and abs(eta + 6789) < 0.01


def test_parallax_factor_size_and_sign():
    """Barnard (near the ecliptic): |P| ~ 1 AU; E1 and E3 share a phase, E2 is on the other side."""
    P = [motion.parallax_factors(269.45, 4.74, motion.observer_bary_au(m)) for m in BARNARD_MJDS]
    assert all(0.3 < math.hypot(*p) < 1.1 for p in P)
    assert P[0][0] * P[2][0] > 0 and P[0][0] * P[1][0] < 0


def test_synthetic_mover_recovered_with_parallax():
    rows, ra0, dec0 = _rows()
    f = motion.fit_motion(rows, ra0, dec0, "fit")
    assert abs(f["pmra"] + 801.6) < 3 * f["pmra_err"] and abs(f["pmdec"] - 10362.4) < 3 * f["pmdec_err"]
    assert f["pmdec_err"] < 150 and abs(f["parallax"] - 547) < 3 * f["parallax_err"]
    assert 0.5 < f["chi2_dof"] < 1.6
    ref = motion.compare(f, {"pmra": -801.551, "pmdec": 10362.394}, "gaia_dr3")
    assert ref["pm_sigma_diff"] < 3


def test_gaia_fixed_parallax_removes_the_nuisance_term():
    rows, ra0, dec0 = _rows()
    ignored = motion.fit_motion([dict(r) for r in rows], ra0, dec0, "ignored")
    fixed = motion.fit_motion([dict(r) for r in rows], ra0, dec0, "gaia_fixed", 547.0)
    assert fixed["chi2_dof"] < ignored["chi2_dof"]
    assert abs(fixed["pmdec"] - 10362.4) < 3 * fixed["pmdec_err"]


def test_parallax_degenerate_with_two_same_season_passes():
    mjds = [m + d for m in (BARNARD_MJDS[0], BARNARD_MJDS[2]) for d in np.linspace(0, 5, 18)]
    rows, ra0, dec0 = _rows(mjds=mjds)
    f = motion.fit_motion(rows, ra0, dec0, "fit")
    assert f["parallax_err"] > 1000          # honest: huge sigma, not a fake value


def test_motion_needs_two_passes():
    rows, ra0, dec0 = _rows(mjds=[BARNARD_MJDS[0] + d for d in range(5)])
    with pytest.raises(motion.NotEnoughData):
        motion.fit_motion(rows, ra0, dec0)


def test_registration_recovers_known_shift_and_rotation():
    """8 reference stars; the WCS is off by 0.4 px + 0.1 deg rotation: corrected at the target to < 0.02 px."""
    ra0, dec0 = 150.0, 10.0
    rng = np.random.default_rng(7)
    field = [{"id": f"G{i}", "ra": ra0 + rng.uniform(-0.05, 0.05), "dec": dec0 + rng.uniform(-0.05, 0.05),
              "pmra": 0.0, "pmdec": 0.0, "mag": 12.0} for i in range(8)]
    n = 64
    true_w = tan_wcs(ra0, dec0, n, rot_deg=0.1)
    true_w.wcs.crpix = true_w.wcs.crpix + [0.4, -0.3]
    st = synth_stamp(ra0, dec0, n=n, mjd=catalogs.GAIA_EPOCH * 0 + 57388.5, stars=[], noise=1.0)
    model = psf.EPSFModel.gaussian()
    img = np.random.default_rng(8).normal(0, 1.0, (n, n))
    for g in field:
        x, y = true_w.all_world2pix(g["ra"], g["dec"], 0)
        img += psf.render(model, (n, n), float(x), float(y), 3000.0)
    st.image = img.astype(np.float32)
    tx, ty = true_w.all_world2pix(ra0, dec0, 0)
    refs = motion.reference_stars(st, field, None, (st.x, st.y))
    reg = motion.register(st, refs, (float(tx), float(ty)))
    ex, ey = float(tx) - st.x, float(ty) - st.y     # true error of the stamp WCS at the target
    assert reg["n_ref"] >= 6 and reg["model"] == "affine"
    assert math.hypot(reg["dx"] - ex, reg["dy"] - ey) < 0.02


# ------------------------------------------------------------------ endpoints (offline)

@pytest.fixture
def offline_products(monkeypatch, tmp_path):
    monkeypatch.setitem(get_config()["cache"], "dir", str(tmp_path))
    st = _cube_stamps()
    monkeypatch.setattr(pipeline, "load_stamps", lambda *a, **k: (st, [(60790, 60810), (60990, 61010)]))
    monkeypatch.setattr(catalogs, "gaia_query", lambda *a, **k: [])
    return st


def test_cube_endpoint_serves_blob_urls(offline_products):
    c = TestClient(app)
    body = c.get("/api/cube?ra=150&dec=10&fov=0.06&det=D6&pmra=0&pmdec=0").json()
    assert len(body["channels"]) == 17 and body["channels"][0]["data"].startswith("http")
    arr = np.frombuffer(c.get(body["channels"][0]["data"]).content, "<f4")
    assert arr.size == body["wcs"]["width"] * body["wcs"]["height"]
    r = c.get("/api/cube?ra=150&dec=10&fov=0.06&det=D6&pmra=0&pmdec=0&async=1")
    assert r.status_code == 200   # cached now: no job


def test_frames_matched_endpoint_is_cached_separately(offline_products):
    c = TestClient(app)
    plain = c.get("/api/frames?ra=150&dec=10&fov=0.06&band=D6").json()
    matched = c.get("/api/frames?ra=150&dec=10&fov=0.06&band=D6&matched=1").json()
    assert plain.get("matched") is None and matched["matched"] is True
    assert len(matched["matched_channels"]) == 17 and matched["frames"][0]["channels"][0]["channel"] == "D6C01"
    assert [f["data"] for f in plain["frames"]] != [f["data"] for f in matched["frames"]]
    arr = np.frombuffer(c.get(matched["frames"][0]["data"]).content, "<f4")
    assert arr.size == matched["wcs"]["width"] * matched["wcs"]["height"]
    assert c.get("/api/frames?ra=150&dec=10&fov=0.06&band=D6&matched=1&async=1").status_code == 200   # cached

def test_frames_fits_export(offline_products):
    import io
    c = TestClient(app)
    r = c.get("/api/frames.fits?ra=150&dec=10&fov=0.06&band=D6&matched=1")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/fits")
    with fits.open(io.BytesIO(r.content)) as h:
        names = [x.name for x in h]
        assert names[0] == "PRIMARY" and "IMAGE_E1" in names and "NOISE_E2" in names
        assert h[0].header["MATCHED"] is True and h[0].header["NPASS"] == 2
        img = h["IMAGE_E1"]
        assert img.header["CTYPE1"] == "RA---TAN" and img.header["NEXP"] >= 1 and img.header["BUNIT"] == "MJy/sr"
        body = c.get("/api/frames?ra=150&dec=10&fov=0.06&band=D6&matched=1").json()
        blob = np.frombuffer(c.get(body["frames"][0]["data"]).content, "<f4").reshape(img.data.shape)
        np.testing.assert_array_equal(np.nan_to_num(img.data[::-1]), np.nan_to_num(blob))   # FITS rows = flipped


def test_stack_endpoint_sharpens_a_mover(offline_products, monkeypatch):
    """Stamps whose star moves 20"/yr (3 smeared PSFs in a static stack): the co-moving stack's S/N is higher.
    At 8"/yr over 400 days the smear is ~1 PSF FWHM and the gain only ~5-20% (as for WISE 0855)."""
    cosd = math.cos(math.radians(10.0))
    st = []
    for k, mjd in enumerate([60800.0, 61000.0, 61200.0]):
        yr = (mjd - 61000.0) / 365.25
        st += [synth_stamp(det=6, mjd=mjd + j, seed=10 * k + j, noise=1.0,
                           stars=[(150.0 - 20.0 * yr / 3600 / cosd, 10.0, 60.0)]) for j in range(3)]
    monkeypatch.setattr(pipeline, "load_stamps", lambda *a, **k: (st, [(m - 10, m + 10) for m in (60800, 61000, 61200)]))
    from backend.catalogs import mjd_to_year
    b = TestClient(app).get(f"/api/stack?ra=150&dec=10&fov=0.06&band=D6&pmra=-20000&pmdec=0&epoch={mjd_to_year(61001.0)}").json()
    assert b["comoving"]["target_snr"] > 1.3 * b["static"]["target_snr"]
    assert b["comoving"]["data"].startswith("http") and b["smear_arcsec"] > 20

def test_spectrum_and_ratio_endpoint(offline_products):
    body = TestClient(app).get("/api/spectrum?ra=150&dec=10&det=D6&pmra=0&pmdec=0&compare=E1").json()
    assert len(body["points"]) == 34 and body["points"][0]["channel"].startswith("D6C")
    assert body["ratio"] and all(set(x["passes"]) == {"E1", "E2"} for x in body["ratio"])
