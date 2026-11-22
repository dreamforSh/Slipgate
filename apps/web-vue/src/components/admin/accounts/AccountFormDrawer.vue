<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  allowedSubscriptionTiersForProvider,
  parseCredentialBlock,
  recommendedMaxConcurrencyForTier,
  type AccountAuthKind,
  type AccountImportResult,
  type AccountInitialStatus,
  type AccountStatus,
  type CreateAccountRequest,
  type ExecutionMode,
  type GroupItem,
  type Provider,
  type SubscriptionTier,
  type UpdateAccountRequest,
  type UpstreamAccount,
} from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import ImportResultSummary from "./ImportResultSummary.vue";
import {
  ACCOUNT_STATUSES,
  AUTH_KINDS,
  EXECUTION_MODES,
  dateInputFromNow,
  dateInputToIso,
  datetimeInputToIso,
  isoToDateInput,
  isoToDatetimeInput,
} from "./accountDisplay";
import { PROVIDER_OPTIONS, accountStatusLabel, executionModeLabel, type Tone } from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";

/** Create (single or batch), edit, and "duplicate as new" for upstream accounts. */
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

const { t, te } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

const editing = computed(() => props.account);
type FormMode = "single" | "batch";
const mode = ref<FormMode>("single");
const saving = ref(false);
const batchResult = ref<AccountImportResult | null>(null);

const formName = ref("");
const formNotes = ref("");
const formGroupId = ref("");
const formPlatform = ref<Provider>("anthropic");
const formMode = ref<ExecutionMode>("stealth_http");
const formAuthKind = ref<AccountAuthKind>("oauth");
const formTier = ref<SubscriptionTier>("max");
const formSecret = ref("");
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

const title = computed(() => {
  if (editing.value) return t("accounts.form.editTitle");
  return props.template ? t("accounts.form.copyTitle") : t("accounts.form.createTitle");
});

const modeOptions = computed(() => [
  { value: "single" as const, label: t("accounts.form.modeSingle") },
  { value: "batch" as const, label: t("accounts.form.modeBatch") },
]);

const tierOptions = computed(() => allowedSubscriptionTiersForProvider(formPlatform.value));

function authKindLabel(kind: string): string {
  const key = `accounts.authKinds.${kind}`;
  return te(key) ? t(key) : kind;
}

/* ---------------- Presets ---------------- */

type SubscriptionPreset = "claude_max" | "claude_ultra" | "codex_pro_5x" | "codex_pro_10x" | "codex_pro_25x" | "antigravity";

// Preset labels are product/plan brand names and stay untranslated.
const presets: { key: SubscriptionPreset; label: string; tone: Tone }[] = [
  { key: "claude_max", label: "Claude Max · 5x", tone: "warning" },
  { key: "claude_ultra", label: "Claude Ultra · 20x", tone: "warning" },
  { key: "codex_pro_5x", label: "Codex Pro · 5x", tone: "success" },
  { key: "codex_pro_10x", label: "Codex Pro · 10x", tone: "success" },
  { key: "codex_pro_25x", label: "Codex Pro · 25x", tone: "success" },
  { key: "antigravity", label: "Antigravity VM", tone: "violet" },
];

const presetToneClass: Record<string, string> = {
  warning: "border-warning/30 bg-warning/[0.07] text-warning hover:bg-warning/15",
  success: "border-success/30 bg-success/[0.07] text-success hover:bg-success/15",
  violet: "border-violet/30 bg-violet/[0.07] text-violet hover:bg-violet/15",
};

function applyPreset(preset: SubscriptionPreset) {
  const fillSecret = (value: unknown) => {
    if (mode.value === "single" && !formSecret.value.trim()) formSecret.value = JSON.stringify(value);
  };
  if (preset === "claude_max" || preset === "claude_ultra") {
    formPlatform.value = "anthropic";
    formMode.value = "stealth_http";
    formAuthKind.value = "oauth";
    formTier.value = preset === "claude_ultra" ? "ultra" : "max";
    formMaxConc.value = recommendedMaxConcurrencyForTier("anthropic", formTier.value);
    fillSecret({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-replace-me",
        refreshToken: "sk-ant-ort01-replace-me",
        subscriptionType: formTier.value,
      },
    });
    return;
  }
  if (preset === "codex_pro_5x" || preset === "codex_pro_10x" || preset === "codex_pro_25x") {
    const tier: SubscriptionTier = preset === "codex_pro_25x" ? "pro_25x" : preset === "codex_pro_10x" ? "pro_10x" : "pro_5x";
    formPlatform.value = "codex";
    formMode.value = "stealth_http";
    formAuthKind.value = "oauth";
    formTier.value = tier;
    formMaxConc.value = recommendedMaxConcurrencyForTier("codex", tier);
    fillSecret({
      tokens: {
        access_token: "eyJhbGciOi-replace-me",
        refresh_token: "rt_replace_me",
        account_id: "acct_chatgpt_replace_me",
        plan_type: tier,
      },
    });
    return;
  }
  formPlatform.value = "antigravity";
  formMode.value = "vm_slot";
  formAuthKind.value = "vm_cli_seed";
  formTier.value = "pro";
  formMaxConc.value = recommendedMaxConcurrencyForTier("antigravity", "pro");
  fillSecret({ accessToken: "ya29.replace-me", refreshToken: "1//replace-me", projectId: "rising-fact-p41fc" });
}

function defaultTierFor(platform: Provider): SubscriptionTier {
  if (platform === "anthropic") return "max";
  if (platform === "codex" || platform === "openai") return "pro_5x";
  if (platform === "antigravity") return "pro";
  return "standard";
}

function onPlatformChange() {
  if (!tierOptions.value.some((o) => o.tier === formTier.value)) formTier.value = defaultTierFor(formPlatform.value);
  formMaxConc.value = recommendedMaxConcurrencyForTier(formPlatform.value, formTier.value);
}

function onTierChange() {
  formMaxConc.value = recommendedMaxConcurrencyForTier(formPlatform.value, formTier.value);
}

/* ---------------- Init ---------------- */

function loadFrom(src: UpstreamAccount, asCopy: boolean) {
  formName.value = asCopy ? `${src.name}-copy`.slice(0, 64) : src.name;
  formNotes.value = src.notes;
  formGroupId.value = src.groupId;
  formPlatform.value = src.platform;
  formMode.value = src.executionMode;
  formAuthKind.value = src.authKind;
  formTier.value = src.subscriptionTier;
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
  batchText.value = "";
  batchPrefix.value = "";
  batchSkipDup.value = true;
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
  formPlatform.value = "anthropic";
  formMode.value = "stealth_http";
  formAuthKind.value = "oauth";
  formTier.value = "max";
  formMaxConc.value = recommendedMaxConcurrencyForTier("anthropic", "max");
  formPriority.value = 100;
  formStatus.value = "active";
  formExpires.value = "";
  formAutoPause.value = true;
  formCooldownUntil.value = "";
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
const batchCredentials = computed(() => batchBlock.value.credentials);
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

function baseFields() {
  return {
    notes: formNotes.value.trim(),
    groupId: formGroupId.value,
    platform: formPlatform.value,
    executionMode: formMode.value,
    authKind: formAuthKind.value,
    subscriptionTier: formTier.value,
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
  if (formAuthKind.value !== acc.authKind) patch.authKind = formAuthKind.value;
  if (formTier.value !== acc.subscriptionTier) patch.subscriptionTier = formTier.value;
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
  if (formSecret.value.trim()) patch.credentialSecret = formSecret.value.trim();
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
  const body: CreateAccountRequest = {
    ...baseFields(),
    name: formName.value.trim(),
    credentialSecret: formSecret.value.trim(),
  };
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
  if (editing.value) return formName.value.trim().length > 0;
  if (mode.value === "batch") {
    return batchPrefix.value.trim().length > 0 && batchCredentials.value.length > 0 && !batchBlock.value.invalidJson;
  }
  return formName.value.trim().length > 0 && formSecret.value.trim().length > 0;
});

const submitLabel = computed(() =>
  !editing.value && mode.value === "batch"
    ? t("accounts.form.submitBatch", { count: batchCredentials.value.length })
    : t("accounts.actions.saveAccount"),
);

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
</script>

<template>
  <UiDrawer :open="open" :title="title" width="lg" @update:open="emit('update:open', $event)">
    <form id="account-form" class="space-y-5" @submit.prevent="submit">
      <SegmentedControl v-if="!editing && !template" v-model="mode" :options="modeOptions" block size="md" />
      <UiAlert v-if="template && !editing" tone="info">{{ t("accounts.form.copyHint") }}</UiAlert>

      <div v-if="!editing">
        <p class="label flex items-center gap-1.5">
          <UiIcon name="sparkles" :size="13" />
          {{ t("accounts.form.presets") }}
        </p>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="p in presets"
            :key="p.key"
            type="button"
            class="inline-flex h-7 cursor-pointer items-center rounded-md border px-2.5 text-xs font-medium transition-colors"
            :class="presetToneClass[p.tone]"
            @click="applyPreset(p.key)"
          >
            {{ p.label }}
          </button>
        </div>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField v-if="editing || mode === 'single'" :label="t('accounts.form.name')" required>
          <input
            v-model="formName"
            type="text"
            required
            maxlength="64"
            :placeholder="t('accounts.form.namePlaceholder')"
            class="input"
          />
        </FormField>
        <FormField v-else :label="t('accounts.form.batchPrefix')" required>
          <input v-model="batchPrefix" type="text" required maxlength="56" placeholder="claude-pool" class="input" />
        </FormField>
        <FormField :label="t('accounts.form.group')" required>
          <select v-model="formGroupId" required class="select">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </FormField>
        <FormField :label="t('accounts.form.platform')">
          <select v-model="formPlatform" class="select" :disabled="!!editing" @change="onPlatformChange">
            <option v-for="p in PROVIDER_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </FormField>
        <FormField :label="t('accounts.form.tier')">
          <select v-model="formTier" class="select" @change="onTierChange">
            <option v-for="opt in tierOptions" :key="opt.tier" :value="opt.tier">{{ opt.label }}</option>
          </select>
        </FormField>
        <FormField :label="t('accounts.form.mode')">
          <select v-model="formMode" class="select">
            <option v-for="m in EXECUTION_MODES" :key="m" :value="m">{{ executionModeLabel(m) }}</option>
          </select>
        </FormField>
        <FormField :label="t('accounts.form.auth')">
          <select v-model="formAuthKind" class="select">
            <option v-for="k in AUTH_KINDS" :key="k" :value="k">{{ authKindLabel(k) }}</option>
          </select>
        </FormField>
        <FormField :label="t('accounts.form.concurrency')">
          <input v-model.number="formMaxConc" type="number" min="1" max="64" required class="input font-mono" />
        </FormField>
        <FormField :label="t('accounts.form.priority')">
          <input v-model.number="formPriority" type="number" min="0" max="10000" required class="input font-mono" />
        </FormField>
        <FormField v-if="editing" :label="t('accounts.form.status')">
          <select v-model="formStatus" class="select">
            <option v-for="s in ACCOUNT_STATUSES" :key="s" :value="s">{{ accountStatusLabel(s) }}</option>
          </select>
        </FormField>
        <FormField v-else :label="t('accounts.form.initialStatus')">
          <select v-model="formInitialStatus" class="select">
            <option value="active">{{ t("accounts.form.startActive") }}</option>
            <option value="paused">{{ t("accounts.form.startPaused") }}</option>
          </select>
        </FormField>
        <label v-if="editing && (formStatus === 'cooldown' || formCooldownUntil)" class="block min-w-0">
          <span class="label">{{ t("accounts.form.cooldownUntil") }}</span>
          <input v-model="formCooldownUntil" type="datetime-local" class="input font-mono" />
          <span class="mt-1 block text-2xs text-fg-subtle">{{ t("accounts.form.cooldownUntilHint") }}</span>
        </label>
      </div>

      <!-- Validity -->
      <fieldset class="rounded-xl border border-line/70 p-4">
        <legend class="eyebrow px-1.5">{{ t("accounts.form.lifecycle") }}</legend>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block min-w-0">
            <span class="label">{{ t("accounts.form.expires") }}</span>
            <input v-model="formExpires" type="date" class="input font-mono" />
            <span class="mt-1.5 flex flex-wrap gap-1">
              <button type="button" class="btn btn-secondary btn-xs" @click="setExpiryPreset(30)">
                {{ t("accounts.form.expiresPreset.d30") }}
              </button>
              <button type="button" class="btn btn-secondary btn-xs" @click="setExpiryPreset(90)">
                {{ t("accounts.form.expiresPreset.d90") }}
              </button>
              <button type="button" class="btn btn-secondary btn-xs" @click="setExpiryPreset(365)">
                {{ t("accounts.form.expiresPreset.d365") }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="setExpiryPreset(null)">
                {{ t("accounts.form.expiresClear") }}
              </button>
            </span>
          </label>
          <div class="flex flex-col justify-center gap-1.5">
            <UiSwitch v-model="formAutoPause" tone="accent" :label="t('accounts.form.autoPause')" />
            <p class="text-2xs leading-relaxed text-fg-subtle">{{ t("accounts.form.expiresHint") }}</p>
          </div>
        </div>
      </fieldset>

      <FormField :label="t('accounts.form.notes')">
        <textarea
          v-model="formNotes"
          rows="2"
          maxlength="500"
          :placeholder="t('accounts.form.notesPlaceholder')"
          class="textarea"
        />
      </FormField>

      <!-- Credentials -->
      <label v-if="editing || mode === 'single'" class="block min-w-0">
        <span class="label flex items-center justify-between gap-3">
          <span>
            {{ t("accounts.form.credentials") }}
            <span v-if="!editing" class="text-danger">*</span>
          </span>
          <span v-if="editing" class="truncate font-mono font-normal text-fg-muted">
            {{ t("accounts.form.credentialsCurrent", { preview: editing.credentialPreview }) }}
          </span>
        </span>
        <textarea
          v-model="formSecret"
          rows="6"
          :required="!editing"
          spellcheck="false"
          autocomplete="off"
          :placeholder="editing ? t('accounts.form.credentialsKeepPlaceholder') : t('accounts.form.credentialsPlaceholder')"
          class="textarea font-mono text-xs"
        />
      </label>
      <div v-else class="space-y-2">
        <label class="block min-w-0">
          <span class="label flex items-center justify-between gap-3">
            <span>{{ t("accounts.form.batchCredentials") }} <span class="text-danger">*</span></span>
            <span class="font-normal text-fg-muted">{{ t("accounts.form.batchCount", { count: batchCredentials.length }) }}</span>
          </span>
          <textarea
            v-model="batchText"
            rows="9"
            spellcheck="false"
            autocomplete="off"
            :placeholder="'sk-ant-api03-...\nsk-ant-api03-...'"
            class="textarea font-mono text-xs"
          />
        </label>
        <p v-if="batchBlock.invalidJson" class="text-xs text-danger">{{ t("accounts.form.batchInvalidJson") }}</p>
        <p class="text-2xs text-fg-subtle">{{ t("accounts.form.batchCredentialsHint") }}</p>
        <p v-if="batchPrefix.trim()" class="text-2xs text-fg-muted">
          {{ t("accounts.form.batchPrefixHint", { example: batchExample }) }}
        </p>
        <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
          <input v-model="batchSkipDup" type="checkbox" class="checkbox" />
          {{ t("accounts.form.skipDuplicates") }}
        </label>
        <ImportResultSummary v-if="batchResult" :result="batchResult" :account-names="accountNames" />
      </div>
    </form>
    <template #footer>
      <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button type="submit" form="account-form" class="btn btn-primary" :disabled="!canSubmit">
        <UiIcon :name="saving ? 'loader' : 'lock'" :size="14" :spin="saving" />
        {{ submitLabel }}
      </button>
    </template>
  </UiDrawer>
</template>
