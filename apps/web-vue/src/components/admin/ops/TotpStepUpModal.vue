<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import OtpInput from "../../me/OtpInput.vue";
import UiIcon, { type IconName } from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { ApiError, apiJson, errorText } from "../../../lib/api";
import { useAuthStore } from "../../../stores/auth";

/**
 * Confirms a destructive audit-log action (clear, shortening retention, an on-demand sweep) with a
 * fresh two-factor code; the server checks it on every call (bff security/step_up.ts) and never
 * takes a password instead. Administrators without two-factor authentication get a blocked state
 * pointing to their profile.
 *
 * `action` receives the code and throws the API error when refused; the modal maps the step-up
 * error codes (totp_not_enabled, invalid_totp, too_many_attempts, …), clears the boxes on a bad
 * code and closes itself once `action` resolves.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    submitLabel: string;
    pendingLabel: string;
    /** Error text when a refusal is not one of the step-up codes. */
    fallbackError: string;
    action: (totpCode: string) => Promise<void>;
    icon?: IconName;
    /** Danger styling (red chip and submit button). */
    danger?: boolean;
  }>(),
  { icon: "shield", danger: true },
);
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const { t } = useI18n();
const auth = useAuthStore();
const uid = useId();

/** checking: two-factor state unknown yet; blocked: two-factor is off for this account. */
type Factor = "checking" | "totp" | "blocked";

const factor = ref<Factor>("checking");
const code = ref("");
const busy = ref(false);
const failure = ref<string | null>(null);
const codeInvalid = ref(false);
const otp = ref<InstanceType<typeof OtpInput> | null>(null);
let checkSeq = 0;

function setTotpEnabled(enabled: boolean) {
  factor.value = enabled ? "totp" : "blocked";
  if (auth.user && auth.user.totpEnabled !== enabled) auth.user.totpEnabled = enabled;
}

/** Re-reads the caller's two-factor state (the session copy may predate a change elsewhere). */
async function refreshFactor() {
  const mine = ++checkSeq;
  try {
    const res = await apiJson<{ enabled: boolean }>("/api/v1/user/totp");
    if (mine === checkSeq && !busy.value) setTotpEnabled(res.enabled);
  } catch {
    // Unknown: offer the code; the server answers totp_not_enabled if it is off.
    if (mine === checkSeq && factor.value === "checking") factor.value = "totp";
  }
}

watch(
  () => props.open,
  (open) => {
    // Never keep a code around between openings.
    code.value = "";
    failure.value = null;
    codeInvalid.value = false;
    if (!open) {
      busy.value = false;
      checkSeq++;
      return;
    }
    factor.value = auth.user?.totpEnabled ? "totp" : "checking";
    void refreshFactor();
  },
  { immediate: true },
);

watch(code, (value) => {
  if (value) {
    codeInvalid.value = false;
    if (failure.value) failure.value = null;
  }
});

const canSubmit = computed(() => !busy.value && factor.value === "totp" && code.value.length === 6);

function failureText(err: unknown): string | null {
  if (err instanceof ApiError) {
    if (err.code === "totp_not_enabled") {
      // Two-factor was turned off meanwhile: the blocked state explains what to do.
      setTotpEnabled(false);
      return null;
    }
    if (err.code === "invalid_totp") return t("audit.stepUp.errors.invalidTotp");
    if (err.status === 429 || err.code === "too_many_attempts") return t("audit.stepUp.errors.tooMany");
    if (err.code === "totp_required") return t("audit.stepUp.errors.required");
    if (err.code === "bad_request") return t("audit.stepUp.errors.badCode");
  }
  return errorText(err, props.fallbackError);
}

async function submit() {
  if (!canSubmit.value) {
    if (factor.value === "totp") otp.value?.focus();
    return;
  }
  busy.value = true;
  failure.value = null;
  try {
    await props.action(code.value);
    code.value = "";
    emit("update:open", false);
  } catch (err) {
    failure.value = failureText(err);
    code.value = "";
    if (factor.value === "totp") {
      codeInvalid.value = failure.value !== null;
      await nextTick();
      otp.value?.focus();
    }
  } finally {
    busy.value = false;
  }
}

function close() {
  if (!busy.value) emit("update:open", false);
}
</script>

<template>
  <UiModal :open="open" width="md" :title="title" :persistent="busy" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip h-8 w-8" :class="danger ? 'icon-chip-danger' : 'icon-chip-accent'">
        <UiIcon :name="icon" :size="15" />
      </span>
    </template>

    <form :id="`${uid}-form`" class="space-y-4" novalidate @submit.prevent="submit">
      <slot />

      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0 translate-y-1"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <!-- Two-factor state not known yet -->
        <div v-if="factor === 'checking'" key="checking" class="space-y-3" aria-busy="true" role="status">
          <span class="mx-auto block h-2.5 w-2/3 rounded-full bg-surface-2 motion-safe:animate-pulse" />
          <div class="flex justify-center gap-2">
            <span v-for="i in 6" :key="i" class="block h-11 w-10 rounded-lg bg-surface-2 motion-safe:animate-pulse" />
          </div>
          <p class="flex items-center justify-center gap-1.5 text-2xs text-fg-subtle">
            <UiIcon name="loader" :size="11" spin />
            {{ t("audit.stepUp.checking") }}
          </p>
        </div>

        <!-- Two-factor is off: nothing destructive without it -->
        <div
          v-else-if="factor === 'blocked'"
          key="blocked"
          class="flex flex-col items-center gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-5 text-center"
          role="alert"
        >
          <span class="icon-chip icon-chip-warning h-10 w-10">
            <UiIcon name="shield-alert" :size="18" />
          </span>
          <div class="space-y-1">
            <p class="text-sm font-semibold text-fg">{{ t("audit.stepUp.blockedTitle") }}</p>
            <p class="text-xs leading-relaxed text-fg-muted">{{ t("audit.stepUp.blockedDesc") }}</p>
          </div>
        </div>

        <!-- Code -->
        <div v-else key="totp" class="space-y-3">
          <p class="text-sm text-fg-muted">{{ t("audit.stepUp.prompt") }}</p>
          <div class="space-y-2">
            <p class="label !mb-0 text-center">{{ t("audit.stepUp.codeLabel") }}</p>
            <OtpInput
              ref="otp"
              v-model="code"
              :id-prefix="`${uid}-otp`"
              :label="t('audit.stepUp.codeLabel')"
              :disabled="busy"
              :invalid="codeInvalid"
              autofocus
              @complete="submit"
            />
          </div>
          <p class="text-center text-xs text-fg-subtle">{{ t("audit.stepUp.hint") }}</p>
        </div>
      </Transition>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <p v-if="failure" class="flex items-start gap-1.5 text-xs text-danger" role="alert">
          <UiIcon name="alert" :size="12" class="mt-px shrink-0" />
          {{ failure }}
        </p>
      </Transition>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="close">
        {{ t("common.cancel") }}
      </button>
      <RouterLink v-if="factor === 'blocked'" to="/profile" class="btn btn-primary" @click="close">
        <UiIcon name="shield" :size="15" />
        {{ t("audit.stepUp.setup") }}
      </RouterLink>
      <button
        v-else
        type="submit"
        :form="`${uid}-form`"
        class="btn"
        :class="danger ? 'btn-danger-solid' : 'btn-primary'"
        :disabled="!canSubmit"
      >
        <UiIcon :name="busy ? 'loader' : icon" :size="15" :spin="busy" />
        {{ busy ? pendingLabel : submitLabel }}
      </button>
    </template>
  </UiModal>
</template>
