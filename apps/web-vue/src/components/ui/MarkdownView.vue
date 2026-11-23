<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../../lib/markdown";

const props = defineProps<{ source: string }>();

// renderMarkdown escapes all input HTML and only re-emits a fixed tag whitelist.
const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="markdown" v-html="html" />
</template>

<style scoped>
.markdown {
  @apply text-sm leading-relaxed text-fg;
  overflow-wrap: anywhere;
}
.markdown :deep(> * + *) {
  @apply mt-3;
}
.markdown :deep(h2) {
  @apply text-lg font-semibold tracking-tight;
}
.markdown :deep(h3) {
  @apply text-base font-semibold;
}
.markdown :deep(h4),
.markdown :deep(h5) {
  @apply text-sm font-semibold;
}
.markdown :deep(a) {
  @apply font-medium text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent;
}
.markdown :deep(code) {
  @apply rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em];
}
.markdown :deep(pre) {
  @apply overflow-x-auto rounded-lg border border-line bg-surface-2 p-3;
}
.markdown :deep(pre code) {
  @apply bg-transparent p-0;
}
.markdown :deep(ul) {
  @apply list-disc space-y-1 pl-5;
}
.markdown :deep(ol) {
  @apply list-decimal space-y-1 pl-5;
}
.markdown :deep(blockquote) {
  @apply border-l-2 border-accent/40 pl-3 text-fg-muted;
}
.markdown :deep(hr) {
  @apply border-line;
}
.markdown :deep(img) {
  @apply max-h-80 rounded-lg border border-line;
}
.markdown :deep(table) {
  @apply w-full border-collapse text-left text-xs;
}
.markdown :deep(th),
.markdown :deep(td) {
  @apply border border-line px-2.5 py-1.5;
}
.markdown :deep(th) {
  @apply bg-surface-2 font-semibold;
}
</style>
