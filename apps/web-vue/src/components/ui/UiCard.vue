<script setup lang="ts">
import UiIcon, { type IconName } from "./UiIcon.vue";

withDefaults(
  defineProps<{
    title?: string;
    icon?: IconName;
    /** Remove body padding (for edge-to-edge tables). */
    flush?: boolean;
  }>(),
  { flush: false },
);
</script>

<template>
  <section class="card flex min-w-0 flex-col">
    <header
      v-if="title || $slots.header || $slots.actions"
      class="flex min-h-[3.5rem] flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line/70 px-5 py-3"
    >
      <slot name="header">
        <div class="flex min-w-0 items-center gap-3">
          <span v-if="icon" class="icon-chip icon-chip-accent h-8 w-8">
            <UiIcon :name="icon" :size="16" />
          </span>
          <h2 class="truncate text-sm font-semibold text-fg">{{ title }}</h2>
        </div>
      </slot>
      <div v-if="$slots.actions" class="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <div :class="flush ? '' : 'p-5'" class="min-w-0 flex-1">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="rounded-b-xl border-t border-line/70 bg-surface-2/40 px-5 py-3">
      <slot name="footer" />
    </footer>
  </section>
</template>
