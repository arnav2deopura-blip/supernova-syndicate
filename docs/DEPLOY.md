# Run and deploy

## Local

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env
uvicorn backend.server:app --reload --port 8000
python -m http.server 5500 --directory frontend
```

Open http://localhost:5500. Add `?mock=1` to use `frontend/mock/` without a backend.

Run the tests:

```bash
pytest
```

## Frontend (GitHub Pages)

`.github/workflows/deploy-frontend.yml` publishes `frontend/` on every push to `main`.

One-time setup: GitHub → Settings → Pages → Source: **GitHub Actions**.

## Backend (Azure Container Apps) — chosen host

**Live:** https://spherex-api.redgrass-773e0da8.canadacentral.azurecontainerapps.io (`/api/health`). Image tag `v2`, deployed 14 Nov 2026.

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
- Deploys `spherex-api` with 1 vCPU / 2 GiB and 0–1 replicas, then prints the URL. Set `API_BASE` in `frontend/js/api.js` to it.

Redeploy new code with `TAG=v2 scripts/deploy_azure.sh` (any new tag).

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

It prints the service URL. Then set `API_BASE` in `frontend/js/api.js` to that URL and push (Pages redeploys).

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

## Before judging

- Hit the backend once to wake it up (free hosts sleep).
- Confirm the five presets load from `frontend/precomputed/` with the backend off.
- Open every link in a private window.
