#!/usr/bin/env bash
# Rolls out the current code to an environment that deploy.sh already created.
# Builds the frontend and a new image in the registry, runs the database
# migration with the new image (and waits for it), then points the API and the
# worker at the new image. Data (database, attachments) and settings (password,
# API key) are untouched.
#
# Usage:   ./deploy/azure/update.sh <name>      e.g.  ./deploy/azure/update.sh sl-test
# Needs:   Azure CLI logged in (az login), the containerapp extension, npm.
#          Run from the repository root, on the branch you want to release.
# Optional: IMAGE_TAG=...   (default: <git short hash>-<UTC timestamp>, always new,
#                            so the apps really roll to a fresh revision)
set -euo pipefail

NAME="${1:?usage: update.sh <name>   (the name you gave deploy.sh)}"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{2,13}$ ]] || { echo "name must be 3-14 chars: lowercase letters, digits, hyphens, starting with a letter" >&2; exit 1; }
[[ -f backend/Dockerfile ]] || { echo "run this from the repository root" >&2; exit 1; }

RG="rg-$NAME"
SUB_SHORT="$(az account show --query id -o tsv | tr -d '-' | cut -c1-6)"
BARE="${NAME//-/}"
ACR="${BARE}${SUB_SHORT}"; ACR="${ACR:0:50}"
GIT_REV="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
IMAGE_TAG="${IMAGE_TAG:-${GIT_REV}-$(date -u +%Y%m%d%H%M%S)}"

az extension add --name containerapp --upgrade -y >/dev/null
for app in "api-$NAME" "worker-$NAME"; do
  az containerapp show -g "$RG" -n "$app" --query name -o tsv >/dev/null \
    || { echo "$app not found in $RG. Run deploy.sh first." >&2; exit 1; }
done
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "Note: you have uncommitted changes; the image is built from the files on disk, not from commit $GIT_REV."
fi

ACR_SERVER="$(az acr show -g "$RG" -n "$ACR" --query loginServer -o tsv)"
IMAGE="$ACR_SERVER/service-ledger:$IMAGE_TAG"

echo "== Building the frontend (same-origin: VITE_API_BASE_URL empty)"
(cd frontend && npm ci && VITE_API_BASE_URL= npm run build)
echo "== Building $IMAGE in the registry"
az acr build -r "$ACR" -t "service-ledger:$IMAGE_TAG" -f backend/Dockerfile .

echo "== Migration with the new image"
az containerapp job update -g "$RG" -n "job-migrate-$NAME" --image "$IMAGE" -o none
# Follow the run just started (the list also holds earlier runs, e.g. the one from deploy.sh).
EXEC="$(az containerapp job start -g "$RG" -n "job-migrate-$NAME" --query name -o tsv)"
[[ -n "$EXEC" ]] || { echo "could not start the migration job" >&2; exit 1; }
STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(az containerapp job execution show -g "$RG" -n "job-migrate-$NAME" --job-execution-name "$EXEC" --query properties.status -o tsv 2>/dev/null || true)"
  [[ "$STATUS" == "Succeeded" || "$STATUS" == "Failed" ]] && break
  sleep 10
done
if [[ "$STATUS" != "Succeeded" ]]; then
  echo "Migration did not succeed (status: ${STATUS:-unknown}). The apps still run the old image. See the job log:" >&2
  echo "  az containerapp job logs show -g $RG -n job-migrate-$NAME --container job-migrate-$NAME" >&2
  exit 1
fi
echo "   migration succeeded"

echo "== Rolling the API and the worker to the new image"
az containerapp update -g "$RG" -n "api-$NAME" --image "$IMAGE" -o none
az containerapp update -g "$RG" -n "worker-$NAME" --image "$IMAGE" -o none

cat <<DONE

Done. Running image: $IMAGE
  Check the API log:  az containerapp logs show -g $RG -n api-$NAME --follow
  Roll back:          check out the earlier commit and run this script again.
  Address:            https://$(az containerapp show -g "$RG" -n "api-$NAME" --query properties.configuration.ingress.fqdn -o tsv 2>/dev/null || echo "(internal only)")
DONE
