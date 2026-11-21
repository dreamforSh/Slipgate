$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $Root "bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

if (Get-Command bun -ErrorAction SilentlyContinue) {
    Write-Host "==> Building web-vue & slipgate-bff via Bun..."
    bun run --cwd (Join-Path $Root "apps/web-vue") build
    $GoWebDist = Join-Path $Root "services/net-go/internal/webui/dist"
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $GoWebDist
    Copy-Item -Recurse -Force (Join-Path $Root "apps/web-vue/dist") $GoWebDist
    bun build --compile (Join-Path $Root "services/bff-ts/src/index.ts") --outfile (Join-Path $BinDir "slipgate-bff.exe")
} else {
    Write-Warning "bun not found; skipping web-vue and slipgate-bff build."
}

if (Get-Command zig -ErrorAction SilentlyContinue) {
    Write-Host "==> Building slipgate-core via Zig..."
    Push-Location (Join-Path $Root "services/core-zig")
    try {
        zig build -Doptimize=ReleaseSafe
        Copy-Item -Force "zig-out/bin/slipgate-core.exe" (Join-Path $BinDir "slipgate-core.exe")
    } finally {
        Pop-Location
    }
} else {
    Write-Warning "zig not found; skipping slipgate-core build."
}

if (Get-Command go -ErrorAction SilentlyContinue) {
    Write-Host "==> Building slipgate (Go network edge + supervisor)..."
    Push-Location (Join-Path $Root "services/net-go")
    try {
        go build -trimpath -ldflags="-s -w" -o (Join-Path $BinDir "slipgate.exe") ./cmd/slipgate
    } finally {
        Pop-Location
    }
} else {
    throw "go toolchain is required to build slipgate."
}

Write-Host "==> Available binaries in ${BinDir}:"
Get-ChildItem $BinDir | Select-Object Name, Length
