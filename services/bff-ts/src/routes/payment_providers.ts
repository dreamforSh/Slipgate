import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  CreatePaymentInstanceRequestSchema,
  EasypayModeSchema,
  normalizeInstanceTypes,
  PAYMENT_INSTANCE_CONFIG_SCHEMAS,
  PAYMENT_INSTANCE_SECRET_FIELDS,
  ReorderPaymentInstancesRequestSchema,
  UpdatePaymentInstanceRequestSchema,
  type PaymentChannelLimit,
  type PaymentInstanceProvider,
} from "@slipgate/contracts";
import type { AuthEnv } from "../middleware/auth.ts";
import { loadRsaPrivateKey, loadRsaPublicKey } from "../payments/alipay.ts";
import { PaymentService } from "../payments/service.ts";
import type { PaymentInstanceInput, PaymentInstanceRecord } from "../store/payment_providers_types.ts";
import { StoreError } from "../store/types.ts";

/**
 * Admin CRUD of payment provider instances (/api/v1/admin/payments/providers): several merchant
 * accounts per gateway with their channels, per-channel limits and refund flags. Secrets are
 * write-only (reported as `secretsSet`), encrypted at rest with the vault secret, and redacted
 * from the audit log by name (`secrets`). Mounted by registerPaymentRoutes.
 */

function bad(issues: z.ZodIssue[], prefix = ""): never {
  const message = issues
    .slice(0, 3)
    .map((i) => `${prefix}${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
    .join("; ");
  throw new StoreError("bad_request", message || "Invalid request");
}

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) bad(parsed.error.issues);
  return parsed.data;
}

interface InstancePatch {
  name?: string;
  enabled?: boolean;
  sortOrder?: number;
  supportedTypes?: string[];
  paymentMode?: string;
  refundEnabled?: boolean;
  allowUserRefund?: boolean;
  limits?: Record<string, PaymentChannelLimit>;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

function validateKeys(provider: PaymentInstanceProvider, config: Record<string, unknown>, secrets: Record<string, string>) {
  const tryKey = (label: string, load: () => unknown) => {
    try {
      load();
    } catch {
      throw new StoreError("bad_request", `${label} is not a valid RSA key`);
    }
  };
  if (provider === "alipay") {
    tryKey("config.alipayPublicKey", () => loadRsaPublicKey(String(config.alipayPublicKey ?? "")));
    if (secrets.privateKey) tryKey("secrets.privateKey", () => loadRsaPrivateKey(secrets.privateKey!));
  }
  if (provider === "wxpay") {
    tryKey("config.publicKey", () => loadRsaPublicKey(String(config.publicKey ?? "")));
    if (secrets.privateKey) tryKey("secrets.privateKey", () => loadRsaPrivateKey(secrets.privateKey!));
    if (secrets.apiV3Key && Buffer.byteLength(secrets.apiV3Key, "utf8") !== 32) {
      throw new StoreError("bad_request", "secrets.apiV3Key must be exactly 32 characters");
    }
  }
}

/** Merges a create / update request over the stored instance and validates the result. */
async function buildInput(
  service: PaymentService,
  provider: PaymentInstanceProvider,
  current: PaymentInstanceRecord | null,
  patch: InstancePatch,
): Promise<{ input: PaymentInstanceInput; secrets: Record<string, string>; before: Record<string, string> }> {
  const supportedTypes = normalizeInstanceTypes(provider, patch.supportedTypes ?? current?.supportedTypes ?? []);
  let paymentMode = "";
  if (provider === "easypay") {
    const mode = EasypayModeSchema.safeParse(patch.paymentMode || current?.paymentMode || "popup");
    if (!mode.success) throw new StoreError("bad_request", 'paymentMode must be "popup" or "qrcode"');
    paymentMode = mode.data;
  }
  const limits: Record<string, PaymentChannelLimit> = {};
  for (const [type, l] of Object.entries(patch.limits ?? current?.limits ?? {})) {
    if (!supportedTypes.includes(type)) continue;
    if (l.singleMinMinor > 0 && l.singleMaxMinor > 0 && l.singleMinMinor > l.singleMaxMinor) {
      throw new StoreError("bad_request", `limits.${type}: the single minimum exceeds the maximum`);
    }
    if (l.dailyLimitMinor > 0 && l.singleMinMinor > l.dailyLimitMinor) {
      throw new StoreError("bad_request", `limits.${type}: the single minimum exceeds the daily limit`);
    }
    limits[type] = l;
  }
  const parsedConfig = PAYMENT_INSTANCE_CONFIG_SCHEMAS[provider].safeParse(patch.config ?? current?.config ?? {});
  if (!parsedConfig.success) bad(parsedConfig.error.issues, "config.");
  const config = parsedConfig.data as Record<string, unknown>;

  const before = current ? await service.instanceSecrets(current) : {};
  const secrets = { ...before };
  const allowed: readonly string[] = PAYMENT_INSTANCE_SECRET_FIELDS[provider];
  for (const [field, value] of Object.entries(patch.secrets ?? {})) {
    if (!allowed.includes(field)) throw new StoreError("bad_request", `secrets.${field} is not a ${provider} secret (expected ${allowed.join(", ")})`);
    if (value.trim() === "") delete secrets[field];
    else secrets[field] = value.trim();
  }
  validateKeys(provider, config, secrets);
  const credentialsEnc = Object.keys(secrets).length > 0 ? await service.seal(JSON.stringify(secrets)) : "";
  return {
    input: {
      provider,
      name: patch.name ?? current?.name ?? provider,
      enabled: patch.enabled ?? current?.enabled ?? true,
      sortOrder: patch.sortOrder ?? current?.sortOrder ?? 0,
      supportedTypes,
      paymentMode,
      refundEnabled: patch.refundEnabled ?? current?.refundEnabled ?? true,
      allowUserRefund: patch.allowUserRefund ?? current?.allowUserRefund ?? false,
      limits,
      config,
      credentialsEnc,
    },
    secrets,
    before,
  };
}

export function registerPaymentProviderRoutes(app: Hono<AuthEnv>, service: PaymentService): void {
  const instances = service.store.payments.instances;

  async function view(rec: PaymentInstanceRecord, usage?: Record<string, number>) {
    return service.toAdminInstance(rec, await service.instanceSecrets(rec), usage ?? (await service.usageToday()));
  }

  app.get("/api/v1/admin/payments/providers", async (c) => {
    const [rows, usage] = await Promise.all([instances.listInstances(), service.usageToday()]);
    return c.json({ items: await Promise.all(rows.map((r) => view(r, usage))) });
  });

  app.post("/api/v1/admin/payments/providers", async (c) => {
    const req = await body(c, CreatePaymentInstanceRequestSchema);
    const { input } = await buildInput(service, req.provider, null, req);
    return c.json({ item: await view(await instances.createInstance(input)) }, 201);
  });

  app.post("/api/v1/admin/payments/providers/reorder", async (c) => {
    const req = await body(c, ReorderPaymentInstancesRequestSchema);
    await instances.reorderInstances(req.ids);
    const [rows, usage] = await Promise.all([instances.listInstances(), service.usageToday()]);
    return c.json({ items: await Promise.all(rows.map((r) => view(r, usage))) });
  });

  app.put("/api/v1/admin/payments/providers/:id", async (c) => {
    const id = c.req.param("id");
    const req = await body(c, UpdatePaymentInstanceRequestSchema);
    const current = await instances.getInstance(id);
    if (!current) throw new StoreError("not_found", "Payment provider not found");
    const { input, secrets, before } = await buildInput(service, current.provider, current, req);
    // Callbacks, queries and refunds of open orders need the merchant they were placed with.
    if (PaymentService.protectedChange(current.provider, { config: current.config, secrets: before }, { config: input.config, secrets })) {
      const open = await instances.countOpenOrders(id);
      if (open > 0) {
        return c.json(
          {
            error: "instance_has_open_orders",
            message: `This provider has ${open} open order(s); its merchant identity and keys cannot change until they are settled`,
          },
          409,
        );
      }
    }
    return c.json({ item: await view(await instances.updateInstance(id, input)) });
  });

  app.delete("/api/v1/admin/payments/providers/:id", async (c) => {
    await instances.deleteInstance(c.req.param("id"));
    return c.json({ deleted: true });
  });
}
