set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

default:
    @just --list

# Install JS/TS workspace dependencies
install:
    bun install

# Start local unified development environment
dev:
    bun run dev

# Build all 4 layers into bin/ for single-service startup
build:
    bun run build

# Run tests across Go, Zig, and Bun workspaces
test:
    cd services/net-go && go test ./...
    cd services/core-zig && zig build test --summary all
    bun run typecheck
    bun run test

# Lint Protobuf contracts with Buf
proto-lint:
    buf lint

# Build single-service Docker image
docker-build:
    docker build -t slipgate:local .
