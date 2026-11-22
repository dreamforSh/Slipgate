<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
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
  </label>
</template>
