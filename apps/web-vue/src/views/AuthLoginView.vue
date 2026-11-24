<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import {
  isRegistrationEmailSuffixAllowed,
  isReservedEmail,
  splitEmailForPolicy,
  type AuthLoginRequest,
  type AuthRegisterRequest,
  type AuthSessionResponse,
  type CaptchaPassResponse,
  type CaptchaProof,
  type PromoCodeCheckResponse,
  type PublicOAuthProvider,
  type SendEmailCodeRequest,
} from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import LoginAgreementPrompt from "../components/auth/LoginAgreementPrompt.vue";
import CaptchaWidget from "../components/captcha/CaptchaWidget.vue";
import { useCaptcha } from "../composables/useCaptcha";
import { useLoginAgreement } from "../composables/useLoginAgreement";
import { isCaptchaError, proofHasAnswer } from "../lib/captcha";
import OtpInput from "../components/me/OtpInput.vue";
import OAuthProviderMark from "../components/settings/OAuthProviderMark.vue";
import { OAUTH_DEFAULT_NAMES } from "../components/settings/oauthForm";
import SegmentedControl from "../components/ui/SegmentedControl.vue";
import UiAlert from "../components/ui/UiAlert.vue";
import UiIcon, { type IconName } from "../components/ui/UiIcon.vue";
import { ApiError, publicJson } from "../lib/api";
import { formatUsd } from "../lib/format";
import { getPasskeyAssertion, isWebAuthnSupported, type ServerRequestOptions } from "../lib/webauthn";
import { useAuthStore } from "../stores/auth";
import { usePortalStore } from "../stores/portal";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_COOLDOWN_SECONDS = 60;

const { t, te } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const portal = usePortalStore();

/** First value of a query parameter as a trimmed string. */
function queryParam(name: string): string {
  const raw = route.query[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" ? v.trim() : "";
}

const settings = computed(() => portal.settings);
const canRegister = computed(() => settings.value?.allowRegistration ?? auth.setupStatus?.allowRegistration ?? true);
const promoEnabled = computed(() => settings.value?.promoCodeEnabled === true);
const inviteRequired = computed(() => settings.value?.inviteRequired === true);
const passwordResetEnabled = computed(() => settings.value?.passwordResetEnabled === true);
const emailVerification = computed(() => settings.value?.emailVerificationRequired === true);
/** Backend (admin-only) mode: sign-up is closed and only administrators can sign in. */
const backendMode = computed(() => settings.value?.backendModeEnabled === true);

/* ---------------- Sign-in guards: captcha, agreement, sign-up email policy ---------------- */

const {
  widget: captchaWidget,
  config: captchaConfig,
  available: captchaAvailable,
  required: captchaRequiredFor,
  proof: captchaProofFor,
  reset: resetCaptcha,
} = useCaptcha();

const {
  enabled: agreementEnabled,
  mode: agreementMode,
  documents: agreementDocs,
  updatedAt: agreementUpdatedAt,
  accepted: agreementAccepted,
  blocked: agreementBlocked,
  dialogOpen: agreementDialogOpen,
  accept: acceptAgreement,
  reject: rejectAgreement,
} = useLoginAgreement();
/** Highlights the consent checkbox after a blocked attempt. */
const agreementAttention = ref(false);

/** Sign-up with an email code skips the challenge when sending the code already needed one. */
const emailCodeNeedsCaptcha = computed(() => emailVerification.value && captchaRequiredFor("emailCode"));
const registerNeedsCaptcha = computed(() => captchaRequiredFor("register") && !emailCodeNeedsCaptcha.value);
const oauthNeedsCaptcha = computed(() => captchaRequiredFor("oauth"));

/** One-time pass from the first sign-in step, sent with the two-factor code instead of a new challenge. */
const captchaPass = ref<string | null>(null);
/** A challenge popup is open (guards against a second click starting another). */
let captchaBusy = false;

/** Consent first: open the dialog again, or point at the checkbox. */
function nudgeAgreement() {
  if (agreementMode.value === "modal") {
    agreementDialogOpen.value = true;
    return;
  }
  errorMessage.value = t("authGuards.agreement.required");
  agreementAttention.value = false;
  void nextTick(() => (agreementAttention.value = true));
}

watch(agreementAccepted, (ok) => {
  if (!ok) return;
  agreementAttention.value = false;
  if (errorMessage.value === t("authGuards.agreement.required")) errorMessage.value = null;
});

/** Friendly copy for an auth-guard error code (captcha, sign-up email policy, backend mode). */
function guardMessage(code: string | undefined, allowedSuffixes?: string[]): string | null {
  if (!code) return null;
  if (code === "email_suffix_not_allowed" && allowedSuffixes?.length) {
    return t("authGuards.errors.email_suffix_not_allowed_list", { list: allowedSuffixes.join(t("authGuards.listSeparator")) });
  }
  const key = `authGuards.errors.${code}`;
  return /^[a-z_]+$/.test(code) && te(key) ? t(key) : null;
}

/** Sign-up email allowlist as the visitor sees it, and a live check of the typed address. */
const allowedSuffixes = computed(() => settings.value?.registrationEmailSuffixAllowlist ?? []);
const domainQuota = computed(() => settings.value?.registrationEmailDomainQuotaEnabled === true);
const emailPolicyHint = computed<{ icon: IconName; cls: string; text: string } | null>(() => {
  if (mode.value !== "register") return null;
  const address = email.value.trim();
  const parts = EMAIL_RE.test(address) ? splitEmailForPolicy(address) : null;
  if (parts && isReservedEmail(address)) return { icon: "x-circle", cls: "text-danger", text: t("authGuards.errors.email_reserved") };
  const list = allowedSuffixes.value;
  if (!list.length) return null;
  const listText = list.join(t("authGuards.listSeparator"));
  if (parts && !isRegistrationEmailSuffixAllowed(address, list)) {
    return domainQuota.value
      ? { icon: "info", cls: "text-warning", text: t("authGuards.signup.quotaDomain", { list: listText }) }
      : { icon: "x-circle", cls: "text-danger", text: t("authGuards.signup.notAllowed", { list: listText }) };
  }
  return { icon: "info", cls: "text-fg-subtle", text: t(domainQuota.value ? "authGuards.signup.allowedQuota" : "authGuards.signup.allowed", { list: listText }) };
});

/** Shown once after the server ended this browser's session (backend mode switched on). */
const sessionNotice = ref(auth.consumeSessionNotice());

const mode = ref<"login" | "register">("login");
const email = ref("");
const password = ref("");
const username = ref("");
const promoCode = ref(queryParam("promo"));
const inviteCode = ref(queryParam("invite"));
const affCode = queryParam("aff").slice(0, 32);
const showPassword = ref(false);
const submitting = ref(false);
const errorMessage = ref<string | null>(null);

const showAffChip = computed(() => Boolean(affCode) && settings.value?.affiliateEnabled !== false);

function wantsRegister(): boolean {
  return queryParam("mode") === "register" || Boolean(queryParam("promo") || queryParam("aff") || queryParam("invite"));
}

onMounted(() => {
  void portal.load();
  if (canRegister.value && wantsRegister()) mode.value = "register";
  consumeOAuthError();
  void loadOAuthProviders();
  window.addEventListener("pageshow", onPageShow);
});

// Settings can arrive late (or change); never leave a closed registration form open.
watch(canRegister, (open) => {
  if (!open) mode.value = "login";
  else if (wantsRegister()) mode.value = "register";
});

/* ---------------- Two-factor second step ---------------- */
const step = ref<"credentials" | "totp">("credentials");
const totpCode = ref("");
const totpInvalid = ref(false);
const otpRef = ref<InstanceType<typeof OtpInput> | null>(null);

// Typing again clears the error state (the reset to "" after a rejection must not).
watch(totpCode, (code) => {
  if (!code) return;
  totpInvalid.value = false;
  if (step.value === "totp") errorMessage.value = null;
});

function enterTotpStep() {
  step.value = "totp";
  totpCode.value = "";
  totpInvalid.value = false;
  errorMessage.value = null;
  // Focus once the step transition has swapped the form in.
  window.setTimeout(() => otpRef.value?.focus(), 240);
}

function backToCredentials() {
  step.value = "credentials";
  captchaPass.value = null;
  totpCode.value = "";
  totpInvalid.value = false;
  errorMessage.value = null;
}

async function rejectTotp(message: string) {
  errorMessage.value = message;
  totpCode.value = "";
  totpInvalid.value = true;
  await nextTick();
  otpRef.value?.focus();
}

function onTotpComplete() {
  if (!submitting.value) void handleSubmit();
}

const LOGIN_ERRORS: Record<string, string> = {
  invalid_totp: "security.login.invalid",
  too_many_attempts: "security.login.tooMany",
};

watch(mode, () => {
  errorMessage.value = null;
  codeError.value = null;
  backToCredentials();
});

/* ---------------- Email verification code (register) ---------------- */
const emailCode = ref("");
/** i18n key of the message shown under the code field. */
const codeError = ref<string | null>(null);
const sendingCode = ref(false);
/** Lower-cased address the last code went to; the cooldown and "sent" hint apply to it only. */
const codeSentTo = ref<string | null>(null);
const emailInputRef = ref<HTMLInputElement | null>(null);
const codeInputRef = ref<HTMLInputElement | null>(null);

const codeNow = ref(Date.now());
const codeResendAt = ref(0);
let codeTicker: number | undefined;

const codeRemaining = computed(() => Math.max(0, Math.ceil((codeResendAt.value - codeNow.value) / 1000)));
const codeForCurrentEmail = computed(() => codeSentTo.value !== null && codeSentTo.value === email.value.trim().toLowerCase());
const codeCoolingDown = computed(() => codeForCurrentEmail.value && codeRemaining.value > 0);

function startCodeCooldown(seconds: number) {
  codeResendAt.value = Date.now() + seconds * 1000;
  codeNow.value = Date.now();
  window.clearInterval(codeTicker);
  codeTicker = window.setInterval(() => {
    codeNow.value = Date.now();
    if (codeNow.value >= codeResendAt.value) window.clearInterval(codeTicker);
  }, 250);
}

onBeforeUnmount(() => window.clearInterval(codeTicker));

// Digits only; typing again clears a rejection.
watch(emailCode, (value) => {
  const digits = value.replace(/\D/g, "").slice(0, 6);
  if (digits !== value) emailCode.value = digits;
  if (digits) codeError.value = null;
});

// A "fill in the email first" hint is stale once the address changes.
watch(email, () => {
  if (codeError.value === "register.emailCode.emailFirst") codeError.value = null;
});

async function sendEmailCode() {
  if (sendingCode.value || codeCoolingDown.value || captchaBusy) return;
  codeError.value = null;
  if (agreementBlocked.value) {
    nudgeAgreement();
    return;
  }
  const address = email.value.trim();
  if (!EMAIL_RE.test(address)) {
    codeError.value = "register.emailCode.emailFirst";
    emailInputRef.value?.focus();
    return;
  }
  captchaBusy = true;
  let proof: CaptchaProof | null | undefined;
  try {
    proof = await captchaProofFor(emailCodeNeedsCaptcha.value);
  } finally {
    captchaBusy = false;
  }
  if (proof === null) return;
  sendingCode.value = true;
  try {
    const body: SendEmailCodeRequest = { email: address, purpose: "register" };
    if (proof) body.captcha = proof;
    const res = await publicJson<{ sent: boolean; cooldownSeconds?: number }>("/api/v1/auth/email-code", { method: "POST", body });
    codeSentTo.value = address.toLowerCase();
    startCodeCooldown(res.cooldownSeconds && res.cooldownSeconds > 0 ? res.cooldownSeconds : CODE_COOLDOWN_SECONDS);
    await nextTick();
    codeInputRef.value?.focus();
  } catch (err) {
    const code = err instanceof ApiError ? err.code : null;
    if (code && guardMessage(code)) {
      // Captcha, sign-up email policy, already registered, backend mode.
      codeError.value = `authGuards.errors.${code}`;
      if (code === "backend_mode") void portal.refresh();
    } else if (err instanceof ApiError && err.status === 409) {
      codeError.value = "register.emailCode.cooldown";
    } else if (err instanceof ApiError && err.status === 403) {
      // Rate limited, or sign-up closed meanwhile (fresh settings close the form).
      const fresh = await portal.refresh();
      codeError.value = fresh && !fresh.allowRegistration ? "auth.registrationClosed" : "register.emailCode.rateLimited";
    } else if (err instanceof ApiError && err.status === 400) {
      // Either a malformed address or mail being off; fresh settings tell which (the field hides when off).
      const fresh = await portal.refresh();
      codeError.value = fresh?.emailVerificationRequired ? "register.emailCode.emailFirst" : null;
    } else if (err instanceof ApiError) {
      codeError.value = "register.emailCode.failed";
    } else {
      codeError.value = "common.networkError";
    }
  } finally {
    sendingCode.value = false;
    // Answers are one-time: the next code (or the sign-up) needs a fresh one.
    if (proofHasAnswer(proof)) resetCaptcha();
  }
}

const codeHint = computed<{ icon: IconName; cls: string; text: string }>(() => {
  if (codeError.value) return { icon: "x-circle", cls: "text-danger", text: t(codeError.value) };
  if (codeForCurrentEmail.value) return { icon: "check-circle", cls: "text-success", text: t("register.emailCode.sent") };
  return { icon: "info", cls: "text-fg-subtle", text: t("register.emailCode.required") };
});

async function rejectEmailCode(key: string) {
  codeError.value = key;
  await nextTick();
  codeInputRef.value?.focus();
  codeInputRef.value?.select();
}

/* ---------------- Third-party sign-in ---------------- */
const oauthProviders = ref<PublicOAuthProvider[]>([]);
/** Provider whose sign-in page is loading (full-page navigation under way). */
const oauthPending = ref<string | null>(null);
/** Error code the provider round trip came back with (?oauth_error=). */
const oauthErrorCode = ref<string | null>(null);

const oauthErrorText = computed(() => {
  const code = oauthErrorCode.value;
  if (!code) return "";
  const key = `register.oauth.errors.${code}`;
  if (/^[a-z_]+$/.test(code) && te(key)) return t(key);
  // Sign-in guards: captcha, sign-up email policy, backend mode.
  const oauthKey = `authGuards.oauthErrors.${code}`;
  if (/^[a-z_]+$/.test(code) && te(oauthKey)) return t(oauthKey);
  return guardMessage(code) ?? t("register.oauth.genericError");
});

/** The widget shows wherever a flow on the current form needs a challenge (never while off). */
const showCaptcha = computed(() => {
  if (!captchaAvailable.value || !captchaConfig.value) return false;
  const oauth = oauthNeedsCaptcha.value && oauthProviders.value.length > 0;
  if (mode.value === "login") return captchaRequiredFor("login") || oauth;
  return registerNeedsCaptcha.value || emailCodeNeedsCaptcha.value || oauth;
});

async function loadOAuthProviders() {
  try {
    const res = await publicJson<{ items?: PublicOAuthProvider[] }>("/api/v1/auth/oauth/providers");
    oauthProviders.value = (res.items ?? []).filter((p) => p.id in OAUTH_DEFAULT_NAMES);
  } catch {
    oauthProviders.value = [];
  }
}

/** Shows ?oauth_error once, then drops it from the address bar (keeping ?redirect and friends). */
function consumeOAuthError() {
  const code = queryParam("oauth_error");
  if (!code) return;
  oauthErrorCode.value = code.slice(0, 64);
  const query = { ...route.query };
  delete query.oauth_error;
  void router.replace({ query });
}

function oauthStartUrl(id: PublicOAuthProvider["id"], captchaPassValue?: string | null): string {
  const params = new URLSearchParams();
  const redirect = safeRedirect();
  if (redirect) params.set("redirect", redirect);
  if (captchaPassValue) params.set("captcha_pass", captchaPassValue);
  const query = params.toString();
  return `/api/v1/auth/oauth/${encodeURIComponent(id)}/start${query ? `?${query}` : ""}`;
}

function onOAuthClick(id: PublicOAuthProvider["id"], e: MouseEvent) {
  if (oauthPending.value || captchaBusy) {
    e.preventDefault();
    return;
  }
  if (agreementBlocked.value) {
    e.preventDefault();
    nudgeAgreement();
    return;
  }
  if (oauthNeedsCaptcha.value) {
    // The start needs a one-time pass bought with a solved challenge (same tab only).
    e.preventDefault();
    void startOAuthWithCaptcha(id);
    return;
  }
  // Modified clicks open a new tab; this page stays usable.
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  oauthPending.value = id;
  oauthErrorCode.value = null;
}

async function startOAuthWithCaptcha(id: PublicOAuthProvider["id"]) {
  oauthErrorCode.value = null;
  captchaBusy = true;
  let proof: CaptchaProof | null | undefined;
  try {
    proof = await captchaProofFor(true);
  } finally {
    captchaBusy = false;
  }
  if (proof === null) return;
  oauthPending.value = id;
  try {
    const res = await publicJson<CaptchaPassResponse>("/api/v1/auth/captcha/pass", {
      method: "POST",
      body: { scope: "oauth", captcha: proof ?? {} },
    });
    window.location.assign(oauthStartUrl(id, res.pass));
  } catch (err) {
    oauthPending.value = null;
    oauthErrorCode.value = err instanceof ApiError && err.code ? err.code.slice(0, 64) : "captcha_unavailable";
  } finally {
    if (proofHasAnswer(proof)) resetCaptcha();
  }
}

/** Back from the provider via bfcache: the navigation is over, re-enable the buttons. */
function onPageShow(e: PageTransitionEvent) {
  if (e.persisted) oauthPending.value = null;
}

onBeforeUnmount(() => window.removeEventListener("pageshow", onPageShow));

/* ---------------- Forgot password ---------------- */
const forgotTo = computed(() => {
  const address = email.value.trim();
  return { path: "/forgot-password", query: EMAIL_RE.test(address) ? { email: address } : {} };
});

/* ---------------- Promo code live check ---------------- */
type PromoState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "valid"; bonusNanoUsd: string }
  | { status: "invalid"; reason: PromoCodeCheckResponse["reason"] }
  | { status: "error"; message: string };

const promo = ref<PromoState>({ status: "idle" });
let promoTimer: number | undefined;
let promoSeq = 0;

function schedulePromoCheck() {
  window.clearTimeout(promoTimer);
  promoSeq += 1;
  const code = promoCode.value.trim();
  if (!code || !promoEnabled.value) {
    promo.value = { status: "idle" };
    return;
  }
  promo.value = { status: "checking" };
  promoTimer = window.setTimeout(() => void checkPromo(code), 450);
}

async function checkPromo(code: string) {
  const seq = ++promoSeq;
  try {
    const res = await publicJson<PromoCodeCheckResponse>(`/api/v1/public/promo/${encodeURIComponent(code)}`);
    if (seq !== promoSeq) return;
    promo.value = res.valid ? { status: "valid", bonusNanoUsd: res.bonusNanoUsd } : { status: "invalid", reason: res.reason };
  } catch (err) {
    if (seq !== promoSeq) return;
    promo.value = {
      status: "error",
      message: err instanceof ApiError && err.status === 403 ? t("register.promoRateLimited") : t("common.networkError"),
    };
  }
}

watch(promoCode, schedulePromoCheck);
watch(promoEnabled, schedulePromoCheck, { immediate: true });
onBeforeUnmount(() => window.clearTimeout(promoTimer));

const promoHint = computed<{ icon: IconName; cls: string; text: string; spin?: boolean } | null>(() => {
  const p = promo.value;
  switch (p.status) {
    case "checking":
      return { icon: "loader", cls: "text-fg-subtle", text: t("register.promoChecking"), spin: true };
    case "valid":
      return {
        icon: "check-circle",
        cls: "text-success",
        text: p.bonusNanoUsd !== "0" ? t("register.promoValid", { amount: formatUsd(p.bonusNanoUsd) }) : t("register.promoValidNoBonus"),
      };
    case "invalid":
      return { icon: "x-circle", cls: "text-danger", text: t(`register.promoReason.${p.reason}`) };
    case "error":
      return { icon: "alert", cls: "text-warning", text: p.message };
    default:
      return null;
  }
});

/* ---------------- Submit ---------------- */

/** Same-site path from ?redirect (no protocol-relative or backslash tricks, no loop back to login). */
function safeRedirect(): string | null {
  const r = queryParam("redirect");
  if (!r.startsWith("/") || r.startsWith("//") || r.startsWith("/\\")) return null;
  if (r === "/login" || r.startsWith("/login?") || r.startsWith("/register")) return null;
  return r;
}

const REGISTER_ERRORS: Record<string, string> = {
  invite_required: "register.errors.invite_required",
  invalid_promo_code: "register.errors.invalid_promo_code",
  invalid_request: "register.errors.invalid_request",
};

const passkeySupported = isWebAuthnSupported();
const passkeyPending = ref(false);

async function handlePasskeyLogin() {
  if (!passkeySupported || passkeyPending.value || submitting.value) return;
  if (agreementBlocked.value) {
    nudgeAgreement();
    return;
  }
  errorMessage.value = null;
  oauthErrorCode.value = null;
  passkeyPending.value = true;
  try {
    const targetEmail = EMAIL_RE.test(email.value.trim()) ? email.value.trim() : undefined;
    const optRes = await fetch("/api/v1/auth/passkey/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(targetEmail ? { email: targetEmail } : {}),
    });
    const optData = (await optRes.json().catch(() => ({}))) as {
      challengeToken?: string;
      options?: ServerRequestOptions;
      message?: string;
    };
    if (!optRes.ok || !optData.challengeToken || !optData.options) {
      errorMessage.value = optData.message || t("register.passkey.failed");
      return;
    }
    const credential = await getPasskeyAssertion(optData.options);
    const verifyRes = await fetch("/api/v1/auth/passkey/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken: optData.challengeToken, credential }),
    });
    const data = (await verifyRes.json().catch(() => ({}))) as Partial<AuthSessionResponse> & {
      error?: string;
      message?: string;
    };
    if (!verifyRes.ok || !data.accessToken || !data.user) {
      errorMessage.value = data.message || data.error || t("register.passkey.failed");
      return;
    }
    auth.setSession(data as AuthSessionResponse);
    await auth.hydrateSession();
    await router.replace(safeRedirect() ?? (data.user.role === "admin" ? "/admin" : "/dashboard"));
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("register.passkey.failed");
  } finally {
    passkeyPending.value = false;
  }
}

function registerBody(proof?: CaptchaProof): AuthRegisterRequest {
  const body: AuthRegisterRequest = { email: email.value, password: password.value };
  if (proof) body.captcha = proof;
  const name = username.value.trim();
  if (name) body.username = name;
  const promoValue = promoCode.value.trim();
  if (promoEnabled.value && promoValue) body.promoCode = promoValue;
  const invite = inviteCode.value.trim();
  if (inviteRequired.value && invite) body.inviteCode = invite;
  if (affCode) body.affCode = affCode;
  const code = emailCode.value.trim();
  if (emailVerification.value && code) body.emailCode = code;
  return body;
}

function loginBody(proof?: CaptchaProof): AuthLoginRequest {
  const body: AuthLoginRequest = { email: email.value, password: password.value };
  if (step.value === "totp") {
    body.totpCode = totpCode.value;
    // The first step's challenge carries over as a one-time pass.
    if (captchaPass.value) body.captcha = { pass: captchaPass.value };
  } else if (proof) {
    body.captcha = proof;
  }
  return body;
}

async function handleSubmit() {
  if (submitting.value || captchaBusy) return;
  errorMessage.value = null;
  oauthErrorCode.value = null;
  if (agreementBlocked.value && step.value === "credentials") {
    nudgeAgreement();
    return;
  }
  const registering = mode.value === "register";
  if (registering && promoEnabled.value && promoCode.value.trim() && promo.value.status === "invalid") {
    errorMessage.value = t("register.promoInvalidSubmit");
    return;
  }
  if (registering && emailVerification.value && !/^\d{6}$/.test(emailCode.value.trim())) {
    void rejectEmailCode("register.emailCode.missing");
    return;
  }
  const verifying = !registering && step.value === "totp";
  if (verifying && totpCode.value.length !== 6) {
    void rejectTotp(t("security.login.required"));
    return;
  }
  // Human verification of the first step (the two-factor step reuses its one-time pass).
  let proof: CaptchaProof | null | undefined;
  if (!verifying) {
    captchaBusy = true;
    try {
      proof = await captchaProofFor(registering ? registerNeedsCaptcha.value : captchaRequiredFor("login"));
    } finally {
      captchaBusy = false;
    }
    if (proof === null) return;
  }
  submitting.value = true;
  const endpoint = registering ? "/api/v1/auth/register" : "/api/v1/auth/login";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registering ? registerBody(proof ?? undefined) : loginBody(proof ?? undefined)),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<AuthSessionResponse> & {
      message?: string;
      error?: string;
      captchaPass?: string;
      allowedSuffixes?: string[];
    };
    if (!res.ok || !data.user || !data.accessToken) {
      if (!registering && (data.error === "totp_required" || data.error === "invalid_totp")) {
        captchaPass.value = typeof data.captchaPass === "string" ? data.captchaPass : null;
      }
      if (!registering && data.error === "totp_required") {
        if (verifying) void rejectTotp(t("security.login.required"));
        else enterTotpStep();
        return;
      }
      if (verifying && (data.error === "invalid_totp" || data.error === "too_many_attempts")) {
        void rejectTotp(t(LOGIN_ERRORS[data.error]!));
        return;
      }
      if (verifying && isCaptchaError(data.error)) {
        // The pass from the first step expired: solve the challenge again from the start.
        backToCredentials();
        errorMessage.value = t("authGuards.captcha.passExpired");
        return;
      }
      if (registering && data.error === "email_code_invalid") {
        // Settings may be stale (verification switched on meanwhile): reload so the field shows.
        if (!emailVerification.value) await portal.refresh();
        void rejectEmailCode("register.emailCode.invalid");
        return;
      }
      if (verifying) {
        // Password no longer accepted (changed meanwhile?): start over from the first step.
        backToCredentials();
      }
      const mapped = data.error ? (registering ? REGISTER_ERRORS[data.error] : LOGIN_ERRORS[data.error]) : undefined;
      const guarded =
        registering && data.error === "conflict" ? t("authGuards.errors.email_registered") : guardMessage(data.error, data.allowedSuffixes);
      errorMessage.value = mapped ? t(mapped) : (guarded ?? data.message ?? data.error ?? t("auth.failed"));
      // Backend mode or sign-up policy changed under this page: pick up the fresh switches.
      if (data.error === "backend_mode" || data.error === "email_suffix_not_allowed") void portal.refresh();
      return;
    }
    totpCode.value = "";
    captchaPass.value = null;
    auth.setSession(data as AuthSessionResponse);
    await auth.hydrateSession();
    await router.replace(safeRedirect() ?? (data.user.role === "admin" ? "/admin" : "/dashboard"));
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("common.networkError");
  } finally {
    submitting.value = false;
    // Answers are one-time: whatever happened, the next attempt needs a fresh one.
    if (proofHasAnswer(proof)) resetCaptcha();
  }
}

/* ---------------- Public page links ---------------- */
const exploreLinks = computed(() => {
  const s = settings.value;
  const out: { to: string; label: string; icon: IconName }[] = [];
  // Backend mode closes the landing page (and the plaza / status flags already read false).
  if (!backendMode.value) out.push({ to: "/home", label: t("publicNav.home"), icon: "home" });
  if (s?.modelPlazaEnabled !== false) out.push({ to: "/models", label: t("publicNav.models"), icon: "store" });
  if (s?.statusPageEnabled !== false) out.push({ to: "/status", label: t("publicNav.status"), icon: "activity" });
  if (s?.keyUsageLookupEnabled !== false) out.push({ to: "/key-usage", label: t("publicNav.keyUsage"), icon: "search" });
  return out;
});
</script>

<template>
  <AuthLayout :site-name="settings?.siteName || auth.setupStatus?.siteName">
    <h1 class="text-center text-xl font-semibold tracking-tight text-fg">
      {{ step === "totp" ? t("security.login.title") : mode === "login" ? t("auth.loginTitle") : t("auth.registerTitle") }}
    </h1>

    <Transition
      mode="out-in"
      enter-active-class="transition duration-200 ease-out"
      leave-active-class="transition duration-150 ease-in"
      :enter-from-class="step === 'totp' ? 'translate-x-6 opacity-0' : '-translate-x-6 opacity-0'"
      :leave-to-class="step === 'totp' ? '-translate-x-6 opacity-0' : 'translate-x-6 opacity-0'"
    >
      <!-- Step 2: authenticator code -->
      <form v-if="step === 'totp'" key="totp" class="mt-6 space-y-5" novalidate @submit.prevent="handleSubmit">
        <div class="flex flex-col items-center text-center">
          <span class="icon-chip icon-chip-accent h-12 w-12 rounded-2xl">
            <UiIcon name="shield" :size="22" />
          </span>
          <p class="mt-3 text-sm text-fg-muted">{{ t("security.login.desc") }}</p>
          <p class="mt-1 inline-flex max-w-full items-center gap-1.5 truncate rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-fg-subtle">
            <UiIcon name="user" :size="11" />
            <span class="truncate">{{ email }}</span>
          </p>
        </div>

        <OtpInput
          ref="otpRef"
          v-model="totpCode"
          id-prefix="login-otp"
          :label="t('security.login.desc')"
          :disabled="submitting"
          :invalid="totpInvalid"
          @complete="onTotpComplete"
        />

        <UiAlert v-if="errorMessage" tone="danger">{{ errorMessage }}</UiAlert>

        <button type="submit" :disabled="submitting || totpCode.length !== 6" class="btn btn-primary h-10 w-full">
          <UiIcon :name="submitting ? 'loader' : 'shield'" :size="16" :spin="submitting" />
          {{ submitting ? t("common.submitting") : t("security.login.verify") }}
        </button>

        <div class="flex flex-col items-center gap-2">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="submitting" @click="backToCredentials">
            <UiIcon name="chevron-left" :size="14" />
            {{ t("security.login.back") }}
          </button>
          <p class="text-center text-2xs text-fg-subtle">{{ t("security.login.help") }}</p>
        </div>
      </form>

      <!-- Step 1: credentials (login / register) -->
      <div v-else key="credentials">
        <!-- Coming back from a failed third-party sign-in -->
        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="-translate-y-1 opacity-0"
          leave-to-class="opacity-0"
        >
          <UiAlert v-if="oauthErrorText" tone="danger" class="mt-5" :title="t('register.oauth.failedTitle')">
            {{ oauthErrorText }}
            <template #action>
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-xs -my-1 -mr-1 shrink-0"
                :aria-label="t('common.close')"
                @click="oauthErrorCode = null"
              >
                <UiIcon name="x" :size="14" />
              </button>
            </template>
          </UiAlert>
        </Transition>

        <!-- The server ended the last session: the site went admin-only -->
        <UiAlert v-if="sessionNotice" tone="warning" class="mt-5" :title="t('authGuards.backendMode.sessionEndedTitle')">
          {{ t("authGuards.backendMode.sessionEnded") }}
          <template #action>
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs -my-1 -mr-1 shrink-0"
              :aria-label="t('common.close')"
              @click="sessionNotice = null"
            >
              <UiIcon name="x" :size="14" />
            </button>
          </template>
        </UiAlert>

        <!-- Backend (admin-only) mode -->
        <div
          v-if="backendMode"
          class="mt-6 flex items-start gap-3 rounded-lg border border-line bg-surface-2/50 px-3.5 py-3 animate-fade-in motion-reduce:animate-none"
          role="note"
        >
          <span class="icon-chip icon-chip-warning h-8 w-8"><UiIcon name="lock" :size="15" /></span>
          <div class="min-w-0">
            <p class="text-sm font-medium text-fg">{{ t("authGuards.backendMode.loginTitle") }}</p>
            <p class="mt-0.5 text-xs leading-relaxed text-fg-muted">{{ t("authGuards.backendMode.loginBody") }}</p>
          </div>
        </div>

        <SegmentedControl
          v-if="canRegister"
          v-model="mode"
          :class="oauthErrorText ? 'mt-5' : 'mt-6'"
          block
          size="md"
          :options="[
            { value: 'login', label: t('auth.login') },
            { value: 'register', label: t('auth.register') },
          ]"
        />

        <div v-if="mode === 'register' && showAffChip" class="mt-4 flex justify-center">
          <span
            class="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent ring-1 ring-inset ring-accent/20 animate-scale-in"
            :title="t('register.invitedByTitle', { code: affCode })"
          >
            <UiIcon name="gift" :size="13" />
            {{ t("register.invitedBy") }}
            <span class="font-mono text-2xs opacity-75">{{ affCode }}</span>
          </span>
        </div>

        <form class="mt-6 space-y-4" @submit.prevent="handleSubmit">
          <label v-if="mode === 'register'" class="block animate-slide-up">
            <span class="label flex items-center justify-between">
              {{ t("register.username") }}
              <span class="font-normal text-fg-subtle">{{ t("register.optional") }}</span>
            </span>
            <input
              v-model="username"
              type="text"
              maxlength="64"
              autocomplete="nickname"
              :placeholder="t('register.usernamePlaceholder')"
              class="input h-10"
            />
          </label>

          <label class="block">
            <span class="label">{{ t("auth.email") }}</span>
            <input
              ref="emailInputRef"
              v-model="email"
              type="email"
              required
              autocomplete="email"
              :placeholder="t('auth.emailPlaceholder')"
              class="input h-10"
              :aria-describedby="emailPolicyHint ? 'register-email-policy' : undefined"
            />
            <Transition
              enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
              leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
              enter-from-class="-translate-y-0.5 opacity-0"
              leave-to-class="opacity-0"
            >
              <span
                v-if="emailPolicyHint"
                id="register-email-policy"
                class="mt-1.5 flex items-start gap-1.5 text-xs"
                :class="emailPolicyHint.cls"
                aria-live="polite"
              >
                <UiIcon :name="emailPolicyHint.icon" :size="13" class="mt-px shrink-0" />
                <span class="min-w-0 break-words">{{ emailPolicyHint.text }}</span>
              </span>
            </Transition>
          </label>

          <!-- Email verification code (only when the site requires verified addresses) -->
          <div v-if="mode === 'register' && emailVerification" class="animate-slide-up motion-reduce:animate-none">
            <label for="register-email-code" class="label">{{ t("register.emailCode.label") }}</label>
            <div class="flex gap-2">
              <span class="relative block min-w-0 flex-1">
                <UiIcon
                  name="badge-check"
                  :size="15"
                  class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
                />
                <input
                  id="register-email-code"
                  ref="codeInputRef"
                  v-model="emailCode"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength="6"
                  required
                  spellcheck="false"
                  :placeholder="t('register.emailCode.placeholder')"
                  class="input h-10 pl-9"
                  :class="[
                    emailCode ? 'font-mono tracking-[0.3em]' : '',
                    codeError ? '!border-danger/60 focus:!ring-danger/20' : '',
                  ]"
                  :aria-invalid="Boolean(codeError)"
                  aria-describedby="register-email-code-hint"
                />
              </span>
              <button
                type="button"
                class="btn btn-secondary h-10 min-w-[6.75rem] shrink-0"
                :class="agreementBlocked ? 'opacity-60' : ''"
                :disabled="sendingCode || codeCoolingDown"
                :aria-disabled="agreementBlocked || undefined"
                :aria-busy="sendingCode"
                @click="sendEmailCode"
              >
                <UiIcon
                  :name="sendingCode ? 'loader' : codeCoolingDown ? 'clock' : codeForCurrentEmail ? 'rotate-ccw' : 'mail'"
                  :size="15"
                  :spin="sendingCode"
                />
                <span v-if="sendingCode">{{ t("register.emailCode.sending") }}</span>
                <span v-else-if="codeCoolingDown" class="tabular-nums">
                  {{ t("register.emailCode.countdown", { n: codeRemaining }) }}
                </span>
                <span v-else>{{ codeForCurrentEmail ? t("register.emailCode.resend") : t("register.emailCode.send") }}</span>
              </button>
            </div>
            <p
              id="register-email-code-hint"
              class="mt-1.5 flex items-start gap-1.5 text-xs"
              :class="codeHint.cls"
              :role="codeError ? 'alert' : undefined"
              aria-live="polite"
            >
              <UiIcon :name="codeHint.icon" :size="13" class="mt-px shrink-0" />
              <span class="min-w-0">{{ codeHint.text }}</span>
            </p>
          </div>

          <label class="block">
            <span class="label flex items-center justify-between gap-3">
              {{ t("auth.password") }}
              <RouterLink
                v-if="mode === 'login' && passwordResetEnabled"
                :to="forgotTo"
                class="font-medium text-accent hover:underline"
              >
                {{ t("register.forgotLink") }}
              </RouterLink>
            </span>
            <span class="relative block">
              <input
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                :minlength="mode === 'register' ? 8 : 1"
                required
                :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
                :placeholder="mode === 'login' ? t('auth.passwordPlaceholder') : t('auth.newPasswordPlaceholder')"
                class="input h-10 pr-10"
              />
              <button
                type="button"
                class="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center text-fg-subtle transition-colors hover:text-fg"
                :aria-label="showPassword ? t('auth.hidePassword') : t('auth.showPassword')"
                @click="showPassword = !showPassword"
              >
                <UiIcon :name="showPassword ? 'eye-off' : 'eye'" :size="16" />
              </button>
            </span>
          </label>

          <template v-if="mode === 'register'">
            <label v-if="inviteRequired" class="block animate-slide-up">
              <span class="label">{{ t("register.invite") }}</span>
              <span class="relative block">
                <UiIcon name="ticket" :size="15" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
                <input
                  v-model="inviteCode"
                  type="text"
                  required
                  maxlength="64"
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="t('register.invitePlaceholder')"
                  class="input h-10 pl-9 font-mono"
                />
              </span>
              <span class="hint flex items-center gap-1">
                <UiIcon name="lock" :size="12" />
                {{ t("register.inviteRequiredHint") }}
              </span>
            </label>

            <label v-if="promoEnabled" class="block animate-slide-up">
              <span class="label flex items-center justify-between">
                {{ t("register.promo") }}
                <span class="font-normal text-fg-subtle">{{ t("register.optional") }}</span>
              </span>
              <span class="relative block">
                <UiIcon name="gift" :size="15" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
                <input
                  v-model="promoCode"
                  type="text"
                  maxlength="32"
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="t('register.promoPlaceholder')"
                  class="input h-10 pl-9 font-mono"
                  :class="
                    promo.status === 'invalid'
                      ? '!border-danger/60 focus:!ring-danger/20'
                      : promo.status === 'valid'
                        ? '!border-success/50 focus:!ring-success/20'
                        : ''
                  "
                  :aria-invalid="promo.status === 'invalid'"
                  aria-describedby="promo-hint"
                />
              </span>
              <span v-if="promoHint" id="promo-hint" class="mt-1.5 flex items-center gap-1.5 text-xs" :class="promoHint.cls" aria-live="polite">
                <UiIcon :name="promoHint.icon" :size="13" :spin="promoHint.spin" />
                {{ promoHint.text }}
              </span>
            </label>
          </template>

          <!-- Human verification (loaded only when a flow on this form needs it) -->
          <Transition
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
            enter-from-class="-translate-y-1 opacity-0"
            leave-to-class="opacity-0"
          >
            <CaptchaWidget v-if="showCaptcha && captchaConfig" ref="captchaWidget" :config="captchaConfig" />
          </Transition>

          <!-- Terms / privacy consent -->
          <LoginAgreementPrompt
            v-if="agreementEnabled"
            v-model:open="agreementDialogOpen"
            :mode="agreementMode"
            :documents="agreementDocs"
            :updated-at="agreementUpdatedAt"
            :accepted="agreementAccepted"
            :attention="agreementAttention"
            @accept="acceptAgreement"
            @reject="rejectAgreement"
          />

          <UiAlert v-if="errorMessage" tone="danger">{{ errorMessage }}</UiAlert>

          <button
            type="submit"
            :disabled="submitting"
            :aria-disabled="agreementBlocked || undefined"
            class="btn btn-primary h-10 w-full"
            :class="agreementBlocked ? 'opacity-60' : ''"
          >
            <UiIcon v-if="submitting" name="loader" :size="16" spin />
            {{ submitting ? t("common.submitting") : mode === "login" ? t("auth.submitLogin") : t("auth.submitRegister") }}
          </button>
        </form>

        <div v-if="mode === 'login' && passkeySupported" class="mt-3">
          <button
            type="button"
            class="btn btn-secondary h-10 w-full"
            :disabled="passkeyPending || submitting"
            @click="handlePasskeyLogin"
          >
            <UiIcon :name="passkeyPending ? 'loader' : 'fingerprint'" :size="16" :spin="passkeyPending" />
            {{ passkeyPending ? t("register.passkey.verifying") : t("register.passkey.signIn") }}
          </button>
        </div>

        <!-- Third-party sign-in (full-page navigation through the BFF) -->
        <div v-if="oauthProviders.length" class="mt-6 animate-fade-in motion-reduce:animate-none">
          <div class="flex items-center gap-3" aria-hidden="true">
            <span class="h-px flex-1 bg-line/80" />
            <span class="text-2xs font-medium text-fg-subtle">{{ t("register.oauth.or") }}</span>
            <span class="h-px flex-1 bg-line/80" />
          </div>
          <ul class="mt-4 grid gap-2" :aria-label="t('register.oauth.or')">
            <li v-for="p in oauthProviders" :key="p.id">
              <a
                :href="oauthStartUrl(p.id)"
                class="btn btn-secondary h-10 w-full"
                :class="oauthPending && oauthPending !== p.id ? 'pointer-events-none opacity-50' : agreementBlocked ? 'opacity-60' : ''"
                :aria-disabled="oauthPending !== null ? 'true' : undefined"
                :aria-busy="oauthPending === p.id ? 'true' : undefined"
                @click="onOAuthClick(p.id, $event)"
              >
                <UiIcon v-if="oauthPending === p.id" name="loader" :size="16" spin />
                <OAuthProviderMark v-else :provider="p.id" :size="16" />
                <span class="truncate">
                  {{
                    oauthPending === p.id
                      ? t("register.oauth.redirecting")
                      : t("register.oauth.continueWith", { name: p.displayName || OAUTH_DEFAULT_NAMES[p.id] })
                  }}
                </span>
              </a>
            </li>
          </ul>
        </div>

        <p v-if="!canRegister && !backendMode" class="mt-6 text-center text-xs text-fg-muted">
          {{ t("auth.registrationClosed") }}
        </p>
      </div>
    </Transition>

    <nav v-if="exploreLinks.length" class="mt-6 border-t border-line/70 pt-4" :aria-label="t('register.explore')">
      <p class="text-center text-2xs text-fg-subtle">{{ t("register.explore") }}</p>
      <ul class="mt-2.5 flex flex-wrap items-center justify-center gap-1.5">
        <li v-for="l in exploreLinks" :key="l.to">
          <RouterLink
            :to="l.to"
            class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <UiIcon :name="l.icon" :size="12" />
            {{ l.label }}
          </RouterLink>
        </li>
      </ul>
    </nav>
  </AuthLayout>
</template>
