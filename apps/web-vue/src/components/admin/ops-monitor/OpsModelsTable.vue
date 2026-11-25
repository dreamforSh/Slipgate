<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { OpsOverview } from "@slipgate/contracts";
import { formatCompact, formatDurationMs, formatNumber, formatTokens } from "../../../lib/format";
import EmptyState from "../../ui/EmptyState.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { TONE_TEXT, errorRateTone, formatRate } from "./opsFormat";

/** Per-model traffic, error rate, latency and tokens. */
const props = defineProps<{ models: OpsOverview["models"] }>();

const { t } = useI18n();
const LIMIT = 8;
const expanded = ref(false);

const sorted = computed(() => [...props.models].sort((a, b) => b.requests - a.requests));
const rows = computed(() => (expanded.value ? sorted.value : sorted.value.slice(0, LIMIT)));
const maxRequests = computed(() => Math.max(1, ...props.models.map((m) => m.requests)));
</script>

<template>
  <UiCard icon="sparkles" :title="t('security.ops.models.title')" flush>
    <template #actions>
      <span class="font-mono text-xs tabular-nums text-fg-subtle">{{ models.length }}</span>
    </template>
    <EmptyState v-if="models.length === 0" compact icon="sparkles" :title="t('security.ops.models.empty')" />
    <template v-else>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("security.ops.models.model") }}</th>
              <th class="text-right">{{ t("security.ops.table.requests") }}</th>
              <th class="text-right">{{ t("security.ops.table.errorRate") }}</th>
              <th class="text-right">{{ t("security.ops.table.ttft") }}</th>
              <th class="text-right">{{ t("security.ops.table.durationP95") }}</th>
              <th class="text-right">{{ t("security.ops.table.tokens") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in rows" :key="m.model">
              <td class="max-w-[14rem]">
                <p class="truncate font-mono text-xs font-medium text-fg" :title="m.model">{{ m.model }}</p>
                <span class="mt-1 block h-1 overflow-hidden rounded-full bg-surface-2">
                  <span
                    class="block h-full rounded-full transition-[width] duration-500 ease-out"
                    :style="{ width: `${(m.requests / maxRequests) * 100}%`, background: 'rgb(var(--viz-1))' }"
                  />
                </span>
              </td>
              <td class="text-right font-mono text-xs tabular-nums" :title="formatNumber(m.requests)">{{ formatCompact(m.requests) }}</td>
              <td class="text-right font-mono text-xs font-medium tabular-nums" :class="TONE_TEXT[errorRateTone(m.errorRate, m.requests)]">
                {{ formatRate(m.errorRate) }}
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">{{ formatDurationMs(m.ttftP50) }}</td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">{{ formatDurationMs(m.durationP95) }}</td>
              <td class="text-right font-mono text-xs tabular-nums text-fg-muted" :title="formatNumber(m.tokens)">{{ formatTokens(m.tokens) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button
        v-if="models.length > LIMIT"
        type="button"
        class="flex w-full items-center justify-center gap-1 border-t border-line/70 py-2.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2/50 hover:text-fg"
        @click="expanded = !expanded"
      >
        {{ expanded ? t("security.ops.showLess") : t("security.ops.showAll", { n: models.length }) }}
        <UiIcon name="chevron-down" :size="13" class="transition-transform duration-200" :class="expanded ? 'rotate-180' : ''" />
      </button>
    </template>
  </UiCard>
</template>
