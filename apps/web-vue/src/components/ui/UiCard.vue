<script setup lang="ts">
import UiIcon, { type IconName } from "./UiIcon.vue";

withDefaults(
  defineProps<{
    title?: string;
    description?: string;
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
      class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5"
    >
      <slot name="header">
        <div class="flex min-w-0 items-center gap-2.5">
          <span
            v-if="icon"
            class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted ring-1 ring-inset ring-line"
          >
            <UiIcon :name="icon" :size="15" />
          </span>
          <div class="min-w-0">
            <h2 class="truncate text-sm font-semibold text-fg">{{ title }}</h2>
            <p v-if="description" class="mt-0.5 truncate text-xs text-fg-subtle">{{ description }}</p>
          </div>
        </div>
      </slot>
      <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <div :class="flush ? '' : 'p-5'" class="min-w-0 flex-1">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="border-t border-line px-5 py-3">
      <slot name="footer" />
    </footer>
  </section>
</template>
