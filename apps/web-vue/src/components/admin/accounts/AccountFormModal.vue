<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  allowedSubscriptionTiersForProvider,
  inspectCredential,
  parseCredentialBlock,
  recommendedMaxConcurrencyForTier,
  resolveTierForPlatform,
  type AccountAuthKind,
  type AccountImportResult,
  type AccountInitialStatus,
  type AccountOAuthProvider,
  type AccountStatus,
  type CreateAccountRequest,
  type ExchangeAccountOAuthResponse,
  type ExecutionMode,
  type GroupItem,
  type Provider,
  type StartAccountOAuthResponse,
  type SubscriptionTier,
  type UpdateAccountRequest,
  type UpstreamAccount,
} from "@slipgate/contracts";
import PlatformIcon from "../../ui/PlatformIcon.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import type { IconName } from "../../ui/icons";
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
import { PROVIDER_OPTIONS, accountStatusLabel, executionModeLabel } from "../../../lib/format";
import { platformShortLabel, platformStyle } from "../../../lib/platformStyle";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";

/**
 * Create (single or batch), edit and "duplicate as new" for upstream accounts, laid out after
 * the linksyncx add-account dialog: target group → name/notes → platform → account type →
 * type-specific credentials → plan, access mode and limits → validity.
 */
const props = defineProps<{
  open: boolean;
  /** Account being edited; `null` creates. */
  account: UpstreamAccount | null;
  /** Settings to start from when duplicating (create mode only). */
  template: UpstreamAccount | null;
  groups: GroupItem[];
  defaultGroupId: string;
  /** id → name, to label duplicate skips in batch results. */
  accountNames: ReadonlyMap<string, string>;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "saved"): void }>();

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

/* ---------------- Account types ---------------- */

type Tone = "orange" | "purple" | "emerald" | "sky" | "fuchsia";
type KindKey = "claude_code" | "console" | "chatgpt" | "antigravity" | "gemini_oauth" | "qwen_oauth" | "vm_seed" | "api_key";

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
const formMaxConc = ref(12);
const formPriority = ref(100);
const formStatus = ref<AccountStatus>("active");
const formInitialStatus = ref<AccountInitialStatus>("active");
const formExpires = ref("");
const formAutoPause = ref(true);
const formCooldownUntil = ref("");
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
/** OAuth and VM seeds are pasted as JSON; API keys and setup tokens are single strings. */
const takesJson = computed(() => authKind.value === "oauth" || authKind.value === "vm_cli_seed");
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

/* ---------------- Group ↔ platform ---------------- */

const selectedGroup = computed(() => props.groups.find((g) => g.id === formGroupId.value) ?? null);
/** A single-platform group decides the platform; composite groups take any. */
const groupPlatform = computed<Provider | null>(() => {
  const p = selectedGroup.value?.platform;
  return p && p !== "composite" ? p : null;
});
const platformLocked = computed(() => !!editing.value || groupPlatform.value !== null);

function defaultTierFor(platform: Provider): SubscriptionTier {
  if (platform === "anthropic") return "max";
  if (platform === "codex" || platform === "openai") return "pro_5x";
  if (platform === "antigravity") return "pro";
  return "standard";
}

function applyKind(key: KindKey) {
  formKind.value = key;
  formMode.value = kind.value.mode;
  if (!tierOptions.value.some((o) => o.tier === formTier.value)) formTier.value = defaultTierFor(formPlatform.value);
  formMaxConc.value = recommendedMaxConcurrencyForTier(formPlatform.value, isApiKey.value ? "standard" : formTier.value);
}

function setPlatform(platform: Provider) {
  formPlatform.value = platform;
  applyKind(kindOptions.value[0]!.key);
}

/** Picker clicks; ignored while the group or the edited account fixes the platform. */
function selectPlatform(platform: Provider) {
  if (!platformLocked.value) setPlatform(platform);
}

function onGroupChange() {
  if (!editing.value && groupPlatform.value && groupPlatform.value !== formPlatform.value) setPlatform(groupPlatform.value);
}

function onTierChange() {
  formMaxConc.value = recommendedMaxConcurrencyForTier(formPlatform.value, formTier.value);
}

/* ---------------- Credential helpers ---------------- */

/** `baseUrl|key` is what the data plane vault reads for relays; a bare key uses the default endpoint. */
function apiKeySecret(key: string): string {
  const base = formBaseUrl.value.trim().replace(/\/+$/, "");
  return base ? `${base}|${key.trim()}` : key.trim();
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
  if (src.platform === "anthropic") return "claude_code";
  return "api_key";
}

function loadFrom(src: UpstreamAccount, asCopy: boolean) {
  formName.value = asCopy ? `${src.name}-copy`.slice(0, 64) : src.name;
  formNotes.value = src.notes;
  formGroupId.value = src.groupId;
  formPlatform.value = src.platform;
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
  if (props.account) {
    loadFrom(props.account, false);
    return;
  }
  if (props.template) {
    loadFrom(props.template, true);
    formStatus.value = "active";
    return;
  }
  formName.value = "";
  formNotes.value = "";
  formGroupId.value = props.defaultGroupId || props.groups[0]?.id || "";
  formPriority.value = 100;
  formStatus.value = "active";
  formExpires.value = "";
  formAutoPause.value = true;
  formCooldownUntil.value = "";
  addMethod.value = "oauth";
  formPlatform.value = groupPlatform.value ?? "anthropic";
  formTier.value = defaultTierFor(formPlatform.value);
  applyKind(kindOptions.value[0]!.key);
}

watch(
  () => [props.open, props.account?.id, props.template?.id] as const,
  ([open]) => {
    if (open) reset();
  },
  { immediate: true },
);

/* ---------------- Batch ---------------- */

const batchBlock = computed(() => parseCredentialBlock(batchText.value));
const batchCredentials = computed(() =>
  batchBlock.value.credentials.map((c) => {
    if (isApiKey.value) return c.startsWith("{") ? c : apiKeySecret(c);
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

/* ---------------- Submit ---------------- */

const expiresIso = computed(() => (formExpires.value ? dateInputToIso(formExpires.value) : null));
/** API keys carry no plan: always stored as standard so the scheduler weighs them 1x. */
const effectiveTier = computed<SubscriptionTier>(() => (isApiKey.value ? "standard" : formTier.value));

const singleSecret = computed(() => {
  if (isApiKey.value) return formApiKey.value.trim() ? apiKeySecret(formApiKey.value) : "";
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
  if (singleSecret.value) patch.credentialSecret = singleSecret.value;
  return patch;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { message?: string; issues?: { message: string }[] };
  return data.message ?? data.issues?.[0]?.message ?? fallback;
}

async function submitEdit(acc: UpstreamAccount) {
  const patch = buildPatch(acc);
  if (Object.keys(patch).length === 0) {
    emit("update:open", false);
    return;
  }
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    toast.error(await readError(res, t("accounts.errors.updateAccount")));
    return;
  }
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
  batchResult.value = merged;
  if (merged.created > 0) emit("saved");
  if (merged.failed === 0 && merged.skipped === 0) {
    toast.success(t("accounts.importResult.created", { n: merged.created }));
    emit("update:open", false);
  }
}

const canSubmit = computed(() => {
  if (saving.value || !formGroupId.value) return false;
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

    <form id="account-form" class="space-y-5" @submit.prevent="submit">
      <UiAlert v-if="template && !editing" tone="info">{{ t("accounts.form.copyHint") }}</UiAlert>

      <!-- Target group: the group decides the platform unless it is composite -->
      <div class="flex items-center gap-3 rounded-xl border border-accent/25 bg-accent/[0.05] px-4 py-3">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-fg shadow-sm" :class="platformStyle(selectedGroup?.platform ?? '').text">
          <PlatformIcon :platform="selectedGroup?.platform ?? ''" :size="16" />
        </span>
        <label class="min-w-0 flex-1">
          <span class="block text-2xs text-fg-subtle">{{ t("accounts.form.targetGroup") }} <span class="text-danger">*</span></span>
          <select v-model="formGroupId" required class="select mt-1 h-9 py-1 text-sm font-semibold" @change="onGroupChange">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <span v-if="groupPlatform && !editing" class="mt-1 block text-2xs text-fg-subtle">
            {{ t("accounts.form.platformLocked", { name: selectedGroup?.name ?? "" }) }}
          </span>
        </label>
      </div>

      <SegmentedControl v-if="!editing && !template" v-model="mode" :options="modeOptions" block size="md" />

      <!-- Name / notes -->
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

      <!-- Platform (hidden when the group or the edited account fixes it) -->
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

      <!-- Account type -->
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
          <div>
            <label class="label" for="account-form-base-url">{{ t("accounts.form.baseUrl") }}</label>
            <input
              id="account-form-base-url"
              v-model="formBaseUrl"
              type="url"
              spellcheck="false"
              autocomplete="off"
              placeholder="https://"
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
        <div v-if="isApiKey">
          <label class="label" for="account-form-batch-base-url">{{ t("accounts.form.baseUrl") }}</label>
          <input id="account-form-batch-base-url" v-model="formBaseUrl" type="url" spellcheck="false" placeholder="https://" class="input font-mono text-xs" />
          <p class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.form.baseUrlHint") }}</p>
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
            :placeholder="isApiKey ? 'sk-...\nsk-...' : authKind === 'setup_token' ? 'sk-ant-oat01-...\nsk-ant-oat01-...' : '{...}\n{...}'"
            class="textarea font-mono text-xs"
          />
        </label>
        <p v-if="batchBlock.invalidJson" class="text-xs text-danger">{{ t("accounts.form.batchInvalidJson") }}</p>
        <p class="text-2xs text-fg-subtle">{{ isApiKey ? t("accounts.form.batchKeysHint") : t("accounts.form.batchCredentialsHint") }}</p>
        <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
          <input v-model="batchSkipDup" type="checkbox" class="checkbox" />
          {{ t("accounts.form.skipDuplicates") }}
        </label>
        <ImportResultSummary v-if="batchResult" :result="batchResult" :account-names="accountNames" />
      </div>

      <!-- Plan (subscriptions only) and access mode -->
      <div class="grid gap-4" :class="!isApiKey && tierOptions.length ? 'sm:grid-cols-2' : ''">
        <div v-if="!isApiKey && tierOptions.length">
          <label class="label" for="account-form-tier">{{ t("accounts.form.tier") }}</label>
          <select id="account-form-tier" v-model="formTier" class="select" @change="onTierChange">
            <option v-for="opt in tierOptions" :key="opt.tier" :value="opt.tier">{{ opt.label }}</option>
          </select>
        </div>
        <div>
          <label class="label" for="account-form-mode">{{ t("accounts.form.mode") }}</label>
          <select id="account-form-mode" v-model="formMode" class="select">
            <option v-for="m in EXECUTION_MODES" :key="m" :value="m">{{ executionModeLabel(m) }}</option>
          </select>
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
          <select id="account-form-status" v-model="formStatus" class="select">
            <option v-for="s in ACCOUNT_STATUSES" :key="s" :value="s">{{ accountStatusLabel(s) }}</option>
          </select>
        </div>
        <div v-else class="col-span-2 sm:col-span-1">
          <label class="label" for="account-form-initial">{{ t("accounts.form.initialStatus") }}</label>
          <select id="account-form-initial" v-model="formInitialStatus" class="select">
            <option value="active">{{ t("accounts.form.startActive") }}</option>
            <option value="paused">{{ t("accounts.form.startPaused") }}</option>
          </select>
        </div>
      </div>
      <div v-if="editing && (formStatus === 'cooldown' || formCooldownUntil)">
        <label class="label" for="account-form-cooldown">{{ t("accounts.form.cooldownUntil") }}</label>
        <input id="account-form-cooldown" v-model="formCooldownUntil" type="datetime-local" class="input font-mono" />
        <p class="mt-1 text-2xs text-fg-subtle">{{ t("accounts.form.cooldownUntilHint") }}</p>
      </div>

      <!-- Validity -->
      <div class="border-t border-line/70 pt-4">
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
      </div>
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
