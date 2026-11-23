<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import OtpInput from "../../me/OtpInput.vue";
import PasswordInput from "../../me/PasswordInput.vue";
import UiIcon from "../../ui/UiIcon.vue";

/** Password (always) and authenticator code (when two-factor is on) for a backup step-up. */
withDefaults(
  defineProps<{
    password: string;
    code: string;
    needTotp: boolean;
    checking?: boolean;
    disabled?: boolean;
    passwordError?: string | null;
    codeError?: string | null;
    idPrefix: string;
  }>(),
  { checking: false, disabled: false, passwordError: null, codeError: null },
);

const emit = defineEmits<{
  (e: "update:password", value: string): void;
  (e: "update:code", value: string): void;
  /** The code boxes were filled in. */
  (e: "complete"): void;
}>();

const { t } = useI18n();
const otp = ref<InstanceType<typeof OtpInput> | null>(null);

defineExpose({ focusCode: () => otp.value?.focus() });
</script>

<template>
  <div class="space-y-4">
    <div>
      <label :for="`${idPrefix}-password`" class="label">
        {{ t("dbBackups.stepUp.password") }}
        <span class="text-danger">*</span>
      </label>
      <PasswordInput
        :id="`${idPrefix}-password`"
        :model-value="password"
        autocomplete="current-password"
        :disabled="disabled"
        :invalid="Boolean(passwordError)"
        @update:model-value="emit('update:password', $event)"
      />
      <p v-if="passwordError" class="mt-1 flex animate-fade-in items-start gap-1 text-xs text-danger" role="alert">
        <UiIcon name="alert" :size="12" class="mt-0.5" />
        {{ passwordError }}
      </p>
    </div>

    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="-translate-y-1 opacity-0"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      leave-to-class="opacity-0"
    >
      <div v-if="needTotp" class="space-y-2 rounded-xl border border-line bg-surface-2/40 px-3 py-3 sm:px-4">
        <p class="label !mb-0 flex items-center justify-center gap-1.5">
          <UiIcon name="shield" :size="12" />
          {{ t("dbBackups.stepUp.totp") }}
          <span class="text-danger">*</span>
        </p>
        <OtpInput
          ref="otp"
          :model-value="code"
          :id-prefix="`${idPrefix}-otp`"
          :label="t('dbBackups.stepUp.totp')"
          :disabled="disabled"
          :invalid="Boolean(codeError)"
          @update:model-value="emit('update:code', $event)"
          @complete="emit('complete')"
        />
        <p v-if="codeError" class="flex items-center justify-center gap-1 text-xs text-danger" role="alert">
          <UiIcon name="alert" :size="12" />
          {{ codeError }}
        </p>
        <p v-else class="text-center text-2xs text-fg-subtle">{{ t("dbBackups.stepUp.totpHint") }}</p>
      </div>
    </Transition>

    <p v-if="checking" class="flex items-center gap-1.5 text-2xs text-fg-subtle" aria-live="polite">
      <UiIcon name="loader" :size="11" spin />
      {{ t("dbBackups.stepUp.checking") }}
    </p>
  </div>
</template>
