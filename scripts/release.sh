#!/usr/bin/env bash
set -Eeuo pipefail

APP="smpte"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-$(awk -F'"' '/"version"[[:space:]]*:/ {print $4; exit}' "$ROOT/package.json")}"
PORT="${PORT:-3000}"
IMAGE="${APP}:${VERSION}"
WORK="$ROOT/.release"
OUT="$ROOT/release/${APP}-${VERSION}"

command -v docker >/dev/null 2>&1 || {
	echo "Docker is required."
	exit 1
}

[[ -f "$ROOT/package.json" ]] || {
	echo "Run this from the project root."
	exit 1
}

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK" "$OUT"

echo "Building ${IMAGE}..."
docker build --file "$ROOT/Dockerfile" --tag "$IMAGE" "$ROOT"

echo "Exporting image..."
IMAGE_TAR="$OUT/${APP}-${VERSION}.image.tar"

docker save "$IMAGE" -o "$IMAGE_TAR"
gzip -f "$IMAGE_TAR"

echo "Image exported: $OUT/${APP}-${VERSION}.image.tar.gz"

if [[ -f "$ROOT/.env.example" ]]; then
	cp "$ROOT/.env.example" "$OUT/.env.example"
fi

cat >"$OUT/install.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail

APP="${APP}"
VERSION="${VERSION}"
IMAGE="\${APP}:\${VERSION}"
PORT="\${PORT:-${PORT}}"
DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required."
  exit 1
}

docker load -i "\${DIR}/\${APP}-\${VERSION}.image.tar.gz"
docker rm -f "\${APP}" >/dev/null 2>&1 || true

if [[ -f "\${DIR}/.env" ]]; then
  docker run -d --name "\${APP}" --restart unless-stopped \
    --env-file "\${DIR}/.env" \
    -e PORT="\${PORT}" -p "\${PORT}:\${PORT}" \
    "\${IMAGE}"
else
  docker run -d --name "\${APP}" --restart unless-stopped \
    -e PORT="\${PORT}" -p "\${PORT}:\${PORT}" \
    "\${IMAGE}"
fi

echo
echo "Installed: \${APP}"
echo "Version:   \${VERSION}"
echo "Port:      \${PORT}"
echo "LAN URL:   http://<server-ip>:\${PORT}"
echo "MCP:    http://127.0.0.1:\${PORT}/mcp"
EOF

chmod +x "$OUT/install.sh"

cp "$ROOT/.env.example" "$OUT/.env.example" 2>/dev/null || true

cat >"$OUT/README.txt" <<EOF
SMPTE ${VERSION}

Install:
  ./install.sh

Optional environment:
  cp .env.example .env
  edit .env
  ./install.sh

Default port:
  ${PORT}

LAN:
  http://<server-ip>:${PORT}

MCP
  http://<server-ip>:${PORT}/mcp
EOF

tar -C "$ROOT/release" \
	-czf "$ROOT/release/${APP}-${VERSION}.tar.gz" \
	"${APP}-${VERSION}"

echo "Release created: release/${APP}-${VERSION}.tar.gz"