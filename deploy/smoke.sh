#!/usr/bin/env bash
# Checks a running deployment: /health is open, the app is closed without the password, the page
# loads, and an uploaded scan comes back byte for byte (so the file storage works). Run it as the
# last step of a deploy or update; it exits non-zero, loudly, when anything is wrong.
#
#   SMOKE_PASSWORD=... deploy/smoke.sh https://the-address
#   SMOKE_STUB=1 SMOKE_PASSWORD=... deploy/smoke.sh https://the-address   # stub extractor: also runs a full upload and finalize
#
# Needs Node and `npm ci` done in frontend/ (the script runs it if node_modules is missing). Records
# it creates are named SMOKE-<timestamp> and are deleted again.
set -euo pipefail

url="${1:-}"
if [[ -z "$url" ]]; then
  echo "usage: SMOKE_PASSWORD=... $0 <https://deployed-address>" >&2
  exit 2
fi
if [[ -z "${SMOKE_PASSWORD:-}" ]]; then
  echo "smoke: SMOKE_PASSWORD is not set" >&2
  exit 2
fi

cd "$(dirname "$0")/../frontend"
[[ -d node_modules ]] || npm ci

if BASE_URL="$url" npx playwright test --config=playwright.smoke.config.ts; then
  echo "smoke: $url is healthy"
else
  echo "smoke: FAILED against $url - do not treat this deploy as good" >&2
  exit 1
fi
