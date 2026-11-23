<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";

/**
 * Write-only multi-line secret (PEM private keys keep their line breaks). Same contract as
 * SecretInput: `undefined` = keep what is stored, `""` = clear it, any other text = replace it.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string | undefined;
    isSet: boolean;
    label: string;
    hint?: string;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
    error?: string | null;
  }>(),
  { hint: "", placeholder: "", required: false, disabled: false, error: null },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string | undefined): void }>();
const { t } = useI18n();
const id = `pem-${Math.random().toString(36).slice(2, 9)}`;

const clearing = computed(() => props.modelValue === "");
const replacing = computed(() => typeof props.modelValue === "string" && props.modelValue !== "");

const state = computed(() => {
  if (clearing.value) return { tone: "danger" as const, text: t("payments.admin.settings.secret.willClear") };
  if (replacing.value) return { tone: "info" as const, text: t("payments.admin.settings.secret.willSet") };
  if (props.isSet) return { tone: "success" as const, text: t("payments.admin.settings.secret.set") };
  return { tone: "neutral" as const, text: t("payments.admin.settings.secret.unset") };
});

const placeholderText = computed(() => {
  if (clearing.value) return t("payments.admin.settings.secret.willClear");
  if (props.isSet) return t("payments.admin.settings.secret.keepPlaceholder");
  return props.placeholder || t("payments.admin.settings.secret.emptyPlaceholder");
});

function onInput(ev: Event) {
  const value = (ev.target as HTMLTextAreaElement).value;
  emit("update:modelValue", value === "" ? undefined : value);
}
</script>

<template>
  <div class="min-w-0">
    <div class="mb-1.5 flex items-center justify-between gap-2">
      <label :for="id" class="flex min-w-0 items-center gap-1 text-xs font-medium text-fg-muted">
        <UiIcon name="key" :size="12" class="shrink-0 text-fg-subtle" />
        <span class="truncate">{{ label }}</span>
        <span v-if="required" class="text-danger">*</span>
      </label>
      <div class="flex shrink-0 items-center gap-1.5">
        <UiBadge :tone="state.tone" dot>{{ state.text }}</UiBadge>
        <button
          v-if="clearing"
          type="button"
          class="btn btn-ghost btn-xs"
          :disabled="disabled"
          @click="emit('update:modelValue', undefined)"
        >
          <UiIcon name="rotate-ccw" :size="12" />
          {{ t("payments.admin.settings.secret.undo") }}
        </button>
        <button
          v-else-if="isSet || replacing"
          type="button"
          class="btn btn-ghost btn-xs hover:!bg-danger/10 hover:!text-danger"
          :disabled="disabled"
          @click="emit('update:modelValue', isSet ? '' : undefined)"
        >
          <UiIcon name="trash" :size="12" />
          {{ t("payments.admin.settings.secret.clear") }}
        </button>
      </div>
    </div>
    <textarea
      :id="id"
      rows="4"
      class="textarea font-mono text-2xs leading-snug"
      :class="[clearing ? 'border-danger/50' : '', error ? '!border-danger focus:!ring-danger/20' : '']"
      :value="modelValue ?? ''"
      :placeholder="placeholderText"
      :disabled="disabled || clearing"
      :aria-invalid="Boolean(error)"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
    />
    <p v-if="error" class="mt-1 text-xs text-danger" role="alert">{{ error }}</p>
    <p v-else-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>
