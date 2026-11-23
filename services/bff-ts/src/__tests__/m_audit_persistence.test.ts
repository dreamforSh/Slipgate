import { describe, expect, it } from "bun:test";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_BACKUP_TYPE,
  type ConfigImportResult,
  type DataPlaneSyncSnapshot,
  type PortalSettings,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { assertSafePlainSqlDump } from "../db_backup/dump_runner.ts";
import { totpAt, TOTP_STEP_SECONDS } from "../security/totp.ts";
import { MemoryControlStore } from "../store/memory_store.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "m-audit-internal-token";
const INTERNAL_HEADERS = { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL };

async function bootstrap() {
  const store = new MemoryControlStore();
  const app = createBffApp({
    store,
    jwtSecret: "m-audit-jwt-secret-32-bytes-minimum",
    vaultSecret: "m-audit-vault-secret-32-bytes-minimum",
    internalToken: INTERNAL,
  });
  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  };
  const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Audit Suite",
    adminEmail: "admin@audit.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  return { store, app, call, admin };
}

describe("M-02..M-07 engineering & P1 persistence closure", () => {
  it("[M-02] serialises concurrent portal settings patches and pending order caps", async () => {
    const { call, admin } = await bootstrap();

    // Two concurrent PATCH /api/v1/admin/settings touching distinct fields must both persist.
    const [r1, r2] = await Promise.all([
      call<PortalSettings>("PATCH", "/api/v1/admin/settings", admin, { siteSubtitle: "sub-one" }),
      call<PortalSettings>("PATCH", "/api/v1/admin/settings", admin, { affiliateEnabled: true, affiliateRebateBps: 750 }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const merged = await call<PortalSettings>("GET", "/api/v1/admin/settings", admin);
    expect(merged.body.siteSubtitle).toBe("sub-one");
    expect(merged.body.affiliateEnabled).toBe(true);
    expect(merged.body.affiliateRebateBps).toBe(750);

    // Enable manual payments with maxPendingOrders = 2 and fire 6 concurrent order creations.
    expect(
      (
        await call("PATCH", "/api/v1/admin/payments/config", admin, {
          enabled: true,
          customAmountEnabled: true,
          maxPendingOrders: 2,
          manual: { enabled: true, instructions: "Wire transfer" },
        })
      ).status,
    ).toBe(200);

    const reg = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email: "buyer@audit.test",
      password: "BuyerPassword123!",
    });
    const buyer = { ...JSON_HEADERS, Authorization: `Bearer ${reg.body.accessToken}` };

    const orders = await Promise.all(
      Array.from({ length: 6 }, () =>
        call("POST", "/api/v1/user/orders", buyer, { provider: "manual", amount: "10" }),
      ),
    );
    expect(orders.filter((o) => o.status === 201)).toHaveLength(2);
    expect(orders.filter((o) => o.status === 409)).toHaveLength(4);

    // Atomic wallet balance set + add.
    const setRes = await call<{ balanceNanoUsd: string; deltaNanoUsd: string }>(
      "POST",
      `/api/v1/admin/users/${reg.body.user.id}/balance`,
      admin,
      { operation: "set", amountUsd: "12.5" },
    );
    expect(setRes.status).toBe(200);
    expect(setRes.body.balanceNanoUsd).toBe("12500000000");
  });

  it("[M-03] validates backup BigInt and schema fields without mid-import 500 crashes", async () => {
    const { call, admin, store } = await bootstrap();

    const imported = await call<ConfigImportResult>("POST", "/api/v1/admin/backup/import", admin, {
      file: {
        type: CONFIG_BACKUP_TYPE,
        version: 1,
        exportedAtIso: new Date().toISOString(),
        portalSettings: null,
        groups: [
          {
            id: "grp_bad",
            name: "bad-bigint-group",
            platform: "anthropic",
            subscriptionType: "subscription",
            dailyLimitNanoUsd: "not-a-bigint",
          },
        ],
        compositeRoutes: [],
        paymentPlans: [],
        promoCodes: [{ code: "BADPROMO", bonusNanoUsd: "NaN" }],
        announcements: [],
        pricingRules: [
          { pattern: "bad-rule", inputNanoPerMTok: "invalid" },
          {
            pattern: "gpt-valid-*",
            inputNanoPerMTok: "1000000000",
            outputNanoPerMTok: "4000000000",
            cacheReadNanoPerMTok: "100000000",
            cacheWriteNanoPerMTok: "1250000000",
            enabled: true,
            notes: "valid rule",
          },
        ],
        autoTest: { enabled: "not-a-bool", intervalMinutes: -1 },
        disabledPlugins: [],
      },
    });
    expect(imported.status).toBe(200);
    expect(imported.body.created.pricingRules).toBe(1);
    expect(imported.body.errors.some((e) => e.includes("bad-bigint-group"))).toBe(true);
    expect(imported.body.errors.some((e) => e.includes("BADPROMO"))).toBe(true);
    expect(imported.body.errors.some((e) => e.includes("bad-rule"))).toBe(true);
    expect(imported.body.errors.some((e) => e.includes("autoTest"))).toBe(true);
    expect((await store.listPricingRules()).some((r) => r.pattern === "gpt-valid-*")).toBe(true);
  });

  it("[M-04] bumps token_version on self-service 2FA disable and rotates the active session", async () => {
    const { call } = await bootstrap();
    const reg = await call<{ accessToken: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email: "totp@audit.test",
      password: "UserPassword123!",
    });
    const sessionA = { ...JSON_HEADERS, Authorization: `Bearer ${reg.body.accessToken}` };

    const setup = await call<{ secret: string }>("POST", "/api/v1/user/totp/setup", sessionA, {
      password: "UserPassword123!",
    });
    const step = () => Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    expect(
      (await call("POST", "/api/v1/user/totp/enable", sessionA, { code: await totpAt(setup.body.secret, step() - 1) }))
        .status,
    ).toBe(200);

    const loginB = await call<{ accessToken: string }>("POST", "/api/v1/auth/login", JSON_HEADERS, {
      email: "totp@audit.test",
      password: "UserPassword123!",
      totpCode: await totpAt(setup.body.secret, step()),
    });
    expect(loginB.status).toBe(200);
    const sessionB = { ...JSON_HEADERS, Authorization: `Bearer ${loginB.body.accessToken}` };

    const disabled = await call<{ enabled: boolean; session?: { accessToken: string } }>(
      "POST",
      "/api/v1/user/totp/disable",
      sessionA,
      { password: "UserPassword123!", code: await totpAt(setup.body.secret, step() + 1) },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    expect(disabled.body.session?.accessToken).toBeTruthy();

    // Both older tokens are revoked immediately; the newly issued token remains valid.
    expect((await call("GET", "/api/v1/user/totp", sessionB)).status).toBe(401);
    expect((await call("GET", "/api/v1/user/totp", sessionA)).status).toBe(401);
    const rotated = { ...JSON_HEADERS, Authorization: `Bearer ${disabled.body.session!.accessToken}` };
    expect((await call("GET", "/api/v1/user/totp", rotated)).status).toBe(200);
  });

  it("[M-05] rejects psql backslash meta-commands outside COPY blocks in plain SQL dumps", async () => {
    const safePath = join(tmpdir(), `slipgate-safe-${crypto.randomUUID()}.sql`);
    const badPath = join(tmpdir(), `slipgate-bad-${crypto.randomUUID()}.sql`);
    try {
      await writeFile(
        safePath,
        "\\restrict token123\nCREATE SCHEMA core;\nCOPY core.groups (id) FROM stdin;\n\\!not_a_cmd_inside_copy\n\\.\n\\unrestrict token123\n",
      );
      await assertSafePlainSqlDump(safePath);

      await writeFile(badPath, "CREATE SCHEMA core;\n\\! id\n");
      let rejected = false;
      try {
        await assertSafePlainSqlDump(badPath);
      } catch (err) {
        rejected = String(err).includes("backslash meta-command");
      }
      expect(rejected).toBe(true);
    } finally {
      await unlink(safePath).catch(() => undefined);
      await unlink(badPath).catch(() => undefined);
    }
  });

  it("[M-07 & P1] cleans orphan wallets on user delete, keeps >500 memory usage logs, and persists media/response tasks", async () => {
    const { call, admin, store } = await bootstrap();

    // Legacy model_pricing blob migrates cleanly into listPricingRules().
    await store.ops.setBlob("model_pricing", {
      rules: [
        {
          id: "price_legacy_1",
          pattern: "legacy-*",
          inputNanoPerMTok: "500000000",
          outputNanoPerMTok: "1500000000",
          cacheReadNanoPerMTok: "50000000",
          cacheWriteNanoPerMTok: "625000000",
          enabled: true,
          notes: "migrated",
          updatedAtIso: new Date().toISOString(),
        },
      ],
    });
    expect((await store.listPricingRules()).some((r) => r.pattern === "legacy-*")).toBe(true);

    // User deletion leaves no orphan wallet in snapshot.
    const tempUser = await call<{ user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email: "temp@audit.test",
      password: "UserPassword123!",
    });
    const uid = tempUser.body.user.id;
    await call("POST", `/api/v1/admin/users/${uid}/balance`, admin, { operation: "add", amountUsd: "5" });
    expect((await call("DELETE", `/api/v1/admin/users/${uid}`, admin)).status).toBe(200);
    const snap: DataPlaneSyncSnapshot = await store.exportDataPlaneSnapshot();
    expect(snap.wallets.some((w) => w.userId === uid)).toBe(false);

    // >500 settlements retained in MemoryControlStore.
    const heavy = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email: "heavy@audit.test",
      password: "UserPassword123!",
    });
    const heavyHeaders = { ...JSON_HEADERS, Authorization: `Bearer ${heavy.body.accessToken}` };
    const keyRes = await call<{ item: { id: string } }>("POST", "/api/v1/user/api-keys", heavyHeaders, {
      groupId: "grp_default",
      name: "k",
      limit7dUsd: "1",
    });
    for (let i = 0; i < 550; i++) {
      await store.recordTurnSettlement({
        settlementId: `stl_heavy_${String(i).padStart(6, "0")}`,
        requestId: `req_${i}`,
        userId: heavy.body.user.id,
        apiKeyId: keyRes.body.item.id,
        accountId: "acc_1",
        groupId: "grp_default",
        platform: "openai",
        publicModel: "gpt-4o-mini",
        upstreamModel: "gpt-4o-mini",
        ingressCodec: "openai_chat",
        egressCodec: "openai_chat",
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costNanoUsd: "2000000",
        ttftMs: 10,
        durationMs: 20,
        window5hUsedBps: 0,
        window7dUsedBps: 0,
        statusCode: 200,
      });
    }
    const logs = await store.listUsageLogs({
      userId: heavy.body.user.id,
      sinceIso: new Date(Date.now() - 86_400_000).toISOString(),
      limit: 1000,
    });
    expect(logs.length).toBe(550);
    expect(await store.getApiKeyLimitState(keyRes.body.item.id)).toBe("window_exhausted");

    // Internal dataplane media-tasks persistence + ownership isolation.
    const saved = await call<{ ok: boolean }>("POST", "/api/v1/internal/dataplane/media-tasks", INTERNAL_HEADERS, {
      id: "resp_persisted_1",
      apiKeyId: "key_owner_a",
      kind: "response_state",
      publicModel: "gpt-5",
      resultJson: { responseJson: { id: "resp_persisted_1", object: "response" }, inputItems: [], history: [] },
    });
    expect(saved.status).toBe(200);
    expect(
      (await call("GET", "/api/v1/internal/dataplane/media-tasks/response_state/resp_persisted_1?apiKeyId=key_owner_b", INTERNAL_HEADERS)).status,
    ).toBe(404);
    const fetched = await call<{ item: { resultJson: { responseJson: { id: string } } } }>(
      "GET",
      "/api/v1/internal/dataplane/media-tasks/response_state/resp_persisted_1?apiKeyId=key_owner_a",
      INTERNAL_HEADERS,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.item.resultJson.responseJson.id).toBe("resp_persisted_1");
    expect(
      (await call("DELETE", "/api/v1/internal/dataplane/media-tasks/response_state/resp_persisted_1?apiKeyId=key_owner_a", INTERNAL_HEADERS)).status,
    ).toBe(200);
    expect(
      (await call("GET", "/api/v1/internal/dataplane/media-tasks/response_state/resp_persisted_1?apiKeyId=key_owner_a", INTERNAL_HEADERS)).status,
    ).toBe(404);
  });
});
