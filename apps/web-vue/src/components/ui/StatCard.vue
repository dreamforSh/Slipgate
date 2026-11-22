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
  neutral: "",
  accent: "icon-chip-accent",
  success: "icon-chip-success",
  warning: "icon-chip-warning",
  danger: "icon-chip-danger",
  info: "icon-chip-info",
  violet: "icon-chip-violet",
};
</script>

<template>
  <div class="card flex min-w-0 flex-col p-4">
    <div class="flex min-w-0 items-center gap-2.5">
      <span v-if="icon" class="icon-chip h-7 w-7" :class="iconTone[tone]">
        <UiIcon :name="icon" :size="15" />
      </span>
      <p class="truncate text-xs font-medium text-fg-subtle">{{ label }}</p>
    </div>
    <p
      class="mt-3 truncate text-[26px] font-semibold leading-8 tracking-tight text-fg"
      :class="mono ? 'tabular-nums' : ''"
    >
      {{ value }}
    </p>
    <p v-if="hint || $slots.hint" class="mt-1 truncate text-xs text-fg-subtle">
      <slot name="hint">{{ hint }}</slot>
    </p>
  </div>
</template>
