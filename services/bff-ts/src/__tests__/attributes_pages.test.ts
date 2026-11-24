import { describe, expect, it } from "bun:test";
import type {
  AdminApiKeyItem,
  AdminUserItem,
  AdminUserListResponse,
  CreateAdminApiKeyResponse,
  GroupItem,
  PublicSitePageNavItem,
  SitePage,
  UsagePageResponse,
  UserAttributeDefinition,
  UserAttributeValueItem,
  UserSubscriptionItem,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { hashPassword } from "../security/crypto.ts";
import { MemoryControlStore } from "../store/memory_store.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const ORIGIN = "http://localhost";

async function setup() {
  const store = new MemoryControlStore();
  const app = createBffApp({
    store,
    jwtSecret: "attributes-pages-test-jwt-secret-32b",
    vaultSecret: "attributes-pages-test-vault-secret-32b",
    internalToken: "attributes-pages-internal-token",
  });

  async function api<T>(
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? JSON_HEADERS : {}),
        ...(extraHeaders ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body: parsed };
  }

  const adminPassword = "AdminPassword123!";
  const init = await api<{ accessToken: string; user: { id: string; email: string } }>(
    "POST",
    "/api/v1/setup/initialize",
    undefined,
    {
      siteName: "Slipgate Test",
      adminEmail: "admin@attrpages.test",
      adminPassword,
      allowRegistration: true,
    },
  );
  expect(init.status).toBe(201);
  return {
    app,
    store,
    adminToken: init.body.accessToken,
    adminId: init.body.user.id,
    adminPassword,
    api,
  };
}

describe("Lanes A4 + S1: User Attributes, Group Manager, Admin API Keys, Signup Defaults & Site Pages", () => {
  it("manages custom user attribute definitions and enforces validation for self-service & admin edits", async () => {
    const t = await setup();

    const reg = await t.api<{ accessToken: string; user: { id: string } }>(
      "POST",
      "/api/v1/auth/register",
      undefined,
      { email: "alice@attr.test", password: "Password123!", username: "Alice" },
    );
    expect(reg.status).toBe(201);
    const userToken = reg.body.accessToken;
    const userId = reg.body.user.id;

    // Select without options must be rejected
    const badSelect = await t.api("POST", "/api/v1/admin/user-attributes", t.adminToken, {
      key: "plan_tier",
      name: "Plan Tier",
      type: "select",
      options: [],
    });
    expect(badSelect.status).toBe(400);

    const companyDef = (
      await t.api<{ item: UserAttributeDefinition }>("POST", "/api/v1/admin/user-attributes", t.adminToken, {
        key: "company",
        name: "Company",
        type: "text",
        required: true,
        enabled: true,
        sortOrder: 1,
      })
    ).body.item;
    expect(companyDef.key).toBe("company");

    // Duplicate key rejected
    const dup = await t.api("POST", "/api/v1/admin/user-attributes", t.adminToken, {
      key: "company",
      name: "Duplicate",
      type: "text",
    });
    expect(dup.status).toBe(409);

    const teamSizeDef = (
      await t.api<{ item: UserAttributeDefinition }>("POST", "/api/v1/admin/user-attributes", t.adminToken, {
        key: "team_size",
        name: "Team Size",
        type: "number",
        sortOrder: 2,
      })
    ).body.item;

    const birthDef = (
      await t.api<{ item: UserAttributeDefinition }>("POST", "/api/v1/admin/user-attributes", t.adminToken, {
        key: "start_date",
        name: "Start Date",
        type: "date",
        sortOrder: 3,
      })
    ).body.item;

    const webDef = (
      await t.api<{ item: UserAttributeDefinition }>("POST", "/api/v1/admin/user-attributes", t.adminToken, {
        key: "website",
        name: "Website",
        type: "url",
        sortOrder: 4,
      })
    ).body.item;

    const tagsDef = (
      await t.api<{ item: UserAttributeDefinition }>("POST", "/api/v1/admin/user-attributes", t.adminToken, {
        key: "regions",
        name: "Regions",
        type: "multiselect",
        options: ["us-east", "eu-west", "ap-tokyo"],
        sortOrder: 5,
      })
    ).body.item;

    const hiddenDef = (
      await t.api<{ item: UserAttributeDefinition }>("POST", "/api/v1/admin/user-attributes", t.adminToken, {
        key: "internal_note",
        name: "Internal Note",
        type: "text",
        enabled: false,
        sortOrder: 6,
      })
    ).body.item;

    // Self-service listing hides disabled definition
    const selfList = await t.api<{ items: UserAttributeValueItem[] }>("GET", "/api/v1/user/attributes", userToken);
    expect(selfList.status).toBe(200);
    expect(selfList.body.items.map((i) => i.key)).toEqual(["company", "team_size", "start_date", "website", "regions"]);

    // Missing required attribute rejected
    const missingReq = await t.api("PUT", "/api/v1/user/attributes", userToken, {
      values: { [companyDef.id]: "" },
    });
    expect(missingReq.status).toBe(400);

    // Invalid number / date / url / multiselect rejected
    expect(
      (await t.api("PUT", "/api/v1/user/attributes", userToken, {
        values: { [companyDef.id]: "Acme", [teamSizeDef.id]: "not-a-number" },
      })).status,
    ).toBe(400);
    expect(
      (await t.api("PUT", "/api/v1/user/attributes", userToken, {
        values: { [companyDef.id]: "Acme", [birthDef.id]: "2026-02-30" },
      })).status,
    ).toBe(400);
    expect(
      (await t.api("PUT", "/api/v1/user/attributes", userToken, {
        values: { [companyDef.id]: "Acme", [webDef.id]: "javascript:alert(1)" },
      })).status,
    ).toBe(400);
    expect(
      (await t.api("PUT", "/api/v1/user/attributes", userToken, {
        values: { [companyDef.id]: "Acme", [tagsDef.id]: JSON.stringify(["unknown-region"]) },
      })).status,
    ).toBe(400);
    // Disabled attribute cannot be edited by user
    expect(
      (await t.api("PUT", "/api/v1/user/attributes", userToken, {
        values: { [companyDef.id]: "Acme", [hiddenDef.id]: "hack" },
      })).status,
    ).toBe(400);

    // Valid self-service update
    const okSave = await t.api<{ items: UserAttributeValueItem[] }>("PUT", "/api/v1/user/attributes", userToken, {
      values: {
        [companyDef.id]: "Acme Corp",
        [teamSizeDef.id]: "42",
        [birthDef.id]: "2026-05-15",
        [webDef.id]: "https://acme.example.com",
        [tagsDef.id]: JSON.stringify(["us-east", "eu-west", "us-east"]),
      },
    });
    expect(okSave.status).toBe(200);
    expect(okSave.body.items.find((i) => i.key === "company")?.value).toBe("Acme Corp");
    expect(okSave.body.items.find((i) => i.key === "regions")?.value).toBe('["us-east","eu-west"]');

    // Admin can set disabled attribute too and delete definition cleanly
    const adminPut = await t.api<{ items: UserAttributeValueItem[] }>(
      "PUT",
      `/api/v1/admin/users/${userId}/attributes`,
      t.adminToken,
      { values: { [hiddenDef.id]: "vip-tier" } },
    );
    expect(adminPut.status).toBe(200);
    expect(adminPut.body.items.find((i) => i.key === "internal_note")?.value).toBe("vip-tier");

    expect((await t.api("DELETE", `/api/v1/admin/user-attributes/${hiddenDef.id}`, t.adminToken)).status).toBe(200);
    const afterDel = await t.api<{ items: UserAttributeValueItem[] }>(
      "GET",
      `/api/v1/admin/users/${userId}/attributes`,
      t.adminToken,
    );
    expect(afterDel.body.items.some((i) => i.attributeId === hiddenDef.id)).toBe(false);
  });

  it("enforces fail-closed group_manager RBAC and excludes group_manager from admin counts", async () => {
    const t = await setup();

    const gA = (
      await t.api<{ group: GroupItem }>("POST", "/api/v1/admin/groups", t.adminToken, {
        name: "group-a",
        platform: "openai",
        isExclusive: true,
      })
    ).body.group;
    const gB = (
      await t.api<{ group: GroupItem }>("POST", "/api/v1/admin/groups", t.adminToken, {
        name: "group-b",
        platform: "anthropic",
        isExclusive: true,
      })
    ).body.group;

    // Seed an account per group
    expect(
      (
        await t.api("POST", "/api/v1/admin/accounts", t.adminToken, {
          groupId: gA.id,
          platform: "openai",
          authKind: "api_key",
          name: "acc-a",
          credentialSecret: "sk-a-secret",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await t.api("POST", "/api/v1/admin/accounts", t.adminToken, {
          groupId: gB.id,
          platform: "anthropic",
          authKind: "api_key",
          name: "acc-b",
          credentialSecret: "sk-b-secret",
        })
      ).status,
    ).toBe(201);

    const usrA = await t.store.ops.createUser({
      email: "usera@gm.test",
      username: "UserA",
      role: "user",
      notes: "",
      allowedGroupIds: [gA.id],
      passwordHash: await hashPassword("Password123!"),
      initialBalanceNano: 0n,
    });
    const usrB = await t.store.ops.createUser({
      email: "userb@gm.test",
      username: "UserB",
      role: "user",
      notes: "",
      allowedGroupIds: [gB.id],
      passwordHash: await hashPassword("Password123!"),
      initialBalanceNano: 0n,
    });

    const mgrRes = await t.api<{ user: AdminUserItem }>("POST", "/api/v1/admin/users", t.adminToken, {
      email: "manager@gm.test",
      password: "Password123!",
      username: "Manager",
      role: "group_manager",
      managedGroupIds: [gA.id],
    });
    expect(mgrRes.status).toBe(201);
    expect(mgrRes.body.user.managedGroupIds).toEqual([gA.id]);

    // Admin cannot self-demote to group_manager
    const selfDemote = await t.api("PATCH", `/api/v1/admin/users/${t.adminId}`, t.adminToken, {
      role: "group_manager",
    });
    expect(selfDemote.status).toBe(403);
    expect(await t.store.ops.countAdmins()).toBe(1);

    // Seed usage rows in gA and gB
    await t.store.recordTurnSettlement({
      settlementId: "stl-gm-a",
      requestId: "req-a",
      userId: usrA.id,
      apiKeyId: "key_a",
      accountId: "acc_a",
      groupId: gA.id,
      platform: "openai",
      publicModel: "gpt-4o",
      upstreamModel: "gpt-4o",
      ingressCodec: "openai_chat",
      egressCodec: "openai_chat",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costNanoUsd: "1000",
      ttftMs: 100,
      durationMs: 200,
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      statusCode: 200,
    });
    await t.store.recordTurnSettlement({
      settlementId: "stl-gm-b",
      requestId: "req-b",
      userId: usrB.id,
      apiKeyId: "key_b",
      accountId: "acc_b",
      groupId: gB.id,
      platform: "anthropic",
      publicModel: "claude-sonnet-4",
      upstreamModel: "claude-sonnet-4",
      ingressCodec: "anthropic_messages",
      egressCodec: "anthropic_messages",
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costNanoUsd: "2000",
      ttftMs: 120,
      durationMs: 250,
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      statusCode: 200,
    });

    const loginRes = await t.api<{ accessToken: string; user: { role: string } }>(
      "POST",
      "/api/v1/auth/login",
      undefined,
      { email: "manager@gm.test", password: "Password123!" },
    );
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.role).toBe("group_manager");
    const gmToken = loginRes.body.accessToken;

    // Scoped groups list & single-get & patch
    const groupsRes = await t.api<{ groups: GroupItem[] }>("GET", "/api/v1/admin/groups", gmToken);
    expect(groupsRes.status).toBe(200);
    expect(groupsRes.body.groups.map((g) => g.id)).toEqual([gA.id]);

    expect((await t.api("GET", `/api/v1/admin/groups/${gA.id}`, gmToken)).status).toBe(200);
    expect((await t.api("GET", `/api/v1/admin/groups/${gB.id}`, gmToken)).status).toBe(403);
    expect((await t.api("PATCH", `/api/v1/admin/groups/${gA.id}`, gmToken, { description: "Managed OK" })).status).toBe(200);
    expect((await t.api("PATCH", `/api/v1/admin/groups/${gB.id}`, gmToken, { description: "Nope" })).status).toBe(403);

    // Scoped accounts
    const accRes = await t.api<{ accounts: { groupId: string }[] }>("GET", "/api/v1/admin/accounts", gmToken);
    expect(accRes.status).toBe(200);
    expect(accRes.body.accounts.map((a) => a.groupId)).toEqual([gA.id]);
    expect((await t.api("GET", `/api/v1/admin/accounts?groupId=${gB.id}`, gmToken)).status).toBe(403);

    // Scoped users
    const usersRes = await t.api<AdminUserListResponse>("GET", "/api/v1/admin/users", gmToken);
    expect(usersRes.status).toBe(200);
    expect(usersRes.body.items.map((u) => u.email)).toEqual(["usera@gm.test"]);
    expect(usersRes.body.stats.admins).toBe(0);
    expect((await t.api("GET", "/api/v1/admin/users?role=admin", gmToken)).status).toBe(403);
    expect((await t.api("GET", `/api/v1/admin/users?groupId=${gB.id}`, gmToken)).status).toBe(403);

    // Scoped usage
    const usageQuick = await t.api<{ items: { groupId: string }[] }>("GET", "/api/v1/admin/usage", gmToken);
    expect(usageQuick.status).toBe(200);
    expect(usageQuick.body.items.map((u) => u.groupId)).toEqual([gA.id]);

    const usageQuery = await t.api<UsagePageResponse>("GET", "/api/v1/admin/usage/query", gmToken);
    expect(usageQuery.status).toBe(200);
    expect(usageQuery.body.items.map((u) => u.groupId)).toEqual([gA.id]);
    expect((await t.api("GET", `/api/v1/admin/usage/query?groupId=${gB.id}`, gmToken)).status).toBe(403);

    // Disallowed admin routes rejected
    expect((await t.api("GET", "/api/v1/admin/settings", gmToken)).status).toBe(403);
    expect((await t.api("POST", "/api/v1/admin/groups", gmToken, { name: "gC", platform: "openai" })).status).toBe(403);
    expect(
      (
        await t.api("POST", "/api/v1/admin/users", gmToken, {
          email: "hack@gm.test",
          password: "Password123!",
          role: "admin",
        })
      ).status,
    ).toBe(403);
    expect((await t.api("GET", "/api/v1/admin/api-keys", gmToken)).status).toBe(403);
    expect((await t.api("GET", "/api/v1/admin/pages", gmToken)).status).toBe(403);
  });

  it("authenticates X-Admin-Api-Key, blocks step-up actions, and rejects revoked/expired/inactive keys", async () => {
    const t = await setup();

    const minted = await t.api<CreateAdminApiKeyResponse>("POST", "/api/v1/admin/api-keys", t.adminToken, {
      name: "Automation Key",
      expiresInDays: 30,
    });
    expect(minted.status).toBe(201);
    expect(minted.body.token.startsWith("slipgate-adm-")).toBe(true);
    const admHeaders = { "X-Admin-Api-Key": minted.body.token };

    // Key listing never leaks raw secret
    const list = await t.api<{ items: AdminApiKeyItem[] }>("GET", "/api/v1/admin/api-keys", t.adminToken);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(minted.body.token);

    // Regular admin read/write succeeds with X-Admin-Api-Key
    expect((await t.api("GET", "/api/v1/admin/groups", undefined, undefined, admHeaders)).status).toBe(200);
    expect(
      (
        await t.api(
          "POST",
          "/api/v1/admin/pages",
          undefined,
          { slug: "via-key", title: "Via Key", body: "Hello", published: true },
          admHeaders,
        )
      ).status,
    ).toBe(201);

    // Admin API key cannot mint another admin API key or clear audit logs or create another admin (step-up blocked)
    expect(
      (await t.api("POST", "/api/v1/admin/api-keys", undefined, { name: "Nested" }, admHeaders)).status,
    ).toBe(403);
    expect(
      (
        await t.api(
          "POST",
          "/api/v1/admin/users",
          undefined,
          {
            email: "admin2@attrpages.test",
            password: "Password123!",
            role: "admin",
            confirm: { password: t.adminPassword },
          },
          admHeaders,
        )
      ).status,
    ).toBe(403);
    expect((await t.api("POST", "/api/v1/admin/audit-logs/clear", undefined, {}, admHeaders)).status).toBe(403);

    // Revoking key invalidates future requests
    const revoked = await t.api("DELETE", `/api/v1/admin/api-keys/${minted.body.item.id}`, t.adminToken);
    expect(revoked.status).toBe(200);
    expect((await t.api("GET", "/api/v1/admin/groups", undefined, undefined, admHeaders)).status).toBe(401);

    // Expired key directly rejected
    const expMinted = await t.api<CreateAdminApiKeyResponse>("POST", "/api/v1/admin/api-keys", t.adminToken, {
      name: "Short Lived",
      expiresInDays: 1,
    });
    expect(expMinted.status).toBe(201);
    const origNow = Date.now;
    Date.now = () => origNow() + 2 * 86_400_000;
    try {
      expect(
        (await t.api("GET", "/api/v1/admin/groups", undefined, undefined, { "X-Admin-Api-Key": expMinted.body.token })).status,
      ).toBe(401);
    } finally {
      Date.now = origNow;
    }

    // Create second admin, mint a key for them, then demote them -> rejected
    const admin2 = await t.store.ops.createUser({
      email: "admin2@attr.test",
      username: "Admin2",
      role: "admin",
      notes: "",
      allowedGroupIds: [],
      passwordHash: await hashPassword("Password123!"),
      initialBalanceNano: 0n,
    });
    const login2 = await t.api<{ accessToken: string }>("POST", "/api/v1/auth/login", undefined, {
      email: "admin2@attr.test",
      password: "Password123!",
    });
    const key2 = await t.api<CreateAdminApiKeyResponse>("POST", "/api/v1/admin/api-keys", login2.body.accessToken, {
      name: "Admin2 Key",
    });
    expect((await t.api("GET", "/api/v1/admin/groups", undefined, undefined, { "X-Admin-Api-Key": key2.body.token })).status).toBe(200);
    await t.store.ops.updateUser(admin2.id, { role: "user" });
    expect((await t.api("GET", "/api/v1/admin/groups", undefined, undefined, { "X-Admin-Api-Key": key2.body.token })).status).toBe(401);
  });

  it("provisions default signup groups & trial subscription on registration without leaking defaults publicly", async () => {
    const t = await setup();

    const gExclusive = (
      await t.api<{ group: GroupItem }>("POST", "/api/v1/admin/groups", t.adminToken, {
        name: "starter-exclusive",
        platform: "openai",
        isExclusive: true,
      })
    ).body.group;
    const gSub = (
      await t.api<{ group: GroupItem }>("POST", "/api/v1/admin/groups", t.adminToken, {
        name: "trial-sub",
        platform: "anthropic",
        subscriptionType: "subscription",
        dailyLimitUsd: "5",
      })
    ).body.group;

    const patched = await t.api("PATCH", "/api/v1/admin/settings", t.adminToken, {
      defaultSignupGroupIds: [gExclusive.id],
      defaultSignupSubGroupId: gSub.id,
      defaultSignupSubDays: 14,
    });
    expect(patched.status).toBe(200);

    // Public settings must not leak provisioning defaults
    const pub = await t.api<Record<string, unknown>>("GET", "/api/v1/public/settings");
    expect(pub.status).toBe(200);
    expect(pub.body.defaultSignupGroupIds).toBeUndefined();
    expect(pub.body.defaultSignupSubGroupId).toBeUndefined();

    const reg = await t.api<{ accessToken: string; user: { id: string } }>(
      "POST",
      "/api/v1/auth/register",
      undefined,
      { email: "newbie@signup.test", password: "Password123!", username: "Newbie" },
    );
    expect(reg.status).toBe(201);

    const userDetail = await t.api<{ user: AdminUserItem }>("GET", `/api/v1/admin/users/${reg.body.user.id}`, t.adminToken);
    expect(userDetail.status).toBe(200);
    expect(userDetail.body.user.allowedGroupIds).toEqual([gExclusive.id]);

    const subs = await t.api<{ items: UserSubscriptionItem[] }>("GET", "/api/v1/user/subscriptions", reg.body.accessToken);
    expect(subs.status).toBe(200);
    expect(subs.body.items).toHaveLength(1);
    expect(subs.body.items[0]?.groupId).toBe(gSub.id);
    expect(subs.body.items[0]?.status).toBe("active");
  });

  it("serves custom Markdown site pages, filters drafts/nav items, and respects backendModeEnabled", async () => {
    const t = await setup();

    const draft = await t.api<{ page: SitePage }>("POST", "/api/v1/admin/pages", t.adminToken, {
      slug: "draft-notes",
      title: "Draft Notes",
      summary: "Not public",
      body: "# Secret draft",
      published: false,
      showInNav: true,
      sortOrder: 1,
    });
    expect(draft.status).toBe(201);

    const faq = await t.api<{ page: SitePage }>("POST", "/api/v1/admin/pages", t.adminToken, {
      slug: "pricing-faq",
      title: "Pricing FAQ",
      summary: "Common questions",
      body: "# FAQ\n\nPay-as-you-go billing.",
      published: true,
      showInNav: true,
      sortOrder: 2,
    });
    expect(faq.status).toBe(201);

    // Duplicate slug conflict
    expect(
      (await t.api("POST", "/api/v1/admin/pages", t.adminToken, { slug: "pricing-faq", title: "Dup" })).status,
    ).toBe(409);

    const hidden = await t.api<{ page: SitePage }>("POST", "/api/v1/admin/pages", t.adminToken, {
      slug: "changelog",
      title: "Changelog",
      body: "- Initial release",
      published: true,
      showInNav: false,
      sortOrder: 3,
    });
    expect(hidden.status).toBe(201);

    const nav = await t.api<{ items: PublicSitePageNavItem[] }>("GET", "/api/v1/public/pages");
    expect(nav.status).toBe(200);
    expect(nav.body.items.map((p) => p.slug)).toEqual(["pricing-faq"]);

    expect((await t.api("GET", "/api/v1/public/pages/draft-notes")).status).toBe(404);
    const faqPub = await t.api<{ page: SitePage }>("GET", "/api/v1/public/pages/pricing-faq");
    expect(faqPub.status).toBe(200);
    expect(faqPub.body.page.body).toContain("Pay-as-you-go");
    expect((await t.api<{ page: SitePage }>("GET", "/api/v1/public/pages/changelog")).status).toBe(200);

    // Publish draft & delete
    expect((await t.api("PATCH", `/api/v1/admin/pages/${draft.body.page.id}`, t.adminToken, { published: true })).status).toBe(200);
    expect((await t.api("GET", "/api/v1/public/pages/draft-notes")).status).toBe(200);
    expect((await t.api("DELETE", `/api/v1/admin/pages/${draft.body.page.id}`, t.adminToken)).status).toBe(200);
    expect((await t.api("GET", "/api/v1/public/pages/draft-notes")).status).toBe(404);

    // Backend mode blocks public pages
    expect((await t.api("PATCH", "/api/v1/admin/settings", t.adminToken, { backendModeEnabled: true })).status).toBe(200);
    expect((await t.api("GET", "/api/v1/public/pages")).status).toBe(403);
    expect((await t.api("GET", "/api/v1/public/pages/pricing-faq")).status).toBe(403);
  });
});
