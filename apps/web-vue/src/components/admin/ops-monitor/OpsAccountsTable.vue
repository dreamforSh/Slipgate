<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { OpsOverview } from "@slipgate/contracts";
import { formatCompact, formatDurationMs, formatNumber } from "../../../lib/format";
import PlatformIcon from "../../ui/PlatformIcon.vue";
import EmptyState from "../../ui/EmptyState.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { TONE_BG, TONE_TEXT, errorRateTone, formatRate } from "./opsFormat";

/** Per-upstream-account traffic with error-rate highlighting (worst offenders first on demand). */
const props = defineProps<{ accounts: OpsOverview["accounts"] }>();

const { t } = useI18n();
const LIMIT = 8;
const expanded = ref(false);
const sortBy = ref<"requests" | "errorRate">("requests");

const sorted = computed(() =>
  [...props.accounts].sort((a, b) =>
    sortBy.value === "errorRate" ? b.errorRate - a.errorRate || b.errors - a.errors : b.requests - a.requests,
  ),
);
const rows = computed(() => (expanded.value ? sorted.value : sorted.value.slice(0, LIMIT)));
</script>

<template>
  <UiCard icon="server" :title="t('security.ops.accounts.title')" flush>
    <template #actions>
      <div v-if="accounts.length > 1" class="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5 text-2xs">
        <button
          v-for="opt in (['requests', 'errorRate'] as const)"
          :key="opt"
          type="button"
          class="rounded-md px-2 py-1 font-medium transition-colors"
          :class="sortBy === opt ? 'bg-surface text-fg shadow-sm dark:bg-surface-3' : 'text-fg-subtle hover:text-fg'"
          :aria-pressed="sortBy === opt"
          @click="sortBy = opt"
        >
          {{ t(`security.ops.accounts.sort.${opt}`) }}
        </button>
      </div>
    </template>
    <EmptyState v-if="accounts.length === 0" compact icon="server" :title="t('security.ops.accounts.empty')" />
    <template v-else>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("security.ops.accounts.account") }}</th>
              <th class="text-right">{{ t("security.ops.table.requests") }}</th>
              <th class="text-right">{{ t("security.ops.table.errors") }}</th>
              <th class="min-w-[8rem]">{{ t("security.ops.table.errorRate") }}</th>
              <th class="text-right">{{ t("security.ops.table.ttft") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in rows" :key="a.accountId" :class="errorRateTone(a.errorRate, a.requests) === 'danger' ? '!bg-danger/[0.04]' : ''">
              <td class="max-w-[14rem]">
                <div class="flex min-w-0 items-center gap-2">
                  <PlatformIcon :platform="a.platform" :size="14" />
                  <span class="truncate font-medium text-fg" :title="a.name">{{ a.name }}</span>
                </div>
              </td>
              <td class="text-right font-mono text-xs tabular-nums" :title="formatNumber(a.requests)">{{ formatCompact(a.requests) }}</td>
              <td class="text-right font-mono text-xs tabular-nums" :class="a.errors > 0 ? 'text-danger' : 'text-fg-subtle'">
                {{ formatCompact(a.errors) }}
              </td>
              <td>
                <div class="flex items-center gap-2">
                  <span class="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <span
                      class="block h-full rounded-full transition-[width] duration-500 ease-out"
                      :class="TONE_BG[errorRateTone(a.errorRate, a.requests)]"
                      :style="{ width: `${Math.min(100, Math.max(a.errorRate > 0 ? 4 : 0, a.errorRate * 100))}%` }"
                    />
                  </span>
                  <span class="font-mono text-xs font-medium tabular-nums" :class="TONE_TEXT[errorRateTone(a.errorRate, a.requests)]">
                    {{ formatRate(a.errorRate) }}
                  </span>
                </div>
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">{{ formatDurationMs(a.ttftP50) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button
        v-if="accounts.length > LIMIT"
        type="button"
        class="flex w-full items-center justify-center gap-1 border-t border-line/70 py-2.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2/50 hover:text-fg"
        @click="expanded = !expanded"
      >
        {{ expanded ? t("security.ops.showLess") : t("security.ops.showAll", { n: accounts.length }) }}
        <UiIcon name="chevron-down" :size="13" class="transition-transform duration-200" :class="expanded ? 'rotate-180' : ''" />
      </button>
    </template>
  </UiCard>
</template>
