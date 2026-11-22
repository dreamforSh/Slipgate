<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 32 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 32 32" aria-hidden="true" class="shrink-0">
    <rect width="32" height="32" rx="8" class="fill-accent" />
    <path
      d="M9 24V14a7 7 0 0 1 14 0v10"
      fill="none"
      class="stroke-accent-fg"
      stroke-width="2.6"
      stroke-linecap="round"
    />
    <path
      d="M13.5 24v-5h5v5"
      fill="none"
      class="stroke-accent-fg"
      stroke-width="2.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
