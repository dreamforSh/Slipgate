import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { UsageRankBy, UsageStatsResponse } from "@slipgate/contracts";
import { apiJson, errorText, toQuery } from "../../lib/api";

/**
 * Admin usage page charts and user ranking (`GET {base}/stats`) over the same criteria as the
 * request list. Refetches when the criteria, the bucket size or the ranking options change; each
 * request aborts the previous one and a sequence number drops late responses.
 */
export function useUsageStats(options: {
  base: string;
  criteriaKey: Ref<string>;
  params: () => Record<string, string | undefined>;
  rangeInvalid: Ref<boolean>;
  errorLoad: string;
}) {
  const stats = ref<UsageStatsResponse | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** Bucket size hint; undefined lets the server pick (hourly up to two days). */
  const granularity = ref<"hour" | "day" | undefined>(undefined);
  const rankBy = ref<UsageRankBy>("tokens");
  const rankLimit = ref(20);

  let seq = 0;
  let controller: AbortController | null = null;

  async function load() {
    if (options.rangeInvalid.value) return;
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    const id = ++seq;
    loading.value = true;
    error.value = null;
    try {
      const res = await apiJson<UsageStatsResponse>(
        `${options.base}/stats${toQuery({
          ...options.params(),
          granularity: granularity.value,
          rankBy: rankBy.value,
          rankLimit: rankLimit.value,
          tz: new Date().getTimezoneOffset(),
        })}`,
        { signal: ctrl.signal, fallbackError: options.errorLoad },
      );
      if (id !== seq) return;
      stats.value = res;
    } catch (err) {
      if (id !== seq || ctrl.signal.aborted) return;
      error.value = errorText(err, options.errorLoad);
    } finally {
      if (id === seq) loading.value = false;
    }
  }

  watch([options.criteriaKey, granularity, rankBy, rankLimit], () => void load());
  onBeforeUnmount(() => controller?.abort());

  return { stats, loading, error, granularity, rankBy, rankLimit, load };
}
