<script setup lang="ts" generic="V extends string">
withDefaults(
  defineProps<{
    modelValue: V;
    options: { value: V; label: string; count?: number }[];
    size?: "sm" | "md";
    block?: boolean;
  }>(),
  { size: "sm", block: false },
);

const emit = defineEmits<{ (e: "update:modelValue", value: V): void }>();
</script>

<template>
  <div
    class="inline-flex gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
    :class="block ? 'flex w-full' : ''"
    role="radiogroup"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === opt.value"
      class="inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-all duration-150"
      :class="[
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        block ? 'flex-1' : '',
        modelValue === opt.value
          ? 'bg-surface text-fg shadow-sm ring-1 ring-line'
          : 'text-fg-subtle hover:text-fg',
      ]"
      @click="emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
      <span v-if="opt.count !== undefined" class="font-mono text-2xs text-fg-subtle">{{ opt.count }}</span>
    </button>
  </div>
</template>
