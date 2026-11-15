# Run and deploy

## Share Sphere Shift

Public website: https://arnav2deopura-blip.github.io/supernova-syndicate/?api=default

Visitors need only a browser. GitHub Pages serves the frontend over HTTPS, and
the browser sends searches to the Azure API. Neither service depends on a local
development server or an open laptop. The repository URL retains its existing slug.

The five preset targets use saved real SPHEREx observations for quick loading.
Other sky positions use live processing. Add `&fresh=1` to the link to require
the backend for the presets too, with no saved-data fallback. Do not add `mock`
when sharing the real application. An uncached field can take several minutes;
the page displays job progress.

Frontend updates publish automatically when changes reach `main`. Backend
updates require a separate Azure container deployment; pushing Python changes
to GitHub alone does not update the running API.

An optional domain registered through GoDaddy can point to GitHub Pages using
its custom-domain settings and the registrar's DNS records. Domain registration
does not replace the Python processing service. Confirm the participant offer,
renewal price and remaining cloud credits in the relevant account before purchase.
Azure processing, storage and registry usage can incur charges beyond credits.

## Local

See [Run it yourself](../README.md#run-it-yourself) in the README: `scripts/run_local.sh` (frontend, deployed backend) or `scripts/run_local.sh --backend` (both on this machine).

## Frontend (GitHub Pages)

`.github/workflows/deploy-frontend.yml` publishes `frontend/` on every push to `main`.

One-time setup: GitHub → Settings → Pages → Source: **GitHub Actions**.

## Backend (Azure Container Apps) — chosen host

**Live:** https://spherex-api.redgrass-773e0da8.canadacentral.azurecontainerapps.io (`/api/health`). Image tag `v4`, deployed 14 Nov 2026 (adds noise maps + frame astrometry, `/movers`, `/stack`, `/frames.fits`, `/meta` to v3's `/cube`, `/lightcurve`, `/motion`, matched frames, deblended spectra).

Runs on an Azure for Students subscription: no card, paid from the student credit. Cloud Run (below) needed a billing account with a card hold, so we didn't use it.

```bash
brew install azure-cli
az login --tenant <your-school-domain>       # university account; activate Azure for Students first
scripts/deploy_azure.sh                      # needs Docker Desktop running
```

What the script does:
- Creates resource group `spherex-rg` in `canadacentral` and a Container Apps environment with no log workspace.
- Creates a Basic container registry (~$5/month from credit).
- Builds the image locally for `linux/amd64` and pushes it.
- Deploys `spherex-api` with 1 vCPU / 2 GiB and 0–1 replicas, then prints the URL. If the URL changes, update `DEPLOYED_API` in `frontend/js/api.js` (anyone can also point the page at it with `?api=<url>`).

Redeploy new code with `TAG=v5 scripts/deploy_azure.sh` (any new tag).

Azure for Students restrictions this works around:
- **Regions:** only `westus2`, `canadacentral`, `westus`, `norwayeast` and `francecentral` are allowed. `canadacentral` is the closest to the SPHEREx S3 mirror in Virginia.
- **Cloud builds (ACR Tasks / `az containerapp up --source`) are blocked**, hence the local Docker build.

Operating notes:
- **Ingress timeout is ~240 s.** For a position that isn't cached, the frontend must call `/api/frames?...&async=1` and poll `/api/jobs/{id}` (see `API.md`).
- **Max 1 replica:** jobs live in one process's memory.
- **Scale to zero kills running jobs.** After ~5 min with no requests, Azure stops the replica. A client polling `/api/jobs/{id}` (every 1–5 s) keeps it alive; an abandoned job is lost, and the next request restarts it.
- **Measured:** a cold Barnard request (async) took 4.6 min end to end (47 index folders, 61 stamps, 3 passes). The same request cached took 0.26 s.
- **Judging day:** `MIN_REPLICAS=1 scripts/deploy_azure.sh` keeps it warm. Set it back to 0 afterwards.
- **Clean up afterwards:** `az group delete --name spherex-rg`.

## Backend (Google Cloud Run) — alternative, not used

One-time setup (needs a Google Cloud project with billing enabled; Cloud Run's free tier covers light use):

```bash
brew install --cask google-cloud-sdk
gcloud auth login
gcloud config set project <your-project-id>
```

Deploy (Cloud Build builds the `Dockerfile`; no local Docker needed):

```bash
scripts/deploy_cloud_run.sh
```

It prints the service URL. Then set `DEPLOYED_API` in `frontend/js/api.js` to that URL and push (Pages redeploys).

Settings and why (all in the script):

| Setting | Why |
|---|---|
| region `us-east4` | Same metro as the SPHEREx S3 mirror (AWS us-east-1): fast cutouts |
| `--max-instances 1` | Background jobs live in one process; polls must reach it |
| `--no-cpu-throttling` | Async jobs keep running after the 202 response |
| `--timeout 900` | Synchronous `/api/frames` on a cold position can take minutes |
| 2 GiB + `SPHEREX_CACHE_MAX_MB=700` | `/tmp` is memory-backed; the cache prunes oldest files past 700 MB |
| `ALLOWED_ORIGINS=*` | Public read-only API, embeddable anywhere |

Judging day: `MIN_INSTANCES=1 scripts/deploy_cloud_run.sh` keeps one instance warm (no cold start, cache survives). It costs a few dollars per day while on; set it back to 0 afterwards.

Local container (optional, needs Docker running):

```bash
docker build -t spherex-api .
docker run -p 8000:8000 -e ALLOWED_ORIGINS='*' spherex-api
```

## New SPHEREx data

`.github/workflows/check-releases.yml` runs every Monday (and on demand). It lists the public S3 mirror with
`scripts/check_releases.py` and opens an issue "New SPHEREx data on the archive" when a release folder (e.g. `qr4/`)
or week folders newer than the pointing index appear. `GET /api/meta?check=1` gives the same answer live.

To take new data in:

1. New release folder only: add it to `archive.s3_releases` and its IRSA collection names to `archive.collections`
   in `backend/config.yaml`. Always: bump `release_tag`.
2. `python scripts/build_coarse_index.py` (rebuilds `backend/data/coarse_index.json.gz` over every week folder).
3. `python -m pytest`, then redeploy (`TAG=vN scripts/deploy_azure.sh`) and `python scripts/precompute.py`.

Cached products are keyed by `release_tag` + the index fingerprint, so nothing stale is served after step 1–2.

## Before judging

- Hit the backend once to wake it up (free hosts sleep).
- Confirm the five presets load from `frontend/precomputed/` with the backend off.
- Open every link in a private window.

## Current release operations

The revised deploy script defaults to **one awake replica** and one process. Set
`MIN_REPLICAS=0` explicitly only when accepting interrupted work/cold starts to save
credits. The already deployed v4 configuration is historical; local changes do not
change it until a deployment runs. Default CORS is the project's GitHub Pages origin;
set `ALLOWED_ORIGINS` to a comma-separated allowlist for additional sites.

Job status snapshots now live under `SPHEREX_CACHE_DIR`. An interrupted job reports
restart/retry instead of pretending it completed. Durable hosting requires a mounted
volume; ordinary container `/tmp` still disappears on replacement. Provision an
Azure Files share and register it as environment storage using the [Azure storage
mount guide](https://learn.microsoft.com/azure/container-apps/storage-mounts).
Then run `CACHE_STORAGE_NAME=<registered-environment-storage-name> scripts/deploy_azure.sh`.
The script attaches that existing storage at `/mnt/spherex-cache` and uses it for
jobs and products. It does not silently create a storage account or incur its charges.
This mounted path has not been provisioned by the local code audit.

For new data, run the manually dispatched **prepare reviewed SPHEREx index refresh**
workflow. Download its candidate index artifact, review the release span/config,
rebuild saved products with `python scripts/precompute.py --science`, run the suites
and `scripts/validate_live.py`, then commit and deploy together. A newly discovered
release requires adding its collection/release to `backend/config.yaml` before the
refresh. Index contents, backend source and scientific configuration all contribute
to the processing hash, so equal-length index changes invalidate product caches.
The UI's date is the indexed cutoff, not a promise of automatic weekly ingestion.

Release sign-off must follow `RELEASE_READINESS.md` on the actual deployed revision.
Local browser checks do not certify an older public frontend/backend pair.
