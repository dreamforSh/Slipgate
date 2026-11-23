import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CaptchaConfig, PortalSettings, UpdatePortalSettingsRequest } from "@slipgate/contracts";
import { ApiError, apiJson, errorText } from "../../lib/api";
import {
  buildGuardPortalPatch,
  cloneGuardPortalForm,
  emptyGuardPortalForm,
  GUARD_TAB_FIELDS,
  guardPortalDirtyKeys,
  guardTabOf,
  parseGuardServerErrors,
  toGuardPortalForm,
  validateDocs,
  validateGuardPortalForm,
  type GuardPortalForm,
  type GuardPortalKey,
  type GuardTab,
} from "./authGuardsForm";
import {
  buildCaptchaPatch,
  captchaDirtyKeys,
  parseCaptchaServerErrors,
  parseMissingFields,
  toCaptchaForm,
  validateCaptchaForm,
  type CaptchaFieldKey,
  type CaptchaForm,
} from "./captchaForm";

/** A captcha save the provider (or the server) refused as a whole. */
export interface CaptchaFailure {
  code: string;
  message: string;
}

/**
 * State of the sign-in guard settings for the admin settings page: the portal fields (sign-up
 * email policy, backend mode, login agreement; saved with the other portal settings in one PATCH)
 * and the captcha configuration (its own endpoint). Both join the page's sticky save bar.
 */
export function useAuthGuardSettings() {
  const { t } = useI18n();

  /* ---------------- Portal fields ---------------- */

  const portalBase = shallowRef<GuardPortalForm | null>(null);
  const portalForm = ref<GuardPortalForm>(emptyGuardPortalForm());
  const portalServerErrors = ref<Record<string, string>>({});

  function applyPortal(s: PortalSettings) {
    const next = toGuardPortalForm(s, portalForm.value.loginAgreementDocuments);
    portalBase.value = next;
    portalForm.value = cloneGuardPortalForm(next);
    portalServerErrors.value = {};
  }

  const portalDirty = computed<GuardPortalKey[]>(() => (portalBase.value ? guardPortalDirtyKeys(portalForm.value, portalBase.value) : []));
  const portalClientErrors = computed(() => {
    const out: Partial<Record<GuardPortalKey, string>> = {};
    for (const [k, v] of Object.entries(validateGuardPortalForm(portalForm.value))) {
      out[k as GuardPortalKey] = v.params ? t(v.key, v.params) : t(v.key);
    }
    return out;
  });
  /** Field and document errors, client first, then the server's (keys may carry an index path). */
  const portalErrors = computed<Record<string, string>>(() => ({ ...portalServerErrors.value, ...portalClientErrors.value }));
  const docErrors = computed(() =>
    validateDocs(portalForm.value.loginAgreementDocuments).map((d, i) => {
      const tr = (issue?: { key: string; params?: Record<string, unknown> }) => (issue ? (issue.params ? t(issue.key, issue.params) : t(issue.key)) : undefined);
      const server = (field: string) => portalServerErrors.value[`loginAgreementDocuments.${i}.${field}`];
      return {
        id: tr(d.id) ?? server("id"),
        title: tr(d.title) ?? server("title"),
        contentMd: tr(d.contentMd) ?? server("contentMd"),
      };
    }),
  );

  watch(
    portalForm,
    () => {
      if (Object.keys(portalServerErrors.value).length) portalServerErrors.value = {};
    },
    { deep: true },
  );

  /** The guard fields' part of the settings PATCH (merged into the page's single PATCH). */
  function portalPatch(): UpdatePortalSettingsRequest {
    return buildGuardPortalPatch(portalForm.value, portalDirty.value);
  }

  /** Takes the field errors of a failed settings PATCH; true when any belonged to these fields. */
  function setPortalServerErrors(message: string): boolean {
    portalServerErrors.value = parseGuardServerErrors(message);
    return Object.keys(portalServerErrors.value).length > 0;
  }

  const portalErrorTab = computed<GuardTab | null>(() => {
    const keys = Object.keys(portalServerErrors.value);
    for (const k of keys) {
      const tab = guardTabOf(k);
      if (tab) return tab;
    }
    return null;
  });

  /* ---------------- Captcha ---------------- */

  const captchaSaved = shallowRef<CaptchaConfig | null>(null);
  const captchaForm = ref<CaptchaForm | null>(null);
  const captchaLoading = ref(false);
  const captchaLoadError = ref<string | null>(null);
  const captchaServerErrors = ref<Partial<Record<CaptchaFieldKey, string>>>({});
  const captchaFailure = ref<CaptchaFailure | null>(null);

  function applyCaptcha(c: CaptchaConfig) {
    captchaSaved.value = c;
    captchaForm.value = toCaptchaForm(c);
    captchaServerErrors.value = {};
    captchaFailure.value = null;
  }

  async function loadCaptcha() {
    captchaLoading.value = true;
    captchaLoadError.value = null;
    try {
      applyCaptcha(await apiJson<CaptchaConfig>("/api/v1/admin/captcha"));
    } catch (err) {
      captchaLoadError.value = errorText(err, t("common.loadFailed"));
    } finally {
      captchaLoading.value = false;
    }
  }

  const captchaDirty = computed<CaptchaFieldKey[]>(() =>
    captchaSaved.value && captchaForm.value ? captchaDirtyKeys(captchaForm.value, toCaptchaForm(captchaSaved.value)) : [],
  );
  const captchaClientErrors = computed(() => {
    const out: Partial<Record<CaptchaFieldKey, string>> = {};
    if (!captchaForm.value || !captchaSaved.value) return out;
    for (const [k, v] of Object.entries(validateCaptchaForm(captchaForm.value, captchaSaved.value))) {
      out[k as CaptchaFieldKey] = v.params ? t(v.key, v.params) : t(v.key);
    }
    return out;
  });
  const captchaErrors = computed(() => ({ ...captchaServerErrors.value, ...captchaClientErrors.value }));

  watch(
    captchaForm,
    () => {
      if (Object.keys(captchaServerErrors.value).length) captchaServerErrors.value = {};
      if (captchaFailure.value) captchaFailure.value = null;
    },
    { deep: true },
  );

  /** PATCH the changed captcha fields; resolves to an error message or null. */
  async function saveCaptcha(): Promise<string | null> {
    const form = captchaForm.value;
    if (!form || !captchaDirty.value.length) return null;
    try {
      applyCaptcha(await apiJson<CaptchaConfig>("/api/v1/admin/captcha", { method: "PATCH", body: buildCaptchaPatch(form, captchaDirty.value) }));
      return null;
    } catch (err) {
      const message = errorText(err, t("settings.saveFailed"));
      const code = err instanceof ApiError ? err.code : null;
      if (code === "captcha_not_configured") {
        const missing: Partial<Record<CaptchaFieldKey, string>> = {};
        for (const f of parseMissingFields(message)) missing[f] = t("settings.errors.required");
        captchaServerErrors.value = missing;
      } else {
        captchaServerErrors.value = parseCaptchaServerErrors(message);
      }
      captchaFailure.value = { code: code ?? "save_failed", message };
      const friendly = code && ["captcha_invalid_credentials", "captcha_unavailable", "captcha_not_configured"].includes(code) ? t(`authGuards.errors.${code}`) : message;
      return `${t("authGuards.settings.captcha.title")}: ${friendly}`;
    }
  }

  /* ---------------- Aggregate (the page's save bar) ---------------- */

  const dirtyCount = computed(() => portalDirty.value.length + captchaDirty.value.length);
  const portalInvalid = computed(() => Object.keys(portalClientErrors.value).length > 0);
  /** Captcha problems only block saving when the captcha settings are part of the save. */
  const captchaInvalid = computed(() => captchaDirty.value.length > 0 && Object.keys(captchaClientErrors.value).length > 0);
  const invalid = computed(() => portalInvalid.value || captchaInvalid.value);

  /** The tab to show when saving is blocked by a client-side problem here. */
  const invalidTab = computed<GuardTab | null>(() => {
    if (portalInvalid.value) {
      for (const k of Object.keys(portalClientErrors.value)) {
        const tab = guardTabOf(k);
        if (tab) return tab;
      }
    }
    return captchaInvalid.value ? "security" : null;
  });

  function tabCount(tab: GuardTab): number {
    const portal = GUARD_TAB_FIELDS[tab].filter((k) => portalDirty.value.includes(k)).length;
    return portal + (tab === "security" ? captchaDirty.value.length : 0);
  }

  function discard() {
    if (portalBase.value) portalForm.value = cloneGuardPortalForm(portalBase.value);
    if (captchaSaved.value) captchaForm.value = toCaptchaForm(captchaSaved.value);
    portalServerErrors.value = {};
    captchaServerErrors.value = {};
    captchaFailure.value = null;
  }

  return {
    // portal fields
    portalForm,
    portalBase,
    portalDirty,
    portalErrors,
    docErrors,
    applyPortal,
    portalPatch,
    setPortalServerErrors,
    portalErrorTab,
    // captcha
    captchaSaved,
    captchaForm,
    captchaLoading,
    captchaLoadError,
    captchaDirty,
    captchaErrors,
    captchaFailure,
    loadCaptcha,
    saveCaptcha,
    // aggregate
    dirtyCount,
    invalid,
    invalidTab,
    tabCount,
    discard,
  };
}

export type AuthGuardSettings = ReturnType<typeof useAuthGuardSettings>;
