<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { SubscriptionLimits, SubscriptionUsage } from "@slipgate/contracts";
import { formatUsd } from "../../../lib/format";
import { cappedWindows } from "./subscriptionDisplay";

/** Per-window "$used / $limit" meters for capped windows only; "∞" when nothing is capped. */
const props = defineProps<{
  limits: SubscriptionLimits;
  usage: SubscriptionUsage;
}>();

const { t } = useI18n();

const windows = computed(() => cappedWindows(props.limits, props.usage));

// Bars grow from zero on first paint so the width transition reads as motion.
const ready = ref(false);
onMounted(() => requestAnimationFrame(() => (ready.value = true)));

const BAR: Record<string, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};
const TEXT: Record<string, string> = {
  success: "text-fg-muted",
  warning: "text-warning",
  danger: "text-danger",
};
</script>

<template>
  <div v-if="windows.length === 0" class="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
    <span class="text-base leading-none" aria-hidden="true">∞</span>
    {{ t("subscriptions.table.unlimited") }}
  </div>
  <div v-else class="w-44 space-y-1.5">
    <div v-for="w in windows" :key="w.key" :title="`${w.pct.toFixed(1)}%`">
      <div class="flex items-baseline justify-between gap-2 text-2xs">
        <span class="font-medium text-fg-subtle">{{ t(`subscriptions.windows.${w.key}`) }}</span>
        <span class="font-mono tabular-nums" :class="TEXT[w.tone]">
          {{ formatUsd(w.usedNano) }} / {{ formatUsd(w.limitNano) }}
        </span>
      </div>
      <div
        class="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        :aria-valuenow="Math.round(w.pct)"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="t(`subscriptions.windows.${w.key}`)"
      >
        <div
          class="h-full rounded-full transition-[width,background-color] duration-700 ease-out"
          :class="BAR[w.tone]"
          :style="{ width: ready ? `${Math.min(100, Math.max(w.pct > 0 ? 2 : 0, w.pct))}%` : '0%' }"
        />
      </div>
    </div>
  </div>
</template>
