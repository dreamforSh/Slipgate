<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { UsageSummary } from "@slipgate/contracts";
import StatCard from "../ui/StatCard.vue";
import { formatCompact, formatDurationMs, formatTokens, formatUsd, type Tone } from "../../lib/format";

/** Totals for the current filters: requests, success rate, tokens, cost and latency. */
const props = defineProps<{ summary: UsageSummary | null }>();

const { t } = useI18n();

const s = computed(() => props.summary);

const successRate = computed(() => {
  const v = s.value;
  if (!v || v.requests === 0) return null;
  return (v.requests - v.errors) / v.requests;
});

const rateTone = computed<Tone>(() => {
  const r = successRate.value;
  if (r === null) return "neutral";
  if (r >= 0.98) return "success";
  if (r >= 0.9) return "warning";
  return "danger";
});

const rateText = computed(() => {
  const r = successRate.value;
  if (r === null) return "—";
  const pct = r * 100;
  return `${pct >= 99.95 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
});

const cards = computed(() => {
  const v = s.value;
  const dash = "—";
  return [
    {
      key: "requests",
      label: t("usageLogs.summary.requests"),
      value: v ? formatCompact(v.requests) : dash,
      hint: v ? (v.errors ? t("usageLogs.summary.errors", { n: formatCompact(v.errors) }) : t("usageLogs.summary.noErrors")) : "",
      icon: "activity" as const,
      tone: "accent" as Tone,
    },
    {
      key: "rate",
      label: t("usageLogs.summary.successRate"),
      value: rateText.value,
      hint: "",
      icon: "check-circle" as const,
      tone: rateTone.value,
    },
    {
      key: "tokens",
      label: t("usageLogs.summary.tokens"),
      value: v ? formatTokens(v.inputTokens + v.outputTokens) : dash,
      hint: v ? t("usageLogs.summary.tokensDetail", { input: formatTokens(v.inputTokens), output: formatTokens(v.outputTokens) }) : "",
      icon: "database" as const,
      tone: "info" as Tone,
    },
    {
      key: "cost",
      label: t("usageLogs.summary.cost"),
      value: v ? formatUsd(v.costNanoUsd) : dash,
      hint: t("usageLogs.summary.costHint"),
      icon: "wallet" as const,
      tone: "violet" as Tone,
    },
    {
      key: "ttft",
      label: t("usageLogs.summary.ttft"),
      value: v && v.avgTtftMs > 0 ? formatDurationMs(v.avgTtftMs) : dash,
      hint: "",
      icon: "zap" as const,
      tone: "warning" as Tone,
    },
    {
      key: "duration",
      label: t("usageLogs.summary.duration"),
      value: v && v.avgDurationMs > 0 ? formatDurationMs(v.avgDurationMs) : dash,
      hint: "",
      icon: "clock" as const,
      tone: "neutral" as Tone,
    },
  ];
});

const cacheText = computed(() => {
  const v = s.value;
  if (!v || v.cacheReadTokens + v.cacheWriteTokens === 0) return "";
  return t("usageLogs.summary.cache", { read: formatTokens(v.cacheReadTokens), write: formatTokens(v.cacheWriteTokens) });
});
</script>

<template>
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-6">
    <StatCard
      v-for="(c, i) in cards"
      :key="c.key"
      class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
      :style="{ animationDelay: `${i * 40}ms` }"
      :label="c.label"
      :value="c.value"
      :icon="c.icon"
      :tone="c.tone"
      mono
    >
      <template v-if="c.key === 'tokens' && cacheText" #hint>
        <span class="block truncate" :title="cacheText">{{ c.hint }}</span>
        <span class="block truncate text-fg-subtle/80">{{ cacheText }}</span>
      </template>
      <template v-else-if="c.hint" #hint>{{ c.hint }}</template>
    </StatCard>
  </div>
</template>
