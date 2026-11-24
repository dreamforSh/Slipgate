<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import {
  configuredPublicBaseUrl,
  DEFAULT_EMAIL_CONFIG,
  type AffiliateCreditMode,
  type EmailConfig,
  type GroupItem,
  type OAuthProviderConfig,
  type OAuthProviderId,
  type PortalSettings,
  type UpdatePortalSettingsRequest,
} from "@slipgate/contracts";
import BrandMark from "../../components/BrandMark.vue";
import { invalidatePortalCapDefaults } from "../../components/admin/users/limits";
import EmailSettingsPanel from "../../components/settings/EmailSettingsPanel.vue";
import {
  buildEmailPatch,
  emailDirtyKeys,
  emailStatus,
  parseEmailServerErrors,
  toEmailForm,
  validateEmailForm,
  type EmailFieldKey,
  type EmailForm,
} from "../../components/settings/emailForm";
import NavLinksEditor, { type NavLinkRow } from "../../components/settings/NavLinksEditor.vue";
import OAuthProvidersPanel from "../../components/settings/OAuthProvidersPanel.vue";
import {
  buildOAuthPatch,
  oauthDirtyKeys,
  OAUTH_DEFAULT_NAMES,
  parseOAuthServerErrors,
  toOAuthForm,
  validateOAuthForm,
  type OAuthFieldKey,
  type OAuthProviderForm,
} from "../../components/settings/oauthForm";
import SettingField from "../../components/settings/SettingField.vue";
import SettingSwitchRow from "../../components/settings/SettingSwitchRow.vue";
import SettingsSaveBar from "../../components/settings/SettingsSaveBar.vue";
// Sign-in guards: captcha, sign-up email policy, backend mode, login agreement.
import BackendModeCard from "../../components/settings/BackendModeCard.vue";
import AuditRetentionSettingsRow from "../../components/admin/ops/AuditRetentionSettingsRow.vue";
import AdminApiKeysPanel from "../../components/settings/AdminApiKeysPanel.vue";
import CaptchaSettingsPanel from "../../components/settings/CaptchaSettingsPanel.vue";
import LoginAgreementEditor from "../../components/settings/LoginAgreementEditor.vue";
import RegistrationEmailPolicyCard from "../../components/settings/RegistrationEmailPolicyCard.vue";
import SitePagesPanel from "../../components/settings/SitePagesPanel.vue";
import GroupPicker from "../../components/admin/users/GroupPicker.vue";
import { useAuthGuardSettings } from "../../components/settings/useAuthGuardSettings";
import EmptyState from "../../components/ui/EmptyState.vue";
import MarkdownView from "../../components/ui/MarkdownView.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { apiJson, errorText } from "../../lib/api";
import { usePortalStore } from "../../stores/portal";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const portal = usePortalStore();
const toast = useToastStore();
/** Sign-in guard settings: their portal fields join the settings PATCH, the captcha has its own endpoint. */
const guards = reactive(useAuthGuardSettings());

/* ---------------- Form model ---------------- */

type TabKey = "general" | "registration" | "email" | "oauth" | "security" | "agreement" | "public" | "referral";

interface SettingsForm {
  siteName: string;
  siteSubtitle: string;
  logoUrl: string;
  footerText: string;
  apiBaseUrl: string;
  docUrl: string;
  contactInfo: string;
  homeContent: string;
  customNavLinks: NavLinkRow[];
  allowRegistration: boolean;
  promoCodeEnabled: boolean;
  inviteRequired: boolean;
  emailVerificationRequired: boolean;
  /** USD decimal string as typed (the API stores nano-USD). */
  defaultBalanceUsd: string;
  defaultApiKeyRpm: number | string;
  defaultApiKeyConcurrency: number | string;
  /** Caps for users without their own (0 = unlimited). */
  defaultUserRpm: number | string;
  defaultUserConcurrency: number | string;
  defaultSignupGroupIds: string[];
  defaultSignupSubGroupId: string;
  defaultSignupSubDays: number | string;
  modelPlazaEnabled: boolean;
  statusPageEnabled: boolean;
  keyUsageLookupEnabled: boolean;
  affiliateEnabled: boolean;
  /** Percent shown to the admin; the API stores basis points. */
  rebatePercent: number | string;
  affiliateCreditMode: AffiliateCreditMode;
  affiliateMinWithdrawUsd: string;
}
type FieldKey = keyof SettingsForm;

const TABS: TabKey[] = ["general", "registration", "email", "oauth", "security", "agreement", "public", "referral"];
const TAB_ICON: Record<TabKey, IconName> = {
  general: "sparkles",
  registration: "user-plus",
  email: "mail",
  oauth: "log-in",
  security: "shield",
  agreement: "file",
  public: "globe",
  referral: "share",
};
/** Tabs whose labels live in the auth guards namespace. */
const GUARD_TAB_LABEL: Partial<Record<TabKey, string>> = {
  security: "authGuards.settings.tabs.security",
  agreement: "authGuards.settings.tabs.agreement",
};
const TAB_FIELDS: Record<TabKey, FieldKey[]> = {
  general: ["siteName", "siteSubtitle", "logoUrl", "footerText", "apiBaseUrl", "docUrl", "contactInfo"],
  registration: [
    "allowRegistration",
    "inviteRequired",
    "emailVerificationRequired",
    "promoCodeEnabled",
    "defaultBalanceUsd",
    "defaultApiKeyRpm",
    "defaultApiKeyConcurrency",
    "defaultUserRpm",
    "defaultUserConcurrency",
    "defaultSignupGroupIds",
    "defaultSignupSubGroupId",
    "defaultSignupSubDays",
  ],
  // SMTP settings live behind their own endpoint and are tracked separately (see "Email" below).
  email: [],
  // Sign-in providers too (one PATCH per provider, see "Third-party sign-in" below).
  oauth: [],
  // Sign-in guard fields (captcha, backend mode, agreement) are tracked by useAuthGuardSettings.
  security: [],
  agreement: [],
  public: ["modelPlazaEnabled", "statusPageEnabled", "keyUsageLookupEnabled", "homeContent", "customNavLinks"],
  referral: ["affiliateEnabled", "rebatePercent", "affiliateCreditMode", "affiliateMinWithdrawUsd"],
};
const FIELDS = TABS.flatMap((tab) => TAB_FIELDS[tab]);
const NUMERIC: FieldKey[] = [
  "defaultApiKeyRpm",
  "defaultApiKeyConcurrency",
  "defaultUserRpm",
  "defaultUserConcurrency",
  "defaultSignupSubDays",
  "rebatePercent",
];
const URL_RE = /^(https?:\/\/|\/(?!\/))/i;
const NANO_PER_USD = 1_000_000_000n;
const MAX_NAV_LINKS = 10;
const HOME_MAX = 20_000;

let rowSeq = 0;

/** nano-USD integer string → exact USD decimal ("12.5"). */
function nanoToUsdString(nano: string): string {
  let n = BigInt(nano || "0");
  const neg = n < 0n;
  if (neg) n = -n;
  const whole = (n / NANO_PER_USD).toString();
  const frac = (n % NANO_PER_USD).toString().padStart(9, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** USD decimal typed by a person → nano-USD string, or null when malformed. */
function usdToNano(raw: string): string | null {
  const m = /^\$?(\d{1,12})(?:\.(\d{1,9}))?$/.exec(raw.trim());
  if (!m) return null;
  return (BigInt(m[1]!) * NANO_PER_USD + BigInt((m[2] ?? "").padEnd(9, "0"))).toString();
}

function toForm(s: PortalSettings, prevRows: NavLinkRow[] = []): SettingsForm {
  return {
    siteName: s.siteName,
    siteSubtitle: s.siteSubtitle,
    logoUrl: s.logoUrl,
    footerText: s.footerText,
    apiBaseUrl: s.apiBaseUrl,
    docUrl: s.docUrl,
    contactInfo: s.contactInfo,
    homeContent: s.homeContent,
    // Reuse row keys by position so a save doesn't replay the list's enter animation.
    customNavLinks: s.customNavLinks.map((l, i) => ({ key: prevRows[i]?.key ?? ++rowSeq, label: l.label, url: l.url })),
    allowRegistration: s.allowRegistration,
    promoCodeEnabled: s.promoCodeEnabled,
    inviteRequired: s.inviteRequired,
    emailVerificationRequired: s.emailVerificationRequired,
    defaultBalanceUsd: nanoToUsdString(s.defaultBalanceNanoUsd),
    defaultApiKeyRpm: s.defaultApiKeyRpm,
    defaultApiKeyConcurrency: s.defaultApiKeyConcurrency,
    defaultUserRpm: s.defaultUserRpm ?? 0,
    defaultUserConcurrency: s.defaultUserConcurrency ?? 0,
    defaultSignupGroupIds: [...(s.defaultSignupGroupIds ?? [])],
    defaultSignupSubGroupId: s.defaultSignupSubGroupId ?? "",
    defaultSignupSubDays: s.defaultSignupSubDays ?? 0,
    modelPlazaEnabled: s.modelPlazaEnabled,
    statusPageEnabled: s.statusPageEnabled,
    keyUsageLookupEnabled: s.keyUsageLookupEnabled,
    affiliateEnabled: s.affiliateEnabled,
    rebatePercent: s.affiliateRebateBps / 100,
    affiliateCreditMode: s.affiliateCreditMode ?? "wallet",
    affiliateMinWithdrawUsd: s.affiliateMinWithdrawUsd ?? "10",
  };
}

function cloneForm(f: SettingsForm): SettingsForm {
  return {
    ...f,
    customNavLinks: f.customNavLinks.map((r) => ({ ...r })),
    defaultSignupGroupIds: [...f.defaultSignupGroupIds],
  };
}

/** Comparable representation of one field (formatting-insensitive for numbers and money). */
function norm(f: SettingsForm, key: FieldKey): string {
  const v = f[key];
  if (key === "customNavLinks") return JSON.stringify(f.customNavLinks.map((r) => [r.label, r.url]));
  if (key === "defaultSignupGroupIds") return JSON.stringify([...f.defaultSignupGroupIds].sort());
  if (key === "defaultBalanceUsd" || key === "affiliateMinWithdrawUsd") {
    return usdToNano(String(v)) ?? `raw:${v}`;
  }
  if (NUMERIC.includes(key)) return v === "" ? "" : String(Number(v));
  return String(v);
}

const baseline = shallowRef<SettingsForm | null>(null);
const form = ref<SettingsForm>(toForm(emptySettings()));
const loading = ref(false);
const saving = ref(false);
const loadError = ref<string | null>(null);
const serverErrors = ref<Record<string, string>>({});

function emptySettings(): PortalSettings {
  return {
    siteName: "",
    siteSubtitle: "",
    logoUrl: "",
    footerText: "",
    apiBaseUrl: "",
    docUrl: "",
    contactInfo: "",
    homeContent: "",
    customNavLinks: [],
    allowRegistration: false,
    promoCodeEnabled: false,
    inviteRequired: false,
    emailVerificationRequired: false,
    defaultBalanceNanoUsd: "0",
    defaultApiKeyRpm: 60,
    defaultApiKeyConcurrency: 5,
    defaultUserRpm: 0,
    defaultUserConcurrency: 0,
    defaultSignupGroupIds: [],
    defaultSignupSubGroupId: "",
    defaultSignupSubDays: 0,
    modelPlazaEnabled: false,
    statusPageEnabled: false,
    keyUsageLookupEnabled: false,
    affiliateEnabled: false,
    affiliateRebateBps: 0,
    affiliateCreditMode: "wallet",
    affiliateMinWithdrawUsd: "10",
    auditLogRetentionDays: 0,
    registrationEmailSuffixAllowlist: [],
    registrationEmailDomainQuotaEnabled: false,
    loginAgreementEnabled: false,
    loginAgreementMode: "modal",
    loginAgreementUpdatedAt: "",
    loginAgreementDocuments: [],
    backendModeEnabled: false,
  };
}

function applyServer(s: PortalSettings) {
  const next = toForm(s, form.value.customNavLinks);
  baseline.value = next;
  form.value = cloneForm(next);
  serverErrors.value = {};
  guards.applyPortal(s);
}

/* ---------------- Dirty tracking ---------------- */

const dirtyKeys = computed<FieldKey[]>(() => {
  const base = baseline.value;
  if (!base) return [];
  return FIELDS.filter((k) => norm(form.value, k) !== norm(base, k));
});
const dirtySet = computed(() => new Set(dirtyKeys.value));
const isDirty = (k: FieldKey) => dirtySet.value.has(k);

/* ---------------- Email (SMTP) ----------------
 * Saved through PATCH /api/v1/admin/email/config, but edited, counted, discarded and saved
 * together with the portal settings through the one sticky save bar.
 */

const emailSaved = shallowRef<EmailConfig | null>(null);
const emailForm = ref<EmailForm>(toEmailForm(DEFAULT_EMAIL_CONFIG));
const emailLoading = ref(false);
const emailLoadError = ref<string | null>(null);
const emailServerErrors = ref<Partial<Record<EmailFieldKey, string>>>({});

const emailDirty = computed<EmailFieldKey[]>(() =>
  emailSaved.value ? emailDirtyKeys(emailForm.value, toEmailForm(emailSaved.value)) : [],
);
const emailClientErrors = computed(() => {
  const out: Partial<Record<EmailFieldKey, string>> = {};
  for (const [k, v] of Object.entries(validateEmailForm(emailForm.value))) {
    out[k as EmailFieldKey] = v.params ? t(v.key, v.params) : t(v.key);
  }
  return out;
});
const emailErrors = computed(() => ({ ...emailServerErrors.value, ...emailClientErrors.value }));
const emailReady = computed(() => emailSaved.value !== null && emailStatus(emailSaved.value) === "ready");

function applyEmail(c: EmailConfig) {
  emailSaved.value = c;
  emailForm.value = toEmailForm(c);
  emailServerErrors.value = {};
}

watch(
  emailForm,
  () => {
    if (Object.keys(emailServerErrors.value).length) emailServerErrors.value = {};
  },
  { deep: true },
);

/* ---------------- Third-party sign-in (OAuth) ----------------
 * Each provider saves through PATCH /api/v1/admin/oauth/providers/:id; like SMTP, edits are
 * counted, discarded and saved together with everything else through the sticky save bar.
 */

type OAuthErrors = Partial<Record<OAuthProviderId, Partial<Record<OAuthFieldKey, string>>>>;

const oauthSaved = shallowRef<OAuthProviderConfig[] | null>(null);
const oauthForms = ref<OAuthProviderForm[]>([]);
const oauthLoading = ref(false);
const oauthLoadError = ref<string | null>(null);
const oauthServerErrors = ref<OAuthErrors>({});

const oauthDirty = computed(() => {
  const out: Partial<Record<OAuthProviderId, OAuthFieldKey[]>> = {};
  const saved = oauthSaved.value;
  if (!saved) return out;
  for (const f of oauthForms.value) {
    const base = saved.find((s) => s.id === f.id);
    if (!base) continue;
    const keys = oauthDirtyKeys(f, toOAuthForm(base));
    if (keys.length) out[f.id] = keys;
  }
  return out;
});
const oauthDirtyIds = computed(() => Object.keys(oauthDirty.value) as OAuthProviderId[]);
const oauthDirtyCount = computed(() => Object.values(oauthDirty.value).reduce((n, keys) => n + (keys?.length ?? 0), 0));
const oauthClientErrors = computed(() => {
  const out: OAuthErrors = {};
  for (const f of oauthForms.value) {
    const entries = Object.entries(validateOAuthForm(f));
    if (!entries.length) continue;
    const errs: Partial<Record<OAuthFieldKey, string>> = {};
    for (const [k, v] of entries) errs[k as OAuthFieldKey] = v.params ? t(v.key, v.params) : t(v.key);
    out[f.id] = errs;
  }
  return out;
});
const oauthErrors = computed(() => {
  const out: OAuthErrors = {};
  for (const f of oauthForms.value) {
    const merged = { ...oauthServerErrors.value[f.id], ...oauthClientErrors.value[f.id] };
    if (Object.keys(merged).length) out[f.id] = merged;
  }
  return out;
});

function applyOAuth(items: OAuthProviderConfig[]) {
  oauthSaved.value = items;
  oauthForms.value = items.map(toOAuthForm);
  oauthServerErrors.value = {};
}

/** One provider saved: replace it alone so edits to the others survive. */
function applyOAuthItem(item: OAuthProviderConfig) {
  const saved = oauthSaved.value ?? [];
  oauthSaved.value = saved.some((s) => s.id === item.id) ? saved.map((s) => (s.id === item.id ? item : s)) : [...saved, item];
  const i = oauthForms.value.findIndex((f) => f.id === item.id);
  if (i >= 0) oauthForms.value[i] = toOAuthForm(item);
  else oauthForms.value.push(toOAuthForm(item));
  const rest = { ...oauthServerErrors.value };
  delete rest[item.id];
  oauthServerErrors.value = rest;
}

// Editing a provider drops its own server errors only (a sibling's failed save keeps its message).
watch(
  () => oauthForms.value.map((f) => JSON.stringify(f)),
  (next, prev) => {
    const ids = oauthForms.value.filter((_, i) => next[i] !== prev[i]).map((f) => f.id);
    if (!ids.some((id) => oauthServerErrors.value[id])) return;
    const rest = { ...oauthServerErrors.value };
    for (const id of ids) delete rest[id];
    oauthServerErrors.value = rest;
  },
);

/** Unsaved changes across all endpoints. */
const dirtyCount = computed(() => dirtyKeys.value.length + emailDirty.value.length + oauthDirtyCount.value + guards.dirtyCount);

/* ---------------- Validation ---------------- */

const navErrors = computed(() =>
  form.value.customNavLinks.map((row, i) => {
    const out: { label?: string; url?: string } = {};
    const label = row.label.trim();
    const url = row.url.trim();
    if (!label) out.label = t("settings.errors.required");
    else if (label.length > 40) out.label = t("settings.errors.maxLength", { n: 40 });
    if (!url) out.url = t("settings.errors.required");
    else if (!URL_RE.test(url)) out.url = t("settings.errors.url");
    out.label ??= serverErrors.value[`customNavLinks.${i}.label`];
    out.url ??= serverErrors.value[`customNavLinks.${i}.url`];
    return out;
  }),
);

function intError(v: number | string, min: number, max: number): string | undefined {
  if (v === "" || v === null) return t("settings.errors.required");
  const n = Number(v);
  if (!Number.isInteger(n)) return t("settings.errors.integer");
  if (n < min || n > max) return t("settings.errors.range", { min, max });
  return undefined;
}

const clientErrors = computed<Partial<Record<FieldKey, string>>>(() => {
  const f = form.value;
  const e: Partial<Record<FieldKey, string>> = {};
  const name = f.siteName.trim();
  if (!name) e.siteName = t("settings.errors.required");
  else if (name.length > 64) e.siteName = t("settings.errors.maxLength", { n: 64 });
  if (f.siteSubtitle.trim().length > 200) e.siteSubtitle = t("settings.errors.maxLength", { n: 200 });
  if (f.footerText.trim().length > 500) e.footerText = t("settings.errors.maxLength", { n: 500 });
  if (f.contactInfo.trim().length > 500) e.contactInfo = t("settings.errors.maxLength", { n: 500 });
  if (f.homeContent.length > HOME_MAX) e.homeContent = t("settings.errors.maxLength", { n: HOME_MAX });
  for (const k of ["logoUrl", "apiBaseUrl", "docUrl"] as const) {
    const v = f[k].trim();
    if (v && !URL_RE.test(v)) e[k] = t("settings.errors.url");
    else if (v.length > 2048) e[k] = t("settings.errors.maxLength", { n: 2048 });
  }
  if (!f.defaultBalanceUsd.trim()) e.defaultBalanceUsd = t("settings.errors.required");
  else if (usdToNano(f.defaultBalanceUsd) === null) e.defaultBalanceUsd = t("settings.errors.usd");
  const rpm = intError(f.defaultApiKeyRpm, 1, 100_000);
  if (rpm) e.defaultApiKeyRpm = rpm;
  const conc = intError(f.defaultApiKeyConcurrency, 1, 10_000);
  if (conc) e.defaultApiKeyConcurrency = conc;
  const userRpm = intError(f.defaultUserRpm, 0, 1_000_000);
  if (userRpm) e.defaultUserRpm = userRpm;
  const userConc = intError(f.defaultUserConcurrency, 0, 1_000_000);
  if (userConc) e.defaultUserConcurrency = userConc;
  const subDaysErr = intError(f.defaultSignupSubDays, 0, 3650);
  if (subDaysErr) e.defaultSignupSubDays = subDaysErr;
  if (f.rebatePercent === "") e.rebatePercent = t("settings.errors.required");
  else {
    const pct = Number(f.rebatePercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) e.rebatePercent = t("settings.errors.range", { min: 0, max: 50 });
  }
  if (!f.affiliateMinWithdrawUsd.trim()) e.affiliateMinWithdrawUsd = t("settings.errors.required");
  else if (usdToNano(f.affiliateMinWithdrawUsd) === null) e.affiliateMinWithdrawUsd = t("settings.errors.usd");
  if (navErrors.value.some((r) => r.label || r.url)) e.customNavLinks = t("settings.errors.navLinks");
  return e;
});

function fieldError(k: FieldKey): string | null {
  return clientErrors.value[k] ?? serverErrors.value[k] ?? null;
}

const portalInvalid = computed(() => Object.keys(clientErrors.value).length > 0);
/** SMTP problems only block saving when the SMTP settings are part of the save. */
const emailInvalid = computed(() => emailDirty.value.length > 0 && Object.keys(emailClientErrors.value).length > 0);
/** Likewise a provider's problems only block saving when that provider is part of the save. */
const oauthInvalid = computed(() => oauthDirtyIds.value.some((id) => oauthClientErrors.value[id] !== undefined));
const hasClientErrors = computed(() => portalInvalid.value || emailInvalid.value || oauthInvalid.value || guards.invalid);
const errorClass = "!border-danger/60 focus:!ring-danger/20";

/** Field names from a Zod message such as `siteName: Required; customNavLinks.0.url: …`. */
function parseServerErrors(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of message.split("; ")) {
    const m = /^([A-Za-z]+)((?:\.\d+\.[A-Za-z]+)?):\s*(.+)$/.exec(part.trim());
    if (!m) continue;
    let field = m[1]!;
    if (field === "affiliateRebateBps") field = "rebatePercent";
    if (field === "defaultBalanceNanoUsd") field = "defaultBalanceUsd";
    if (!(FIELDS as string[]).includes(field)) continue;
    out[`${field}${m[2] ?? ""}`] = m[3]!;
    if (m[2]) out[field] ??= m[3]!;
  }
  return out;
}

function tabWith(keys: string[]): TabKey | null {
  return TABS.find((tab) => TAB_FIELDS[tab].some((f) => keys.some((k) => k === f || k.startsWith(`${f}.`)))) ?? null;
}

watch(
  form,
  () => {
    if (Object.keys(serverErrors.value).length) serverErrors.value = {};
  },
  { deep: true },
);

/* ---------------- Tabs ---------------- */

function isTab(v: unknown): v is TabKey {
  return typeof v === "string" && (TABS as string[]).includes(v);
}

const tab = ref<TabKey>(isTab(route.query.tab) ? route.query.tab : "general");
watch(tab, (next) => {
  void router.replace({ query: { ...route.query, tab: next === "general" ? undefined : next } });
});

const tabs = computed(() =>
  TABS.map((key) => {
    const n =
      key === "email"
        ? emailDirty.value.length
        : key === "oauth"
          ? oauthDirtyCount.value
          : TAB_FIELDS[key].filter((f) => dirtySet.value.has(f)).length +
            (key === "registration" || key === "security" || key === "agreement" ? guards.tabCount(key) : 0);
    return { key, label: t(GUARD_TAB_LABEL[key] ?? `settings.tabs.${key}`), icon: TAB_ICON[key], count: n > 0 ? n : undefined };
  }),
);

/* ---------------- Derived UI ---------------- */

const logoFailed = ref(false);
watch(
  () => form.value.logoUrl,
  () => (logoFailed.value = false),
);
const logoPreview = computed(() => {
  const v = form.value.logoUrl.trim();
  return v && URL_RE.test(v) && !logoFailed.value ? v : "";
});

const origin = window.location.origin;
const allGroups = ref<GroupItem[]>([]);
const subscriptionGroups = computed(() => allGroups.value.filter((g) => g.enabled && g.subscriptionType === "subscription"));

const rebateBps = computed(() => {
  const n = Number(form.value.rebatePercent);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
});
const rebateExample = computed(() =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(
    (100 * rebateBps.value) / 10_000,
  ),
);

const homeLength = computed(() => form.value.homeContent.length);

/* ---------------- Load / save ---------------- */

async function load() {
  loading.value = true;
  emailLoading.value = true;
  oauthLoading.value = true;
  loadError.value = null;
  emailLoadError.value = null;
  oauthLoadError.value = null;
  void guards.loadCaptcha();
  void apiJson<{ groups: GroupItem[] }>("/api/v1/admin/groups")
    .then((res) => (allGroups.value = res.groups))
    .catch(() => {});
  const [settingsRes, emailRes, oauthRes] = await Promise.allSettled([
    apiJson<PortalSettings>("/api/v1/admin/settings"),
    apiJson<EmailConfig>("/api/v1/admin/email/config"),
    apiJson<{ items: OAuthProviderConfig[] }>("/api/v1/admin/oauth/providers"),
  ]);
  if (settingsRes.status === "fulfilled") applyServer(settingsRes.value);
  else loadError.value = errorText(settingsRes.reason, t("common.loadFailed"));
  if (emailRes.status === "fulfilled") applyEmail(emailRes.value);
  else emailLoadError.value = errorText(emailRes.reason, t("common.loadFailed"));
  if (oauthRes.status === "fulfilled") applyOAuth(oauthRes.value.items);
  else oauthLoadError.value = errorText(oauthRes.reason, t("common.loadFailed"));
  loading.value = false;
  emailLoading.value = false;
  oauthLoading.value = false;
}

/** Retry for the Email tab alone (keeps any portal edits). */
async function loadEmail() {
  emailLoading.value = true;
  emailLoadError.value = null;
  try {
    applyEmail(await apiJson<EmailConfig>("/api/v1/admin/email/config"));
  } catch (err) {
    emailLoadError.value = errorText(err, t("common.loadFailed"));
  } finally {
    emailLoading.value = false;
  }
}

/** Retry for the sign-in tab alone (keeps other edits). */
async function loadOAuth() {
  oauthLoading.value = true;
  oauthLoadError.value = null;
  try {
    applyOAuth((await apiJson<{ items: OAuthProviderConfig[] }>("/api/v1/admin/oauth/providers")).items);
  } catch (err) {
    oauthLoadError.value = errorText(err, t("common.loadFailed"));
  } finally {
    oauthLoading.value = false;
  }
}

function reload() {
  if (dirtyCount.value && !window.confirm(t("settings.discardConfirm"))) return;
  void load();
}

function discard() {
  if (baseline.value) form.value = cloneForm(baseline.value);
  if (emailSaved.value) emailForm.value = toEmailForm(emailSaved.value);
  if (oauthSaved.value) oauthForms.value = oauthSaved.value.map(toOAuthForm);
  serverErrors.value = {};
  emailServerErrors.value = {};
  oauthServerErrors.value = {};
  guards.discard();
}

function buildPatch(): UpdatePortalSettingsRequest {
  const f = form.value;
  const patch: UpdatePortalSettingsRequest = {};
  for (const k of dirtyKeys.value) {
    switch (k) {
      case "customNavLinks":
        patch.customNavLinks = f.customNavLinks.map((r) => ({ label: r.label.trim(), url: r.url.trim() }));
        break;
      case "defaultBalanceUsd":
        patch.defaultBalanceUsd = f.defaultBalanceUsd.trim().replace(/^\$/, "");
        break;
      case "defaultApiKeyRpm":
        patch.defaultApiKeyRpm = Number(f.defaultApiKeyRpm);
        break;
      case "defaultApiKeyConcurrency":
        patch.defaultApiKeyConcurrency = Number(f.defaultApiKeyConcurrency);
        break;
      case "defaultUserRpm":
        patch.defaultUserRpm = Number(f.defaultUserRpm);
        invalidatePortalCapDefaults();
        break;
      case "defaultUserConcurrency":
        patch.defaultUserConcurrency = Number(f.defaultUserConcurrency);
        invalidatePortalCapDefaults();
        break;
      case "defaultSignupSubDays":
        patch.defaultSignupSubDays = Number(f.defaultSignupSubDays);
        break;
      case "rebatePercent":
        patch.affiliateRebateBps = rebateBps.value;
        break;
      case "affiliateMinWithdrawUsd":
        patch.affiliateMinWithdrawUsd = f.affiliateMinWithdrawUsd.trim().replace(/^\$/, "");
        break;
      default:
        Object.assign(patch, { [k]: f[k] });
    }
  }
  return patch;
}

/** PATCH the changed portal fields; resolves to an error message or null. */
async function savePortal(): Promise<string | null> {
  try {
    // One PATCH for every portal field (the sign-in guard fields included): the BFF merges into
    // the stored settings, so two concurrent PATCHes could lose one another's changes.
    const body = { ...buildPatch(), ...guards.portalPatch() };
    applyServer(await apiJson<PortalSettings>("/api/v1/admin/settings", { method: "PATCH", body }));
    return null;
  } catch (err) {
    const message = errorText(err, t("settings.saveFailed"));
    serverErrors.value = parseServerErrors(message);
    guards.setPortalServerErrors(message);
    return message;
  }
}

/** PATCH the changed SMTP fields (the password only when typed or cleared). */
async function saveEmail(): Promise<string | null> {
  try {
    const body = buildEmailPatch(emailForm.value, emailDirty.value);
    applyEmail(await apiJson<EmailConfig>("/api/v1/admin/email/config", { method: "PATCH", body }));
    return null;
  } catch (err) {
    const message = errorText(err, t("settings.saveFailed"));
    emailServerErrors.value = parseEmailServerErrors(message);
    return message;
  }
}

/** PATCH one sign-in provider's changed fields (the secret only when typed or cleared). */
async function saveOAuthProvider(id: OAuthProviderId): Promise<string | null> {
  const f = oauthForms.value.find((x) => x.id === id);
  const keys = oauthDirty.value[id];
  if (!f || !keys?.length) return null;
  const name = f.displayName.trim() || OAUTH_DEFAULT_NAMES[id];
  try {
    const body = buildOAuthPatch(f, keys);
    const res = await apiJson<{ item?: OAuthProviderConfig }>(`/api/v1/admin/oauth/providers/${id}`, { method: "PATCH", body });
    if (res.item) applyOAuthItem(res.item);
    return null;
  } catch (err) {
    const message = errorText(err, t("settings.saveFailed"));
    oauthServerErrors.value = { ...oauthServerErrors.value, [id]: parseOAuthServerErrors(message) };
    return `${name}: ${message}`;
  }
}

async function save() {
  if (saving.value || !dirtyCount.value) return;
  if (hasClientErrors.value) {
    const target = portalInvalid.value
      ? tabWith(Object.keys(clientErrors.value))
      : (guards.invalidTab ?? (emailInvalid.value ? "email" : "oauth"));
    if (target) tab.value = target;
    toast.error(t("settings.fixErrors"));
    return;
  }
  saving.value = true;
  try {
    // Every endpoint in parallel (one PATCH per changed provider); whichever succeeds is applied
    // even if another fails.
    const portalTask = dirtyKeys.value.length || guards.portalDirty.length ? savePortal() : null;
    const emailTask = emailDirty.value.length ? saveEmail() : null;
    const oauthTasks = oauthDirtyIds.value.map(saveOAuthProvider);
    const captchaTask = guards.captchaDirty.length ? guards.saveCaptcha() : null;
    const attempted = (portalTask ? 1 : 0) + (emailTask ? 1 : 0) + oauthTasks.length + (captchaTask ? 1 : 0);
    const [portalError, emailError, oauthResults, captchaError] = await Promise.all([
      portalTask,
      emailTask,
      Promise.all(oauthTasks),
      captchaTask,
    ]);
    const errors = [portalError, emailError, ...oauthResults, captchaError].filter((e): e is string => e !== null);
    // Public settings (sign-up switches, password reset, sign-in buttons) depend on all of them.
    if (errors.length < attempted) void portal.refresh();
    if (!errors.length) {
      toast.success(t("settings.saved"));
      return;
    }
    let target: TabKey | null = null;
    if (portalError) target = tabWith(Object.keys(serverErrors.value)) ?? guards.portalErrorTab;
    else if (captchaError) target = "security";
    else if (Object.keys(emailServerErrors.value).length) target = "email";
    else if (Object.keys(oauthServerErrors.value).length) target = "oauth";
    if (target) tab.value = target;
    toast.error(errors.join(" · "));
  } finally {
    saving.value = false;
  }
}

/* ---------------- Guards & shortcuts ---------------- */

function onKeydown(ev: KeyboardEvent) {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    void save();
  }
}

function onBeforeUnload(ev: BeforeUnloadEvent) {
  if (!dirtyCount.value) return;
  ev.preventDefault();
  ev.returnValue = "";
}

onBeforeRouteLeave(() => {
  if (dirtyCount.value && !saving.value) return window.confirm(t("settings.leaveConfirm"));
  return true;
});

onMounted(() => {
  void load();
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("beforeunload", onBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("beforeunload", onBeforeUnload);
});

/** Staggered entrance for cards (capped so long pages don't lag). */
const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 5) * 60}ms`, animationFillMode: "both" });
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('settings.title')">
      <template #meta>
        <Transition
          enter-active-class="transition duration-200 ease-out"
          leave-active-class="transition duration-150 ease-in"
          enter-from-class="opacity-0 scale-95"
          leave-to-class="opacity-0 scale-95"
        >
          <UiBadge v-if="dirtyCount" tone="warning" dot>{{ t("settings.unsaved", { n: dirtyCount }) }}</UiBadge>
        </Transition>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading || saving" @click="reload">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </PageHeader>

    <UiAlert v-if="loadError && !baseline" tone="danger" :title="t('settings.loadFailed')">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="load">
          {{ t("settings.retry") }}
        </button>
      </template>
    </UiAlert>

    <!-- First-load skeleton -->
    <div v-if="!baseline && loading" class="space-y-6" aria-busy="true">
      <div class="flex gap-3 border-b border-line pb-3">
        <div v-for="i in 4" :key="i" class="h-6 w-24 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" />
      </div>
      <div v-for="i in 2" :key="i" class="card space-y-4 p-5">
        <div class="h-4 w-40 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
        <div class="grid gap-4 sm:grid-cols-2">
          <div v-for="j in 4" :key="j" class="space-y-2">
            <div class="h-3 w-24 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
            <div class="h-9 animate-pulse rounded-lg bg-surface-2/70 motion-reduce:animate-none" />
          </div>
        </div>
      </div>
    </div>

    <template v-else-if="baseline">
      <UiTabs v-model="tab" :tabs="tabs" />

      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <!-- ============ General & branding ============ -->
        <div v-if="tab === 'general'" key="general" class="space-y-6">
          <div class="grid gap-6 xl:grid-cols-5">
            <UiCard
              class="animate-slide-up motion-reduce:animate-none xl:col-span-3"
              :style="stagger(0)"
              icon="sparkles"
              :title="t('settings.general.brandingTitle')"
            >
              <div class="grid gap-4 sm:grid-cols-2">
                <SettingField
                  input-id="set-site-name"
                  :label="t('settings.general.siteName')"
                  required
                  :dirty="isDirty('siteName')"
                  :error="fieldError('siteName')"
                >
                  <input
                    id="set-site-name"
                    v-model="form.siteName"
                    type="text"
                    maxlength="64"
                    class="input"
                    :class="fieldError('siteName') ? errorClass : ''"
                  />
                </SettingField>
                <SettingField
                  input-id="set-site-subtitle"
                  :label="t('settings.general.siteSubtitle')"
                  :dirty="isDirty('siteSubtitle')"
                  :error="fieldError('siteSubtitle')"
                >
                  <input
                    id="set-site-subtitle"
                    v-model="form.siteSubtitle"
                    type="text"
                    maxlength="200"
                    class="input"
                    :class="fieldError('siteSubtitle') ? errorClass : ''"
                    :placeholder="t('settings.general.siteSubtitlePlaceholder')"
                  />
                </SettingField>
                <SettingField
                  class="sm:col-span-2"
                  input-id="set-logo"
                  :label="t('settings.general.logoUrl')"
                  :hint="t('settings.general.logoHint')"
                  :dirty="isDirty('logoUrl')"
                  :error="fieldError('logoUrl')"
                >
                  <input
                    id="set-logo"
                    v-model="form.logoUrl"
                    type="text"
                    inputmode="url"
                    spellcheck="false"
                    class="input font-mono"
                    :class="fieldError('logoUrl') ? errorClass : ''"
                    placeholder="https://example.com/logo.svg"
                  />
                </SettingField>
                <SettingField
                  class="sm:col-span-2"
                  input-id="set-footer"
                  :label="t('settings.general.footerText')"
                  :dirty="isDirty('footerText')"
                  :error="fieldError('footerText')"
                >
                  <template #aside>
                    <span class="text-2xs tabular-nums text-fg-subtle">{{ form.footerText.length }}/500</span>
                  </template>
                  <textarea
                    id="set-footer"
                    v-model="form.footerText"
                    rows="2"
                    maxlength="500"
                    class="textarea"
                    :class="fieldError('footerText') ? errorClass : ''"
                    :placeholder="t('settings.general.footerPlaceholder')"
                  />
                </SettingField>
              </div>
            </UiCard>

            <!-- Live brand preview -->
            <UiCard
              class="animate-slide-up motion-reduce:animate-none xl:col-span-2"
              :style="stagger(1)"
              icon="eye"
              :title="t('settings.general.previewTitle')"
            >
              <div class="overflow-hidden rounded-xl border border-line bg-bg">
                <div class="flex items-center gap-3 border-b border-line/70 bg-surface px-4 py-3">
                  <span
                    class="inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-2 ring-1 ring-inset ring-line"
                  >
                    <img
                      v-if="logoPreview"
                      :key="logoPreview"
                      :src="logoPreview"
                      alt=""
                      class="h-full w-full animate-fade-in object-contain p-1"
                      @error="logoFailed = true"
                    />
                    <BrandMark v-else :size="28" />
                  </span>
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-fg">{{ form.siteName.trim() || "—" }}</p>
                    <p class="truncate text-xs text-fg-subtle">
                      {{ form.siteSubtitle.trim() || t("settings.general.noSubtitle") }}
                    </p>
                  </div>
                </div>
                <div class="space-y-2 bg-grid px-4 py-5">
                  <div class="h-2.5 w-2/3 rounded-full bg-surface-3/80" />
                  <div class="h-2.5 w-1/2 rounded-full bg-surface-3/60" />
                  <div class="h-2.5 w-3/5 rounded-full bg-surface-3/40" />
                </div>
                <div class="border-t border-line/70 bg-surface/60 px-4 py-2.5 text-center text-2xs text-fg-subtle">
                  {{ form.footerText.trim() || t("settings.general.noFooter") }}
                </div>
              </div>
              <p v-if="logoFailed" class="mt-3 flex items-center gap-1.5 text-xs text-warning">
                <UiIcon name="alert" :size="13" />
                {{ t("settings.general.logoFailed") }}
              </p>
            </UiCard>
          </div>

          <UiCard
            class="animate-slide-up motion-reduce:animate-none"
            :style="stagger(2)"
            icon="book-open"
            :title="t('settings.general.docsTitle')"
          >
            <div class="grid gap-4 md:grid-cols-2">
              <SettingField
                input-id="set-api-base"
                :label="t('settings.general.apiBaseUrl')"
                :hint="t('settings.general.apiBaseHint')"
                :dirty="isDirty('apiBaseUrl')"
                :error="fieldError('apiBaseUrl')"
              >
                <input
                  id="set-api-base"
                  v-model="form.apiBaseUrl"
                  type="text"
                  inputmode="url"
                  spellcheck="false"
                  class="input font-mono"
                  :class="fieldError('apiBaseUrl') ? errorClass : ''"
                  :placeholder="origin"
                />
              </SettingField>
              <SettingField
                input-id="set-doc-url"
                :label="t('settings.general.docUrl')"
                :hint="t('settings.general.docHint')"
                :dirty="isDirty('docUrl')"
                :error="fieldError('docUrl')"
              >
                <input
                  id="set-doc-url"
                  v-model="form.docUrl"
                  type="text"
                  inputmode="url"
                  spellcheck="false"
                  class="input font-mono"
                  :class="fieldError('docUrl') ? errorClass : ''"
                  placeholder="https://docs.example.com"
                />
              </SettingField>
              <SettingField
                class="md:col-span-2"
                input-id="set-contact"
                :label="t('settings.general.contactInfo')"
                :hint="t('settings.general.contactHint')"
                :dirty="isDirty('contactInfo')"
                :error="fieldError('contactInfo')"
              >
                <textarea
                  id="set-contact"
                  v-model="form.contactInfo"
                  rows="2"
                  maxlength="500"
                  class="textarea"
                  :class="fieldError('contactInfo') ? errorClass : ''"
                  :placeholder="t('settings.general.contactPlaceholder')"
                />
              </SettingField>
            </div>
          </UiCard>
        </div>

        <!-- ============ Registration & defaults ============ -->
        <div v-else-if="tab === 'registration'" key="registration" class="grid gap-6 xl:grid-cols-2">
          <UiCard
            class="animate-slide-up motion-reduce:animate-none"
            :style="stagger(0)"
            icon="user-plus"
            :title="t('settings.registration.title')"
          >
            <div class="divide-y divide-line/70">
              <SettingSwitchRow
                v-model="form.allowRegistration"
                icon="user-plus"
                tone="success"
                :title="t('settings.registration.allow')"
                :description="t('settings.registration.allowHelp')"
                :dirty="isDirty('allowRegistration')"
              />
              <SettingSwitchRow
                v-model="form.inviteRequired"
                icon="lock"
                tone="warning"
                :title="t('settings.registration.invite')"
                :description="t('settings.registration.inviteHelp')"
                :dirty="isDirty('inviteRequired')"
              >
                <p
                  v-if="form.inviteRequired && !form.allowRegistration"
                  class="mt-1.5 flex items-center gap-1 text-2xs text-fg-subtle"
                >
                  <UiIcon name="info" :size="11" />
                  {{ t("settings.registration.inviteClosedNote") }}
                </p>
              </SettingSwitchRow>
              <SettingSwitchRow
                v-model="form.emailVerificationRequired"
                icon="badge-check"
                tone="info"
                :title="t('settings.registration.emailVerify')"
                :description="t('settings.registration.emailVerifyHelp')"
                :dirty="isDirty('emailVerificationRequired')"
              >
                <Transition
                  enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
                  leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
                  enter-from-class="-translate-y-0.5 opacity-0"
                  leave-to-class="opacity-0"
                >
                  <p
                    v-if="form.emailVerificationRequired && emailSaved && !emailReady"
                    class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-warning"
                  >
                    <span class="inline-flex items-center gap-1">
                      <UiIcon name="alert" :size="11" />
                      {{ t("settings.registration.emailVerifyInactive") }}
                    </span>
                    <button
                      type="button"
                      class="inline-flex cursor-pointer items-center gap-0.5 font-medium text-accent hover:underline"
                      @click="tab = 'email'"
                    >
                      {{ t("settings.registration.configureEmail") }}
                      <UiIcon name="arrow-right" :size="11" />
                    </button>
                  </p>
                </Transition>
              </SettingSwitchRow>
              <SettingSwitchRow
                v-model="form.promoCodeEnabled"
                icon="percent"
                tone="violet"
                :title="t('settings.registration.promo')"
                :description="t('settings.registration.promoHelp')"
                :dirty="isDirty('promoCodeEnabled')"
              />
            </div>
          </UiCard>

          <UiCard
            class="animate-slide-up motion-reduce:animate-none"
            :style="stagger(1)"
            icon="gift"
            :title="t('settings.registration.defaultsTitle')"
          >
            <div class="space-y-4">
              <SettingField
                input-id="set-balance"
                :label="t('settings.registration.balance')"
                :hint="t('settings.registration.balanceHint')"
                :dirty="isDirty('defaultBalanceUsd')"
                :error="fieldError('defaultBalanceUsd')"
              >
                <div class="relative">
                  <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-fg-subtle">$</span>
                  <input
                    id="set-balance"
                    v-model="form.defaultBalanceUsd"
                    type="text"
                    inputmode="decimal"
                    class="input pl-7 font-mono"
                    :class="fieldError('defaultBalanceUsd') ? errorClass : ''"
                    placeholder="0"
                  />
                </div>
              </SettingField>
              <div class="grid gap-4 sm:grid-cols-2">
                <SettingField
                  input-id="set-rpm"
                  :label="t('settings.registration.rpm')"
                  :hint="t('settings.registration.rpmHint')"
                  :dirty="isDirty('defaultApiKeyRpm')"
                  :error="fieldError('defaultApiKeyRpm')"
                >
                  <input
                    id="set-rpm"
                    v-model.number="form.defaultApiKeyRpm"
                    type="number"
                    min="1"
                    max="100000"
                    step="1"
                    class="input font-mono"
                    :class="fieldError('defaultApiKeyRpm') ? errorClass : ''"
                  />
                </SettingField>
                <SettingField
                  input-id="set-concurrency"
                  :label="t('settings.registration.concurrency')"
                  :hint="t('settings.registration.concurrencyHint')"
                  :dirty="isDirty('defaultApiKeyConcurrency')"
                  :error="fieldError('defaultApiKeyConcurrency')"
                >
                  <input
                    id="set-concurrency"
                    v-model.number="form.defaultApiKeyConcurrency"
                    type="number"
                    min="1"
                    max="10000"
                    step="1"
                    class="input font-mono"
                    :class="fieldError('defaultApiKeyConcurrency') ? errorClass : ''"
                  />
                </SettingField>
              </div>
              <!-- Per-user caps across all of a user's keys (lane U1) -->
              <div class="border-t border-line/70 pt-4">
                <p class="eyebrow">{{ t("userLimits.settings.title") }}</p>
                <p class="mt-1 text-xs text-fg-subtle">{{ t("userLimits.settings.hint") }}</p>
              </div>
              <div class="grid gap-4 sm:grid-cols-2">
                <SettingField
                  input-id="set-user-rpm"
                  :label="t('userLimits.settings.rpm')"
                  :hint="t('userLimits.settings.rpmHint')"
                  :dirty="isDirty('defaultUserRpm')"
                  :error="fieldError('defaultUserRpm')"
                >
                  <input
                    id="set-user-rpm"
                    v-model.number="form.defaultUserRpm"
                    type="number"
                    min="0"
                    max="1000000"
                    step="1"
                    class="input font-mono"
                    :class="fieldError('defaultUserRpm') ? errorClass : ''"
                  />
                </SettingField>
                <SettingField
                  input-id="set-user-concurrency"
                  :label="t('userLimits.settings.concurrency')"
                  :hint="t('userLimits.settings.concurrencyHint')"
                  :dirty="isDirty('defaultUserConcurrency')"
                  :error="fieldError('defaultUserConcurrency')"
                >
                  <input
                    id="set-user-concurrency"
                    v-model.number="form.defaultUserConcurrency"
                    type="number"
                    min="0"
                    max="1000000"
                    step="1"
                    class="input font-mono"
                    :class="fieldError('defaultUserConcurrency') ? errorClass : ''"
                  />
                </SettingField>
              </div>
            </div>
          </UiCard>

          <UiCard
            class="animate-slide-up motion-reduce:animate-none xl:col-span-2"
            :style="stagger(2)"
            icon="layers"
            :title="t('settings.registration.signupDefaultsTitle')"
          >
            <div class="space-y-5">
              <GroupPicker
                v-model="form.defaultSignupGroupIds"
                :groups="allGroups"
                :label="t('settings.registration.defaultGroups')"
                :hint="t('settings.registration.defaultGroupsHint')"
                :empty-label="t('settings.registration.noGroups')"
              />
              <div class="grid gap-4 sm:grid-cols-2">
                <SettingField
                  input-id="set-signup-sub-group"
                  :label="t('settings.registration.trialSubGroup')"
                  :hint="t('settings.registration.trialSubGroupHint')"
                  :dirty="isDirty('defaultSignupSubGroupId')"
                >
                  <select id="set-signup-sub-group" v-model="form.defaultSignupSubGroupId" class="select">
                    <option value="">{{ t("settings.registration.trialSubNone") }}</option>
                    <option v-for="g in subscriptionGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
                  </select>
                </SettingField>
                <SettingField
                  input-id="set-signup-sub-days"
                  :label="t('settings.registration.trialSubDays')"
                  :hint="t('settings.registration.trialSubDaysHint')"
                  :dirty="isDirty('defaultSignupSubDays')"
                  :error="fieldError('defaultSignupSubDays')"
                >
                  <input
                    id="set-signup-sub-days"
                    v-model.number="form.defaultSignupSubDays"
                    type="number"
                    min="0"
                    max="3650"
                    step="1"
                    class="input font-mono"
                    :class="fieldError('defaultSignupSubDays') ? errorClass : ''"
                  />
                </SettingField>
              </div>
            </div>
          </UiCard>

          <!-- Sign-up email domains (allowlist, per-domain quota) -->
          <RegistrationEmailPolicyCard
            v-model:allowlist="guards.portalForm.registrationEmailSuffixAllowlist"
            v-model:quota="guards.portalForm.registrationEmailDomainQuotaEnabled"
            class="animate-slide-up motion-reduce:animate-none xl:col-span-2"
            :style="stagger(3)"
            :dirty-keys="guards.portalDirty"
            :errors="guards.portalErrors"
          />
        </div>

        <!-- ============ Sign-in security (captcha, backend mode) ============ -->
        <div v-else-if="tab === 'security'" key="security" class="space-y-6">
          <CaptchaSettingsPanel
            v-model="guards.captchaForm"
            :saved="guards.captchaSaved"
            :loading="guards.captchaLoading"
            :load-error="guards.captchaLoadError"
            :dirty-keys="guards.captchaDirty"
            :errors="guards.captchaErrors"
            :failure="guards.captchaFailure"
            @retry="guards.loadCaptcha()"
          />
          <BackendModeCard
            v-model="guards.portalForm.backendModeEnabled"
            class="animate-slide-up motion-reduce:animate-none"
            :style="stagger(3)"
            :saved="guards.portalBase?.backendModeEnabled ?? false"
            :dirty="guards.portalDirty.includes('backendModeEnabled')"
          />
          <AuditRetentionSettingsRow class="animate-slide-up motion-reduce:animate-none" :style="stagger(4)" />
          <AdminApiKeysPanel class="animate-slide-up motion-reduce:animate-none" :style="stagger(5)" />
        </div>

        <!-- ============ Login agreement & legal documents ============ -->
        <div v-else-if="tab === 'agreement'" key="agreement">
          <LoginAgreementEditor
            v-model="guards.portalForm"
            :saved="guards.portalBase"
            :dirty-keys="guards.portalDirty"
            :errors="guards.portalErrors"
            :doc-errors="guards.docErrors"
          />
        </div>

        <!-- ============ Email (SMTP) ============ -->
        <div v-else-if="tab === 'email'" key="email">
          <EmailSettingsPanel
            v-if="emailSaved"
            v-model="emailForm"
            :saved="emailSaved"
            :dirty-keys="emailDirty"
            :errors="emailErrors"
            :verification-required="form.emailVerificationRequired"
            :public-url-set="configuredPublicBaseUrl({ apiBaseUrl: form.apiBaseUrl }) !== null"
            @open-registration="tab = 'registration'"
            @open-general="tab = 'general'"
          />
          <UiAlert v-else-if="emailLoadError && !emailLoading" tone="danger" :title="t('settings.email.loadFailed')">
            {{ emailLoadError }}
            <template #action>
              <button type="button" class="btn btn-secondary btn-sm shrink-0" @click="loadEmail">
                {{ t("settings.retry") }}
              </button>
            </template>
          </UiAlert>
          <div v-else class="grid gap-6 xl:grid-cols-5" aria-busy="true">
            <div class="card space-y-4 p-5 xl:col-span-3">
              <div class="h-4 w-40 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
              <div class="grid gap-4 sm:grid-cols-2">
                <div v-for="j in 4" :key="j" class="space-y-2">
                  <div class="h-3 w-24 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
                  <div class="h-9 animate-pulse rounded-lg bg-surface-2/70 motion-reduce:animate-none" />
                </div>
              </div>
            </div>
            <div class="card space-y-3 p-5 xl:col-span-2">
              <div class="h-4 w-32 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
              <div class="h-9 animate-pulse rounded-lg bg-surface-2/70 motion-reduce:animate-none" />
            </div>
          </div>
        </div>

        <!-- ============ Third-party sign-in ============ -->
        <div v-else-if="tab === 'oauth'" key="oauth">
          <OAuthProvidersPanel
            v-if="oauthSaved"
            v-model="oauthForms"
            :saved="oauthSaved"
            :dirty="oauthDirty"
            :errors="oauthErrors"
            :api-base-url="form.apiBaseUrl"
            :registration-open="form.allowRegistration && !form.inviteRequired"
            @open-registration="tab = 'registration'"
          />
          <UiAlert v-else-if="oauthLoadError && !oauthLoading" tone="danger" :title="t('settings.oauth.loadFailed')">
            {{ oauthLoadError }}
            <template #action>
              <button type="button" class="btn btn-secondary btn-sm shrink-0" @click="loadOAuth">
                {{ t("settings.retry") }}
              </button>
            </template>
          </UiAlert>
          <div v-else class="space-y-6" aria-busy="true">
            <div class="card space-y-3 p-5">
              <div class="h-4 w-40 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
              <div class="h-3 w-2/3 animate-pulse rounded bg-surface-2/70 motion-reduce:animate-none" />
            </div>
            <div class="grid gap-6 xl:grid-cols-2">
              <div v-for="i in 2" :key="i" class="card space-y-4 p-5">
                <div class="flex items-center gap-3">
                  <div class="h-9 w-9 animate-pulse rounded-lg bg-surface-2 motion-reduce:animate-none" />
                  <div class="h-4 w-28 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
                </div>
                <div class="grid gap-4 sm:grid-cols-2">
                  <div v-for="j in 2" :key="j" class="space-y-2">
                    <div class="h-3 w-24 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
                    <div class="h-9 animate-pulse rounded-lg bg-surface-2/70 motion-reduce:animate-none" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ============ Public pages ============ -->
        <div v-else-if="tab === 'public'" key="public" class="space-y-6">
          <UiCard
            class="animate-slide-up motion-reduce:animate-none"
            :style="stagger(0)"
            icon="globe"
            :title="t('settings.public.pagesTitle')"
          >
            <div class="divide-y divide-line/70">
              <SettingSwitchRow
                v-model="form.modelPlazaEnabled"
                icon="grid"
                tone="accent"
                :title="t('settings.public.plaza')"
                :description="t('settings.public.plazaHelp')"
                :dirty="isDirty('modelPlazaEnabled')"
              >
                <a href="/models" target="_blank" rel="noopener" class="mt-1 inline-flex items-center gap-1 font-mono text-2xs text-accent hover:underline">
                  /models <UiIcon name="external-link" :size="11" />
                </a>
              </SettingSwitchRow>
              <SettingSwitchRow
                v-model="form.statusPageEnabled"
                icon="activity"
                tone="success"
                :title="t('settings.public.status')"
                :description="t('settings.public.statusHelp')"
                :dirty="isDirty('statusPageEnabled')"
              >
                <a href="/status" target="_blank" rel="noopener" class="mt-1 inline-flex items-center gap-1 font-mono text-2xs text-accent hover:underline">
                  /status <UiIcon name="external-link" :size="11" />
                </a>
              </SettingSwitchRow>
              <SettingSwitchRow
                v-model="form.keyUsageLookupEnabled"
                icon="search"
                tone="info"
                :title="t('settings.public.keyUsage')"
                :description="t('settings.public.keyUsageHelp')"
                :dirty="isDirty('keyUsageLookupEnabled')"
              >
                <a href="/key-usage" target="_blank" rel="noopener" class="mt-1 inline-flex items-center gap-1 font-mono text-2xs text-accent hover:underline">
                  /key-usage <UiIcon name="external-link" :size="11" />
                </a>
              </SettingSwitchRow>
            </div>
          </UiCard>

          <UiCard
            class="animate-slide-up motion-reduce:animate-none"
            :style="stagger(1)"
            icon="home"
            :title="t('settings.public.homeTitle')"
          >
            <template #actions>
              <span v-if="isDirty('homeContent')" class="inline-block h-1.5 w-1.5 rounded-full bg-accent" :title="t('settings.modified')" />
              <span class="text-xs tabular-nums" :class="homeLength > HOME_MAX ? 'text-danger' : 'text-fg-subtle'">
                {{ homeLength.toLocaleString() }} / {{ HOME_MAX.toLocaleString() }}
              </span>
            </template>
            <p class="mb-3 text-xs text-fg-subtle">{{ t("settings.public.homeHelp") }}</p>
            <div class="grid gap-4 lg:grid-cols-2">
              <div class="min-w-0">
                <p class="eyebrow mb-1.5">{{ t("settings.public.markdown") }}</p>
                <textarea
                  id="set-home"
                  v-model="form.homeContent"
                  rows="16"
                  spellcheck="false"
                  class="textarea min-h-[18rem] resize-y font-mono text-xs"
                  :class="fieldError('homeContent') ? errorClass : ''"
                  :aria-label="t('settings.public.homeTitle')"
                  :placeholder="t('settings.public.homePlaceholder')"
                />
                <p v-if="fieldError('homeContent')" class="mt-1 text-xs text-danger">{{ fieldError("homeContent") }}</p>
              </div>
              <div class="min-w-0">
                <p class="eyebrow mb-1.5">{{ t("settings.public.preview") }}</p>
                <div class="h-[18rem] overflow-y-auto rounded-lg border border-line bg-bg/60 p-4 lg:h-[calc(100%-1.375rem)] lg:min-h-[18rem]">
                  <MarkdownView v-if="form.homeContent.trim()" :source="form.homeContent" />
                  <EmptyState v-else compact icon="home" :title="t('settings.public.homeEmpty')" />
                </div>
              </div>
            </div>
          </UiCard>

          <UiCard
            class="animate-slide-up motion-reduce:animate-none"
            :style="stagger(2)"
            icon="link"
            :title="t('settings.nav.title')"
          >
            <template #actions>
              <span v-if="isDirty('customNavLinks')" class="inline-block h-1.5 w-1.5 rounded-full bg-accent" :title="t('settings.modified')" />
            </template>
            <p class="mb-4 text-xs text-fg-subtle">{{ t("settings.nav.help") }}</p>
            <NavLinksEditor v-model="form.customNavLinks" :max="MAX_NAV_LINKS" :errors="navErrors" />
          </UiCard>

          <SitePagesPanel class="animate-slide-up motion-reduce:animate-none" :style="stagger(3)" />
        </div>

        <!-- ============ Referral program ============ -->
        <div v-else key="referral" class="grid gap-6 xl:grid-cols-5">
          <UiCard
            class="animate-slide-up motion-reduce:animate-none xl:col-span-3"
            :style="stagger(0)"
            icon="share"
            :title="t('settings.referral.title')"
          >
            <div class="divide-y divide-line/70">
              <SettingSwitchRow
                v-model="form.affiliateEnabled"
                icon="gift"
                tone="success"
                :title="t('settings.referral.enabled')"
                :description="t('settings.referral.enabledHelp')"
                :dirty="isDirty('affiliateEnabled')"
              />
              <div class="space-y-4 pt-4 transition-opacity" :class="form.affiliateEnabled ? '' : 'opacity-60'">
                <SettingField
                  input-id="set-rebate"
                  :label="t('settings.referral.rate')"
                  :hint="t('settings.referral.rateHint')"
                  :dirty="isDirty('rebatePercent')"
                  :error="fieldError('rebatePercent')"
                >
                  <div class="flex items-center gap-4">
                    <input
                      v-model.number="form.rebatePercent"
                      type="range"
                      min="0"
                      max="50"
                      step="0.5"
                      class="h-1.5 min-w-0 flex-1 cursor-pointer"
                      style="accent-color: rgb(var(--accent-solid))"
                      :aria-label="t('settings.referral.rate')"
                    />
                    <div class="relative w-28 shrink-0">
                      <input
                        id="set-rebate"
                        v-model.number="form.rebatePercent"
                        type="number"
                        min="0"
                        max="50"
                        step="0.01"
                        class="input pr-7 text-right font-mono"
                        :class="fieldError('rebatePercent') ? errorClass : ''"
                      />
                      <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-fg-subtle">%</span>
                    </div>
                  </div>
                </SettingField>

                <SettingField
                  input-id="set-aff-credit-mode"
                  :label="t('settings.referral.creditMode')"
                  :hint="t('settings.referral.creditModeHint')"
                  :dirty="isDirty('affiliateCreditMode')"
                >
                  <select id="set-aff-credit-mode" v-model="form.affiliateCreditMode" class="input">
                    <option value="wallet">{{ t("settings.referral.creditModeOptions.wallet") }}</option>
                    <option value="commission_pool">{{ t("settings.referral.creditModeOptions.commission_pool") }}</option>
                  </select>
                </SettingField>

                <SettingField
                  input-id="set-aff-min-withdraw"
                  :label="t('settings.referral.minWithdrawUsd')"
                  :hint="t('settings.referral.minWithdrawUsdHint')"
                  :dirty="isDirty('affiliateMinWithdrawUsd')"
                  :error="fieldError('affiliateMinWithdrawUsd')"
                >
                  <div class="relative w-44">
                    <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-fg-subtle">$</span>
                    <input
                      id="set-aff-min-withdraw"
                      v-model="form.affiliateMinWithdrawUsd"
                      type="text"
                      inputmode="decimal"
                      class="input pl-7 font-mono"
                      :class="fieldError('affiliateMinWithdrawUsd') ? errorClass : ''"
                    />
                  </div>
                </SettingField>
              </div>
            </div>
          </UiCard>

          <UiCard
            class="animate-slide-up motion-reduce:animate-none xl:col-span-2"
            :style="stagger(1)"
            icon="percent"
            :title="t('settings.referral.exampleTitle')"
          >
            <div class="rounded-xl border border-line bg-gradient-to-br from-accent/[0.08] via-transparent to-transparent p-4">
              <div class="flex items-center gap-3">
                <span class="icon-chip icon-chip-accent h-9 w-9"><UiIcon name="user" :size="16" /></span>
                <div class="min-w-0 flex-1">
                  <p class="text-xs text-fg-subtle">{{ t("settings.referral.exampleTopup") }}</p>
                  <p class="font-mono text-lg font-semibold tabular-nums text-fg">$100.00</p>
                </div>
              </div>
              <div class="my-3 ml-[1.125rem] h-5 border-l border-dashed border-line-strong" />
              <div class="flex items-center gap-3">
                <span class="icon-chip icon-chip-success h-9 w-9"><UiIcon name="gift" :size="16" /></span>
                <div class="min-w-0 flex-1">
                  <p class="text-xs text-fg-subtle">{{ t("settings.referral.exampleReward") }}</p>
                  <p class="font-mono text-lg font-semibold tabular-nums text-success">{{ rebateExample }}</p>
                </div>
              </div>
            </div>
            <p class="mt-3 text-xs leading-relaxed text-fg-subtle">
              {{
                !form.affiliateEnabled
                  ? t("settings.referral.noteOff")
                  : form.affiliateCreditMode === "commission_pool"
                    ? t("settings.referral.notePool")
                    : t("settings.referral.noteOn")
              }}
            </p>
          </UiCard>
        </div>
      </Transition>

      <SettingsSaveBar
        :show="dirtyCount > 0"
        :count="dirtyCount"
        :saving="saving"
        :invalid="hasClientErrors"
        @save="save"
        @discard="discard"
      />
    </template>
  </div>
</template>
