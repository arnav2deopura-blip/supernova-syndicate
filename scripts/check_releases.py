"""Weekly check for new SPHEREx data on the public S3 mirror (run by .github/workflows/check-releases.yml).

    python scripts/check_releases.py            # prints JSON; exit 0
    python scripts/check_releases.py --issue    # also writes issue.md + GITHUB_OUTPUT new_data=true|false

New release folders (e.g. qr4/) need a config change; new week folders in a known release only need the
pointing index rebuilt. Both steps are listed in the issue body and in docs/DEPLOY.md.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import releases  # noqa: E402


def main() -> int:
    r = releases.check()
    print(json.dumps(r, indent=2))
    if "--issue" in sys.argv:
        new = not r["up_to_date"]
        if new:
            lines = ["The weekly release check found SPHEREx data the backend does not index yet.", ""]
            if r["new_releases"]:
                lines += [f"* **New release folder(s):** {', '.join(r['new_releases'])}. Add to "
                          "`archive.s3_releases` (and the IRSA collection names to `archive.collections`) in "
                          "`backend/config.yaml`, bump `release_tag`."]
            if r["new_week_folders"]:
                lines += [f"* **{len(r['new_week_folders'])} new week folder(s)** after {r['index_last_week']} "
                          f"(archive now ends at {r['archive_last_week']})."]
            lines += ["", "Then: `python scripts/build_coarse_index.py`, `python -m pytest`, redeploy "
                      "(`TAG=vN scripts/deploy_azure.sh`), `python scripts/precompute.py`. See docs/DEPLOY.md."]
            (ROOT / "issue.md").write_text("\n".join(lines) + "\n")
        out = os.environ.get("GITHUB_OUTPUT")
        if out:
            with open(out, "a") as f:
                f.write(f"new_data={'true' if new else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
