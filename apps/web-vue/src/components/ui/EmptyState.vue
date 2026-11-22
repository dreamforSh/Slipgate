<script setup lang="ts">
import UiIcon, { type IconName } from "./UiIcon.vue";

withDefaults(
  defineProps<{
    icon?: IconName;
    title: string;
    compact?: boolean;
  }>(),
  { icon: "inbox", compact: false },
);
</script>

<template>
  <div class="flex flex-col items-center justify-center text-center" :class="compact ? 'px-4 py-8' : 'px-6 py-14'">
    <span
      class="relative inline-flex items-center justify-center rounded-2xl bg-surface-2 text-fg-subtle ring-1 ring-inset ring-line"
      :class="compact ? 'h-11 w-11' : 'h-14 w-14'"
    >
      <span class="absolute inset-0 rounded-2xl bg-gradient-to-b from-accent/[0.06] to-transparent" aria-hidden="true" />
      <UiIcon :name="icon" :size="compact ? 20 : 24" :stroke-width="1.6" />
    </span>
    <p class="mt-4 text-sm font-semibold text-fg">{{ title }}</p>
    <div v-if="$slots.default" class="mt-5 flex flex-wrap items-center justify-center gap-2">
      <slot />
    </div>
  </div>
</template>
