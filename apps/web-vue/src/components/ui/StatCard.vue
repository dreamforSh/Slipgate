<script setup lang="ts">
import type { Tone } from "../../lib/format";
import UiIcon, { type IconName } from "./UiIcon.vue";

withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    icon?: IconName;
    tone?: Tone;
    mono?: boolean;
  }>(),
  { tone: "neutral", mono: true },
);

const iconTone: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-muted ring-line",
  accent: "bg-accent/10 text-accent ring-accent/20",
  success: "bg-success/10 text-success ring-success/20",
  warning: "bg-warning/10 text-warning ring-warning/20",
  danger: "bg-danger/10 text-danger ring-danger/20",
  info: "bg-info/10 text-info ring-info/20",
  violet: "bg-violet/10 text-violet ring-violet/20",
};
</script>

<template>
  <div class="card flex min-w-0 items-start justify-between gap-3 p-4">
    <div class="min-w-0">
      <p class="truncate text-xs font-medium text-fg-subtle">{{ label }}</p>
      <p
        class="mt-1.5 truncate text-lg font-semibold tracking-tight text-fg sm:text-xl"
        :class="mono ? 'font-mono tabular-nums' : ''"
      >
        {{ value }}
      </p>
      <p v-if="hint || $slots.hint" class="mt-1 truncate text-xs text-fg-subtle">
        <slot name="hint">{{ hint }}</slot>
      </p>
    </div>
    <span
      v-if="icon"
      class="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset sm:inline-flex"
      :class="iconTone[tone]"
    >
      <UiIcon :name="icon" :size="16" />
    </span>
  </div>
</template>
