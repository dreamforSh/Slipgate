import { z } from "zod";

/**
 * Re-confirmation of the acting administrator for actions that could hand over the deployment or
 * its data: the account password, plus a fresh authenticator code when two-factor sign-in is on.
 */
export const AdminStepUpSchema = z.object({
  password: z.string().min(1).max(256),
  totpCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code")
    .optional(),
});
export type AdminStepUp = z.infer<typeof AdminStepUpSchema>;

/** Body of POST /api/v1/admin/users/:id/totp/reset. */
export const AdminTotpResetRequestSchema = z.object({
  confirm: AdminStepUpSchema.optional(),
});
export type AdminTotpResetRequest = z.infer<typeof AdminTotpResetRequestSchema>;
