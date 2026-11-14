"""First-hour spike (issue #3): coordinates -> one SPHEREx cutout PNG.

Goal: prove we can reach IRSA and see a real cutout before building anything else.

    python scripts/spike_one_cutout.py --ra 269.452 --dec 4.693 --size 0.05 --band D2

Uses the TAP query shape from the IRSA SPHEREx cutouts tutorial. Check the
table/column names there if this errors: https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts
"""
import argparse
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.visualization import AsinhStretch, ImageNormalize, PercentileInterval
from pyvo.dal import TAPService

TAP_URL = "https://irsa.ipac.caltech.edu/TAP"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ra", type=float, required=True)
    ap.add_argument("--dec", type=float, required=True)
    ap.add_argument("--size", type=float, default=0.05, help="cutout side, degrees")
    ap.add_argument("--band", default="D2")
    ap.add_argument("--out", default="data/spike.png")
    args = ap.parse_args()

    query = f"""
        SELECT TOP 5 a.uri, p.time_bounds_lower, p.energy_bandpassname
        FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
        WHERE CONTAINS(POINT('ICRS', {args.ra}, {args.dec}), p.poly) = 1
          AND p.energy_bandpassname = 'SPHEREx-{args.band}'
        ORDER BY p.time_bounds_lower
    """
    print("Querying IRSA TAP ...")
    rows = TAPService(TAP_URL).run_sync(query).to_table()
    print(rows)
    if len(rows) == 0:
        raise SystemExit("No images cover this position in this band.")

    url = f"{rows['uri'][0]}?center={args.ra},{args.dec}&size={args.size}"
    print("Downloading", url)
    with fits.open(url, cache=False) as hdul:
        hdul.info()
        image = hdul["IMAGE"].data.astype(float)

    import matplotlib.pyplot as plt  # only needed for the spike

    norm = ImageNormalize(image, interval=PercentileInterval(99.5), stretch=AsinhStretch())
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    plt.imsave(args.out, np.nan_to_num(norm(image)), cmap="gray", origin="lower")
    print("Wrote", args.out)


if __name__ == "__main__":
    main()
