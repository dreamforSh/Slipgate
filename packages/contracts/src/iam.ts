import { z } from "zod";
import { CaptchaProofSchema } from "./auth_guards.ts";

export const UserRoleSchema = z.enum(["admin", "group_manager", "user"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(["active", "suspended"]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const SetupStatusSchema = z.object({
  initialized: z.boolean(),
  siteName: z.string(),
  allowRegistration: z.boolean(),
});
export type SetupStatus = z.infer<typeof SetupStatusSchema>;

export const SetupInitializeRequestSchema = z.object({
  siteName: z.string().trim().min(1).max(64),
  adminEmail: z.string().trim().email(),
  adminPassword: z.string().min(8).max(128),
  allowRegistration: z.boolean().default(true),
});
export type SetupInitializeRequest = z.infer<typeof SetupInitializeRequestSchema>;

export const AuthLoginRequestSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
  /** Required (second step) when the account has two-factor authentication on. */
  totpCode: z.string().trim().max(12).optional(),
  /** Captcha answer (or the `captchaPass` a totp_required / invalid_totp answer handed out). */
  captcha: CaptchaProofSchema.optional(),
});
export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;

export const AuthRegisterRequestSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  username: z.string().trim().max(64).optional(),
  /** Registration bonus code (portal setting promoCodeEnabled). */
  promoCode: z.string().trim().max(32).optional(),
  /** Invitation redeem code; required when the portal is invite-only. */
  inviteCode: z.string().trim().max(64).optional(),
  /** Referrer's affiliate code (from an /login?aff= link). */
  affCode: z.string().trim().max(32).optional(),
  /** Email verification code, required when the portal demands verified addresses. */
  emailCode: z.string().trim().max(12).optional(),
  /** Captcha answer; not needed when an email code is sent while email verification is on. */
  captcha: CaptchaProofSchema.optional(),
});
export type AuthRegisterRequest = z.infer<typeof AuthRegisterRequestSchema>;

export const UserProfileSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  /** Display name; empty falls back to the email's local part in the UI. */
  username: z.string().max(64).default(""),
  avatarUrl: z.string().max(512).optional(),
  emailVerified: z.boolean().optional(),
  role: UserRoleSchema,
  managedGroupIds: z.array(z.string()).optional(),
  status: UserStatusSchema,
  totpEnabled: z.boolean(),
  createdAtIso: z.string(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const AuthSessionResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresAtIso: z.string(),
  user: UserProfileSchema,
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

/**
 * POST /api/v1/auth/logout: signs out the presented access token only (server-side denylist until
 * it expires). Other devices stay signed in; see POST /api/v1/user/sessions/revoke-all.
 */
export const LogoutResponseSchema = z.object({
  loggedOut: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

/** POST /api/v1/user/sessions/revoke-all: ends every session of the caller ("sign out of all devices"). */
export const RevokeAllSessionsRequestSchema = z.object({
  /** Keep this device signed in: the response carries a fresh session for it. */
  keepCurrent: z.boolean().default(false),
});
export type RevokeAllSessionsRequest = z.infer<typeof RevokeAllSessionsRequestSchema>;

export const RevokeAllSessionsResponseSchema = z.object({
  revoked: z.literal(true),
  /** The replacement session when `keepCurrent` was set; null when this device was signed out too. */
  session: AuthSessionResponseSchema.nullable(),
});
export type RevokeAllSessionsResponse = z.infer<typeof RevokeAllSessionsResponseSchema>;

/**
 * POST /api/v1/user/password: every other session ends with the old password; this device keeps
 * going with the fresh session returned here.
 */
export const PasswordChangedResponseSchema = z.object({
  ok: z.literal(true),
  session: AuthSessionResponseSchema,
});
export type PasswordChangedResponse = z.infer<typeof PasswordChangedResponseSchema>;
