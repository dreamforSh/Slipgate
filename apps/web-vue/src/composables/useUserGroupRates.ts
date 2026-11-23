import { computed, ref } from "vue";
import type { UserGroupRateItem, UserGroupRatesResponse } from "@slipgate/contracts";
import { apiJson, errorText } from "../lib/api";

/**
 * The signed-in user's effective rate per group and their caps (GET /api/v1/user/groups/rates).
 * `withEffectiveRates` swaps each group's list multiplier for what this user is billed, so key
 * pickers, forms and the model plaza show the user's own price.
 */
export function useUserGroupRates() {
  const data = ref<UserGroupRatesResponse | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** `fallbackError`: the (translated) message shown when the server gives none. */
  async function load(fallbackError: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      data.value = await apiJson<UserGroupRatesResponse>("/api/v1/user/groups/rates", { fallbackError });
    } catch (err) {
      error.value = errorText(err, fallbackError);
    } finally {
      loading.value = false;
    }
  }

  const byGroup = computed(() => new Map<string, UserGroupRateItem>((data.value?.items ?? []).map((i) => [i.groupId, i])));

  /** Groups with `rateMultiplier` replaced by this user's effective multiplier. */
  function withEffectiveRates<T extends { id: string; rateMultiplier: number }>(groups: T[]): T[] {
    const map = byGroup.value;
    if (map.size === 0) return groups;
    return groups.map((g) => {
      const r = map.get(g.id);
      return r && r.effectiveRateMultiplier !== g.rateMultiplier ? { ...g, rateMultiplier: r.effectiveRateMultiplier } : g;
    });
  }

  return { data, loading, error, load, byGroup, withEffectiveRates };
}
