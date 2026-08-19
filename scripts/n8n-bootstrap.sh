#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# n8n bootstrap for CI / local hybrid tests.
#
# Assumes:
#   - n8n is already reachable (compose runs it with a healthcheck; use
#     `docker compose up -d --wait` to block until healthy).
#   - The instance is fresh (no owner set up yet). Re-running against an
#     already-provisioned volume will fail at owner setup; wipe
#     tests/bookshop/.n8n-data first.
#
# 1. POST /rest/owner/setup    - create owner
# 2. POST /rest/api-keys       - mint public-API JWT
# 3. Export to $GITHUB_ENV and tests/bookshop/.env.n8n
#
# Each REST call is retried on non-2xx *and* on 2xx with a non-JSON body,
# because n8n's REST layer can briefly return the plain-text placeholder
# "n8n is starting up. Please wait" during boot / migrations even after
# /healthz reports OK and after previous REST calls have succeeded.
#
# Required env vars:
#   N8N_URL                    e.g. http://localhost:5678
# Optional env vars:
#   N8N_OWNER_EMAIL / N8N_OWNER_PASS / API_KEY_LABEL
# ---------------------------------------------------------------------------
set -euo pipefail

: "${N8N_URL:?N8N_URL must be set (e.g. http://localhost:5678)}"
EMAIL="${N8N_OWNER_EMAIL:-ci-owner@example.com}"
PASS="${N8N_OWNER_PASS:-Ci-Owner-Pass!23}"
LABEL="${API_KEY_LABEL:-cap-js-n8n-ci}"

JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
log() { printf '[n8n-bootstrap] %s\n' "$*" >&2; }

# is_json <file> - returns 0 if file parses as JSON
is_json() {
  node -e 'try { JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(0) } catch { process.exit(1) }' "$1" 2>/dev/null
}

# retry_json <method> <path> <body> <out_file> - calls n8n until the response
# body is valid JSON with a 2xx status, or bails after N attempts.
#
# Retries only on transient conditions:
#   - Network failure (curl reports code 000)
#   - HTTP 5xx (server-side transient)
#   - HTTP 2xx but non-JSON body (n8n's "starting up" placeholder)
# 4xx and 5xx-with-JSON are treated as real errors and fail fast.
retry_json() {
  local method="$1" path="$2" body="$3" out="$4"
  local attempts=30 code
  for j in $(seq 1 "$attempts"); do
    if [ -n "$body" ]; then
      code=$(curl -sS -o "$out" -w '%{http_code}' -b "$JAR" -c "$JAR" \
        -H 'Content-Type: application/json' -X "$method" "$N8N_URL$path" \
        --data "$body" || echo "000")
    else
      code=$(curl -sS -o "$out" -w '%{http_code}' -b "$JAR" -c "$JAR" \
        -X "$method" "$N8N_URL$path" || echo "000")
    fi

    # Success: 2xx with a real JSON body.
    if { [ "$code" = "200" ] || [ "$code" = "201" ]; } && is_json "$out"; then
      return 0
    fi

    # Hard failure: server responded with an actual error (4xx, or 5xx with a
    # JSON error body). No point retrying - surface it immediately.
    if [ "$code" != "000" ] && [ "${code:0:1}" != "5" ] && \
       [ "$code" != "200" ] && [ "$code" != "201" ]; then
      log "$method $path failed with HTTP $code:"
      head -c 500 "$out" >&2; echo >&2
      return 1
    fi
    if [ "${code:0:1}" = "5" ] && is_json "$out"; then
      log "$method $path failed with HTTP $code (JSON error body):"
      head -c 500 "$out" >&2; echo >&2
      return 1
    fi

    # Transient: network error, 5xx without JSON, or 2xx with placeholder body.
    log "[$j/$attempts] $method $path -> HTTP $code (transient); retrying..."
    sleep 2
  done
  log "$method $path failed after $attempts attempts. Last body:"
  head -c 500 "$out" >&2; echo >&2
  return 1
}

# --- 1. Owner setup --------------------------------------------------------
retry_json POST /rest/owner/setup \
  "{\"email\":\"$EMAIL\",\"firstName\":\"CI\",\"lastName\":\"Owner\",\"password\":\"$PASS\"}" \
  /tmp/n8n-setup.json
log "Owner account created ($EMAIL)"

# --- 2. Mint an API key ----------------------------------------------------
SCOPES='["workflow:create","workflow:read","workflow:update","workflow:delete","workflow:list","workflow:move","workflow:activate","workflow:deactivate","workflow:export","workflow:import","execution:read","execution:list","execution:delete","execution:retry","execution:stop","credential:create","credential:read","credential:update","credential:delete","credential:list","credential:move","tag:create","tag:read","tag:update","tag:delete","tag:list","variable:create","variable:update","variable:delete","variable:list","project:create","project:update","project:delete","project:list","user:create","user:read","user:list","user:delete","user:changeRole"]'

retry_json POST /rest/api-keys \
  "{\"label\":\"$LABEL\",\"expiresAt\":null,\"scopes\":$SCOPES}" \
  /tmp/n8n-key.json

RAW_KEY=$(node -e '
  const b = JSON.parse(require("fs").readFileSync("/tmp/n8n-key.json","utf8"));
  process.stdout.write((b.data || b).rawApiKey || "");
')

if [ -z "$RAW_KEY" ]; then
  log "rawApiKey missing from response:"; cat /tmp/n8n-key.json >&2; exit 1
fi

log "API key '$LABEL' minted"

# --- 3. Export -------------------------------------------------------------
printf '%s\n' "$RAW_KEY"

if [ -n "${GITHUB_ENV:-}" ]; then
  { echo "N8N_API_KEY=$RAW_KEY"; echo "N8N_URL=$N8N_URL"; } >> "$GITHUB_ENV"
  log "Exported N8N_API_KEY to \$GITHUB_ENV"
fi

target_env="$(cd "$(dirname "$0")/.." && pwd)/tests/bookshop/.env.n8n"
{ echo "# Auto-generated by scripts/n8n-bootstrap.sh - do not commit"
  echo "N8N_API_KEY=$RAW_KEY"; } > "$target_env"
log "Wrote $target_env"
