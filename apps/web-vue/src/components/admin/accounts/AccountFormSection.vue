<script setup lang="ts">
import UiIcon from "../../ui/UiIcon.vue";
import type { IconName } from "../../ui/icons";

/** One titled block of the account form: icon chip, eyebrow title, optional tag and a hairline rule. */
defineProps<{
  title: string;
  icon: IconName;
  /** Small muted tag after the title (e.g. "Optional"). */
  tag?: string;
}>();
</script>

<template>
  <section class="space-y-4">
    <header class="flex items-center gap-2">
      <span class="icon-chip icon-chip-accent h-6 w-6" aria-hidden="true"><UiIcon :name="icon" :size="13" /></span>
      <h3 class="eyebrow text-fg-muted">{{ title }}</h3>
      <span v-if="tag" class="rounded-full bg-surface-2 px-1.5 py-px text-2xs font-medium text-fg-subtle">{{ tag }}</span>
      <span class="h-px min-w-4 flex-1 bg-line/70" aria-hidden="true" />
    </header>
    <slot />
  </section>
</template>
