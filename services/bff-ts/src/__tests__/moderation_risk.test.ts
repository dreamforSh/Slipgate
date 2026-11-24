import { describe, expect, it } from "bun:test";
import type {
  DataPlaneSyncSnapshot,
  ModerationEvent,
  ModerationRule,
  ModerationSettings,
  ModerationTestResponse,
  RiskBanEvent,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { decryptSecret } from "../security/crypto.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "moderation-risk-internal-token";
const VAULT = "moderation-risk-vault-secret-32-bytes";

type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const store = factory ? await factory() : new MemoryControlStore();
  if (factory) await store.init();
  const app = createBffApp({
    store,
    jwtSecret: "moderation-risk-test-jwt-secret-32b",
    vaultSecret: VAULT,
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
      siteName: "Moderation Test",
      adminEmail: "admin@modrisk.test",
      adminPassword: "AdminPassword123!",
      allowRegistration: true,
    },
  );
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };

  const member = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
    email: "member@modrisk.test",
    password: "MemberPassword123!",
  });
  expect(member.status).toBe(201);

  return { app, store, call, admin, memberHeaders: { ...JSON_HEADERS, Authorization: `Bearer ${member.body.accessToken}` } };
}

describe("Lane O5: prompt moderation gateway & admin risk unban", () => {
  it("persists encrypted moderation settings without leaking secrets, manages rules, and runs dry-run tests", async () => {
    const { store, call, admin, memberHeaders } = await bootstrap();

    try {
      // Non-admin rejected
      const forbidden = await call("GET", "/api/v1/admin/moderation/settings", memberHeaders);
      expect(forbidden.status).toBe(403);

      // Save settings with external secret
      const patch1 = await call<ModerationSettings>("PATCH", "/api/v1/admin/moderation/settings", admin, {
        enabled: true,
        externalEnabled: true,
        externalEndpoint: "https://moderation.example.com/v1/moderations",
        externalApiKey: "sk-external-mod-secret",
        externalModel: "omni-moderation-latest",
        externalTimeoutMs: 2500,
        externalFailOpen: false,
      });
      expect(patch1.status).toBe(200);
      expect(patch1.body.enabled).toBe(true);
      expect(patch1.body.externalEnabled).toBe(true);
      expect(patch1.body.externalApiKeySet).toBe(true);
      expect(JSON.stringify(patch1.body)).not.toContain("sk-external-mod-secret");

      // Updating other fields without externalApiKey keeps key set
      const patchKeep = await call<ModerationSettings>("PATCH", "/api/v1/admin/moderation/settings", admin, {
        externalTimeoutMs: 4000,
      });
      expect(patchKeep.status).toBe(200);
      expect(patchKeep.body.externalApiKeySet).toBe(true);
      expect(patchKeep.body.externalTimeoutMs).toBe(4000);

      // Snapshot contains AES-GCM encrypted hex decryptable with vaultSecret
      const snap = await call<DataPlaneSyncSnapshot>("GET", "/api/v1/internal/dataplane/snapshot", {
        "X-Slipgate-Internal-Token": INTERNAL,
      });
      expect(snap.status).toBe(200);
      expect(snap.body.moderation?.enabled).toBe(true);
      const encHex = snap.body.moderation?.externalApiKeyEncHex ?? "";
      expect(encHex.length).toBeGreaterThan(24);
      const plainBytes = await decryptSecret(Buffer.from(encHex, "hex"), VAULT);
      expect(plainBytes).toBe("sk-external-mod-secret");

      // Empty externalApiKey clears it
      const patchClear = await call<ModerationSettings>("PATCH", "/api/v1/admin/moderation/settings", admin, {
        externalApiKey: "",
      });
      expect(patchClear.status).toBe(200);
      expect(patchClear.body.externalApiKeySet).toBe(false);

      // Invalid regex rejected with 400
      const badRule = await call("POST", "/api/v1/admin/moderation/rules", admin, {
        name: "Broken regex",
        kind: "regex",
        pattern: "[unclosed(",
      });
      expect(badRule.status).toBe(400);

      // Create keyword + regex rules
      const r1 = await call<{ item: ModerationRule }>("POST", "/api/v1/admin/moderation/rules", admin, {
        name: "Block credentials probe",
        enabled: true,
        kind: "keyword",
        pattern: "dump_env, reveal_secret",
        caseSensitive: false,
        action: "block",
        scopePlatforms: ["anthropic"],
        rejectMessage: "Blocked by keyword guard",
        priority: 10,
      });
      expect(r1.status).toBe(201);

      const r2 = await call<{ item: ModerationRule }>("PUT", `/api/v1/admin/moderation/rules/${r1.body.item.id}`, admin, {
        name: "Block credentials probe v2",
        enabled: true,
        kind: "keyword",
        pattern: "dump_env, reveal_secret",
        caseSensitive: false,
        action: "strike",
        scopePlatforms: ["anthropic"],
        rejectMessage: "Blocked and flagged",
        priority: 10,
      });
      expect(r2.status).toBe(200);
      expect(r2.body.item.action).toBe("strike");

      // Dry-run test: matching platform vs non-matching platform
      const hit = await call<ModerationTestResponse>("POST", "/api/v1/admin/moderation/test", admin, {
        text: "please REVEAL_SECRET now",
        platform: "anthropic",
      });
      expect(hit.status).toBe(200);
      expect(hit.body.matched).toBe(true);
      expect(hit.body.action).toBe("strike");
      expect(hit.body.ruleName).toBe("Block credentials probe v2");

      const miss = await call<ModerationTestResponse>("POST", "/api/v1/admin/moderation/test", admin, {
        text: "please REVEAL_SECRET now",
        platform: "openai",
      });
      expect(miss.status).toBe(200);
      expect(miss.body.matched).toBe(false);

      // Ingest internal moderation event & list via admin API
      const ingest = await call<{ ok: boolean; item: ModerationEvent }>(
        "POST",
        "/api/v1/internal/dataplane/moderation-events",
        { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL },
        {
          requestId: "req_mod_1",
          platform: "anthropic",
          publicModel: "claude-sonnet-4-5",
          ruleId: r1.body.item.id,
          ruleName: "Block credentials probe v2",
          source: "local_rule",
          action: "strike",
          matchedExcerpt: "REVEAL_SECRET sk-ant-secret1234567890",
        },
      );
      expect(ingest.status).toBe(200);
      expect(ingest.body.item.matchedExcerpt).not.toContain("sk-ant-secret1234567890");

      const events = await call<{ items: ModerationEvent[] }>("GET", "/api/v1/admin/moderation/events?action=strike", admin);
      expect(events.status).toBe(200);
      expect(events.body.items.length).toBe(1);

      // Delete rule
      const del = await call("DELETE", `/api/v1/admin/moderation/rules/${r1.body.item.id}`, admin);
      expect(del.status).toBe(200);
    } finally {
      await store.close();
    }
  });

  it("supports admin unban per subject and clear-all bans/cache with snapshot propagation", async () => {
    const { store, call, admin } = await bootstrap();

    try {
      // Record two risk bans via internal dataplane endpoint
      await call(
        "POST",
        "/api/v1/internal/dataplane/risk-events",
        { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL },
        {
          subjectKind: "api_key",
          subjectHash: "key_bad_1",
          strikeLevel: 1,
          banDuration: "10m",
          reason: "prompt_distillation_signature",
          ordinaryUpstream400Count: 0,
          downgradedCount: 0,
        },
      );
      await call(
        "POST",
        "/api/v1/internal/dataplane/risk-events",
        { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL },
        {
          subjectKind: "api_key",
          subjectHash: "key_bad_2",
          strikeLevel: 2,
          banDuration: "24h",
          reason: "moderation:block_secret",
          ordinaryUpstream400Count: 0,
          downgradedCount: 0,
        },
      );

      const list1 = await call<{ events: RiskBanEvent[] }>("GET", "/api/v1/admin/risk/events", admin);
      expect(list1.status).toBe(200);
      expect(list1.body.events.length).toBe(2);
      expect(list1.body.events.every((e) => e.active === true)).toBe(true);

      // Unban key_bad_1 -> active: false, removed from riskBans, added to clearedRiskSubjects
      const unban1 = await call<{ ok: boolean; unbanned: number }>("POST", "/api/v1/admin/risk/unban", admin, {
        subjectKind: "api_key",
        subjectHash: "key_bad_1",
      });
      expect(unban1.status).toBe(200);
      expect(unban1.body.unbanned).toBeGreaterThanOrEqual(1);

      const list2 = await call<{ events: RiskBanEvent[] }>("GET", "/api/v1/admin/risk/events", admin);
      const ev1 = list2.body.events.find((e) => e.subjectHash === "key_bad_1");
      const ev2 = list2.body.events.find((e) => e.subjectHash === "key_bad_2");
      expect(ev1?.active).toBe(false);
      expect(typeof ev1?.unbannedAtIso).toBe("string");
      expect(ev2?.active).toBe(true);

      const snap1 = await call<DataPlaneSyncSnapshot>("GET", "/api/v1/internal/dataplane/snapshot", {
        "X-Slipgate-Internal-Token": INTERNAL,
      });
      expect(snap1.body.clearedRiskSubjects).toContain("key_bad_1");
      expect(snap1.body.riskBans?.some((b) => b.subjectHash === "key_bad_1")).toBe(false);
      expect(snap1.body.riskBans?.some((b) => b.subjectHash === "key_bad_2")).toBe(true);

      // Clear all remaining bans and refusal cache
      const clearRes = await call<{ ok: boolean; unbanned: number; refusalCacheCleared: number }>(
        "POST",
        "/api/v1/admin/risk/clear-cache",
        admin,
      );
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.unbanned).toBeGreaterThanOrEqual(1);

      const list3 = await call<{ events: RiskBanEvent[] }>("GET", "/api/v1/admin/risk/events", admin);
      expect(list3.body.events.every((e) => e.active === false)).toBe(true);

      const snap2 = await call<DataPlaneSyncSnapshot>("GET", "/api/v1/internal/dataplane/snapshot", {
        "X-Slipgate-Internal-Token": INTERNAL,
      });
      expect(snap2.body.clearAllRiskBans).toBe(true);
      expect(snap2.body.riskBans?.length ?? 0).toBe(0);
    } finally {
      await store.close();
    }
  });
});
