import { z } from "zod";
import { OAuthProviderIdSchema } from "./commerce.ts";

export const PasskeyItemSchema = z.object({
  id: z.string().min(1),
  credentialId: z.string().min(1),
  deviceName: z.string().min(1),
  transports: z.array(z.string()),
  backedUp: z.boolean(),
  lastUsedAtIso: z.string().nullable(),
  createdAtIso: z.string(),
});
export type PasskeyItem = z.infer<typeof PasskeyItemSchema>;

export const PasskeyRegisterOptionsRequestSchema = z.object({
  deviceName: z.string().trim().max(64).optional(),
});
export type PasskeyRegisterOptionsRequest = z.infer<typeof PasskeyRegisterOptionsRequestSchema>;

export const PasskeyRegisterVerifyRequestSchema = z.object({
  challengeToken: z.string().min(1).max(1024),
  deviceName: z.string().trim().min(1).max(64).default("Passkey"),
  credential: z.object({
    id: z.string().min(1).max(512),
    rawId: z.string().min(1).max(512),
    response: z.object({
      clientDataJSON: z.string().min(1).max(16_384),
      authenticatorData: z.string().min(1).max(16_384).optional(),
      publicKeySpki: z.string().min(1).max(16_384).optional(),
      attestationObject: z.string().min(1).max(32_768).optional(),
      publicKeyAlgorithm: z.number().int().default(-7),
      transports: z.array(z.string().trim().max(32)).max(10).default([]),
    }),
  }),
});
export type PasskeyRegisterVerifyRequest = z.infer<typeof PasskeyRegisterVerifyRequestSchema>;

export const PasskeyLoginOptionsRequestSchema = z.object({
  email: z.string().trim().email().max(254).optional(),
});
export type PasskeyLoginOptionsRequest = z.infer<typeof PasskeyLoginOptionsRequestSchema>;

export const PasskeyAssertionCredentialSchema = z.object({
  id: z.string().min(1).max(512),
  rawId: z.string().min(1).max(512),
  response: z.object({
    clientDataJSON: z.string().min(1).max(16_384),
    authenticatorData: z.string().min(1).max(16_384),
    signature: z.string().min(1).max(4096),
    userHandle: z.string().max(512).nullable().optional(),
  }),
});
export type PasskeyAssertionCredential = z.infer<typeof PasskeyAssertionCredentialSchema>;

export const PasskeyLoginVerifyRequestSchema = z.object({
  challengeToken: z.string().min(1).max(1024),
  credential: PasskeyAssertionCredentialSchema,
});
export type PasskeyLoginVerifyRequest = z.infer<typeof PasskeyLoginVerifyRequestSchema>;

export const PasskeyStepUpVerifyRequestSchema = PasskeyLoginVerifyRequestSchema;
export type PasskeyStepUpVerifyRequest = z.infer<typeof PasskeyStepUpVerifyRequestSchema>;

export const RenamePasskeyRequestSchema = z.object({
  deviceName: z.string().trim().min(1).max(64),
});
export type RenamePasskeyRequest = z.infer<typeof RenamePasskeyRequestSchema>;

export const OAuthContinueSignupRequestSchema = z.object({
  token: z.string().min(1).max(256),
  username: z.string().trim().max(64).optional(),
  inviteCode: z.string().trim().max(64).optional(),
  promoCode: z.string().trim().max(32).optional(),
  affCode: z.string().trim().max(32).optional(),
});
export type OAuthContinueSignupRequest = z.infer<typeof OAuthContinueSignupRequestSchema>;

export const BindUserEmailRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  emailCode: z.string().trim().max(12).optional(),
});
export type BindUserEmailRequest = z.infer<typeof BindUserEmailRequestSchema>;

export const OAuthPendingSignupSummarySchema = z.object({
  provider: OAuthProviderIdSchema,
  displayName: z.string(),
  suggestedUsername: z.string(),
  avatarUrl: z.string(),
  inviteRequired: z.boolean(),
  promoCodeEnabled: z.boolean(),
});
export type OAuthPendingSignupSummary = z.infer<typeof OAuthPendingSignupSummarySchema>;
