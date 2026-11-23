<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "../ui/UiIcon.vue";

/** Password field with a show/hide toggle. */
withDefaults(
  defineProps<{
    modelValue: string;
    id?: string;
    autocomplete?: string;
    placeholder?: string;
    invalid?: boolean;
    disabled?: boolean;
  }>(),
  { autocomplete: "current-password", invalid: false, disabled: false },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();
const { t } = useI18n();
const visible = ref(false);
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      :value="modelValue"
      :type="visible ? 'text' : 'password'"
      :autocomplete="autocomplete"
      :placeholder="placeholder"
      :disabled="disabled"
      spellcheck="false"
      maxlength="128"
      class="input pr-10"
      :class="invalid ? '!border-danger/60 focus:!ring-danger/20' : ''"
      :aria-invalid="invalid || undefined"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      type="button"
      class="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-fg-subtle transition-colors hover:text-fg focus:outline-none focus-visible:text-accent"
      :aria-label="visible ? t('auth.hidePassword') : t('auth.showPassword')"
      :title="visible ? t('auth.hidePassword') : t('auth.showPassword')"
      :aria-pressed="visible"
      tabindex="-1"
      @click="visible = !visible"
    >
      <UiIcon :name="visible ? 'eye-off' : 'eye'" :size="15" />
    </button>
  </div>
</template>
