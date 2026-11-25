<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { USAGE_RANK_LIMITS, type UsageRankBy, type UsageStatsResponse } from "@slipgate/contracts";
import EmptyState from "../ui/EmptyState.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiSelect from "../ui/UiSelect.vue";
import { formatNumber, formatTokens, formatUsd, nanoToUsd } from "../../lib/format";

/**
 * sub2api "user ranking" tab of the usage page: the top users of the list's filters by requests,
 * tokens or spend (header click; a toggle on phones, which only show the ranked column), top
 * 10-100. Picking a user narrows the request list to them.
 */
const props = defineProps<{
  stats: UsageStatsResponse | null;
  loading: boolean;
}>();
const rankBy = defineModel<UsageRankBy>("rankBy", { required: true });
const rankLimit = defineModel<number>("rankLimit", { required: true });
const emit = defineEmits<{ (e: "select-user", userId: string): void }>();

const { t } = useI18n();

const users = computed(() => props.stats?.users ?? []);
const totals = computed(() => props.stats?.totals ?? null);

const tokensOf = (r: { inputTokens: number; outputTokens: number }) => r.inputTokens + r.outputTokens;
function valueOf(r: { requests: number; inputTokens: number; outputTokens: number; costNanoUsd: string }, by: UsageRankBy): number {
  if (by === "requests") return r.requests;
  if (by === "cost") return nanoToUsd(r.costNanoUsd);
  return tokensOf(r);
}
/** Share of the ranked metric over every matching row (not just the listed users). */
function shareOf(r: Parameters<typeof valueOf>[0]): string {
  const total = totals.value ? valueOf(totals.value, rankBy.value) : 0;
  if (total <= 0) return "—";
  const share = valueOf(r, rankBy.value) / total;
  return `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;
}

const sortable: { key: UsageRankBy; label: string }[] = [
  { key: "requests", label: "usageLogs.ranking.columns.requests" },
  { key: "tokens", label: "usageLogs.ranking.columns.tokens" },
  { key: "cost", label: "usageLogs.ranking.columns.cost" },
];
const sortableLabel = (key: UsageRankBy) => t(sortable.find((s) => s.key === key)!.label);
const sortOptions = computed(() => sortable.map((s) => ({ value: s.key, label: t(s.label) })));
/** Phones keep only the ranked metric of the three sortable columns. */
const metricCell = (key: UsageRankBy) => (rankBy.value === key ? "" : "hidden sm:table-cell");

const RANK_BADGE = [
  "bg-[rgb(var(--viz-4)/0.18)] text-fg",
  "bg-[rgb(var(--fg-subtle)/0.18)] text-fg",
  "bg-[rgb(var(--viz-2)/0.16)] text-fg",
];
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-5 py-2.5">
      <p class="text-xs text-fg-subtle">{{ t("usageLogs.ranking.subtitle", { by: sortableLabel(rankBy) }) }}</p>
      <div class="flex flex-wrap items-center gap-3">
        <SegmentedControl v-model="rankBy" class="sm:hidden" :options="sortOptions" :aria-label="t('usageLogs.ranking.sortBy')" />
        <span v-if="stats" class="text-xs tabular-nums text-fg-subtle">{{ t("usageLogs.ranking.userCount", { n: formatNumber(stats.userCount) }) }}</span>
        <UiSelect
          class="select input-sm w-auto"
          :aria-label="t('usageLogs.ranking.limit')"
          :model-value="String(rankLimit)"
          @change="rankLimit = Number($event)"
        >
          <option v-for="n in USAGE_RANK_LIMITS" :key="n" :value="String(n)">{{ t("usageLogs.ranking.top", { n }) }}</option>
        </UiSelect>
      </div>
    </div>

    <div v-if="!stats && loading" class="divide-y divide-line/60" aria-busy="true">
      <div v-for="i in 6" :key="i" class="flex animate-pulse items-center gap-4 px-5 py-3.5">
        <span class="h-6 w-6 rounded-full bg-surface-2" />
        <span class="h-3 flex-1 rounded bg-surface-2" />
        <span class="h-3 w-16 rounded bg-surface-2" />
        <span class="h-3 w-16 rounded bg-surface-2" />
      </div>
    </div>
    <EmptyState v-else-if="!users.length" compact icon="users" :title="t('usageLogs.ranking.empty')" />
    <div v-else class="table-wrap transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
      <table class="data-table">
        <thead>
          <tr>
            <th class="w-12">#</th>
            <th>{{ t("usageLogs.ranking.columns.user") }}</th>
            <th v-for="col in sortable.slice(0, 1)" :key="col.key" class="text-right" :class="metricCell(col.key)" :aria-sort="rankBy === col.key ? 'descending' : 'none'">
              <button type="button" class="inline-flex items-center gap-1 hover:text-fg" :class="rankBy === col.key ? 'text-fg' : ''" @click="rankBy = col.key">
                {{ t(col.label) }}<span v-if="rankBy === col.key" aria-hidden="true">↓</span>
              </button>
            </th>
            <th class="hidden text-right md:table-cell">{{ t("usageLogs.ranking.columns.input") }}</th>
            <th class="hidden text-right md:table-cell">{{ t("usageLogs.ranking.columns.output") }}</th>
            <th class="hidden text-right lg:table-cell">{{ t("usageLogs.ranking.columns.cacheRead") }}</th>
            <th v-for="col in sortable.slice(1)" :key="col.key" class="text-right" :class="metricCell(col.key)" :aria-sort="rankBy === col.key ? 'descending' : 'none'">
              <button type="button" class="inline-flex items-center gap-1 hover:text-fg" :class="rankBy === col.key ? 'text-fg' : ''" @click="rankBy = col.key">
                {{ t(col.label) }}<span v-if="rankBy === col.key" aria-hidden="true">↓</span>
              </button>
            </th>
            <th class="text-right">{{ t("usageLogs.ranking.columns.share") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(u, i) in users" :key="u.userId">
            <td>
              <span
                v-if="i < 3"
                class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums"
                :class="RANK_BADGE[i]"
              >{{ i + 1 }}</span>
              <span v-else class="inline-block w-6 text-center font-mono text-xs tabular-nums text-fg-subtle">{{ i + 1 }}</span>
            </td>
            <td class="max-w-[8rem] sm:max-w-[16rem]">
              <button
                type="button"
                class="block max-w-full truncate text-left text-sm text-fg hover:text-accent focus-visible:text-accent focus-visible:outline-none"
                :title="t('usageLogs.ranking.rowHint')"
                @click="emit('select-user', u.userId)"
              >
                {{ u.email || u.userId }}
              </button>
              <span v-if="u.email" class="block truncate font-mono text-2xs text-fg-subtle">{{ u.userId }}</span>
            </td>
            <td class="text-right font-mono text-xs tabular-nums" :class="[metricCell('requests'), rankBy === 'requests' ? 'font-medium text-fg' : 'text-fg-muted']">
              {{ formatNumber(u.requests) }}
            </td>
            <td class="hidden text-right font-mono text-xs tabular-nums text-fg-muted md:table-cell">{{ formatTokens(u.inputTokens) }}</td>
            <td class="hidden text-right font-mono text-xs tabular-nums text-fg-muted md:table-cell">{{ formatTokens(u.outputTokens) }}</td>
            <td class="hidden text-right font-mono text-xs tabular-nums text-fg-muted lg:table-cell">{{ formatTokens(u.cacheReadTokens) }}</td>
            <td class="text-right font-mono text-xs tabular-nums" :class="[metricCell('tokens'), rankBy === 'tokens' ? 'font-medium text-fg' : 'text-fg-muted']">
              {{ formatTokens(tokensOf(u)) }}
            </td>
            <td class="text-right font-mono text-xs tabular-nums" :class="[metricCell('cost'), rankBy === 'cost' ? 'font-medium text-fg' : 'text-fg-muted']">
              {{ formatUsd(u.costNanoUsd) }}
            </td>
            <td class="text-right font-mono text-xs tabular-nums text-fg-muted">{{ shareOf(u) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
