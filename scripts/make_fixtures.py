"""Cut small real SPHEREx stamps straight from the public S3 mirror into tests/fixtures/.

Works with IRSA's TAP/SIA/cutout services down: reads only the needed byte ranges of
each level-2 file (s3://nasa-irsa-spherex, public, no credentials).

The stamps mimic IRSA cutout-service output so the same code path handles both:
  * IMAGE / FLAGS / VARIANCE / ZODI sliced to the stamp; celestial WCS (TAN-SIP) shifted via CRPIX.
  * Alternate WCS "A" (0-based detector pixel coords) and "W" (wavelength lookup) shifted so a stamp
    pixel still maps to the right detector pixel and therefore the right wavelength.
  * EPSF trimmed to the one zone nearest the target (the full table is ~4 MB).
  * WCS-WAVE copied unchanged (it is indexed in full-detector coordinates).

    python scripts/make_fixtures.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from astropy.io import fits

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OUT = ROOT / "tests" / "fixtures"

from backend.s3_archive import cut_stamp  # noqa: E402  (same code path the API uses)

# Barnard's Star, one exposure per survey pass, chosen at similar detector rows (similar wavelength).
# Found by header-scanning the S3 week folders on 14 Nov 2026 while IRSA TAP was down.
# Not every exposure exists for every detector (e.g. 0474_4D4 is missing), hence per-detector lists.
_E1 = "dr1/level2/2025W35_2A/l2b-v27-2026-231/{d}/level2_2025W35_2A_0474_{n}D{d}_spx_l2b-v27-2026-231.fits"
_E2 = "dr1/level2/2026W11_1A/l2b-v27-2026-232/{d}/level2_2026W11_1A_0570_{n}D{d}_spx_l2b-v27-2026-232.fits"
_E3 = "qr3/level2/2026W35_1A/l2b-v27-2026-243/{d}/level2_2026W35_1A_0079_{n}D{d}_spx_l2b-v27-2026-243.fits"
BARNARD = {
    1: {"E1": _E1.format(d=1, n=4), "E2": _E2.format(d=1, n=1), "E3": _E3.format(d=1, n=4)},
    4: {"E1": _E1.format(d=4, n=3), "E2": _E2.format(d=4, n=1), "E3": _E3.format(d=4, n=4)},
}
# Approximate mid-survey (~2025.9) position of Barnard's Star; the stamp is big enough that ~1' error is fine.
CENTER = (269.4463, 4.7660)
SIZE_PX = 48


def s3_stamp(key: str, ra: float, dec: float, size_px: int) -> fits.HDUList:
    stamp = cut_stamp(key, ra, dec, size_px)
    if stamp is None:
        raise SystemExit(f"target is off-chip in {key}")
    return stamp


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    dets = [int(a) for a in sys.argv[1:]] or list(BARNARD)
    for det in dets:
        for ep, key in BARNARD[det].items():
            path = OUT / f"barnard_{ep}_D{det}.fits"
            s3_stamp(key, *CENTER, SIZE_PX).writeto(path, overwrite=True)
            print(f"{path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
