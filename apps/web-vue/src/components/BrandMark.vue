<script setup lang="ts">
import { useId } from "vue";

withDefaults(defineProps<{ size?: number; glow?: boolean }>(), { size: 32, glow: false });

// Gradient ids must be unique per instance: several marks can be on screen at once.
const gradientId = `brand-grad-${useId()}`;
</script>

<template>
  <span
    class="inline-flex shrink-0 rounded-[28%]"
    :class="glow ? 'shadow-glow' : ''"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <svg :width="size" :height="size" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient :id="gradientId" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#2dd4bf" />
          <stop offset="0.55" stop-color="#0d9488" />
          <stop offset="1" stop-color="#115e59" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" :fill="`url(#${gradientId})`" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" stroke="white" stroke-opacity="0.18" />
      <path d="M9 24V14a7 7 0 0 1 14 0v10" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" />
      <path
        d="M13.5 24v-5h5v5"
        fill="none"
        stroke="white"
        stroke-width="2.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>
</template>
