#!/usr/bin/env bash
# Sets up ServiceLedger for a few testers on Azure (see the project doc
# claude/proposal-azure-deployment.md). Creates, in one resource group:
#   Azure Database for PostgreSQL (Flexible Server), a storage account with an
#   Azure Files share for attachments, a container registry, a Container Apps
#   environment, a one-off migration job (run and awaited before the apps are created), the API app and the worker app.
#
# The image (backend/Dockerfile) carries the API, the worker code and the built
# frontend. The API asks for one shared password (HTTP Basic, SHARED_PASSWORD);
# the script generates one if you do not provide it, and prints it once at the
# end. Ingress defaults to INTERNAL (unreachable from the internet) until you
# choose INGRESS=external.
#
# Usage:   ./deploy.sh <name>        e.g.  ./deploy.sh sl-test
# Needs:   Azure CLI logged in (az login), the containerapp extension,
#          openssl. Run from the repository root (the image is built there).
# Optional environment variables (never put keys in files):
#   LOCATION=westeurope            Azure region (decide with the project owner)
#   ANTHROPIC_API_KEY=...          turns on live Claude (USE_LIVE_CLAUDE=true)
#   SHARED_PASSWORD=...            at least 12 characters (generated if absent)
#   INGRESS=external               public URL, protected by the shared password
#   IMAGE_TAG=latest
#   BUILD_IMAGE=1                  build the frontend (npm) and then the image in
#                                  the registry from backend/Dockerfile
set -euo pipefail

NAME="${1:?usage: deploy.sh <name>   (lowercase letters, digits, hyphens; 3-14 chars)}"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{2,13}$ ]] || { echo "name must be 3-14 chars: lowercase letters, digits, hyphens, starting with a letter" >&2; exit 1; }

LOCATION="${LOCATION:-westeurope}"
INGRESS="${INGRESS:-internal}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
RG="rg-$NAME"
SUB_SHORT="$(az account show --query id -o tsv | tr -d '-' | cut -c1-6)"
BARE="${NAME//-/}"
STORAGE="${BARE}${SUB_SHORT}"; STORAGE="${STORAGE:0:24}"      # globally unique, 3-24 lowercase alphanumerics
ACR="${BARE}${SUB_SHORT}"; ACR="${ACR:0:50}"
PG="pg-${NAME}-${SUB_SHORT}"                                  # globally unique server name
PG_ADMIN="slAdmin"
PG_DB="service_ledger"
SHARE="attachments"
ENV_NAME="cae-$NAME"
LAW="log-$NAME"

# Re-running resumes a first deploy that stopped half way: steps whose resource
# already exists are skipped. It never touches a deployment that is running
# (the apps hold the passwords and the data); releases go through update.sh.
exists() { "$@" -o none >/dev/null 2>&1; }
if exists az containerapp show -g "$RG" -n "api-$NAME" || exists az containerapp show -g "$RG" -n "worker-$NAME"; then
  echo "$NAME is already deployed (api-$NAME or worker-$NAME exists in $RG). deploy.sh only sets up a new" >&2
  echo "environment or finishes one that stopped half way. To release new code: ./deploy/azure/update.sh $NAME" >&2
  exit 1
fi
if exists az group show -n "$RG"; then
  echo "Resource group $RG exists without the apps: resuming. Existing resources are kept; the database"
  echo "admin password is reset, because the one from the earlier run was never stored."
fi

if [[ "$INGRESS" == "external" ]]; then
  echo "INGRESS=external makes the app reachable from the internet. It is protected only by one shared password"
  echo "(no accounts, everyone who knows it can change everything)."
  read -r -p "Type 'open' to continue: " ans; [[ "$ans" == "open" ]] || exit 1
fi
GENERATED_PASSWORD=0
if [[ -z "${SHARED_PASSWORD:-}" ]]; then SHARED_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"; GENERATED_PASSWORD=1; fi
[[ ${#SHARED_PASSWORD} -ge 12 ]] || { echo "SHARED_PASSWORD must be at least 12 characters" >&2; exit 1; }

az extension add --name containerapp --upgrade -y >/dev/null
az provider register --namespace Microsoft.App --wait >/dev/null
az provider register --namespace Microsoft.OperationalInsights --wait >/dev/null

echo "== Resource group $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

echo "== Log analytics + Container Apps environment"
az monitor log-analytics workspace create -g "$RG" -n "$LAW" -l "$LOCATION" -o none
LAW_ID="$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query customerId -o tsv)"
LAW_KEY="$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LAW" --query primarySharedKey -o tsv)"
if exists az containerapp env show -g "$RG" -n "$ENV_NAME"; then
  echo "   environment $ENV_NAME exists, keeping it"
else
  az containerapp env create -g "$RG" -n "$ENV_NAME" -l "$LOCATION" \
    --logs-workspace-id "$LAW_ID" --logs-workspace-key "$LAW_KEY" -o none
fi
# Creation continues in the background; wait until it is ready or the next steps are refused.
echo "   waiting for the environment to be provisioned..."
ENV_STATE=""
for _ in $(seq 1 60); do
  ENV_STATE="$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.provisioningState -o tsv 2>/dev/null || true)"
  [[ "$ENV_STATE" == "Succeeded" || "$ENV_STATE" == "Failed" ]] && break
  sleep 10
done
[[ "$ENV_STATE" == "Succeeded" ]] || { echo "Container Apps environment is not ready (state: ${ENV_STATE:-unknown}). Check: az containerapp env show -g $RG -n $ENV_NAME" >&2; exit 1; }

echo "== Storage account and file share for attachments"
if exists az storage account show -g "$RG" -n "$STORAGE"; then
  echo "   storage account $STORAGE exists, keeping it"
else
  az storage account create -g "$RG" -n "$STORAGE" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 --allow-blob-public-access false -o none
fi
STORAGE_KEY="$(az storage account keys list -g "$RG" -n "$STORAGE" --query '[0].value' -o tsv)"
if [[ "$(az storage share-rm exists -g "$RG" --storage-account "$STORAGE" -n "$SHARE" --query exists -o tsv)" == "true" ]]; then
  echo "   file share $SHARE exists, keeping it"
else
  az storage share-rm create -g "$RG" --storage-account "$STORAGE" -n "$SHARE" --quota 20 -o none
fi
# Safe to repeat: points the environment at the share with the current key.
az containerapp env storage set -g "$RG" -n "$ENV_NAME" --storage-name attachments \
  --azure-file-account-name "$STORAGE" --azure-file-account-key "$STORAGE_KEY" \
  --azure-file-share-name "$SHARE" --access-mode ReadWrite -o none

echo "== PostgreSQL Flexible Server (smallest burstable size)"
PG_PASSWORD="$(openssl rand -hex 24)"      # hex only, so it is safe inside a URL
if exists az postgres flexible-server show -g "$RG" -n "$PG"; then
  # Left over from an earlier run that stopped before the apps (which would hold the password) were created.
  echo "   server $PG exists, keeping it and setting a new admin password"
  az postgres flexible-server update -g "$RG" -n "$PG" --admin-password "$PG_PASSWORD" -o none
else
  az postgres flexible-server create -g "$RG" -n "$PG" -l "$LOCATION" --version 16 \
    --tier Burstable --sku-name Standard_B1ms --storage-size 32 \
    --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
    --public-access 0.0.0.0 --yes -o none     # 0.0.0.0 = allow Azure services only, not the internet
fi
if exists az postgres flexible-server db show -g "$RG" --server-name "$PG" --database-name "$PG_DB"; then
  echo "   database $PG_DB exists, keeping it"
else
  az postgres flexible-server db create -g "$RG" --server-name "$PG" --name "$PG_DB" -o none
fi
DATABASE_URL="postgresql+psycopg2://${PG_ADMIN}:${PG_PASSWORD}@${PG}.postgres.database.azure.com:5432/${PG_DB}?sslmode=require"

echo "== Container registry"
if exists az acr show -g "$RG" -n "$ACR"; then
  echo "   registry $ACR exists, keeping it"
else
  az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled true -o none
fi
ACR_SERVER="$(az acr show -g "$RG" -n "$ACR" --query loginServer -o tsv)"
ACR_USER="$(az acr credential show -n "$ACR" --query username -o tsv)"
ACR_PASS="$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)"
IMAGE="$ACR_SERVER/service-ledger:$IMAGE_TAG"
if [[ "${BUILD_IMAGE:-0}" == "1" ]]; then
  [[ -f backend/Dockerfile ]] || { echo "run this from the repository root" >&2; exit 1; }
  echo "== Building the frontend (same-origin: VITE_API_BASE_URL empty)"
  (cd frontend && npm ci && VITE_API_BASE_URL= npm run build)
  echo "== Building the image in the registry"
  az acr build -r "$ACR" -t "service-ledger:$IMAGE_TAG" -f backend/Dockerfile .
else
  echo "   (BUILD_IMAGE not set: push '$IMAGE' yourself before the apps below can start)"
fi

LIVE=false; [[ -n "${ANTHROPIC_API_KEY:-}" ]] && LIVE=true
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT; chmod 700 "$TMP"

# One YAML per app: volumes can only be mounted through YAML, and the secret
# values live in a temp file that is deleted when the script ends.
write_app_yaml() {  # $1 file  $2 app name  $3 command-json  $4 ingress-yaml  $5 extra env lines (yaml, may be empty)
cat > "$1" <<YAML
location: $LOCATION
properties:
  environmentId: $(az containerapp env show -g "$RG" -n "$ENV_NAME" --query id -o tsv)
  configuration:
    $4
    registries:
      - server: $ACR_SERVER
        username: $ACR_USER
        passwordSecretRef: acr-password
    secrets:
      - name: acr-password
        value: "$ACR_PASS"
      - name: database-url
        value: "$DATABASE_URL"
      - name: anthropic-key
        value: "${ANTHROPIC_API_KEY:-unset}"
      - name: shared-password
        value: "$SHARED_PASSWORD"
  template:
    containers:
      - name: $2
        image: $IMAGE
        command: $3
        resources: { cpu: 0.5, memory: 1Gi }
        env:
          - { name: DATABASE_URL, secretRef: database-url }
          - { name: ANTHROPIC_API_KEY, secretRef: anthropic-key }
          - { name: USE_LIVE_CLAUDE, value: "$LIVE" }
          - { name: ATTACHMENT_STORAGE_DIR, value: /data/attachments }
$5
        volumeMounts:
          - { volumeName: attachments, mountPath: /data }
    volumes:
      - name: attachments
        storageType: AzureFile
        storageName: attachments
    scale: { minReplicas: 1, maxReplicas: 1 }
YAML
}

echo "== One-off migration job (alembic upgrade head)"
if exists az containerapp job show -g "$RG" -n "job-migrate-$NAME"; then
  # It holds the old database password; recreating it is simpler than patching it, and it keeps no data.
  echo "   replacing the migration job left by an earlier run"
  az containerapp job delete -g "$RG" -n "job-migrate-$NAME" --yes -o none
fi
az containerapp job create -g "$RG" -n "job-migrate-$NAME" --environment "$ENV_NAME" \
  --trigger-type Manual --replica-timeout 600 --replica-retry-limit 1 \
  --image "$IMAGE" --registry-server "$ACR_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
  --secrets "database-url=$DATABASE_URL" --env-vars "DATABASE_URL=secretref:database-url" \
  --command "alembic" --args "upgrade" "head" --cpu 0.5 --memory 1Gi -o none
# Run the migration now and wait for it, so the API never starts against an empty
# database (it seeds the fleet on startup and would crash-loop without the tables).
echo "   running the migration and waiting for it..."
az containerapp job start -g "$RG" -n "job-migrate-$NAME" -o none
STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(az containerapp job execution list -g "$RG" -n "job-migrate-$NAME" --query '[0].properties.status' -o tsv 2>/dev/null || true)"
  [[ "$STATUS" == "Succeeded" || "$STATUS" == "Failed" ]] && break
  sleep 10
done
if [[ "$STATUS" != "Succeeded" ]]; then
  echo "Migration did not succeed (status: ${STATUS:-unknown}). Nothing else was started. See the job log:" >&2
  echo "  az containerapp job logs show -g $RG -n job-migrate-$NAME --container job-migrate-$NAME" >&2
  exit 1
fi
echo "   migration succeeded"

echo "== API app (ingress: $INGRESS) and worker app"
if [[ "$INGRESS" == "external" ]]; then INGRESS_YAML="ingress: { external: true, targetPort: 8000, allowInsecure: false }"; else INGRESS_YAML="ingress: { external: false, targetPort: 8000, allowInsecure: false }"; fi
write_app_yaml "$TMP/api.yaml" "api" '["python","-m","uvicorn","app.main:app","--host","0.0.0.0","--port","8000","--no-access-log"]' "$INGRESS_YAML" "          - { name: SHARED_PASSWORD, secretRef: shared-password }"
write_app_yaml "$TMP/worker.yaml" "worker" '["python","-m","app.worker"]' "activeRevisionsMode: Single" ""
az containerapp create -g "$RG" -n "api-$NAME" --yaml "$TMP/api.yaml" -o none
az containerapp create -g "$RG" -n "worker-$NAME" --yaml "$TMP/worker.yaml" -o none

cat <<DONE

Done. Resource group: $RG
  Postgres:  $PG.postgres.database.azure.com   (admin $PG_ADMIN; the password is stored only as a Container Apps secret)
  Storage:   $STORAGE / share $SHARE (mounted at /data in both apps)
  Registry:  $ACR_SERVER
  Live Claude: $LIVE
Next:
  1. Make sure the image exists: $IMAGE
  2. (The migration already ran; run it again after a new release with:
      az containerapp job start -g $RG -n job-migrate-$NAME)
  3. Check the API log:           az containerapp logs show -g $RG -n api-$NAME --follow
  4. Stop paying when finished:   ./deploy/azure/destroy.sh $NAME
DONE
if [[ "$INGRESS" == "external" ]]; then
  echo "Address:  https://$(az containerapp show -g "$RG" -n "api-$NAME" --query properties.configuration.ingress.fqdn -o tsv)"
fi
if [[ "$GENERATED_PASSWORD" == "1" ]]; then
  echo "Shared password (shown once, also stored as the 'shared-password' secret of api-$NAME): $SHARED_PASSWORD"
fi
