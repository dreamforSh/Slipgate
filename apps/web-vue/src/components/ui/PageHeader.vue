<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
}>();
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
    <div class="min-w-0">
      <h1 class="text-xl font-semibold tracking-tight text-fg">{{ title }}</h1>
      <p v-if="description" class="mt-1 max-w-3xl text-sm text-fg-muted">{{ description }}</p>
      <div v-if="$slots.meta" class="mt-2.5 flex flex-wrap items-center gap-2">
        <slot name="meta" />
      </div>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
