import { describe, expect, it } from "bun:test";
import type { ConfigBackupFile, ConfigImportResult, GroupItem } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import type { ControlStore } from "../store/types.ts";
import { allowPrivateUpstreamsInSuite } from "./private_upstreams.ts";

/** Postgres-backed runs inject a store factory through a test preload; default is in-memory. */
const storeFactory = (globalThis as { __slipgateTestStoreFactory?: () => Promise<ControlStore> }).__slipgateTestStoreFactory;

const JSON_HEADERS = { "Content-Type": "application/json" };

async function instance(siteName: string) {
  const app = createBffApp({
    store: storeFactory ? await storeFactory() : undefined,
    jwtSecret: "admin-tools-jwt-secret-32-bytes-min",
    vaultSecret: "admin-tools-vault-secret-32-bytes-min",
  });
  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  };
  const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName,
    adminEmail: "admin@tools.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  return { call, admin: { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` } };
}

describe("plugin management", () => {
  allowPrivateUpstreamsInSuite();

  it("lists the built-in webhook plugin, stores secrets encrypted and delivers a signed test event", async () => {
    const { call, admin } = await instance("Plugins");
    const list = await call<{ items: { name: string; enabled: boolean; hooks: string[] }[] }>("GET", "/api/v1/admin/plugins", admin);
    const hook = list.body.items.find((p) => p.name === "payment-webhook")!;
    expect(hook.hooks).toContain("onPaymentSettled");

    const received: { sig: string | null; body: string }[] = [];
    const sink = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push({ sig: req.headers.get("x-slipgate-signature"), body: await req.text() });
        return new Response("ok");
      },
    });
    try {
      const patched = await call<{ item: { config: Record<string, string>; secretsSet: Record<string, boolean> } }>(
        "PATCH",
        "/api/v1/admin/plugins/payment-webhook",
        admin,
        { config: { url: `http://127.0.0.1:${sink.port}/hook`, secret: "s3cret" } },
      );
      expect(patched.body.item.config.secret).toBe("");
      expect(patched.body.item.secretsSet.secret).toBe(true);
      const test = await call<{ ok: boolean }>("POST", "/api/v1/admin/plugins/payment-webhook/test", admin);
      expect(test.body.ok).toBe(true);
      expect(received).toHaveLength(1);
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(received[0]!.body)));
      expect(received[0]!.sig).toBe(`sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`);

      await call("PATCH", "/api/v1/admin/plugins/payment-webhook", admin, { enabled: false });
      expect((await call("POST", "/api/v1/admin/plugins/payment-webhook/test", admin)).status).toBe(400);
    } finally {
      sink.stop(true);
    }
  });
});

describe("configuration backup", () => {
  it("exports operator config without secrets and merges it into another instance", async () => {
    const a = await instance("Source");
    await a.call("PATCH", "/api/v1/admin/settings", a.admin, { siteSubtitle: "from backup", affiliateEnabled: true });
    const sub = (
      await a.call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", a.admin, {
        name: "pro-sub",
        platform: "anthropic",
        subscriptionType: "subscription",
        dailyLimitUsd: "5",
      })
    ).body.group;
    await a.call("POST", "/api/v1/admin/routes", a.admin, {
      groupId: sub.id,
      publicModel: "team-sonnet",
      targetPlatform: "anthropic",
      upstreamModel: "claude-sonnet-5-5",
    });
    await a.call("POST", "/api/v1/admin/payments/plans", a.admin, {
      name: "Pro monthly",
      kind: "subscription",
      price: "20",
      groupId: sub.id,
      validityDays: 30,
    });
    await a.call("POST", "/api/v1/admin/promo-codes", a.admin, { code: "HELLO", bonusUsd: "1.5" });
    await a.call("POST", "/api/v1/admin/announcements", a.admin, { title: "Hi", status: "published" });
    await a.call("POST", "/api/v1/admin/pricing", a.admin, { pattern: "claude-*", inputPerMTokUsd: "2", outputPerMTokUsd: "8" });
    await a.call("PATCH", "/api/v1/admin/email/config", a.admin, { host: "smtp.x", password: "never-exported" });

    const exported = await a.call<ConfigBackupFile>("GET", "/api/v1/admin/backup/export", a.admin);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).not.toContain("never-exported");
    expect(exported.body.groups.some((g) => g.name === "pro-sub")).toBe(true);

    const b = await instance("Target");
    const imported = await b.call<ConfigImportResult>("POST", "/api/v1/admin/backup/import", b.admin, { file: exported.body });
    expect(imported.status).toBe(200);
    expect(imported.body.errors).toEqual([]);
    expect(imported.body.created).toMatchObject({ groups: 1, compositeRoutes: 1, paymentPlans: 1, promoCodes: 1, announcements: 1, pricingRules: 1 });

    const settings = await b.call<{ siteSubtitle: string; siteName: string }>("GET", "/api/v1/admin/settings", b.admin);
    expect(settings.body.siteSubtitle).toBe("from backup");
    const groups = await b.call<{ groups: GroupItem[] }>("GET", "/api/v1/admin/groups", b.admin);
    const restored = groups.body.groups.find((g) => g.name === "pro-sub")!;
    expect(restored.dailyLimitNanoUsd).toBe("5000000000");
    const routes = await b.call<{ routes: { groupId: string }[] }>("GET", "/api/v1/admin/routes", b.admin);
    expect(routes.body.routes.find((r) => r.groupId === restored.id)).toBeTruthy();

    // Importing again is a no-op (everything matched by name/code/pattern).
    const again = await b.call<ConfigImportResult>("POST", "/api/v1/admin/backup/import", b.admin, { file: exported.body });
    expect(again.body.created).toEqual({});
  });
});
