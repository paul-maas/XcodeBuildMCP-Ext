#!/usr/bin/env bash
# patch-supergateway.sh — Two fixes to the npx-cached supergateway gateways.
#
# 1. Async send: supergateway calls `transport.send(jsonMsg)` without `await` inside a
#    synchronous try/catch in a forEach callback. Since send() is async, rejected
#    promises escape the catch and crash the process as unhandled rejections when an
#    HTTP connection closes before the response is sent. We wrap the call in `.catch()`.
#
# 2. Progress routing (stateful gateway only): supergateway forwards child notifications
#    with no relatedRequestId, so `notifications/progress` lands on the standalone GET
#    SSE stream instead of the originating request's POST response stream. The response
#    connection then gets no keep-alive traffic and is idle-dropped, and the tool result
#    cannot be delivered. We reunite progress with its request via
#    `relatedRequestId = params.progressToken` (Claude Code sets progressToken == id).
#
# Both are interim workarounds; the native StreamableHTTPServerTransport migration
# (Stage 3 of docs/MCP_HTTP_TRANSPORT_PLAN.md) removes supergateway and both patches.
#
# Upstream issue: https://github.com/supercorp-ai/supergateway/issues/116
#
# Usage:
#   ./scripts/patch-supergateway.sh                # auto-detect npx cache
#   ./scripts/patch-supergateway.sh /path/to/supergateway

set -euo pipefail

if [[ -n "${1:-}" ]]; then
  SG_DIR="$1"
else
  SG_DIR=$(find "$HOME/.npm/_npx" -path "*/node_modules/supergateway" -type d -maxdepth 4 2>/dev/null | head -1)
  if [[ -z "$SG_DIR" ]]; then
    echo "ERROR: Could not find supergateway in npx cache. Pass the path explicitly."
    exit 1
  fi
fi

GATEWAYS="$SG_DIR/dist/gateways"

if [[ ! -d "$GATEWAYS" ]]; then
  echo "ERROR: $GATEWAYS does not exist"
  exit 1
fi

VERSION=$(node -p "require('$SG_DIR/package.json').version" 2>/dev/null || echo "unknown")
echo "Patching supergateway v${VERSION} at ${SG_DIR}"

patch_count=0

patch_file() {
  local file="$1"
  local name
  name=$(basename "$file")

  if [[ ! -f "$file" ]]; then
    echo "  SKIP: $name (not found)"
    return
  fi

  if grep -q 'await transport\.send\|\.send(jsonMsg)\.catch' "$file" 2>/dev/null; then
    echo "  OK:   $name (already patched)"
    return
  fi

  if ! grep -q 'transport\.send(jsonMsg)' "$file" 2>/dev/null; then
    echo "  SKIP: $name (pattern not found)"
    return
  fi

  # Wrap bare `transport.send(jsonMsg)` in `.catch()` to handle rejected promises.
  # This is minimally invasive — no structural changes to forEach/callback.
  sed -i.bak \
    's/transport\.send(jsonMsg);/transport.send(jsonMsg).catch((e) => logger.error("Async send failed:", e));/g' \
    "$file"

  # Same for session.transport.send (stdioToSse.js)
  sed -i.bak \
    's/session\.transport\.send(jsonMsg);/session.transport.send(jsonMsg).catch((e) => logger.error("Async send failed:", e));/g' \
    "$file"

  rm -f "${file}.bak"
  echo "  PATCH: $name"
  patch_count=$((patch_count + 1))
}

# Stateful streamable-HTTP gateway only: route `notifications/progress` to the
# originating request's stream via `relatedRequestId = progressToken`, and wrap in
# `.catch()`. Without this the child's progress notifications are forwarded with no
# relatedRequestId, so the SDK puts them on the standalone GET SSE stream while the
# request's POST response connection receives no keep-alive traffic and is idle-dropped
# by the Docker->host path — the tool result then cannot be delivered ("No connection
# established for request ID: N"). Claude Code sets progressToken == request id, so this
# reunites the heartbeat with the connection that carries the response.
# NOTE: interim workaround; the native StreamableHTTPServerTransport migration (Stage 3
# of docs/MCP_HTTP_TRANSPORT_PLAN.md) removes supergateway and makes this unnecessary.
patch_stateful_file() {
  local file="$1"
  local name
  name=$(basename "$file")

  if [[ ! -f "$file" ]]; then
    echo "  SKIP: $name (not found)"
    return
  fi

  if grep -q 'relatedRequestId' "$file" 2>/dev/null; then
    echo "  OK:   $name (already patched)"
    return
  fi

  if ! grep -q 'transport\.send(jsonMsg);' "$file" 2>/dev/null; then
    echo "  SKIP: $name (pattern not found)"
    return
  fi

  sed -i.bak \
    's|transport\.send(jsonMsg);|transport.send(jsonMsg, (jsonMsg \&\& jsonMsg.method === "notifications/progress" \&\& jsonMsg.params \&\& jsonMsg.params.progressToken != null) ? { relatedRequestId: jsonMsg.params.progressToken } : undefined).catch((e) => logger.error("Async send failed:", e));|g' \
    "$file"

  rm -f "${file}.bak"
  echo "  PATCH: $name (progress routing + async catch)"
  patch_count=$((patch_count + 1))
}

patch_stateful_file "$GATEWAYS/stdioToStatefulStreamableHttp.js"
patch_file "$GATEWAYS/stdioToStatelessStreamableHttp.js"
patch_file "$GATEWAYS/stdioToSse.js"

echo ""
if [[ $patch_count -gt 0 ]]; then
  echo "Patched $patch_count file(s). Restart supergateway to apply."
else
  echo "Nothing to patch."
fi
