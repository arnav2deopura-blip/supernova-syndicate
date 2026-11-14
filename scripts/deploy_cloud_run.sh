#!/usr/bin/env bash
# Deploy the backend to Google Cloud Run from source (Cloud Build runs the Dockerfile; no local Docker).
#
#   gcloud auth login && gcloud config set project <your-project-id>
#   scripts/deploy_cloud_run.sh            # normal deploy (scales to zero when idle)
#   MIN_INSTANCES=1 scripts/deploy_cloud_run.sh   # keep one warm instance (judging day; costs a few $/day)
#
# Why these flags:
#   --region us-east4        Ashburn, VA: same metro as the SPHEREx S3 mirror (AWS us-east-1) -> fast stamps.
#   --max-instances 1        background jobs live in one process's memory; polls must hit that instance.
#   --no-cpu-throttling      async jobs keep running after the 202 response is sent.
#   --timeout 900            the synchronous /api/frames path can take minutes on a cold position.
#   --memory 2Gi + cache cap /tmp is memory-backed on Cloud Run; SPHEREX_CACHE_MAX_MB keeps it bounded.
#   ALLOWED_ORIGINS=*        public, read-only GET API meant to be embedded anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE="${SERVICE:-spherex-api}"
REGION="${REGION:-us-east4}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
if [[ -z "$PROJECT" ]]; then
  echo "No gcloud project set. Run: gcloud config set project <your-project-id>" >&2
  exit 1
fi
echo "Deploying $SERVICE to project $PROJECT, region $REGION (min instances: $MIN_INSTANCES)"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$PROJECT"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 2Gi --cpu 2 \
  --timeout 900 \
  --concurrency 40 \
  --no-cpu-throttling \
  --min-instances "$MIN_INSTANCES" --max-instances 1 \
  --set-env-vars "ALLOWED_ORIGINS=*,SPHEREX_CACHE_DIR=/tmp/spherex-cache,SPHEREX_CACHE_MAX_MB=700"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo
echo "Backend URL: $URL"
echo "Health:      $(curl -s "$URL/api/health")"
echo "Next: set API_BASE in frontend/js/api.js to $URL"
