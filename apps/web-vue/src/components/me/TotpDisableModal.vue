<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { apiJson } from "../../lib/api";
import { useAuthStore } from "../../stores/auth";
import UiAlert from "../ui/UiAlert.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import OtpInput from "./OtpInput.vue";
import PasswordInput from "./PasswordInput.vue";
import { totpErrorText } from "./totpErrors";

/** Turn two-factor sign-in off: needs the password and a current code. Inputs are wiped on close. */
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "disabled"): void }>();

const { t } = useI18n();
const auth = useAuthStore();

const password = ref("");
const code = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const codeInvalid = ref(false);
const otp = ref<InstanceType<typeof OtpInput> | null>(null);

watch(open, () => {
  password.value = "";
  code.value = "";
  error.value = null;
  codeInvalid.value = false;
});

// Typing again clears the error state (the reset to "" after a rejection must not).
watch(code, (value) => {
  if (value) codeInvalid.value = false;
});

async function submit() {
  if (!password.value) return;
  if (code.value.length !== 6) {
    otp.value?.focus();
    return;
  }
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await apiJson("/api/v1/user/totp/disable", {
      method: "POST",
      body: { password: password.value, code: code.value },
      fallbackError: t("security.totp.errors.disable"),
    });
    if (auth.user) auth.user.totpEnabled = false;
    password.value = "";
    code.value = "";
    emit("disabled");
    open.value = false;
  } catch (err) {
    error.value = totpErrorText(err, "code", t("security.totp.errors.disable"));
    code.value = "";
    codeInvalid.value = true;
    await nextTick();
    otp.value?.focus();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal v-model:open="open" :title="t('security.totp.disableTitle')" width="md">
    <template #icon>
      <span class="icon-chip icon-chip-danger h-8 w-8"><UiIcon name="shield-alert" :size="16" /></span>
    </template>

    <form id="totp-disable-form" class="space-y-4" @submit.prevent="submit">
      <UiAlert tone="warning">{{ t("security.totp.disableDesc") }}</UiAlert>
      <div>
        <label for="totp-disable-pw" class="label">{{ t("security.totp.passwordLabel") }}</label>
        <PasswordInput id="totp-disable-pw" v-model="password" autocomplete="current-password" :disabled="busy" />
      </div>
      <div class="space-y-2">
        <p class="label">{{ t("security.totp.currentCode") }}</p>
        <OtpInput
          ref="otp"
          v-model="code"
          id-prefix="totp-disable"
          :disabled="busy"
          :invalid="codeInvalid"
          @complete="password && submit()"
        />
      </div>
      <UiAlert v-if="error" tone="danger">{{ error }}</UiAlert>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">{{ t("common.cancel") }}</button>
      <button
        type="submit"
        form="totp-disable-form"
        class="btn btn-danger-solid"
        :disabled="busy || !password || code.length !== 6"
      >
        <UiIcon :name="busy ? 'loader' : 'shield-alert'" :size="15" :spin="busy" />
        {{ t("security.totp.disableConfirm") }}
      </button>
    </template>
  </UiModal>
</template>
