import { z } from "zod";
import { UsageSeriesPointSchema, UsageTotalsSchema } from "./dashboard.ts";
import {
  AccountStatusSchema,
  allowedSubscriptionTiersForProvider,
  CreateAccountRequestSchema,
  ExecutionModeSchema,
  ProviderSchema,
  SubscriptionTierSchema,
  AccountAuthKindSchema,
  type AccountAuthKind,
  type AccountInitialStatus,
  type ExecutionMode,
  type Provider,
  type SubscriptionTier,
} from "./pool.ts";

const Count = z.number().int().nonnegative();
const NanoUsd = z.string().regex(/^\d+$/);

/* -------------------------------------------------------------------------- */
/* Per-account usage                                                          */
/* -------------------------------------------------------------------------- */

/** Usage of one account since the start of the viewer's local day. */
export const AccountUsageSummaryItemSchema = z.object({
  accountId: z.string(),
  requests: Count,
  errors: Count,
  inputTokens: Count,
  outputTokens: Count,
  costNanoUsd: NanoUsd,
});
export type AccountUsageSummaryItem = z.infer<typeof AccountUsageSummaryItemSchema>;

/** `GET /api/v1/admin/accounts/usage-today?tz=` — accounts without traffic are omitted. */
export const AccountUsageSummaryResponseSchema = z.object({
  generatedAtIso: z.string(),
  sinceIso: z.string(),
  items: z.array(AccountUsageSummaryItemSchema),
});
export type AccountUsageSummaryResponse = z.infer<typeof AccountUsageSummaryResponseSchema>;

export const AccountStatsRangeSchema = z.enum(["24h", "7d", "30d"]);
export type AccountStatsRange = z.infer<typeof AccountStatsRangeSchema>;

/** `GET /api/v1/admin/accounts/:id/stats?range=&tz=` — one account's traffic over a window. */
export const AccountUsageStatsSchema = z.object({
  generatedAtIso: z.string(),
  accountId: z.string(),
  range: AccountStatsRangeSchema,
  granularity: z.enum(["hour", "day"]),
  /** True when the window held more rows than the aggregation reads; totals are then a lower bound. */
  truncated: z.boolean(),
  today: UsageTotalsSchema,
  period: UsageTotalsSchema,
  /** Buckets with at least one request. */
  activeBuckets: Count,
  /** Busiest bucket by requests; `null` without traffic. */
  peak: z.object({ startIso: z.string(), requests: Count, costNanoUsd: NanoUsd }).nullable(),
  series: z.array(UsageSeriesPointSchema),
  models: z.array(z.object({ model: z.string(), requests: Count, tokens: Count, costNanoUsd: NanoUsd })),
  /** Upstream error responses grouped by HTTP status, most frequent first. */
  errorCodes: z.array(z.object({ statusCode: z.number().int(), count: Count })),
});
export type AccountUsageStats = z.infer<typeof AccountUsageStatsSchema>;

/* -------------------------------------------------------------------------- */
/* Import / export                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v1/admin/accounts/import`. Items are validated one by one with
 * `CreateAccountRequestSchema` so a malformed row fails alone instead of the batch.
 */
export const AccountImportRequestSchema = z.object({
  accounts: z.array(z.unknown()).min(1).max(1000),
  /** Skip items whose credential is already stored (or repeated earlier in the batch). */
  skipExisting: z.boolean().default(true),
});
export type AccountImportRequest = z.infer<typeof AccountImportRequestSchema>;

export const AccountImportOutcomeSchema = z.enum(["created", "skipped", "failed"]);
export type AccountImportOutcome = z.infer<typeof AccountImportOutcomeSchema>;

export const AccountImportResultSchema = z.object({
  created: Count,
  skipped: Count,
  failed: Count,
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      name: z.string(),
      outcome: AccountImportOutcomeSchema,
      accountId: z.string().optional(),
      /** For skipped duplicates: the account that already holds the credential. */
      duplicateOf: z.string().optional(),
      /** For skipped duplicates: the earlier item of the same request with this credential. */
      duplicateOfIndex: z.number().int().nonnegative().optional(),
      message: z.string().optional(),
    }),
  ),
});
export type AccountImportResult = z.infer<typeof AccountImportResultSchema>;

/** Exporting plaintext credentials requires the admin to re-enter their password (and 2FA code when enabled). */
export const AccountExportRequestSchema = z.object({
  /** Omit to export every account. */
  accountIds: z.array(z.string().min(1)).min(1).max(5000).optional(),
  password: z.string().min(1).max(256),
  totpCode: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code").optional(),
});
export type AccountExportRequest = z.infer<typeof AccountExportRequestSchema>;

export const SLIPGATE_ACCOUNT_EXPORT_TYPE = "slipgate-accounts";

export const AccountExportItemSchema = z.object({
  name: z.string(),
  notes: z.string(),
  groupName: z.string(),
  platform: ProviderSchema,
  executionMode: ExecutionModeSchema,
  authKind: AccountAuthKindSchema,
  subscriptionTier: SubscriptionTierSchema,
  maxConcurrency: z.number().int(),
  priority: z.number().int(),
  status: AccountStatusSchema,
  expiresAtIso: z.string().nullable(),
  autoPauseOnExpired: z.boolean(),
  credentialSecret: z.string(),
});
export type AccountExportItem = z.infer<typeof AccountExportItemSchema>;

export const AccountExportFileSchema = z.object({
  type: z.literal(SLIPGATE_ACCOUNT_EXPORT_TYPE),
  version: z.literal(1),
  exportedAtIso: z.string(),
  accounts: z.array(AccountExportItemSchema),
  /** Accounts whose credential could not be decrypted with the current vault key. */
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
});
export type AccountExportFile = z.infer<typeof AccountExportFileSchema>;

/* -------------------------------------------------------------------------- */
/* Credential helpers                                                         */
/* -------------------------------------------------------------------------- */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Stable text for duplicate detection: JSON credentials are re-serialized with sorted
 * keys and no whitespace, anything else is trimmed.
 */
export function canonicalCredentialText(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(canonicalize(JSON.parse(trimmed)));
    } catch {
      // Not JSON after all; fall through to the trimmed text.
    }
  }
  return trimmed;
}

/**
 * Upstream plan / rate-limit tier strings → Slipgate tier (mirror of the Go data plane's
 * `NormalizeSubscriptionTier`, plus bare `pro` / `plus` / `max` words). `null` when unknown.
 */
export function normalizeSubscriptionTier(raw: string | null | undefined): SubscriptionTier | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const direct = SubscriptionTierSchema.safeParse(s);
  if (direct.success) return direct.data;
  switch (s) {
    case "default_claude_max_20x":
    case "claude_max_20x":
    case "max_20x":
    case "20x":
    case "claude_ultra":
      return "ultra";
    case "default_claude_max_5x":
    case "claude_max_5x":
    case "max_5x":
    case "claude_max":
      return "max";
    case "5x":
    case "codex_pro_5x":
    case "pro5x":
    case "pro-5x":
      return "pro_5x";
    case "10x":
    case "codex_pro_10x":
    case "pro10x":
    case "pro-10x":
      return "pro_10x";
    case "25x":
    case "codex_pro_25x":
    case "pro25x":
    case "pro-25x":
      return "pro_25x";
  }
  if (s.includes("20x") || s.includes("ultra")) return "ultra";
  if (s.includes("25x")) return "pro_25x";
  if (s.includes("10x")) return "pro_10x";
  if (s.includes("claude") && s.includes("5x")) return "max";
  if (s.includes("5x")) return "pro_5x";
  const words = s.split(/[^a-z0-9]+/);
  if (words.includes("max")) return "max";
  if (words.includes("plus")) return "plus";
  if (words.includes("pro")) return "pro";
  if (words.includes("free") || words.includes("standard")) return "standard";
  return null;
}

/** A tier the platform accepts: the normalized hint when allowed, else `standard`. */
export function resolveTierForPlatform(platform: Provider, hint: string | null | undefined): SubscriptionTier {
  const normalized = normalizeSubscriptionTier(hint);
  const allowed = allowedSubscriptionTiersForProvider(platform);
  if (normalized && allowed.some((o) => o.tier === normalized)) return normalized;
  return "standard";
}

/* -------------------------------------------------------------------------- */
/* Import file parsing (Slipgate backups, sub2api / linksyncx data exports,    */
/* and CLIProxyAPI auth files)                                                */
/* -------------------------------------------------------------------------- */

/** `cpa` = CLIProxyAPI auth files (one JSON object per account, `type` names the provider). */
export type AccountImportFormat = "slipgate" | "sub2api" | "cpa";

/** One account ready to be sent to the import endpoint once a target group is chosen. */
export interface AccountImportDraft {
  /** Which kind of file the account came from (not sent to the server). */
  origin: AccountImportFormat;
  name: string;
  notes: string;
  platform: Provider;
  executionMode: ExecutionMode;
  authKind: AccountAuthKind;
  subscriptionTier: SubscriptionTier;
  credentialSecret: string;
  maxConcurrency: number;
  priority: number;
  status: AccountInitialStatus;
  expiresAtIso: string | null;
  autoPauseOnExpired: boolean;
  /** Group name from a Slipgate backup, used to land the account in a same-named group. */
  groupName: string | null;
  /** Source platform / type when they differ from Slipgate's (shown in the preview). */
  sourceLabel: string;
}

export type AccountImportSkipReason =
  | "unsupported_platform"
  | "unsupported_type"
  | "missing_credentials"
  | "invalid"
  /** A whole file of a multi-file import that is not JSON or not an account file. */
  | "unrecognized_file";

export interface AccountImportSkip {
  /** Position among all entries of the import (a rejected file counts as one entry). */
  index: number;
  name: string;
  reason: AccountImportSkipReason;
  detail: string;
}

export interface AccountImportParseResult {
  /** Distinct formats found, in file order (several only for a multi-file import). */
  formats: AccountImportFormat[];
  drafts: AccountImportDraft[];
  skipped: AccountImportSkip[];
}

/** One uploaded file (or the pasted text) after JSON parsing. */
export interface AccountImportSource {
  /** File name, used to name CPA accounts and to label rejected files; `""` for pasted text. */
  name: string;
  /** Parsed JSON, or `undefined` when the text is not JSON (see `parseImportJsonText`). */
  value: unknown;
}

/** Why a whole document could not be read (stable, for translated messages). */
export type AccountImportFormatErrorCode = "not_json" | "no_accounts" | "unrecognized";

const FORMAT_ERROR_MESSAGES: Record<AccountImportFormatErrorCode, string> = {
  not_json: "not valid JSON",
  no_accounts: "no accounts array found",
  unrecognized: "unrecognized account format",
};

export class AccountImportFormatError extends Error {
  readonly code: AccountImportFormatErrorCode;
  constructor(code: AccountImportFormatErrorCode) {
    super(FORMAT_ERROR_MESSAGES[code]);
    this.name = "AccountImportFormatError";
    this.code = code;
  }
}

export interface AccountImportParseOptions {
  /** Access mode for OAuth / setup-token accounts from sub2api exports and CPA auth files. */
  subscriptionMode?: ExecutionMode;
  /** Access mode for API-key / upstream accounts from sub2api exports. */
  apiKeyMode?: ExecutionMode;
}

const SUB2API_PLATFORMS: Record<string, Provider | ((type: string) => Provider)> = {
  anthropic: "anthropic",
  claude: "anthropic",
  // sub2api keeps ChatGPT/Codex OAuth and OpenAI API keys on one platform.
  openai: (type) => (type === "oauth" ? "codex" : "openai"),
  codex: "codex",
  gemini: "gemini",
  antigravity: "antigravity",
  grok: "grok",
  kimi: "kimi",
  moonshot: "kimi",
  zhipu: "glm",
  glm: "glm",
  deepseek: "deepseek",
  minimax: "minimax",
  qwen: "qwen",
  bedrock: "bedrock",
  aws: "bedrock",
  vertex: "vertex",
  "vertex-ai": "vertex",
  opencode_go: "opencode_go",
  "opencode-go": "opencode_go",
  opencode: "opencode_go",
  typesafe: "typesafe",
  command_code: "command_code",
  "command-code": "command_code",
  cline: "cline",
};

const SUB2API_TYPES: Record<string, AccountAuthKind> = {
  oauth: "oauth",
  "setup-token": "setup_token",
  setup_token: "setup_token",
  apikey: "api_key",
  api_key: "api_key",
  upstream: "api_key",
};

/** Credential fields sub2api uses for plan / tier hints, in preference order. */
const TIER_HINT_KEYS = [
  "subscription_tier",
  "subscriptionTier",
  "plan_type",
  "planType",
  "subscription_type",
  "subscriptionType",
  "rate_limit_tier",
  "rateLimitTier",
  "tier",
  "tier_id",
  "account_tier",
];

/** Own-property lookup, so names like `constructor` never resolve to Object.prototype members. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function unixSecondsToIso(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // Millisecond timestamps are 13 digits; seconds are 10.
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function tierHint(credentials: Record<string, unknown>): string {
  for (const key of TIER_HINT_KEYS) {
    const v = str(credentials[key]);
    if (v) return v;
  }
  return "";
}

function hasCredentialMaterial(credentials: Record<string, unknown>): boolean {
  return Object.values(credentials).some((v) => (typeof v === "string" ? v.trim().length > 0 : v != null));
}

function clipName(name: string, fallback: string): string {
  const trimmed = name.trim() || fallback;
  return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
}

function parseSub2apiAccount(
  item: unknown,
  index: number,
  opts: Required<AccountImportParseOptions>,
): AccountImportDraft | AccountImportSkip {
  const rec = asRecord(item);
  const fallbackName = `account-${index + 1}`;
  if (!rec) return { index, name: fallbackName, reason: "invalid", detail: "not an object" };
  const name = clipName(str(rec.name), fallbackName);
  const sourcePlatform = str(rec.platform).toLowerCase();
  const sourceType = str(rec.type).toLowerCase();

  const authKind = own(SUB2API_TYPES, sourceType);
  if (!authKind) {
    return { index, name, reason: "unsupported_type", detail: sourceType || "-" };
  }
  const platformRule = own(SUB2API_PLATFORMS, sourcePlatform);
  if (!platformRule) {
    return { index, name, reason: "unsupported_platform", detail: sourcePlatform || "-" };
  }
  const platform = typeof platformRule === "function" ? platformRule(sourceType) : platformRule;

  const credentials = asRecord(rec.credentials);
  if (!credentials || !hasCredentialMaterial(credentials)) {
    return { index, name, reason: "missing_credentials", detail: "" };
  }

  const isKey = authKind === "api_key";
  return {
    origin: "sub2api",
    name,
    notes: str(rec.notes).slice(0, 500),
    platform,
    executionMode: isKey ? opts.apiKeyMode : opts.subscriptionMode,
    authKind,
    subscriptionTier: isKey ? "standard" : resolveTierForPlatform(platform, tierHint(credentials)),
    credentialSecret: JSON.stringify(credentials),
    maxConcurrency: clampInt(rec.concurrency, 1, 64, 5),
    priority: clampInt(rec.priority, 0, 10000, 100),
    status: "active",
    expiresAtIso: unixSecondsToIso(rec.expires_at),
    autoPauseOnExpired: typeof rec.auto_pause_on_expired === "boolean" ? rec.auto_pause_on_expired : true,
    groupName: null,
    sourceLabel: `${sourcePlatform}/${sourceType}`,
  };
}

function parseSlipgateAccount(item: unknown, index: number): AccountImportDraft | AccountImportSkip {
  const rec = asRecord(item);
  const fallbackName = `account-${index + 1}`;
  if (!rec) return { index, name: fallbackName, reason: "invalid", detail: "not an object" };
  const name = clipName(str(rec.name), fallbackName);
  const platform = ProviderSchema.safeParse(rec.platform);
  if (!platform.success) {
    return { index, name, reason: "unsupported_platform", detail: str(rec.platform) || "-" };
  }
  const authKind = AccountAuthKindSchema.safeParse(rec.authKind);
  if (!authKind.success) {
    return { index, name, reason: "unsupported_type", detail: str(rec.authKind) || "-" };
  }
  const credentialSecret = str(rec.credentialSecret);
  if (!credentialSecret) return { index, name, reason: "missing_credentials", detail: "" };
  const mode = ExecutionModeSchema.safeParse(rec.executionMode);
  const status = AccountStatusSchema.safeParse(rec.status);
  return {
    origin: "slipgate",
    name,
    notes: str(rec.notes).slice(0, 500),
    platform: platform.data,
    executionMode: mode.success ? mode.data : "stealth_http",
    authKind: authKind.data,
    // API keys carry no plan; a stray tier would only skew the scheduler weight.
    subscriptionTier: authKind.data === "api_key" ? "standard" : resolveTierForPlatform(platform.data, str(rec.subscriptionTier)),
    credentialSecret,
    maxConcurrency: clampInt(rec.maxConcurrency, 1, 64, 5),
    priority: clampInt(rec.priority, 0, 10000, 100),
    // Runtime states do not survive a move: cooldown resumes, a manual "expired" stays off.
    status: status.success && (status.data === "paused" || status.data === "expired") ? "paused" : "active",
    expiresAtIso: unixSecondsToIso(rec.expiresAtIso),
    autoPauseOnExpired: typeof rec.autoPauseOnExpired === "boolean" ? rec.autoPauseOnExpired : true,
    groupName: str(rec.groupName) || null,
    sourceLabel: "",
  };
}

/* -------------------------------------------------------------------------- */
/* CLIProxyAPI (CPA) auth files                                               */
/* -------------------------------------------------------------------------- */

/** CPA auth-file `type` → Slipgate platform. Every CPA auth file is an OAuth login. */
const CPA_PLATFORMS: Record<string, Provider> = {
  claude: "anthropic",
  codex: "codex",
  gemini: "gemini",
  "gemini-cli": "gemini",
  antigravity: "antigravity",
  qwen: "qwen",
  kimi: "kimi",
  vertex: "vertex",
};

/** CPA providers without a Slipgate counterpart: reported as unsupported instead of guessed. */
const CPA_UNSUPPORTED_TYPES = new Set(["iflow", "aistudio"]);

/** CPA routing metadata kept out of the stored credential (Slipgate has its own fields for these). */
const CPA_METADATA_KEYS = new Set(["type", "disabled", "prefix", "proxy_url", "priority", "label"]);

const CPA_TOKEN_KEYS = ["access_token", "refresh_token", "id_token", "api_key", "token"];

/** Namespaced claim in ChatGPT id_tokens holding the account id and plan. */
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

/** A CLIProxyAPI auth object: a known provider `type`, without a sub2api / Slipgate wrapper. */
function isCpaAuthRecord(rec: Record<string, unknown> | null): boolean {
  if (!rec || "credentials" in rec || "credentialSecret" in rec || "platform" in rec) return false;
  const type = str(rec.type).toLowerCase();
  return own(CPA_PLATFORMS, type) !== undefined || CPA_UNSUPPORTED_TYPES.has(type);
}

/** Payload of a JWT, or `null` when it is not one. The signature is not checked: hints only. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** `claude-a@b.com.json` → `claude-a@b.com`; `""` for pasted text. */
function fileStem(fileName: string): string {
  return fileName
    .replace(/^.*[\\/]/, "")
    .replace(/\.json$/i, "")
    .trim();
}

/**
 * The stored credential: the auth file minus CPA routing metadata. Gemini CLI logins nest the
 * OAuth token (`token: {access_token, refresh_token, expiry, ...}`) while the data plane reads
 * flat fields, so the nested fields are lifted up without overwriting top-level ones.
 */
function cpaCredentials(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (!CPA_METADATA_KEYS.has(key)) out[key] = value;
  }
  const nested = asRecord(rec.token);
  if (nested) {
    delete out.token;
    for (const [key, value] of Object.entries(nested)) {
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}

/** Qwen OAuth answers on `https://<resource_url>/v1` (the same rule qwen-code applies). */
function qwenBaseUrl(resourceUrl: string): string {
  const host = resourceUrl.trim().replace(/\/+$/, "");
  if (!host) return "";
  const withScheme = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return withScheme.endsWith("/v1") ? withScheme : `${withScheme}/v1`;
}

function parseCpaAuth(
  item: unknown,
  index: number,
  nameHint: string,
  opts: Required<AccountImportParseOptions>,
): AccountImportDraft | AccountImportSkip {
  const rec = asRecord(item);
  if (!rec) return { index, name: nameHint || `account-${index + 1}`, reason: "invalid", detail: "not an object" };
  const type = str(rec.type).toLowerCase();
  const credentials = cpaCredentials(rec);
  const idToken = str(credentials.id_token);
  const idClaims = idToken ? decodeJwtPayload(idToken) : null;
  const email = str(credentials.email) || str(idClaims?.email);
  // CPA names files `<type>-<email>.json`; mirror that when the object came without a file.
  const name = clipName(nameHint || (email ? `${type}-${email}` : ""), `${type || "account"}-${index + 1}`);

  const platform = own(CPA_PLATFORMS, type);
  if (!platform) return { index, name, reason: "unsupported_platform", detail: type || "-" };
  if (!CPA_TOKEN_KEYS.some((key) => str(credentials[key]))) {
    return { index, name, reason: "missing_credentials", detail: "" };
  }

  let hint = tierHint(credentials);
  if (platform === "codex") {
    const auth = asRecord(idClaims?.[CODEX_AUTH_CLAIM]);
    const accountId = str(auth?.chatgpt_account_id);
    // The data plane needs the ChatGPT account id; some CPA files only carry it in the id_token.
    if (accountId && !str(credentials.account_id)) credentials.account_id = accountId;
    hint ||= str(auth?.chatgpt_plan_type) || (/-(plus|pro|team|free)$/i.exec(nameHint)?.[1] ?? "");
  }
  if (platform === "qwen" && !str(credentials.base_url)) {
    const baseUrl = qwenBaseUrl(str(credentials.resource_url));
    if (baseUrl) credentials.base_url = baseUrl;
  }

  return {
    origin: "cpa",
    name,
    notes: email && !name.includes(email) ? email.slice(0, 500) : "",
    platform,
    executionMode: opts.subscriptionMode,
    authKind: "oauth",
    subscriptionTier: resolveTierForPlatform(platform, hint),
    credentialSecret: JSON.stringify(credentials),
    maxConcurrency: 5,
    priority: 100,
    status: rec.disabled === true ? "paused" : "active",
    // CPA's `expired` is the access token's expiry (refreshed hourly), not the end of the
    // subscription; mapping it would auto-pause every account within the hour.
    expiresAtIso: null,
    autoPauseOnExpired: true,
    groupName: null,
    sourceLabel: `cpa/${type}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Single credential inspection (add-account form)                            */
/* -------------------------------------------------------------------------- */

export type CredentialSource = "cpa" | "claude_code" | "codex_cli" | "json";

export interface CredentialInsight {
  source: CredentialSource;
  /** Platform the credential belongs to, when the shape tells. */
  platform: Provider | null;
  email: string;
  /** Raw plan / tier string found in the credential (resolve with `resolveTierForPlatform`). */
  tierHint: string;
  /** Text to store: CPA auth files are normalized exactly like the importer does. */
  credentialSecret: string;
  /** CPA `type` (e.g. `claude`), for naming the account like CPA does. */
  cpaType: string;
}

/**
 * Read what a pasted OAuth credential says about itself: `.claude/.credentials.json`,
 * `.codex/auth.json`, a CLIProxyAPI auth file, or any flat token JSON. `null` for non-JSON
 * text (plain keys and tokens are stored as typed).
 */
export function inspectCredential(text: string): CredentialInsight | null {
  const value = parseImportJsonText(text);
  const rec = asRecord(value);
  if (!rec) return null;

  if (isCpaAuthRecord(rec)) {
    const type = str(rec.type).toLowerCase();
    const parsed = parseCpaAuth(rec, 0, "", resolveParseOptions({}));
    if ("reason" in parsed) {
      return { source: "cpa", platform: null, email: str(rec.email), tierHint: "", credentialSecret: text.trim(), cpaType: type };
    }
    const secret = asRecord(JSON.parse(parsed.credentialSecret)) ?? {};
    return {
      source: "cpa",
      platform: parsed.platform,
      email: str(secret.email) || str(decodeJwtPayload(str(secret.id_token))?.email),
      tierHint: parsed.subscriptionTier === "standard" ? "" : parsed.subscriptionTier,
      credentialSecret: parsed.credentialSecret,
      cpaType: type,
    };
  }

  const claude = asRecord(rec.claudeAiOauth);
  if (claude) {
    return {
      source: "claude_code",
      platform: "anthropic",
      email: str(rec.email),
      tierHint: str(claude.rateLimitTier) || str(claude.subscriptionType),
      credentialSecret: text.trim(),
      cpaType: "",
    };
  }

  const tokens = asRecord(rec.tokens);
  if (tokens) {
    const claims = decodeJwtPayload(str(tokens.id_token));
    const auth = asRecord(claims?.[CODEX_AUTH_CLAIM]);
    return {
      source: "codex_cli",
      platform: "codex",
      email: str(claims?.email),
      tierHint: str(tokens.plan_type) || str(auth?.chatgpt_plan_type),
      credentialSecret: text.trim(),
      cpaType: "",
    };
  }

  return { source: "json", platform: null, email: str(rec.email), tierHint: tierHint(rec), credentialSecret: text.trim(), cpaType: "" };
}

/* -------------------------------------------------------------------------- */
/* Format detection                                                           */
/* -------------------------------------------------------------------------- */

interface ParsedDocument {
  format: AccountImportFormat;
  drafts: AccountImportDraft[];
  skipped: AccountImportSkip[];
  /** Entries read from the document, for offsetting indexes across files. */
  entries: number;
}

function resolveParseOptions(options: AccountImportParseOptions): Required<AccountImportParseOptions> {
  return {
    subscriptionMode: options.subscriptionMode ?? "stealth_http",
    apiKeyMode: options.apiKeyMode ?? "direct_api",
  };
}

function parseDocument(raw: unknown, opts: Required<AccountImportParseOptions>, sourceName: string): ParsedDocument {
  const root = asRecord(raw);
  let items: unknown[];
  let format: AccountImportFormat;
  let nameHint = "";
  if (isCpaAuthRecord(root)) {
    // One CPA auth file holds exactly one account; its file name is the account's name.
    items = [root];
    format = "cpa";
    nameHint = fileStem(sourceName);
  } else {
    const list = Array.isArray(raw) ? raw : Array.isArray(root?.accounts) ? (root!.accounts as unknown[]) : null;
    if (!list) throw new AccountImportFormatError(root ? "no_accounts" : "unrecognized");
    items = list;
    const declared = str(root?.type).toLowerCase();
    if (declared === SLIPGATE_ACCOUNT_EXPORT_TYPE) {
      format = "slipgate";
    } else if (declared.startsWith("sub2api")) {
      format = "sub2api";
    } else {
      const first = asRecord(items.find((item) => asRecord(item)));
      if (first && "credentialSecret" in first) format = "slipgate";
      else if (first && "credentials" in first) format = "sub2api";
      else if (isCpaAuthRecord(first)) format = "cpa";
      else throw new AccountImportFormatError("unrecognized");
    }
  }

  const drafts: AccountImportDraft[] = [];
  const skipped: AccountImportSkip[] = [];
  items.forEach((item, index) => {
    const parsed =
      format === "slipgate"
        ? parseSlipgateAccount(item, index)
        : format === "sub2api"
          ? parseSub2apiAccount(item, index, opts)
          : parseCpaAuth(item, index, nameHint, opts);
    if ("reason" in parsed) skipped.push(parsed);
    else drafts.push(parsed);
  });
  return { format, drafts, skipped, entries: items.length };
}

/**
 * Parse one account document: a Slipgate backup (`type: "slipgate-accounts"`), a sub2api /
 * linksyncx data export (`type: "sub2api-data"` or the legacy bundle), a CLIProxyAPI auth
 * file, or a bare array of any of those account objects.
 */
export function parseAccountImportFile(raw: unknown, options: AccountImportParseOptions = {}): AccountImportParseResult {
  const doc = parseDocument(raw, resolveParseOptions(options), "");
  return { formats: [doc.format], drafts: doc.drafts, skipped: doc.skipped };
}

/**
 * Parse every file of an import (or the pasted text as a single source). A lone source that
 * cannot be read throws; in a multi-file import an unreadable file becomes an
 * `unrecognized_file` skip, so a CPA auth directory with a stray config file still imports.
 * Throws when no source holds accounts at all.
 */
export function parseAccountImportSources(
  sources: readonly AccountImportSource[],
  options: AccountImportParseOptions = {},
): AccountImportParseResult {
  const opts = resolveParseOptions(options);
  const formats: AccountImportFormat[] = [];
  const drafts: AccountImportDraft[] = [];
  const skipped: AccountImportSkip[] = [];
  let offset = 0;
  let firstError: AccountImportFormatError | null = null;
  for (const source of sources) {
    let doc: ParsedDocument;
    try {
      if (source.value === undefined) throw new AccountImportFormatError("not_json");
      doc = parseDocument(source.value, opts, source.name);
    } catch (err) {
      if (!(err instanceof AccountImportFormatError) || sources.length === 1) throw err;
      firstError ??= err;
      skipped.push({ index: offset, name: source.name || `#${offset + 1}`, reason: "unrecognized_file", detail: err.code });
      offset += 1;
      continue;
    }
    if (!formats.includes(doc.format)) formats.push(doc.format);
    drafts.push(...doc.drafts);
    for (const skip of doc.skipped) skipped.push({ ...skip, index: skip.index + offset });
    offset += doc.entries;
  }
  if (!formats.length) throw firstError ?? new AccountImportFormatError("no_accounts");
  return { formats, drafts, skipped };
}

/**
 * JSON for the import dialog: one document, or several concatenated objects (`{..}{..}` or
 * JSON lines, which is how CPA auth files look when pasted together) as an array.
 * `undefined` when the text is not JSON. A leading UTF-8 BOM is trimmed like whitespace.
 */
export function parseImportJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Possibly several objects back to back.
  }
  if (!trimmed.startsWith("{")) return undefined;
  const chunks = splitJsonObjects(trimmed);
  if (!chunks || chunks.length < 2) return undefined;
  try {
    return chunks.map((chunk) => JSON.parse(chunk) as unknown);
  } catch {
    return undefined;
  }
}

export interface CredentialBlock {
  credentials: string[];
  /** The block looked like JSON but did not parse; nothing should be created from it. */
  invalidJson: boolean;
}

/** Split concatenated top-level JSON objects (`{..}{..}`, JSON lines, pretty-printed or not). */
function splitJsonObjects(text: string): string[] | null {
  const chunks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 0) return null;
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) chunks.push(text.slice(start, i + 1));
    } else if (depth === 0 && !/[\s,]/.test(ch)) {
      return null;
    }
  }
  return depth === 0 && !inString ? chunks : null;
}

const JSONISH_LINE = /^[{}[\]"]/;

/**
 * Turn a pasted block into one credential per entry. Accepts a JSON array, one or more JSON
 * objects (pretty-printed objects stay whole), or plain credentials one per line (`#` lines
 * are comments). A block that looks like JSON but does not parse is flagged instead of being
 * cut into nonsense "credentials".
 */
export function parseCredentialBlock(text: string): CredentialBlock {
  const trimmed = text.trim();
  if (!trimmed) return { credentials: [], invalidJson: false };

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) return { credentials: [], invalidJson: true };
      const credentials = parsed
        .map((v) => (typeof v === "string" ? v.trim() : v && typeof v === "object" ? JSON.stringify(v) : ""))
        .filter((v) => v.length > 0);
      return { credentials, invalidJson: false };
    } catch {
      return { credentials: [], invalidJson: true };
    }
  }

  if (trimmed.startsWith("{")) {
    const chunks = splitJsonObjects(trimmed);
    if (!chunks) return { credentials: [], invalidJson: true };
    try {
      return { credentials: chunks.map((c) => JSON.stringify(JSON.parse(c))), invalidJson: false };
    } catch {
      return { credentials: [], invalidJson: true };
    }
  }

  const credentials: string[] = [];
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (JSONISH_LINE.test(line)) {
      // A JSON object on its own line is fine; a fragment of a multi-line object is not.
      try {
        JSON.parse(line);
      } catch {
        return { credentials: [], invalidJson: true };
      }
    }
    credentials.push(line);
  }
  return { credentials, invalidJson: false };
}

/** Validate a draft + target group the same way the import endpoint will. */
export function draftToCreateRequest(draft: AccountImportDraft, groupId: string) {
  return CreateAccountRequestSchema.safeParse({
    name: draft.name,
    notes: draft.notes,
    groupId,
    platform: draft.platform,
    executionMode: draft.executionMode,
    authKind: draft.authKind,
    subscriptionTier: draft.subscriptionTier,
    credentialSecret: draft.credentialSecret,
    maxConcurrency: draft.maxConcurrency,
    priority: draft.priority,
    status: draft.status,
    expiresAtIso: draft.expiresAtIso,
    autoPauseOnExpired: draft.autoPauseOnExpired,
  });
}
