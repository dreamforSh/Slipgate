<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../ui/UiIcon.vue";
import { channelVisual, ICON_CHIP_TONE } from "./paymentUtil";

/** Tinted brand monogram / icon for a payment channel (decorative; pair it with a text label). */
const props = withDefaults(
  defineProps<{
    provider: string;
    method?: string | null;
    size?: "xs" | "sm" | "md" | "lg";
  }>(),
  { method: null, size: "md" },
);

const visual = computed(() => channelVisual(props.provider, props.method));

const sizeClass = {
  xs: "h-5 w-5 rounded text-[10px]",
  sm: "h-7 w-7 rounded-md text-xs",
  md: "h-9 w-9 rounded-lg text-sm",
  lg: "h-11 w-11 rounded-xl text-base",
};
const iconSize = { xs: 11, sm: 14, md: 17, lg: 20 };
</script>

<template>
  <span class="icon-chip font-bold" :class="[sizeClass[size], ICON_CHIP_TONE[visual.tone]]" aria-hidden="true">
    <UiIcon v-if="visual.icon" :name="visual.icon" :size="iconSize[size]" />
    <span v-else class="leading-none">{{ visual.glyph }}</span>
  </span>
</template>
