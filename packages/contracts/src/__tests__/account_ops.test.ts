import { describe, expect, it } from "bun:test";
import {
  AccountImportFormatError,
  canonicalCredentialText,
  draftToCreateRequest,
  inspectCredential,
  effectiveAccountStatus,
  normalizeSubscriptionTier,
  parseAccountImportFile,
  parseAccountImportSources,
  parseImportJsonText,
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
    expect(result.formats).toEqual(["sub2api"]);
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
    expect(result.formats).toEqual(["slipgate"]);
    expect(result.drafts[0]).toMatchObject({ groupName: "claude-pool", status: "active", subscriptionTier: "max" });
    expect(result.drafts[1]).toMatchObject({ status: "paused", executionMode: "stealth_http", maxConcurrency: 5 });
    expect(result.skipped).toEqual([{ index: 2, name: "c", reason: "unsupported_platform", detail: "mystery" }]);
  });

  it("detects bare arrays and rejects unknown shapes", () => {
    expect(parseAccountImportFile([{ name: "x", platform: "kimi", type: "apikey", credentials: { api_key: "k" } }]).formats).toEqual([
      "sub2api",
    ]);
    expect(() => parseAccountImportFile({ foo: 1 })).toThrow(AccountImportFormatError);
    expect(() => parseAccountImportFile({ accounts: [{ name: "x" }] })).toThrow(AccountImportFormatError);
  });
});

describe("CLIProxyAPI (CPA) auth files", () => {
  const b64url = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const codexIdToken = [
    b64url({ alg: "RS256" }),
    b64url({ email: "c@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "plus" } }),
    "sig",
  ].join(".");

  const claude = {
    type: "claude",
    email: "a@example.com",
    access_token: "sk-ant-oat01-a",
    refresh_token: "sk-ant-ort01-a",
    id_token: "",
    expired: "2026-11-22T13:00:00+08:00",
    last_refresh: "2026-11-22T12:00:00+08:00",
    disabled: false,
    proxy_url: "socks5://127.0.0.1:1080",
  };
  const codex = { type: "codex", access_token: "eyJ.a.b", refresh_token: "rt", id_token: codexIdToken, expired: "2026-11-30T00:00:00Z" };
  const gemini = {
    type: "gemini",
    email: "g@example.com",
    project_id: "proj-1",
    auto: false,
    checked: true,
    token: { access_token: "ya29.g", refresh_token: "1//g", client_id: "cid", expiry: "2026-11-22T13:00:00Z", token_type: "Bearer" },
  };
  const antigravity = {
    type: "antigravity",
    email: "ag@example.com",
    access_token: "ya29.ag",
    refresh_token: "1//ag",
    project_id: "ag-proj",
    expires_in: 3599,
    timestamp: 1763812800000,
    disabled: true,
  };
  const qwen = { type: "qwen", email: "q@example.com", access_token: "q", refresh_token: "qr", resource_url: "portal.qwen.ai" };

  it("reads a single auth file and names the account after the file", () => {
    const result = parseAccountImportSources([{ name: "claude-a@example.com.json", value: claude }]);
    expect(result.formats).toEqual(["cpa"]);
    expect(result.drafts).toHaveLength(1);
    const [draft] = result.drafts;
    expect(draft).toMatchObject({
      origin: "cpa",
      name: "claude-a@example.com",
      notes: "",
      platform: "anthropic",
      authKind: "oauth",
      executionMode: "stealth_http",
      subscriptionTier: "standard",
      status: "active",
      // The token expiry is not the subscription's end: never auto-pause on it.
      expiresAtIso: null,
      sourceLabel: "cpa/claude",
    });
    const secret = JSON.parse(draft!.credentialSecret);
    expect(secret).toMatchObject({ access_token: "sk-ant-oat01-a", refresh_token: "sk-ant-ort01-a", email: "a@example.com" });
    // CPA routing metadata stays out of the stored credential.
    expect(secret).not.toHaveProperty("type");
    expect(secret).not.toHaveProperty("disabled");
    expect(secret).not.toHaveProperty("proxy_url");
    expect(draftToCreateRequest(draft!, "grp_x").success).toBe(true);
  });

  it("maps every supported provider from a multi-file auth directory", () => {
    const result = parseAccountImportSources(
      [
        { name: "claude-a@example.com.json", value: claude },
        { name: "codex-3f2a9b.json", value: codex },
        { name: "g@example.com-proj-1.json", value: gemini },
        { name: "antigravity-ag@example.com.json", value: antigravity },
        { name: "qwen-q@example.com.json", value: qwen },
        { name: "iflow-i@example.com.json", value: { type: "iflow", api_key: "sk-iflow", access_token: "x" } },
        { name: "claude-empty.json", value: { type: "claude", access_token: "", refresh_token: "" } },
        { name: "config.json", value: { port: 8317 } },
        { name: "broken.json", value: undefined },
      ],
      { subscriptionMode: "vm_slot" },
    );
    expect(result.formats).toEqual(["cpa"]);
    expect(result.drafts.map((d) => [d.name, d.platform])).toEqual([
      ["claude-a@example.com", "anthropic"],
      ["codex-3f2a9b", "codex"],
      ["g@example.com-proj-1", "gemini"],
      ["antigravity-ag@example.com", "antigravity"],
      ["qwen-q@example.com", "qwen"],
    ]);
    expect(result.drafts.every((d) => d.executionMode === "vm_slot" && d.authKind === "oauth")).toBe(true);

    const [, codexDraft, geminiDraft, agDraft, qwenDraft] = result.drafts;
    // Account id and plan come from the id_token when the file does not carry them.
    expect(codexDraft!.subscriptionTier).toBe("plus");
    // The email comes from the id_token too and lands in notes when the name lacks it.
    expect(codexDraft!.notes).toBe("c@example.com");
    expect(JSON.parse(codexDraft!.credentialSecret)).toMatchObject({ account_id: "acct-123", access_token: "eyJ.a.b" });
    // The nested Gemini CLI token is flattened so the data plane can read it.
    const geminiSecret = JSON.parse(geminiDraft!.credentialSecret);
    expect(geminiSecret).toMatchObject({ access_token: "ya29.g", refresh_token: "1//g", project_id: "proj-1", client_id: "cid" });
    expect(geminiSecret).not.toHaveProperty("token");
    expect(agDraft).toMatchObject({ status: "paused" });
    expect(JSON.parse(qwenDraft!.credentialSecret)).toMatchObject({ base_url: "https://portal.qwen.ai/v1" });

    // A rejected file counts as one entry, so indexes stay aligned with the file list.
    expect(result.skipped).toEqual([
      { index: 5, name: "iflow-i@example.com", reason: "unsupported_platform", detail: "iflow" },
      { index: 6, name: "claude-empty", reason: "missing_credentials", detail: "" },
      { index: 7, name: "config.json", reason: "unrecognized_file", detail: "no_accounts" },
      { index: 8, name: "broken.json", reason: "unrecognized_file", detail: "not_json" },
    ]);
    for (const draft of result.drafts) {
      expect(draftToCreateRequest(draft, "grp_x").success).toBe(true);
    }
  });

  it("accepts pasted auth objects back to back and arrays of them", () => {
    const pasted = parseImportJsonText(`${JSON.stringify(claude, null, 2)}\n${JSON.stringify(qwen)}`);
    expect(Array.isArray(pasted)).toBe(true);
    const result = parseAccountImportFile(pasted);
    expect(result.formats).toEqual(["cpa"]);
    // Without file names, CPA's own `<type>-<email>` naming is used.
    expect(result.drafts.map((d) => d.name)).toEqual(["claude-a@example.com", "qwen-q@example.com"]);

    expect(parseImportJsonText("﻿" + JSON.stringify(claude))).toMatchObject({ type: "claude" });
    expect(parseImportJsonText('{"a":1} trailing')).toBeUndefined();
    expect(parseImportJsonText("   ")).toBeUndefined();
  });

  it("merges different formats across files and fails only when nothing is readable", () => {
    const mixed = parseAccountImportSources([
      { name: "claude-a@example.com.json", value: claude },
      { name: "sub2api.json", value: { type: "sub2api-data", accounts: [{ name: "k", platform: "kimi", type: "apikey", credentials: { api_key: "k" } }] } },
    ]);
    expect(mixed.formats).toEqual(["cpa", "sub2api"]);
    expect(mixed.drafts.map((d) => d.origin)).toEqual(["cpa", "sub2api"]);

    let caught: unknown;
    try {
      parseAccountImportSources([{ name: "x.json", value: undefined }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AccountImportFormatError);
    expect((caught as AccountImportFormatError).code).toBe("not_json");
    expect(() =>
      parseAccountImportSources([
        { name: "a.json", value: { port: 1 } },
        { name: "b.json", value: undefined },
      ]),
    ).toThrow(AccountImportFormatError);
  });

  it("never resolves platforms through Object.prototype", () => {
    const result = parseAccountImportFile([{ name: "x", platform: "constructor", type: "toString", credentials: { api_key: "k" } }]);
    expect(result.drafts).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("unsupported_type");
    expect(() => parseAccountImportFile({ type: "constructor", access_token: "x" })).toThrow(AccountImportFormatError);
  });
});

describe("inspectCredential", () => {
  const b64url = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const idToken = ["x", b64url({ email: "c@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-9" } }), "s"].join(".");

  it("recognizes Claude Code, Codex CLI and CPA credentials", () => {
    expect(inspectCredential(JSON.stringify({ claudeAiOauth: { accessToken: "a", subscriptionType: "max" } }))).toMatchObject({
      source: "claude_code",
      platform: "anthropic",
      tierHint: "max",
    });
    expect(inspectCredential(JSON.stringify({ tokens: { access_token: "a", id_token: idToken } }))).toMatchObject({
      source: "codex_cli",
      platform: "codex",
      email: "c@example.com",
      tierHint: "plus",
    });
    const cpa = inspectCredential(JSON.stringify({ type: "codex", access_token: "a", id_token: idToken }));
    expect(cpa).toMatchObject({ source: "cpa", platform: "codex", email: "c@example.com", tierHint: "plus", cpaType: "codex" });
    // CPA files are normalized like the importer: account id lifted out of the id_token.
    expect(JSON.parse(cpa!.credentialSecret)).toMatchObject({ account_id: "acct-9" });
    const gemini = inspectCredential(JSON.stringify({ type: "gemini", email: "g@example.com", token: { access_token: "ya29" } }));
    expect(JSON.parse(gemini!.credentialSecret)).toMatchObject({ access_token: "ya29" });
  });

  it("returns null for plain tokens and keeps unknown JSON as typed", () => {
    expect(inspectCredential("sk-ant-oat01-plain")).toBeNull();
    const raw = '{"access_token":"t","plan_type":"pro_10x"}';
    expect(inspectCredential(raw)).toMatchObject({ source: "json", platform: null, tierHint: "pro_10x", credentialSecret: raw });
  });

  it("forces the standard tier on API keys from Slipgate backups", () => {
    const result = parseAccountImportFile({
      type: "slipgate-accounts",
      accounts: [{ name: "k", platform: "anthropic", authKind: "api_key", subscriptionTier: "max", credentialSecret: "sk-k" }],
    });
    expect(result.drafts[0]?.subscriptionTier).toBe("standard");
  });
});

describe("UpdateAccountRequestSchema lifecycle fields", () => {
  it("accepts ISO instants and explicit nulls, rejects free text", () => {
    expect(UpdateAccountRequestSchema.safeParse({ expiresAtIso: null, cooldownUntilIso: null }).success).toBe(true);
    expect(UpdateAccountRequestSchema.safeParse({ expiresAtIso: "2026-12-01T00:00:00+08:00" }).success).toBe(true);
    expect(UpdateAccountRequestSchema.safeParse({ cooldownUntilIso: "tomorrow" }).success).toBe(false);
  });
});
