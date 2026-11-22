<script setup lang="ts">
/**
 * Slipgate mark in thin lines: an open gateway on a ground line, broken at the doorway, with a
 * chevron passing through. Everything is drawn in currentColor (the accent token by default),
 * so it follows light/dark themes without per-theme assets.
 */
withDefaults(defineProps<{ size?: number; glow?: boolean }>(), { size: 32, glow: false });
</script>

<template>
  <span
    class="inline-flex shrink-0 rounded-[30%] text-accent"
    :class="glow ? 'ring-4 ring-accent/[0.07]' : ''"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <svg
      :width="size"
      :height="size"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <!-- Tile: hairline frame over a faint tint -->
      <rect x="1" y="1" width="30" height="30" rx="9" fill="currentColor" fill-opacity="0.07" stroke-opacity="0.38" stroke-width="1.25" />
      <!-- Gateway standing on the ground line, open at the doorway -->
      <path d="M6.5 23.5H10v-9a6 6 0 0 1 12 0v9h3.5" stroke-width="1.8" />
      <!-- Traffic slipping through -->
      <path d="m14.75 16.5 2.75 2.75-2.75 2.75" stroke-width="1.8" />
    </svg>
  </span>
</template>
