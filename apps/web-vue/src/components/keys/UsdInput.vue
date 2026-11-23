<script setup lang="ts">
/** USD amount field with a leading "$" adornment; the text is validated by the parent. */
withDefaults(
  defineProps<{
    modelValue: string;
    id?: string;
    invalid?: boolean;
    disabled?: boolean;
    placeholder?: string;
    ariaLabel?: string;
  }>(),
  { invalid: false, disabled: false, placeholder: "0" },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();
</script>

<template>
  <div class="relative">
    <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-fg-subtle" aria-hidden="true">$</span>
    <input
      :id="id"
      :value="modelValue"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      spellcheck="false"
      maxlength="22"
      :disabled="disabled"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      :aria-invalid="invalid || undefined"
      class="input pl-6 font-mono tabular-nums"
      :class="invalid ? '!border-danger/60 focus:!ring-danger/20' : ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>
