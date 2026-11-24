import type { Context, Hono } from "hono";
import {
  CreateChannelMonitorRequestSchema,
  UpdateChannelMonitorRequestSchema,
  type PublicChannelMonitorItem,
  type PublicChannelMonitorsStatusResponse,
} from "@slipgate/contracts";
import type { z } from "zod";
import { ChannelMonitorService } from "../channel_monitors/service.ts";
import type { AuthEnv } from "../middleware/auth.ts";
import type { JwtClaims } from "../security/crypto.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

/**
 * Channel Monitors & Public Matrix routes (Lane O3):
 *
 *   GET    /api/v1/admin/channel-monitors
 *   POST   /api/v1/admin/channel-monitors
 *   PATCH  /api/v1/admin/channel-monitors/:id
 *   DELETE /api/v1/admin/channel-monitors/:id
 *   POST   /api/v1/admin/channel-monitors/:id/run
 *   GET    /api/v1/admin/channel-monitors/:id/runs
 *   GET    /api/v1/public/channel-monitors/status
 */

type App = Hono<AuthEnv>;

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

export function registerChannelMonitorRoutes(app: App, store: ControlStore, service: ChannelMonitorService): void {
  app.get("/api/v1/public/channel-monitors/status", async (c) => {
    const settings = await store.ops.getSettings();
    if (!settings.statusPageEnabled) {
      throw new StoreError("not_found", "Status page is disabled");
    }
    const monitors = await store.channelMonitors.listMonitors({ publicOnly: true, enabledOnly: true });
    const items: PublicChannelMonitorItem[] = monitors.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      platform: m.platform,
      model: m.model,
      lastStatus: m.lastStatus,
      lastLatencyMs: m.lastLatencyMs,
      lastCheckedAtIso: m.lastCheckedAtIso,
      uptime24hPct: m.uptime24hPct,
      recentRuns: m.recentRuns,
    }));
    const body: PublicChannelMonitorsStatusResponse = {
      generatedAtIso: new Date().toISOString(),
      items,
    };
    c.header("Cache-Control", "public, max-age=15");
    return c.json(body);
  });

  app.get("/api/v1/admin/channel-monitors", async (c) => {
    adminClaims(c);
    return c.json({ items: await store.channelMonitors.listMonitors() });
  });

  app.post("/api/v1/admin/channel-monitors", async (c) => {
    adminClaims(c);
    const parsed = CreateChannelMonitorRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const account = await store.getAccount(parsed.data.accountId);
    if (!account) {
      throw new StoreError("not_found", `Account ${parsed.data.accountId} not found`);
    }
    if (account.executionMode === "vm_slot") {
      throw new StoreError("bad_request", "VM slot accounts cannot be assigned to synthetic probes");
    }
    const item = await store.channelMonitors.createMonitor({
      ...parsed.data,
      groupId: account.groupId,
      platform: account.platform,
    });
    return c.json({ item }, 201);
  });

  app.patch("/api/v1/admin/channel-monitors/:id", async (c) => {
    adminClaims(c);
    const parsed = UpdateChannelMonitorRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    let groupId: string | undefined;
    let platform: string | undefined;
    if (parsed.data.accountId) {
      const account = await store.getAccount(parsed.data.accountId);
      if (!account) {
        throw new StoreError("not_found", `Account ${parsed.data.accountId} not found`);
      }
      if (account.executionMode === "vm_slot") {
        throw new StoreError("bad_request", "VM slot accounts cannot be assigned to synthetic probes");
      }
      groupId = account.groupId;
      platform = account.platform;
    }
    const item = await store.channelMonitors.updateMonitor(c.req.param("id"), {
      ...parsed.data,
      ...(groupId !== undefined ? { groupId, platform } : {}),
    });
    if (!item) throw new StoreError("not_found", "Channel monitor not found");
    return c.json({ item });
  });

  app.delete("/api/v1/admin/channel-monitors/:id", async (c) => {
    adminClaims(c);
    const deleted = await store.channelMonitors.deleteMonitor(c.req.param("id"));
    if (!deleted) throw new StoreError("not_found", "Channel monitor not found");
    return c.json({ deleted: true });
  });

  app.post("/api/v1/admin/channel-monitors/:id/run", async (c) => {
    adminClaims(c);
    const outcome = await service.runProbe(c.req.param("id"));
    if (!outcome) throw new StoreError("not_found", "Channel monitor not found");
    return c.json(outcome);
  });

  app.get("/api/v1/admin/channel-monitors/:id/runs", async (c) => {
    adminClaims(c);
    const monitorId = c.req.param("id");
    const existing = await store.channelMonitors.getMonitor(monitorId);
    if (!existing) throw new StoreError("not_found", "Channel monitor not found");
    const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50) || 50));
    return c.json({ monitorId, items: await store.channelMonitors.listRuns(monitorId, limit) });
  });
}
