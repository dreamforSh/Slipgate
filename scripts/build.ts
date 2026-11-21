import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const binDir = join(root, "bin");
const ext = process.platform === "win32" ? ".exe" : "";

function run(cmd: string[], cwd = root): void {
  console.log(`\n==> [${cwd}] ${cmd.join(" ")}`);
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    process.exit(proc.exitCode || 1);
  }
}

mkdirSync(binDir, { recursive: true });

// 1. Build Vue 3 console and copy static assets for Go embed.
run(["bun", "run", "--cwd", "apps/web-vue", "build"]);
const webDist = join(root, "apps", "web-vue", "dist");
const goWebDist = join(root, "services", "net-go", "internal", "webui", "dist");
if (existsSync(goWebDist)) {
  rmSync(goWebDist, { recursive: true, force: true });
}
mkdirSync(goWebDist, { recursive: true });
cpSync(webDist, goWebDist, { recursive: true });

// 2. Build Zig core engine (L2).
run(["zig", "build", "-Doptimize=ReleaseSafe"], join(root, "services", "core-zig"));
cpSync(
  join(root, "services", "core-zig", "zig-out", "bin", `slipgate-core${ext}`),
  join(binDir, `slipgate-core${ext}`),
);

// 3. Compile Bun TS BFF (L3) into a standalone executable.
run([
  "bun",
  "build",
  "--compile",
  "services/bff-ts/src/index.ts",
  "--outfile",
  join(binDir, `slipgate-bff${ext}`),
]);

// 4. Build Go network edge & supervisor (L1) with embedded Vue SPA.
run(
  ["go", "build", "-trimpath", "-ldflags=-s -w", "-o", join(binDir, `slipgate${ext}`), "./cmd/slipgate"],
  join(root, "services", "net-go"),
);

console.log(`\nBuild complete. Start single-service Slipgate via: ${join(binDir, `slipgate${ext}`)}`);
