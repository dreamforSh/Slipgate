<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { UsageTotals } from "@slipgate/contracts";
import { formatDurationMs, formatNumber, formatTokens, formatUsd } from "../../lib/format";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";
import { RATE_TEXT, formatRate, rateTone } from "./health";

/** Usage totals for one period: cost as the headline, then requests, success, tokens and latency. */
const props = withDefaults(
  defineProps<{
    title: string;
    icon: IconName;
    totals: UsageTotals;
    chip?: string;
  }>(),
  { chip: "icon-chip-accent" },
);

const { t } = useI18n();

const successRate = computed(() => (props.totals.requests ? 1 - props.totals.errors / props.totals.requests : null));
const rows = computed(() => [
  { key: "req", label: t("public.keyUsage.totals.requests"), value: formatNumber(props.totals.requests), cls: "text-fg" },
  { key: "rate", label: t("public.keyUsage.totals.successRate"), value: formatRate(successRate.value), cls: RATE_TEXT[rateTone(successRate.value)] },
  { key: "in", label: t("public.keyUsage.totals.inputTokens"), value: formatTokens(props.totals.inputTokens), cls: "text-fg" },
  { key: "out", label: t("public.keyUsage.totals.outputTokens"), value: formatTokens(props.totals.outputTokens), cls: "text-fg" },
  { key: "cache", label: t("public.keyUsage.totals.cacheRead"), value: formatTokens(props.totals.cacheReadTokens), cls: "text-fg" },
  {
    key: "ttft",
    label: t("public.keyUsage.totals.ttft"),
    value: props.totals.avgTtftMs > 0 ? formatDurationMs(props.totals.avgTtftMs) : "—",
    cls: "text-fg",
  },
]);
</script>

<template>
  <div class="card flex min-w-0 flex-col p-5">
    <div class="flex items-center gap-2.5">
      <span class="icon-chip h-8 w-8" :class="chip"><UiIcon :name="icon" :size="16" /></span>
      <p class="text-sm font-semibold text-fg">{{ title }}</p>
    </div>
    <p class="mt-4 truncate text-[28px] font-semibold leading-9 tracking-tight tabular-nums text-fg">{{ formatUsd(totals.costNanoUsd) }}</p>
    <p class="text-xs text-fg-subtle">{{ t("public.keyUsage.totals.cost") }}</p>
    <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line/70 pt-4">
      <div v-for="r in rows" :key="r.key" class="min-w-0">
        <dt class="truncate text-2xs text-fg-subtle">{{ r.label }}</dt>
        <dd class="mt-0.5 truncate text-sm font-medium tabular-nums" :class="r.cls">{{ r.value }}</dd>
      </div>
    </dl>
  </div>
</template>
