<script setup lang="ts">
import { computed } from "vue";
import qrcode from "qrcode-generator";

/**
 * QR code as inline SVG. Modules use currentColor on a light tile in both themes (dark text
 * on surface in light mode, inverted fg/bg tokens in dark mode) so phone cameras read it.
 */
const props = withDefaults(defineProps<{ text: string; size?: number; label: string }>(), { size: 184 });

const QUIET = 2;

const matrix = computed(() => {
  try {
    const qr = qrcode(0, "M");
    qr.addData(props.text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
      }
    }
    return { n: n + QUIET * 2, d };
  } catch {
    return null;
  }
});
</script>

<template>
  <div
    class="inline-flex items-center justify-center rounded-xl bg-surface p-2 text-fg shadow-sm ring-1 ring-inset ring-line dark:bg-fg dark:text-bg dark:ring-0"
  >
    <svg
      v-if="matrix"
      xmlns="http://www.w3.org/2000/svg"
      :viewBox="`0 0 ${matrix.n} ${matrix.n}`"
      :width="size"
      :height="size"
      shape-rendering="crispEdges"
      role="img"
      :aria-label="label"
      class="block"
    >
      <path :d="matrix.d" fill="currentColor" />
    </svg>
    <div v-else class="flex items-center justify-center text-xs opacity-60" :style="{ width: `${size}px`, height: `${size}px` }">QR</div>
  </div>
</template>
