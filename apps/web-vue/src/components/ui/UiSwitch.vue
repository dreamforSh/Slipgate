<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue: boolean;
    label?: string;
    disabled?: boolean;
    tone?: "accent" | "success";
    /** Keep `label` for screen readers only. */
    hideLabel?: boolean;
  }>(),
  { disabled: false, tone: "success", hideLabel: false },
);

const emit = defineEmits<{ (e: "update:modelValue", value: boolean): void }>();
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    class="inline-flex cursor-pointer items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      class="relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-200"
      :class="modelValue ? (tone === 'success' ? 'bg-success' : 'bg-accent') : 'bg-surface-3 ring-1 ring-inset ring-line-strong'"
    >
      <span
        class="inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out"
        :class="modelValue ? 'translate-x-[15px]' : 'translate-x-[2px]'"
      />
    </span>
    <span v-if="(label || $slots.default) && !hideLabel" class="whitespace-nowrap text-xs text-fg-muted"><slot>{{ label }}</slot></span>
  </button>
</template>
