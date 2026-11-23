<script setup lang="ts">
import { useI18n } from "vue-i18n";
import UiIcon from "../ui/UiIcon.vue";

/** Labelled settings input with an inline error / help line and an "unsaved" marker. */
withDefaults(
  defineProps<{
    label: string;
    /** id of the control the label points at. */
    inputId?: string;
    hint?: string;
    error?: string | null;
    dirty?: boolean;
    required?: boolean;
  }>(),
  { dirty: false, required: false },
);

const { t } = useI18n();
</script>

<template>
  <div class="min-w-0">
    <div class="mb-1.5 flex items-center justify-between gap-2">
      <label :for="inputId" class="flex min-w-0 items-center gap-1.5 text-xs font-medium text-fg-muted">
        <span class="truncate">{{ label }}</span>
        <span v-if="required" class="text-danger">*</span>
        <Transition
          enter-active-class="transition duration-200 ease-out"
          leave-active-class="transition duration-150 ease-in"
          enter-from-class="scale-0 opacity-0"
          leave-to-class="scale-0 opacity-0"
        >
          <span
            v-if="dirty"
            class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            :title="t('settings.modified')"
            :aria-label="t('settings.modified')"
          />
        </Transition>
      </label>
      <slot name="aside" />
    </div>
    <slot />
    <p v-if="error" class="mt-1 flex animate-fade-in items-start gap-1 text-xs text-danger" role="alert">
      <UiIcon name="alert" :size="12" class="mt-0.5" />
      <span class="min-w-0 break-words">{{ error }}</span>
    </p>
    <p v-else-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>
