# syntax=docker/dockerfile:1.7
# =============================================================================
# Slipgate Unified Single-Service Image
#   - Stage 1: web-vue SPA bundle (Bun)
#   - Stage 2: slipgate-bff native binary (Bun --compile, target arch)
#   - Stage 3: slipgate-core native binary (Zig 0.14.0 cross-compile)
#   - Stage 4: slipgate unified Go edge & supervisor (embedded Vue SPA)
#   - Stage 5: Minimal Alpine runtime running all 3 planes via single entrypoint
# =============================================================================

ARG BUN_IMAGE=oven/bun:1.2-alpine
ARG GOLANG_IMAGE=golang:1.27.3-alpine
ARG ALPINE_IMAGE=alpine:3.21
ARG ZIG_VERSION=0.14.0

# -----------------------------------------------------------------------------
# Stage 1: Build Vue 3 Frontend Console (arch-neutral static bundle)
# -----------------------------------------------------------------------------
FROM --platform=${BUILDPLATFORM} ${BUN_IMAGE} AS web-builder
WORKDIR /app

COPY package.json tsconfig.base.json bun.loc[k] ./
COPY packages ./packages
COPY services/bff-ts/package.json ./services/bff-ts/package.json
COPY apps/web-vue ./apps/web-vue

RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi && \
    bun run --cwd apps/web-vue build

# -----------------------------------------------------------------------------
# Stage 2: Compile Bun TS Middleware (slipgate-bff) for TARGETARCH
# -----------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS bff-builder
WORKDIR /app

COPY package.json tsconfig.base.json bun.loc[k] ./
COPY packages ./packages
COPY services/bff-ts ./services/bff-ts
COPY apps/web-vue/package.json ./apps/web-vue/package.json

RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi && \
    mkdir -p /out && \
    bun build --compile services/bff-ts/src/index.ts --outfile /out/slipgate-bff

# -----------------------------------------------------------------------------
# Stage 3: Cross-Compile Zig Core Engine (slipgate-core)
# -----------------------------------------------------------------------------
FROM --platform=${BUILDPLATFORM} ${ALPINE_IMAGE} AS zig-builder
ARG ZIG_VERSION
ARG TARGETARCH

RUN apk add --no-cache curl xz && \
    HOST_ARCH="$(uname -m)" && \
    case "${HOST_ARCH}" in \
      x86_64) ZIG_HOST_ARCH="x86_64" ;; \
      aarch64|arm64) ZIG_HOST_ARCH="aarch64" ;; \
      *) echo "Unsupported build host arch: ${HOST_ARCH}" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-${ZIG_HOST_ARCH}-${ZIG_VERSION}.tar.xz" -o /tmp/zig.tar.xz && \
    tar -xf /tmp/zig.tar.xz -C /opt && \
    ln -s "/opt/zig-linux-${ZIG_HOST_ARCH}-${ZIG_VERSION}/zig" /usr/local/bin/zig && \
    rm -f /tmp/zig.tar.xz

WORKDIR /app/services/core-zig
COPY services/core-zig ./

RUN case "${TARGETARCH}" in \
      amd64) ZIG_TARGET="x86_64-linux-musl" ;; \
      arm64) ZIG_TARGET="aarch64-linux-musl" ;; \
      *) echo "Unsupported target arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    zig build --prefix /out -Dtarget="${ZIG_TARGET}" -Doptimize=ReleaseSafe

# -----------------------------------------------------------------------------
# Stage 4: Cross-Compile Go Edge & Supervisor (slipgate) with embedded Vue SPA
# -----------------------------------------------------------------------------
FROM --platform=${BUILDPLATFORM} ${GOLANG_IMAGE} AS go-builder
ARG TARGETARCH
ARG SLIPGATE_VERSION=0.1.0
ARG SLIPGATE_COMMIT=unknown

WORKDIR /app/services/net-go
COPY services/net-go/go.mod services/net-go/go.sum ./
RUN go mod download
COPY services/net-go ./
COPY --from=web-builder /app/apps/web-vue/dist ./internal/webui/dist

RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" go build \
    -trimpath -ldflags="-s -w -X main.version=${SLIPGATE_VERSION} -X main.commit=${SLIPGATE_COMMIT}" \
    -o /out/slipgate \
    ./cmd/slipgate

# -----------------------------------------------------------------------------
# Stage 5: Single-Service Runtime Image
# -----------------------------------------------------------------------------
FROM ${ALPINE_IMAGE} AS runtime

# postgresql17-client: pg_dump / psql for full database backups and restores (BFF); keep its major
# version >= the Postgres server's (deploy uses postgres:17-alpine).
RUN apk add --no-cache ca-certificates tzdata libstdc++ libgcc postgresql17-client && \
    addgroup -S slipgate && adduser -S slipgate -G slipgate && \
    mkdir -p /etc/slipgate /var/run/slipgate /var/run/slipgate/clash /var/run/slipgate/vms /var/run/slipgate/hotupdate /usr/local/share/slipgate/guest && \
    chown -R slipgate:slipgate /etc/slipgate /var/run/slipgate

COPY --from=go-builder /out/slipgate /usr/local/bin/slipgate
COPY --from=zig-builder /out/bin/slipgate-core /usr/local/bin/slipgate-core
COPY --from=zig-builder /out/bin/slipgate-guestd /usr/local/share/slipgate/guest/slipgate-guestd
COPY --from=bff-builder /out/slipgate-bff /usr/local/bin/slipgate-bff
RUN chmod 0755 /usr/local/bin/slipgate /usr/local/bin/slipgate-core /usr/local/share/slipgate/guest/slipgate-guestd /usr/local/bin/slipgate-bff
COPY migrations /etc/slipgate/migrations
COPY config/slipgate.example.yaml /etc/slipgate/slipgate.example.yaml

ENV SLIPGATE_LISTEN_ADDR=":8080" \
    SLIPGATE_SUPERVISE="true" \
    SLIPGATE_CORE_BIN="/usr/local/bin/slipgate-core" \
    SLIPGATE_BFF_BIN="/usr/local/bin/slipgate-bff" \
    SLIPGATE_CORE_IPC="127.0.0.1:19081" \
    SLIPGATE_BFF_ADDR="127.0.0.1:19082" \
    SLIPGATE_CLASH_MODE="embedded" \
    SLIPGATE_CLASH_DATA_DIR="/var/run/slipgate/clash" \
    SLIPGATE_VM_DATA_DIR="/var/run/slipgate/vms" \
    SLIPGATE_GUESTD_BIN="/usr/local/share/slipgate/guest/slipgate-guestd" \
    SLIPGATE_HOTUPDATE_DIR="/var/run/slipgate/hotupdate"

EXPOSE 8080
USER slipgate

ENTRYPOINT ["/usr/local/bin/slipgate"]
