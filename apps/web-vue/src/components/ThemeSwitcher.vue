<script setup lang="ts">
import { useThemeStore, type ThemeMode } from "../stores/theme";
import UiIcon, { type IconName } from "./ui/UiIcon.vue";

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const theme = useThemeStore();

const options: { value: ThemeMode; icon: IconName; label: string }[] = [
  { value: "system", icon: "monitor", label: "跟随系统" },
  { value: "light", icon: "sun", label: "浅色" },
  { value: "dark", icon: "moon", label: "深色" },
];
</script>

<template>
  <button
    v-if="compact"
    type="button"
    class="btn btn-ghost btn-icon btn-sm"
    :title="`主题：${options.find((o) => o.value === theme.mode)?.label}`"
    aria-label="切换主题"
    @click="theme.cycle()"
  >
    <UiIcon :name="options.find((o) => o.value === theme.mode)?.icon ?? 'monitor'" :size="16" />
  </button>
  <div v-else class="flex rounded-lg border border-line bg-surface-2 p-0.5" role="radiogroup" aria-label="主题">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="theme.mode === opt.value"
      :title="opt.label"
      :aria-label="opt.label"
      class="inline-flex h-7 flex-1 cursor-pointer items-center justify-center rounded-md transition-colors"
      :class="theme.mode === opt.value ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-fg-subtle hover:text-fg'"
      @click="theme.setMode(opt.value)"
    >
      <UiIcon :name="opt.icon" :size="14" />
    </button>
  </div>
</template>
