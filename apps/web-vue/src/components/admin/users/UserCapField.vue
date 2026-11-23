<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { USER_LIMIT_MAX, type UserCap } from "@slipgate/contracts";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { parseLimit, useLimitText, type CapKind } from "./limits";

/**
 * One user-level cap (RPM or concurrency): inherit the portal default (null), no cap (0) or a
 * custom number. `invalid` mirrors a custom value that is not a whole number in range.
 */
const props = withDefaults(
  defineProps<{
    id: string;
    kind: CapKind;
    label: string;
    /** The portal default the user inherits (null while unknown). */
    portalDefault?: number | null;
    disabled?: boolean;
  }>(),
  { portalDefault: null, disabled: false },
);
const model = defineModel<UserCap>({ required: true });
const invalid = defineModel<boolean>("invalid", { default: false });

const { t, capText } = useLimitText();

type Mode = "inherit" | "unlimited" | "custom";
const modeOf = (v: UserCap): Mode => (v === null ? "inherit" : v === 0 ? "unlimited" : "custom");

const mode = ref<Mode>(modeOf(model.value));
// type="number" hands back a number once the text parses (Vue casts it).
const text = ref<string | number>(model.value && model.value > 0 ? String(model.value) : "");

// Follow outside changes (dialog reopened for another user).
watch(model, (v) => {
  const next = modeOf(v);
  if (next !== mode.value) mode.value = next;
  if (next === "custom" && parseLimit(text.value, 1) !== v) text.value = String(v);
});

const options = computed<{ value: Mode; label: string }[]>(() => [
  { value: "inherit", label: t("userLimits.capField.inherit") },
  { value: "unlimited", label: t("userLimits.capField.unlimited") },
  { value: "custom", label: t("userLimits.capField.custom") },
]);

function setMode(next: Mode) {
  if (props.disabled) return;
  mode.value = next;
  if (next === "inherit") model.value = null;
  else if (next === "unlimited") model.value = 0;
  else {
    if (!parseLimit(text.value, 1)) {
      const seed = props.portalDefault && props.portalDefault > 0 ? props.portalDefault : props.kind === "rpm" ? 60 : 5;
      text.value = String(seed);
    }
    model.value = parseLimit(text.value, 1) ?? model.value;
  }
}

watch(text, (v) => {
  if (mode.value !== "custom") return;
  const n = parseLimit(v, 1);
  if (n !== null) model.value = n;
});

const customInvalid = computed(() => mode.value === "custom" && parseLimit(text.value, 1) === null);
watch(customInvalid, (v) => (invalid.value = v), { immediate: true });

const hint = computed(() => {
  if (customInvalid.value) return t("userLimits.capField.invalid", { max: USER_LIMIT_MAX.toLocaleString() });
  if (mode.value === "inherit") {
    return props.portalDefault === null
      ? t("userLimits.capField.inheritHintUnknown")
      : t("userLimits.capField.inheritHint", { value: capText(props.portalDefault, props.kind) });
  }
  if (mode.value === "unlimited") return t(`userLimits.capField.unlimitedHint.${props.kind}`);
  return t(`userLimits.capField.customHint.${props.kind}`, { n: parseLimit(text.value, 1) ?? 0 });
});
</script>

<template>
  <div class="min-w-0">
    <div class="mb-1.5 flex items-center gap-1.5">
      <UiIcon :name="kind === 'rpm' ? 'gauge' : 'activity'" :size="13" class="text-fg-subtle" />
      <span :id="`${id}-label`" class="text-xs font-medium text-fg-muted">{{ label }}</span>
    </div>
    <SegmentedControl
      :model-value="mode"
      :options="options"
      block
      :aria-labelledby="`${id}-label`"
      :class="disabled ? 'pointer-events-none opacity-60' : ''"
      @update:model-value="setMode"
    />
    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      enter-from-class="-translate-y-1 opacity-0"
      leave-to-class="-translate-y-1 opacity-0"
    >
      <div v-if="mode === 'custom'" class="relative mt-2">
        <label :for="id" class="sr-only">{{ label }}</label>
        <input
          :id="id"
          v-model="text"
          type="number"
          inputmode="numeric"
          min="1"
          :max="USER_LIMIT_MAX"
          step="1"
          :disabled="disabled"
          class="input pr-16 font-mono"
          :class="customInvalid ? '!border-danger/60 focus:!ring-danger/20' : ''"
          :aria-invalid="customInvalid || undefined"
          :aria-describedby="`${id}-hint`"
        />
        <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-2xs text-fg-subtle">
          {{ kind === "rpm" ? t("userLimits.capField.perMinute") : t("userLimits.capField.inFlight") }}
        </span>
      </div>
    </Transition>
    <p :id="`${id}-hint`" class="hint" :class="customInvalid ? '!text-danger' : ''">{{ hint }}</p>
  </div>
</template>
