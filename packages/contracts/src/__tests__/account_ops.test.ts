import { describe, expect, it } from "bun:test";
import {
  AccountImportFormatError,
  canonicalCredentialText,
  draftToCreateRequest,
  effectiveAccountStatus,
  normalizeSubscriptionTier,
  parseAccountImportFile,
  resolveTierForPlatform,
  parseCredentialBlock,
  UpdateAccountRequestSchema,
} from "../index.ts";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const PAST = "2026-11-22T11:00:00Z";
const FUTURE = "2026-11-22T13:00:00Z";

describe("effectiveAccountStatus", () => {
  const base = { status: "active" as const, expiresAtIso: null, autoPauseOnExpired: true, cooldownUntilIso: null };

  it("lets admin pauses win and applies expiry only with auto-pause", () => {
    expect(effectiveAccountStatus(base, NOW)).toBe("active");
    expect(effectiveAccountStatus({ ...base, status: "paused", expiresAtIso: PAST }, NOW)).toBe("paused");
    expect(effectiveAccountStatus({ ...base, expiresAtIso: PAST }, NOW)).toBe("expired");
    expect(effectiveAccountStatus({ ...base, expiresAtIso: PAST, autoPauseOnExpired: false }, NOW)).toBe("active");
    expect(effectiveAccountStatus({ ...base, expiresAtIso: FUTURE }, NOW)).toBe("active");
    expect(effectiveAccountStatus({ ...base, status: "expired" }, NOW)).toBe("expired");
  });

  it("treats the cooldown deadline as the source of truth", () => {
    expect(effectiveAccountStatus({ ...base, cooldownUntilIso: FUTURE }, NOW)).toBe("cooldown");
    expect(effectiveAccountStatus({ ...base, status: "cooldown", cooldownUntilIso: FUTURE }, NOW)).toBe("cooldown");
    expect(effectiveAccountStatus({ ...base, status: "cooldown", cooldownUntilIso: PAST }, NOW)).toBe("active");
    expect(effectiveAccountStatus({ ...base, status: "cooldown" }, NOW)).toBe("cooldown");
    // Expiry outranks a cooldown.
    expect(effectiveAccountStatus({ ...base, cooldownUntilIso: FUTURE, expiresAtIso: PAST }, NOW)).toBe("expired");
  });
});

describe("subscription tier hints", () => {
  it("normalizes upstream plan strings like the data plane", () => {
    expect(normalizeSubscriptionTier("default_claude_max_20x")).toBe("ultra");
    expect(normalizeSubscriptionTier("claude_max_5x")).toBe("max");
    expect(normalizeSubscriptionTier("Pro-10x")).toBe("pro_10x");
    expect(normalizeSubscriptionTier("chatgpt plus")).toBe("plus");
    expect(normalizeSubscriptionTier("g1-pro-tier")).toBe("pro");
    expect(normalizeSubscriptionTier("")).toBeNull();
    expect(normalizeSubscriptionTier("enterprise")).toBeNull();
  });

  it("falls back to standard when the platform does not offer the tier", () => {
    expect(resolveTierForPlatform("anthropic", "max_5x")).toBe("max");
    expect(resolveTierForPlatform("codex", "max_5x")).toBe("standard");
    expect(resolveTierForPlatform("codex", "plus")).toBe("plus");
    expect(resolveTierForPlatform("deepseek", null)).toBe("standard");
  });
});

describe("credential helpers", () => {
  it("canonicalizes JSON credentials independent of key order and whitespace", () => {
    const a = canonicalCredentialText('{"b":1,"a":{"y":2,"x":3}}');
    const b = canonicalCredentialText(' {\n "a": {"x": 3, "y": 2}, "b": 1 }\n');
    expect(a).toBe(b);
    expect(canonicalCredentialText("  sk-abc  ")).toBe("sk-abc");
    expect(canonicalCredentialText("{not json")).toBe("{not json");
  });

  it("splits pasted credentials by line or JSON array", () => {
    expect(parseCredentialBlock("sk-1\n\n  sk-2  \n# comment\r\nsk-3")).toEqual({
      credentials: ["sk-1", "sk-2", "sk-3"],
      invalidJson: false,
    });
    expect(parseCredentialBlock('[{"api_key":"a"}, "sk-b", ""]').credentials).toEqual(['{"api_key":"a"}', "sk-b"]);
    expect(parseCredentialBlock("   ")).toEqual({ credentials: [], invalidJson: false });
  });

  it("keeps pretty-printed JSON objects whole and flags fragments", () => {
    const authJson = JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", account_id: "x" } }, null, 2);
    expect(parseCredentialBlock(authJson)).toEqual({
      credentials: ['{"tokens":{"access_token":"a","refresh_token":"r","account_id":"x"}}'],
      invalidJson: false,
    });
    // Back-to-back objects, pretty-printed or one per line, with braces inside strings.
    const two = `${JSON.stringify({ api_key: "k{1}" }, null, 2)}\n${JSON.stringify({ api_key: "k2" })}`;
    expect(parseCredentialBlock(two).credentials).toEqual(['{"api_key":"k{1}"}', '{"api_key":"k2"}']);
    expect(parseCredentialBlock('sk-plain\n{"api_key":"k3"}').credentials).toEqual(["sk-plain", '{"api_key":"k3"}']);

    expect(parseCredentialBlock('{"api_key": "unterminated').invalidJson).toBe(true);
    expect(parseCredentialBlock("[1, 2").invalidJson).toBe(true);
    // A plain key followed by a multi-line object: the fragments must not become credentials.
    expect(parseCredentialBlock('sk-plain\n{\n  "api_key": "k"\n}')).toEqual({ credentials: [], invalidJson: true });
  });
});

describe("parseAccountImportFile", () => {
  const sub2apiExport = {
    type: "sub2api-data",
    version: 1,
    exported_at: "2026-11-20T00:00:00Z",
    proxies: [],
    accounts: [
      {
        name: "claude-max",
        notes: "main",
        platform: "anthropic",
        type: "oauth",
        credentials: { access_token: "sk-ant-oat01-x", refresh_token: "sk-ant-ort01-y", subscription_type: "claude_max_20x" },
        concurrency: 8,
        priority: 1,
        expires_at: 1798761600,
        auto_pause_on_expired: false,
      },
      {
        name: "codex-pro",
        platform: "openai",
        type: "oauth",
        credentials: { access_token: "eyJ", refresh_token: "rt", chatgpt_account_id: "acct", plan_type: "pro_10x" },
        concurrency: 999,
        priority: -5,
      },
      { name: "openai-key", platform: "openai", type: "apikey", credentials: { api_key: "sk-proj", base_url: "https://api.openai.com" } },
      { name: "glm", platform: "zhipu", type: "upstream", credentials: { api_key: "glm-key", base_url: "https://open.bigmodel.cn" } },
      { name: "setup", platform: "anthropic", type: "setup-token", credentials: { access_token: "sk-ant-oat01-setup" } },
      { name: "bedrock", platform: "anthropic", type: "bedrock", credentials: { access_key_id: "AKIA" } },
      { name: "pplx", platform: "perplexity", type: "apikey", credentials: { api_key: "pplx" } },
      { name: "empty", platform: "openai", type: "apikey", credentials: { api_key: "" } },
      "garbage",
    ],
  };

  it("maps sub2api / linksyncx exports onto Slipgate accounts", () => {
    const result = parseAccountImportFile(sub2apiExport);
    expect(result.format).toBe("sub2api");
    expect(result.drafts.map((d) => d.name)).toEqual(["claude-max", "codex-pro", "openai-key", "glm", "setup"]);

    const [claude, codex, key, glm, setup] = result.drafts;
    expect(claude).toMatchObject({
      platform: "anthropic",
      authKind: "oauth",
      executionMode: "stealth_http",
      subscriptionTier: "ultra",
      maxConcurrency: 8,
      priority: 1,
      notes: "main",
      expiresAtIso: "2027-01-01T00:00:00.000Z",
      autoPauseOnExpired: false,
      status: "active",
      sourceLabel: "anthropic/oauth",
    });
    expect(JSON.parse(claude!.credentialSecret)).toMatchObject({ access_token: "sk-ant-oat01-x" });
    // sub2api keeps ChatGPT OAuth under "openai"; Slipgate calls it Codex. Out-of-range numbers clamp.
    expect(codex).toMatchObject({ platform: "codex", subscriptionTier: "pro_10x", maxConcurrency: 64, priority: 0 });
    expect(key).toMatchObject({ platform: "openai", authKind: "api_key", executionMode: "direct_api", subscriptionTier: "standard" });
    expect(glm).toMatchObject({ platform: "glm", authKind: "api_key" });
    expect(setup).toMatchObject({ authKind: "setup_token", subscriptionTier: "standard" });

    expect(result.skipped.map((s) => [s.name, s.reason])).toEqual([
      ["bedrock", "unsupported_type"],
      ["pplx", "unsupported_platform"],
      ["empty", "missing_credentials"],
      ["account-9", "invalid"],
    ]);

    for (const draft of result.drafts) {
      expect(draftToCreateRequest(draft, "grp_x").success).toBe(true);
    }
  });

  it("honours access-mode overrides for sub2api accounts", () => {
    const result = parseAccountImportFile(sub2apiExport, { subscriptionMode: "vm_slot", apiKeyMode: "stealth_http" });
    expect(result.drafts[0]?.executionMode).toBe("vm_slot");
    expect(result.drafts[2]?.executionMode).toBe("stealth_http");
  });

  it("reads Slipgate backups and normalizes runtime states", () => {
    const result = parseAccountImportFile({
      type: "slipgate-accounts",
      version: 1,
      exportedAtIso: "2026-11-22T00:00:00Z",
      accounts: [
        {
          name: "a",
          notes: "",
          groupName: "claude-pool",
          platform: "anthropic",
          executionMode: "stealth_http",
          authKind: "oauth",
          subscriptionTier: "max",
          maxConcurrency: 12,
          priority: 10,
          status: "cooldown",
          expiresAtIso: null,
          autoPauseOnExpired: true,
          credentialSecret: "{}",
        },
        { name: "b", platform: "openai", authKind: "api_key", status: "expired", credentialSecret: "sk-b" },
        { name: "c", platform: "mystery", authKind: "api_key", credentialSecret: "sk-c" },
      ],
    });
    expect(result.format).toBe("slipgate");
    expect(result.drafts[0]).toMatchObject({ groupName: "claude-pool", status: "active", subscriptionTier: "max" });
    expect(result.drafts[1]).toMatchObject({ status: "paused", executionMode: "stealth_http", maxConcurrency: 5 });
    expect(result.skipped).toEqual([{ index: 2, name: "c", reason: "unsupported_platform", detail: "mystery" }]);
  });

  it("detects bare arrays and rejects unknown shapes", () => {
    expect(parseAccountImportFile([{ name: "x", platform: "kimi", type: "apikey", credentials: { api_key: "k" } }]).format).toBe(
      "sub2api",
    );
    expect(() => parseAccountImportFile({ foo: 1 })).toThrow(AccountImportFormatError);
    expect(() => parseAccountImportFile({ accounts: [{ name: "x" }] })).toThrow(AccountImportFormatError);
  });
});

describe("UpdateAccountRequestSchema lifecycle fields", () => {
  it("accepts ISO instants and explicit nulls, rejects free text", () => {
    expect(UpdateAccountRequestSchema.safeParse({ expiresAtIso: null, cooldownUntilIso: null }).success).toBe(true);
    expect(UpdateAccountRequestSchema.safeParse({ expiresAtIso: "2026-12-01T00:00:00+08:00" }).success).toBe(true);
    expect(UpdateAccountRequestSchema.safeParse({ cooldownUntilIso: "tomorrow" }).success).toBe(false);
  });
});
