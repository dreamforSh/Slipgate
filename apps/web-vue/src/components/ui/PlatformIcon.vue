<script setup lang="ts">
import { computed } from "vue";
import { platformIcon } from "./platformIcons";

/**
 * Provider mark in currentColor (brand logo where one exists, a neutral glyph otherwise).
 * Rendered with v-html from the trusted static strings in platformIcons.ts.
 */
const props = withDefaults(defineProps<{ platform: string; size?: number }>(), { size: 12 });

const icon = computed(() => platformIcon(props.platform));
</script>

<template>
  <svg
    :width="size"
    :height="size"
    :viewBox="icon.viewBox"
    :fill="icon.mode === 'fill' ? 'currentColor' : 'none'"
    :stroke="icon.mode === 'stroke' ? 'currentColor' : undefined"
    :stroke-width="icon.mode === 'stroke' ? 2 : undefined"
    :fill-rule="icon.evenOdd ? 'evenodd' : undefined"
    class="shrink-0"
    aria-hidden="true"
    focusable="false"
    v-html="icon.body"
  />
</template>
