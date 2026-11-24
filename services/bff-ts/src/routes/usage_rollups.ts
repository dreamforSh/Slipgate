import type { Context, Hono } from "hono";
import {
  UpdateUsageRollupConfigRequestSchema,
  UsageRollupBackfillRequestSchema,
  UsageRollupCleanupRequestSchema,
  UsageRollupSeriesQuerySchema,
} from "@slipgate/contracts";
import type { z } from "zod";
import type { AuthEnv } from "../middleware/auth.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

/**
 * Usage Rollup & Retention Cleanup routes (Lane O4):
 *
 *   GET   /api/v1/admin/usage-rollups/status
 *   PATCH /api/v1/admin/usage-rollups/config
 *   POST  /api/v1/admin/usage-rollups/backfill
 *   POST  /api/v1/admin/usage-rollups/cleanup
 *   GET   /api/v1/admin/usage-rollups/series
 */

type App = Hono<AuthEnv>;

function requireAdmin(c: Context<AuthEnv>): void {
  const claims = c.get("authUser");
  if (!claims || claims.role !== "admin") {
    throw new StoreError("forbidden", "Administrator role required");
  }
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

export function registerUsageRollupRoutes(app: App, store: ControlStore): void {
  app.get("/api/v1/admin/usage-rollups/status", async (c) => {
    requireAdmin(c);
    const status = await store.usageRollups.getStatus();
    return c.json(status);
  });

  app.patch("/api/v1/admin/usage-rollups/config", async (c) => {
    requireAdmin(c);
    const parsed = UpdateUsageRollupConfigRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const status = await store.usageRollups.updateConfig(parsed.data);
    return c.json(status);
  });

  app.post("/api/v1/admin/usage-rollups/backfill", async (c) => {
    requireAdmin(c);
    const parsed = UsageRollupBackfillRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const result = await store.usageRollups.backfill({
      days: parsed.data.days,
      granularity: parsed.data.granularity,
    });
    return c.json(result);
  });

  app.post("/api/v1/admin/usage-rollups/cleanup", async (c) => {
    requireAdmin(c);
    const parsed = UsageRollupCleanupRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const result = await store.usageRollups.cleanupUsageLogs(parsed.data);
    return c.json(result);
  });

  app.get("/api/v1/admin/usage-rollups/series", async (c) => {
    requireAdmin(c);
    const parsed = UsageRollupSeriesQuerySchema.safeParse({
      granularity: c.req.query("granularity") || undefined,
      days: c.req.query("days") || undefined,
      userId: c.req.query("userId") || undefined,
      groupId: c.req.query("groupId") || undefined,
      platform: c.req.query("platform") || undefined,
      publicModel: c.req.query("publicModel") || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const series = await store.usageRollups.querySeries(parsed.data);
    return c.json(series);
  });
}
