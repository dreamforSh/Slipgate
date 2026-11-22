<script setup lang="ts" generic="K extends string">
import UiIcon, { type IconName } from "./UiIcon.vue";

defineProps<{
  modelValue: K;
  tabs: { key: K; label: string; count?: number; icon?: IconName }[];
}>();

const emit = defineEmits<{ (e: "update:modelValue", value: K): void }>();
</script>

<template>
  <div class="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.key"
      class="group relative inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 px-3 text-sm font-medium transition-colors"
      :class="modelValue === tab.key ? 'text-fg' : 'text-fg-subtle hover:text-fg'"
      @click="emit('update:modelValue', tab.key)"
    >
      <UiIcon v-if="tab.icon" :name="tab.icon" :size="15" />
      {{ tab.label }}
      <span
        v-if="tab.count !== undefined"
        class="rounded-full px-1.5 font-mono text-2xs leading-4"
        :class="modelValue === tab.key ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-fg-subtle'"
      >
        {{ tab.count }}
      </span>
      <span
        class="absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors"
        :class="modelValue === tab.key ? 'bg-accent' : 'bg-transparent'"
      />
    </button>
  </div>
</template>
