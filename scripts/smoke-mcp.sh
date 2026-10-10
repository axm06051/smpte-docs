#!/usr/bin/env bash
# Post-deploy check: ./scripts/smoke-mcp.sh [base-url]
set -Eeuo pipefail

readonly DEFAULT_PORT=3000
readonly HEALTH_PATH=/healthz
readonly MCP_PATH=/mcp
readonly CURL_TIMEOUT=20
readonly HEALTH_TIMEOUT=5
readonly SEARCH_QUERY='ST 2110-21'
readonly DOCUMENT_SLUG=st2110-21
readonly DOCUMENT_LENGTH=500
readonly SEARCH_LIMIT=3

detect_host() {
	if [[ -n "${MCP_HOST:-}" ]]; then
		printf '%s' "$MCP_HOST"
	elif [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then
		ip route show default 2>/dev/null | awk 'NR == 1 {print $3}' || true
	else
		printf localhost
	fi
}

PORT="${PORT:-$DEFAULT_PORT}"
HOST="$(detect_host)"
HOST="${HOST:-localhost}"
BASE="${1:-http://${HOST}:${PORT}}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

EXPORTED_MCP_TOKEN="${MCP_TOKEN:-}"
if [[ -f "$ENV_FILE" ]]; then
    set -a
    source "$ENV_FILE"
    set +a
    [[ -z "$EXPORTED_MCP_TOKEN" ]] || MCP_TOKEN="$EXPORTED_MCP_TOKEN"
else
    printf 'Warning: .env not found at %s\n' "$ENV_FILE" >&2
fi

rpc() {
	local args=(-fsS --max-time "$CURL_TIMEOUT"
		-H 'Content-Type: application/json'
		-H 'Accept: application/json, text/event-stream')
	[[ -z "${MCP_TOKEN:-}" ]] || args+=(-H "Authorization: Bearer ${MCP_TOKEN}")
	curl "${args[@]}" "$BASE$MCP_PATH" -d "$1"
}

readonly INITIALIZE_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
readonly TOOLS_REQUEST='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
readonly SEARCH_REQUEST="{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"search_smpte\",\"arguments\":{\"q\":\"$SEARCH_QUERY\",\"limit\":$SEARCH_LIMIT}}}"
readonly READ_REQUEST="{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"read_smpte_document\",\"arguments\":{\"slug\":\"$DOCUMENT_SLUG\",\"length\":$DOCUMENT_LENGTH}}}"

echo "Target: $BASE"

echo -n "healthz ............ "
curl -fsS --max-time "$HEALTH_TIMEOUT" "$BASE$HEALTH_PATH"
echo

echo -n "initialize ......... "
rpc "$INITIALIZE_REQUEST" | grep -q '"serverInfo"' && echo ok

echo -n "tools/list ......... "
rpc "$TOOLS_REQUEST" | grep -q 'read_smpte_document' && echo ok

echo -n "search_smpte ....... "
rpc "$SEARCH_REQUEST" | grep -q "slug: $DOCUMENT_SLUG" && echo ok

echo -n "read_smpte_document  "
rpc "$READ_REQUEST" | grep -q 'Traffic Shaping' && echo ok

echo "SMOKE TEST PASSED"
