import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  AdminAdjustBalanceRequestSchema,
  AdminBatchUserStatusRequestSchema,
  AdminCreateUserRequestSchema,
  AdminTotpResetRequestSchema,
  AdminUpdateUserRequestSchema,
  AdminUserListQuerySchema,
  AffiliateTransferRequestSchema,
  AffiliateWithdrawRequestSchema,
  AssignSubscriptionRequestSchema,
  AuditClearRequestSchema,
  AuditClearResponseSchema,
  AuditLogQuerySchema,
  auditRetentionShortens,
  BindUserEmailRequestSchema,
  BulkSubscriptionActionRequestSchema,
  ChangePasswordRequestSchema,
  PasswordChangedResponseSchema,
  TotpCodeRequestSchema,
  TotpDisableRequestSchema,
  TotpSetupRequestSchema,
  CreatePromoCodeRequestSchema,
  DashboardRangeSchema,
  GenerateRedeemCodesRequestSchema,
  KeyUsageLookupRequestSchema,
  parseUsdToNano,
  PortalSettingsSchema,
  RedeemCodeListQuerySchema,
  RedeemRequestSchema,
  toPublicSettings,
  isReservedEmail,
  portalSettingsIssues,
  type PublicCaptcha,
  UpdatePortalSettingsRequestSchema,
  UpdateProfileRequestSchema,
  UpdatePromoCodeRequestSchema,
  UpdateRedeemCodesRequestSchema,
  UpdateSubscriptionRequestSchema,
  UpsertAnnouncementRequestSchema,
  USAGE_DEFAULT_WINDOW_DAYS,
  USAGE_EXPORT_MAX_ROWS,
  USAGE_QUERY_MAX_PAGED_ROWS,
  OpsRangeSchema,
  UsageQuerySchema,
  UserSubscriptionListQuerySchema,
  type KeyUsageLookupResponse,
  type ModelPricingRule,
  type OpsOverview,
  type OpsRange,
  type UserDashboardStats,
  type UserSubscriptionItem,
} from "@slipgate/contracts";
import {
  buildOpsOverview,
  buildChannelStatus,
  buildModelPlaza,
  cached,
  KeyedCache,
  channelStatusQuery,
  opsUsageQuery,
  redactAuditBody,
  toCsv,
  usageCsv,
  WindowLimiter,
  nanoToUsdString,
} from "../insights.ts";
import {
  finalizeScopedUsage,
  scopedUsagePlan,
  UsageAggregateTimeoutError,
  type ScopedUsage,
  type ScopedUsageQuery,
} from "../store/usage_aggregates.ts";
import type { AuthEnv, SessionManager } from "../middleware/auth.ts";
import { clientAddress, clientIp } from "../security/client_ip.ts";
import { decryptSecret, encryptSecret, hashPassword } from "../security/crypto.ts";
import { totpStepUp } from "../security/step_up.ts";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../security/totp.ts";
import { generateRedeemCodeText, randomCode } from "../store/ops_shared.ts";
import { StoreError, type ControlStore } from "../store/types.ts";
import { requireTargetingGroups } from "./announcements.ts";
import { digestEmailCode, renderEmail, type MailService } from "./mail.ts";
import { applyUserCaps, decorateAdminUsers, prepareUserLimitFields } from "./user_limits.ts";

export interface OpsRouteContext {
  store: ControlStore;
  /** Encrypts two-factor secrets at rest. */
  vaultSecret: string;
  /** Whether outgoing mail is configured (public settings flags). */
  mailReady: () => Promise<boolean>;
  /** Optional mail service accessor for self-service verification flows (e.g. bind-email). */
  mailService?: () => MailService;
  /** Admin model price rules (model plaza shows them instead of built-in rates). */
  pricingRules: () => Promise<ModelPricingRule[]>;
  /** SWR-discovered upstream model IDs per provider from slipgate-net. */
  discoveredModels?: () => Promise<Record<string, readonly string[]>>;
  /** Pushes a fresh (entitlement-filtered) snapshot to the data plane; never throws. */
  syncDataPlane: () => Promise<void>;
  /** Console sessions: re-issued on password change, invalidated after user edits, password-attempt limits. */
  sessions: SessionManager;
  /** The captcha widget parameters for public settings (auth_guards.ts; its config has secrets, so it lives apart). */
  publicCaptcha?: () => Promise<PublicCaptcha>;
}

type App = Hono<AuthEnv>;

function bad(issues: z.ZodIssue[]): never {
  const message = issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
  throw new StoreError("bad_request", message || "Invalid request");
}

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) bad(parsed.error.issues);
  return parsed.data;
}

function query<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) bad(parsed.error.issues);
  return parsed.data;
}

function usd(text: string): bigint {
  try {
    return parseUsdToNano(text);
  } catch {
    throw new StoreError("bad_request", `Invalid USD amount: ${text}`);
  }
}

function tzOffset(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(n) ? Math.max(-14 * 60, Math.min(14 * 60, n)) : 0;
}

function csvResponse(c: Context, filename: string, csv: string) {
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

/** A scope's dashboard / key-lookup figures are reused this long per (scope, range, time zone). */
export const SCOPED_USAGE_TTL_MS = 30_000;
/** Fresh scoped aggregates one user or one key may start per minute; cached views are free. */
export const SCOPED_USAGE_LOADS_PER_MINUTE = 6;

function tooManyUsageLoads(c: Context) {
  c.header("Retry-After", "60");
  return c.json({ error: "too_many_requests", message: "Usage figures were requested too often, try again in a minute" }, 429);
}

/** 503 for a scoped aggregate past its statement timeout; anything else propagates. */
function usageTimedOut(c: Context, err: unknown) {
  if (!(err instanceof UsageAggregateTimeoutError)) throw err;
  c.header("Retry-After", "60");
  return c.json({ error: "usage_timeout", message: "Usage figures for this range took too long to compute; try a shorter range" }, 503);
}

/**
 * Self-service usage browsing: no start means the USAGE_DEFAULT_WINDOW_DAYS before the end (the
 * summary aggregates every matching row and history is never pruned).
 */
function ownUsageWindow<T extends { sinceIso?: string; untilIso?: string }>(q: T): T {
  if (q.sinceIso) return q;
  const untilMs = q.untilIso ? Date.parse(q.untilIso) : Number.NaN;
  const endMs = Number.isFinite(untilMs) ? Math.min(untilMs, Date.now()) : Date.now();
  return { ...q, sinceIso: new Date(endMs - USAGE_DEFAULT_WINDOW_DAYS * 86_400_000).toISOString() };
}

/** Request bytes the audit record keeps at most; a larger body is noted by size only. */
export const AUDIT_BODY_READ_LIMIT = 64 * 1024;

/**
 * The request body for the audit record, reading at most `limit` bytes from a clone (a tee of the
 * stream), whatever Content-Length says or omits (chunked uploads): past the limit the clone is
 * cancelled and only its size is noted. The original stream the route handler reads is untouched.
 */
export async function readAuditBody(req: Request, limit = AUDIT_BODY_READ_LIMIT): Promise<string> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > limit) return JSON.stringify({ omitted: `${declared} bytes` });
  if (!req.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    reader = req.clone().body?.getReader() ?? null;
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Not awaited: cancelling one branch of a tee only settles once the other branch (the
        // handler's) is done too, and the handler has not run yet.
        void reader.cancel().catch(() => undefined);
        reader = null;
        return JSON.stringify({ omitted: `over ${limit} bytes` });
      }
      chunks.push(value);
    }
    reader = null;
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    if (reader) void reader.cancel().catch(() => undefined);
    return "";
  }
}

/** Facts a handler adds to its own audit record (e.g. how many rows a clear removed). */
const auditNotes = new WeakMap<Request, Record<string, unknown>>();

export function noteAudit(c: Context, note: Record<string, unknown>): void {
  auditNotes.set(c.req.raw, { ...(auditNotes.get(c.req.raw) ?? {}), ...note });
}

/** The redacted body with the handler's note under `_outcome` (left as is when not a JSON object). */
function withAuditNote(redacted: string, note: Record<string, unknown> | undefined): string {
  if (!note) return redacted;
  if (!redacted) return JSON.stringify({ _outcome: note });
  try {
    const parsed = JSON.parse(redacted) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return JSON.stringify({ ...parsed, _outcome: note });
  } catch {
    // A cut-off or non-JSON body keeps its text.
  }
  return redacted;
}

/**
 * Records every admin write (POST/PUT/PATCH/DELETE under /api/v1/admin) after it ran, with the
 * route pattern, outcome and a redacted request body. Never fails the request.
 */
export function auditMiddleware(store: ControlStore): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await next();
      return;
    }
    const started = Date.now();
    const bodyText = await readAuditBody(c.req.raw);
    await next();
    try {
      const claims = c.get("authUser");
      if (!claims) return;
      const params = c.req.param() as Record<string, string>;
      await store.ops.recordAudit({
        actorId: claims.sub,
        actorEmail: claims.email,
        actorRole: claims.role,
        method,
        route: c.req.routePath,
        path: c.req.path,
        targetId: Object.values(params)[0] ?? "",
        statusCode: c.res.status,
        ip: clientAddress(c),
        userAgent: (c.req.header("user-agent") ?? "").slice(0, 300),
        durationMs: Date.now() - started,
        requestBody: withAuditNote(redactAuditBody(bodyText), auditNotes.get(c.req.raw)),
      });
    } catch (err) {
      console.warn(`[slipgate-bff] audit write failed: ${err instanceof Error ? err.message : err}`);
    }
  };
}

/** Public, user and admin routes for the operations & commerce features. */
export function registerOpsRoutes(app: App, ctx: OpsRouteContext): void {
  const { store, syncDataPlane, vaultSecret, sessions } = ctx;
  // Destructive audit-log actions ask for a fresh code; 2FA enable/disable share its attempt limiter.
  const stepUp = totpStepUp(store, vaultSecret);
  const totpLimiter = stepUp.limiter;
  const ops = store.ops;
  const redeemLimiter = new WindowLimiter(10, 10 * 60_000);
  const publicLimiter = new WindowLimiter(30, 60_000);

  const plaza = cached(60_000, async () =>
    buildModelPlaza(
      await store.listGroups(true),
      await store.listCompositeRoutes(),
      await store.listAccounts(),
      Date.now(),
      await ctx.pricingRules(),
      new Set(),
      await (ctx.discoveredModels?.() ?? Promise.resolve({})),
    ),
  );
  const status = cached(30_000, async () => {
    const nowMs = Date.now();
    const groups = await store.listGroups(true);
    // Exact 24h figures aggregated in the store, read only for the groups the page lists.
    const [accounts, usage] = await Promise.all([store.listAccounts(), ops.channelStatusUsage(channelStatusQuery(groups, nowMs))]);
    return buildChannelStatus(groups, accounts, usage, nowMs);
  });
  /** Overview per range, shared by concurrently polling admin tabs for a few seconds. */
  const opsOverview = Object.fromEntries(
    OpsRangeSchema.options.map((range) => [
      range,
      cached(10_000, async () => {
        const nowMs = Date.now();
        const [usage, accounts] = await Promise.all([ops.opsUsage(opsUsageQuery(range, nowMs)), store.listAccounts()]);
        return buildOpsOverview({ range, nowMs, usage, accounts });
      }),
    ]),
  ) as Record<OpsRange, () => Promise<OpsOverview>>;

  /*
   * Scoped usage (a user's dashboard, a key's public lookup) is exact over its window, so it costs
   * as much as the scope's traffic. Views of one (scope, range, time zone) within the TTL share
   * one aggregate (concurrent ones a single load), and each user or key may start only a few
   * fresh ones a minute, however many tabs, ranges or time zones it cycles through.
   */
  // A value is a few KB (≤ 30 series points, 12 models, 20 keys / rows); a full cache only costs loads.
  const dashboardUsage = new KeyedCache<{ nowMs: number; scoped: ScopedUsage }>(SCOPED_USAGE_TTL_MS, 5_000);
  const keyUsage = new KeyedCache<{ scoped: ScopedUsage; recent: KeyUsageLookupResponse["recent"] }>(SCOPED_USAGE_TTL_MS, 2_000);
  const scopedUsageLoads = new WindowLimiter(SCOPED_USAGE_LOADS_PER_MINUTE, 60_000);

  /** The cached value for `key`, else a load if `scope` has loads left this minute; null if not. */
  function budgetedUsage<T>(cache: KeyedCache<T>, scope: string, key: string, load: () => Promise<T>): Promise<T> | null {
    const known = cache.peek(key);
    if (known) return known;
    if (!scopedUsageLoads.allow(scope)) return null;
    return cache.get(key, load);
  }

  async function requireSettingsFlag(flag: "modelPlazaEnabled" | "statusPageEnabled" | "keyUsageLookupEnabled") {
    const settings = await ops.getSettings();
    if (!settings[flag]) throw new StoreError("not_found", "This page is disabled");
  }

  /* ======================================================================================== */
  /* Public                                                                                   */
  /* ======================================================================================== */

  app.get("/api/v1/public/settings", async (c) => {
    const [settings, setup, payment, mail, captcha] = await Promise.all([
      ops.getSettings(),
      store.getSetupStatus(),
      store.payments.getConfigBlob(),
      ctx.mailReady(),
      ctx.publicCaptcha?.(),
    ]);
    c.header("Cache-Control", "no-cache");
    return c.json(toPublicSettings(settings, setup.initialized, payment?.enabled === true, mail, { captcha }));
  });

  app.get("/api/v1/public/home", async (c) => {
    const settings = await ops.getSettings();
    return c.json({ homeContent: settings.homeContent });
  });

  app.get("/api/v1/public/promo/:code", async (c) => {
    if (!publicLimiter.allow(`promo:${clientIp(c)}`)) throw new StoreError("forbidden", "Too many attempts, slow down");
    const settings = await ops.getSettings();
    if (!settings.promoCodeEnabled) return c.json({ valid: false, bonusNanoUsd: "0", reason: "disabled" });
    return c.json(await ops.checkPromoCode(c.req.param("code")));
  });

  app.get("/api/v1/public/models", async (c) => {
    await requireSettingsFlag("modelPlazaEnabled");
    c.header("Cache-Control", "public, max-age=30");
    return c.json(await plaza());
  });

  app.get("/api/v1/public/status", async (c) => {
    await requireSettingsFlag("statusPageEnabled");
    c.header("Cache-Control", "public, max-age=15");
    return c.json(await status());
  });

  app.post("/api/v1/public/key-usage", async (c) => {
    await requireSettingsFlag("keyUsageLookupEnabled");
    if (!publicLimiter.allow(`key:${clientIp(c)}`)) throw new StoreError("forbidden", "Too many lookups, slow down");
    const { apiKey } = await body(c, KeyUsageLookupRequestSchema);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey)));
    // One unique-index probe: an unknown key costs a single lookup, never a snapshot export.
    const key = await ops.findApiKeyByHash(digest);
    if (!key) throw new StoreError("not_found", "No API key matches");
    const tz = tzOffset(c.req.query("tz"));
    // Figures are cached per (key, time zone) and budgeted per key: a heavy key looked up from
    // many addresses still costs a few 30-day aggregates a minute.
    const pending = budgetedUsage(keyUsage, `key:${key.id}`, `${key.id}|${tz}`, async () => {
      const q: ScopedUsageQuery = { apiKeyId: key.id, range: "30d", nowMs: Date.now(), tzOffsetMinutes: tz };
      const sinceIso = new Date(scopedUsagePlan(q).periodStartMs).toISOString();
      // One connection at a time: the aggregate, then the 20 newest rows (an index-ordered LIMIT).
      const usage = await ops.scopedUsage(q);
      const rows = await ops.queryUsage({ apiKeyId: key.id, sinceIso, page: 1, pageSize: 20, summary: false });
      return {
        scoped: finalizeScopedUsage(q, usage),
        recent: rows.items.map((r) => ({
          createdAtIso: r.createdAtIso,
          model: r.publicModel,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costNanoUsd: r.costNanoUsd,
          statusCode: r.statusCode,
          durationMs: r.durationMs,
        })),
      };
    });
    if (!pending) return tooManyUsageLoads(c);
    let figures;
    try {
      figures = await pending;
    } catch (err) {
      return usageTimedOut(c, err);
    }
    const { scoped, recent } = figures;
    const wallet = await store.getWallet(key.userId);
    const response: KeyUsageLookupResponse = {
      keyName: key.name,
      keyPrefix: key.keyPrefix,
      enabled: key.enabled,
      expiresAtIso: key.expiresAtIso,
      groupName: key.groupName || key.groupId,
      billing: key.billing,
      balanceNanoUsd: wallet.balanceNanoUsd,
      today: scoped.today,
      last30d: scoped.period,
      series: scoped.series,
      models: scoped.models,
      recent,
    };
    c.header("Cache-Control", "no-store");
    return c.json(response);
  });

  /* ======================================================================================== */
  /* Self-service (requireAuth is mounted on /api/v1/user/* by createBffApp)                   */
  /* ======================================================================================== */

  app.patch("/api/v1/user/profile", async (c) => {
    const { username, avatarUrl } = await body(c, UpdateProfileRequestSchema);
    const user = await ops.updateOwnProfile(c.get("authUser").sub, username, avatarUrl);
    return c.json({ user });
  });

  app.post("/api/v1/user/profile/bind-email/code", async (c) => {
    const userId = c.get("authUser").sub;
    const req = await body(c, z.object({ email: z.string().trim().email().max(254) }));
    const mail = ctx.mailService?.();
    if (!mail || !(await mail.ready())) {
      throw new StoreError("bad_request", "Outgoing mail is not configured");
    }
    const current = await store.getUserById(userId);
    if (!current) throw new StoreError("not_found", "User no longer exists");
    if (!current.email.toLowerCase().endsWith("@users.noreply.slipgate")) {
      throw new StoreError("conflict", "Only placeholder OAuth accounts can bind a new email address");
    }
    if (isReservedEmail(req.email)) {
      return c.json({ error: "email_reserved", message: "This email domain is reserved and can't be used" }, 400);
    }
    if (await store.findUserByEmail(req.email)) {
      throw new StoreError("conflict", "Email is already registered");
    }
    const last = await ops.lastEmailCodeAt(req.email, "bind_email");
    if (last && Date.now() - Date.parse(last) < 60_000) {
      throw new StoreError("conflict", "A code was just sent; wait a minute before asking again");
    }
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
    await ops.saveEmailCode(
      req.email,
      "bind_email",
      await digestEmailCode(req.email, code),
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    const site = await mail.siteName();
    const zh = (c.req.header("accept-language") ?? "").toLowerCase().startsWith("zh");
    await mail.deliver({
      to: req.email,
      subject: zh ? `${site} 绑定邮箱验证码：${code}` : `${site} email binding code: ${code}`,
      html: renderEmail(
        site,
        zh ? "绑定邮箱验证" : "Verify email binding",
        [zh ? "请在个人资料页面输入以下验证码，10 分钟内有效。" : "Enter this code on your profile page. It expires in 10 minutes."],
        undefined,
        code,
      ),
    });
    return c.json({ sent: true, cooldownSeconds: 60 });
  });

  app.post("/api/v1/user/profile/bind-email", async (c) => {
    const userId = c.get("authUser").sub;
    const req = await body(c, BindUserEmailRequestSchema);
    const current = await store.getUserById(userId);
    if (!current) throw new StoreError("not_found", "User no longer exists");
    if (!current.email.toLowerCase().endsWith("@users.noreply.slipgate")) {
      throw new StoreError("conflict", "Only placeholder OAuth accounts can bind a new email address");
    }
    if (isReservedEmail(req.email)) {
      return c.json({ error: "email_reserved", message: "This email domain is reserved and can't be used" }, 400);
    }
    if (await store.findUserByEmail(req.email)) {
      throw new StoreError("conflict", "Email is already registered");
    }
    const settings = await ops.getSettings();
    let verified = false;
    if (settings.emailVerificationRequired && (await ctx.mailReady())) {
      const code = req.emailCode?.trim() ?? "";
      if (!/^\d{6}$/.test(code) || !(await ops.consumeEmailCode(req.email, "bind_email", await digestEmailCode(req.email, code)))) {
        return c.json({ error: "email_code_invalid", message: "The email verification code is invalid or expired" }, 400);
      }
      verified = true;
    } else if (req.emailCode?.trim()) {
      const code = req.emailCode.trim();
      if (/^\d{6}$/.test(code) && (await ops.consumeEmailCode(req.email, "bind_email", await digestEmailCode(req.email, code)))) {
        verified = true;
      }
    }
    const user = await ops.bindPlaceholderEmail(userId, req.email, verified);
    return c.json({ user });
  });

  /**
   * Re-checks the signed-in user's password under the per-user failure limit (reserved before the
   * hash is read, see SessionManager.confirmPassword), so a stolen session cannot be turned into an
   * unlimited password oracle, not even with concurrent requests.
   */
  async function requirePassword(c: Context, userId: string, password: string, message = "Password is incorrect") {
    const check = await sessions.confirmPassword(userId, clientIp(c), password);
    if (check.ok) return;
    if (check.retryAfterSeconds !== null) {
      throw new StoreError("forbidden", `Too many wrong passwords, try again in ${Math.ceil(check.retryAfterSeconds / 60)} min`);
    }
    throw new StoreError("forbidden", message);
  }

  app.post("/api/v1/user/password", async (c) => {
    const req = await body(c, ChangePasswordRequestSchema);
    const userId = c.get("authUser").sub;
    await requirePassword(c, userId, req.currentPassword, "Current password is incorrect");
    // Bumps the token version: every other session (a stolen one included) ends here.
    const version = await ops.setPasswordHash(userId, await hashPassword(req.newPassword));
    sessions.invalidate(userId);
    const user = await store.getUserById(userId);
    if (!user) throw new StoreError("not_found", "User no longer exists");
    // This device carries on with a fresh token at the new version.
    const session = await sessions.issue(user, version);
    return c.json(PasswordChangedResponseSchema.parse({ ok: true, session }));
  });

  /* ---------------- Two-factor authentication ---------------- */

  async function totpSecretOf(userId: string): Promise<{ secret: string | null; enabled: boolean }> {
    const state = await ops.getTotp(userId);
    if (!state?.secretEnc) return { secret: null, enabled: false };
    try {
      return { secret: await decryptSecret(state.secretEnc, vaultSecret), enabled: state.enabled };
    } catch {
      return { secret: null, enabled: state.enabled };
    }
  }

  app.get("/api/v1/user/totp", async (c) => {
    const state = await ops.getTotp(c.get("authUser").sub);
    return c.json({ enabled: Boolean(state?.enabled) });
  });

  app.post("/api/v1/user/totp/setup", async (c) => {
    const claims = c.get("authUser");
    const { password } = await body(c, TotpSetupRequestSchema);
    await requirePassword(c, claims.sub, password);
    if ((await ops.getTotp(claims.sub))?.enabled) throw new StoreError("conflict", "Two-factor authentication is already on");
    const secret = generateTotpSecret();
    await ops.setTotp(claims.sub, await encryptSecret(secret, vaultSecret), false);
    const issuer = (await ops.getSettings()).siteName || "Slipgate";
    return c.json({ secret, otpauthUrl: otpauthUrl(secret, claims.email, issuer) });
  });

  app.post("/api/v1/user/totp/enable", async (c) => {
    const claims = c.get("authUser");
    const { code } = await body(c, TotpCodeRequestSchema);
    if (!totpLimiter.allow(claims.sub)) throw new StoreError("forbidden", "Too many attempts, try again later");
    const { secret, enabled } = await totpSecretOf(claims.sub);
    if (enabled) throw new StoreError("conflict", "Two-factor authentication is already on");
    if (!secret) throw new StoreError("bad_request", "Start the setup first");
    if (!(await verifyTotp(secret, code, claims.sub))) throw new StoreError("bad_request", "The code is not valid");
    await ops.setTotp(claims.sub, (await ops.getTotp(claims.sub))!.secretEnc, true);
    return c.json({ enabled: true });
  });

  app.post("/api/v1/user/totp/disable", async (c) => {
    const claims = c.get("authUser");
    const req = await body(c, TotpDisableRequestSchema);
    if (!totpLimiter.allow(claims.sub)) throw new StoreError("forbidden", "Too many attempts, try again later");
    await requirePassword(c, claims.sub, req.password);
    const { secret, enabled } = await totpSecretOf(claims.sub);
    if (!enabled || !secret) throw new StoreError("conflict", "Two-factor authentication is off");
    if (!(await verifyTotp(secret, req.code, claims.sub))) throw new StoreError("bad_request", "The code is not valid");
    await ops.setTotp(claims.sub, null, false);
    const version = await ops.bumpTokenVersion(claims.sub);
    sessions.invalidate(claims.sub);
    const user = await store.getUserById(claims.sub);
    const session = user && version !== null ? await sessions.issue(user, version) : null;
    return c.json({ enabled: false, ...(session ? { session } : {}) });
  });

  /** Model plaza for the signed-in user: public groups plus exclusive groups they were granted. */
  app.get("/api/v1/user/models", async (c) => {
    const claims = c.get("authUser");
    const granted = claims.role === "admin" ? ("all" as const) : new Set((await ops.getAdminUser(claims.sub))?.allowedGroupIds ?? []);
    return c.json(
      buildModelPlaza(
        await store.listGroups(true),
        await store.listCompositeRoutes(),
        await store.listAccounts(),
        Date.now(),
        await ctx.pricingRules(),
        granted,
        await (ctx.discoveredModels?.() ?? Promise.resolve({})),
      ),
    );
  });

  app.get("/api/v1/user/dashboard", async (c) => {
    const userId = c.get("authUser").sub;
    const range = DashboardRangeSchema.catch("7d").parse(c.req.query("range") ?? "7d");
    const tz = tzOffset(c.req.query("tz"));
    // Usage is grouped in the store (exact, however many rows), cached per (user, range, time
    // zone) and budgeted per user; key names and the active subscription count come from plain
    // lookups, not the spend-window listings.
    const pending = budgetedUsage(dashboardUsage, `user:${userId}`, `${userId}|${range}|${tz}`, async () => {
      const q: ScopedUsageQuery = { userId, range, nowMs: Date.now(), tzOffsetMinutes: tz };
      return { nowMs: q.nowMs, scoped: finalizeScopedUsage(q, await ops.scopedUsage(q)) };
    });
    if (!pending) return tooManyUsageLoads(c);
    let figures;
    try {
      figures = await pending;
    } catch (err) {
      return usageTimedOut(c, err);
    }
    const { nowMs, scoped } = figures;
    // The aggregate holds a connection for its whole scan; the cheap lookups follow it rather
    // than taking more of the pool alongside it.
    const [wallet, keys, user] = await Promise.all([store.getWallet(userId), ops.listApiKeyLabels(userId), ops.getAdminUser(userId)]);
    const keyName = new Map(keys.map((k) => [k.id, k.name]));
    const stats: UserDashboardStats = {
      generatedAtIso: new Date(nowMs).toISOString(),
      range,
      granularity: scoped.granularity,
      truncated: false,
      balanceNanoUsd: wallet.balanceNanoUsd,
      spentNanoUsd: user?.spentNanoUsd ?? "0",
      today: scoped.today,
      period: scoped.period,
      apiKeys: { total: keys.length, enabled: keys.filter((k) => k.enabled).length },
      subscriptions: { active: user?.activeSubscriptionCount ?? 0 },
      series: scoped.series,
      models: scoped.models,
      keys: scoped.keys.map((k) => ({ ...k, name: keyName.get(k.apiKeyId) ?? k.apiKeyId })),
    };
    return c.json(stats);
  });

  app.get("/api/v1/user/usage/query", async (c) => {
    const q = ownUsageWindow(query(c, UsageQuerySchema));
    // OFFSET walks every row it skips: past the first rows, narrow the window or export.
    if (q.page * q.pageSize > USAGE_QUERY_MAX_PAGED_ROWS) {
      throw new StoreError("bad_request", `Only the newest ${USAGE_QUERY_MAX_PAGED_ROWS} matching rows can be paged; narrow the time range or filters`);
    }
    return c.json(await ops.queryUsage({ ...q, userId: c.get("authUser").sub, accountId: undefined }));
  });

  app.get("/api/v1/user/usage/export", async (c) => {
    const q = ownUsageWindow(query(c, UsageQuerySchema));
    const rows = await ops.exportUsage({ ...q, userId: c.get("authUser").sub, accountId: undefined, limit: USAGE_EXPORT_MAX_ROWS });
    // Users never see which upstream account served them.
    const csv = usageCsv(rows.map((r) => ({ ...r, accountId: "", accountName: "", userEmail: "" })));
    return csvResponse(c, `usage-${stamp()}.csv`, csv);
  });

  app.get("/api/v1/user/ledger", async (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
    return c.json({ items: await ops.listLedger(c.get("authUser").sub, Number.isFinite(limit) ? limit : 50) });
  });

  app.post("/api/v1/user/redeem", async (c) => {
    const userId = c.get("authUser").sub;
    if (!redeemLimiter.allow(userId)) {
      throw new StoreError("forbidden", "Too many redeem attempts, try again in a few minutes");
    }
    const { code } = await body(c, RedeemRequestSchema);
    const result = await ops.redeemCode(userId, code);
    await syncDataPlane();
    const wallet = await store.getWallet(userId);
    return c.json({ result, wallet });
  });

  app.get("/api/v1/user/redeem/history", async (c) => {
    return c.json({ items: await ops.listUserRedeemHistory(c.get("authUser").sub, 50) });
  });

  app.get("/api/v1/user/announcements", async (c) => {
    const claims = c.get("authUser");
    return c.json({ items: await ops.listUserAnnouncements(claims.sub, claims.role) });
  });

  app.post("/api/v1/user/announcements/read", async (c) => {
    const claims = c.get("authUser");
    const raw = (await c.req.json().catch(() => ({}))) as { ids?: unknown; all?: unknown };
    const ids = raw.all === true ? "all" : Array.isArray(raw.ids) ? raw.ids.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
    await ops.markAnnouncementsRead(claims.sub, ids, claims.role);
    return c.json({ ok: true });
  });

  app.get("/api/v1/user/subscriptions", async (c) => {
    return c.json({ items: await ops.listUserSubscriptions(c.get("authUser").sub) });
  });

  app.get("/api/v1/user/affiliate", async (c) => {
    const userId = c.get("authUser").sub;
    const settings = await ops.getSettings();
    const inviteCode = await ops.ensureInviteCode(userId);
    // Invitees see each other's addresses only masked.
    const mine = (await ops.listInvitees(userId)).map((u) => ({
      ...u,
      email: u.email.replace(/^(.).*?(@.*)$/, "$1***$2"),
    }));
    const [rebateTotal, rebates, account, withdrawals] = await Promise.all([
      store.payments.rebateTotal(userId),
      store.payments.listRebates(userId, 50),
      store.payments.getAffiliateAccount(userId, settings.affiliateRebateBps),
      store.payments.listAffiliateWithdrawals({ userId, limit: 50 }),
    ]);
    return c.json({
      enabled: settings.affiliateEnabled,
      creditMode: settings.affiliateCreditMode,
      minWithdrawUsd: settings.affiliateMinWithdrawUsd,
      rebateBps: account.effectiveRebateBps,
      globalRebateBps: settings.affiliateRebateBps,
      customRebateBps: account.customRebateBps,
      inviteCode,
      inviteCount: mine.length,
      invitees: mine,
      rebateTotalNanoUsd: rebateTotal.toString(),
      commissionBalanceNanoUsd: account.balanceNanoUsd,
      totalEarnedNanoUsd: account.totalEarnedNanoUsd,
      totalTransferredNanoUsd: account.totalTransferredNanoUsd,
      totalWithdrawnNanoUsd: account.totalWithdrawnNanoUsd,
      withdrawals,
      rebates: rebates.map((r) => ({
        amountNanoUsd: r.amountNanoUsd,
        inviteeEmail: r.inviteeEmail.replace(/^(.).*?(@.*)$/, "$1***$2"),
        creditedTo: r.creditedTo ?? "wallet",
        createdAtIso: r.createdAtIso,
      })),
    });
  });

  app.post("/api/v1/user/affiliate/transfer", async (c) => {
    const userId = c.get("authUser").sub;
    const settings = await ops.getSettings();
    if (!settings.affiliateEnabled) throw new StoreError("forbidden", "Referral program is disabled");
    const req = await body(c, AffiliateTransferRequestSchema);
    const amountNano = usd(req.amountUsd);
    if (amountNano <= 0n) throw new StoreError("bad_request", "Transfer amount must be greater than zero");
    const result = await store.payments.transferAffiliateToWallet(userId, amountNano);
    await syncDataPlane();
    return c.json(result);
  });

  app.post("/api/v1/user/affiliate/withdraw", async (c) => {
    const userId = c.get("authUser").sub;
    const settings = await ops.getSettings();
    if (!settings.affiliateEnabled) throw new StoreError("forbidden", "Referral program is disabled");
    const req = await body(c, AffiliateWithdrawRequestSchema);
    const amountNano = usd(req.amountUsd);
    if (amountNano <= 0n) throw new StoreError("bad_request", "Withdrawal amount must be greater than zero");
    const minNano = parseUsdToNano(settings.affiliateMinWithdrawUsd);
    if (amountNano < minNano) {
      throw new StoreError("bad_request", `Minimum withdrawal amount is $${settings.affiliateMinWithdrawUsd}`);
    }
    const item = await store.payments.requestAffiliateWithdrawal(
      userId,
      amountNano,
      req.payoutMethod,
      req.payoutAccount,
      req.notes,
    );
    return c.json({ item }, 201);
  });

  /* ======================================================================================== */
  /* Admin (requireAdmin + auditMiddleware are mounted on /api/v1/admin/* by createBffApp)     */
  /* ======================================================================================== */

  /* ---------------- Settings ---------------- */

  app.get("/api/v1/admin/settings", async (c) => c.json(await ops.getSettings()));

  app.patch("/api/v1/admin/settings", async (c) => {
    const patch = await body(c, UpdatePortalSettingsRequestSchema);
    let retentionBlocked = false;
    const { previous, saved } = await ops.updateSettings((current) => {
      // Shortening audit retention deletes history: only PUT /audit-logs/retention, with a fresh code.
      if (
        patch.auditLogRetentionDays !== undefined &&
        auditRetentionShortens(current.auditLogRetentionDays, patch.auditLogRetentionDays)
      ) {
        retentionBlocked = true;
        return current;
      }
      const { defaultBalanceUsd, ...rest } = patch;
      const next = PortalSettingsSchema.safeParse({
        ...current,
        ...rest,
        ...(defaultBalanceUsd !== undefined ? { defaultBalanceNanoUsd: usd(defaultBalanceUsd).toString() } : {}),
      });
      if (!next.success) bad(next.error.issues);
      const crossIssues = portalSettingsIssues(next.data);
      if (crossIssues.length > 0) throw new StoreError("bad_request", crossIssues.join("; "));
      return next.data;
    });
    if (retentionBlocked) {
      return c.json(
        {
          error: "retention_step_up",
          message: "auditLogRetentionDays: shortening the audit log retention needs a two-factor code; change it on the audit log page",
        },
        403,
      );
    }
    // Default user caps travel in the data-plane snapshot (userLimits).
    if (saved.defaultUserRpm !== previous.defaultUserRpm || saved.defaultUserConcurrency !== previous.defaultUserConcurrency) {
      await syncDataPlane();
    }
    return c.json(saved);
  });

  /* ---------------- Users ---------------- */

  app.get("/api/v1/admin/users", async (c) => {
    const listed = await ops.listAdminUsers(query(c, AdminUserListQuerySchema));
    const result = { ...listed, items: await decorateAdminUsers(store, listed.items) };
    // `users` keeps older console builds working.
    return c.json({ ...result, users: result.items });
  });

  app.post("/api/v1/admin/users", async (c) => {
    const req = await body(c, AdminCreateUserRequestSchema);
    // Placeholder addresses of provider sign-ups (users.noreply.slipgate) are never handed out.
    if (isReservedEmail(req.email)) return c.json({ error: "email_reserved", message: "This email domain is reserved and can't be used" }, 400);
    if (req.role === "admin") {
      const refused = await stepUp.confirmAdmin(c, sessions, c.get("authUser").sub, req.confirm);
      if (refused) return refused;
    }
    const settings = await ops.getSettings();
    const initial = req.initialBalanceUsd !== undefined ? usd(req.initialBalanceUsd) : BigInt(settings.defaultBalanceNanoUsd);
    const user = await ops.createUser({
      email: req.email,
      username: req.username,
      role: req.role,
      notes: req.notes,
      allowedGroupIds: req.allowedGroupIds,
      passwordHash: await hashPassword(req.password),
      initialBalanceNano: initial,
    });
    await applyUserCaps(store, user.id, req);
    await syncDataPlane();
    return c.json({ user: (await decorateAdminUsers(store, [user]))[0] }, 201);
  });

  app.post("/api/v1/admin/users/batch-status", async (c) => {
    const req = await body(c, AdminBatchUserStatusRequestSchema);
    const self = c.get("authUser").sub;
    const targets = req.userIds.filter((id) => id !== self);
    // A status change bumps each user's token version: suspended users are signed out at once.
    const changed = await ops.setUsersStatus(targets, req.status);
    sessions.invalidate(...targets);
    await syncDataPlane();
    return c.json({ changed });
  });

  app.get("/api/v1/admin/users/:userId", async (c) => {
    const user = await ops.getAdminUser(c.req.param("userId"));
    if (!user) throw new StoreError("not_found", "User not found");
    return c.json({ user: (await decorateAdminUsers(store, [user]))[0] });
  });

  app.patch("/api/v1/admin/users/:userId", async (c) => {
    const userId = c.req.param("userId");
    const req = await body(c, AdminUpdateUserRequestSchema);
    const self = c.get("authUser").sub;
    if (userId === self && (req.role === "user" || req.status === "suspended")) {
      throw new StoreError("forbidden", "You cannot demote or suspend your own account");
    }
    const target = await ops.getAdminUser(userId);
    if (!target) throw new StoreError("not_found", "User not found");
    // Ways to take an account over: a new administrator, a password set by someone else, or another
    // administrator's email (then a password reset), role or status.
    const promotes = req.role === "admin" && target.role !== "admin";
    const touchesOtherAdmin =
      target.role === "admin" && userId !== self && (req.email !== undefined || req.role !== undefined || req.status !== undefined);
    if (promotes || touchesOtherAdmin || req.password) {
      const refused = await stepUp.confirmAdmin(c, sessions, self, req.confirm);
      if (refused) return refused;
    }
    // Caps and per-group rates are validated before anything is saved, written after the user.
    const applyLimits = await prepareUserLimitFields(store, req);
    const { password, confirm: _confirm, ...rest } = req;
    // A role, status or password change bumps the user's token version (ends their sessions).
    const user = await ops.updateUser(userId, {
      ...rest,
      ...(password ? { passwordHash: await hashPassword(password) } : {}),
    });
    sessions.invalidate(userId);
    // An administrator handing out a new password is also the recovery path for a sign-in lockout.
    if (password) sessions.attempts.clearSignIn(user.email);
    await applyLimits(userId);
    await syncDataPlane();
    return c.json({ user: (await decorateAdminUsers(store, [user]))[0] });
  });

  app.delete("/api/v1/admin/users/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (userId === c.get("authUser").sub) throw new StoreError("forbidden", "You cannot delete your own account");
    await ops.deleteUser(userId);
    sessions.invalidate(userId);
    await syncDataPlane();
    return c.json({ deleted: true, userId });
  });

  app.post("/api/v1/admin/users/:userId/balance", async (c) => {
    const userId = c.req.param("userId");
    const req = await body(c, AdminAdjustBalanceRequestSchema);
    const amount = usd(req.amountUsd);
    const reason = req.reason || `admin_${req.operation}`;
    const { balanceNano, deltaNano } = await ops.adjustWalletAtomic(
      userId,
      req.operation,
      amount,
      `admin:${crypto.randomUUID()}`,
      reason,
    );
    if (deltaNano !== 0n) await syncDataPlane();
    return c.json({ balanceNanoUsd: balanceNano.toString(), deltaNanoUsd: deltaNano.toString() });
  });

  app.post("/api/v1/admin/users/:userId/totp/reset", async (c) => {
    const userId = c.req.param("userId");
    // Turning off someone's second factor is half of taking their account over.
    const parsed = AdminTotpResetRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) bad(parsed.error.issues);
    const refused = await stepUp.confirmAdmin(c, sessions, c.get("authUser").sub, parsed.data.confirm);
    if (refused) return refused;
    await ops.setTotp(userId, null, false);
    await ops.bumpTokenVersion(userId);
    sessions.invalidate(userId);
    return c.json({ enabled: false });
  });

  app.get("/api/v1/admin/users/:userId/ledger", async (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
    return c.json({ items: await ops.listLedger(c.req.param("userId"), Number.isFinite(limit) ? limit : 100) });
  });

  app.get("/api/v1/admin/users/:userId/api-keys", async (c) => {
    return c.json({ items: await store.listUserApiKeys(c.req.param("userId")) });
  });

  /* ---------------- Redeem codes ---------------- */

  app.get("/api/v1/admin/redeem-codes", async (c) => c.json(await ops.listRedeemCodes(query(c, RedeemCodeListQuerySchema))));

  app.post("/api/v1/admin/redeem-codes/generate", async (c) => {
    const req = await body(c, GenerateRedeemCodesRequestSchema);
    const amount = req.kind === "balance" ? usd(req.amountUsd ?? "0") : 0n;
    if (req.kind === "balance" && amount <= 0n) throw new StoreError("bad_request", "Amount must be greater than zero");
    const codes = new Set<string>();
    while (codes.size < req.count) codes.add(generateRedeemCodeText(req.prefix));
    const items = await ops.generateRedeemCodes(req, [...codes], amount, c.get("authUser").sub);
    return c.json({ items }, 201);
  });

  app.post("/api/v1/admin/redeem-codes/batch", async (c) => {
    const req = await body(c, UpdateRedeemCodesRequestSchema);
    return c.json({ changed: await ops.updateRedeemCodes(req) });
  });

  app.get("/api/v1/admin/redeem-codes/:code/claims", async (c) => {
    return c.json({ items: await ops.listRedeemCodeClaims(c.req.param("code")) });
  });

  app.get("/api/v1/admin/redeem-codes/export", async (c) => {
    const q = query(c, RedeemCodeListQuerySchema);
    const rows = [];
    for (let page = 1; page <= 50; page++) {
      const res = await ops.listRedeemCodes({ ...q, page, pageSize: 200 });
      rows.push(...res.items);
      if (res.items.length < 200) break;
    }
    const csv = toCsv(
      [
        "code",
        "kind",
        "amount_usd",
        "group",
        "validity_days",
        "status",
        "used_count",
        "max_uses",
        "per_user_limit",
        "batch_per_user_limit",
        "batch",
        "notes",
        "redeemed_by",
        "redeemed_at",
        "expires_at",
        "created_at",
      ],
      rows.map((r) => [
        r.code,
        r.kind,
        nanoToUsdString(r.amountNanoUsd),
        r.groupName ?? "",
        r.validityDays ?? "",
        r.status,
        r.usedCount,
        r.maxUses,
        r.perUserLimit,
        r.batchPerUserLimit,
        r.batchId,
        r.notes,
        r.redeemedByEmail ?? "",
        r.redeemedAtIso ?? "",
        r.expiresAtIso ?? "",
        r.createdAtIso,
      ]),
    );
    return csvResponse(c, `redeem-codes-${stamp()}.csv`, csv);
  });

  /* ---------------- Promo codes ---------------- */

  app.get("/api/v1/admin/promo-codes", async (c) => c.json({ items: await ops.listPromoCodes() }));

  app.post("/api/v1/admin/promo-codes", async (c) => {
    const req = await body(c, CreatePromoCodeRequestSchema);
    const item = await ops.createPromoCode(req.code ?? randomCode(8), req, usd(req.bonusUsd));
    return c.json({ item }, 201);
  });

  app.patch("/api/v1/admin/promo-codes/:id", async (c) => {
    const req = await body(c, UpdatePromoCodeRequestSchema);
    const item = await ops.updatePromoCode(c.req.param("id"), req, req.bonusUsd !== undefined ? usd(req.bonusUsd) : null);
    return c.json({ item });
  });

  app.delete("/api/v1/admin/promo-codes/:id", async (c) => {
    await ops.deletePromoCode(c.req.param("id"));
    return c.json({ deleted: true });
  });

  app.get("/api/v1/admin/promo-codes/:id/usages", async (c) => c.json({ items: await ops.listPromoCodeUsages(c.req.param("id")) }));

  /* ---------------- Announcements ---------------- */

  app.get("/api/v1/admin/announcements", async (c) => c.json({ items: await ops.listAnnouncements() }));

  app.post("/api/v1/admin/announcements", async (c) => {
    const req = await body(c, UpsertAnnouncementRequestSchema);
    await requireTargetingGroups(store, req.targeting);
    return c.json({ item: await ops.createAnnouncement(req, c.get("authUser").sub) }, 201);
  });

  app.put("/api/v1/admin/announcements/:id", async (c) => {
    const req = await body(c, UpsertAnnouncementRequestSchema);
    await requireTargetingGroups(store, req.targeting);
    return c.json({ item: await ops.updateAnnouncement(c.req.param("id"), req) });
  });

  app.delete("/api/v1/admin/announcements/:id", async (c) => {
    await ops.deleteAnnouncement(c.req.param("id"));
    return c.json({ deleted: true });
  });

  app.get("/api/v1/admin/announcements/:id/readers", async (c) =>
    c.json({ items: await ops.listAnnouncementReaders(c.req.param("id")) }),
  );

  /* ---------------- Audit log ---------------- */

  app.get("/api/v1/admin/audit-logs", async (c) => c.json(await ops.listAudit(query(c, AuditLogQuerySchema))));

  /**
   * Wipes the audit log (Linksyncx AuditLogHandler.Clear): only with a fresh `totpCode`, verified
   * on every call (security/step_up.ts). Administrators without two-factor authentication are
   * refused (403 totp_not_enabled) and a password is never accepted. The clear itself is recorded
   * afterwards by auditMiddleware, with the number of rows removed.
   */
  app.post("/api/v1/admin/audit-logs/clear", async (c) => {
    const claims = c.get("authUser");
    const parsed = AuditClearRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) bad(parsed.error.issues);
    const refused = await stepUp.require(c, claims.sub, parsed.data.totpCode);
    if (refused) return refused;
    const deleted = await ops.clearAudit();
    noteAudit(c, { deleted, confirmedWith: "totp" });
    return c.json(AuditClearResponseSchema.parse({ deleted }));
  });

  /* ---------------- Subscriptions ---------------- */

  app.get("/api/v1/admin/subscriptions", async (c) => c.json(await ops.listSubscriptions(query(c, UserSubscriptionListQuerySchema))));

  app.post("/api/v1/admin/subscriptions/assign", async (c) => {
    const req = await body(c, AssignSubscriptionRequestSchema);
    const targets: { label: string; userId: string | null }[] = req.userIds.map((id) => ({ label: id, userId: id }));
    for (const email of req.emails) {
      const u = await store.findUserByEmail(email);
      targets.push({ label: email, userId: u?.id ?? null });
    }
    const items: UserSubscriptionItem[] = [];
    const failed: { user: string; message: string }[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      if (!t.userId) {
        failed.push({ user: t.label, message: "User not found" });
        continue;
      }
      if (seen.has(t.userId)) continue;
      seen.add(t.userId);
      try {
        items.push(await ops.assignSubscription(t.userId, req.groupId, req.validityDays, req.notes, "admin"));
      } catch (err) {
        failed.push({ user: t.label, message: err instanceof Error ? err.message : String(err) });
      }
    }
    await syncDataPlane();
    return c.json({ items, failed }, items.length > 0 ? 201 : 400);
  });

  app.post("/api/v1/admin/subscriptions/bulk", async (c) => {
    const req = await body(c, BulkSubscriptionActionRequestSchema);
    const items: UserSubscriptionItem[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const id of new Set(req.ids)) {
      try {
        items.push(await ops.updateSubscription(id, req.action, req.days ?? 0, req.notes, req.window));
      } catch (err) {
        failed.push({ id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    await syncDataPlane();
    return c.json({ items, failed });
  });

  app.patch("/api/v1/admin/subscriptions/:id", async (c) => {
    const req = await body(c, UpdateSubscriptionRequestSchema);
    const item = await ops.updateSubscription(c.req.param("id"), req.action, req.days ?? 0, req.notes, req.window);
    await syncDataPlane();
    return c.json({ item });
  });

  app.delete("/api/v1/admin/subscriptions/:id", async (c) => {
    await ops.deleteSubscription(c.req.param("id"));
    await syncDataPlane();
    return c.json({ deleted: true });
  });

  /* ---------------- Ops monitoring ---------------- */

  app.get("/api/v1/admin/ops/overview", async (c) => {
    const range = OpsRangeSchema.catch("1h").parse(c.req.query("range") ?? "1h");
    return c.json(await opsOverview[range]());
  });

  /* ---------------- Usage ---------------- */

  app.get("/api/v1/admin/usage/query", async (c) => c.json(await ops.queryUsage(query(c, UsageQuerySchema))));

  app.get("/api/v1/admin/usage/export", async (c) => {
    const q = query(c, UsageQuerySchema);
    const rows = await ops.exportUsage({ ...q, limit: USAGE_EXPORT_MAX_ROWS });
    return csvResponse(c, `usage-${stamp()}.csv`, usageCsv(rows));
  });
}
