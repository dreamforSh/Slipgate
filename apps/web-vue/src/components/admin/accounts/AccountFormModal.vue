<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  allowedSubscriptionTiersForProvider,
  inspectCredential,
  parseCredentialBlock,
  PLATFORM_MULTI_PROTOCOL_CATALOG,
  recommendedMaxConcurrencyForTier,
  resolveTierForPlatform,
  type AccountAuthKind,
  type AccountExitBinding,
  type AccountImportResult,
  type ClashExitNode,
  type AccountInitialStatus,
  type AccountMode,
  type AccountOAuthProvider,
  type AccountStatus,
  type ApiProtocol,
  type CreateAccountRequest,
  type ExchangeAccountOAuthResponse,
  type ExecutionMode,
  type GroupItem,
  type NativeApiProtocol,
  type Provider,
  type StartAccountOAuthResponse,
  type SubscriptionTier,
  type UpdateAccountRequest,
  type UpstreamAccount,
  accountQuotaLimited,
  parseUsdToNano,
} from "@slipgate/contracts";
import PlatformIcon from "../../ui/PlatformIcon.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import type { IconName } from "../../ui/icons";
import AccountFormSection from "./AccountFormSection.vue";
import ExitNodePicker from "./ExitNodePicker.vue";
import ImportResultSummary from "./ImportResultSummary.vue";
import {
  ACCOUNT_STATUSES,
  EXECUTION_MODES,
  dateInputFromNow,
  dateInputToIso,
  datetimeInputToIso,
  isoToDateInput,
  isoToDatetimeInput,
} from "./accountDisplay";
import { PROVIDER_OPTIONS, accountStatusLabel, executionModeLabel, formatUsd } from "../../../lib/format";
import { platformShortLabel, platformStyle } from "../../../lib/platformStyle";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";
import UiSelect from "../../ui/UiSelect.vue";
import { exitAvailability, isStaticExit, modeUsesExit, type ExitAvailability, type ExitPool } from "./exitPool";
import TempUnschedRulesEditor from "./TempUnschedRulesEditor.vue";
import { ruleProblem, sameRules, toEditable, toRule, type EditableRule } from "./tempUnschedRules";

/**
 * Create (single or batch), edit and "duplicate as new" for upstream accounts. Sections follow the
 * sub2api add-account dialog: basic info → platform & account type → credentials → exit proxy →
 * plan & scheduling → validity → group. The group is optional and comes last: it no longer picks
 * the platform, the platform filters the groups instead (same platform or composite).
 */
const props = defineProps<{
  open: boolean;
  /** Account being edited; `null` creates. */
  account: UpstreamAccount | null;
  /** Settings to start from when duplicating (create mode only). */
  template: UpstreamAccount | null;
  groups: GroupItem[];
  /** Group preselected on create (e.g. the list's group filter); `""` = ungrouped. */
  defaultGroupId: string;
  /** id → name, to label duplicate skips in batch results. */
  accountNames: ReadonlyMap<string, string>;
  /** Exit nodes and bindings; the exit is bound through slipgate-net after the account is saved. */
  exitPool: ExitPool;
  /** Edit opened as "re-authorize": scroll to the credentials and explain that they get replaced. */
  reauth?: boolean;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "saved"): void }>();

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

/* ---------------- Account types ---------------- */

type Tone = "orange" | "purple" | "emerald" | "sky" | "fuchsia";
type KindKey =
  | "claude_code"
  | "console"
  | "chatgpt"
  | "antigravity"
  | "gemini_oauth"
  | "qwen_oauth"
  | "xpass_sub"
  | "vm_seed"
  | "api_key";

/** XPass subscriptions call Grok through the Grok CLI proxy (slipgate-net adds the CLI identity there). */
const XPASS_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

interface KindOption {
  key: KindKey;
  title: string;
  desc: string;
  icon: IconName;
  tone: Tone;
  /** Auth kind the option creates (Claude Code switches to setup_token via the add method). */
  authKind: AccountAuthKind;
  mode: ExecutionMode;
}

// Full literal class strings so Tailwind keeps them.
const TONE: Record<Tone, { on: string; off: string; chip: string }> = {
  orange: {
    on: "border-orange-500 bg-orange-50 dark:bg-orange-900/20",
    off: "hover:border-orange-300 dark:hover:border-orange-700",
    chip: "bg-orange-500 text-white",
  },
  purple: {
    on: "border-purple-500 bg-purple-50 dark:bg-purple-900/20",
    off: "hover:border-purple-300 dark:hover:border-purple-700",
    chip: "bg-purple-500 text-white",
  },
  emerald: {
    on: "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20",
    off: "hover:border-emerald-300 dark:hover:border-emerald-700",
    chip: "bg-emerald-500 text-white",
  },
  sky: {
    on: "border-sky-500 bg-sky-50 dark:bg-sky-900/20",
    off: "hover:border-sky-300 dark:hover:border-sky-700",
    chip: "bg-sky-500 text-white",
  },
  fuchsia: {
    on: "border-fuchsia-500 bg-fuchsia-50 dark:bg-fuchsia-900/20",
    off: "hover:border-fuchsia-300 dark:hover:border-fuchsia-700",
    chip: "bg-fuchsia-500 text-white",
  },
};

const kindOptions = computed<KindOption[]>(() => {
  const vmSeed: KindOption = {
    key: "vm_seed",
    title: t("accounts.form.types.vmSeed"),
    desc: t("accounts.form.types.vmSeedDesc"),
    icon: "server",
    tone: "fuchsia",
    authKind: "vm_cli_seed",
    mode: "vm_slot",
  };
  const apiKey = (title: string): KindOption => ({
    key: "api_key",
    title,
    desc: t("accounts.form.types.apiKeyDesc"),
    icon: "key",
    tone: "purple",
    authKind: "api_key",
    mode: "direct_api",
  });
  // Product names stay untranslated.
  switch (formPlatform.value) {
    case "anthropic":
      return [
        { key: "claude_code", title: "Claude Code", desc: "OAuth / Setup Token", icon: "sparkles", tone: "orange", authKind: "oauth", mode: "stealth_http" },
        { ...apiKey("Claude Console"), key: "console" },
        vmSeed,
      ];
    case "codex":
      return [
        { key: "chatgpt", title: "ChatGPT OAuth", desc: t("accounts.form.types.chatgptDesc"), icon: "zap", tone: "emerald", authKind: "oauth", mode: "stealth_http" },
        vmSeed,
      ];
    case "antigravity":
      return [
        { key: "antigravity", title: "Antigravity OAuth", desc: t("accounts.form.types.antigravityDesc"), icon: "globe", tone: "sky", authKind: "oauth", mode: "stealth_http" },
        vmSeed,
      ];
    case "gemini":
      return [
        { key: "gemini_oauth", title: "Gemini CLI OAuth", desc: t("accounts.form.types.antigravityDesc"), icon: "globe", tone: "sky", authKind: "oauth", mode: "stealth_http" },
        apiKey("Gemini API"),
      ];
    case "qwen":
      return [
        { key: "qwen_oauth", title: "Qwen OAuth", desc: t("accounts.form.types.qwenDesc"), icon: "globe", tone: "emerald", authKind: "oauth", mode: "stealth_http" },
        apiKey("Qwen API"),
      ];
    case "grok":
      return [
        { key: "xpass_sub", title: t("accounts.form.types.xpass"), desc: t("accounts.form.types.xpassDesc"), icon: "sparkles", tone: "sky", authKind: "oauth", mode: "stealth_http" },
        apiKey("XPass API"),
      ];
    default:
      return [apiKey(`${platformShortLabel(formPlatform.value)} API`)];
  }
});

/* ---------------- State ---------------- */

const editing = computed(() => props.account);
type FormMode = "single" | "batch";
const mode = ref<FormMode>("single");
const saving = ref(false);
const batchResult = ref<AccountImportResult | null>(null);

const formName = ref("");
const formNotes = ref("");
const formGroupId = ref("");
const formPlatform = ref<Provider>("anthropic");
const formKind = ref<KindKey>("claude_code");
/** Claude Code only: OAuth credential JSON or a long-lived setup token. */
const addMethod = ref<"oauth" | "setup_token">("oauth");
const formMode = ref<ExecutionMode>("stealth_http");
const formTier = ref<SubscriptionTier>("max");
const formSecret = ref("");
const formBaseUrl = ref("");
const formApiKey = ref("");
const formAccountMode = ref<AccountMode>("payg");
const formApiProtocol = ref<ApiProtocol>("adaptive");
const formMaxConc = ref(12);
const formPriority = ref(100);
const formStatus = ref<AccountStatus>("active");
const formInitialStatus = ref<AccountInitialStatus>("active");
const formExpires = ref("");
const formAutoPause = ref(true);
const formCooldownUntil = ref("");
/** Bound exit node (`""` = none) and the uTLS profile carried by the binding (`""` = platform default). */
const formExitNodeId = ref("");
const formUtlsProfileId = ref("");
/** Batch create: give each new account its own free healthy exit. */
const batchAutoExit = ref(true);
/** Temporary-unschedulable rules as edited (status / keywords as text). */
const formRules = ref<EditableRule[]>([]);
const rulesInvalid = computed(() => formRules.value.some((r) => ruleProblem(r) !== null));

/* Spend quota (USD as typed; "" or 0 = no limit). */
type QuotaKey = "daily" | "weekly" | "total";
const QUOTA_KEYS: QuotaKey[] = ["daily", "weekly", "total"];
const QUOTA_USD = /^\$?\d{1,12}(?:\.\d{1,9})?$/;
const formQuota = ref<Record<QuotaKey, string>>({ daily: "", weekly: "", total: "" });
const quotaBad = (key: QuotaKey) => {
  const v = formQuota.value[key].trim();
  return v !== "" && !QUOTA_USD.test(v);
};
const quotaInvalid = computed(() => QUOTA_KEYS.some(quotaBad));
/** nano-USD digits of a typed amount ("0" for empty or invalid). */
function quotaNanoOf(key: QuotaKey): string {
  const v = formQuota.value[key].trim();
  return v && QUOTA_USD.test(v) ? parseUsdToNano(v).toString() : "0";
}
/** nano-USD digits back to a plain USD string for the input ("" = no limit). */
function quotaText(nano: string): string {
  if (nano === "0") return "";
  const n = BigInt(nano);
  const whole = n / 1_000_000_000n;
  const frac = (n % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
const QUOTA_FIELD = {
  daily: "quotaDailyLimitUsd",
  weekly: "quotaWeeklyLimitUsd",
  total: "quotaTotalLimitUsd",
} as const;
const QUOTA_LIMIT = { daily: "dailyLimitNanoUsd", weekly: "weeklyLimitNanoUsd", total: "totalLimitNanoUsd" } as const;
const QUOTA_USED = { daily: "dailyUsedNanoUsd", weekly: "weeklyUsedNanoUsd", total: "totalUsedNanoUsd" } as const;
const quotaCount = computed(() => QUOTA_KEYS.filter((k) => quotaNanoOf(k) !== "0").length);
const batchPrefix = ref("");
const batchText = ref("");
const batchSkipDup = ref(true);

const oauthSession = ref<StartAccountOAuthResponse | null>(null);
const oauthCodeInput = ref("");
const oauthProjectId = ref("");
const oauthStarting = ref(false);
const oauthExchanging = ref(false);

const kind = computed(() => kindOptions.value.find((k) => k.key === formKind.value) ?? kindOptions.value[0]!);
const authKind = computed<AccountAuthKind>(() =>
  kind.value.key === "claude_code" && addMethod.value === "setup_token" ? "setup_token" : kind.value.authKind,
);
const isApiKey = computed(() => authKind.value === "api_key");
/** XPass subscription: a Grok CLI token plus the CLI proxy base URL, stored as JSON. */
const isXPassSub = computed(() => kind.value.key === "xpass_sub");
/** OAuth and VM seeds are pasted as JSON; API keys and setup tokens are single strings. */
const takesJson = computed(() => (authKind.value === "oauth" || authKind.value === "vm_cli_seed") && !isXPassSub.value);
const OAUTH_PLATFORMS: ReadonlySet<string> = new Set(["anthropic", "codex", "antigravity", "gemini", "qwen"]);
const supportsInteractiveOAuth = computed(
  () => (authKind.value === "oauth" || authKind.value === "setup_token") && OAUTH_PLATFORMS.has(formPlatform.value),
);

watch([formPlatform, formKind, addMethod], () => {
  oauthSession.value = null;
  oauthCodeInput.value = "";
});

async function startInteractiveOAuth() {
  if (!supportsInteractiveOAuth.value || oauthStarting.value) return;
  oauthStarting.value = true;
  try {
    const res = await auth.apiFetch("/api/v1/admin/accounts/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: formPlatform.value as AccountOAuthProvider,
        addMethod: authKind.value === "setup_token" ? "setup_token" : "oauth",
        ...(oauthProjectId.value.trim() ? { projectId: oauthProjectId.value.trim() } : {}),
      }),
    });
    if (!res.ok) {
      toast.error(await readError(res, t("accounts.form.oauth.startFailed")));
      return;
    }
    oauthSession.value = (await res.json()) as StartAccountOAuthResponse;
    oauthCodeInput.value = "";
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("accounts.form.oauth.startFailed"));
  } finally {
    oauthStarting.value = false;
  }
}

async function copyAuthorizeUrl() {
  if (!oauthSession.value?.authorizeUrl) return;
  try {
    await navigator.clipboard.writeText(oauthSession.value.authorizeUrl);
    toast.success(t("accounts.form.oauth.copied"));
  } catch {
    // Fallback ignored if clipboard permission denied.
  }
}

async function exchangeInteractiveOAuth() {
  if (!oauthSession.value || !oauthCodeInput.value.trim() || oauthExchanging.value) return;
  oauthExchanging.value = true;
  try {
    const res = await auth.apiFetch("/api/v1/admin/accounts/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: oauthSession.value.sessionId,
        codeInput: oauthCodeInput.value.trim(),
      }),
    });
    if (!res.ok) {
      toast.error(await readError(res, t("accounts.form.oauth.exchangeFailed")));
      return;
    }
    const data = (await res.json()) as ExchangeAccountOAuthResponse;
    formSecret.value = data.credentialSecret;
    if (!editing.value && !formName.value.trim() && data.email) {
      formName.value = data.email.slice(0, 64);
    }
    if (!editing.value && data.subscriptionTier !== "standard" && tierOptions.value.some((o) => o.tier === data.subscriptionTier)) {
      formTier.value = data.subscriptionTier;
      onTierChange();
    }
    oauthSession.value = null;
    oauthCodeInput.value = "";
    toast.success(t("accounts.form.oauth.authorized"));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("accounts.form.oauth.exchangeFailed"));
  } finally {
    oauthExchanging.value = false;
  }
}

const title = computed(() => {
  if (editing.value) return t("accounts.form.editTitle");
  return props.template ? t("accounts.form.copyTitle") : t("accounts.form.createTitle");
});

const modeOptions = computed(() => [
  { value: "single" as const, label: t("accounts.form.modeSingle") },
  { value: "batch" as const, label: t("accounts.form.modeBatch") },
]);

// Standard stays selectable: imported subscriptions with an unknown plan must not be upgraded on save.
const tierOptions = computed(() => allowedSubscriptionTiersForProvider(formPlatform.value));

/* ---------------- Group (optional, filtered by platform) ---------------- */

const selectedGroup = computed(() => props.groups.find((g) => g.id === formGroupId.value) ?? null);
/** Single-platform groups of the chosen platform; the current group stays listed even if it no longer fits. */
const platformGroups = computed(() =>
  props.groups.filter((g) => g.platform !== "composite" && (g.platform === formPlatform.value || g.id === formGroupId.value)),
);
/** Composite groups draw on every platform. */
const compositeGroups = computed(() => props.groups.filter((g) => g.platform === "composite"));

function groupFits(g: GroupItem, platform: Provider): boolean {
  return g.platform === "composite" || g.platform === platform;
}

function groupLabel(g: GroupItem): string {
  return g.enabled ? g.name : t("accounts.form.groupDisabled", { name: g.name });
}

/** The platform is fixed once the account exists. */
const platformLocked = computed(() => !!editing.value);

const multiProtoSpec = computed(() => PLATFORM_MULTI_PROTOCOL_CATALOG[formPlatform.value] ?? null);
const accountModeOptions = computed(() => multiProtoSpec.value?.modes ?? []);
const selectedModeSpec = computed(() => {
  const spec = multiProtoSpec.value;
  if (!spec) return null;
  return spec.modes.find((m) => m.mode === formAccountMode.value) ?? spec.modes[0] ?? null;
});
const supportedNativeProtocols = computed<NativeApiProtocol[]>(() => {
  const urls = selectedModeSpec.value?.baseUrls;
  if (!urls) return [];
  return (["chat_completions", "anthropic", "responses"] as const).filter((p) => Boolean(urls[p]));
});
const apiProtocolOptions = computed<ApiProtocol[]>(() => {
  const native = supportedNativeProtocols.value;
  if (native.length <= 1) return native;
  return ["adaptive", ...native];
});
const baseUrlPlaceholder = computed(() => {
  const urls = selectedModeSpec.value?.baseUrls;
  if (urls) {
    if (formApiProtocol.value !== "adaptive" && urls[formApiProtocol.value]) {
      return urls[formApiProtocol.value]!;
    }
    return urls.chat_completions ?? urls.anthropic ?? urls.responses ?? "https://";
  }
  if (formPlatform.value === "typesafe") return "https://api.typesafe.ai";
  return "https://";
});

function syncMultiProtoDefaults() {
  const spec = multiProtoSpec.value;
  if (!spec) {
    formAccountMode.value = "payg";
    formApiProtocol.value = "adaptive";
    return;
  }
  formAccountMode.value = spec.defaultMode;
  const native = supportedNativeProtocols.value;
  formApiProtocol.value = native.length > 1 ? "adaptive" : (native[0] ?? "chat_completions");
}

function defaultTierFor(platform: Provider): SubscriptionTier {
  if (platform === "anthropic") return "max";
  if (platform === "codex" || platform === "openai") return "pro_5x";
  if (platform === "antigravity") return "pro";
  if (platform === "grok") return "plus";
  return "standard";
}

function xpassSecret(token: string): string {
  const base = (formBaseUrl.value.trim() || XPASS_CLI_BASE_URL).replace(/\/+$/, "");
  return JSON.stringify({ api_key: token.trim(), base_url: base });
}

function applyKind(key: KindKey) {
  formKind.value = key;
  formMode.value = kind.value.mode;
  if (!tierOptions.value.some((o) => o.tier === formTier.value)) formTier.value = defaultTierFor(formPlatform.value);
  formMaxConc.value = recommendedMaxConcurrencyForTier(formPlatform.value, isApiKey.value ? "standard" : formTier.value);
}

function setPlatform(platform: Provider) {
  formPlatform.value = platform;
  syncMultiProtoDefaults();
  applyKind(kindOptions.value[0]!.key);
  // A single-platform group of another platform cannot hold the account: fall back to ungrouped.
  if (selectedGroup.value && !groupFits(selectedGroup.value, platform)) formGroupId.value = "";
}

/** Picker clicks; ignored while editing (the platform is fixed at creation). */
function selectPlatform(platform: Provider) {
  if (!platformLocked.value) setPlatform(platform);
}

function onTierChange() {
  formMaxConc.value = recommendedMaxConcurrencyForTier(formPlatform.value, formTier.value);
}

/* ---------------- Credential helpers ---------------- */

/** `baseUrl|key` for simple relays; JSON with account_mode / api_protocol when configured on multi-protocol providers. */
function apiKeySecret(key: string): string {
  const base = formBaseUrl.value.trim().replace(/\/+$/, "");
  const trimmedKey = key.trim();
  const spec = multiProtoSpec.value;
  if (spec && (accountModeOptions.value.length > 1 || apiProtocolOptions.value.length > 1)) {
    const needsMeta =
      formAccountMode.value !== spec.defaultMode ||
      formApiProtocol.value !== "adaptive";
    if (needsMeta || (base && formApiProtocol.value === "adaptive")) {
      return JSON.stringify({
        api_key: trimmedKey,
        ...(base ? { base_url: base } : {}),
        account_mode: formAccountMode.value,
        api_protocol: formApiProtocol.value,
      });
    }
  }
  return base ? `${base}|${trimmedKey}` : trimmedKey;
}

const insight = computed(() => (takesJson.value && mode.value === "single" ? inspectCredential(formSecret.value) : null));

const insightSummary = computed(() => {
  const i = insight.value;
  if (!i) return "";
  const source = { cpa: `CPA · ${i.cpaType}`, claude_code: ".claude/.credentials.json", codex_cli: ".codex/auth.json", json: "JSON" }[i.source];
  const tier = i.tierHint && i.platform ? resolveTierForPlatform(i.platform, i.tierHint) : null;
  return [source, i.email, tier && tier !== "standard" ? tier : ""].filter(Boolean).join(" · ");
});

const platformMismatch = computed(() => {
  const p = insight.value?.platform;
  return p && p !== formPlatform.value ? PROVIDER_OPTIONS.find((o) => o.value === p)?.label ?? p : "";
});

// Fill what the credential tells (create mode only, never over a name the admin typed). Re-runs
// when the platform changes so a credential pasted before picking the platform still sets the plan.
watch([insight, formPlatform], ([i]) => {
  if (!i || editing.value) return;
  if (!formName.value.trim() && i.email) formName.value = (i.cpaType ? `${i.cpaType}-${i.email}` : i.email).slice(0, 64);
  if (i.tierHint && i.platform === formPlatform.value) {
    const tier = resolveTierForPlatform(formPlatform.value, i.tierHint);
    if (tier !== "standard" && tier !== formTier.value) {
      formTier.value = tier;
      onTierChange();
    }
  }
});

async function loadCredentialFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 1024 * 1024) {
    toast.error(t("accounts.form.fileTooLarge"));
    return;
  }
  formSecret.value = (await file.text()).trim();
}

/* ---------------- Init ---------------- */

function kindFor(src: UpstreamAccount): KindKey {
  if (src.authKind === "vm_cli_seed") return "vm_seed";
  if (src.authKind === "api_key") return src.platform === "anthropic" ? "console" : "api_key";
  if (src.platform === "codex") return "chatgpt";
  if (src.platform === "antigravity") return "antigravity";
  if (src.platform === "gemini") return "gemini_oauth";
  if (src.platform === "qwen") return "qwen_oauth";
  if (src.platform === "grok") return "xpass_sub";
  if (src.platform === "anthropic") return "claude_code";
  return "api_key";
}

function loadFrom(src: UpstreamAccount, asCopy: boolean) {
  formName.value = asCopy ? `${src.name}-copy`.slice(0, 64) : src.name;
  formNotes.value = src.notes;
  formGroupId.value = src.groupId;
  formPlatform.value = src.platform;
  syncMultiProtoDefaults();
  formKind.value = kindFor(src);
  addMethod.value = src.authKind === "setup_token" ? "setup_token" : "oauth";
  formMode.value = src.executionMode;
  formTier.value = src.subscriptionTier === "standard" ? defaultTierFor(src.platform) : src.subscriptionTier;
  formMaxConc.value = src.maxConcurrency;
  formPriority.value = src.priority;
  formStatus.value = src.status;
  formExpires.value = isoToDateInput(src.expiresAtIso);
  formAutoPause.value = src.autoPauseOnExpired;
  formCooldownUntil.value = isoToDatetimeInput(src.cooldownUntilIso);
  formRules.value = src.tempUnschedRules.map(toEditable);
  formQuota.value = {
    daily: quotaText(src.quota.dailyLimitNanoUsd),
    weekly: quotaText(src.quota.weeklyLimitNanoUsd),
    total: quotaText(src.quota.totalLimitNanoUsd),
  };
}

function reset() {
  mode.value = "single";
  batchResult.value = null;
  formSecret.value = "";
  formApiKey.value = "";
  formBaseUrl.value = "";
  batchText.value = "";
  batchPrefix.value = "";
  batchSkipDup.value = true;
  oauthSession.value = null;
  oauthCodeInput.value = "";
  oauthProjectId.value = "";
  formInitialStatus.value = "active";
  batchAutoExit.value = true;
  if (props.account) {
    loadFrom(props.account, false);
    const bound = props.exitPool.bindingByAccount.get(props.account.id) ?? null;
    formExitNodeId.value = bound?.nodeId ?? "";
    formUtlsProfileId.value = bound?.utlsProfileId ?? "";
    return;
  }
  // An exit IP serves one account, so a duplicate never inherits the original's exit.
  formExitNodeId.value = "";
  formUtlsProfileId.value = "";
  if (props.template) {
    loadFrom(props.template, true);
    formStatus.value = "active";
    return;
  }
  formName.value = "";
  formNotes.value = "";
  // No group unless the list is filtered by one; a single-platform preset also picks the platform.
  const preset = props.groups.find((g) => g.id === props.defaultGroupId) ?? null;
  formGroupId.value = preset?.id ?? "";
  formPriority.value = 100;
  formStatus.value = "active";
  formExpires.value = "";
  formAutoPause.value = true;
  formCooldownUntil.value = "";
  formRules.value = [];
  formQuota.value = { daily: "", weekly: "", total: "" };
  addMethod.value = "oauth";
  formPlatform.value = preset && preset.platform !== "composite" ? preset.platform : "anthropic";
  syncMultiProtoDefaults();
  formTier.value = defaultTierFor(formPlatform.value);
  applyKind(kindOptions.value[0]!.key);
}

watch(
  () => [props.open, props.account?.id, props.template?.id] as const,
  ([open]) => {
    if (!open) return;
    reset();
    // Re-authorize: bring the credentials (OAuth panel) into view once the modal has laid out.
    if (props.reauth && props.account) {
      void nextTick(() =>
        window.setTimeout(
          () => document.getElementById("account-form-credentials")?.scrollIntoView({ block: "start" }),
          220,
        ),
      );
    }
  },
  { immediate: true },
);

/* ---------------- Batch ---------------- */

const batchBlock = computed(() => parseCredentialBlock(batchText.value));
const batchCredentials = computed(() =>
  batchBlock.value.credentials.map((c) => {
    if (isApiKey.value) return c.startsWith("{") ? c : apiKeySecret(c);
    if (isXPassSub.value) return c.startsWith("{") ? c : xpassSecret(c);
    return takesJson.value ? inspectCredential(c)?.credentialSecret ?? c : c;
  }),
);
const batchPad = computed(() => Math.max(2, String(batchCredentials.value.length).length));
function batchName(i: number) {
  return `${batchPrefix.value.trim()}-${String(i + 1).padStart(batchPad.value, "0")}`.slice(0, 64);
}
const batchExample = computed(() => {
  const n = Math.max(1, batchCredentials.value.length);
  if (n <= 3) return Array.from({ length: n }, (_, i) => batchName(i)).join(", ");
  return `${batchName(0)}, ${batchName(1)} … ${batchName(n - 1)}`;
});

/* ---------------- Exit proxy ---------------- */

const currentBinding = computed(() => (editing.value ? props.exitPool.bindingByAccount.get(editing.value.id) ?? null : null));
/** The pool cannot bind for real: no slipgate-net, or the overview did not load. */
const exitPickerDisabled = computed(() => props.exitPool.standalone || props.exitPool.failed);
const exitNeeded = computed(() => modeUsesExit(formMode.value));

interface ExitOption {
  nodeId: string;
  label: string;
  availability: ExitAvailability;
}

function exitOption(node: ClashExitNode): ExitOption {
  const availability = exitAvailability(node, currentBinding.value);
  const parts = [node.name, node.exitIp || t("accounts.form.exit.unprobed")];
  if (node.exitIp && node.latencyMs > 0) parts.push(`${node.latencyMs} ms`);
  const label = parts.join(" · ");
  return {
    nodeId: node.nodeId,
    availability,
    // An unprobed exit already reads "not probed" in place of its IP; other reasons are appended.
    label:
      availability === "ok" || availability === "unprobed"
        ? label
        : `${label}（${t(`accounts.form.exit.reasons.${availability}`)}）`,
  };
}

/** Free healthy exits first, fastest first; unavailable ones stay listed (disabled) with the reason. */
function exitOptions(list: ClashExitNode[]): ExitOption[] {
  return list
    .map(exitOption)
    .sort((a, b) => {
      const rank = (o: ExitOption) => (o.availability === "ok" ? 0 : 1);
      const na = props.exitPool.nodeById.get(a.nodeId)!;
      const nb = props.exitPool.nodeById.get(b.nodeId)!;
      return rank(a) - rank(b) || (na.latencyMs || 1e9) - (nb.latencyMs || 1e9);
    });
}

const clashExitOptions = computed(() => exitOptions(props.exitPool.clashNodes));
const staticExitOptions = computed(() => exitOptions(props.exitPool.staticNodes));
const freeExitCount = computed(
  () => [...clashExitOptions.value, ...staticExitOptions.value].filter((o) => o.availability === "ok").length,
);

watch(formExitNodeId, (nodeId) => {
  if (!nodeId) formUtlsProfileId.value = "";
});

/** Bind / move / clear the account's exit when the form differs from the stored binding. */
async function applyExit(accountId: string, current: AccountExitBinding | null): Promise<void> {
  if (exitPickerDisabled.value) return;
  const nodeId = formExitNodeId.value;
  if (!nodeId) {
    if (!current) return;
    const err = await props.exitPool.unbind(accountId);
    if (err) toast.warning(t("accounts.form.exit.unbindFailed", { message: err }));
    return;
  }
  if (current && current.nodeId === nodeId && (current.utlsProfileId ?? "") === formUtlsProfileId.value) return;
  const err = await props.exitPool.bind(accountId, nodeId, formUtlsProfileId.value);
  if (err) toast.warning(t("accounts.form.exit.bindFailed", { message: err }));
}

/** After a batch create: one free healthy exit per new account, in list order. */
async function autoAssignExits(accountIds: string[]): Promise<void> {
  const free = [...clashExitOptions.value, ...staticExitOptions.value]
    .filter((o) => o.availability === "ok")
    .map((o) => o.nodeId);
  let bound = 0;
  for (const accountId of accountIds) {
    const nodeId = free.shift();
    if (!nodeId) break;
    if (!(await props.exitPool.bind(accountId, nodeId, ""))) bound += 1;
  }
  if (bound > 0) toast.info(t("accounts.form.exit.batchAssigned", { n: bound }));
  if (bound < accountIds.length) toast.warning(t("accounts.form.exit.batchShort", { n: accountIds.length - bound }));
}

/* ---------------- Submit ---------------- */

const expiresIso = computed(() => (formExpires.value ? dateInputToIso(formExpires.value) : null));
/** API keys carry no plan: always stored as standard so the scheduler weighs them 1x. */
const effectiveTier = computed<SubscriptionTier>(() => (isApiKey.value ? "standard" : formTier.value));

const singleSecret = computed(() => {
  if (isApiKey.value) return formApiKey.value.trim() ? apiKeySecret(formApiKey.value) : "";
  if (isXPassSub.value) return formApiKey.value.trim() ? xpassSecret(formApiKey.value) : "";
  if (takesJson.value) return insight.value?.credentialSecret ?? formSecret.value.trim();
  return formSecret.value.trim();
});

function baseFields() {
  return {
    notes: formNotes.value.trim(),
    groupId: formGroupId.value,
    platform: formPlatform.value,
    executionMode: formMode.value,
    authKind: authKind.value,
    subscriptionTier: effectiveTier.value,
    maxConcurrency: formMaxConc.value,
    priority: formPriority.value,
    status: formInitialStatus.value,
    expiresAtIso: expiresIso.value,
    autoPauseOnExpired: formAutoPause.value,
    tempUnschedRules: formRules.value.map(toRule),
    ...Object.fromEntries(
      QUOTA_KEYS.filter((k) => quotaNanoOf(k) !== "0").map((k) => [QUOTA_FIELD[k], formQuota.value[k].trim()]),
    ),
  };
}

function buildPatch(acc: UpstreamAccount): UpdateAccountRequest {
  const patch: UpdateAccountRequest = {};
  const name = formName.value.trim();
  const notes = formNotes.value.trim();
  if (name !== acc.name) patch.name = name;
  if (notes !== acc.notes) patch.notes = notes;
  if (formGroupId.value !== acc.groupId) patch.groupId = formGroupId.value;
  if (formMode.value !== acc.executionMode) patch.executionMode = formMode.value;
  if (authKind.value !== acc.authKind) patch.authKind = authKind.value;
  if (effectiveTier.value !== acc.subscriptionTier) patch.subscriptionTier = effectiveTier.value;
  if (formMaxConc.value !== acc.maxConcurrency) patch.maxConcurrency = formMaxConc.value;
  if (formPriority.value !== acc.priority) patch.priority = formPriority.value;
  // Compare by calendar day so re-saving keeps the stored time of day.
  if (formExpires.value !== isoToDateInput(acc.expiresAtIso)) patch.expiresAtIso = expiresIso.value;
  if (formAutoPause.value !== acc.autoPauseOnExpired) patch.autoPauseOnExpired = formAutoPause.value;
  const untilChanged = formCooldownUntil.value !== isoToDatetimeInput(acc.cooldownUntilIso);
  if (formStatus.value !== acc.status) {
    patch.status = formStatus.value;
    // The server resets the deadline on a status change unless one is sent along, so
    // switching to cooldown carries the form's deadline (empty = until resumed).
    if (formStatus.value === "cooldown" || (untilChanged && formCooldownUntil.value)) {
      patch.cooldownUntilIso = datetimeInputToIso(formCooldownUntil.value);
    }
  } else if (untilChanged) {
    patch.cooldownUntilIso = datetimeInputToIso(formCooldownUntil.value);
  }
  const rules = formRules.value.map(toRule);
  if (!sameRules(rules, acc.tempUnschedRules)) patch.tempUnschedRules = rules;
  for (const k of QUOTA_KEYS) {
    if (quotaNanoOf(k) !== acc.quota[QUOTA_LIMIT[k]]) patch[QUOTA_FIELD[k]] = formQuota.value[k].trim() || "0";
  }
  if (singleSecret.value) patch.credentialSecret = singleSecret.value;
  return patch;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { message?: string; issues?: { message: string }[] };
  return data.message ?? data.issues?.[0]?.message ?? fallback;
}

async function submitEdit(acc: UpstreamAccount) {
  const patch = buildPatch(acc);
  const current = currentBinding.value;
  const exitChanged =
    !exitPickerDisabled.value &&
    (formExitNodeId.value !== (current?.nodeId ?? "") ||
      (!!formExitNodeId.value && formUtlsProfileId.value !== (current?.utlsProfileId ?? "")));
  if (Object.keys(patch).length === 0 && !exitChanged) {
    emit("update:open", false);
    return;
  }
  if (Object.keys(patch).length > 0) {
    const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      toast.error(await readError(res, t("accounts.errors.updateAccount")));
      return;
    }
  }
  if (exitChanged) await applyExit(acc.id, current);
  toast.success(t("accounts.toast.updated"));
  emit("saved");
  emit("update:open", false);
}

async function submitSingle() {
  const body: CreateAccountRequest = { ...baseFields(), name: formName.value.trim(), credentialSecret: singleSecret.value };
  const res = await auth.apiFetch("/api/v1/admin/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    toast.error(await readError(res, t("accounts.errors.createAccount")));
    return;
  }
  const { account } = (await res.json()) as { account: UpstreamAccount };
  // The account exists either way; a failed binding only warns (it can be bound later).
  if (account?.id) await applyExit(account.id, null);
  toast.success(t("accounts.toast.created"));
  emit("saved");
  emit("update:open", false);
}

async function submitBatch() {
  const base = baseFields();
  const items = batchCredentials.value.map((credentialSecret, i) => ({ ...base, name: batchName(i), credentialSecret }));
  const merged: AccountImportResult = { created: 0, skipped: 0, failed: 0, results: [] };
  // The endpoint takes at most 1000 items per call.
  for (let offset = 0; offset < items.length; offset += 1000) {
    const res = await auth.apiFetch("/api/v1/admin/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts: items.slice(offset, offset + 1000), skipExisting: batchSkipDup.value }),
    });
    if (!res.ok) {
      toast.error(await readError(res, t("accounts.errors.createAccount")));
      break;
    }
    const part = (await res.json()) as AccountImportResult;
    merged.created += part.created;
    merged.skipped += part.skipped;
    merged.failed += part.failed;
    merged.results.push(
      ...part.results.map((r) => ({
        ...r,
        index: r.index + offset,
        duplicateOfIndex: r.duplicateOfIndex === undefined ? undefined : r.duplicateOfIndex + offset,
      })),
    );
  }
  if (merged.results.length === 0) return;
  const createdIds = merged.results.flatMap((r) => (r.outcome === "created" && r.accountId ? [r.accountId] : []));
  if (batchAutoExit.value && exitNeeded.value && !exitPickerDisabled.value && createdIds.length) {
    await autoAssignExits(createdIds);
  }
  batchResult.value = merged;
  if (merged.created > 0) emit("saved");
  if (merged.failed === 0 && merged.skipped === 0) {
    toast.success(t("accounts.importResult.created", { n: merged.created }));
    emit("update:open", false);
  }
}

const canSubmit = computed(() => {
  // The group is optional: an empty one creates (or moves to) an ungrouped account.
  if (saving.value || rulesInvalid.value || quotaInvalid.value) return false;
  // Switching the account type needs the matching credential; otherwise it may stay as stored.
  if (editing.value) return formName.value.trim().length > 0 && (authKind.value === editing.value.authKind || singleSecret.value.length > 0);
  if (mode.value === "batch") {
    return batchPrefix.value.trim().length > 0 && batchCredentials.value.length > 0 && !batchBlock.value.invalidJson;
  }
  return formName.value.trim().length > 0 && singleSecret.value.length > 0;
});

const submitLabel = computed(() => {
  if (editing.value) return t("accounts.actions.saveAccount");
  return mode.value === "batch"
    ? t("accounts.form.submitBatch", { count: batchCredentials.value.length })
    : t("accounts.form.submitCreate");
});

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    const acc = editing.value;
    if (acc) await submitEdit(acc);
    else if (mode.value === "batch") await submitBatch();
    else await submitSingle();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("common.requestFailed"));
  } finally {
    saving.value = false;
  }
}

function setExpiryPreset(days: number | null) {
  formExpires.value = days === null ? "" : dateInputFromNow(days);
}

const credentialPlaceholder = computed(() => {
  if (authKind.value === "vm_cli_seed") return t("accounts.form.vmSeedPlaceholder");
  if (formPlatform.value === "codex") return '{"tokens": {"access_token": "...", "refresh_token": "...", "account_id": "..."}}';
  if (formPlatform.value === "antigravity") return '{"access_token": "ya29...", "refresh_token": "1//...", "project_id": "..."}';
  return '{"claudeAiOauth": {"accessToken": "sk-ant-oat01-...", "refreshToken": "sk-ant-ort01-..."}}';
});
</script>

<template>
  <UiModal :open="open" :title="title" width="lg" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon :name="editing ? 'pencil' : 'plus'" :size="16" /></span>
    </template>

    <form id="account-form" class="space-y-7" @submit.prevent="submit">
      <UiAlert v-if="template && !editing" tone="info">{{ t("accounts.form.copyHint") }}</UiAlert>

      <SegmentedControl v-if="!editing && !template" v-model="mode" :options="modeOptions" block size="md" />

      <!-- 1. Basic info -->
      <AccountFormSection :title="t('accounts.form.sections.basic')" icon="pencil">
        <div v-if="editing || mode === 'single'">
          <label class="label" for="account-form-name">{{ t("accounts.form.name") }} <span class="text-danger">*</span></label>
          <input
            id="account-form-name"
            v-model="formName"
            type="text"
            required
            maxlength="64"
            :placeholder="t('accounts.form.namePlaceholder')"
            class="input"
          />
        </div>
        <div v-else>
          <label class="label" for="account-form-prefix">{{ t("accounts.form.batchPrefix") }} <span class="text-danger">*</span></label>
          <input id="account-form-prefix" v-model="batchPrefix" type="text" required maxlength="56" placeholder="claude-pool" class="input" />
          <p v-if="batchPrefix.trim()" class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.form.batchPrefixHint", { example: batchExample }) }}</p>
        </div>
        <div>
          <label class="label" for="account-form-notes">{{ t("accounts.form.notes") }}</label>
          <textarea
            id="account-form-notes"
            v-model="formNotes"
            rows="2"
            maxlength="500"
            :placeholder="t('accounts.form.notesPlaceholder')"
            class="textarea"
          />
          <p class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.form.notesHint") }}</p>
        </div>
      </AccountFormSection>

      <!-- 2. Platform & account type (the platform is fixed once the account exists) -->
      <AccountFormSection :title="t('accounts.form.sections.platform')" icon="box">
        <div v-if="!platformLocked">
          <p class="label">{{ t("accounts.form.platform") }}</p>
          <div class="flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" :aria-label="t('accounts.form.platform')">
            <button
              v-for="p in PROVIDER_OPTIONS"
              :key="p.value"
              type="button"
              role="radio"
              :aria-checked="formPlatform === p.value"
              :title="p.label"
              class="flex min-w-[6.5rem] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 py-2 text-sm font-medium transition-all"
              :class="formPlatform === p.value ? ['bg-surface shadow-sm', platformStyle(p.value).text] : 'text-fg-muted hover:text-fg'"
              @click="selectPlatform(p.value)"
            >
              <PlatformIcon :platform="p.value" :size="14" />
              {{ platformShortLabel(p.value) }}
            </button>
          </div>
        </div>
        <div v-else>
          <p class="label">{{ t("accounts.form.platform") }}</p>
          <div class="flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2" :class="platformStyle(formPlatform).text">
            <PlatformIcon :platform="formPlatform" :size="14" />
            <span class="text-sm font-medium">{{ platformShortLabel(formPlatform) }}</span>
            <span class="ml-auto inline-flex items-center gap-1 text-2xs text-fg-subtle">
              <UiIcon name="lock" :size="11" />
              {{ t("accounts.form.platformFixed") }}
            </span>
          </div>
        </div>

        <div>
          <p class="label">{{ t("accounts.form.accountType") }}</p>
          <div class="grid gap-3" :class="kindOptions.length >= 3 ? 'grid-cols-1 sm:grid-cols-3' : kindOptions.length === 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'">
            <button
              v-for="k in kindOptions"
              :key="k.key"
              type="button"
              class="flex cursor-pointer items-center gap-3 rounded-lg border-2 p-3 text-left transition-all"
              :class="formKind === k.key ? TONE[k.tone].on : ['border-line', TONE[k.tone].off]"
              :aria-pressed="formKind === k.key"
              @click="applyKind(k.key)"
            >
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                :class="formKind === k.key ? TONE[k.tone].chip : 'bg-surface-2 text-fg-muted'"
              >
                <UiIcon :name="k.icon" :size="15" />
              </span>
              <span class="min-w-0">
                <span class="block truncate text-sm font-medium text-fg">{{ k.title }}</span>
                <span class="block truncate text-xs text-fg-muted">{{ k.desc }}</span>
              </span>
            </button>
          </div>
        </div>

        <!-- Add method (Claude Code) -->
        <div v-if="kind.key === 'claude_code'">
          <p class="label">{{ t("accounts.form.addMethod") }}</p>
          <div class="flex flex-wrap gap-4">
            <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
              <input v-model="addMethod" type="radio" value="oauth" class="radio" />
              {{ t("accounts.form.addMethodOauth") }}
            </label>
            <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
              <input v-model="addMethod" type="radio" value="setup_token" class="radio" />
              {{ t("accounts.form.addMethodSetupToken") }}
            </label>
          </div>
        </div>
      </AccountFormSection>

      <!-- 3. Credentials -->
      <AccountFormSection id="account-form-credentials" class="scroll-mt-4" :title="t('accounts.form.sections.credentials')" icon="key">
        <UiAlert v-if="reauth && editing" tone="info">{{ t("accounts.form.reauthNotice") }}</UiAlert>
        <!-- Credentials: single -->
        <template v-if="editing || mode === 'single'">
          <div
            v-if="supportsInteractiveOAuth"
            class="space-y-3 rounded-xl border border-accent/25 bg-accent/[0.04] p-3.5"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="min-w-0">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-fg">
                  <UiIcon name="link" :size="13" class="text-accent" />
                  {{ t("accounts.form.oauth.title") }}
                </p>
                <p class="mt-0.5 text-2xs text-fg-subtle">{{ t("accounts.form.oauth.hint") }}</p>
              </div>
              <button
                type="button"
                class="btn btn-secondary btn-xs shrink-0"
                :disabled="oauthStarting"
                @click="startInteractiveOAuth"
              >
                <UiIcon :name="oauthStarting ? 'loader' : 'external-link'" :size="12" :spin="oauthStarting" />
                {{ oauthSession ? t("accounts.form.oauth.regenerateLink") : t("accounts.form.oauth.generateLink") }}
              </button>
            </div>

            <div v-if="formPlatform === 'antigravity' || formPlatform === 'gemini'">
              <label class="label text-2xs" for="account-form-oauth-project">{{ t("accounts.form.oauth.projectId") }}</label>
              <input
                id="account-form-oauth-project"
                v-model="oauthProjectId"
                type="text"
                maxlength="128"
                :placeholder="t('accounts.form.oauth.projectIdPlaceholder')"
                class="input input-sm font-mono text-xs"
              />
            </div>

            <div v-if="oauthSession" class="space-y-2.5 border-t border-line/60 pt-2.5">
              <div>
                <span class="mb-1 block text-2xs font-medium text-fg-subtle">{{ t("accounts.form.oauth.authorizeUrl") }}</span>
                <div class="flex items-center gap-1.5">
                  <input
                    :value="oauthSession.authorizeUrl"
                    type="text"
                    readonly
                    class="input input-sm min-w-0 flex-1 font-mono text-2xs"
                    @focus="($event.target as HTMLInputElement).select()"
                  />
                  <button type="button" class="btn btn-secondary btn-xs shrink-0" @click="copyAuthorizeUrl">
                    <UiIcon name="copy" :size="12" />
                  </button>
                  <a
                    :href="oauthSession.authorizeUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="btn btn-primary btn-xs shrink-0"
                  >
                    <UiIcon name="external-link" :size="12" />
                    {{ t("accounts.form.oauth.openBrowser") }}
                  </a>
                </div>
                <p v-if="oauthSession.instructions" class="mt-1 text-2xs text-fg-subtle">{{ oauthSession.instructions }}</p>
              </div>

              <div>
                <label class="mb-1 block text-2xs font-medium text-fg-subtle" for="account-form-oauth-code">
                  {{ t("accounts.form.oauth.codeInput") }}
                </label>
                <div class="flex items-center gap-1.5">
                  <input
                    id="account-form-oauth-code"
                    v-model="oauthCodeInput"
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    :placeholder="t('accounts.form.oauth.codePlaceholder')"
                    class="input input-sm min-w-0 flex-1 font-mono text-xs"
                  />
                  <button
                    type="button"
                    class="btn btn-primary btn-xs shrink-0"
                    :disabled="!oauthCodeInput.trim() || oauthExchanging"
                    @click="exchangeInteractiveOAuth"
                  >
                    <UiIcon :name="oauthExchanging ? 'loader' : 'check'" :size="12" :spin="oauthExchanging" />
                    {{ t("accounts.form.oauth.exchange") }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-if="isApiKey" class="space-y-4">
            <UiAlert v-if="formPlatform === 'typesafe'" tone="info">{{ t("accounts.form.typesafeHint") }}</UiAlert>
            <div
              v-if="accountModeOptions.length > 1 || apiProtocolOptions.length > 1"
              class="grid gap-4"
              :class="accountModeOptions.length > 1 && apiProtocolOptions.length > 1 ? 'sm:grid-cols-2' : ''"
            >
              <div v-if="accountModeOptions.length > 1">
                <label class="label" for="account-form-acct-mode">{{ t("accounts.form.accountMode") }}</label>
                <UiSelect id="account-form-acct-mode" v-model="formAccountMode" class="select">
                  <option v-for="m in accountModeOptions" :key="m.mode" :value="m.mode">
                    {{ t(`accounts.form.accountModes.${m.mode}`) }}
                  </option>
                </UiSelect>
              </div>
              <div v-if="apiProtocolOptions.length > 1">
                <label class="label" for="account-form-api-proto">{{ t("accounts.form.apiProtocol") }}</label>
                <UiSelect id="account-form-api-proto" v-model="formApiProtocol" class="select">
                  <option v-for="p in apiProtocolOptions" :key="p" :value="p">
                    {{ t(`accounts.form.apiProtocols.${p}`) }}
                  </option>
                </UiSelect>
              </div>
            </div>
            <div>
              <label class="label" for="account-form-base-url">{{ t("accounts.form.baseUrl") }}</label>
              <input
                id="account-form-base-url"
                v-model="formBaseUrl"
                type="url"
                spellcheck="false"
                autocomplete="off"
                :placeholder="baseUrlPlaceholder"
                class="input font-mono text-xs"
              />
              <p class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.form.baseUrlHint") }}</p>
            </div>
            <div>
              <label class="label flex items-center justify-between gap-3" for="account-form-api-key">
                <span>{{ t("accounts.form.apiKey") }} <span v-if="!editing" class="text-danger">*</span></span>
                <span v-if="editing" class="truncate font-mono font-normal text-fg-muted">
                  {{ t("accounts.form.credentialsCurrent", { preview: editing.credentialPreview }) }}
                </span>
              </label>
              <input
                id="account-form-api-key"
                v-model="formApiKey"
                type="password"
                :required="!editing"
                autocomplete="new-password"
                :placeholder="editing ? t('accounts.form.credentialsKeepPlaceholder') : 'sk-...'"
                class="input font-mono"
              />
            </div>
          </div>

          <div v-else-if="isXPassSub" class="space-y-4">
            <div>
              <label class="label" for="account-form-xpass-base">{{ t("accounts.form.baseUrl") }}</label>
              <input
                id="account-form-xpass-base"
                v-model="formBaseUrl"
                type="url"
                spellcheck="false"
                autocomplete="off"
                :placeholder="XPASS_CLI_BASE_URL"
                class="input font-mono text-xs"
              />
              <p class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.form.xpassBaseUrlHint") }}</p>
            </div>
            <div>
              <label class="label flex items-center justify-between gap-3" for="account-form-xpass-token">
                <span>{{ t("accounts.form.xpassToken") }} <span v-if="!editing" class="text-danger">*</span></span>
                <span v-if="editing" class="truncate font-mono font-normal text-fg-muted">
                  {{ t("accounts.form.credentialsCurrent", { preview: editing.credentialPreview }) }}
                </span>
              </label>
              <input
                id="account-form-xpass-token"
                v-model="formApiKey"
                type="password"
                :required="!editing"
                autocomplete="new-password"
                :placeholder="editing ? t('accounts.form.credentialsKeepPlaceholder') : 'xai-...'"
                class="input font-mono"
              />
              <p class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.form.xpassTokenHint") }}</p>
            </div>
          </div>

          <div v-else-if="authKind === 'setup_token'">
            <label class="label flex items-center justify-between gap-3" for="account-form-setup-token">
              <span>Setup Token <span v-if="!editing" class="text-danger">*</span></span>
              <span v-if="editing" class="truncate font-mono font-normal text-fg-muted">
                {{ t("accounts.form.credentialsCurrent", { preview: editing.credentialPreview }) }}
              </span>
            </label>
            <input
              id="account-form-setup-token"
              v-model="formSecret"
              type="password"
              :required="!editing"
              autocomplete="new-password"
              :placeholder="editing ? t('accounts.form.credentialsKeepPlaceholder') : 'sk-ant-oat01-...'"
              class="input font-mono"
            />
            <p class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.form.setupTokenHint") }}</p>
          </div>

          <div v-else>
            <div class="mb-1.5 flex items-center justify-between gap-3">
              <label class="label mb-0" for="account-form-secret">
                {{ authKind === "vm_cli_seed" ? t("accounts.form.vmSeedCredentials") : t("accounts.form.oauthCredentials") }}
                <span v-if="!editing" class="text-danger">*</span>
              </label>
              <span v-if="editing" class="min-w-0 truncate font-mono text-2xs text-fg-muted">
                {{ t("accounts.form.credentialsCurrent", { preview: editing.credentialPreview }) }}
              </span>
              <label v-else class="btn btn-ghost btn-xs shrink-0 cursor-pointer">
                <UiIcon name="file" :size="12" />
                {{ t("accounts.form.loadFile") }}
                <input type="file" accept=".json,application/json,text/plain" class="sr-only" @change="loadCredentialFile" />
              </label>
            </div>
            <textarea
              id="account-form-secret"
              v-model="formSecret"
              rows="6"
              :required="!editing"
              spellcheck="false"
              autocomplete="off"
              :placeholder="editing ? t('accounts.form.credentialsKeepPlaceholder') : credentialPlaceholder"
              class="textarea font-mono text-xs"
            />
            <p v-if="insightSummary" class="mt-1 flex items-center gap-1 text-2xs text-success">
              <UiIcon name="check" :size="12" />
              {{ t("accounts.form.detected", { summary: insightSummary }) }}
            </p>
            <p v-if="platformMismatch" class="mt-1 text-2xs text-warning">{{ t("accounts.form.platformMismatch", { platform: platformMismatch }) }}</p>
            <p class="mt-1 text-2xs text-fg-subtle">
              {{ authKind === "vm_cli_seed" ? t("accounts.form.vmSeedHint") : t("accounts.form.oauthCredentialsHint") }}
            </p>
          </div>
        </template>

        <!-- Credentials: batch -->
        <div v-else class="space-y-2">
          <div v-if="isApiKey || isXPassSub">
            <label class="label" for="account-form-batch-base-url">{{ t("accounts.form.baseUrl") }}</label>
            <input
              id="account-form-batch-base-url"
              v-model="formBaseUrl"
              type="url"
              spellcheck="false"
              :placeholder="isXPassSub ? XPASS_CLI_BASE_URL : 'https://'"
              class="input font-mono text-xs"
            />
            <p class="mt-1 text-2xs text-fg-subtle">
              {{ isXPassSub ? t("accounts.form.xpassBaseUrlHint") : t("accounts.form.baseUrlHint") }}
            </p>
          </div>
          <label class="block min-w-0">
            <span class="label flex items-center justify-between gap-3">
              <span>{{ t("accounts.form.batchCredentials") }} <span class="text-danger">*</span></span>
              <span class="font-normal text-fg-muted">{{ t("accounts.form.batchCount", { count: batchCredentials.length }) }}</span>
            </span>
            <textarea
              v-model="batchText"
              rows="8"
              spellcheck="false"
              autocomplete="off"
              :placeholder="
                isApiKey ? 'sk-...\nsk-...' : isXPassSub ? 'xai-...\nxai-...' : authKind === 'setup_token' ? 'sk-ant-oat01-...\nsk-ant-oat01-...' : '{...}\n{...}'
              "
              class="textarea font-mono text-xs"
            />
          </label>
          <p v-if="batchBlock.invalidJson" class="text-xs text-danger">{{ t("accounts.form.batchInvalidJson") }}</p>
          <p class="text-2xs text-fg-subtle">
            {{
              isApiKey
                ? t("accounts.form.batchKeysHint")
                : isXPassSub
                  ? t("accounts.form.xpassBatchHint")
                  : t("accounts.form.batchCredentialsHint")
            }}
          </p>
          <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
            <input v-model="batchSkipDup" type="checkbox" class="checkbox" />
            {{ t("accounts.form.skipDuplicates") }}
          </label>
          <ImportResultSummary v-if="batchResult" :result="batchResult" :account-names="accountNames" />
        </div>
      </AccountFormSection>

      <!-- 4. Exit proxy: the Clash node / static IP the account's traffic leaves through -->
      <AccountFormSection :title="t('accounts.form.sections.exit')" icon="network" :tag="exitNeeded ? undefined : t('accounts.form.optional')">
        <UiAlert v-if="exitPool.standalone" tone="info">{{ t("accounts.form.exit.standalone") }}</UiAlert>
        <UiAlert v-else-if="exitPool.failed" tone="warning">{{ t("accounts.form.exit.loadFailed") }}</UiAlert>

        <!-- Batch: one exit per account, so offer automatic assignment instead of a single pick -->
        <div v-if="!editing && mode === 'batch'" class="space-y-1.5">
          <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-fg" :class="exitPickerDisabled || !exitNeeded ? 'opacity-60' : ''">
            <input v-model="batchAutoExit" type="checkbox" class="checkbox" :disabled="exitPickerDisabled || !exitNeeded" />
            {{ t("accounts.form.exit.batchAuto") }}
          </label>
          <p class="text-2xs leading-relaxed text-fg-subtle">
            {{ exitNeeded ? t("accounts.form.exit.batchHint", { n: freeExitCount }) : t("accounts.form.exit.directHint") }}
          </p>
        </div>

        <template v-else>
          <div class="min-w-0">
            <label class="label flex items-center justify-between gap-3" for="account-form-exit">
              <span>{{ t("accounts.form.exit.node") }}</span>
              <RouterLink to="/admin/proxy/clash" class="font-normal text-accent hover:underline" target="_blank">
                {{ t("accounts.form.exit.manage") }}
              </RouterLink>
            </label>
            <ExitNodePicker
              v-model="formExitNodeId"
              input-id="account-form-exit"
              :pool="exitPool"
              :current="currentBinding"
              :disabled="exitPickerDisabled"
            />
          </div>
          <div v-if="formExitNodeId" class="sm:max-w-xs">
            <label class="label" for="account-form-utls">{{ t("accounts.form.exit.profile") }}</label>
            <UiSelect id="account-form-utls" v-model="formUtlsProfileId" class="select" :disabled="exitPickerDisabled">
              <option value="">{{ t("accounts.form.exit.profileDefault") }}</option>
              <option v-for="p in exitPool.profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
            </UiSelect>
          </div>
          <UiAlert v-if="exitNeeded && !formExitNodeId && !exitPickerDisabled" tone="warning">
            {{ t("accounts.form.exit.requiredHint", { mode: executionModeLabel(formMode) }) }}
          </UiAlert>
          <p v-else-if="!exitNeeded" class="text-2xs leading-relaxed text-fg-subtle">{{ t("accounts.form.exit.directHint") }}</p>
        </template>
      </AccountFormSection>

      <!-- 5. Plan & scheduling -->
      <AccountFormSection :title="t('accounts.form.sections.scheduling')" icon="gauge">
        <!-- Plan (subscriptions only) and access mode -->
        <div class="grid gap-4" :class="!isApiKey && tierOptions.length ? 'sm:grid-cols-2' : ''">
          <div v-if="!isApiKey && tierOptions.length">
            <label class="label" for="account-form-tier">{{ t("accounts.form.tier") }}</label>
            <UiSelect id="account-form-tier" v-model="formTier" class="select" @change="onTierChange">
              <option v-for="opt in tierOptions" :key="opt.tier" :value="opt.tier">{{ opt.label }}</option>
            </UiSelect>
          </div>
          <div>
            <label class="label" for="account-form-mode">{{ t("accounts.form.mode") }}</label>
            <UiSelect id="account-form-mode" v-model="formMode" class="select">
              <option v-for="m in EXECUTION_MODES" :key="m" :value="m">{{ executionModeLabel(m) }}</option>
            </UiSelect>
          </div>
        </div>

        <!-- Limits and status -->
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <label class="label" for="account-form-conc">{{ t("accounts.form.concurrency") }}</label>
            <input id="account-form-conc" v-model.number="formMaxConc" type="number" min="1" max="64" required class="input font-mono" />
          </div>
          <div>
            <label class="label" for="account-form-priority">{{ t("accounts.form.priority") }}</label>
            <input id="account-form-priority" v-model.number="formPriority" type="number" min="0" max="10000" required class="input font-mono" />
          </div>
          <div v-if="editing" class="col-span-2 sm:col-span-1">
            <label class="label" for="account-form-status">{{ t("accounts.form.status") }}</label>
            <UiSelect id="account-form-status" v-model="formStatus" class="select">
              <option v-for="s in ACCOUNT_STATUSES" :key="s" :value="s">{{ accountStatusLabel(s) }}</option>
            </UiSelect>
          </div>
          <div v-else class="col-span-2 sm:col-span-1">
            <label class="label" for="account-form-initial">{{ t("accounts.form.initialStatus") }}</label>
            <UiSelect id="account-form-initial" v-model="formInitialStatus" class="select">
              <option value="active">{{ t("accounts.form.startActive") }}</option>
              <option value="paused">{{ t("accounts.form.startPaused") }}</option>
            </UiSelect>
          </div>
        </div>
        <div v-if="editing && (formStatus === 'cooldown' || formCooldownUntil)">
          <label class="label" for="account-form-cooldown">{{ t("accounts.form.cooldownUntil") }}</label>
          <input id="account-form-cooldown" v-model="formCooldownUntil" type="datetime-local" class="input font-mono" />
          <p class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.form.cooldownUntilHint") }}</p>
        </div>
      </AccountFormSection>

      <!-- Spend quota (rolling daily / weekly windows and a total cap) -->
      <AccountFormSection
        :title="t('accounts.form.sections.quota')"
        icon="wallet"
        :tag="quotaCount ? t('accounts.quota.tagSet', { n: quotaCount }) : t('accounts.form.optional')"
      >
        <p class="text-2xs text-fg-subtle">{{ t("accounts.quota.hint") }}</p>
        <div class="grid gap-4 sm:grid-cols-3">
          <div v-for="k in QUOTA_KEYS" :key="k">
            <label class="label" :for="`account-form-quota-${k}`">{{ t(`accounts.quota.${k}Limit`) }}</label>
            <div class="relative">
              <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-fg-subtle">$</span>
              <input
                :id="`account-form-quota-${k}`"
                v-model="formQuota[k]"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                placeholder="0"
                class="input pl-6 font-mono"
                :class="quotaBad(k) ? '!border-danger' : ''"
                :aria-invalid="quotaBad(k) || undefined"
              />
            </div>
            <p v-if="quotaBad(k)" class="mt-1 text-2xs text-danger">{{ t("accounts.quota.invalid") }}</p>
            <p v-else-if="editing && accountQuotaLimited(editing.quota) && editing.quota[QUOTA_LIMIT[k]] !== '0'" class="mt-1 text-2xs text-fg-subtle">
              {{ t("accounts.quota.used", { used: formatUsd(editing.quota[QUOTA_USED[k]]) }) }}
            </p>
            <p v-else class="mt-1 text-2xs text-fg-subtle">{{ t(`accounts.quota.${k}Hint`) }}</p>
          </div>
        </div>
        <p v-if="editing && accountQuotaLimited(editing.quota)" class="text-2xs text-fg-subtle">{{ t("accounts.quota.editHint") }}</p>
      </AccountFormSection>

      <!-- 6. Temporary-unschedulable rules (applied by slipgate-net to upstream errors) -->
      <AccountFormSection
        :title="t('accounts.form.sections.rules')"
        icon="shield-alert"
        :tag="formRules.length ? t('accounts.rules.count', { n: formRules.length }) : t('accounts.form.optional')"
      >
        <TempUnschedRulesEditor v-model="formRules" />
      </AccountFormSection>

      <!-- 7. Validity -->
      <AccountFormSection :title="t('accounts.form.sections.validity')" icon="calendar">
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="label" for="account-form-expires">{{ t("accounts.form.expires") }}</label>
            <input id="account-form-expires" v-model="formExpires" type="date" class="input font-mono" />
            <div class="mt-1.5 flex flex-wrap gap-1">
              <button type="button" class="btn btn-secondary btn-xs" @click="setExpiryPreset(30)">{{ t("accounts.form.expiresPreset.d30") }}</button>
              <button type="button" class="btn btn-secondary btn-xs" @click="setExpiryPreset(90)">{{ t("accounts.form.expiresPreset.d90") }}</button>
              <button type="button" class="btn btn-secondary btn-xs" @click="setExpiryPreset(365)">{{ t("accounts.form.expiresPreset.d365") }}</button>
              <button type="button" class="btn btn-ghost btn-xs" @click="setExpiryPreset(null)">{{ t("accounts.form.expiresClear") }}</button>
            </div>
          </div>
          <div class="flex flex-col justify-center gap-1.5">
            <UiSwitch v-model="formAutoPause" tone="accent" :label="t('accounts.form.autoPause')" />
            <p class="text-2xs leading-relaxed text-fg-subtle">{{ t("accounts.form.expiresHint") }}</p>
          </div>
        </div>
      </AccountFormSection>

      <!-- 8. Group: optional, listed by the chosen platform (plus composite groups) -->
      <AccountFormSection :title="t('accounts.form.sections.group')" icon="layers" :tag="t('accounts.form.optional')">
        <div>
          <label class="label" for="account-form-group">{{ t("accounts.form.group") }}</label>
          <div class="flex items-center gap-2">
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2"
              :class="selectedGroup ? platformStyle(selectedGroup.platform).text : 'text-fg-subtle'"
              aria-hidden="true"
            >
              <PlatformIcon v-if="selectedGroup" :platform="selectedGroup.platform" :size="15" />
              <UiIcon v-else name="layers" :size="15" />
            </span>
            <UiSelect id="account-form-group" v-model="formGroupId" class="select min-w-0 flex-1">
              <option value="">{{ t("accounts.form.noGroup") }}</option>
              <optgroup v-if="platformGroups.length" :label="t('accounts.form.groupsOfPlatform', { platform: platformShortLabel(formPlatform) })">
                <option v-for="g in platformGroups" :key="g.id" :value="g.id">{{ groupLabel(g) }}</option>
              </optgroup>
              <optgroup v-if="compositeGroups.length" :label="t('accounts.form.compositeGroups')">
                <option v-for="g in compositeGroups" :key="g.id" :value="g.id">{{ groupLabel(g) }}</option>
              </optgroup>
            </UiSelect>
          </div>
          <p class="mt-1 text-2xs leading-relaxed text-fg-subtle">
            {{ formGroupId ? t("accounts.form.groupHint") : t("accounts.form.noGroupHint") }}
          </p>
          <p v-if="!platformGroups.length && !compositeGroups.length" class="mt-1 text-2xs text-fg-subtle">
            {{ t("accounts.form.noGroupsForPlatform", { platform: platformShortLabel(formPlatform) }) }}
          </p>
        </div>
      </AccountFormSection>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button type="submit" form="account-form" class="btn btn-primary" :disabled="!canSubmit">
        <UiIcon :name="saving ? 'loader' : editing ? 'check' : 'plus'" :size="14" :spin="saving" />
        {{ submitLabel }}
      </button>
    </template>
  </UiModal>
</template>
