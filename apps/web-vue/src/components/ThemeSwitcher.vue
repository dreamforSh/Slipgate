<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useThemeStore, type ThemeMode } from "../stores/theme";
import UiIcon, { type IconName } from "./ui/UiIcon.vue";

/**
 * Theme picker. The default is a three-way segmented control with a sliding thumb (add
 * `labels` for text next to the icons); `compact` collapses it into one button that cycles
 * system → light → dark with an animated icon swap.
 */
withDefaults(defineProps<{ compact?: boolean; labels?: boolean }>(), { compact: false, labels: false });

const { t } = useI18n();
const theme = useThemeStore();

interface Option {
  value: ThemeMode;
  icon: IconName;
  label: string;
  short: string;
  /** Icon tint while selected: warm sun, cool moon, accent for "follow the system". */
  tint: string;
}

const options = computed<Option[]>(() => [
  { value: "system", icon: "monitor", label: t("theme.system"), short: t("theme.short.system"), tint: "text-accent" },
  { value: "light", icon: "sun", label: t("theme.light"), short: t("theme.short.light"), tint: "text-amber-500" },
  { value: "dark", icon: "moon", label: t("theme.dark"), short: t("theme.short.dark"), tint: "text-indigo-400" },
]);

const index = computed(() => Math.max(0, options.value.findIndex((o) => o.value === theme.mode)));
const current = computed(() => options.value[index.value]!);

const buttons = ref<HTMLButtonElement[]>([]);

/** Radio-group keys: arrows move the selection (and focus), Home/End jump to the ends. */
function onKeydown(ev: KeyboardEvent) {
  const last = options.value.length - 1;
  let next = index.value;
  if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = index.value === last ? 0 : index.value + 1;
  else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = index.value === 0 ? last : index.value - 1;
  else if (ev.key === "Home") next = 0;
  else if (ev.key === "End") next = last;
  else return;
  ev.preventDefault();
  theme.setMode(options.value[next]!.value);
  buttons.value[next]?.focus();
}
</script>

<template>
  <button
    v-if="compact"
    type="button"
    class="theme-cycle btn btn-ghost btn-icon btn-sm"
    :title="t('theme.current', { name: current.label })"
    :aria-label="`${t('theme.toggle')} (${current.label})`"
    @click="theme.cycle()"
  >
    <Transition name="theme-icon" mode="out-in">
      <UiIcon :key="current.value" :name="current.icon" :size="16" :class="current.tint" />
    </Transition>
  </button>

  <div
    v-else
    class="relative grid grid-cols-3 rounded-lg bg-surface-2 p-0.5 ring-1 ring-inset ring-line/60"
    role="radiogroup"
    :aria-label="t('theme.label')"
    @keydown="onKeydown"
  >
    <!-- Sliding thumb behind the selected option -->
    <span
      class="pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 rounded-md bg-surface shadow-sm ring-1 ring-fg/5 transition-transform duration-300 ease-[cubic-bezier(0.2,0,0,1)] dark:bg-surface-3 dark:ring-white/10"
      :style="{ width: 'calc((100% - 0.25rem) / 3)', transform: `translateX(${index * 100}%)` }"
      aria-hidden="true"
    />
    <button
      v-for="(opt, i) in options"
      :key="opt.value"
      ref="buttons"
      type="button"
      role="radio"
      :aria-checked="theme.mode === opt.value"
      :tabindex="theme.mode === opt.value ? 0 : -1"
      :title="opt.label"
      :aria-label="opt.label"
      class="relative z-10 inline-flex h-7 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      :class="theme.mode === opt.value ? 'text-fg' : 'text-fg-subtle hover:text-fg'"
      @click="theme.setMode(opt.value)"
    >
      <UiIcon
        :name="opt.icon"
        :size="14"
        class="shrink-0 transition-colors duration-200"
        :class="[theme.mode === opt.value ? opt.tint : '', i === index ? 'theme-pop' : '']"
      />
      <span v-if="labels" class="truncate">{{ opt.short }}</span>
    </button>
  </div>
</template>

<style scoped>
.theme-icon-enter-active,
.theme-icon-leave-active {
  transition:
    transform 220ms cubic-bezier(0.2, 0, 0, 1),
    opacity 160ms ease;
}
.theme-icon-enter-from {
  opacity: 0;
  transform: rotate(-90deg) scale(0.6);
}
.theme-icon-leave-to {
  opacity: 0;
  transform: rotate(90deg) scale(0.6);
}
.theme-pop {
  animation: theme-pop 320ms cubic-bezier(0.2, 0, 0, 1);
}
@keyframes theme-pop {
  40% {
    transform: scale(1.18) rotate(-8deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .theme-icon-enter-active,
  .theme-icon-leave-active,
  .theme-pop {
    transition: none;
    animation: none;
  }
}
</style>
