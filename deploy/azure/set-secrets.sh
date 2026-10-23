#!/usr/bin/env bash
# Changes the Anthropic API key or the shared password of an environment that
# deploy.sh created, without rebuilding anything. Data and the image are untouched.
#
# Usage:   ./deploy/azure/set-secrets.sh <name> <action>
#   action:
#     key        store a new API key and turn live Claude on (API and worker)
#     key-off    remove the key and go back to stub mode (API and worker)
#     password   change the shared password (API only); generates one if you
#                leave the prompt empty, and prints it once
# Needs:   Azure CLI logged in (az login), the containerapp extension.
#
# Secrets are never put in files and never printed back. Provide them as
# environment variables (ANTHROPIC_API_KEY, SHARED_PASSWORD) or type them when
# asked (typing is hidden). Note that Azure CLI receives the value as a command
# argument, so run this only on a machine you trust (your own Cloud Shell is fine).
# Each change creates a new revision of the app(s); the old password or key stops
# working a few seconds after the new revision is up.
set -euo pipefail

NAME="${1:?usage: set-secrets.sh <name> key|key-off|password}"
ACTION="${2:?usage: set-secrets.sh <name> key|key-off|password}"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{2,13}$ ]] || { echo "name must be 3-14 chars: lowercase letters, digits, hyphens, starting with a letter" >&2; exit 1; }
case "$ACTION" in key|key-off|password) ;; *) echo "action must be key, key-off or password" >&2; exit 1;; esac

RG="rg-$NAME"
API="api-$NAME"; WORKER="worker-$NAME"
az extension add --name containerapp --upgrade -y >/dev/null
for app in "$API" "$WORKER"; do
  az containerapp show -g "$RG" -n "$app" --query name -o tsv >/dev/null \
    || { echo "$app not found in $RG. Run deploy.sh first." >&2; exit 1; }
done
STAMP="$(date -u +%Y%m%d%H%M%S)"   # a harmless env var that forces a new revision so secrets are re-read

case "$ACTION" in
  key)
    if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then read -rs -p "Anthropic API key (hidden): " ANTHROPIC_API_KEY; echo; fi
    [[ -n "$ANTHROPIC_API_KEY" ]] || { echo "no key given" >&2; exit 1; }
    for app in "$API" "$WORKER"; do
      az containerapp secret set -g "$RG" -n "$app" --secrets "anthropic-key=$ANTHROPIC_API_KEY" -o none
      az containerapp update -g "$RG" -n "$app" --set-env-vars USE_LIVE_CLAUDE=true SECRETS_CHANGED_AT="$STAMP" -o none
    done
    unset ANTHROPIC_API_KEY
    echo "Live Claude is on. These are real, paid model calls. Check /config on the app address shows \"live_claude\": true."
    ;;
  key-off)
    for app in "$API" "$WORKER"; do
      az containerapp secret set -g "$RG" -n "$app" --secrets "anthropic-key=unset" -o none
      az containerapp update -g "$RG" -n "$app" --set-env-vars USE_LIVE_CLAUDE=false SECRETS_CHANGED_AT="$STAMP" -o none
    done
    echo "Back to stub mode (no model calls). Revoke the old key in the Anthropic Console if you will not use it again."
    ;;
  password)
    GENERATED=0
    if [[ -z "${SHARED_PASSWORD:-}" ]]; then
      read -rs -p "New shared password (hidden, 12+ characters; leave empty to generate one): " SHARED_PASSWORD; echo
    fi
    if [[ -z "$SHARED_PASSWORD" ]]; then SHARED_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"; GENERATED=1; fi
    [[ ${#SHARED_PASSWORD} -ge 12 ]] || { echo "the password must be at least 12 characters" >&2; exit 1; }
    az containerapp secret set -g "$RG" -n "$API" --secrets "shared-password=$SHARED_PASSWORD" -o none
    az containerapp update -g "$RG" -n "$API" --set-env-vars SECRETS_CHANGED_AT="$STAMP" -o none
    echo "The shared password was changed. Everyone signed in must use the new one."
    if [[ "$GENERATED" == "1" ]]; then echo "New shared password (shown once): $SHARED_PASSWORD"; fi
    unset SHARED_PASSWORD
    ;;
esac
