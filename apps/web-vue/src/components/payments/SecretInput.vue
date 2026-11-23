<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import UiBadge from "../ui/UiBadge.vue";
import UiIcon from "../ui/UiIcon.vue";

/**
 * Write-only secret field. `modelValue` follows the PATCH contract:
 * `undefined` = keep what is stored, `""` = clear it, any other string = replace it.
 * The stored secret itself is never available to the browser.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string | undefined;
    /** Whether a value is currently stored server-side. */
    isSet: boolean;
    label: string;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  { placeholder: "", disabled: false },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string | undefined): void }>();
const { t } = useI18n();

const reveal = ref(false);
const id = `secret-${Math.random().toString(36).slice(2, 9)}`;

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
  const value = (ev.target as HTMLInputElement).value;
  // Emptying the box goes back to "keep", never to an accidental clear.
  emit("update:modelValue", value === "" ? undefined : value);
}
</script>

<template>
  <div class="min-w-0">
    <div class="mb-1.5 flex items-center justify-between gap-2">
      <label :for="id" class="text-xs font-medium text-fg-muted">{{ label }}</label>
      <UiBadge :tone="state.tone" dot>{{ state.text }}</UiBadge>
    </div>
    <div class="flex gap-2">
      <div class="relative min-w-0 flex-1">
        <UiIcon name="key" :size="14" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <input
          :id="id"
          :type="reveal ? 'text' : 'password'"
          class="input pl-8 pr-9 font-mono"
          :class="clearing ? 'border-danger/50' : ''"
          :value="modelValue ?? ''"
          :placeholder="placeholderText"
          :disabled="disabled"
          autocomplete="new-password"
          spellcheck="false"
          @input="onInput"
        />
        <button
          v-if="replacing"
          type="button"
          class="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          :title="reveal ? t('payments.admin.settings.secret.hide') : t('payments.admin.settings.secret.show')"
          :aria-label="reveal ? t('payments.admin.settings.secret.hide') : t('payments.admin.settings.secret.show')"
          @click="reveal = !reveal"
        >
          <UiIcon :name="reveal ? 'eye-off' : 'eye'" :size="14" />
        </button>
      </div>
      <button
        v-if="clearing"
        type="button"
        class="btn btn-secondary shrink-0"
        :disabled="disabled"
        @click="emit('update:modelValue', undefined)"
      >
        <UiIcon name="rotate-ccw" :size="14" />
        {{ t("payments.admin.settings.secret.undo") }}
      </button>
      <button
        v-else-if="isSet || replacing"
        type="button"
        class="btn btn-ghost shrink-0 hover:!bg-danger/10 hover:!text-danger"
        :disabled="disabled"
        @click="emit('update:modelValue', isSet ? '' : undefined)"
      >
        <UiIcon name="trash" :size="14" />
        {{ t("payments.admin.settings.secret.clear") }}
      </button>
    </div>
  </div>
</template>
