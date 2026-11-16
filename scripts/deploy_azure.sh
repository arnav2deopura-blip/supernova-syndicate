#!/usr/bin/env bash
# Deploy the backend to Azure Container Apps (works on an Azure for Students subscription, no card).
#
#   az login --tenant <your-school-domain>       # once
#   scripts/deploy_azure.sh                      # build, push, deploy (one awake replica)
#   MIN_REPLICAS=1 scripts/deploy_azure.sh       # keep one replica warm (judging day; uses more credit)
#   TAG=v2 scripts/deploy_azure.sh               # redeploy new code under a new image tag
#
# Azure for Students restrictions this script works around (found 14 Nov 2026):
#   * Region policy: only westus2, canadacentral, westus, norwayeast, francecentral. canadacentral is the
#     closest of those to the SPHEREx S3 mirror (AWS us-east-1).
#   * ACR Tasks (cloud builds, `az containerapp up --source`) are blocked, so the image is built HERE with
#     Docker (cross-built for linux/amd64) and pushed to a Basic registry (~$5/month from the credit).
#
# Why these settings:
#   max replicas 1           background jobs live in one process's memory; polls must reach it.
#   --logs-destination none  no Log Analytics workspace (avoids log-ingestion charges).
#   ingress timeout ~240 s   cold positions must use /api/frames?async=1 (job + polling), not the plain call.
#
# Clean up after the hackathon:  az group delete --name spherex-rg
set -euo pipefail
cd "$(dirname "$0")/.."

RG="${RG:-spherex-rg}"
LOCATION="${LOCATION:-canadacentral}"
ENVNAME="${ENVNAME:-spherex-env}"
APP="${APP:-spherex-api}"
TAG="${TAG:-v1}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"

docker info >/dev/null 2>&1 || { echo "Docker is not running: start Docker Desktop first." >&2; exit 1; }
SUB="$(az account show --query name -o tsv)"
echo "Deploying $APP:$TAG to subscription '$SUB', resource group $RG, region $LOCATION (min replicas: $MIN_REPLICAS)"

az extension add --name containerapp --upgrade --only-show-errors
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.OperationalInsights; do
  az provider register --namespace "$ns" --wait --only-show-errors
done

az group create --name "$RG" --location "$LOCATION" --only-show-errors -o none
if ! az containerapp env show --name "$ENVNAME" --resource-group "$RG" -o none 2>/dev/null; then
  az containerapp env create --name "$ENVNAME" --resource-group "$RG" --location "$LOCATION" \
    --logs-destination none --only-show-errors -o none
fi

ACR="$(az acr list --resource-group "$RG" --query '[0].name' -o tsv)"
if [[ -z "$ACR" ]]; then
  ACR="spherex$(openssl rand -hex 4)"
  az acr create --name "$ACR" --resource-group "$RG" --location "$LOCATION" --sku Basic --only-show-errors -o none
fi
az acr update --name "$ACR" --admin-enabled true --only-show-errors -o none
SERVER="$ACR.azurecr.io"
IMAGE="$SERVER/$APP:$TAG"

az acr login --name "$ACR" --only-show-errors
docker buildx build --platform linux/amd64 -t "$IMAGE" --push .

USER_="$(az acr credential show --name "$ACR" --query username -o tsv)"
PASS_="$(az acr credential show --name "$ACR" --query 'passwords[0].value' -o tsv)"
CACHE_DIR="/tmp/spherex-cache"
[[ -z "${CACHE_STORAGE_NAME:-}" ]] || CACHE_DIR="/mnt/spherex-cache"
ENVV=("ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-https://arnav2deopura-blip.github.io}" "SPHEREX_CACHE_DIR=$CACHE_DIR" "SPHEREX_CACHE_MAX_MB=${SPHEREX_CACHE_MAX_MB:-1500}")
COMMON=(--resource-group "$RG" --image "$IMAGE" --cpu 1 --memory 2Gi
        --min-replicas "$MIN_REPLICAS" --max-replicas 1 --only-show-errors -o none)
if az containerapp show --name "$APP" --resource-group "$RG" -o none 2>/dev/null; then
  az containerapp registry set --name "$APP" --resource-group "$RG" --server "$SERVER" \
    --username "$USER_" --password "$PASS_" --only-show-errors -o none
  az containerapp update --name "$APP" "${COMMON[@]}" --set-env-vars "${ENVV[@]}"  # update: --set-env-vars
else
  az containerapp create --name "$APP" --environment "$ENVNAME" "${COMMON[@]}" --env-vars "${ENVV[@]}" \
    --ingress external --target-port 8000 \
    --registry-server "$SERVER" --registry-username "$USER_" --registry-password "$PASS_"
fi

# Optional pre-provisioned Azure Files environment storage. No account keys are written here.
if [[ -n "${CACHE_STORAGE_NAME:-}" ]]; then
  config_file="$(mktemp -t spherex-volume.XXXXXX)"
  trap 'rm -f "$config_file"' EXIT
  az containerapp show --name "$APP" --resource-group "$RG" -o json > "$config_file"
  python3 - "$config_file" "$CACHE_STORAGE_NAME" <<'PYV'
import json,sys
path,name=sys.argv[1:];app=json.load(open(path));props=app['properties'];template=props['template']
volumes=[v for v in template.get('volumes',[]) if v['name']!='spherex-cache']
volumes.append({'name':'spherex-cache','storageType':'AzureFile','storageName':name});template['volumes']=volumes
for container in template['containers']:
 mounts=[v for v in container.get('volumeMounts',[]) if v['volumeName']!='spherex-cache']
 mounts.append({'volumeName':'spherex-cache','mountPath':'/mnt/spherex-cache'});container['volumeMounts']=mounts
import yaml
with open(path,'w') as f:yaml.safe_dump({'properties':{'configuration':props['configuration'],'template':template}},f)
PYV
  az containerapp update --name "$APP" --resource-group "$RG" --yaml "$config_file" --only-show-errors -o none
fi

URL="https://$(az containerapp show --name "$APP" --resource-group "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
echo
echo "Backend URL: $URL"
echo "Health:      $(curl -s --max-time 180 "$URL/api/health")"
echo "Next: set API_BASE in frontend/js/api.js to $URL"
