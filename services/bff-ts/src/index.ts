import { PluginRegistry } from "@slipgate/plugin-sdk";
import { createBffApp } from "./app.ts";
import { MemoryControlStore } from "./store/memory_store.ts";
import { PostgresControlStore } from "./store/postgres_store.ts";
import { allowInsecureSecrets, secretProblems } from "./security/secrets.ts";
import type { ControlStore } from "./store/types.ts";

const VERSION = "0.1.0";

if (process.argv.includes("--version")) {
  console.log(`slipgate-bff ${VERSION}`);
  process.exit(0);
}

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
const app = createBffApp({ store, registry });

const server = Bun.serve({
  hostname,
  port,
  fetch: app.fetch,
});

console.log(`slipgate-bff ${VERSION} listening on http://${server.hostname}:${server.port}`);

const shutdown = async () => {
  server.stop(true);
  await store.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
