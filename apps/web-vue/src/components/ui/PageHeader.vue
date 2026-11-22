<script setup lang="ts">
defineProps<{
  title: string;
}>();
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <h1 class="text-2xl font-bold tracking-tight text-fg">{{ title }}</h1>
      <slot name="meta" />
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
