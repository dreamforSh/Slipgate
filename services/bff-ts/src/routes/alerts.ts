import type { Context, Hono } from "hono";
import {
  AlertEventQuerySchema,
  CreateAlertRuleRequestSchema,
  CreateAlertSilenceRequestSchema,
  UpdateAlertRuleRequestSchema,
} from "@slipgate/contracts";
import type { z } from "zod";
import { AlertService } from "../alerts/service.ts";
import type { AuthEnv } from "../middleware/auth.ts";
import type { JwtClaims } from "../security/crypto.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

/**
 * Ops Alerting & Email Notification routes (Lane O2):
 *
 *   GET    /api/v1/admin/ops/alerts/rules
 *   POST   /api/v1/admin/ops/alerts/rules
 *   PATCH  /api/v1/admin/ops/alerts/rules/:id
 *   DELETE /api/v1/admin/ops/alerts/rules/:id
 *   POST   /api/v1/admin/ops/alerts/evaluate
 *   GET    /api/v1/admin/ops/alerts/events
 *   POST   /api/v1/admin/ops/alerts/events/:id/ack
 *   POST   /api/v1/admin/ops/alerts/events/:id/resolve
 *   GET    /api/v1/admin/ops/alerts/silences
 *   POST   /api/v1/admin/ops/alerts/silences
 *   DELETE /api/v1/admin/ops/alerts/silences/:id
 */

type App = Hono<AuthEnv>;

const services = new WeakMap<object, AlertService>();

export function alertServiceOf(app: object): AlertService | undefined {
  return services.get(app);
}

function adminClaims(c: Context<AuthEnv>): JwtClaims {
  const claims = c.get("authUser") as JwtClaims | undefined;
  if (!claims || claims.role !== "admin") {
    throw new StoreError("forbidden", "Administrator role required");
  }
  return claims;
}

function issuesMessage(issues: z.ZodIssue[]): string {
  return (
    issues
      .slice(0, 3)
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ") || "Invalid request"
  );
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
}

export function registerAlertRoutes(app: App, store: ControlStore, service: AlertService): void {
  services.set(app, service);

  app.get("/api/v1/admin/ops/alerts/rules", async (c) => {
    adminClaims(c);
    return c.json({ items: await store.alerts.listRules() });
  });

  app.post("/api/v1/admin/ops/alerts/rules", async (c) => {
    const claims = adminClaims(c);
    const parsed = CreateAlertRuleRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const item = await store.alerts.createRule(parsed.data, claims.sub);
    return c.json({ item }, 201);
  });

  app.patch("/api/v1/admin/ops/alerts/rules/:id", async (c) => {
    adminClaims(c);
    const parsed = UpdateAlertRuleRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const item = await store.alerts.updateRule(c.req.param("id"), parsed.data);
    if (!item) throw new StoreError("not_found", "Alert rule not found");
    return c.json({ item });
  });

  app.delete("/api/v1/admin/ops/alerts/rules/:id", async (c) => {
    adminClaims(c);
    const deleted = await store.alerts.deleteRule(c.req.param("id"));
    if (!deleted) throw new StoreError("not_found", "Alert rule not found");
    return c.json({ deleted: true });
  });

  app.post("/api/v1/admin/ops/alerts/evaluate", async (c) => {
    adminClaims(c);
    return c.json(await service.evaluateNow());
  });

  app.get("/api/v1/admin/ops/alerts/events", async (c) => {
    adminClaims(c);
    const parsed = AlertEventQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const { page, pageSize, ...filter } = parsed.data;
    const { items, total, firingCount } = await store.alerts.listEvents(filter, page, pageSize);
    return c.json({ items, total, firingCount, page, pageSize });
  });

  app.post("/api/v1/admin/ops/alerts/events/:id/ack", async (c) => {
    const claims = adminClaims(c);
    const item = await store.alerts.acknowledgeEvent(c.req.param("id"), claims.sub);
    if (!item) throw new StoreError("not_found", "Alert event not found");
    return c.json({ item });
  });

  app.post("/api/v1/admin/ops/alerts/events/:id/resolve", async (c) => {
    adminClaims(c);
    const item = await store.alerts.resolveEvent(c.req.param("id"), new Date().toISOString());
    if (!item) throw new StoreError("not_found", "Alert event not found");
    return c.json({ item });
  });

  app.get("/api/v1/admin/ops/alerts/silences", async (c) => {
    adminClaims(c);
    const activeOnly = c.req.query("activeOnly") === "true";
    return c.json({ items: await store.alerts.listSilences(activeOnly) });
  });

  app.post("/api/v1/admin/ops/alerts/silences", async (c) => {
    const claims = adminClaims(c);
    const parsed = CreateAlertSilenceRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    if (parsed.data.ruleId) {
      const rule = await store.alerts.getRule(parsed.data.ruleId);
      if (!rule) throw new StoreError("not_found", "Referenced alert rule not found");
    }
    const item = await store.alerts.createSilence(parsed.data, claims.sub);
    return c.json({ item }, 201);
  });

  app.delete("/api/v1/admin/ops/alerts/silences/:id", async (c) => {
    adminClaims(c);
    const deleted = await store.alerts.deleteSilence(c.req.param("id"));
    if (!deleted) throw new StoreError("not_found", "Alert silence not found");
    return c.json({ deleted: true });
  });
}
