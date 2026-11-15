# API contract

**Source of truth.** The backend (`backend/schemas.py`) and the fake data (`frontend/mock/`) must match this file.
Changing it = one PR that updates all three together, reviewed by everyone.

Base URL: set in `frontend/js/api.js` (`API_BASE`). All responses are JSON.

## Conventions

| Thing | Unit / format |
|---|---|
| Coordinates | ICRS degrees (`ra` 0–360, `dec` −90–90) |
| Proper motion | mas/yr (`pmra` includes the cos δ factor) |
| Wavelength | µm |
| Image pixels (`/frames`) | **MJy/sr** surface brightness (SPHEREx `BUNIT`), zodi and local background removed |
| Flux (`/spectrum`) | µJy |
| Time | MJD (float) |
| Field of view `fov` | degrees, square cutout side. Default 0.1, max 0.5 |
| Band `band` | `D1` … `D6` (detector). Edges in `backend/config.yaml` |
| Image arrays | flat, row-major, **row 0 = top of image** (north up, east left), `null` = masked pixel |

## Errors

Every error, on every endpoint, has the same shape and a matching HTTP status:

```json
{ "error": "not_found", "message": "No SPHEREx images cover this position." }
```

| `error` | HTTP |
|---|---|
| `bad_request` | 400 |
| `not_found` | 404 |
| `upstream_unavailable` | 503 (IRSA slow or down) |
| `not_implemented` | 501 |

---

## `GET /api/resolve?name=`

Resolve a target name and propagate its position to the current epoch.

```json
{
  "name": "Barnard's Star",
  "ra": 269.4486,
  "dec": 4.7394,
  "epoch": 2026.0,
  "pmra": -801.551,
  "pmdec": 10362.394,
  "source": "simbad"
}
```

## `GET /api/frames?ra=&dec=&fov=&band=`

One co-added frame per epoch for one detector band, all on the same grid.

```json
{
  "ra": 269.4486,
  "dec": 4.7394,
  "fov": 0.04,
  "band": "D2",
  "wcs": {
    "center_ra": 269.4486,
    "center_dec": 4.7394,
    "pixel_scale_arcsec": 3.075,
    "width": 48,
    "height": 48
  },
  "frames": [
    {
      "epoch_label": "E1",
      "mjd_start": 60810.2,
      "mjd_end": 60824.9,
      "n_exposures": 12,
      "width": 48,
      "height": 48,
      "data": [0.12, 0.08, null, "..."],
      "flag_fraction": 0.03
    }
  ]
}
```

`data` is either the flat float array or a string URL to a `.json`/`.bin` file with the same array (used by `frontend/precomputed/` for large cutouts). For `.bin`: little-endian float32, NaN for masked.

**Live backend (phase 1):** `data` is always an absolute URL to `GET /api/blob/<id>.bin` (content-addressed, cacheable forever, gzip on the wire). Optional fields added to every frame and the response (all additive, mocks stay valid):

| Field | Meaning |
|---|---|
| `units` (response) | `"MJy/sr"` |
| `release` (response) | Data release tag the frames were built from, e.g. `dr1+qr3-2026W40` |
| `mjd_mean` | Mean MJD of the frame's exposures. Propagate overlays to this, not to the label |
| `lam_um` | Wavelength (µm) at the target in each exposure. A SPHEREx detector sees a different wavelength at every position, so a frame's colour mix is listed here |
| `lam_eff_um` | Mean of `lam_um` |
| `target_flags` | Flag names touching the target in any exposure (e.g. `OVERFLOW` = saturated). Show as a warning, not an error |
| `obs_ids` | Exposure IDs in the frame |

**Slow first requests (phase 2).** A position nobody has asked for before needs an archive search plus downloads: ~1–10 min. Cached positions answer in well under a second. Two ways to call:

- `GET /api/frames?...` (default) waits for the result. Simple, but a browser may time out.
- `GET /api/frames?...&async=1` returns at once: **200** with frames if cached, otherwise **202** with a job:

```json
{ "job_id": "3f9c0a1b2c3d4e5f", "state": "running", "stage": "stamps", "message": "Downloading image cutouts",
  "done": 12, "total": 46, "error": null, "created": 1794680000.1, "finished": null, "result": null,
  "status_url": "http://host/api/jobs/3f9c0a1b2c3d4e5f" }
```

Poll `GET /api/jobs/{job_id}` (every ~1 s) until `state` is `done` (then `result.result_url` is the frames URL, now cached) or `error` (`error` is an error code from the table above, `message` explains). `stage`/`done`/`total` drive a progress bar.

**Epoch labels are per position, shared by all bands and the overlay.** `E2` means the same months in D1 and D6. A band with no data in a pass skips that label (e.g. `E1, E3`). A pass longer than 90 days (near the ecliptic poles coverage is nearly continuous) is split at its largest gap, or into equal ≤90-day bins, so polar targets get more frames.

## `GET /api/exposures?ra=&dec=&fov=`

Every individual exposure covering the position, all six detectors (for the metadata panel). `wavelength_um` and `flags_summary.target_flags` are `null` until that detector's frames have been built once (they come from the image cutout). `url` is the full level-2 file (S3 or IRSA).

```json
{
  "exposures": [
    {
      "obs_id": "2025W21_1A_0123_1",
      "mjd": 60812.4,
      "detector": 2,
      "wavelength_um": 1.31,
      "epoch_label": "E1",
      "flags_summary": { "flag_fraction": 0.02 },
      "url": "https://irsa.ipac.caltech.edu/..."
    }
  ]
}
```

## `GET /api/spectrum?ra=&dec=`

Quick-look aperture photometry at one position, every exposure, tagged by epoch.

```json
{
  "ra": 269.4486,
  "dec": 4.7394,
  "points": [
    { "wavelength_um": 1.31, "flux": 1520.0, "flux_err": 35.0, "epoch_label": "E1", "flagged": false }
  ]
}
```

## `GET /api/overlay?ra=&dec=&fov=&cat=gaia`

Gaia DR3 sources in the field (G < 18, plus every source with proper motion > 100 mas/yr at any magnitude), with positions propagated from J2016.0 (`ref_epoch`) to each epoch's mean exposure time (`positions_by_epoch[].mjd`). Draw `positions_by_epoch`, not `ra`/`dec`. Not in Gaia: very red faint objects such as WISE 0855 (CatWISE planned).

```json
{
  "catalog": "gaia_dr3",
  "sources": [
    {
      "id": "Gaia DR3 4472832130942575872",
      "ra": 269.4486,
      "dec": 4.7394,
      "pmra": -801.551,
      "pmdec": 10362.394,
      "mag": 8.19,
      "positions_by_epoch": [
        { "epoch_label": "E1", "ra": 269.44861, "dec": 4.73901 }
      ]
    }
  ]
}
```

---

Mock files: `frontend/mock/{resolve,frames,exposures,spectrum,overlay}.json`, regenerated by `python scripts/make_mock.py`. Mock values are fake; they only show the shape.
