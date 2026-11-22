<script setup lang="ts">
import { computed } from "vue";
import UiIcon, { type IconName } from "./UiIcon.vue";

const props = withDefaults(
  defineProps<{
    tone?: "info" | "success" | "warning" | "danger";
    title?: string;
  }>(),
  { tone: "info" },
);

const icon = computed<IconName>(
  () =>
    ({
      info: "info",
      success: "check-circle",
      warning: "alert",
      danger: "x-circle",
    })[props.tone] as IconName,
);

const toneClass = {
  info: "border-info/25 bg-info/[0.06] text-info",
  success: "border-success/25 bg-success/[0.06] text-success",
  warning: "border-warning/30 bg-warning/[0.07] text-warning",
  danger: "border-danger/25 bg-danger/[0.06] text-danger",
};
</script>

<template>
  <div class="flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm" :class="toneClass[tone]" role="status">
    <UiIcon :name="icon" :size="16" class="mt-0.5" />
    <div class="min-w-0 flex-1 text-fg">
      <p v-if="title" class="font-medium">{{ title }}</p>
      <div :class="title ? 'mt-1 text-fg-muted' : ''" class="break-words">
        <slot />
      </div>
    </div>
    <slot name="action" />
  </div>
</template>
