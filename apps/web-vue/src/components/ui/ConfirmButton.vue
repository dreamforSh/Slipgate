<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import UiIcon, { type IconName } from "./UiIcon.vue";

/** Two-step destructive action: first click arms, second click (within 3s) confirms. */
const props = withDefaults(
  defineProps<{
    label?: string;
    confirmLabel?: string;
    icon?: IconName;
    size?: "xs" | "sm";
    iconOnly?: boolean;
    disabled?: boolean;
  }>(),
  { label: "删除", confirmLabel: "确认？", icon: "trash", size: "xs", iconOnly: false, disabled: false },
);

const emit = defineEmits<{ (e: "confirm"): void }>();

const armed = ref(false);
let timer: number | undefined;

function onClick() {
  if (props.disabled) return;
  if (!armed.value) {
    armed.value = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (armed.value = false), 3000);
    return;
  }
  window.clearTimeout(timer);
  armed.value = false;
  emit("confirm");
}

onBeforeUnmount(() => window.clearTimeout(timer));
</script>

<template>
  <button
    type="button"
    class="btn"
    :class="[
      size === 'xs' ? 'btn-xs' : 'btn-sm',
      armed ? 'btn-danger-solid' : 'btn-ghost hover:!bg-danger/10 hover:!text-danger',
      iconOnly && !armed ? 'btn-icon' : '',
    ]"
    :disabled="disabled"
    :title="iconOnly ? label : undefined"
    :aria-label="armed ? confirmLabel : label"
    @click="onClick"
    @blur="armed = false"
  >
    <UiIcon :name="armed ? 'alert' : icon" :size="13" />
    <span v-if="!iconOnly || armed">{{ armed ? confirmLabel : label }}</span>
  </button>
</template>
