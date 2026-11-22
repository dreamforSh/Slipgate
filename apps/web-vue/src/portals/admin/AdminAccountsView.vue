<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import {
  allowedSubscriptionTiersForProvider,
  recommendedMaxConcurrencyForTier,
  type AccountAuthKind,
  type AccountBulkResult,
  type AccountStatus,
  type ExecutionMode,
  type GroupItem,
  type Provider,
  type SubscriptionTier,
  type UpdateAccountRequest,
  type UpstreamAccount,
} from "@slipgate/contracts";
import AccountTestModal from "../../components/admin/AccountTestModal.vue";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiDrawer from "../../components/ui/UiDrawer.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import UsageMeter from "../../components/ui/UsageMeter.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import {
  PROVIDER_OPTIONS,
  accountStatusLabel,
  executionModeLabel,
  healthTone,
  type Tone,
} from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const { t, te } = useI18n();
const route = useRoute();
const auth = useAuthStore();

/** 18 cards fill complete rows in the 1 / 2 / 3-column grid. */
const PAGE_SIZE = 18;
const ACCOUNT_STATUSES: AccountStatus[] = ["active", "paused", "cooldown", "expired"];
const EXECUTION_MODES: ExecutionMode[] = ["stealth_http", "direct_api", "vm_slot"];
const AUTH_KINDS: AccountAuthKind[] = ["oauth", "setup_token", "api_key", "vm_cli_seed"];

const groups = ref<GroupItem[]>([]);
const accounts = ref<UpstreamAccount[]>([]);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const toast = useFeedbackToasts(errorMessage);

/* ---------------- Labels ---------------- */

function platformLabel(platform: string): string {
  if (platform === "composite") return t("accounts.platforms.composite");
  return PROVIDER_OPTIONS.find((p) => p.value === platform)?.label ?? platform;
}

function authKindLabel(kind: string): string {
  const key = `accounts.authKinds.${kind}`;
  return te(key) ? t(key) : kind;
}

function formatTierBadge(acc: UpstreamAccount): string {
  switch (acc.subscriptionTier) {
    case "ultra":
      return `ULTRA · ${acc.tierMultiplier}x`;
    case "max":
      return `MAX · ${acc.tierMultiplier}x`;
    case "pro_25x":
      return "PRO 25x";
    case "pro_10x":
      return "PRO 10x";
    case "pro_5x":
      return "PRO 5x";
    case "plus":
      return `PLUS · ${acc.tierMultiplier}x`;
    case "pro":
      return `PRO · ${acc.tierMultiplier}x`;
    default:
      return `STD · ${acc.tierMultiplier}x`;
  }
}

function tierTone(acc: UpstreamAccount): Tone {
  if (acc.tierMultiplier >= 20) return "violet";
  if (acc.tierMultiplier >= 5) return "success";
  return "neutral";
}

const MODE_ICON: Record<ExecutionMode, IconName> = {
  stealth_http: "shield",
  direct_api: "plug",
  vm_slot: "server",
};

function lastTestStripClass(acc: UpstreamAccount): string {
  if (!acc.lastTest) return "bg-surface-2/60 text-fg-subtle";
  if (acc.lastTest.ok) return "bg-success/[0.07] text-fg-muted";
  return "bg-danger/[0.07] text-danger ring-1 ring-inset ring-danger/15";
}

/* ---------------- Relative time for the last-test column ---------------- */

const now = ref(Date.now());
const clock = window.setInterval(() => (now.value = Date.now()), 30_000);
onBeforeUnmount(() => window.clearInterval(clock));

function relativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((now.value - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return t("accounts.lastTest.justNow");
  if (diffSec < 3600) return t("accounts.lastTest.minutesAgo", { n: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return t("accounts.lastTest.hoursAgo", { n: Math.floor(diffSec / 3600) });
  return t("accounts.lastTest.daysAgo", { n: Math.floor(diffSec / 86400) });
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/* ---------------- Filters ---------------- */

const search = ref("");
const platformFilter = ref<"all" | Provider>("all");
const groupFilter = ref<string>(typeof route.query.groupId === "string" ? route.query.groupId : "all");
const statusFilter = ref<"all" | AccountStatus>("all");
const modeFilter = ref<"all" | ExecutionMode>("all");

watch(
  () => route.query.groupId,
  (groupId) => {
    groupFilter.value = typeof groupId === "string" && groupId ? groupId : "all";
  },
);

/** All filters except the execution mode (the segmented control shows counts per mode). */
const baseFiltered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return accounts.value.filter((a) => {
    if (platformFilter.value !== "all" && a.platform !== platformFilter.value) return false;
    if (groupFilter.value !== "all" && a.groupId !== groupFilter.value) return false;
    if (statusFilter.value !== "all" && a.status !== statusFilter.value) return false;
    if (!q) return true;
    return [a.name, a.notes, a.id, a.credentialPreview].some((v) => v.toLowerCase().includes(q));
  });
});

const filteredAccounts = computed(() =>
  modeFilter.value === "all" ? baseFiltered.value : baseFiltered.value.filter((a) => a.executionMode === modeFilter.value),
);

const modeOptions = computed(() => {
  const count = (m: ExecutionMode) => baseFiltered.value.filter((a) => a.executionMode === m).length;
  return [
    { value: "all" as const, label: t("common.all"), count: baseFiltered.value.length },
    ...EXECUTION_MODES.map((m) => ({ value: m, label: executionModeLabel(m), count: count(m) })),
  ];
});

/* ---------------- Pagination ---------------- */

const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(filteredAccounts.value.length / PAGE_SIZE)));
const pagedAccounts = computed(() =>
  filteredAccounts.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
);

watch([search, platformFilter, groupFilter, statusFilter, modeFilter], () => {
  page.value = 1;
});
watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});

/* ---------------- Selection + bulk actions ---------------- */

const selected = ref(new Set<string>());
const selectedCount = computed(() => selected.value.size);
const allPageSelected = computed(
  () => pagedAccounts.value.length > 0 && pagedAccounts.value.every((a) => selected.value.has(a.id)),
);
const somePageSelected = computed(
  () => !allPageSelected.value && pagedAccounts.value.some((a) => selected.value.has(a.id)),
);

function togglePage() {
  const next = new Set(selected.value);
  if (allPageSelected.value) {
    for (const a of pagedAccounts.value) next.delete(a.id);
  } else {
    for (const a of pagedAccounts.value) next.add(a.id);
  }
  selected.value = next;
}

function toggleOne(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function clearSelection() {
  selected.value = new Set();
}

const bulkGroupId = ref("");
const bulkBusy = ref(false);

function reportBulk(result: AccountBulkResult) {
  const message = t("accounts.bulk.result", { success: result.success, failed: result.failed });
  if (result.failed > 0) toast.warning(message);
  else toast.success(message);
}

async function runBulk(path: string, body: Record<string, unknown>) {
  errorMessage.value = null;
  bulkBusy.value = true;
  try {
    const res = await auth.apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountIds: [...selected.value], ...body }),
    });
    const data = (await res.json()) as AccountBulkResult & { message?: string };
    if (!res.ok) {
      errorMessage.value = data.message ?? t("accounts.bulk.failed");
      return;
    }
    reportBulk(data);
    clearSelection();
    await refreshPool(true);
  } finally {
    bulkBusy.value = false;
  }
}

function bulkSetStatus(status: AccountStatus) {
  void runBulk("/api/v1/admin/accounts/bulk-update", { patch: { status } });
}

function bulkMove() {
  if (!bulkGroupId.value) return;
  void runBulk("/api/v1/admin/accounts/bulk-update", { patch: { groupId: bulkGroupId.value } });
}

function bulkDelete() {
  void runBulk("/api/v1/admin/accounts/batch-delete", {});
}

/* ---------------- Stats ---------------- */

const activeAccounts = computed(() => accounts.value.filter((a) => a.status === "active").length);
const totalWeight = computed(() =>
  accounts.value.reduce((s, a) => s + (a.status === "active" ? a.tierMultiplier : 0), 0),
);
const totalConcurrency = computed(() =>
  accounts.value.reduce((s, a) => s + (a.status === "active" ? a.maxConcurrency : 0), 0),
);
const failedTests = computed(() => accounts.value.filter((a) => a.lastTest?.ok === false).length);

/* ---------------- Loading ---------------- */

async function refreshPool(silent = false) {
  errorMessage.value = null;
  if (!silent) loading.value = true;
  try {
    const [gRes, aRes] = await Promise.all([
      auth.apiFetch("/api/v1/admin/groups"),
      auth.apiFetch("/api/v1/admin/accounts"),
    ]);
    if (gRes.ok) {
      groups.value = ((await gRes.json()) as { groups: GroupItem[] }).groups;
    }
    if (aRes.ok) {
      accounts.value = ((await aRes.json()) as { accounts: UpstreamAccount[] }).accounts;
      const ids = new Set(accounts.value.map((a) => a.id));
      const kept = [...selected.value].filter((id) => ids.has(id));
      if (kept.length !== selected.value.size) selected.value = new Set(kept);
    } else {
      errorMessage.value = t("accounts.errors.loadFailed");
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("accounts.errors.loadFailed");
  } finally {
    loading.value = false;
  }
}

/* ---------------- Row actions ---------------- */

async function patchAccount(acc: UpstreamAccount, patch: UpdateAccountRequest, fallback: string): Promise<boolean> {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${acc.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    errorMessage.value = data.message ?? fallback;
    return false;
  }
  return true;
}

async function toggleAccountStatus(acc: UpstreamAccount) {
  const status: AccountStatus = acc.status === "active" ? "paused" : "active";
  if (await patchAccount(acc, { status }, t("accounts.errors.updateStatus"))) {
    await refreshPool(true);
  }
}

async function removeAccount(acc: UpstreamAccount) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${acc.id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    errorMessage.value = data.message ?? t("accounts.errors.deleteAccount");
    return;
  }
  toast.success(t("accounts.toast.deleted"));
  await refreshPool(true);
}

const testOpen = ref(false);
const testTarget = ref<UpstreamAccount | null>(null);

function openTest(acc: UpstreamAccount) {
  if (acc.executionMode === "vm_slot") return;
  testTarget.value = acc;
  testOpen.value = true;
}

/* ---------------- Create / edit drawer ---------------- */

const drawerOpen = ref(false);
const editing = ref<UpstreamAccount | null>(null);
const saving = ref(false);

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

const tierOptions = computed(() => allowedSubscriptionTiersForProvider(formPlatform.value));

type SubscriptionPreset =
  | "claude_max"
  | "claude_ultra"
  | "codex_pro_5x"
  | "codex_pro_10x"
  | "codex_pro_25x"
  | "antigravity";

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

function defaultGroupId(): string {
  if (groupFilter.value !== "all" && groups.value.some((g) => g.id === groupFilter.value)) return groupFilter.value;
  return groups.value[0]?.id ?? "";
}

function openCreate() {
  editing.value = null;
  formName.value = "";
  formNotes.value = "";
  formGroupId.value = defaultGroupId();
  formPlatform.value = "anthropic";
  formMode.value = "stealth_http";
  formAuthKind.value = "oauth";
  formTier.value = "max";
  formSecret.value = "";
  formMaxConc.value = recommendedMaxConcurrencyForTier("anthropic", "max");
  formPriority.value = 100;
  formStatus.value = "active";
  drawerOpen.value = true;
}

function openEdit(acc: UpstreamAccount) {
  editing.value = acc;
  formName.value = acc.name;
  formNotes.value = acc.notes;
  formGroupId.value = acc.groupId;
  formPlatform.value = acc.platform;
  formMode.value = acc.executionMode;
  formAuthKind.value = acc.authKind;
  formTier.value = acc.subscriptionTier;
  formSecret.value = "";
  formMaxConc.value = acc.maxConcurrency;
  formPriority.value = acc.priority;
  formStatus.value = acc.status;
  drawerOpen.value = true;
}

function onPlatformChange() {
  const valid = tierOptions.value.some((o) => o.tier === formTier.value);
  if (!valid) {
    if (formPlatform.value === "anthropic") {
      formTier.value = "max";
    } else if (formPlatform.value === "codex" || formPlatform.value === "openai") {
      formTier.value = "pro_5x";
    } else if (formPlatform.value === "antigravity") {
      formTier.value = "pro";
    } else {
      formTier.value = "standard";
    }
  }
  formMaxConc.value = recommendedMaxConcurrencyForTier(formPlatform.value, formTier.value);
}

function onTierChange() {
  formMaxConc.value = recommendedMaxConcurrencyForTier(formPlatform.value, formTier.value);
}

function applySubscriptionTemplate(preset: SubscriptionPreset) {
  if (preset === "claude_max" || preset === "claude_ultra") {
    formPlatform.value = "anthropic";
    formMode.value = "stealth_http";
    formAuthKind.value = "oauth";
    formTier.value = preset === "claude_ultra" ? "ultra" : "max";
    formMaxConc.value = recommendedMaxConcurrencyForTier("anthropic", formTier.value);
    if (!formSecret.value.trim()) {
      formSecret.value = JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-replace-me",
          refreshToken: "sk-ant-ort01-replace-me",
          subscriptionType: formTier.value,
        },
      });
    }
    return;
  }
  if (preset === "codex_pro_5x" || preset === "codex_pro_10x" || preset === "codex_pro_25x") {
    const tier: SubscriptionTier =
      preset === "codex_pro_25x" ? "pro_25x" : preset === "codex_pro_10x" ? "pro_10x" : "pro_5x";
    formPlatform.value = "codex";
    formMode.value = "stealth_http";
    formAuthKind.value = "oauth";
    formTier.value = tier;
    formMaxConc.value = recommendedMaxConcurrencyForTier("codex", tier);
    if (!formSecret.value.trim()) {
      formSecret.value = JSON.stringify({
        tokens: {
          access_token: "eyJhbGciOi-replace-me",
          refresh_token: "rt_replace_me",
          account_id: "acct_chatgpt_replace_me",
          plan_type: tier,
        },
      });
    }
    return;
  }
  formPlatform.value = "antigravity";
  formMode.value = "vm_slot";
  formAuthKind.value = "vm_cli_seed";
  formTier.value = "pro";
  formMaxConc.value = recommendedMaxConcurrencyForTier("antigravity", "pro");
  if (!formSecret.value.trim()) {
    formSecret.value = JSON.stringify({
      accessToken: "ya29.replace-me",
      refreshToken: "1//replace-me",
      projectId: "rising-fact-p41fc",
    });
  }
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
  if (formStatus.value !== acc.status) patch.status = formStatus.value;
  if (formSecret.value.trim()) patch.credentialSecret = formSecret.value.trim();
  return patch;
}

async function submitForm() {
  errorMessage.value = null;
  saving.value = true;
  try {
    const target = editing.value;
    if (target) {
      const patch = buildPatch(target);
      if (Object.keys(patch).length === 0) {
        drawerOpen.value = false;
        return;
      }
      if (!(await patchAccount(target, patch, t("accounts.errors.updateAccount")))) return;
      toast.success(t("accounts.toast.updated"));
    } else {
      const res = await auth.apiFetch("/api/v1/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName.value.trim(),
          notes: formNotes.value.trim(),
          groupId: formGroupId.value,
          platform: formPlatform.value,
          executionMode: formMode.value,
          authKind: formAuthKind.value,
          subscriptionTier: formTier.value,
          credentialSecret: formSecret.value,
          maxConcurrency: formMaxConc.value,
          priority: formPriority.value,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        errorMessage.value = data.message ?? t("accounts.errors.createAccount");
        return;
      }
      toast.success(t("accounts.toast.created"));
    }
    formSecret.value = "";
    drawerOpen.value = false;
    await refreshPool(true);
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void refreshPool();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.accounts')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="refreshPool()">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button type="button" class="btn btn-primary" @click="openCreate">
          <UiIcon name="plus" :size="15" />
          {{ t("accounts.actions.addAccount") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        :label="t('accounts.stats.activeAccounts')"
        :value="`${activeAccounts} / ${accounts.length}`"
        icon="users"
        tone="success"
      />
      <StatCard :label="t('accounts.stats.totalWeight')" :value="`${totalWeight}x`" icon="gauge" tone="violet" />
      <StatCard :label="t('accounts.stats.concurrency')" :value="totalConcurrency" icon="zap" tone="info" />
      <StatCard
        :label="t('accounts.stats.failedTests')"
        :value="failedTests"
        icon="alert"
        :tone="failedTests > 0 ? 'danger' : 'neutral'"
      />
    </div>

    <UiCard icon="users" :title="t('accounts.list.title')" flush>
      <template #actions>
        <SegmentedControl v-model="modeFilter" :options="modeOptions" />
      </template>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[13rem] flex-1">
          <UiIcon
            name="search"
            :size="14"
            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            v-model="search"
            type="search"
            class="input input-sm pl-8"
            :placeholder="t('accounts.filters.search')"
            :aria-label="t('common.search')"
          />
        </label>
        <select v-model="platformFilter" class="select input-sm w-auto min-w-[9rem]" :aria-label="t('accounts.form.platform')">
          <option value="all">{{ t("accounts.filters.allPlatforms") }}</option>
          <option v-for="p in PROVIDER_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
        <select v-model="groupFilter" class="select input-sm w-auto min-w-[9rem]" :aria-label="t('accounts.form.group')">
          <option value="all">{{ t("accounts.filters.allGroups") }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
        <select v-model="statusFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('common.status')">
          <option value="all">{{ t("accounts.filters.allStatuses") }}</option>
          <option v-for="s in ACCOUNT_STATUSES" :key="s" :value="s">{{ accountStatusLabel(s) }}</option>
        </select>
        <label
          v-if="pagedAccounts.length > 0"
          class="ml-auto inline-flex cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
        >
          <input
            type="checkbox"
            class="checkbox"
            :checked="allPageSelected"
            :indeterminate="somePageSelected"
            @change="togglePage"
          />
          {{ t("accounts.card.selectPage") }}
        </label>
      </div>

      <!-- Bulk actions -->
      <div
        v-if="selectedCount > 0"
        class="flex flex-wrap items-center gap-2 border-b border-line/70 bg-accent/[0.06] px-5 py-2.5"
      >
        <span class="text-sm font-medium text-fg">{{ t("accounts.bulk.selected", { count: selectedCount }) }}</span>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy" @click="bulkSetStatus('active')">
            <UiIcon name="play" :size="13" />
            {{ t("accounts.bulk.enable") }}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy" @click="bulkSetStatus('paused')">
            <UiIcon name="stop" :size="13" />
            {{ t("accounts.bulk.pause") }}
          </button>
          <div class="flex items-center gap-1">
            <select v-model="bulkGroupId" class="select input-sm w-40" :aria-label="t('accounts.bulk.moveTo')">
              <option value="" disabled>{{ t("accounts.bulk.moveTo") }}</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
            <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy || !bulkGroupId" @click="bulkMove">
              {{ t("accounts.bulk.move") }}
            </button>
          </div>
          <ConfirmButton size="sm" :label="t('accounts.bulk.delete')" :disabled="bulkBusy" @confirm="bulkDelete" />
          <button type="button" class="btn btn-ghost btn-sm" @click="clearSelection">
            {{ t("accounts.bulk.clear") }}
          </button>
        </div>
      </div>

      <EmptyState
        v-if="filteredAccounts.length === 0"
        icon="users"
        :title="accounts.length === 0 ? t('accounts.list.empty') : t('accounts.list.noMatch')"
      >
        <button v-if="accounts.length === 0" type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <UiIcon name="plus" :size="14" />
          {{ t("accounts.actions.addAccount") }}
        </button>
      </EmptyState>

      <div v-else class="grid gap-4 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="acc in pagedAccounts"
          :key="acc.id"
          class="card card-hover flex min-w-0 flex-col p-4"
          :class="[
            selected.has(acc.id) ? '!border-accent/50 ring-2 ring-accent/30' : '',
            acc.status === 'active' ? '' : 'opacity-80',
          ]"
        >
          <!-- Header: select, name + group, status -->
          <div class="flex items-start gap-3">
            <input
              type="checkbox"
              class="checkbox mt-1"
              :checked="selected.has(acc.id)"
              :aria-label="t('accounts.card.select', { name: acc.name })"
              @change="toggleOne(acc.id)"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-fg" :title="acc.id">{{ acc.name }}</p>
              <button
                type="button"
                class="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-fg-muted transition-colors hover:text-accent"
                :title="t('accounts.card.filterGroup')"
                @click="groupFilter = acc.groupId"
              >
                <UiIcon name="layers" :size="12" />
                <span class="truncate">{{ acc.groupName }}</span>
              </button>
            </div>
            <div class="shrink-0">
              <UiSwitch
                v-if="acc.status === 'active' || acc.status === 'paused'"
                :model-value="acc.status === 'active'"
                :label="accountStatusLabel(acc.status)"
                @update:model-value="toggleAccountStatus(acc)"
              />
              <button
                v-else
                type="button"
                class="cursor-pointer"
                :title="t('accounts.card.resume')"
                @click="toggleAccountStatus(acc)"
              >
                <UiBadge :tone="healthTone(acc.status)" dot>{{ accountStatusLabel(acc.status) }}</UiBadge>
              </button>
            </div>
          </div>

          <!-- Platform, plan, access mode, auth -->
          <div class="mt-3 flex flex-wrap items-center gap-1.5">
            <UiBadge tone="accent">{{ platformLabel(acc.platform) }}</UiBadge>
            <UiBadge :tone="tierTone(acc)" mono>{{ formatTierBadge(acc) }}</UiBadge>
            <UiBadge :tone="acc.executionMode === 'vm_slot' ? 'violet' : 'info'">
              <span class="inline-flex items-center gap-1">
                <UiIcon :name="MODE_ICON[acc.executionMode]" :size="11" />
                {{ executionModeLabel(acc.executionMode) }}
              </span>
            </UiBadge>
            <span class="text-2xs text-fg-muted">{{ authKindLabel(acc.authKind) }}</span>
          </div>

          <!-- Notes + credential -->
          <p v-if="acc.notes" class="mt-2.5 truncate text-xs text-fg-muted" :title="acc.notes">{{ acc.notes }}</p>
          <p
            class="truncate font-mono text-2xs text-fg-subtle"
            :class="acc.notes ? 'mt-1' : 'mt-2.5'"
            :title="acc.credentialPreview"
          >
            {{ acc.credentialPreview }}
          </p>

          <!-- Usage windows + limits -->
          <div class="mt-3 grid grid-cols-2 gap-3">
            <UsageMeter label="5h" :bps="acc.window5hUsedBps" />
            <UsageMeter label="7d" :bps="acc.window7dUsedBps" />
          </div>
          <dl class="mt-3 grid grid-cols-2 gap-2">
            <div class="rounded-lg bg-surface-2/60 px-2.5 py-1.5">
              <dt class="text-2xs text-fg-subtle">{{ t("accounts.card.concurrency") }}</dt>
              <dd class="font-mono text-sm font-medium tabular-nums text-fg">{{ acc.maxConcurrency }}</dd>
            </div>
            <div class="rounded-lg bg-surface-2/60 px-2.5 py-1.5">
              <dt class="text-2xs text-fg-subtle">{{ t("accounts.card.priority") }}</dt>
              <dd class="font-mono text-sm font-medium tabular-nums text-fg">#{{ acc.priority }}</dd>
            </div>
          </dl>

          <div class="flex-1" />

          <!-- Last test -->
          <div
            class="mt-3 flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs"
            :class="lastTestStripClass(acc)"
            :title="acc.lastTest ? acc.lastTest.message || acc.lastTest.model : undefined"
          >
            <span class="inline-flex min-w-0 items-center gap-1.5">
              <UiIcon
                :name="!acc.lastTest ? 'clock' : acc.lastTest.ok ? 'check-circle' : 'x-circle'"
                :size="13"
                :class="acc.lastTest?.ok ? 'text-success' : ''"
              />
              <span class="truncate font-medium">
                {{
                  !acc.lastTest
                    ? t("accounts.lastTest.never")
                    : acc.lastTest.ok
                      ? t("accounts.lastTest.ok")
                      : t("accounts.lastTest.failed")
                }}
              </span>
            </span>
            <span v-if="acc.lastTest" class="shrink-0 font-mono text-2xs opacity-80">
              {{ relativeTime(acc.lastTest.atIso) }} · {{ formatDuration(acc.lastTest.durationMs) }}
            </span>
          </div>

          <!-- Actions -->
          <div class="mt-3 flex items-center gap-1 border-t border-line/70 pt-3">
            <button
              type="button"
              class="btn btn-ghost btn-sm text-accent hover:!bg-accent/10 hover:!text-accent"
              :disabled="acc.executionMode === 'vm_slot'"
              :title="acc.executionMode === 'vm_slot' ? t('accounts.row.vmTestDisabled') : undefined"
              @click="openTest(acc)"
            >
              <UiIcon name="play" :size="13" />
              {{ t("accounts.row.test") }}
            </button>
            <div class="ml-auto flex items-center gap-1">
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-sm"
                :title="t('accounts.row.edit')"
                :aria-label="t('accounts.row.edit')"
                @click="openEdit(acc)"
              >
                <UiIcon name="pencil" :size="14" />
              </button>
              <ConfirmButton icon-only size="sm" @confirm="removeAccount(acc)" />
            </div>
          </div>
        </article>
      </div>

      <template v-if="pageCount > 1" #footer>
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs text-fg-muted">
            {{ t("accounts.pagination.summary", { page, pages: pageCount, total: filteredAccounts.length }) }}
          </span>
          <div class="flex items-center gap-1.5">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="page <= 1" @click="page -= 1">
              <UiIcon name="chevron-right" :size="13" class="rotate-180" />
              {{ t("accounts.pagination.prev") }}
            </button>
            <button type="button" class="btn btn-secondary btn-sm" :disabled="page >= pageCount" @click="page += 1">
              {{ t("accounts.pagination.next") }}
              <UiIcon name="chevron-right" :size="13" />
            </button>
          </div>
        </div>
      </template>
    </UiCard>

    <!-- Create / edit drawer -->
    <UiDrawer
      v-model:open="drawerOpen"
      :title="editing ? t('accounts.form.editTitle') : t('accounts.form.createTitle')"
      width="lg"
    >
      <form id="account-form" class="space-y-5" @submit.prevent="submitForm">
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
              @click="applySubscriptionTemplate(p.key)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField :label="t('accounts.form.name')" required>
            <input
              v-model="formName"
              type="text"
              required
              maxlength="64"
              :placeholder="t('accounts.form.namePlaceholder')"
              class="input"
            />
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
            <input v-model.number="formMaxConc" type="number" min="1" max="64" class="input font-mono" />
          </FormField>
          <FormField :label="t('accounts.form.priority')">
            <input v-model.number="formPriority" type="number" min="0" max="10000" class="input font-mono" />
          </FormField>
          <FormField v-if="editing" :label="t('accounts.form.status')">
            <select v-model="formStatus" class="select">
              <option v-for="s in ACCOUNT_STATUSES" :key="s" :value="s">{{ accountStatusLabel(s) }}</option>
            </select>
          </FormField>
        </div>

        <FormField :label="t('accounts.form.notes')">
          <textarea
            v-model="formNotes"
            rows="2"
            maxlength="500"
            :placeholder="t('accounts.form.notesPlaceholder')"
            class="textarea"
          />
        </FormField>

        <label class="block min-w-0">
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
            :placeholder="editing ? t('accounts.form.credentialsKeepPlaceholder') : t('accounts.form.credentialsPlaceholder')"
            class="textarea font-mono text-xs"
          />
        </label>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="drawerOpen = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="account-form" class="btn btn-primary" :disabled="saving">
          <UiIcon :name="saving ? 'loader' : 'lock'" :size="14" :spin="saving" />
          {{ t("accounts.actions.saveAccount") }}
        </button>
      </template>
    </UiDrawer>

    <AccountTestModal v-model:open="testOpen" :account="testTarget" @tested="refreshPool(true)" />
  </div>
</template>
