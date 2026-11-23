import type { Hono } from "hono";
import {
  announcementTargetingGroupIds,
  AnnouncementReadStatusQuerySchema,
  type AnnouncementTargeting,
} from "@slipgate/contracts";
import type { AuthEnv } from "../middleware/auth.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

/**
 * Announcement targeting and read status (admin). The create / update / list / delete routes live
 * in routes/ops.ts; they call requireTargetingGroups before storing a rule.
 */

/**
 * Refuses a targeting rule that names a group which does not exist or is not a subscription group
 * (no account can hold an active subscription in it, so the condition could never match).
 */
export async function requireTargetingGroups(store: ControlStore, targeting: AnnouncementTargeting | undefined): Promise<void> {
  if (!targeting) return;
  const ids = announcementTargetingGroupIds(targeting);
  if (ids.length === 0) return;
  const groups = new Map((await store.listGroups(false)).map((g) => [g.id, g]));
  const unknown = ids.filter((id) => groups.get(id)?.subscriptionType !== "subscription");
  if (unknown.length > 0) {
    throw new StoreError("bad_request", `targeting: not a subscription group: ${unknown.slice(0, 5).join(", ")}`);
  }
}

/**
 * Rewrites the subscription group ids of a restored targeting rule through the backup import's
 * old → new group id map; ids the map does not know stay (they never match, i.e. fail closed).
 */
export function remapTargetingGroups<T extends { targeting?: AnnouncementTargeting }>(req: T, groupIdMap: ReadonlyMap<string, string>): T {
  if (!req.targeting) return req;
  return {
    ...req,
    targeting: {
      anyOf: req.targeting.anyOf.map((g) => ({
        allOf: g.allOf.map((c) =>
          c.type === "subscription" ? { ...c, groupIds: [...new Set(c.groupIds.map((id) => groupIdMap.get(id) ?? id))] } : c,
        ),
      })),
    },
  };
}

/** Admin routes (requireAdmin + auditMiddleware are mounted on /api/v1/admin/* by createBffApp). */
export function registerAnnouncementRoutes(app: Hono<AuthEnv>, store: ControlStore): void {
  /**
   * Every account with its read state for one announcement: q (email / username), read
   * (all|read|unread), eligible (all|eligible|ineligible), sort, page, pageSize.
   */
  app.get("/api/v1/admin/announcements/:id/read-status", async (c) => {
    const parsed = AnnouncementReadStatusQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new StoreError("bad_request", parsed.error.issues[0]?.message ?? "Invalid query");
    c.header("Cache-Control", "no-store");
    return c.json(await store.ops.listAnnouncementReadStatus(c.req.param("id"), parsed.data));
  });
}
