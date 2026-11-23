import type { ConfigBackupFile, ConfigBackupSection } from "@slipgate/contracts";
import type { IconName } from "../../ui/icons";

/** How the server applies a section: merge skips existing items, replace overwrites a setting. */
export type SectionMode = "merge" | "replace";

export interface BackupSectionMeta {
  key: ConfigBackupSection;
  icon: IconName;
  mode: SectionMode;
}

/** Sections in the order the server restores them (groups before what refers to them). */
export const BACKUP_SECTIONS: BackupSectionMeta[] = [
  { key: "portalSettings", icon: "settings", mode: "replace" },
  { key: "groups", icon: "layers", mode: "merge" },
  { key: "compositeRoutes", icon: "route", mode: "merge" },
  { key: "paymentPlans", icon: "credit-card", mode: "merge" },
  { key: "promoCodes", icon: "ticket", mode: "merge" },
  { key: "announcements", icon: "megaphone", mode: "merge" },
  { key: "pricingRules", icon: "percent", mode: "merge" },
  { key: "autoTest", icon: "clock", mode: "replace" },
  { key: "plugins", icon: "plug", mode: "replace" },
];

/** Never part of a configuration backup (shown next to the sections above). */
export const NEVER_BACKED_UP = ["users", "wallets", "apiKeys", "credentials", "secrets"] as const;

/** Items of a section in a backup file (settings-like sections count as 0 or 1). */
export function sectionCount(file: ConfigBackupFile, key: ConfigBackupSection): number {
  switch (key) {
    case "portalSettings":
      return file.portalSettings ? 1 : 0;
    case "groups":
      return file.groups.length;
    case "compositeRoutes":
      return file.compositeRoutes.length;
    case "paymentPlans":
      return file.paymentPlans.length;
    case "promoCodes":
      return file.promoCodes.length;
    case "announcements":
      return file.announcements.length;
    case "pricingRules":
      return file.pricingRules.length;
    case "autoTest":
      return file.autoTest ? 1 : 0;
    case "plugins":
      return file.disabledPlugins.length;
    default:
      return 0;
  }
}

/** Whether importing the section would do anything (plugin switches always apply, even "all on"). */
export function sectionAvailable(file: ConfigBackupFile, key: ConfigBackupSection): boolean {
  return key === "plugins" || sectionCount(file, key) > 0;
}
