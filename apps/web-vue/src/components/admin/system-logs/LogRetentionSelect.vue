<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import UiSelect from "../../ui/UiSelect.vue";

/**
 * Retention in days: common presets, or a custom whole number of days (1–3650). The model may
 * hold a half-typed custom value ("" while the box is empty); the parent validates it.
 */
const props = withDefaults(
  defineProps<{
    modelValue: number | string;
    /** id for the select, so a field label can point at it. */
    id?: string;
    invalid?: boolean;
    disabled?: boolean;
  }>(),
  { invalid: false, disabled: false },
);
const emit = defineEmits<{ (e: "update:modelValue", value: number | string): void }>();

const { t } = useI18n();

const PRESETS = [1, 3, 7, 14, 30, 60, 90, 180, 365];
const isPreset = (v: number | string) => PRESETS.includes(Number(v)) && String(v).trim() !== "";

const custom = ref(!isPreset(props.modelValue));
/** The last value typed into the custom box (its own echo must not close the box while typing). */
let typed: { value: number | string } | null = null;
// A value set from outside (discard, save, reset, reload) shows as its preset, or opens the box.
watch(
  () => props.modelValue,
  (v) => {
    if (typed && typed.value === v) return;
    typed = null;
    custom.value = !isPreset(v);
  },
);

const selection = computed(() => (custom.value ? "custom" : String(Number(props.modelValue))));

function onSelect(next: unknown) {
  const value = String(next);
  if (value === "custom") {
    custom.value = true;
    return;
  }
  custom.value = false;
  typed = null;
  emit("update:modelValue", Number(value));
}

function onCustom(ev: Event) {
  const raw = (ev.target as HTMLInputElement).value.trim();
  const value = raw === "" ? "" : Number(raw);
  typed = { value };
  emit("update:modelValue", value);
}

/** Leaving the box with a preset number in it shows that preset in the select. */
function onCustomBlur() {
  if (isPreset(props.modelValue)) {
    custom.value = false;
    typed = null;
  }
}

const errorRing = "!border-danger focus:!ring-danger/20";
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center gap-2">
    <UiSelect
      :id="id"
      class="select w-auto min-w-[9rem] flex-1 sm:flex-none"
      :model-value="selection"
      :disabled="disabled"
      :class="invalid && !custom ? errorRing : ''"
      @change="onSelect"
    >
      <option v-for="d in PRESETS" :key="d" :value="String(d)">{{ t("systemLogs.retention.days", { n: d }, d) }}</option>
      <option value="custom">{{ t("systemLogs.retention.custom") }}</option>
    </UiSelect>
    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      enter-from-class="-translate-x-1 opacity-0"
      leave-to-class="-translate-x-1 opacity-0"
    >
      <div v-if="custom" class="flex min-w-0 flex-1 items-center gap-2 sm:max-w-[11rem]">
        <input
          :value="modelValue"
          type="number"
          inputmode="numeric"
          min="1"
          max="3650"
          step="1"
          class="input min-w-0 tabular-nums"
          :class="invalid ? errorRing : ''"
          :disabled="disabled"
          :aria-label="t('systemLogs.retention.customLabel')"
          :aria-invalid="invalid"
          @input="onCustom"
          @blur="onCustomBlur"
        />
        <span class="shrink-0 text-xs text-fg-muted">{{ t("systemLogs.retention.unit") }}</span>
      </div>
    </Transition>
  </div>
</template>
