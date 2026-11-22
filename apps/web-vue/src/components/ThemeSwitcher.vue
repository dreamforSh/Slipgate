<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useThemeStore, type ThemeMode } from "../stores/theme";
import UiIcon, { type IconName } from "./ui/UiIcon.vue";

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const { t } = useI18n();
const theme = useThemeStore();

const options = computed<{ value: ThemeMode; icon: IconName; label: string }[]>(() => [
  { value: "system", icon: "monitor", label: t("theme.system") },
  { value: "light", icon: "sun", label: t("theme.light") },
  { value: "dark", icon: "moon", label: t("theme.dark") },
]);

const current = computed(() => options.value.find((o) => o.value === theme.mode) ?? options.value[0]!);
</script>

<template>
  <button
    v-if="compact"
    type="button"
    class="btn btn-ghost btn-icon btn-sm"
    :title="t('theme.current', { name: current.label })"
    :aria-label="t('theme.toggle')"
    @click="theme.cycle()"
  >
    <UiIcon :name="current.icon" :size="16" :class="theme.mode === 'light' ? 'text-warning' : ''" />
  </button>
  <div v-else class="flex gap-0.5 rounded-lg bg-surface-2 p-0.5" role="radiogroup" :aria-label="t('theme.label')">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="theme.mode === opt.value"
      :title="opt.label"
      :aria-label="opt.label"
      class="inline-flex h-7 flex-1 cursor-pointer items-center justify-center rounded-md transition-colors duration-150"
      :class="
        theme.mode === opt.value
          ? 'bg-surface text-fg shadow-sm ring-1 ring-fg/5 dark:bg-surface-3 dark:ring-white/10'
          : 'text-fg-subtle hover:text-fg'
      "
      @click="theme.setMode(opt.value)"
    >
      <UiIcon :name="opt.icon" :size="14" />
    </button>
  </div>
</template>
