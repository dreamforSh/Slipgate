<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import { EXPIRY_PRESETS, isoToLocalInput, type ExpiryPreset } from "./opsUtil";

/** "Never / 1 / 7 / 30 days / custom" expiry picker; the parent resolves it with `resolveExpiry`. */
const props = defineProps<{ preset: ExpiryPreset; custom: string; label: string; invalid?: boolean }>();
const emit = defineEmits<{
  (e: "update:preset", value: ExpiryPreset): void;
  (e: "update:custom", value: string): void;
}>();

const { t } = useI18n();

const options = computed(() =>
  EXPIRY_PRESETS.map((value) => ({
    value,
    label: value === "never" ? t("redeem.expiry.never") : value === "custom" ? t("redeem.expiry.custom") : t("redeem.expiry.days", { n: Number(value) }),
  })),
);

const minLocal = computed(() => isoToLocalInput(new Date(Date.now() + 60_000).toISOString()));

function pick(value: ExpiryPreset) {
  emit("update:preset", value);
  if (value === "custom" && !props.custom) {
    emit("update:custom", isoToLocalInput(new Date(Date.now() + 14 * 86_400_000).toISOString()));
  }
}
</script>

<template>
  <div class="min-w-0">
    <p class="label">{{ label }}</p>
    <div class="scrollbar-hide -mx-0.5 overflow-x-auto px-0.5">
      <SegmentedControl :model-value="preset" :options="options" size="md" block @update:model-value="pick" />
    </div>
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="-translate-y-1 opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <input
        v-if="preset === 'custom'"
        :value="custom"
        type="datetime-local"
        :min="minLocal"
        class="input mt-2"
        :class="invalid ? '!border-danger focus:!ring-danger/20' : ''"
        :aria-label="t('redeem.expiry.custom')"
        @input="emit('update:custom', ($event.target as HTMLInputElement).value)"
      />
    </Transition>
  </div>
</template>
