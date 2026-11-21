import { z } from "zod";

export const UserRoleSchema = z.enum(["admin", "user"]);
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
});
export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;

export const AuthRegisterRequestSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
});
export type AuthRegisterRequest = z.infer<typeof AuthRegisterRequestSchema>;

export const UserProfileSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  role: UserRoleSchema,
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
