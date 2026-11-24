import { describe, expect, it } from "bun:test";
import type {
  DataPlaneSyncSnapshot,
  GroupItem,
  TurnSettlementEvent,
  UserPlatformQuotaItem,
  UserPlatformQuotasResponse,
  UserSubscriptionItem,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "platform-quotas-internal-token";

type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const store = factory ? await factory() : undefined;
  const app = createBffApp({
    store,
    jwtSecret: "platform-quotas-test-jwt-secret-32-bytes",
    vaultSecret: "platform-quotas-test-vault-secret-32b",
    internalToken: INTERNAL,
  });

  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T };
  };

  const init = await call<{ accessToken: string; user: { id: string } }>(
    "POST",
    "/api/v1/setup/initialize",
    JSON_HEADERS,
    {
      siteName: "Quota Test",
      adminEmail: "admin@quotas.test",
      adminPassword: "AdminPassword123!",
      allowRegistration: true,
    },
  );
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };

  const reg = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
    email: "member@quotas.test",
    password: "MemberPassword123!",
  });
  expect(reg.status).toBe(201);
  const member = {
    id: reg.body.user.id,
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${reg.body.accessToken}` },
  };

  return { app, call, admin, member };
}

describe("Lane U2: platform quotas and per-window subscription resets", () => {
  it("evaluates daily/weekly/monthly caps, propagates blockedPlatforms, and resets single windows independently", async () => {
    const { app, call, admin, member } = await bootstrap();

    const grp = await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, {
      name: "anth-quota",
      platform: "anthropic",
      subscriptionType: "balance",
      rateMultiplier: 1,
    });
    expect(grp.status).toBe(201);
    const groupId = grp.body.group.id;

    const acc = await call<{ account: { id: string } }>("POST", "/api/v1/admin/accounts", admin, {
      groupId,
      name: "acc-1",
      platform: "anthropic",
      executionMode: "direct_api",
      authKind: "api_key",
      credentialSecret: "sk-ant-test-key",
    });
    expect(acc.status).toBe(201);

    const keyRes = await call<{ item: { id: string } }>("POST", "/api/v1/user/api-keys", member.headers, {
      name: "member-key",
      groupId,
    });
    expect(keyRes.status).toBe(201);

    await call("POST", `/api/v1/admin/users/${member.id}/balance`, admin, {
      operation: "add",
      amountUsd: "100",
    });

    // Configure $2 daily, $5 weekly, $20 monthly caps on anthropic for member.
    const putRes = await call<UserPlatformQuotasResponse>(
      "PUT",
      `/api/v1/admin/users/${member.id}/platform-quotas`,
      admin,
      {
        items: [
          {
            platform: "anthropic",
            dailyLimitNanoUsd: "2000000000",
            weeklyLimitNanoUsd: "5000000000",
            monthlyLimitNanoUsd: "20000000000",
          },
        ],
      },
    );
    expect(putRes.status).toBe(200);
    expect(putRes.body.items.length).toBe(1);
    expect(putRes.body.items[0]!.overLimit).toBe(false);

    // Record a $2.50 settlement on anthropic -> breaches daily ($2) while weekly ($2.50 < $5) stays under.
    const settleEv: TurnSettlementEvent = {
      settlementId: "stl_u2_1",
      requestId: "req_u2_1",
      userId: member.id,
      apiKeyId: keyRes.body.item.id,
      accountId: acc.body.account.id,
      groupId,
      platform: "anthropic",
      publicModel: "claude-sonnet-4-5",
      upstreamModel: "claude-sonnet-4-5",
      ingressCodec: "anthropic_messages",
      egressCodec: "anthropic_messages",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costNanoUsd: "2500000000",
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      ttftMs: 10,
      durationMs: 20,
      statusCode: 200,
    };
    const settleRes = await app.request("/api/v1/internal/dataplane/settlement", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL },
      body: JSON.stringify(settleEv),
    });
    expect(settleRes.status).toBe(200);

    // Snapshot now includes blockedPlatforms entry for member/anthropic (window: daily).
    const snapRes = await call<DataPlaneSyncSnapshot>("GET", "/api/v1/internal/dataplane/snapshot", {
      "X-Slipgate-Internal-Token": INTERNAL,
    });
    expect(snapRes.status).toBe(200);
    expect(snapRes.body.userLimits?.blockedPlatforms).toEqual([
      { userId: member.id, platform: "anthropic", window: "daily" },
    ]);

    // User self-read reflects overLimit & usage.
    const mine = await call<UserPlatformQuotasResponse>("GET", "/api/v1/user/platform-quotas", member.headers);
    expect(mine.status).toBe(200);
    expect(mine.body.items[0]!.overLimit).toBe(true);
    expect(mine.body.items[0]!.overLimitWindow).toBe("daily");
    expect(mine.body.items[0]!.dailyUsedNanoUsd).toBe("2500000000");

    // Reset ONLY daily window -> daily becomes 0, weekly/monthly STILL retain $2.50!
    await new Promise((r) => setTimeout(r, 10));
    const resetRes = await call<{ item: UserPlatformQuotaItem }>(
      "POST",
      `/api/v1/admin/users/${member.id}/platform-quotas/anthropic/reset`,
      admin,
      { window: "daily" },
    );
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.item.overLimit).toBe(false);
    expect(resetRes.body.item.dailyUsedNanoUsd).toBe("0");
    expect(resetRes.body.item.weeklyUsedNanoUsd).toBe("2500000000");
    expect(resetRes.body.item.monthlyUsedNanoUsd).toBe("2500000000");
    expect(resetRes.body.item.dailyResetAtIso).not.toBeNull();
    expect(resetRes.body.item.weeklyResetAtIso).toBeNull();

    // Snapshot clears blockedPlatforms after daily reset.
    const snapAfterReset = await call<DataPlaneSyncSnapshot>("GET", "/api/v1/internal/dataplane/snapshot", {
      "X-Slipgate-Internal-Token": INTERNAL,
    });
    expect(snapAfterReset.body.userLimits?.blockedPlatforms).toEqual([]);

    // Deleting quota cleans it up.
    const delRes = await call<{ deleted: boolean }>(
      "DELETE",
      `/api/v1/admin/users/${member.id}/platform-quotas/anthropic`,
      admin,
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);
    const emptyAfter = await call<UserPlatformQuotasResponse>(
      "GET",
      `/api/v1/admin/users/${member.id}/platform-quotas`,
      admin,
    );
    expect(emptyAfter.body.items).toEqual([]);
  });

  it("resets subscription daily usage independently from weekly and monthly windows", async () => {
    const { app, call, admin, member } = await bootstrap();

    const subGroup = await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, {
      name: "sub-window-reset",
      platform: "openai",
      subscriptionType: "subscription",
      dailyLimitUsd: "1",
      weeklyLimitUsd: "5",
      monthlyLimitUsd: "10",
    });
    expect(subGroup.status).toBe(201);
    const gid = subGroup.body.group.id;

    const assignRes = await call<{ items: UserSubscriptionItem[] }>(
      "POST",
      "/api/v1/admin/subscriptions/assign",
      admin,
      { userIds: [member.id], groupId: gid, validityDays: 30 },
    );
    expect(assignRes.status).toBe(201);
    const subId = assignRes.body.items[0]!.id;

    const acc = await call<{ account: { id: string } }>("POST", "/api/v1/admin/accounts", admin, {
      groupId: gid,
      name: "acc-openai",
      platform: "openai",
      executionMode: "direct_api",
      authKind: "api_key",
      credentialSecret: "sk-openai-test-key",
    });
    expect(acc.status).toBe(201);

    const keyRes = await call<{ item: { id: string } }>("POST", "/api/v1/user/api-keys", member.headers, {
      name: "sub-key",
      groupId: gid,
    });
    expect(keyRes.status).toBe(201);

    const settleEv: TurnSettlementEvent = {
      settlementId: "stl_sub_u2_1",
      requestId: "req_sub_u2_1",
      userId: member.id,
      apiKeyId: keyRes.body.item.id,
      accountId: acc.body.account.id,
      groupId: gid,
      platform: "openai",
      publicModel: "gpt-4.1",
      upstreamModel: "gpt-4.1",
      ingressCodec: "openai_chat",
      egressCodec: "openai_chat",
      inputTokens: 100,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costNanoUsd: "1500000000",
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      ttftMs: 10,
      durationMs: 20,
      statusCode: 200,
    };
    const settleRes = await app.request("/api/v1/internal/dataplane/settlement", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL },
      body: JSON.stringify(settleEv),
    });
    expect(settleRes.status).toBe(200);

    // Before reset: daily=1.5B breaches $1 daily limit -> overLimit=true.
    const before = await call<{ items: UserSubscriptionItem[] }>("GET", `/api/v1/admin/subscriptions?groupId=${gid}`, admin);
    expect(before.body.items[0]!.overLimit).toBe(true);
    expect(before.body.items[0]!.usage.dailyNanoUsd).toBe("1500000000");

    // Reset ONLY daily window -> daily drops to 0 and overLimit becomes false, while weekly/monthly stay 1.5B.
    await new Promise((r) => setTimeout(r, 10));
    const resetDaily = await call<{ item: UserSubscriptionItem }>(
      "PATCH",
      `/api/v1/admin/subscriptions/${subId}`,
      admin,
      { action: "reset_usage", window: "daily" },
    );
    expect(resetDaily.status).toBe(200);
    expect(resetDaily.body.item.overLimit).toBe(false);
    expect(resetDaily.body.item.usage.dailyNanoUsd).toBe("0");
    expect(resetDaily.body.item.usage.weeklyNanoUsd).toBe("1500000000");
    expect(resetDaily.body.item.usage.monthlyNanoUsd).toBe("1500000000");
    expect(resetDaily.body.item.dailyResetAtIso).not.toBeNull();
    expect(resetDaily.body.item.weeklyResetAtIso).toBeNull();
  });
});
