import { z } from "zod";
import { UserProfileSchema, UserRoleSchema, UserStatusSchema } from "./iam.ts";
import { LimitValueSchema, UserCapSchema, UserRateMultiplierSchema } from "./user_limits.ts";
import { AnnouncementTargetingInputSchema, AnnouncementTargetingSchema } from "./announcements.ts";
import { AUDIT_LOG_RETENTION_DEFAULT_DAYS, AuditLogRetentionDaysSchema } from "./audit.ts";
import {
  CaptchaProofSchema,
  DISABLED_PUBLIC_CAPTCHA,
  LoginAgreementDocumentsSchema,
  LoginAgreementModeSchema,
  loginAgreementRevision,
  LoginAgreementUpdatedAtSchema,
  PublicCaptchaSchema,
  PublicLoginAgreementDocumentSchema,
  RegistrationEmailSuffixListSchema,
  type PublicCaptcha,
} from "./auth_guards.ts";

/**
 * Operations & commerce contracts: admin user management, portal settings, redeem codes,
 * promo codes, announcements, audit logs and group subscriptions.
 *
 * Pure ESM/Zod leaf module (no Node/Bun APIs). Money crosses the wire as signed nano-USD
 * integer strings; human input arrives as USD decimal strings (at most 9 fractional digits).
 */

/** A non-negative USD decimal typed by a person, e.g. "12.5" or "$0.000001". */
export const UsdAmountSchema = z
  .string()
  .trim()
  .regex(/^\$?\d{1,12}(?:\.\d{1,9})?$/, "Expected a USD amount such as 10 or 2.50");

/** Signed nano-USD integer string. */
export const NanoUsdStringSchema = z.string().regex(/^-?\d+$/);

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).catch(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(20).default(20),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/* ------------------------------------------------------------------------------------------ */
/* Users (admin)                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const AdminUserSortSchema = z.enum([
  "created_desc",
  "created_asc",
  "balance_desc",
  "balance_asc",
  "spent_desc",
  "email_asc",
  "login_desc",
  /** Spend since the start of the viewer's day (`tz`). */
  "today_cost_desc",
  /** Lifetime spend (same order as spent_desc). */
  "total_cost_desc",
  /** Most recent API use of any of the user's keys. */
  "last_used_desc",
  /** Later of last sign-in and last API use. */
  "last_active_desc",
]);
export type AdminUserSort = z.infer<typeof AdminUserSortSchema>;

export const AdminUserItemSchema = UserProfileSchema.extend({
  notes: z.string(),
  allowedGroupIds: z.array(z.string()),
  inviteCode: z.string(),
  referrerId: z.string().nullable(),
  referrerEmail: z.string().nullable(),
  lastLoginAtIso: z.string().nullable(),
  balanceNanoUsd: NanoUsdStringSchema,
  spentNanoUsd: NanoUsdStringSchema,
  apiKeyCount: z.number().int().nonnegative(),
  activeSubscriptionCount: z.number().int().nonnegative(),
  /*
   * Request caps (user_limits.ts). Always set by the admin user routes; optional only so the
   * stores' base rows type-check. Own caps: null = portal default, 0 = unlimited.
   */
  rpmLimit: UserCapSchema.optional(),
  concurrencyLimit: UserCapSchema.optional(),
  /** What is enforced after applying the portal default (0 = unlimited). */
  effectiveRpmLimit: z.number().int().nonnegative().optional(),
  effectiveConcurrencyLimit: z.number().int().nonnegative().optional(),
  /** Latest API use of any of the user's keys. */
  lastApiUsedAtIso: z.string().nullable().optional(),
  /** Later of the last sign-in and the last API use. */
  lastActiveAtIso: z.string().nullable().optional(),
});
export type AdminUserItem = z.infer<typeof AdminUserItemSchema>;

export const AdminUserListQuerySchema = PageQuerySchema.extend({
  search: z.string().trim().max(200).optional().catch(undefined),
  role: UserRoleSchema.optional().catch(undefined),
  status: UserStatusSchema.optional().catch(undefined),
  sort: AdminUserSortSchema.catch("created_desc").default("created_desc"),
  /** Users granted this (exclusive) group in allowedGroupIds. */
  groupId: z.string().trim().min(1).max(128).optional().catch(undefined),
  /** Users owning at least one API key bound to this group. */
  apiKeyGroupId: z.string().trim().min(1).max(128).optional().catch(undefined),
  /** Viewer's `Date#getTimezoneOffset()` (minutes): where "today" starts for today_cost_desc. */
  tz: z.coerce.number().int().min(-840).max(840).catch(0).default(0),
});
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;

export const AdminUserListResponseSchema = z.object({
  items: z.array(AdminUserItemSchema),
  total: z.number().int().nonnegative(),
  stats: z.object({
    total: z.number().int().nonnegative(),
    admins: z.number().int().nonnegative(),
    suspended: z.number().int().nonnegative(),
    newLast7d: z.number().int().nonnegative(),
    balanceNanoUsd: NanoUsdStringSchema,
  }),
});
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;

export const AdminCreateUserRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  username: z.string().trim().max(64).default(""),
  role: UserRoleSchema.default("user"),
  notes: z.string().trim().max(1000).default(""),
  allowedGroupIds: z.array(z.string().min(1)).max(200).default([]),
  /** Opening balance; omitted means the portal's default new-user balance. */
  initialBalanceUsd: UsdAmountSchema.optional(),
  /** Request caps; omitted or null = the portal default, 0 = unlimited. */
  rpmLimit: UserCapSchema.optional(),
  concurrencyLimit: UserCapSchema.optional(),
});
export type AdminCreateUserRequest = z.infer<typeof AdminCreateUserRequestSchema>;

export const AdminUpdateUserRequestSchema = z.object({
  email: z.string().trim().email().max(254).optional(),
  username: z.string().trim().max(64).optional(),
  role: UserRoleSchema.optional(),
  status: UserStatusSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
  allowedGroupIds: z.array(z.string().min(1)).max(200).optional(),
  /** Admin password reset; never echoed back. */
  password: z.string().min(8).max(128).optional(),
  /** Request caps; null = back to the portal default, 0 = unlimited. */
  rpmLimit: UserCapSchema.optional(),
  concurrencyLimit: UserCapSchema.optional(),
  /**
   * Linksyncx UpdateUserRequest.group_rates: groupId -> custom multiplier for this user (null
   * clears it). Only the listed groups change; unknown groups are refused before anything is saved.
   */
  groupRates: z.record(z.string().min(1), UserRateMultiplierSchema.nullable()).optional(),
});
export type AdminUpdateUserRequest = z.infer<typeof AdminUpdateUserRequestSchema>;

export const BalanceOperationSchema = z.enum(["add", "subtract", "set"]);
export type BalanceOperation = z.infer<typeof BalanceOperationSchema>;

export const AdminAdjustBalanceRequestSchema = z.object({
  operation: BalanceOperationSchema,
  amountUsd: UsdAmountSchema,
  reason: z.string().trim().max(200).default(""),
});
export type AdminAdjustBalanceRequest = z.infer<typeof AdminAdjustBalanceRequestSchema>;

export const AdminBatchUserStatusRequestSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(500),
  status: UserStatusSchema,
});
export type AdminBatchUserStatusRequest = z.infer<typeof AdminBatchUserStatusRequestSchema>;

/** One wallet movement as shown in balance history. */
export const BalanceLedgerItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["credit", "settle", "adjust", "hold", "release"]),
  deltaNanoUsd: NanoUsdStringSchema,
  balanceAfterNanoUsd: NanoUsdStringSchema,
  reason: z.string(),
  createdAtIso: z.string(),
});
export type BalanceLedgerItem = z.infer<typeof BalanceLedgerItemSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Self-service profile                                                                       */
/* ------------------------------------------------------------------------------------------ */

export const UpdateProfileRequestSchema = z.object({
  username: z.string().trim().max(64),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

export const TotpSetupRequestSchema = z.object({ password: z.string().min(1).max(128) });
export type TotpSetupRequest = z.infer<typeof TotpSetupRequestSchema>;

export const TotpSetupResponseSchema = z.object({
  /** Base32 secret for manual entry. */
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;

export const TotpCodeRequestSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });
export type TotpCodeRequest = z.infer<typeof TotpCodeRequestSchema>;

export const TotpDisableRequestSchema = z.object({
  password: z.string().min(1).max(128),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});
export type TotpDisableRequest = z.infer<typeof TotpDisableRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Portal settings                                                                            */
/* ------------------------------------------------------------------------------------------ */

const OptionalUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => v === "" || /^(https?:\/\/|\/)/i.test(v), "Must be an http(s) URL or a site path");

export const CustomNavLinkSchema = z.object({
  label: z.string().trim().min(1).max(40),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((v) => /^(https?:\/\/|\/)/i.test(v), "Must be an http(s) URL or a site path"),
});
export type CustomNavLink = z.infer<typeof CustomNavLinkSchema>;

export const PortalSettingsSchema = z.object({
  /* Branding */
  siteName: z.string().trim().min(1).max(64),
  siteSubtitle: z.string().trim().max(200),
  logoUrl: OptionalUrlSchema,
  footerText: z.string().trim().max(500),
  /* Docs & contact */
  apiBaseUrl: OptionalUrlSchema,
  docUrl: OptionalUrlSchema,
  contactInfo: z.string().trim().max(500),
  /** Markdown shown on the public landing page; empty uses the built-in hero. */
  homeContent: z.string().max(20_000),
  customNavLinks: z.array(CustomNavLinkSchema).max(10),
  /* Registration & defaults */
  allowRegistration: z.boolean(),
  promoCodeEnabled: z.boolean(),
  inviteRequired: z.boolean(),
  /** New accounts must confirm their email with a code (needs working SMTP). */
  emailVerificationRequired: z.boolean(),
  defaultBalanceNanoUsd: NanoUsdStringSchema,
  defaultApiKeyRpm: z.number().int().min(1).max(100_000),
  defaultApiKeyConcurrency: z.number().int().min(1).max(10_000),
  /** Caps for users without their own (0 = unlimited): requests per minute / in flight, across all keys. */
  defaultUserRpm: LimitValueSchema,
  defaultUserConcurrency: LimitValueSchema,
  /* Public surfaces */
  modelPlazaEnabled: z.boolean(),
  statusPageEnabled: z.boolean(),
  keyUsageLookupEnabled: z.boolean(),
  /* Affiliate program */
  affiliateEnabled: z.boolean(),
  /** Rebate on the invitee's paid top-ups, in basis points (1000 = 10%). */
  affiliateRebateBps: z.number().int().min(0).max(5000),
  /* Maintenance */
  /** Audit-log rows older than this many days are swept daily; 0 keeps them forever. */
  auditLogRetentionDays: AuditLogRetentionDaysSchema,
  /* Sign-up email policy (auth_guards.ts) */
  /** "@example.com" (exact domain) / "*.edu.cn" (domain and subdomains); empty = every domain. */
  registrationEmailSuffixAllowlist: RegistrationEmailSuffixListSchema,
  /** With an allowlist: an unlisted domain may still sign up while it has no account (one per domain). */
  registrationEmailDomainQuotaEnabled: z.boolean(),
  /* Login agreement (terms / privacy documents, also served at /legal/:id) */
  loginAgreementEnabled: z.boolean(),
  loginAgreementMode: LoginAgreementModeSchema,
  /** Shown as "last updated"; part of the revision, so changing it asks everyone again. */
  loginAgreementUpdatedAt: LoginAgreementUpdatedAtSchema,
  loginAgreementDocuments: LoginAgreementDocumentsSchema,
  /* Backend (admin-only) mode: no sign-up, no self-service, only administrators sign in */
  backendModeEnabled: z.boolean(),
});
export type PortalSettings = z.infer<typeof PortalSettingsSchema>;

export const DEFAULT_PORTAL_SETTINGS: PortalSettings = {
  siteName: "Slipgate Gateway",
  siteSubtitle: "",
  logoUrl: "",
  footerText: "",
  apiBaseUrl: "",
  docUrl: "",
  contactInfo: "",
  homeContent: "",
  customNavLinks: [],
  allowRegistration: true,
  promoCodeEnabled: true,
  inviteRequired: false,
  emailVerificationRequired: false,
  defaultBalanceNanoUsd: "0",
  defaultApiKeyRpm: 60,
  defaultApiKeyConcurrency: 5,
  defaultUserRpm: 0,
  defaultUserConcurrency: 0,
  modelPlazaEnabled: true,
  statusPageEnabled: true,
  keyUsageLookupEnabled: true,
  affiliateEnabled: false,
  affiliateRebateBps: 1000,
  auditLogRetentionDays: AUDIT_LOG_RETENTION_DEFAULT_DAYS,
  registrationEmailSuffixAllowlist: [],
  registrationEmailDomainQuotaEnabled: false,
  loginAgreementEnabled: false,
  loginAgreementMode: "modal",
  loginAgreementUpdatedAt: "",
  loginAgreementDocuments: [],
  backendModeEnabled: false,
};

/** Admin PATCH: any subset; the default balance arrives as a USD string. */
export const UpdatePortalSettingsRequestSchema = PortalSettingsSchema.omit({ defaultBalanceNanoUsd: true })
  .extend({ defaultBalanceUsd: UsdAmountSchema })
  .partial();
export type UpdatePortalSettingsRequest = z.infer<typeof UpdatePortalSettingsRequestSchema>;

/** Unauthenticated branding subset (everything the login page, landing page and shell need). */
export const PublicSettingsSchema = PortalSettingsSchema.pick({
  siteName: true,
  siteSubtitle: true,
  logoUrl: true,
  footerText: true,
  apiBaseUrl: true,
  docUrl: true,
  contactInfo: true,
  customNavLinks: true,
  allowRegistration: true,
  promoCodeEnabled: true,
  inviteRequired: true,
  emailVerificationRequired: true,
  modelPlazaEnabled: true,
  statusPageEnabled: true,
  keyUsageLookupEnabled: true,
  affiliateEnabled: true,
}).extend({
  initialized: z.boolean(),
  /** Online payment is configured and switched on (drives the purchase menu). */
  paymentEnabled: z.boolean().default(false),
  /** Outgoing mail is configured, so "forgot password" works. */
  passwordResetEnabled: z.boolean().default(false),
  /* Auth guards (auth_guards.ts) */
  /** Sign-up email suffix allowlist ("@a.com", "*.edu.cn"); empty = every domain. */
  registrationEmailSuffixAllowlist: z.array(z.string()).default([]),
  /** Unlisted domains may still sign up once (one account per domain). */
  registrationEmailDomainQuotaEnabled: z.boolean().default(false),
  /** Admin-only mode: hide sign-up, self-service and public pages; only administrators sign in. */
  backendModeEnabled: z.boolean().default(false),
  /** Ask for consent before sign-in / sign-up (only true when there is at least one document). */
  loginAgreementEnabled: z.boolean().default(false),
  loginAgreementMode: LoginAgreementModeSchema.default("modal"),
  loginAgreementUpdatedAt: z.string().default(""),
  /** Changes with the date or any document: consent stored for another revision is asked again. */
  loginAgreementRevision: z.string().default(""),
  /** Documents to link (/legal/:id); their text comes from GET /api/v1/public/legal/:id. */
  loginAgreementDocuments: z.array(PublicLoginAgreementDocumentSchema).default([]),
  /** Human verification widget for login, sign-up, email codes, forgot password and OAuth start. */
  captcha: PublicCaptchaSchema.default(DISABLED_PUBLIC_CAPTCHA),
});
export type PublicSettings = z.infer<typeof PublicSettingsSchema>;

/**
 * The site's public base URL (Settings → API base URL) when it is an absolute http(s) URL, without
 * query, fragment, trailing slash or a trailing "/v1" (the field is also the API key snippets' base
 * and may be entered as https://host/v1; the console lives one level up); null otherwise. Links in
 * outgoing mail are built only from this, never from request headers: a client-chosen Host /
 * X-Forwarded-Host would otherwise point a genuine password-reset mail (and its token) at the
 * attacker's host.
 */
export function configuredPublicBaseUrl(settings: Pick<PortalSettings, "apiBaseUrl">): string | null {
  const raw = settings.apiBaseUrl.trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function toPublicSettings(
  settings: PortalSettings,
  initialized: boolean,
  paymentEnabled = false,
  mailEnabled = false,
  /** Values that live outside the portal settings blob (the captcha config has its own, with secrets). */
  extras: { captcha?: PublicCaptcha } = {},
): PublicSettings {
  const backendMode = settings.backendModeEnabled;
  return {
    ...publicAuthGuardSettings(settings, extras.captcha),
    initialized,
    paymentEnabled,
    // Reset links need working mail and a configured public URL to point at.
    passwordResetEnabled: mailEnabled && configuredPublicBaseUrl(settings) !== null,
    siteName: settings.siteName,
    siteSubtitle: settings.siteSubtitle,
    logoUrl: settings.logoUrl,
    footerText: settings.footerText,
    apiBaseUrl: settings.apiBaseUrl,
    docUrl: settings.docUrl,
    contactInfo: settings.contactInfo,
    customNavLinks: settings.customNavLinks.map((l) => ({ ...l })),
    // Backend mode closes sign-up and the public pages whatever their own switches say.
    allowRegistration: settings.allowRegistration && !backendMode,
    promoCodeEnabled: settings.promoCodeEnabled,
    inviteRequired: settings.inviteRequired,
    // Verification is only enforced when mail can actually be delivered.
    emailVerificationRequired: settings.emailVerificationRequired && mailEnabled,
    modelPlazaEnabled: settings.modelPlazaEnabled && !backendMode,
    statusPageEnabled: settings.statusPageEnabled && !backendMode,
    keyUsageLookupEnabled: settings.keyUsageLookupEnabled,
    affiliateEnabled: settings.affiliateEnabled,
  };
}

/** The auth-guard part of the public settings (sign-up policy, backend mode, agreement, captcha). */
function publicAuthGuardSettings(settings: PortalSettings, captcha: PublicCaptcha | undefined) {
  const documents = settings.loginAgreementDocuments;
  return {
    registrationEmailSuffixAllowlist: [...settings.registrationEmailSuffixAllowlist],
    registrationEmailDomainQuotaEnabled: settings.registrationEmailDomainQuotaEnabled,
    backendModeEnabled: settings.backendModeEnabled,
    loginAgreementEnabled: settings.loginAgreementEnabled && documents.length > 0,
    loginAgreementMode: settings.loginAgreementMode,
    loginAgreementUpdatedAt: settings.loginAgreementUpdatedAt,
    loginAgreementRevision: loginAgreementRevision(settings.loginAgreementUpdatedAt, documents),
    loginAgreementDocuments: documents.map((d) => ({ id: d.id, title: d.title })),
    captcha: captcha ?? DISABLED_PUBLIC_CAPTCHA,
  };
}

/**
 * Rules between portal settings fields that one field's schema can't express; empty when the
 * settings are consistent. Checked when an administrator saves the settings.
 */
export function portalSettingsIssues(settings: PortalSettings): string[] {
  const issues: string[] = [];
  if (settings.loginAgreementEnabled && settings.loginAgreementDocuments.length === 0) {
    issues.push("loginAgreementDocuments: add at least one document before turning the login agreement on");
  }
  return issues;
}

/** Fill gaps in a stored settings blob (older rows, partial JSON) from the defaults. */
export function normalizePortalSettings(raw: unknown): PortalSettings {
  const base: Record<string, unknown> = { ...DEFAULT_PORTAL_SETTINGS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_PORTAL_SETTINGS, key) && value !== undefined && value !== null) {
        base[key] = value;
      }
    }
  }
  const parsed = PortalSettingsSchema.safeParse(base);
  if (parsed.success) return parsed.data;
  // Drop only the invalid fields, keep the rest.
  const repaired: Record<string, unknown> = { ...base };
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === "string") repaired[key] = (DEFAULT_PORTAL_SETTINGS as Record<string, unknown>)[key];
  }
  return PortalSettingsSchema.parse(repaired);
}

/* ------------------------------------------------------------------------------------------ */
/* Redeem codes                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** `invitation` codes gate registration when the portal is invite-only. */
export const RedeemCodeKindSchema = z.enum(["balance", "subscription", "invitation"]);
export type RedeemCodeKind = z.infer<typeof RedeemCodeKindSchema>;

/** `expired` is derived from `expiresAtIso` for unused codes; the stored state stays `unused`. */
export const RedeemCodeStatusSchema = z.enum(["unused", "used", "disabled", "expired"]);
export type RedeemCodeStatus = z.infer<typeof RedeemCodeStatusSchema>;

export const RedeemCodeItemSchema = z.object({
  code: z.string(),
  kind: RedeemCodeKindSchema,
  amountNanoUsd: NanoUsdStringSchema,
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
  validityDays: z.number().int().nullable(),
  status: RedeemCodeStatusSchema,
  batchId: z.string(),
  notes: z.string(),
  redeemedBy: z.string().nullable(),
  redeemedByEmail: z.string().nullable(),
  redeemedAtIso: z.string().nullable(),
  expiresAtIso: z.string().nullable(),
  createdAtIso: z.string(),
});
export type RedeemCodeItem = z.infer<typeof RedeemCodeItemSchema>;

export const RedeemCodeListQuerySchema = PageQuerySchema.extend({
  search: z.string().trim().max(200).optional().catch(undefined),
  status: RedeemCodeStatusSchema.optional().catch(undefined),
  kind: RedeemCodeKindSchema.optional().catch(undefined),
  batchId: z.string().trim().max(64).optional().catch(undefined),
});
export type RedeemCodeListQuery = z.infer<typeof RedeemCodeListQuerySchema>;

export const RedeemCodeListResponseSchema = z.object({
  items: z.array(RedeemCodeItemSchema),
  total: z.number().int().nonnegative(),
  stats: z.object({
    total: z.number().int().nonnegative(),
    unused: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    disabled: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    redeemedNanoUsd: NanoUsdStringSchema,
  }),
});
export type RedeemCodeListResponse = z.infer<typeof RedeemCodeListResponseSchema>;

export const GenerateRedeemCodesRequestSchema = z
  .object({
    kind: RedeemCodeKindSchema.default("balance"),
    amountUsd: UsdAmountSchema.optional(),
    groupId: z.string().min(1).optional(),
    validityDays: z.number().int().min(1).max(3650).optional(),
    count: z.number().int().min(1).max(500).default(1),
    prefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{0,8}$/, "Prefix: up to 8 letters or digits")
      .default(""),
    expiresAtIso: z.string().datetime({ offset: true }).nullable().optional(),
    notes: z.string().trim().max(200).default(""),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "balance" && !v.amountUsd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountUsd"], message: "Amount is required" });
    }
    if (v.kind === "subscription" && (!v.groupId || !v.validityDays)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groupId"],
        message: "Subscription codes need a group and a validity in days",
      });
    }
  });
export type GenerateRedeemCodesRequest = z.infer<typeof GenerateRedeemCodesRequestSchema>;

export const UpdateRedeemCodesRequestSchema = z.object({
  codes: z.array(z.string().min(1)).min(1).max(1000),
  action: z.enum(["disable", "enable", "delete", "set_expiry", "set_notes"]),
  /** set_expiry: new expiry or null for never. */
  expiresAtIso: z.string().datetime({ offset: true }).nullable().optional(),
  /** set_notes */
  notes: z.string().trim().max(200).optional(),
});
export type UpdateRedeemCodesRequest = z.infer<typeof UpdateRedeemCodesRequestSchema>;

export const RedeemRequestSchema = z.object({
  code: z.string().trim().min(4).max(64),
});
export type RedeemRequest = z.infer<typeof RedeemRequestSchema>;

export const RedeemResultSchema = z.object({
  code: z.string(),
  kind: RedeemCodeKindSchema,
  amountNanoUsd: NanoUsdStringSchema,
  groupName: z.string().nullable(),
  validityDays: z.number().int().nullable(),
  subscriptionExpiresAtIso: z.string().nullable(),
});
export type RedeemResult = z.infer<typeof RedeemResultSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Promo codes (registration bonus)                                                           */
/* ------------------------------------------------------------------------------------------ */

export const PromoCodeItemSchema = z.object({
  id: z.string(),
  code: z.string(),
  bonusNanoUsd: NanoUsdStringSchema,
  /** 0 = unlimited. */
  maxUses: z.number().int().nonnegative(),
  usedCount: z.number().int().nonnegative(),
  enabled: z.boolean(),
  expiresAtIso: z.string().nullable(),
  notes: z.string(),
  createdAtIso: z.string(),
});
export type PromoCodeItem = z.infer<typeof PromoCodeItemSchema>;

const PromoCodeTextSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,32}$/, "3-32 letters, digits, - or _");

export const CreatePromoCodeRequestSchema = z.object({
  /** Omitted: a random 8-character code. */
  code: PromoCodeTextSchema.optional(),
  bonusUsd: UsdAmountSchema,
  maxUses: z.number().int().min(0).max(1_000_000).default(0),
  enabled: z.boolean().default(true),
  expiresAtIso: z.string().datetime({ offset: true }).nullable().default(null),
  notes: z.string().trim().max(200).default(""),
});
export type CreatePromoCodeRequest = z.infer<typeof CreatePromoCodeRequestSchema>;

export const UpdatePromoCodeRequestSchema = z.object({
  bonusUsd: UsdAmountSchema.optional(),
  maxUses: z.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
  expiresAtIso: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().trim().max(200).optional(),
});
export type UpdatePromoCodeRequest = z.infer<typeof UpdatePromoCodeRequestSchema>;

export const PromoCodeUsageItemSchema = z.object({
  userId: z.string(),
  userEmail: z.string(),
  bonusNanoUsd: NanoUsdStringSchema,
  usedAtIso: z.string(),
});
export type PromoCodeUsageItem = z.infer<typeof PromoCodeUsageItemSchema>;

export const PromoCodeCheckResponseSchema = z.object({
  valid: z.boolean(),
  bonusNanoUsd: NanoUsdStringSchema,
  reason: z.enum(["ok", "not_found", "disabled", "expired", "exhausted"]),
});
export type PromoCodeCheckResponse = z.infer<typeof PromoCodeCheckResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Announcements                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const AnnouncementLevelSchema = z.enum(["info", "success", "warning", "important"]);
export type AnnouncementLevel = z.infer<typeof AnnouncementLevelSchema>;

export const AnnouncementStatusSchema = z.enum(["draft", "published", "archived"]);
export type AnnouncementStatus = z.infer<typeof AnnouncementStatusSchema>;

export const AnnouncementAudienceSchema = z.enum(["all", "users", "admins"]);
export type AnnouncementAudience = z.infer<typeof AnnouncementAudienceSchema>;

export const AnnouncementItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Markdown (rendered with a safe subset on the client). */
  content: z.string(),
  level: AnnouncementLevelSchema,
  status: AnnouncementStatusSchema,
  audience: AnnouncementAudienceSchema,
  pinned: z.boolean(),
  /** Pop up once per user until read. */
  popup: z.boolean(),
  startsAtIso: z.string().nullable(),
  endsAtIso: z.string().nullable(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
  readCount: z.number().int().nonnegative().default(0),
  /** Extra conditions on top of `audience` (announcements.ts); `{ anyOf: [] }` = none. */
  targeting: AnnouncementTargetingSchema.default({ anyOf: [] }),
});
export type AnnouncementItem = z.infer<typeof AnnouncementItemSchema>;

export const UpsertAnnouncementRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    content: z.string().max(20_000).default(""),
    level: AnnouncementLevelSchema.default("info"),
    status: AnnouncementStatusSchema.default("draft"),
    audience: AnnouncementAudienceSchema.default("all"),
    /** Omitted: none on create, unchanged on update. `null`, `{}` or `{ anyOf: [] }` clears it. */
    targeting: AnnouncementTargetingInputSchema.nullish().transform((t) => (t === null ? { anyOf: [] } : t)),
    pinned: z.boolean().default(false),
    popup: z.boolean().default(false),
    startsAtIso: z.string().datetime({ offset: true }).nullable().default(null),
    endsAtIso: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .refine((v) => !v.startsAtIso || !v.endsAtIso || Date.parse(v.startsAtIso) < Date.parse(v.endsAtIso), {
    path: ["endsAtIso"],
    message: "End time must be after the start time",
  });
export type UpsertAnnouncementRequest = z.infer<typeof UpsertAnnouncementRequestSchema>;

export const AnnouncementReaderSchema = z.object({
  userId: z.string(),
  email: z.string(),
  readAtIso: z.string(),
});
export type AnnouncementReader = z.infer<typeof AnnouncementReaderSchema>;

export const UserAnnouncementItemSchema = AnnouncementItemSchema.omit({ status: true, audience: true, readCount: true, targeting: true }).extend({
  read: z.boolean(),
});
export type UserAnnouncementItem = z.infer<typeof UserAnnouncementItemSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Audit log                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export const AuditLogItemSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  actorEmail: z.string(),
  actorRole: z.string(),
  method: z.string(),
  /** Route pattern, e.g. /api/v1/admin/users/:userId */
  route: z.string(),
  path: z.string(),
  targetId: z.string(),
  statusCode: z.number().int(),
  ip: z.string(),
  userAgent: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** JSON request body with secrets redacted and long values cut (empty for bodiless calls). */
  requestBody: z.string(),
  createdAtIso: z.string(),
});
export type AuditLogItem = z.infer<typeof AuditLogItemSchema>;

export const AuditLogQuerySchema = PageQuerySchema.extend({
  search: z.string().trim().max(200).optional().catch(undefined),
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]).optional().catch(undefined),
  actorId: z.string().trim().max(64).optional().catch(undefined),
  outcome: z.enum(["success", "failure"]).optional().catch(undefined),
  sinceIso: z.string().datetime({ offset: true }).optional().catch(undefined),
  untilIso: z.string().datetime({ offset: true }).optional().catch(undefined),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

/* ------------------------------------------------------------------------------------------ */
/* Group subscriptions                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** Spend caps of a subscription-billed group over rolling windows; "0" = unlimited. */
export const SubscriptionLimitsSchema = z.object({
  dailyLimitNanoUsd: NanoUsdStringSchema,
  weeklyLimitNanoUsd: NanoUsdStringSchema,
  monthlyLimitNanoUsd: NanoUsdStringSchema,
});
export type SubscriptionLimits = z.infer<typeof SubscriptionLimitsSchema>;

export const SubscriptionUsageSchema = z.object({
  dailyNanoUsd: NanoUsdStringSchema,
  weeklyNanoUsd: NanoUsdStringSchema,
  monthlyNanoUsd: NanoUsdStringSchema,
});
export type SubscriptionUsage = z.infer<typeof SubscriptionUsageSchema>;

/** `expired` is derived from expiresAt for active rows. */
export const UserSubscriptionStatusSchema = z.enum(["active", "expired", "revoked"]);
export type UserSubscriptionStatus = z.infer<typeof UserSubscriptionStatusSchema>;

export const UserSubscriptionItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userEmail: z.string(),
  groupId: z.string(),
  groupName: z.string(),
  status: UserSubscriptionStatusSchema,
  source: z.string(),
  notes: z.string(),
  startsAtIso: z.string(),
  expiresAtIso: z.string(),
  /** Spend before this instant no longer counts against the caps (admin quota reset). */
  usageResetAtIso: z.string().nullable(),
  createdAtIso: z.string(),
  limits: SubscriptionLimitsSchema,
  usage: SubscriptionUsageSchema,
  /** True when any window is at or over its cap (keys of this group are paused). */
  overLimit: z.boolean(),
});
export type UserSubscriptionItem = z.infer<typeof UserSubscriptionItemSchema>;

export const UserSubscriptionListQuerySchema = PageQuerySchema.extend({
  search: z.string().trim().max(200).optional().catch(undefined),
  status: UserSubscriptionStatusSchema.optional().catch(undefined),
  groupId: z.string().trim().max(64).optional().catch(undefined),
  userId: z.string().trim().max(64).optional().catch(undefined),
});
export type UserSubscriptionListQuery = z.infer<typeof UserSubscriptionListQuerySchema>;

export const AssignSubscriptionRequestSchema = z
  .object({
    userIds: z.array(z.string().min(1)).max(100).default([]),
    emails: z.array(z.string().trim().email()).max(100).default([]),
    groupId: z.string().min(1),
    validityDays: z.number().int().min(1).max(3650),
    notes: z.string().trim().max(200).default(""),
  })
  .refine((v) => v.userIds.length + v.emails.length > 0, { path: ["emails"], message: "Pick at least one user" });
export type AssignSubscriptionRequest = z.infer<typeof AssignSubscriptionRequestSchema>;

export const SubscriptionActionSchema = z.enum(["extend", "revoke", "reactivate", "reset_usage"]);
export type SubscriptionAction = z.infer<typeof SubscriptionActionSchema>;

export const UpdateSubscriptionRequestSchema = z.object({
  action: SubscriptionActionSchema,
  /** extend: positive lengthens, negative shortens (an expired one restarts from now). */
  days: z.number().int().min(-3650).max(3650).optional(),
  notes: z.string().trim().max(200).optional(),
});

export const BulkSubscriptionActionRequestSchema = UpdateSubscriptionRequestSchema.extend({
  ids: z.array(z.string().min(1)).min(1).max(200),
});
export type BulkSubscriptionActionRequest = z.infer<typeof BulkSubscriptionActionRequestSchema>;

export const AssignSubscriptionResultSchema = z.object({
  items: z.array(z.lazy(() => UserSubscriptionItemSchema)),
  failed: z.array(z.object({ user: z.string(), message: z.string() })),
});
export type UpdateSubscriptionRequest = z.infer<typeof UpdateSubscriptionRequestSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Email (SMTP), verification codes and password reset                                        */
/* ------------------------------------------------------------------------------------------ */

export const SmtpSecuritySchema = z.enum(["tls", "starttls", "none"]);
export type SmtpSecurityMode = z.infer<typeof SmtpSecuritySchema>;

export const EmailConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().max(255),
  port: z.number().int().min(1).max(65535),
  security: SmtpSecuritySchema,
  username: z.string().trim().max(255),
  passwordSet: z.boolean(),
  fromAddress: z.string().trim().max(255),
  fromName: z.string().trim().max(64),
  allowInsecureTls: z.boolean(),
});
export type EmailConfig = z.infer<typeof EmailConfigSchema>;

export const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  enabled: false,
  host: "",
  port: 465,
  security: "tls",
  username: "",
  passwordSet: false,
  fromAddress: "",
  fromName: "",
  allowInsecureTls: false,
};

/** password: omitted = keep, "" = clear, otherwise replace. */
export const UpdateEmailConfigRequestSchema = EmailConfigSchema.omit({ passwordSet: true })
  .extend({ password: z.string().max(512) })
  .partial()
  .refine((v) => v.fromAddress === undefined || v.fromAddress === "" || /^[^\s@]+@[^\s@]+$/.test(v.fromAddress), {
    path: ["fromAddress"],
    message: "Expected an email address",
  });
export type UpdateEmailConfigRequest = z.infer<typeof UpdateEmailConfigRequestSchema>;

export const TestEmailRequestSchema = z.object({ to: z.string().trim().email() });
export type TestEmailRequest = z.infer<typeof TestEmailRequestSchema>;

export const EmailCodePurposeSchema = z.enum(["register"]);
export type EmailCodePurpose = z.infer<typeof EmailCodePurposeSchema>;

export const SendEmailCodeRequestSchema = z.object({
  email: z.string().trim().email(),
  purpose: EmailCodePurposeSchema.default("register"),
  /** Captcha answer (auth_guards.ts) when the emailCode scope is on. */
  captcha: CaptchaProofSchema.optional(),
});
export type SendEmailCodeRequest = z.infer<typeof SendEmailCodeRequestSchema>;

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().trim().email(),
  /** Captcha answer (auth_guards.ts) when the forgotPassword scope is on. */
  captcha: CaptchaProofSchema.optional(),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: z.string().trim().regex(/^[A-Za-z0-9_-]{32,128}$/),
  password: z.string().min(8).max(128),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Third-party sign-in (OAuth 2.0 / OIDC)                                                     */
/* ------------------------------------------------------------------------------------------ */

export const OAuthProviderIdSchema = z.enum(["github", "google", "linuxdo", "oidc"]);
export type OAuthProviderId = z.infer<typeof OAuthProviderIdSchema>;

const OAuthUrlSchema = z
  .string()
  .trim()
  .max(512)
  .refine((v) => v === "" || /^https?:\/\//i.test(v), "Must be an http(s) URL");

/** Admin view; the client secret is only reported as set/unset. */
export const OAuthProviderConfigSchema = z.object({
  id: OAuthProviderIdSchema,
  enabled: z.boolean(),
  displayName: z.string().trim().max(40),
  clientId: z.string().trim().max(256),
  clientSecretSet: z.boolean(),
  authorizeUrl: OAuthUrlSchema,
  tokenUrl: OAuthUrlSchema,
  userinfoUrl: OAuthUrlSchema,
  scopes: z.string().trim().max(256),
  /** Dotted paths into the userinfo JSON. */
  idField: z.string().trim().max(64),
  emailField: z.string().trim().max(64),
  nameField: z.string().trim().max(64),
  /** Create accounts for unknown users (still subject to the portal's registration switch). */
  allowSignup: z.boolean(),
});
export type OAuthProviderConfig = z.infer<typeof OAuthProviderConfigSchema>;

export const UpdateOAuthProviderRequestSchema = OAuthProviderConfigSchema.omit({ id: true, clientSecretSet: true })
  .extend({ clientSecret: z.string().max(512) })
  .partial();
export type UpdateOAuthProviderRequest = z.infer<typeof UpdateOAuthProviderRequestSchema>;

export const PublicOAuthProviderSchema = z.object({ id: OAuthProviderIdSchema, displayName: z.string() });
export type PublicOAuthProvider = z.infer<typeof PublicOAuthProviderSchema>;

export const LinkedIdentitySchema = z.object({
  provider: z.string(),
  subject: z.string(),
  createdAtIso: z.string(),
});
export type LinkedIdentity = z.infer<typeof LinkedIdentitySchema>;
