#!/usr/bin/env bash
set -euo pipefail

REPO="${SLIPGATE_UPDATE_REPO:-dreamforSh/Slipgate}"
GITHUB_PAT="${SLIPGATE_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
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
    --token)
      GITHUB_PAT="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
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
      echo "Usage: $0 [--channel release|dev] [--version v0.1.0] [--token <github_pat>] [--repo owner/repo] [--prefix /opt/slipgate] [--no-systemd]" >&2
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

AUTH_ARGS=()
if [[ -n "$GITHUB_PAT" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${GITHUB_PAT}")
fi

if [[ "$CHANNEL" == "dev" ]]; then
  RELEASE_API="https://api.github.com/repos/${REPO}/releases/tags/dev-latest"
  RELEASE_TAG="dev-latest"
  ASSET_PREFIX="dev"
else
  if [[ -z "$VERSION" ]]; then
    RELEASE_API="https://api.github.com/repos/${REPO}/releases/latest"
  else
    RELEASE_API="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
  fi
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -n "$GITHUB_PAT" ]]; then
  # Private (or authenticated) GitHub repository path: resolve release metadata & download assets via GitHub REST API.
  REL_JSON="${TMP_DIR}/release.json"
  curl -fsSL "${AUTH_ARGS[@]}" -H "Accept: application/vnd.github+json" "$RELEASE_API" -o "$REL_JSON"
  if [[ "$CHANNEL" != "dev" ]]; then
    RELEASE_TAG="${VERSION:-$(grep -m1 '"tag_name"' "$REL_JSON" | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')}"
    ASSET_PREFIX="$RELEASE_TAG"
  fi
  ARCHIVE_NAME="slipgate-${ASSET_PREFIX}-linux-${ARCH}${MUSL_SUFFIX}.tar.gz"

  extract_asset_url() {
    local target_name="$1"
    tr '{' '\n' < "$REL_JSON" | awk -v target="\"name\":\"${target_name}\"" -v target_sp="\"name\": \"${target_name}\"" '
      (index($0, target) > 0 || index($0, target_sp) > 0) && match($0, /https:\/\/api\.github\.com\/repos\/[^"]+\/releases\/assets\/[0-9]+/) {
        print substr($0, RSTART, RLENGTH)
        exit
      }
    '
  }

  SUMS_URL="$(extract_asset_url "SHA256SUMS.txt")"
  ARCHIVE_URL="$(extract_asset_url "${ARCHIVE_NAME}")"
  if [[ -z "$SUMS_URL" || -z "$ARCHIVE_URL" ]]; then
    echo "Failed to locate ${ARCHIVE_NAME} or SHA256SUMS.txt in release ${RELEASE_TAG} of ${REPO}" >&2
    exit 1
  fi

  echo "==> Downloading ${ARCHIVE_NAME} (${RELEASE_TAG}) from private/authenticated ${REPO}"
  curl -fsSL "${AUTH_ARGS[@]}" -H "Accept: application/octet-stream" "$SUMS_URL" -o "${TMP_DIR}/SHA256SUMS.txt"
  curl -fsSL "${AUTH_ARGS[@]}" -H "Accept: application/octet-stream" "$ARCHIVE_URL" -o "${TMP_DIR}/${ARCHIVE_NAME}"
else
  if [[ "$CHANNEL" != "dev" ]]; then
    if [[ -z "$VERSION" ]]; then
      RELEASE_TAG="$(curl -fsSL "$RELEASE_API" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
      if [[ -z "$RELEASE_TAG" ]]; then
        echo "Failed to resolve latest release tag from ${REPO} (if private repository, pass SLIPGATE_GITHUB_TOKEN or --token)" >&2
        exit 1
      fi
    else
      RELEASE_TAG="$VERSION"
    fi
    ASSET_PREFIX="$RELEASE_TAG"
  fi
  ARCHIVE_NAME="slipgate-${ASSET_PREFIX}-linux-${ARCH}${MUSL_SUFFIX}.tar.gz"
  BASE_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}"

  echo "==> Downloading ${ARCHIVE_NAME} (${RELEASE_TAG}) from ${REPO}"
  curl -fsSL "${BASE_URL}/SHA256SUMS.txt" -o "${TMP_DIR}/SHA256SUMS.txt"
  curl -fsSL "${BASE_URL}/${ARCHIVE_NAME}" -o "${TMP_DIR}/${ARCHIVE_NAME}"
fi

(
  cd "$TMP_DIR"
  grep " ${ARCHIVE_NAME}\$" SHA256SUMS.txt | sha256sum -c -
)

tar -xzf "${TMP_DIR}/${ARCHIVE_NAME}" -C "$TMP_DIR"
BUNDLE_DIR="${TMP_DIR}/slipgate-${ASSET_PREFIX}-linux-${ARCH}${MUSL_SUFFIX}"

mkdir -p "$PREFIX" /etc/slipgate /var/lib/slipgate/hotupdate /var/lib/slipgate/vms /var/run/slipgate
# The binaries may be running (re-running this script upgrades in place). Writing over a running
# executable fails with "Text file busy", so each one is installed under a temporary name and
# renamed over the old path: the running process keeps its old inode until it restarts.
BINARIES=(slipgate slipgate-core slipgate-guestd slipgate-bff)
for bin in "${BINARIES[@]}"; do
  if [[ -f "${BUNDLE_DIR}/${bin}" ]]; then
    install -m 0755 "${BUNDLE_DIR}/${bin}" "${PREFIX}/.${bin}.new"
    mv -f "${PREFIX}/.${bin}.new" "${PREFIX}/${bin}"
  fi
done
# Everything else (web UI, deploy files, migrations) is plain data.
(
  cd "$BUNDLE_DIR"
  for entry in * .[!.]*; do
    [[ -e "$entry" ]] || continue
    case " ${BINARIES[*]} " in *" ${entry} "*) continue ;; esac
    cp -R "$entry" "${PREFIX}/"
  done
)
ln -sf "${PREFIX}/slipgate" /usr/local/bin/slipgate

# Ensure PostgreSQL client tools (pg_dump / pg_restore / psql) are installed for DB backups & restores.
if ! command -v pg_dump >/dev/null 2>&1 || ! command -v pg_restore >/dev/null 2>&1; then
  echo "==> Installing PostgreSQL client utilities for database backups..."
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-client || true
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache postgresql-client || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q postgresql || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q postgresql || true
  fi
fi

# Provision a dedicated unprivileged system account for systemd execution.
if ! getent group slipgate >/dev/null 2>&1; then
  groupadd --system slipgate 2>/dev/null || addgroup -S slipgate 2>/dev/null || true
fi
if ! id -u slipgate >/dev/null 2>&1; then
  useradd --system --gid slipgate --home-dir /var/lib/slipgate --shell /usr/sbin/nologin slipgate 2>/dev/null \
    || adduser -S -G slipgate -h /var/lib/slipgate -s /sbin/nologin slipgate 2>/dev/null || true
fi

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [[ ! -f /etc/slipgate/slipgate.env ]]; then
  cp "${PREFIX}/deploy/.env.example" /etc/slipgate/slipgate.env
  chmod 0600 /etc/slipgate/slipgate.env
  # slipgate refuses to start on the .env.example placeholders, so mint real secrets now.
  sed -i \
    -e "s|^SLIPGATE_JWT_SECRET=.*|SLIPGATE_JWT_SECRET=$(gen_secret)|" \
    -e "s|^SLIPGATE_VAULT_SECRET=.*|SLIPGATE_VAULT_SECRET=$(gen_secret)|" \
    /etc/slipgate/slipgate.env
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
  if [[ -n "$GITHUB_PAT" ]]; then
    echo "SLIPGATE_GITHUB_TOKEN=${GITHUB_PAT}" >> /etc/slipgate/slipgate.env
  fi
  echo "==> Created /etc/slipgate/slipgate.env (0600) with freshly generated JWT/vault secrets; set DATABASE_URL before production use"
  echo "    Back up SLIPGATE_VAULT_SECRET: stored account credentials cannot be decrypted without it."
fi

if id -u slipgate >/dev/null 2>&1; then
  chown -R root:slipgate /etc/slipgate
  chmod 0750 /etc/slipgate
  [[ -f /etc/slipgate/slipgate.env ]] && chmod 0640 /etc/slipgate/slipgate.env
  chown -R slipgate:slipgate /var/lib/slipgate /var/run/slipgate "${PREFIX}"
fi

if [[ "$USE_SYSTEMD" == "true" ]] && command -v systemctl >/dev/null 2>&1; then
  SERVICE_USER_LINES=""
  if id -u slipgate >/dev/null 2>&1; then
    SERVICE_USER_LINES=$'User=slipgate\nGroup=slipgate\nRuntimeDirectory=slipgate\nStateDirectory=slipgate\nNoNewPrivileges=true'
  fi
  cat > /etc/systemd/system/slipgate.service <<EOF
[Unit]
Description=Slipgate Unified AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${SERVICE_USER_LINES}
WorkingDirectory=${PREFIX}
EnvironmentFile=/etc/slipgate/slipgate.env
Environment=SLIPGATE_CORE_BIN=${PREFIX}/slipgate-core
Environment=SLIPGATE_BFF_BIN=${PREFIX}/slipgate-bff
Environment=SLIPGATE_HOTUPDATE_DIR=/var/lib/slipgate/hotupdate
# Undelivered settlements are money owed: keep them under StateDirectory, which (unlike the
# RuntimeDirectory above) survives a service restart and a reboot.
Environment=SLIPGATE_SETTLEMENT_SPOOL_DIR=/var/lib/slipgate/settlement-spool
# VM slot directories hold each slot's immutable machine-id: keep them across restarts too.
Environment=SLIPGATE_VM_DATA_DIR=/var/lib/slipgate/vms
ExecStart=${PREFIX}/slipgate
Restart=always
RestartSec=3
# Stop signals go to the edge alone: it drains in-flight requests, flushes settlements and then
# stops core and the BFF itself (they must stay up meanwhile). Leftovers are killed after the
# timeout, which leaves room for the default 30 s drain window.
KillMode=mixed
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable slipgate.service
  if systemctl is-active --quiet slipgate.service; then
    # An upgrade: the running service still executes the previous binaries until it restarts.
    systemctl restart slipgate.service
    echo "==> Installed systemd unit slipgate.service and restarted the running service on the new version"
  else
    echo "==> Installed systemd unit slipgate.service. Start with: systemctl start slipgate"
  fi
else
  echo "==> Installed Slipgate into ${PREFIX}. Run with: ${PREFIX}/slipgate"
fi
