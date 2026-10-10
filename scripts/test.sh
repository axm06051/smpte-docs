#!/usr/bin/env bash

set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

bun run format:check
bun run build:app
bun run build:mcp

export NODE_ENV=test
export PORT=3001
export MCP_TOKEN="${MCP_TEST_TOKEN:-'fFAaKke3TtESsttTT0kK3EnN'}"
export LOG_LEVEL=ERROR

bun src/server.ts &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null && break
  sleep 1
done

bun x playwright test
bash ./scripts/smoke-mcp.sh
