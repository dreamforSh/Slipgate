<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import UiIcon from "./UiIcon.vue";

const props = withDefaults(
  defineProps<{
    text: string;
    label?: string;
    size?: "xs" | "sm";
  }>(),
  { size: "xs" },
);

const copied = ref(false);
let timer: number | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(props.text);
    copied.value = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}

onBeforeUnmount(() => window.clearTimeout(timer));
</script>

<template>
  <button
    type="button"
    class="btn btn-ghost"
    :class="[size === 'xs' ? 'btn-xs' : 'btn-sm', label ? '' : 'btn-icon', copied ? '!text-success' : '']"
    :title="copied ? '已复制' : '复制'"
    :aria-label="copied ? '已复制' : '复制'"
    @click="copy"
  >
    <UiIcon :name="copied ? 'check' : 'copy'" :size="13" />
    <span v-if="label">{{ copied ? "已复制" : label }}</span>
  </button>
</template>
