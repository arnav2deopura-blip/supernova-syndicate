"""Name resolution, proper-motion propagation, Gaia queries. Owner: A.

Catalogue positions are years stale (Barnard's Star has moved ~4.6' since J2000),
so every named target is propagated to the current epoch before centring.
"""
from __future__ import annotations

import csv
import io
import math
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests

MAS_PER_DEG = 3.6e6
SESAME_URL = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
GAIA_EPOCH = 2016.0


class NameNotFound(LookupError):
    pass


class ResolverUnavailable(RuntimeError):
    pass


def propagate(ra: float, dec: float, pmra: float, pmdec: float, from_year: float, to_year: float) -> tuple[float, float]:
    """Linear proper-motion propagation.

    pmra is in mas/yr and already includes cos(dec) (Gaia/SIMBAD convention).
    Good to well under a pixel over decades for everything we target; ignores
    parallax and radial velocity.
    """
    dt = to_year - from_year
    ddec = pmdec * dt / MAS_PER_DEG
    cosd = math.cos(math.radians(dec))
    dra = (pmra * dt / MAS_PER_DEG) / cosd if cosd > 1e-9 else 0.0
    return (ra + dra) % 360.0, max(-90.0, min(90.0, dec + ddec))


def mjd_to_year(mjd: float) -> float:
    """Approximate decimal year (J2000 = MJD 51544.5)."""
    return 2000.0 + (mjd - 51544.5) / 365.25


def current_year() -> float:
    now = datetime.now(timezone.utc)
    return 2000.0 + (now - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)).total_seconds() / (365.25 * 86400)


def parse_sesame(xml_text: str) -> dict:
    """First resolver hit from a Sesame -oxp response: J2000 position (deg) and PM (mas/yr)."""
    root = ET.fromstring(xml_text)
    for res in root.iter("Resolver"):
        ra, dec = res.findtext("jradeg"), res.findtext("jdedeg")
        if ra is None or dec is None:
            continue
        pm = res.find("pm")
        return {
            "name": res.findtext("oname") or root.findtext("Target/name") or "",
            "ra": float(ra), "dec": float(dec),
            "pmra": float(pm.findtext("pmRA")) if pm is not None and pm.findtext("pmRA") else None,
            "pmdec": float(pm.findtext("pmDE")) if pm is not None and pm.findtext("pmDE") else None,
            "source": "sesame:" + (res.get("name", "").split("=")[-1].split(",")[0].strip().lower() or "cds"),
        }
    raise NameNotFound("no position in Sesame response")


def resolve_name(name: str, to_year: float | None = None) -> dict:
    """Resolve via CDS Sesame (SIMBAD, then NED/VizieR) and propagate J2000 -> to_year (default: now)."""
    try:
        r = requests.get(SESAME_URL, params=name, timeout=15)  # Sesame takes the name as the bare query string
    except requests.RequestException as e:
        raise ResolverUnavailable(f"CDS Sesame unreachable: {e}") from e
    if r.status_code != 200:
        raise ResolverUnavailable(f"CDS Sesame returned HTTP {r.status_code}")
    try:
        hit = parse_sesame(r.text)
    except (NameNotFound, ET.ParseError) as e:
        raise NameNotFound(f"Could not resolve '{name}'.") from e

    year = to_year if to_year is not None else current_year()
    ra, dec = hit["ra"], hit["dec"]
    if hit["pmra"] is not None and hit["pmdec"] is not None:
        ra, dec = propagate(ra, dec, hit["pmra"], hit["pmdec"], 2000.0, year)
    return {"name": hit["name"] or name, "ra": round(ra, 7), "dec": round(dec, 7), "epoch": round(year, 3),
            "pmra": hit["pmra"], "pmdec": hit["pmdec"], "source": hit["source"]}


def gaia_query(ra: float, dec: float, radius_deg: float, gmax: float = 18.0, pm_min: float = 100.0,
               limit: int = 1000) -> list[dict]:
    """Gaia DR3 cone (ESA archive), J2016.0 positions. Bright-ish stars plus every fast mover at any
    magnitude: the movers are the point of the overlay. Cached forever (DR3 is static)."""
    from . import cache  # local import: cache imports config, keep catalogs importable standalone

    ck = cache.cache_key("gaia", ra, dec, radius_deg, f"{gmax}|{pm_min}|{limit}")
    hit = cache.get_json(ck)
    if hit is not None:
        return hit
    q = (f"SELECT TOP {limit} source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, pm "
         "FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS', ra, dec), "
         f"CIRCLE('ICRS', {ra}, {dec}, {radius_deg})) AND (phot_g_mean_mag < {gmax} OR pm > {pm_min}) "
         "ORDER BY phot_g_mean_mag")
    try:
        r = requests.get(GAIA_TAP, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q},
                         timeout=30)
    except requests.RequestException as e:
        raise ResolverUnavailable(f"Gaia archive unreachable: {e}") from e
    if r.status_code != 200 or not r.text.startswith("source_id"):
        raise ResolverUnavailable(f"Gaia archive returned HTTP {r.status_code}")

    def num(v):
        return float(v) if v not in ("", None) else None

    rows = [{"id": f"Gaia DR3 {x['source_id']}", "ra": float(x["ra"]), "dec": float(x["dec"]),
             "pmra": num(x["pmra"]), "pmdec": num(x["pmdec"]), "parallax": num(x["parallax"]),
             "mag": num(x["phot_g_mean_mag"])} for x in csv.DictReader(io.StringIO(r.text))]
    cache.put_json(ck, rows)
    return rows


def gaia_sources(ra: float, dec: float, fov: float, epochs: list[tuple[str, float]]) -> list[dict]:
    """Gaia DR3 sources in a fov-square field, each propagated to every epoch's mean MJD.

    `ra`/`dec` stay the catalogue J2016.0 values (ref_epoch); use positions_by_epoch to draw.
    Linear proper motion only: parallax (<0.6" even for Barnard's Star) is ignored.
    Not in Gaia: very red, faint objects such as WISE 0855 (use CatWISE, tier 3).
    """
    half_diag = fov / math.sqrt(2) * 1.05
    out = []
    for s in gaia_query(ra, dec, half_diag):
        pos = []
        for label, mjd in epochs:
            if s["pmra"] is not None and s["pmdec"] is not None:
                pra, pdec = propagate(s["ra"], s["dec"], s["pmra"], s["pmdec"], GAIA_EPOCH, mjd_to_year(mjd))
            else:
                pra, pdec = s["ra"], s["dec"]
            pos.append({"epoch_label": label, "mjd": round(mjd, 4), "ra": round(pra, 7), "dec": round(pdec, 7)})
        out.append({"id": s["id"], "ra": s["ra"], "dec": s["dec"], "pmra": s["pmra"], "pmdec": s["pmdec"],
                    "mag": s["mag"], "ref_epoch": GAIA_EPOCH, "positions_by_epoch": pos})
    return out
