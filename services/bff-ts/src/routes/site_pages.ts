import { CreateSitePageRequestSchema, SitePageSlugSchema, UpdateSitePageRequestSchema } from "@slipgate/contracts";
import type { Hono } from "hono";
import type { AuthGuards } from "../auth_guards.ts";
import type { AuthEnv } from "../middleware/auth.ts";
import type { ControlStore } from "../store/types.ts";

type App = Hono<AuthEnv>;

export function registerSitePageRoutes(app: App, ctx: { store: ControlStore; guards: AuthGuards }): void {
  const { store, guards } = ctx;
  const pages = store.sitePages;
  const publicGuard = guards.backendModePublicGuard();

  app.get("/api/v1/public/pages", publicGuard, async (c) => {
    return c.json({ items: await pages.listPublicNav() });
  });

  app.get("/api/v1/public/pages/:slug", publicGuard, async (c) => {
    const slugParsed = SitePageSlugSchema.safeParse(c.req.param("slug"));
    if (!slugParsed.success) {
      return c.json({ error: "not_found", message: "Page not found" }, 404);
    }
    const page = await pages.getBySlug(slugParsed.data, { includeDrafts: false });
    if (!page) {
      return c.json({ error: "not_found", message: "Page not found" }, 404);
    }
    return c.json({ page });
  });

  app.get("/api/v1/admin/pages", async (c) => {
    return c.json({ items: await pages.listAll() });
  });

  app.post("/api/v1/admin/pages", async (c) => {
    const parsed = CreateSitePageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const page = await pages.create(parsed.data);
    return c.json({ page }, 201);
  });

  app.patch("/api/v1/admin/pages/:id", async (c) => {
    const parsed = UpdateSitePageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const page = await pages.update(c.req.param("id"), parsed.data);
    return c.json({ page });
  });

  app.delete("/api/v1/admin/pages/:id", async (c) => {
    const id = c.req.param("id");
    await pages.delete(id);
    return c.json({ deleted: true, id });
  });
}
