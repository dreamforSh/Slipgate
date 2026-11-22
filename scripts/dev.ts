import { join } from "node:path";

const root = process.cwd();
// Local dev runs on the built-in secrets; release entrypoints refuse them without this flag.
const devEnv = { ...process.env, SLIPGATE_ALLOW_INSECURE_SECRETS: "true" };

const procs = [
  Bun.spawn(["bun", "run", "--cwd", "apps/web-vue", "dev"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "run", "--cwd", "services/bff-ts", "dev"], {
    cwd: root,
    env: devEnv,
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(
    [
      "go",
      "run",
      "./cmd/slipgate",
      "--standalone",
      "--allow-degraded",
      "--dev",
    ],
    {
      cwd: join(root, "services", "net-go"),
      env: {
        ...devEnv,
        SLIPGATE_MODE: "dev",
        SLIPGATE_DEV_UI_URL: "http://127.0.0.1:5173",
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  ),
];

const zigCheck = Bun.which("zig");
if (zigCheck) {
  procs.push(
    Bun.spawn(["zig", "build", "run"], {
      cwd: join(root, "services", "core-zig"),
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
} else {
  console.warn("[dev] zig not found in PATH; slipgate-net running with --allow-degraded");
}

const shutdown = () => {
  for (const p of procs) {
    p.kill();
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(procs.map((p) => p.exited));
