<script setup lang="ts">
import { computed } from "vue";

/** Horizontal usage bar for basis-point (0–10000) or ratio values. */
const props = withDefaults(
  defineProps<{
    label?: string;
    /** Basis points 0–10000. Ignored when `max` is set. */
    bps?: number;
    value?: number;
    max?: number;
    /** Basis-point threshold above which the bar turns red (cooldown watermark). */
    dangerAt?: number;
    warnAt?: number;
  }>(),
  { dangerAt: 9500, warnAt: 7500 },
);

const ratioBps = computed(() => {
  if (props.max !== undefined) {
    return props.max > 0 ? Math.round(((props.value ?? 0) / props.max) * 10000) : 0;
  }
  return props.bps ?? 0;
});

const pct = computed(() => Math.min(100, Math.max(0, ratioBps.value / 100)));

const barClass = computed(() => {
  if (ratioBps.value >= props.dangerAt) return "bg-danger";
  if (ratioBps.value >= props.warnAt) return "bg-warning";
  return "bg-accent";
});

const text = computed(() =>
  props.max !== undefined ? `${props.value ?? 0}/${props.max}` : `${pct.value.toFixed(1)}%`,
);
</script>

<template>
  <div class="min-w-[5.5rem]">
    <div class="flex items-baseline justify-between gap-2 text-2xs">
      <span v-if="label" class="text-fg-subtle">{{ label }}</span>
      <span class="font-mono tabular-nums text-fg-muted">{{ text }}</span>
    </div>
    <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
      <div class="h-full rounded-full transition-[width] duration-500 ease-out" :class="barClass" :style="{ width: `${pct}%` }" />
    </div>
  </div>
</template>
