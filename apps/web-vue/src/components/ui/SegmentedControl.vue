<script setup lang="ts" generic="V extends string">
withDefaults(
  defineProps<{
    modelValue: V;
    options: { value: V; label: string; count?: number; disabled?: boolean }[];
    size?: "sm" | "md";
    block?: boolean;
  }>(),
  { size: "sm", block: false },
);

const emit = defineEmits<{ (e: "update:modelValue", value: V): void }>();
</script>

<template>
  <div class="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5" :class="block ? 'flex w-full' : ''" role="radiogroup">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === opt.value"
      :disabled="opt.disabled"
      class="inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      :class="[
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        block ? 'flex-1' : '',
        modelValue === opt.value
          ? 'bg-surface text-fg shadow-sm ring-1 ring-fg/5 dark:bg-surface-3 dark:ring-white/10'
          : 'text-fg-subtle hover:text-fg',
        opt.disabled ? 'cursor-not-allowed opacity-40 hover:text-fg-subtle' : '',
      ]"
      @click="!opt.disabled && emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
      <span
        v-if="opt.count !== undefined"
        class="rounded-full px-1.5 font-mono text-[10px] leading-4 tabular-nums"
        :class="modelValue === opt.value ? 'bg-accent/10 text-accent' : 'bg-surface-3/70 text-fg-subtle dark:bg-surface/60'"
      >
        {{ opt.count }}
      </span>
    </button>
  </div>
</template>
