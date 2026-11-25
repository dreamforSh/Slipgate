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
    class="group inline-flex cursor-pointer items-center gap-2 rounded-full disabled:cursor-not-allowed disabled:opacity-50"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      class="relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-[background-color,box-shadow] duration-200"
      :class="
        modelValue
          ? tone === 'success'
            ? 'bg-success shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)]'
            : 'bg-accent shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)]'
          : 'bg-surface-3 ring-1 ring-inset ring-line-strong'
      "
    >
      <!-- The knob stretches toward its destination while pressed, then springs across. -->
      <span
        class="inline-block h-3.5 w-3.5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-[transform,width] duration-300 ease-spring group-active:w-[18px] motion-reduce:transition-none"
        :class="modelValue ? 'translate-x-[15px] group-active:translate-x-[11px]' : 'translate-x-[2px]'"
      />
    </span>
    <span v-if="(label || $slots.default) && !hideLabel" class="whitespace-nowrap text-xs text-fg-muted"><slot>{{ label }}</slot></span>
  </button>
</template>
