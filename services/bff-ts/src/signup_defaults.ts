import type { PortalSettings } from "@slipgate/contracts";
import type { ControlStore } from "./store/types.ts";

/**
 * Applies default signup group grants and optional trial subscription configured in portal settings.
 * Failures due to stale/deleted groups never abort signup; invalid targets are skipped cleanly.
 */
export async function applySignupDefaults(
  store: ControlStore,
  userId: string,
  settings: PortalSettings,
  syncDataPlane?: () => Promise<void>,
): Promise<void> {
  const configuredGroups = [...new Set(settings.defaultSignupGroupIds.filter(Boolean))];
  const subGroupId = settings.defaultSignupSubGroupId.trim();
  const subDays = settings.defaultSignupSubDays;
  if (configuredGroups.length === 0 && !(subGroupId && subDays > 0)) return;

  const activeGroups = await store.listGroups(true).catch(() => []);
  const byId = new Map(activeGroups.map((g) => [g.id, g]));
  let synced = false;

  const validGroupIds = configuredGroups.filter((id) => byId.has(id));
  if (validGroupIds.length > 0) {
    try {
      const adminUser = await store.ops.getAdminUser(userId);
      const merged = [...new Set([...(adminUser?.allowedGroupIds ?? []), ...validGroupIds])];
      await store.ops.updateUser(userId, { allowedGroupIds: merged });
      synced = true;
    } catch {
      // Best-effort post-signup default; never fail user creation.
    }
  }

  if (subGroupId && subDays > 0) {
    const subGroup = byId.get(subGroupId);
    if (subGroup && subGroup.subscriptionType === "subscription") {
      try {
        await store.ops.assignSubscription(userId, subGroupId, subDays, "signup_trial", "signup_default");
        synced = true;
      } catch {
        // Best-effort post-signup trial grant.
      }
    }
  }

  if (synced) {
    await syncDataPlane?.().catch(() => undefined);
  }
}
