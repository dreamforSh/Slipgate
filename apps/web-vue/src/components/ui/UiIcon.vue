<script setup lang="ts">
import { computed } from "vue";
import { ICONS, type IconName } from "./icons";

export type { IconName };

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: number | string;
    strokeWidth?: number;
    spin?: boolean;
  }>(),
  { size: 16, strokeWidth: 1.85, spin: false },
);

const markup = computed(() => ICONS[props.name] ?? "");
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
    :class="{ 'animate-spin': spin }"
    v-html="markup"
  />
</template>
