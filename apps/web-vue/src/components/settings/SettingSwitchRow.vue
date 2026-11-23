<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { Tone } from "../../lib/format";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";
import UiSwitch from "../ui/UiSwitch.vue";

/** One on/off setting: icon chip, title, short help text and a switch on the right. */
withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    description?: string;
    icon?: IconName;
    tone?: Tone;
    dirty?: boolean;
    disabled?: boolean;
  }>(),
  { tone: "accent", dirty: false, disabled: false },
);

const emit = defineEmits<{ (e: "update:modelValue", value: boolean): void }>();
const { t } = useI18n();

const chip: Record<Tone, string> = {
  neutral: "",
  accent: "icon-chip-accent",
  success: "icon-chip-success",
  warning: "icon-chip-warning",
  danger: "icon-chip-danger",
  info: "icon-chip-info",
  violet: "icon-chip-violet",
};
</script>

<template>
  <div class="flex items-start gap-3.5 py-4 first:pt-0 last:pb-0">
    <span v-if="icon" class="icon-chip mt-0.5 h-8 w-8 transition-opacity" :class="[chip[tone], modelValue ? '' : 'opacity-60']">
      <UiIcon :name="icon" :size="15" />
    </span>
    <div class="min-w-0 flex-1">
      <p class="flex items-center gap-1.5 text-sm font-medium text-fg">
        {{ title }}
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
      </p>
      <p v-if="description" class="mt-0.5 text-xs leading-relaxed text-fg-subtle">{{ description }}</p>
      <slot />
    </div>
    <UiSwitch
      class="mt-1 shrink-0"
      :model-value="modelValue"
      :label="title"
      :disabled="disabled"
      hide-label
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>
