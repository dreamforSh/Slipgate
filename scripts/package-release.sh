#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "Usage: $0 <tag_slug> <version> <commit> <out_dir>" >&2
  exit 1
fi

TAG_SLUG="$1"
VERSION="$2"
COMMIT="$3"
OUT_DIR="$(cd "$(dirname "$4")" && pwd)/$(basename "$4")"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

mkdir -p "$OUT_DIR"

echo "==> Packaging Slipgate (tag=$TAG_SLUG version=$VERSION commit=$COMMIT)"

# 1. Build Vue 3 SPA and sync assets into Go embed directory
cd "$ROOT_DIR"
if [[ ! -d node_modules ]]; then
  if [[ -f bun.lock ]]; then
    bun install --frozen-lockfile
  else
    bun install
  fi
fi

bun run --cwd apps/web-vue build
rm -rf services/net-go/internal/webui/dist
mkdir -p services/net-go/internal/webui/dist
cp -R apps/web-vue/dist/. services/net-go/internal/webui/dist/

# 2. Cross-compile Zig Core Engine (slipgate-core + slipgate-guestd)
build_zig() {
  local zig_target="$1"
  local zig_out="$2"
  rm -rf "$zig_out"
  mkdir -p "$zig_out"
  (
    cd "$ROOT_DIR/services/core-zig"
    zig build --prefix "$zig_out" -Dtarget="$zig_target" -Doptimize=ReleaseSafe
  )
}

build_zig "x86_64-linux-musl" "$STAGE_DIR/zig-linux-amd64"
build_zig "aarch64-linux-musl" "$STAGE_DIR/zig-linux-arm64"
build_zig "x86_64-windows-gnu" "$STAGE_DIR/zig-windows-amd64"

# 3. Cross-compile Bun BFF binaries
compile_bff() {
  local bun_target="$1"
  local out_bin="$2"
  bun build --compile --target="$bun_target" \
    "$ROOT_DIR/services/bff-ts/src/index.ts" \
    --outfile "$out_bin"
}

mkdir -p "$STAGE_DIR/bff"
compile_bff "bun-linux-x64" "$STAGE_DIR/bff/slipgate-bff-linux-amd64"
compile_bff "bun-linux-x64-musl" "$STAGE_DIR/bff/slipgate-bff-linux-amd64-musl"
compile_bff "bun-linux-arm64" "$STAGE_DIR/bff/slipgate-bff-linux-arm64"
compile_bff "bun-linux-arm64-musl" "$STAGE_DIR/bff/slipgate-bff-linux-arm64-musl"
compile_bff "bun-windows-x64" "$STAGE_DIR/bff/slipgate-bff-windows-amd64.exe"

# 4. Cross-compile Go Edge & Supervisor with embedded Vue UI + build ldflags
build_go() {
  local goos="$1"
  local goarch="$2"
  local out_bin="$3"
  (
    cd "$ROOT_DIR/services/net-go"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build \
      -trimpath \
      -ldflags="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
      -o "$out_bin" \
      ./cmd/slipgate
  )
}

mkdir -p "$STAGE_DIR/go"
build_go "linux" "amd64" "$STAGE_DIR/go/slipgate-linux-amd64"
build_go "linux" "arm64" "$STAGE_DIR/go/slipgate-linux-arm64"
build_go "windows" "amd64" "$STAGE_DIR/go/slipgate-windows-amd64.exe"

BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$OUT_DIR/BUILD_META.json" <<EOF
{
  "tag": "${TAG_SLUG}",
  "version": "${VERSION}",
  "commit": "${COMMIT}",
  "builtAt": "${BUILT_AT}"
}
EOF

# 5. Assemble deployable platform bundles
package_linux() {
  local platform_slug="$1"
  local arch_key="$2"
  local bff_key="$3"
  local bundle_name="slipgate-${TAG_SLUG}-${platform_slug}"
  local bundle_dir="$STAGE_DIR/bundles/$bundle_name"

  mkdir -p "$bundle_dir/webui" "$bundle_dir/config" "$bundle_dir/deploy"
  cp "$STAGE_DIR/go/slipgate-linux-${arch_key}" "$bundle_dir/slipgate"
  cp "$STAGE_DIR/zig-linux-${arch_key}/bin/slipgate-core" "$bundle_dir/slipgate-core"
  cp "$STAGE_DIR/zig-linux-${arch_key}/bin/slipgate-guestd" "$bundle_dir/slipgate-guestd"
  cp "$STAGE_DIR/bff/slipgate-bff-${bff_key}" "$bundle_dir/slipgate-bff"
  chmod 0755 "$bundle_dir/slipgate" "$bundle_dir/slipgate-core" "$bundle_dir/slipgate-guestd" "$bundle_dir/slipgate-bff"

  cp -R "$ROOT_DIR/apps/web-vue/dist/." "$bundle_dir/webui/"
  cp -R "$ROOT_DIR/migrations" "$bundle_dir/migrations"
  cp "$ROOT_DIR/config/slipgate.example.yaml" "$bundle_dir/config/slipgate.example.yaml"
  cp "$ROOT_DIR/deploy/docker-compose.prod.yml" "$bundle_dir/deploy/docker-compose.prod.yml"
  cp "$ROOT_DIR/deploy/install.sh" "$bundle_dir/deploy/install.sh"
  cp "$ROOT_DIR/deploy/.env.example" "$bundle_dir/deploy/.env.example"
  chmod 0755 "$bundle_dir/deploy/install.sh"

  cat > "$bundle_dir/BUILD_META.json" <<EOF
{
  "tag": "${TAG_SLUG}",
  "platform": "${platform_slug}",
  "version": "${VERSION}",
  "commit": "${COMMIT}",
  "builtAt": "${BUILT_AT}"
}
EOF

  tar -C "$STAGE_DIR/bundles" -czf "$OUT_DIR/${bundle_name}.tar.gz" "$bundle_name"
}

package_linux "linux-amd64" "amd64" "linux-amd64"
package_linux "linux-amd64-musl" "amd64" "linux-amd64-musl"
package_linux "linux-arm64" "arm64" "linux-arm64"
package_linux "linux-arm64-musl" "arm64" "linux-arm64-musl"

# Windows amd64 ZIP archive
WIN_NAME="slipgate-${TAG_SLUG}-windows-amd64"
WIN_DIR="$STAGE_DIR/bundles/$WIN_NAME"
mkdir -p "$WIN_DIR/webui" "$WIN_DIR/config" "$WIN_DIR/deploy"
cp "$STAGE_DIR/go/slipgate-windows-amd64.exe" "$WIN_DIR/slipgate.exe"
cp "$STAGE_DIR/zig-windows-amd64/bin/slipgate-core.exe" "$WIN_DIR/slipgate-core.exe"
cp "$STAGE_DIR/zig-windows-amd64/bin/slipgate-guestd.exe" "$WIN_DIR/slipgate-guestd.exe"
cp "$STAGE_DIR/bff/slipgate-bff-windows-amd64.exe" "$WIN_DIR/slipgate-bff.exe"
cp -R "$ROOT_DIR/apps/web-vue/dist/." "$WIN_DIR/webui/"
cp -R "$ROOT_DIR/migrations" "$WIN_DIR/migrations"
cp "$ROOT_DIR/config/slipgate.example.yaml" "$WIN_DIR/config/slipgate.example.yaml"
cp "$ROOT_DIR/deploy/docker-compose.prod.yml" "$WIN_DIR/deploy/docker-compose.prod.yml"
cp "$ROOT_DIR/deploy/.env.example" "$WIN_DIR/deploy/.env.example"

cat > "$WIN_DIR/BUILD_META.json" <<EOF
{
  "tag": "${TAG_SLUG}",
  "platform": "windows-amd64",
  "version": "${VERSION}",
  "commit": "${COMMIT}",
  "builtAt": "${BUILT_AT}"
}
EOF

(
  cd "$STAGE_DIR/bundles"
  if command -v zip >/dev/null 2>&1; then
    zip -rq "$OUT_DIR/${WIN_NAME}.zip" "$WIN_NAME"
  else
    python3 -c "import os, zipfile; z=zipfile.ZipFile('$OUT_DIR/${WIN_NAME}.zip','w',zipfile.ZIP_DEFLATED); [z.write(os.path.join(r,f)) for r,_,fs in os.walk('$WIN_NAME') for f in fs]; z.close()"
  fi
)

cp "$ROOT_DIR/deploy/docker-compose.prod.yml" "$OUT_DIR/docker-compose.prod.yml"
cp "$ROOT_DIR/deploy/install.sh" "$OUT_DIR/install.sh"
chmod 0755 "$OUT_DIR/install.sh"

# 6. Compute SHA256SUMS.txt across all deployable archives and standalone manifests
(
  cd "$OUT_DIR"
  sha256sum slipgate-*.tar.gz slipgate-*.zip docker-compose.prod.yml install.sh BUILD_META.json > SHA256SUMS.txt
)

cat > "$OUT_DIR/RELEASE_NOTES.md" <<EOF
## Slipgate ${VERSION} (\`${COMMIT}\`)

### Included Binaries per Archive
- \`slipgate\` — Go 1.27 unified HTTP edge (:8080), built-in supervisor, Clash 1-slot-1-exit pool, VM slot coordinator, embedded Vue 3 UI
- \`slipgate-core\` — Zig 0.14 zero-GC DataPlane router, pre-hop risk gate & i128 nano-USD ledger
- \`slipgate-guestd\` — Zig 0.14 static in-VM CLI supervisor daemon
- \`slipgate-bff\` — Bun-compiled TypeScript ControlPlane BFF
- \`webui/\`, \`migrations/\`, \`config/\`, \`deploy/\`

### Container Image
- \`ghcr.io/dreamforsh/slipgate:${TAG_SLUG}\`
EOF

echo "==> Artifacts written to $OUT_DIR:"
ls -lh "$OUT_DIR"
