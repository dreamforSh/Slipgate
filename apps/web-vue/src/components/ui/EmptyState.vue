<script setup lang="ts">
import UiIcon, { type IconName } from "./UiIcon.vue";

withDefaults(
  defineProps<{
    icon?: IconName;
    title: string;
    description?: string;
    compact?: boolean;
  }>(),
  { icon: "inbox", compact: false },
);
</script>

<template>
  <div class="flex flex-col items-center justify-center text-center" :class="compact ? 'px-4 py-8' : 'px-6 py-12'">
    <span
      class="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-fg-subtle ring-1 ring-inset ring-line"
    >
      <UiIcon :name="icon" :size="18" />
    </span>
    <p class="mt-3 text-sm font-medium text-fg">{{ title }}</p>
    <p v-if="description" class="mt-1 max-w-sm text-xs leading-relaxed text-fg-subtle">{{ description }}</p>
    <div v-if="$slots.default" class="mt-4 flex flex-wrap items-center justify-center gap-2">
      <slot />
    </div>
  </div>
</template>
