<script setup lang="ts">
import { computed } from "vue";

/** Ranked horizontal bars (magnitude, single hue). Value sits at the row end; details on hover/focus. */
export interface BarListItem {
  key: string;
  label: string;
  value: number;
  valueText: string;
  /** Secondary facts shown under the label and in the hover title. */
  meta?: string;
}

const props = defineProps<{ items: BarListItem[] }>();

const max = computed(() => Math.max(0, ...props.items.map((i) => i.value)));
const total = computed(() => props.items.reduce((s, i) => s + i.value, 0));

function pct(v: number) {
  return max.value > 0 ? Math.max(2, (v / max.value) * 100) : 0;
}
function share(v: number) {
  return total.value > 0 ? `${((v / total.value) * 100).toFixed(1)}%` : "0%";
}
</script>

<template>
  <ul class="space-y-1">
    <li
      v-for="(item, idx) in items"
      :key="item.key"
      tabindex="0"
      class="group rounded-lg px-2 py-2 outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2/60"
      :title="[item.label, item.valueText, share(item.value), item.meta].filter(Boolean).join(' · ')"
    >
      <div class="flex items-baseline justify-between gap-3 text-xs">
        <span class="flex min-w-0 items-baseline gap-2">
          <span class="w-4 shrink-0 text-right tabular-nums text-fg-subtle">{{ idx + 1 }}</span>
          <span class="truncate font-medium text-fg">{{ item.label }}</span>
        </span>
        <span class="shrink-0 tabular-nums">
          <span class="font-semibold text-fg">{{ item.valueText }}</span>
          <span class="ml-1.5 text-fg-subtle">{{ share(item.value) }}</span>
        </span>
      </div>
      <div class="ml-6 mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          class="h-full rounded-full transition-[width] duration-500 ease-out"
          :style="{ width: `${pct(item.value)}%`, background: 'rgb(var(--viz-1))' }"
        />
      </div>
      <p v-if="item.meta" class="ml-6 mt-1 truncate text-2xs text-fg-subtle">{{ item.meta }}</p>
    </li>
  </ul>
</template>
