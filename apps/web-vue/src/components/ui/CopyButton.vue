<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "./UiIcon.vue";

const props = withDefaults(
  defineProps<{
    text: string;
    label?: string;
    size?: "xs" | "sm";
  }>(),
  { size: "xs" },
);

const { t } = useI18n();
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
    :title="copied ? t('common.copied') : t('common.copy')"
    :aria-label="copied ? t('common.copied') : t('common.copy')"
    @click="copy"
  >
    <Transition name="swap" mode="out-in">
      <UiIcon :key="copied ? 'done' : 'copy'" :name="copied ? 'check' : 'copy'" :size="13" :stroke-width="copied ? 2.4 : 1.85" />
    </Transition>
    <Transition v-if="label" name="text-swap" mode="out-in">
      <span :key="copied ? 'done' : 'copy'">{{ copied ? t("common.copied") : label }}</span>
    </Transition>
  </button>
</template>
