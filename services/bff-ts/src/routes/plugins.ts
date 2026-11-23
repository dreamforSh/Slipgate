import type { Hono } from "hono";
import { z } from "zod";
import type { PluginRegistry } from "@slipgate/plugin-sdk";
import type { AuthEnv } from "../middleware/auth.ts";
import { decryptSecret, encryptSecret } from "../security/crypto.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

const BLOB_KEY = "plugins";

const PatchPluginSchema = z.object({
  enabled: z.boolean().optional(),
  /** Field values; for secret fields "" clears and an omitted key keeps the stored value. */
  config: z.record(z.string().max(64), z.string().max(4000)).optional(),
});

interface PluginBlob {
  disabled: string[];
  /** name -> key -> plain value, or `enc:<hex>` for secret fields. */
  configs: Record<string, Record<string, string>>;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => Number.parseInt(x, 16)));

/** Admin plugin management: list, enable/disable, configure and send a test event. */
export function registerPluginRoutes(
  app: Hono<AuthEnv>,
  store: ControlStore,
  registry: PluginRegistry,
  vaultSecret: string,
): { reload: () => Promise<void> } {
  async function readBlob(): Promise<PluginBlob> {
    const raw = (await store.ops.getBlob(BLOB_KEY)) ?? {};
    return {
      disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((x): x is string => typeof x === "string") : [],
      configs: raw.configs && typeof raw.configs === "object" ? (raw.configs as PluginBlob["configs"]) : {},
    };
  }

  /** Pushes persisted state (decrypted) into the registry. */
  async function apply(): Promise<PluginBlob> {
    const blob = await readBlob();
    registry.setDisabled(blob.disabled);
    for (const plugin of registry.list()) {
      const stored = blob.configs[plugin.name] ?? {};
      const plain: Record<string, string> = {};
      for (const [k, v] of Object.entries(stored)) {
        if (v.startsWith("enc:")) {
          try {
            plain[k] = await decryptSecret(fromHex(v.slice(4)), vaultSecret);
          } catch {
            plain[k] = "";
          }
        } else plain[k] = v;
      }
      registry.setConfig(plugin.name, plain);
    }
    return blob;
  }
  const ready = apply().catch(() => undefined);

  function view(blob: PluginBlob) {
    return registry.describe().map((d) => {
      const stored = blob.configs[d.name] ?? {};
      return {
        ...d,
        config: Object.fromEntries(
          d.settings.map((s) => [s.key, s.secret ? "" : (stored[s.key] ?? "")]),
        ) as Record<string, string>,
        secretsSet: Object.fromEntries(d.settings.filter((s) => s.secret).map((s) => [s.key, Boolean(stored[s.key])])) as Record<string, boolean>,
      };
    });
  }

  app.get("/api/v1/admin/plugins", async (c) => {
    await ready;
    return c.json({ items: view(await readBlob()) });
  });

  app.patch("/api/v1/admin/plugins/:name", async (c) => {
    const name = c.req.param("name");
    const plugin = registry.list().find((p) => p.name === name);
    if (!plugin) throw new StoreError("not_found", "Plugin not found");
    const parsed = PatchPluginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new StoreError("bad_request", parsed.error.issues.map((i) => i.message).join("; "));
    const blob = await readBlob();
    if (parsed.data.enabled !== undefined) {
      const set = new Set(blob.disabled);
      if (parsed.data.enabled) set.delete(name);
      else set.add(name);
      blob.disabled = [...set];
    }
    if (parsed.data.config) {
      const fields = new Map((plugin.settings ?? []).map((s) => [s.key, s]));
      const current = { ...(blob.configs[name] ?? {}) };
      for (const [key, value] of Object.entries(parsed.data.config)) {
        const field = fields.get(key);
        if (!field) continue;
        if (field.secret) current[key] = value ? `enc:${toHex(await encryptSecret(value, vaultSecret))}` : "";
        else current[key] = value.trim();
      }
      blob.configs = { ...blob.configs, [name]: current };
    }
    await store.ops.setBlob(BLOB_KEY, blob as unknown as Record<string, unknown>);
    const applied = await apply();
    return c.json({ item: view(applied).find((p) => p.name === name) });
  });

  app.post("/api/v1/admin/plugins/:name/test", async (c) => {
    await ready;
    const plugin = registry.list().find((p) => p.name === c.req.param("name"));
    if (!plugin) throw new StoreError("not_found", "Plugin not found");
    if (!plugin.onPaymentSettled) throw new StoreError("bad_request", "This plugin has no payment hook to test");
    const blob = await apply();
    if (!registry.isEnabled(plugin.name)) throw new StoreError("bad_request", "Enable the plugin first");
    const stored: Record<string, string> = {};
    for (const [k, v] of Object.entries(blob.configs[plugin.name] ?? {})) {
      stored[k] = v.startsWith("enc:") ? await decryptSecret(fromHex(v.slice(4)), vaultSecret).catch(() => "") : v;
    }
    try {
      await plugin.onPaymentSettled(
        { serviceVersion: "0.1.0", logger: (m, meta) => console.log(`[plugin:${plugin.name}] ${m}`, meta ?? {}), config: stored },
        { orderId: "ord_test", userId: "usr_test", provider: "manual", amountNanoUsd: "1000000000" },
      );
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) }, 502);
    }
    return c.json({ ok: true });
  });

  return {
    reload: async () => {
      await apply();
    },
  };
}
