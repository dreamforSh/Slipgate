/**
 * "METHOD /route/pattern" → key under `audit.actions.*`. Routes not listed here fall back to
 * the raw pattern in the UI, so new admin endpoints still show up (just without a name).
 */
const A = "/api/v1/admin";

export const AUDIT_ACTION_KEYS: Record<string, string> = {
  [`POST ${A}/users`]: "userCreate",
  [`PATCH ${A}/users/:userId`]: "userUpdate",
  [`DELETE ${A}/users/:userId`]: "userDelete",
  [`POST ${A}/users/:userId/balance`]: "userBalance",
  [`POST ${A}/users/:userId/credit`]: "userCredit",
  [`POST ${A}/users/batch-status`]: "userBatchStatus",
  [`POST ${A}/users/batch-limits`]: "userBatchLimits",
  [`POST ${A}/users/batch-concurrency`]: "userBatchConcurrency",
  [`POST ${A}/users/batch-delete`]: "userBatchDelete",
  [`PUT ${A}/users/:userId/group-rates`]: "userGroupRates",
  [`PUT ${A}/users/:userId/platform-quotas`]: "userPlatformQuotasSave",
  [`DELETE ${A}/users/:userId/platform-quotas/:platform`]: "userPlatformQuotaDelete",
  [`POST ${A}/users/:userId/platform-quotas/:platform/reset`]: "userPlatformQuotaReset",
  [`POST ${A}/users/:userId/replace-group`]: "userReplaceGroup",
  [`PATCH ${A}/api-keys/:keyId`]: "apiKeyAdminUpdate",
  [`PUT ${A}/groups/:groupId/rate-multipliers`]: "groupRateMultipliers",
  [`DELETE ${A}/groups/:groupId/rate-multipliers`]: "groupRateMultipliersClear",
  [`PUT ${A}/groups/:groupId/rpm-overrides`]: "groupRpmOverrides",
  [`DELETE ${A}/groups/:groupId/rpm-overrides`]: "groupRpmOverridesClear",

  [`POST ${A}/groups`]: "groupCreate",
  [`PATCH ${A}/groups/:groupId`]: "groupUpdate",
  [`DELETE ${A}/groups/:groupId`]: "groupDelete",
  [`POST ${A}/groups/:groupId/duplicate`]: "groupDuplicate",

  [`POST ${A}/accounts`]: "accountCreate",
  [`PATCH ${A}/accounts/:accountId`]: "accountUpdate",
  [`DELETE ${A}/accounts/:accountId`]: "accountDelete",
  [`POST ${A}/accounts/:accountId/test`]: "accountTest",
  [`POST ${A}/accounts/batch-delete`]: "accountBatchDelete",
  [`POST ${A}/accounts/bulk-update`]: "accountBulkUpdate",
  [`POST ${A}/accounts/export`]: "accountExport",
  [`POST ${A}/accounts/import`]: "accountImport",

  [`POST ${A}/routes`]: "routeCreate",
  [`DELETE ${A}/routes/:routeId`]: "routeDelete",
  [`POST ${A}/routes/preview`]: "routePreview",

  [`POST ${A}/redeem-codes/generate`]: "redeemGenerate",
  [`POST ${A}/redeem-codes/batch`]: "redeemBatch",

  [`POST ${A}/promo-codes`]: "promoCreate",
  [`PATCH ${A}/promo-codes/:id`]: "promoUpdate",
  [`DELETE ${A}/promo-codes/:id`]: "promoDelete",

  [`POST ${A}/announcements`]: "announcementCreate",
  [`PUT ${A}/announcements/:id`]: "announcementUpdate",
  [`DELETE ${A}/announcements/:id`]: "announcementDelete",

  [`POST ${A}/audit-logs/clear`]: "auditClear",
  [`PUT ${A}/audit-logs/retention`]: "auditRetentionUpdate",
  [`POST ${A}/audit-logs/retention/run`]: "auditRetentionRun",

  [`POST ${A}/subscriptions/assign`]: "subscriptionAssign",
  [`POST ${A}/subscriptions/bulk`]: "subscriptionBulk",
  [`PATCH ${A}/subscriptions/:id`]: "subscriptionUpdate",
  [`DELETE ${A}/subscriptions/:id`]: "subscriptionDelete",

  [`PATCH ${A}/settings`]: "settingsUpdate",

  [`POST ${A}/clash/bindings`]: "clashBindingCreate",
  [`DELETE ${A}/clash/bindings/:accountId`]: "clashBindingDelete",
  [`POST ${A}/clash/subscriptions`]: "clashSubscriptionCreate",
  [`DELETE ${A}/clash/subscriptions/:id`]: "clashSubscriptionDelete",
  [`POST ${A}/clash/subscriptions/:id/sync`]: "clashSubscriptionSync",
  [`PATCH ${A}/clash/nodes/:id`]: "clashNodeUpdate",
  [`POST ${A}/clash/nodes/probe`]: "clashNodeProbe",
  [`POST ${A}/clash/nodes/:id/confirm-drift`]: "clashNodeConfirmDrift",
  [`POST ${A}/clash/test-outbound`]: "clashTestOutbound",

  [`POST ${A}/vms/nodes`]: "vmNodeCreate",
  [`DELETE ${A}/vms/nodes/:id`]: "vmNodeDelete",
  [`POST ${A}/vms/slots`]: "vmSlotCreate",
  [`DELETE ${A}/vms/slots/:id`]: "vmSlotDelete",
  [`POST ${A}/vms/slots/:id/start`]: "vmSlotStart",
  [`POST ${A}/vms/slots/:id/stop`]: "vmSlotStop",
  [`POST ${A}/vms/slots/:id/migrate`]: "vmSlotMigrate",
  [`POST ${A}/vms/slots/:id/terminal-ticket`]: "vmSlotTerminal",
  [`PATCH ${A}/vms/slots/:id/telemetry`]: "vmSlotTelemetry",
  [`PUT ${A}/vms/:slotId/seed`]: "vmSeed",
  [`PUT ${A}/vms/slots/:slotId/seed`]: "vmSeed",

  [`POST ${A}/tls-profiles`]: "tlsCreate",
  [`PUT ${A}/tls-profiles/:id`]: "tlsUpdate",
  [`DELETE ${A}/tls-profiles/:id`]: "tlsDelete",

  [`POST ${A}/ops/settlement-dead-letters/replay`]: "opsDeadLetterReplay",
  [`POST ${A}/ops/request-errors/:id/resolve`]: "opsRequestErrorResolve",
  [`POST ${A}/ops/request-errors/cleanup`]: "opsRequestErrorCleanup",
  [`POST ${A}/ops/alerts/rules`]: "opsAlertRuleCreate",
  [`PATCH ${A}/ops/alerts/rules/:id`]: "opsAlertRuleUpdate",
  [`DELETE ${A}/ops/alerts/rules/:id`]: "opsAlertRuleDelete",
  [`POST ${A}/ops/alerts/evaluate`]: "opsAlertEvaluate",
  [`POST ${A}/ops/alerts/events/:id/ack`]: "opsAlertEventAck",
  [`POST ${A}/ops/alerts/events/:id/resolve`]: "opsAlertEventResolve",
  [`POST ${A}/ops/alerts/silences`]: "opsAlertSilenceCreate",
  [`DELETE ${A}/ops/alerts/silences/:id`]: "opsAlertSilenceDelete",
  [`POST ${A}/channel-monitors`]: "channelMonitorCreate",
  [`PATCH ${A}/channel-monitors/:id`]: "channelMonitorUpdate",
  [`DELETE ${A}/channel-monitors/:id`]: "channelMonitorDelete",
  [`POST ${A}/channel-monitors/:id/run`]: "channelMonitorRun",

  [`PATCH ${A}/ops/usage-rollups/config`]: "opsRollupsConfig",
  [`PATCH ${A}/usage-rollups/config`]: "opsRollupsConfig",
  [`POST ${A}/usage-rollups/backfill`]: "opsRollupsBackfill",
  [`POST ${A}/usage-rollups/cleanup`]: "opsRollupsCleanup",
  [`PATCH ${A}/moderation/settings`]: "moderationSettingsUpdate",
  [`POST ${A}/moderation/rules`]: "moderationRuleCreate",
  [`PUT ${A}/moderation/rules/:id`]: "moderationRuleUpdate",
  [`DELETE ${A}/moderation/rules/:id`]: "moderationRuleDelete",
  [`POST ${A}/risk/unban`]: "riskUnban",
  [`POST ${A}/risk/clear-cache`]: "riskClearCache",

  [`PUT ${A}/affiliates/rates/:userId`]: "affiliateRateUpdate",
  [`POST ${A}/affiliates/withdrawals/:id/review`]: "affiliateWithdrawalReview",

  [`POST ${A}/system/update/sync`]: "systemUpdateSync",
  [`PUT ${A}/system/update/config`]: "systemUpdateConfig",
  [`POST ${A}/system/update/rollback`]: "systemUpdateRollback",
  [`POST ${A}/system/update/restart`]: "systemUpdateRestart",

  [`POST ${A}/user-attributes`]: "userAttrCreate",
  [`PATCH ${A}/user-attributes/:id`]: "userAttrUpdate",
  [`DELETE ${A}/user-attributes/:id`]: "userAttrDelete",
  [`PUT ${A}/users/:userId/attributes`]: "userAttrSetValues",
  [`POST ${A}/api-keys`]: "adminApiKeyCreate",
  [`DELETE ${A}/api-keys/:id`]: "adminApiKeyRevoke",
  [`POST ${A}/pages`]: "sitePageCreate",
  [`PATCH ${A}/pages/:id`]: "sitePageUpdate",
  [`DELETE ${A}/pages/:id`]: "sitePageDelete",
};

export function auditActionKey(method: string, route: string): string | null {
  return AUDIT_ACTION_KEYS[`${method.toUpperCase()} ${route}`] ?? null;
}
