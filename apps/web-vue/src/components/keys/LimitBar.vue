<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { formatUsd } from "../../lib/format";
import { ratioTone, usageRatio } from "./keyLimits";

/** Spend vs cap for one key limit (nano-USD strings). A 0 cap reads "unlimited" with no bar. */
const props = withDefaults(
  defineProps<{
    label?: string;
    used: string;
    limit: string;
    /** Thinner bar and tighter text for table cells. */
    compact?: boolean;
  }>(),
  { compact: false },
);

const { t } = useI18n();

const ratio = computed(() => usageRatio(props.used, props.limit));
const tone = computed(() => ratioTone(ratio.value));

// Grow from 0 on first paint so the bar eases in; later changes animate via the width transition.
const ready = ref(false);
onMounted(() => requestAnimationFrame(() => (ready.value = true)));

const width = computed(() => `${ready.value ? Math.min(100, Math.max(ratio.value ? 2 : 0, (ratio.value ?? 0) * 100)) : 0}%`);
const barClass = { accent: "bg-accent", warning: "bg-warning", danger: "bg-danger" };
const textClass = { accent: "text-fg-muted", warning: "text-warning", danger: "text-danger" };
const pctText = computed(() => (ratio.value === null ? "" : `${Math.round(ratio.value * 100)}%`));
</script>

<template>
  <div class="min-w-0" :title="ratio === null ? undefined : pctText">
    <div class="flex items-baseline justify-between gap-2" :class="compact ? 'text-2xs' : 'text-xs'">
      <span v-if="label" class="truncate text-fg-subtle">{{ label }}</span>
      <span class="ml-auto shrink-0 font-mono tabular-nums" :class="textClass[tone]">
        {{ formatUsd(used) }}
        <template v-if="ratio !== null">
          <span class="text-fg-subtle">/ {{ formatUsd(limit) }}</span>
        </template>
        <span v-else class="font-sans text-fg-subtle">· {{ t("user.keys.unlimited") }}</span>
      </span>
    </div>
    <div
      v-if="ratio !== null"
      class="overflow-hidden rounded-full bg-surface-3"
      :class="compact ? 'mt-1 h-1' : 'mt-1.5 h-1.5'"
      role="meter"
      :aria-valuenow="Math.round((ratio ?? 0) * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="label"
    >
      <div class="h-full rounded-full transition-[width] duration-700 ease-out" :class="barClass[tone]" :style="{ width }" />
    </div>
  </div>
</template>
