import { PluginRegistry } from "@slipgate/plugin-sdk";
import { createBffApp } from "./app.ts";

const VERSION = "0.1.0";

if (process.argv.includes("--version")) {
  console.log(`slipgate-bff ${VERSION}`);
  process.exit(0);
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

const registry = new PluginRegistry();
await registry.initAll({
  serviceVersion: VERSION,
  logger: (message, meta) => console.log(`[plugin] ${message}`, meta ?? {}),
});

const { hostname, port } = resolveBindAddress();
const app = createBffApp(registry);

const server = Bun.serve({
  hostname,
  port,
  fetch: app.fetch,
});

console.log(`slipgate-bff ${VERSION} listening on http://${server.hostname}:${server.port}`);

const shutdown = () => {
  server.stop(true);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
