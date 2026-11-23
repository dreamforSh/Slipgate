<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiIcon from "../ui/UiIcon.vue";
import { EXPIRY_PRESETS, isoToLocalInput, type ExpiryPreset, type ExpiryResult } from "./keyLimits";

/** Expiry presets (never / 7 / 30 / 90 days / custom) with a live "expires at" preview. */
const preset = defineModel<ExpiryPreset>("preset", { required: true });
const custom = defineModel<string>("custom", { required: true });
const props = withDefaults(defineProps<{ result: ExpiryResult; now: number; id?: string; disabled?: boolean }>(), {
  disabled: false,
});

const { t, locale } = useI18n();

const options = computed(() => EXPIRY_PRESETS.map((value) => ({ value, label: t(`user.form.expiryPresets.${value}`) })));
const minLocal = computed(() => isoToLocalInput(new Date(props.now).toISOString()));

const preview = computed(() => {
  const r = props.result;
  if (!r.ok) return { tone: "text-danger", icon: "alert" as const, text: t(r.reason === "past" ? "user.form.expiryPast" : "user.form.expiryRequired") };
  if (r.iso === null) return { tone: "text-fg-subtle", icon: "info" as const, text: t("user.keys.noExpiry") };
  const time = new Date(r.iso).toLocaleString(locale.value, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return { tone: "text-fg-muted", icon: "calendar" as const, text: t("user.form.expiryAt", { time }) };
});
</script>

<template>
  <div class="space-y-2.5">
    <div class="scrollbar-hide -mx-1 overflow-x-auto px-1">
      <SegmentedControl v-model="preset" :options="options" size="md" :class="disabled ? 'pointer-events-none opacity-60' : ''" />
    </div>
    <Transition
      enter-active-class="transition duration-200 ease-out"
      leave-active-class="transition duration-150 ease-in"
      enter-from-class="-translate-y-1 opacity-0"
      leave-to-class="-translate-y-1 opacity-0"
    >
      <input
        v-if="preset === 'custom'"
        :id="id"
        v-model="custom"
        type="datetime-local"
        :min="minLocal"
        :disabled="disabled"
        class="input max-w-xs font-mono"
        :class="!result.ok ? '!border-danger/60 focus:!ring-danger/20' : ''"
        :aria-invalid="!result.ok || undefined"
      />
    </Transition>
    <p class="flex items-center gap-1.5 text-xs" :class="preview.tone" aria-live="polite">
      <UiIcon :name="preview.icon" :size="12" />
      {{ preview.text }}
    </p>
  </div>
</template>
