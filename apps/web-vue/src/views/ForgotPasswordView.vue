<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import type { CaptchaProof, ForgotPasswordRequest } from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import CaptchaWidget from "../components/captcha/CaptchaWidget.vue";
import UiAlert from "../components/ui/UiAlert.vue";
import UiIcon from "../components/ui/UiIcon.vue";
import { useCaptcha } from "../composables/useCaptcha";
import { ApiError, publicJson } from "../lib/api";
import { isCaptchaError, proofHasAnswer } from "../lib/captcha";
import { usePortalStore } from "../stores/portal";

const RESEND_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const { t } = useI18n();
const route = useRoute();
const portal = usePortalStore();

const settings = computed(() => portal.settings);
const settingsLoaded = ref(portal.settings !== null);
/** Set when the endpoint itself reports that reset-by-email is off (settings may be stale). */
const reportedUnavailable = ref(false);
/** Unknown settings count as available: the endpoint answers 400 when it isn't. */
const available = computed(() => !reportedUnavailable.value && settings.value?.passwordResetEnabled !== false);

function initialEmail(): string {
  const raw = route.query.email;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" ? v.trim().slice(0, 254) : "";
}

const email = ref(initialEmail());
const submitting = ref(false);
const errorMessage = ref<string | null>(null);
/** Address the link was sent to; switches the card to the "check your inbox" state. */
const sentTo = ref<string | null>(null);
const resent = ref(false);

watch(email, () => {
  if (!sentTo.value) errorMessage.value = null;
});

/* ---------------- Resend cooldown ---------------- */

const now = ref(Date.now());
const resendAt = ref(0);
let ticker: number | undefined;

const remaining = computed(() => Math.max(0, Math.ceil((resendAt.value - now.value) / 1000)));

function startCooldown() {
  resendAt.value = Date.now() + RESEND_SECONDS * 1000;
  now.value = Date.now();
  window.clearInterval(ticker);
  ticker = window.setInterval(() => {
    now.value = Date.now();
    if (now.value >= resendAt.value) window.clearInterval(ticker);
  }, 250);
}

onBeforeUnmount(() => window.clearInterval(ticker));

/* ---------------- Human verification ---------------- */

const { widget: captchaWidget, config: captchaConfig, available: captchaAvailable, required: captchaRequiredFor, proof: captchaProofFor, reset: resetCaptcha } =
  useCaptcha();
const captchaNeeded = computed(() => captchaRequiredFor("forgotPassword"));
const showCaptcha = computed(() => captchaNeeded.value && captchaAvailable.value && captchaConfig.value !== null);
/** Backend (admin-only) mode: only administrator accounts get reset mail. */
const backendMode = computed(() => settings.value?.backendModeEnabled === true);

/* ---------------- Requests ---------------- */

async function request(address: string): Promise<boolean> {
  errorMessage.value = null;
  let proof: CaptchaProof | null | undefined;
  submitting.value = true;
  try {
    proof = await captchaProofFor(captchaNeeded.value);
    if (proof === null) return false;
    const body: ForgotPasswordRequest = { email: address };
    if (proof) body.captcha = proof;
    await publicJson<{ accepted: boolean }>("/api/v1/auth/forgot-password", { method: "POST", body });
    return true;
  } catch (err) {
    if (err instanceof ApiError && isCaptchaError(err.code)) {
      errorMessage.value = t(`authGuards.errors.${err.code}`);
    } else if (err instanceof ApiError && err.status === 400) {
      // 400 is either a malformed address or reset-by-email being off; the settings tell which.
      const fresh = await portal.refresh();
      if (fresh?.passwordResetEnabled) errorMessage.value = t("register.forgot.errors.invalidEmail");
      else reportedUnavailable.value = true;
    } else if (err instanceof ApiError && err.status === 403) {
      errorMessage.value = t("register.forgot.errors.rateLimited");
    } else if (err instanceof ApiError) {
      errorMessage.value = t("register.forgot.errors.failed");
    } else {
      errorMessage.value = t("common.networkError");
    }
    return false;
  } finally {
    submitting.value = false;
    // Answers are one-time (a resend needs a fresh one).
    if (proofHasAnswer(proof)) resetCaptcha();
  }
}

async function submit() {
  if (submitting.value) return;
  const address = email.value.trim();
  if (!EMAIL_RE.test(address)) {
    errorMessage.value = t("register.forgot.errors.invalidEmail");
    return;
  }
  if (await request(address)) {
    sentTo.value = address;
    resent.value = false;
    startCooldown();
  }
}

async function resend() {
  if (!sentTo.value || remaining.value > 0 || submitting.value) return;
  resent.value = false;
  if (await request(sentTo.value)) {
    resent.value = true;
    startCooldown();
  }
}

function useAnother() {
  sentTo.value = null;
  resent.value = false;
  errorMessage.value = null;
}

onMounted(async () => {
  await portal.load();
  settingsLoaded.value = true;
});

const fade = {
  enterActiveClass: "transition duration-200 ease-out motion-reduce:transition-none",
  leaveActiveClass: "transition duration-150 ease-in motion-reduce:transition-none",
  enterFromClass: "translate-y-1.5 opacity-0",
  leaveToClass: "-translate-y-1 opacity-0",
};
</script>

<template>
  <AuthLayout :site-name="settings?.siteName">
    <Transition mode="out-in" v-bind="fade">
      <!-- ============ Loading settings ============ -->
      <div v-if="!settingsLoaded" key="loading" class="space-y-4" aria-busy="true" :aria-label="t('register.forgot.loading')">
        <div class="mx-auto h-6 w-32 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" />
        <div class="mx-auto h-4 w-56 max-w-full animate-pulse rounded bg-surface-2/70 motion-reduce:animate-none" />
        <div class="h-10 animate-pulse rounded-lg bg-surface-2/70 motion-reduce:animate-none" />
        <div class="h-10 animate-pulse rounded-lg bg-surface-2 motion-reduce:animate-none" />
      </div>

      <!-- ============ Reset by email is off ============ -->
      <div v-else-if="!available" key="unavailable" class="text-center">
        <span class="icon-chip icon-chip-warning mx-auto h-12 w-12 rounded-2xl">
          <UiIcon name="mail" :size="22" />
        </span>
        <h1 class="mt-4 text-xl font-semibold tracking-tight text-fg">{{ t("register.forgot.unavailableTitle") }}</h1>
        <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ t("register.forgot.unavailableBody") }}</p>
        <div
          v-if="settings?.contactInfo"
          class="mt-5 rounded-lg border border-line bg-surface-2/50 px-3.5 py-3 text-left"
        >
          <p class="eyebrow">{{ t("register.forgot.contact") }}</p>
          <p class="mt-1 whitespace-pre-line break-words text-sm text-fg-muted">{{ settings.contactInfo }}</p>
        </div>
        <RouterLink to="/login" class="btn btn-primary mt-6 h-10 w-full">
          <UiIcon name="chevron-left" :size="16" />
          {{ t("register.backToLogin") }}
        </RouterLink>
      </div>

      <!-- ============ Link sent ============ -->
      <div v-else-if="sentTo" key="sent" class="text-center">
        <span class="sent-mark relative mx-auto flex h-14 w-14 items-center justify-center" aria-hidden="true">
          <span class="sent-ring absolute inset-0 rounded-2xl bg-success/15" />
          <span class="icon-chip icon-chip-success relative h-14 w-14 rounded-2xl">
            <UiIcon name="mail" :size="24" />
          </span>
        </span>
        <h1 class="mt-5 text-xl font-semibold tracking-tight text-fg">{{ t("register.forgot.sentTitle") }}</h1>
        <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ t("register.forgot.sentLead") }}</p>
        <p
          class="mx-auto mt-2 inline-block max-w-full break-all rounded-md bg-surface-2 px-2.5 py-1 font-mono text-sm text-fg ring-1 ring-inset ring-line"
        >
          {{ sentTo }}
        </p>

        <ul class="mt-5 space-y-2 rounded-lg border border-line/80 bg-surface-2/40 px-3.5 py-3 text-left text-xs text-fg-muted">
          <li class="flex items-start gap-2">
            <UiIcon name="clock" :size="14" class="mt-px text-fg-subtle" />
            <span class="min-w-0">{{ t("register.forgot.sentValidity") }}</span>
          </li>
          <li class="flex items-start gap-2">
            <UiIcon name="inbox" :size="14" class="mt-px text-fg-subtle" />
            <span class="min-w-0">{{ t("register.forgot.sentSpam") }}</span>
          </li>
        </ul>

        <div class="mt-5 space-y-3" aria-live="polite">
          <!-- A resend needs a fresh challenge too -->
          <CaptchaWidget v-if="showCaptcha && captchaConfig && remaining === 0" ref="captchaWidget" :config="captchaConfig" class="text-left" />
          <UiAlert v-if="errorMessage" tone="danger" class="text-left">{{ errorMessage }}</UiAlert>
          <p v-else-if="resent" class="flex animate-fade-in items-center justify-center gap-1.5 text-xs text-success">
            <UiIcon name="check-circle" :size="13" />
            {{ t("register.forgot.resent") }}
          </p>
          <button
            type="button"
            class="btn btn-secondary h-10 w-full"
            :disabled="remaining > 0 || submitting"
            :aria-busy="submitting"
            @click="resend"
          >
            <UiIcon :name="submitting ? 'loader' : 'rotate-ccw'" :size="15" :spin="submitting" />
            <span v-if="submitting">{{ t("register.forgot.sending") }}</span>
            <span v-else-if="remaining > 0" class="tabular-nums">{{ t("register.forgot.resendIn", { n: remaining }) }}</span>
            <span v-else>{{ t("register.forgot.resend") }}</span>
          </button>
        </div>

        <div class="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-4 text-xs">
          <button type="button" class="cursor-pointer font-medium text-fg-muted transition-colors hover:text-fg" @click="useAnother">
            {{ t("register.forgot.useAnother") }}
          </button>
          <RouterLink to="/login" class="inline-flex items-center gap-1 font-medium text-accent hover:underline">
            {{ t("register.backToLogin") }}
            <UiIcon name="arrow-right" :size="12" />
          </RouterLink>
        </div>
      </div>

      <!-- ============ Request form ============ -->
      <div v-else key="form">
        <h1 class="text-center text-xl font-semibold tracking-tight text-fg">{{ t("register.forgot.title") }}</h1>
        <p class="mt-2 text-center text-sm leading-relaxed text-fg-muted">{{ t("register.forgot.subtitle") }}</p>

        <form class="mt-6 space-y-4" novalidate @submit.prevent="submit">
          <label class="block">
            <span class="label">{{ t("auth.email") }}</span>
            <span class="relative block">
              <UiIcon name="mail" :size="15" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <input
                v-model="email"
                type="email"
                inputmode="email"
                required
                autocomplete="email"
                autocapitalize="off"
                spellcheck="false"
                maxlength="254"
                :placeholder="t('auth.emailPlaceholder')"
                class="input h-10 pl-9"
                :class="errorMessage ? '!border-danger/60 focus:!ring-danger/20' : ''"
                :aria-invalid="Boolean(errorMessage)"
                :aria-describedby="errorMessage ? 'forgot-error' : undefined"
              />
            </span>
          </label>

          <CaptchaWidget v-if="showCaptcha && captchaConfig" ref="captchaWidget" :config="captchaConfig" />

          <p v-if="backendMode" class="flex items-start gap-1.5 text-xs leading-relaxed text-fg-subtle">
            <UiIcon name="lock" :size="13" class="mt-px shrink-0" />
            <span class="min-w-0">{{ t("authGuards.backendMode.forgotNote") }}</span>
          </p>

          <Transition
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
            enter-from-class="-translate-y-1 opacity-0"
            leave-to-class="opacity-0"
          >
            <UiAlert v-if="errorMessage" id="forgot-error" tone="danger">{{ errorMessage }}</UiAlert>
          </Transition>

          <button type="submit" class="btn btn-primary h-10 w-full" :disabled="submitting" :aria-busy="submitting">
            <UiIcon v-if="submitting" name="loader" :size="16" spin />
            {{ submitting ? t("register.forgot.sending") : t("register.forgot.submit") }}
          </button>
        </form>

        <p class="mt-6 border-t border-line/70 pt-4 text-center text-xs text-fg-subtle">
          {{ t("register.forgot.remembered") }}
          <RouterLink to="/login" class="ml-1 font-medium text-accent hover:underline">{{ t("register.backToLogin") }}</RouterLink>
        </p>
      </div>
    </Transition>
  </AuthLayout>
</template>

<style scoped>
/* One soft pulse behind the envelope when the "sent" state appears. */
.sent-ring {
  animation: sent-ring 1.4s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both;
}
.sent-mark {
  animation: sent-pop 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes sent-ring {
  from {
    opacity: 0.9;
    transform: scale(0.9);
  }
  to {
    opacity: 0;
    transform: scale(1.6);
  }
}
@keyframes sent-pop {
  from {
    opacity: 0;
    transform: scale(0.8);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sent-ring,
  .sent-mark {
    animation: none;
  }
  .sent-ring {
    opacity: 0;
  }
}
</style>
