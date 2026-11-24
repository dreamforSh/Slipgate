import {
  CreateAdminApiKeyRequestSchema,
  CreateUserAttributeRequestSchema,
  UpdateUserAttributeRequestSchema,
  UpdateUserAttributeValuesRequestSchema,
} from "@slipgate/contracts";
import type { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.ts";
import type { ControlStore } from "../store/types.ts";

type App = Hono<AuthEnv>;

function randomAdminToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  let b64 = "";
  for (let i = 0; i < raw.length; i++) b64 += String.fromCharCode(raw[i]!);
  const url = btoa(b64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `slipgate-adm-${url}`;
}

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function registerUserAttributeRoutes(app: App, ctx: { store: ControlStore }): void {
  const { store } = ctx;
  const ua = store.userAttributes;

  /* ---------------- Admin attribute definitions ---------------- */

  app.get("/api/v1/admin/user-attributes", async (c) => {
    return c.json({ items: await ua.listDefinitions() });
  });

  app.post("/api/v1/admin/user-attributes", async (c) => {
    const parsed = CreateUserAttributeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const item = await ua.createDefinition(parsed.data);
    return c.json({ item }, 201);
  });

  app.patch("/api/v1/admin/user-attributes/:id", async (c) => {
    const parsed = UpdateUserAttributeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const item = await ua.updateDefinition(c.req.param("id"), parsed.data);
    return c.json({ item });
  });

  app.delete("/api/v1/admin/user-attributes/:id", async (c) => {
    const id = c.req.param("id");
    await ua.deleteDefinition(id);
    return c.json({ deleted: true, id });
  });

  /* ---------------- Admin user attribute values ---------------- */

  app.get("/api/v1/admin/users/:userId/attributes", async (c) => {
    const items = await ua.listUserValues(c.req.param("userId"));
    return c.json({ items });
  });

  app.put("/api/v1/admin/users/:userId/attributes", async (c) => {
    const parsed = UpdateUserAttributeValuesRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const items = await ua.setUserValues(c.req.param("userId"), parsed.data.values, { isAdmin: true });
    return c.json({ items });
  });

  /* ---------------- User self-service attributes ---------------- */

  app.get("/api/v1/user/attributes", async (c) => {
    const items = await ua.listUserValues(c.get("authUser").sub, { onlyEnabled: true });
    return c.json({ items });
  });

  app.put("/api/v1/user/attributes", async (c) => {
    const parsed = UpdateUserAttributeValuesRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const items = await ua.setUserValues(c.get("authUser").sub, parsed.data.values, { isAdmin: false });
    return c.json({ items });
  });

  /* ---------------- Admin API keys ---------------- */

  app.get("/api/v1/admin/api-keys", async (c) => {
    return c.json({ items: await ua.listAdminApiKeys() });
  });

  app.post("/api/v1/admin/api-keys", async (c) => {
    const claims = c.get("authUser");
    if (claims.authKind === "admin_api_key") {
      return c.json({ error: "forbidden", message: "Interactive sign-in required to mint an admin API key" }, 403);
    }
    const parsed = CreateAdminApiKeyRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const token = randomAdminToken();
    const keyHash = await sha256Hex(token);
    const keyPrefix = token.slice(0, 18);
    const item = await ua.createAdminApiKey(claims.sub, parsed.data, { keyPrefix, keyHash });
    return c.json({ item, token }, 201);
  });

  app.delete("/api/v1/admin/api-keys/:id", async (c) => {
    const claims = c.get("authUser");
    if (claims.authKind === "admin_api_key") {
      return c.json({ error: "forbidden", message: "Interactive sign-in required to revoke an admin API key" }, 403);
    }
    const item = await ua.revokeAdminApiKey(c.req.param("id"));
    return c.json({ item });
  });
}
