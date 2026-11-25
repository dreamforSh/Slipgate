import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { UsageOutcome, UsagePageResponse, UsageRow, UsageSummary } from "@slipgate/contracts";
import { apiJson, downloadFile, errorText, toQuery } from "../../lib/api";

export type UsageRange = "24h" | "7d" | "30d" | "custom";
export const USAGE_RANGES: UsageRange[] = ["24h", "7d", "30d", "custom"];

const RANGE_MS: Record<Exclude<UsageRange, "custom">, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export interface UsageFilters {
  range: UsageRange;
  /** `datetime-local` values (local wall time), only used when range is custom. */
  start: string;
  end: string;
  groupId: string;
  /** Substring of the public model name. */
  model: string;
  outcome: "" | UsageOutcome;
  /** Admin only. */
  userId: string;
  /** Self-service only. */
  apiKeyId: string;
}

export function blankUsageFilters(overrides: Partial<UsageFilters> = {}): UsageFilters {
  return { range: "7d", start: "", end: "", groupId: "", model: "", outcome: "", userId: "", apiKeyId: "", ...overrides };
}

/** Epoch ms → value for `<input type="datetime-local">` in local time. */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Server-paginated usage browsing shared by the admin and self-service pages. Text filters
 * are debounced; each request aborts the previous one and a sequence number guards against
 * a late response overwriting a newer one.
 */
export function useUsageLogs(options: { base: string; initial?: Partial<UsageFilters>; errorLoad: string; errorExport: string }) {
  const filters = ref<UsageFilters>(blankUsageFilters(options.initial));
  const page = ref(1);
  const pageSize = ref(20);

  const items = ref<UsageRow[]>([]);
  const total = ref(0);
  const summary = ref<UsageSummary | null>(null);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref<string | null>(null);
  const exporting = ref(false);

  /* Debounced copies of the free-text filters. */
  const textModel = ref(filters.value.model.trim());
  const textUser = ref(filters.value.userId.trim());
  let textTimer: number | undefined;
  watch(
    () => [filters.value.model, filters.value.userId] as const,
    ([model, userId]) => {
      window.clearTimeout(textTimer);
      textTimer = window.setTimeout(() => {
        textModel.value = model.trim();
        textUser.value = userId.trim();
      }, 300);
    },
  );

  const rangeInvalid = computed(() => {
    const f = filters.value;
    if (f.range !== "custom" || !f.start || !f.end) return false;
    return new Date(f.start).getTime() >= new Date(f.end).getTime();
  });

  /** Everything except paging; drives both the list and the CSV export. */
  const criteria = computed(() => {
    const f = filters.value;
    return {
      range: f.range,
      start: f.range === "custom" ? f.start : "",
      end: f.range === "custom" ? f.end : "",
      groupId: f.groupId,
      model: textModel.value,
      outcome: f.outcome,
      userId: textUser.value,
      apiKeyId: f.apiKeyId,
    };
  });

  /** Value-compared key: a fresh filters object with equal fields must not refetch. */
  const criteriaKey = computed(() => JSON.stringify(criteria.value));

  const hasFilters = computed(() => {
    const c = criteria.value;
    return Boolean(c.groupId || c.model || c.outcome || c.userId || c.apiKeyId || c.range === "custom");
  });

  /** Resolves the window at call time so "last 24h" always means now. */
  function params(): Record<string, string | undefined> {
    const c = criteria.value;
    let sinceIso: string | undefined;
    let untilIso: string | undefined;
    if (c.range === "custom") {
      sinceIso = localToIso(c.start);
      untilIso = localToIso(c.end);
    } else {
      sinceIso = new Date(Date.now() - RANGE_MS[c.range]).toISOString();
    }
    return {
      sinceIso,
      untilIso,
      groupId: c.groupId || undefined,
      model: c.model || undefined,
      outcome: c.outcome || undefined,
      userId: c.userId || undefined,
      apiKeyId: c.apiKeyId || undefined,
    };
  }

  let seq = 0;
  let controller: AbortController | null = null;

  /** Criteria the shown summary and total were computed for (paging within them reuses both). */
  let summarizedKey: string | null = null;

  /** Full reload: rows plus a fresh summary and total. */
  function load() {
    return fetchPage(false);
  }

  async function fetchPage(keepSummary: boolean) {
    if (rangeInvalid.value) return;
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    const id = ++seq;
    const key = criteriaKey.value;
    // Paging only needs the rows: skip the server's COUNT/SUM over every matching row.
    const reuse = keepSummary && summarizedKey === key && summary.value !== null;
    loading.value = true;
    error.value = null;
    try {
      const res = await apiJson<UsagePageResponse>(
        `${options.base}/query${toQuery({ ...params(), page: page.value, pageSize: pageSize.value, summary: reuse ? false : undefined })}`,
        { signal: ctrl.signal, fallbackError: options.errorLoad },
      );
      if (id !== seq) return;
      items.value = res.items;
      if (res.summary) {
        total.value = res.total;
        summary.value = res.summary;
        summarizedKey = key;
      }
      loaded.value = true;
      const lastPage = Math.max(1, Math.ceil(total.value / pageSize.value));
      if (page.value > lastPage) page.value = lastPage;
    } catch (err) {
      if (id !== seq || ctrl.signal.aborted) return;
      error.value = errorText(err, options.errorLoad);
    } finally {
      if (id === seq) loading.value = false;
    }
  }

  // Filter changes go back to page 1 (registered first so the page reset lands in the same flush).
  watch(criteriaKey, () => {
    page.value = 1;
  });
  watch([criteriaKey, page, pageSize], ([key], [prevKey]) => void fetchPage(key === prevKey));

  function reset(keep: Partial<UsageFilters> = {}) {
    window.clearTimeout(textTimer);
    filters.value = blankUsageFilters(keep);
    textModel.value = filters.value.model;
    textUser.value = filters.value.userId;
  }

  async function exportCsv(): Promise<boolean> {
    if (exporting.value || rangeInvalid.value) return false;
    exporting.value = true;
    error.value = null;
    try {
      await downloadFile(`${options.base}/export${toQuery(params())}`, "usage.csv");
      return true;
    } catch (err) {
      error.value = errorText(err, options.errorExport);
      return false;
    } finally {
      exporting.value = false;
    }
  }

  onBeforeUnmount(() => {
    window.clearTimeout(textTimer);
    controller?.abort();
  });

  return {
    filters,
    page,
    pageSize,
    items,
    total,
    summary,
    loading,
    loaded,
    error,
    exporting,
    rangeInvalid,
    hasFilters,
    /** Value-compared criteria key and the matching query params (the stats panel reuses both). */
    criteriaKey,
    params,
    load,
    reset,
    exportCsv,
  };
}
