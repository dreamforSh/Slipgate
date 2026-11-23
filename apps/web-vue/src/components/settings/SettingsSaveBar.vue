<script setup lang="ts">
import { useI18n } from "vue-i18n";
import UiIcon from "../ui/UiIcon.vue";

/** Sticky "unsaved changes" bar that slides up from the bottom of the page. */
withDefaults(
  defineProps<{
    show: boolean;
    count: number;
    saving?: boolean;
    invalid?: boolean;
  }>(),
  { saving: false, invalid: false },
);

const emit = defineEmits<{ (e: "save"): void; (e: "discard"): void }>();
const { t } = useI18n();
</script>

<template>
  <div class="pointer-events-none sticky bottom-4 z-20 sm:bottom-6">
    <Transition
      enter-active-class="transition duration-300 ease-out motion-reduce:transition-none"
      leave-active-class="transition duration-200 ease-in motion-reduce:transition-none"
      enter-from-class="translate-y-6 opacity-0"
      leave-to-class="translate-y-6 opacity-0"
    >
      <div
        v-if="show"
        class="glass pointer-events-auto mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3 shadow-pop sm:flex-nowrap sm:px-5"
        role="region"
        :aria-label="t('settings.saveBar.label')"
      >
        <div class="flex min-w-0 items-center gap-3">
          <span
            class="icon-chip h-8 w-8 shrink-0"
            :class="invalid ? 'icon-chip-danger' : 'icon-chip-warning'"
          >
            <UiIcon :name="invalid ? 'alert' : 'pencil'" :size="15" />
          </span>
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-fg">{{ t("settings.saveBar.title", { n: count }) }}</p>
            <p class="hidden truncate text-xs text-fg-subtle sm:block">
              {{ invalid ? t("settings.saveBar.invalid") : t("settings.saveBar.hint") }}
            </p>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
          <button type="button" class="btn btn-ghost" :disabled="saving" @click="emit('discard')">
            <UiIcon name="rotate-ccw" :size="14" />
            {{ t("settings.saveBar.discard") }}
          </button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="emit('save')">
            <UiIcon :name="saving ? 'loader' : 'check'" :size="15" :spin="saving" />
            {{ saving ? t("common.saving") : t("settings.saveBar.save") }}
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
