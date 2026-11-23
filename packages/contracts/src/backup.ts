import { z } from "zod";

/**
 * Configuration backup: everything an operator sets up by hand (portal settings, groups,
 * composite routes, payment plans, promo codes, announcements, price rules, auto-test and
 * plugin switches). Secrets, users, wallets, API keys and upstream credentials are never
 * included — accounts have their own encrypted export.
 */
export const CONFIG_BACKUP_TYPE = "slipgate-config-backup";

export const ConfigBackupFileSchema = z.object({
  type: z.literal(CONFIG_BACKUP_TYPE),
  version: z.literal(1),
  exportedAtIso: z.string(),
  portalSettings: z.record(z.unknown()).nullable(),
  groups: z.array(z.record(z.unknown())),
  compositeRoutes: z.array(z.record(z.unknown())),
  paymentPlans: z.array(z.record(z.unknown())),
  promoCodes: z.array(z.record(z.unknown())),
  announcements: z.array(z.record(z.unknown())),
  pricingRules: z.array(z.record(z.unknown())),
  autoTest: z.record(z.unknown()).nullable(),
  disabledPlugins: z.array(z.string()),
});
export type ConfigBackupFile = z.infer<typeof ConfigBackupFileSchema>;

export const ConfigBackupSectionSchema = z.enum([
  "portalSettings",
  "groups",
  "compositeRoutes",
  "paymentPlans",
  "promoCodes",
  "announcements",
  "pricingRules",
  "autoTest",
  "plugins",
]);
export type ConfigBackupSection = z.infer<typeof ConfigBackupSectionSchema>;

export const ConfigImportRequestSchema = z.object({
  file: ConfigBackupFileSchema,
  /** Sections to restore; default all. Existing items are kept (matched by name/code/pattern). */
  sections: z.array(ConfigBackupSectionSchema).optional(),
});
export type ConfigImportRequest = z.infer<typeof ConfigImportRequestSchema>;

export const ConfigImportResultSchema = z.object({
  created: z.record(z.number().int().nonnegative()),
  skipped: z.record(z.number().int().nonnegative()),
  updated: z.array(z.string()),
  errors: z.array(z.string()),
});
export type ConfigImportResult = z.infer<typeof ConfigImportResultSchema>;
