#!/usr/bin/env bash
set -euo pipefail

REPO="${SLIPGATE_UPDATE_REPO:-dreamforSh/Slipgate}"
CHANNEL="release"
VERSION=""
PREFIX="/opt/slipgate"
USE_SYSTEMD=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      CHANNEL="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --prefix)
      PREFIX="$2"
      shift 2
      ;;
    --no-systemd)
      USE_SYSTEMD=false
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--channel release|dev] [--version v0.1.0] [--prefix /opt/slipgate] [--no-systemd]" >&2
      exit 1
      ;;
  esac
done

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

MUSL_SUFFIX=""
if [[ -f /etc/alpine-release ]] || ldd --version 2>&1 | grep -qi musl; then
  MUSL_SUFFIX="-musl"
fi

if [[ "$CHANNEL" == "dev" ]]; then
  RELEASE_TAG="dev-latest"
  ASSET_PREFIX="dev"
else
  if [[ -z "$VERSION" ]]; then
    RELEASE_TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    if [[ -z "$RELEASE_TAG" ]]; then
      echo "Failed to resolve latest release tag from ${REPO}" >&2
      exit 1
    fi
  else
    RELEASE_TAG="$VERSION"
  fi
  ASSET_PREFIX="$RELEASE_TAG"
fi

ARCHIVE_NAME="slipgate-${ASSET_PREFIX}-linux-${ARCH}${MUSL_SUFFIX}.tar.gz"
BASE_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Downloading ${ARCHIVE_NAME} (${RELEASE_TAG}) from ${REPO}"
curl -fsSL "${BASE_URL}/SHA256SUMS.txt" -o "${TMP_DIR}/SHA256SUMS.txt"
curl -fsSL "${BASE_URL}/${ARCHIVE_NAME}" -o "${TMP_DIR}/${ARCHIVE_NAME}"

(
  cd "$TMP_DIR"
  grep " ${ARCHIVE_NAME}\$" SHA256SUMS.txt | sha256sum -c -
)

tar -xzf "${TMP_DIR}/${ARCHIVE_NAME}" -C "$TMP_DIR"
BUNDLE_DIR="${TMP_DIR}/slipgate-${ASSET_PREFIX}-linux-${ARCH}${MUSL_SUFFIX}"

mkdir -p "$PREFIX" /etc/slipgate /var/run/slipgate/hotupdate
cp -R "${BUNDLE_DIR}/." "${PREFIX}/"
chmod 0755 "${PREFIX}/slipgate" "${PREFIX}/slipgate-core" "${PREFIX}/slipgate-guestd" "${PREFIX}/slipgate-bff"
ln -sf "${PREFIX}/slipgate" /usr/local/bin/slipgate

if [[ ! -f /etc/slipgate/slipgate.env ]]; then
  cp "${PREFIX}/deploy/.env.example" /etc/slipgate/slipgate.env
  if [[ "$CHANNEL" == "dev" ]]; then
    {
      echo ""
      echo "SLIPGATE_MODE=dev"
      echo "SLIPGATE_DEV_SYNC_MODE=release"
      echo "SLIPGATE_DEV_SYNC_INTERVAL_SEC=60"
      echo "SLIPGATE_UPDATE_REPO=${REPO}"
      echo "SLIPGATE_UPDATE_BRANCH=main"
    } >> /etc/slipgate/slipgate.env
  fi
  echo "==> Created default /etc/slipgate/slipgate.env (update secrets & DATABASE_URL before production use)"
fi

if [[ "$USE_SYSTEMD" == "true" ]] && command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/slipgate.service <<EOF
[Unit]
Description=Slipgate Unified AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PREFIX}
EnvironmentFile=/etc/slipgate/slipgate.env
Environment=SLIPGATE_CORE_BIN=${PREFIX}/slipgate-core
Environment=SLIPGATE_BFF_BIN=${PREFIX}/slipgate-bff
Environment=SLIPGATE_HOTUPDATE_DIR=/var/run/slipgate/hotupdate
ExecStart=${PREFIX}/slipgate
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable slipgate.service
  echo "==> Installed systemd unit slipgate.service. Start with: systemctl start slipgate"
else
  echo "==> Installed Slipgate into ${PREFIX}. Run with: ${PREFIX}/slipgate"
fi
