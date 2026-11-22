<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
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
  { icon: "trash", size: "xs", iconOnly: false, disabled: false },
);

const emit = defineEmits<{ (e: "confirm"): void }>();

const { t } = useI18n();
const labelText = computed(() => props.label ?? t("common.delete"));
const confirmText = computed(() => props.confirmLabel ?? t("common.confirmDelete"));

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
    :title="iconOnly ? labelText : undefined"
    :aria-label="armed ? confirmText : labelText"
    @click="onClick"
    @blur="armed = false"
  >
    <UiIcon :name="armed ? 'alert' : icon" :size="13" />
    <span v-if="!iconOnly || armed">{{ armed ? confirmText : labelText }}</span>
  </button>
</template>
