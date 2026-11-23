<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TotpSetupResponse } from "@slipgate/contracts";
import { apiJson } from "../../lib/api";
import { useAuthStore } from "../../stores/auth";
import CopyButton from "../ui/CopyButton.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import OtpInput from "./OtpInput.vue";
import PasswordInput from "./PasswordInput.vue";
import QrCode from "./QrCode.vue";
import { totpErrorText } from "./totpErrors";

/**
 * Turn on two-factor sign-in: confirm the password → scan the QR (or type the secret) →
 * confirm one code → done. The secret and codes live only in this dialog and are wiped on close.
 */
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "enabled"): void }>();

const { t } = useI18n();
const auth = useAuthStore();

type Step = "password" | "verify" | "done";
const STEPS: Step[] = ["password", "verify", "done"];

const step = ref<Step>("password");
const dir = ref<1 | -1>(1);
const password = ref("");
const secret = ref("");
const otpauthUrl = ref("");
const code = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const codeInvalid = ref(false);
const otp = ref<InstanceType<typeof OtpInput> | null>(null);

function wipe() {
  password.value = "";
  secret.value = "";
  otpauthUrl.value = "";
  code.value = "";
  error.value = null;
  codeInvalid.value = false;
}

watch(open, (value) => {
  wipe();
  if (value) {
    step.value = "password";
    dir.value = 1;
  }
});

watch(password, (value) => {
  if (value && step.value === "password") error.value = null;
});

// Typing again clears the error state (the reset to "" after a rejection must not).
watch(code, (value) => {
  if (!value) return;
  codeInvalid.value = false;
  error.value = null;
});

function go(next: Step) {
  dir.value = STEPS.indexOf(next) >= STEPS.indexOf(step.value) ? 1 : -1;
  error.value = null;
  step.value = next;
}

const stepIndex = computed(() => STEPS.indexOf(step.value));
const groupedSecret = computed(() => secret.value.match(/.{1,4}/g)?.join(" ") ?? "");

async function startSetup() {
  if (!password.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await apiJson<TotpSetupResponse>("/api/v1/user/totp/setup", {
      method: "POST",
      body: { password: password.value },
      fallbackError: t("security.totp.errors.setup"),
    });
    password.value = "";
    secret.value = res.secret;
    otpauthUrl.value = res.otpauthUrl;
    code.value = "";
    go("verify");
    await nextTick();
    // Wait for the step transition before focusing the first box.
    window.setTimeout(() => otp.value?.focus(), 260);
  } catch (err) {
    error.value = totpErrorText(err, "setup", t("security.totp.errors.setup"));
  } finally {
    busy.value = false;
  }
}

async function verify() {
  if (code.value.length !== 6 || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await apiJson("/api/v1/user/totp/enable", {
      method: "POST",
      body: { code: code.value },
      fallbackError: t("security.totp.errors.enable"),
    });
    if (auth.user) auth.user.totpEnabled = true;
    secret.value = "";
    otpauthUrl.value = "";
    code.value = "";
    go("done");
    emit("enabled");
  } catch (err) {
    const message = totpErrorText(err, "code", t("security.totp.errors.enable"));
    code.value = "";
    error.value = message;
    codeInvalid.value = true;
    await nextTick();
    otp.value?.focus();
  } finally {
    busy.value = false;
  }
}

function back() {
  secret.value = "";
  otpauthUrl.value = "";
  code.value = "";
  go("password");
}

const enterFrom = computed(() => (dir.value > 0 ? "translate-x-6 opacity-0" : "-translate-x-6 opacity-0"));
const leaveTo = computed(() => (dir.value > 0 ? "-translate-x-6 opacity-0" : "translate-x-6 opacity-0"));
</script>

<template>
  <UiModal v-model:open="open" :title="t('security.totp.enableTitle')" width="md">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="shield" :size="16" /></span>
    </template>

    <!-- Stepper -->
    <ol class="mb-5 flex items-center gap-2" :aria-label="t('security.totp.progress')">
      <li v-for="(s, i) in STEPS" :key="s" class="flex min-w-0 flex-1 items-center gap-2" :aria-current="i === stepIndex ? 'step' : undefined">
        <span
          class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold transition-colors duration-300"
          :class="
            i < stepIndex
              ? 'bg-success/15 text-success'
              : i === stepIndex
                ? 'bg-accent-solid text-accent-fg shadow-glow'
                : 'bg-surface-2 text-fg-subtle ring-1 ring-inset ring-line'
          "
        >
          <UiIcon v-if="i < stepIndex" name="check" :size="12" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="truncate text-xs" :class="i === stepIndex ? 'font-medium text-fg' : 'text-fg-subtle'">
          {{ t(`security.totp.steps.${s}`) }}
        </span>
        <span v-if="i < STEPS.length - 1" class="h-px min-w-[0.75rem] flex-1 bg-line" aria-hidden="true">
          <span
            class="block h-px bg-success transition-[width] duration-500 ease-out"
            :style="{ width: i < stepIndex ? '100%' : '0%' }"
          />
        </span>
      </li>
    </ol>

    <div class="relative overflow-hidden">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out"
        leave-active-class="transition duration-150 ease-in"
        :enter-from-class="enterFrom"
        :leave-to-class="leaveTo"
      >
        <!-- 1. Password -->
        <form v-if="step === 'password'" id="totp-setup-form" key="password" class="space-y-4" @submit.prevent="startSetup">
          <p class="text-sm text-fg-muted">{{ t("security.totp.passwordHint") }}</p>
          <div>
            <label for="totp-setup-pw" class="label">{{ t("security.totp.passwordLabel") }}</label>
            <PasswordInput id="totp-setup-pw" v-model="password" autocomplete="current-password" :invalid="Boolean(error)" :disabled="busy" />
          </div>
          <p class="flex items-start gap-1.5 text-xs text-fg-subtle">
            <UiIcon name="info" :size="12" class="mt-0.5" />
            {{ t("security.totp.apps") }}
          </p>
          <UiAlert v-if="error" tone="danger">{{ error }}</UiAlert>
        </form>

        <!-- 2. Scan + verify -->
        <form v-else-if="step === 'verify'" id="totp-verify-form" key="verify" class="space-y-5" @submit.prevent="verify">
          <div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            <QrCode :text="otpauthUrl" :size="168" :label="t('security.totp.qrLabel')" class="shrink-0 animate-scale-in" />
            <div class="min-w-0 flex-1 space-y-2 text-center sm:text-left">
              <p class="text-sm font-medium text-fg">{{ t("security.totp.scanTitle") }}</p>
              <p class="text-xs text-fg-subtle">{{ t("security.totp.scanHint") }}</p>
              <div class="flex items-center gap-1 rounded-lg border border-line bg-surface-2/60 py-1 pl-3 pr-1">
                <code class="min-w-0 flex-1 break-all text-left font-mono text-xs tracking-wide text-fg">{{ groupedSecret }}</code>
                <CopyButton :text="secret" />
              </div>
            </div>
          </div>
          <div class="space-y-2 border-t border-line/70 pt-4">
            <p class="text-center text-xs font-medium text-fg-muted">{{ t("security.totp.codeLabel") }}</p>
            <OtpInput ref="otp" v-model="code" id-prefix="totp-enable" :disabled="busy" :invalid="codeInvalid" @complete="verify" />
          </div>
          <UiAlert v-if="error" tone="danger">{{ error }}</UiAlert>
        </form>

        <!-- 3. Done -->
        <div v-else key="done" class="flex flex-col items-center py-4 text-center">
          <span class="inline-flex h-14 w-14 animate-scale-in items-center justify-center rounded-2xl bg-success/10 text-success ring-1 ring-inset ring-success/25">
            <UiIcon name="badge-check" :size="28" />
          </span>
          <p class="mt-4 text-base font-semibold text-fg">{{ t("security.totp.successTitle") }}</p>
          <p class="mt-1 max-w-xs text-sm text-fg-muted">{{ t("security.totp.successDesc") }}</p>
        </div>
      </Transition>
    </div>

    <template #footer>
      <template v-if="step === 'password'">
        <button type="button" class="btn btn-secondary" :disabled="busy" @click="open = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="totp-setup-form" class="btn btn-primary" :disabled="busy || !password">
          <UiIcon :name="busy ? 'loader' : 'arrow-right'" :size="15" :spin="busy" />
          {{ t("security.totp.continue") }}
        </button>
      </template>
      <template v-else-if="step === 'verify'">
        <button type="button" class="btn btn-ghost mr-auto" :disabled="busy" @click="back">
          <UiIcon name="chevron-left" :size="15" />
          {{ t("security.totp.back") }}
        </button>
        <button type="submit" form="totp-verify-form" class="btn btn-primary" :disabled="busy || code.length !== 6">
          <UiIcon :name="busy ? 'loader' : 'shield'" :size="15" :spin="busy" />
          {{ t("security.totp.verify") }}
        </button>
      </template>
      <button v-else type="button" class="btn btn-primary" @click="open = false">{{ t("security.totp.done") }}</button>
    </template>
  </UiModal>
</template>
