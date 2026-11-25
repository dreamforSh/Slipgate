import { PluginRegistry } from "@slipgate/plugin-sdk";
import { createBffApp, MAX_REQUEST_BODY_BYTES } from "./app.ts";
import { stopAuditRetentionSweepers } from "./audit_retention.ts";
import { stopAlertServices } from "./alerts/service.ts";
import { stopChannelMonitorServices } from "./channel_monitors/service.ts";
import { stopUsageRollupServices } from "./usage_rollups/service.ts";
import { installCrashLogging } from "./logging/crash.ts";
import { installConsoleCapture } from "./logging/logger.ts";
import { stopSystemLogServices } from "./logging/service.ts";
import { MemoryControlStore } from "./store/memory_store.ts";
import { PostgresControlStore } from "./store/postgres_store.ts";
import { allowInsecureSecrets, secretProblems } from "./security/secrets.ts";
import type { ControlStore } from "./store/types.ts";

const VERSION = "0.1.0";

if (process.argv.includes("--version")) {
  console.log(`slipgate-bff ${VERSION}`);
  process.exit(0);
}

// console.warn / console.error everywhere also become persisted system-log entries (once the app's
// system-log service is registered as the default destination by createBffApp below).
installConsoleCapture();
// A crash is stored as an error entry (queued entries written first), then the process exits 1.
installCrashLogging(() => stopSystemLogServices());

const weakSecrets = secretProblems(process.env);
if (weakSecrets.length > 0) {
  const summary = weakSecrets.join("; ");
  if (!allowInsecureSecrets(process.env)) {
    console.error(
      `[security] slipgate-bff refusing to start: ${summary}. Generate each secret with \`openssl rand -hex 32\` ` +
        "(keep SLIPGATE_VAULT_SECRET stable once accounts exist: it decrypts stored credentials), " +
        "or set SLIPGATE_ALLOW_INSECURE_SECRETS=true for local development only.",
    );
    process.exit(1);
  }
  console.warn(
    `[security] WARNING: slipgate-bff running with weak secrets because SLIPGATE_ALLOW_INSECURE_SECRETS=true: ${summary}. Never expose this instance.`,
  );
}

function resolveBindAddress(): { hostname: string; port: number } {
  const rawAddr = process.env.SLIPGATE_BFF_ADDR?.trim();
  if (rawAddr) {
    const colon = rawAddr.lastIndexOf(":");
    if (colon !== -1) {
      const hostname = colon === 0 ? "127.0.0.1" : rawAddr.slice(0, colon);
      const port = Number.parseInt(rawAddr.slice(colon + 1), 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return { hostname, port };
      }
    }
  }
  const hostname = process.env.SLIPGATE_BFF_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(process.env.SLIPGATE_BFF_PORT ?? "19082", 10);
  return { hostname, port: Number.isInteger(port) ? port : 19082 };
}

const databaseUrl = process.env.DATABASE_URL?.trim();
const store: ControlStore = databaseUrl ? new PostgresControlStore(databaseUrl) : new MemoryControlStore();
await store.init();
console.log(`slipgate-bff ${VERSION} store initialized (${databaseUrl ? "postgres" : "memory"})`);

const registry = new PluginRegistry();
await registry.initAll({
  serviceVersion: VERSION,
  logger: (message, meta) => console.log(`[plugin] ${message}`, meta ?? {}),
});

const { hostname, port } = resolveBindAddress();
const app = createBffApp({ store, registry, startSchedulers: true });

const server = Bun.serve({
  hostname,
  port,
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  fetch: app.fetch,
});

console.log(`slipgate-bff ${VERSION} listening on http://${server.hostname}:${server.port}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Let requests already in flight finish (the edge has drained public traffic before it stops
  // this process), then cut whatever is still open so the supervisor's grace period is honoured.
  await Promise.race([server.stop(false), Bun.sleep(5_000)]).catch(() => undefined);
  server.stop(true);
  stopAuditRetentionSweepers();
  stopAlertServices();
  stopChannelMonitorServices();
  stopUsageRollupServices();
  // Writes the entries still queued before the pool closes.
  await stopSystemLogServices().catch(() => undefined);
  await store.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
