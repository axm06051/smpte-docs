#!/usr/bin/env bash
set -Eeuo pipefail

APP="smpte"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
REMOTE="${REMOTE}"
REMOTE_BASE="${REMOTE_BASE}"
PORT="${PORT:-3000}"
ARCHIVE="${APP}-${VERSION}.tar.gz"

[[ -n "$VERSION" ]] || {
  echo "Unable to determine release version from package.json."
  exit 1
}

command -v ssh >/dev/null 2>&1 && command -v scp >/dev/null 2>&1 || {
  echo "OpenSSH client (ssh and scp) is required."
  exit 1
}

echo "Checking key-based SSH access to ${REMOTE}..."
ssh \
	-o ConnectTimeout=10 \
	-o StrictHostKeyChecking=accept-new \
	"$REMOTE" true

LOCAL_ARCHIVE="$ROOT/release/$ARCHIVE"
if [[ -f "$LOCAL_ARCHIVE" && "${REBUILD:-0}" != "1" ]]; then
	echo "Reusing existing ${LOCAL_ARCHIVE} (REBUILD=1 to rebuild; bump the version for new code)."
else
	echo "Building release ${VERSION}..."
	VERSION="$VERSION" PORT="$PORT" bash "$ROOT/scripts/release.sh"
fi

[[ -f "$LOCAL_ARCHIVE" ]] || {
	echo "Release archive was not created: $LOCAL_ARCHIVE"
	exit 1
}

echo "Uploading ${ARCHIVE} to ${REMOTE} home directory..."
scp \
	-o ConnectTimeout=10 \
	-o StrictHostKeyChecking=accept-new \
	"$LOCAL_ARCHIVE" "$REMOTE:$ARCHIVE"

REMOTE_SCRIPT='set -Eeuo pipefail

base_dir="$1"
app="$2"
version="$3"
archive="$4"
port="$5"
release_dir="$base_dir/$app-$version"
login_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
archive_path="$login_home/$archive"

mkdir -p "$base_dir"
tar -xzf "$archive_path" -C "$base_dir"

if [[ ! -f "$release_dir/.env" ]]; then
  for candidate in "$base_dir/$app"-*/.env; do
    [[ -f "$candidate" ]] || continue
    [[ "$candidate" == "$release_dir/.env" ]] && continue
    cp "$candidate" "$release_dir/.env"
    chmod 600 "$release_dir/.env"
    echo "Preserved settings from ${candidate}"
    break
  done
fi

if [[ -f "$release_dir/.env" ]]; then
  chmod 600 "$release_dir/.env"
fi

cd "$release_dir"
./install.sh

curl \
  --fail \
  --silent \
  --show-error \
  --retry 10 \
  --retry-connrefused \
  --retry-delay 1 \
  "http://127.0.0.1:$port/" >/dev/null

rm -f "$archive_path"

echo "Published ${app}:${version}"
echo "LAN: http://<server-ip>:${port}"'

bash -n <<<"$REMOTE_SCRIPT"

REMOTE_SCRIPT_QUOTED="$(printf '%q' "$REMOTE_SCRIPT")"
printf -v REMOTE_ARGS '%q ' \
	"$REMOTE_BASE" \
	"$APP" \
	"$VERSION" \
	"$ARCHIVE" \
	"$PORT"

echo "Installing on ${REMOTE}..."
ssh \
	-t \
	-o ConnectTimeout=10 \
	-o StrictHostKeyChecking=accept-new \
	"$REMOTE" \
	"sudo bash -c $REMOTE_SCRIPT_QUOTED publish $REMOTE_ARGS"

echo "Publish complete."
