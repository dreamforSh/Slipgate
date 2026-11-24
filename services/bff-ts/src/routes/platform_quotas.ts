import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  ResetUserPlatformQuotaRequestSchema,
  SetUserPlatformQuotasRequestSchema,
  type UserPlatformQuotasResponse,
} from "@slipgate/contracts";
import type { AuthEnv } from "../middleware/auth.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

type App = Hono<AuthEnv>;

export interface PlatformQuotaRouteContext {
  store: ControlStore;
  syncDataPlane: () => Promise<void>;
}

function bad(issues: z.ZodIssue[]): never {
  const message = issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
  throw new StoreError("bad_request", message || "Invalid request");
}

async function parseBody<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
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

/** Per-user per-platform quota routes for admins and authenticated users (Lane U2). */
export function registerPlatformQuotaRoutes(app: App, ctx: PlatformQuotaRouteContext): void {
  const { store, syncDataPlane } = ctx;

  async function requireUser(userId: string) {
    const user = await store.ops.getAdminUser(userId);
    if (!user) throw new StoreError("not_found", "User not found");
    return user;
  }

  app.get("/api/v1/user/platform-quotas", async (c) => {
    const claims = c.get("authUser");
    const items = await store.platformQuotas.listUserPlatformQuotas(claims.sub);
    const body: UserPlatformQuotasResponse = { userId: claims.sub, items };
    return c.json(body);
  });

  app.get("/api/v1/admin/users/:userId/platform-quotas", async (c) => {
    const user = await requireUser(c.req.param("userId"));
    const items = await store.platformQuotas.listUserPlatformQuotas(user.id);
    const body: UserPlatformQuotasResponse = { userId: user.id, items };
    return c.json(body);
  });

  app.put("/api/v1/admin/users/:userId/platform-quotas", async (c) => {
    const user = await requireUser(c.req.param("userId"));
    const req = await parseBody(c, SetUserPlatformQuotasRequestSchema);
    const items = await store.platformQuotas.upsertUserPlatformQuotas(user.id, req.items);
    await syncDataPlane();
    const body: UserPlatformQuotasResponse = { userId: user.id, items };
    return c.json(body);
  });

  app.delete("/api/v1/admin/users/:userId/platform-quotas/:platform", async (c) => {
    const user = await requireUser(c.req.param("userId"));
    const deleted = await store.platformQuotas.deleteUserPlatformQuota(user.id, c.req.param("platform"));
    if (!deleted) throw new StoreError("not_found", "Platform quota not found");
    await syncDataPlane();
    return c.json({ deleted: true });
  });

  app.post("/api/v1/admin/users/:userId/platform-quotas/:platform/reset", async (c) => {
    const user = await requireUser(c.req.param("userId"));
    const raw = await c.req.json().catch(() => ({}));
    const parsed = ResetUserPlatformQuotaRequestSchema.safeParse(raw);
    if (!parsed.success) bad(parsed.error.issues);
    const item = await store.platformQuotas.resetUserPlatformQuotaWindow(
      user.id,
      c.req.param("platform"),
      parsed.data.window,
    );
    await syncDataPlane();
    return c.json({ item });
  });
}
