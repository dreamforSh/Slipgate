<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    hint?: string;
    required?: boolean;
  }>(),
  { required: false },
);
</script>

<template>
  <label class="block min-w-0">
    <span class="label">
      {{ label }}
      <span v-if="required" class="text-danger">*</span>
    </span>
    <slot />
    <span v-if="hint" class="hint block">{{ hint }}</span>
  </label>
</template>
