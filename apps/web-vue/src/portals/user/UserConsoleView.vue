<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  formatNanoUsd,
  recognizeEndpoint,
  type ApiKeyItem,
  type CreatedApiKeyResponse,
  type GroupItem,
  type UsageLogItem,
} from "@slipgate/contracts";
import BulkEditKeysModal from "../../components/keys/BulkEditKeysModal.vue";
import KeyFlags from "../../components/keys/KeyFlags.vue";
import KeyFormModal from "../../components/keys/KeyFormModal.vue";
import KeyGroupSwitcher from "../../components/keys/KeyGroupSwitcher.vue";
import KeyMobileCard from "../../components/keys/KeyMobileCard.vue";
import MyRatesPanel from "../../components/keys/MyRatesPanel.vue";
import KeyUsageCell from "../../components/keys/KeyUsageCell.vue";
import UseKeyModal from "../../components/keys/UseKeyModal.vue";
import { isExpired, stagger } from "../../components/keys/keyLimits";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { useNow } from "../../composables/useNow";
import { useUserGroupRates } from "../../composables/useUserGroupRates";
import { apiJson, errorText } from "../../lib/api";
import { formatDateTime, formatNumber, formatRelative } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import UiSelect from "../../components/ui/UiSelect.vue";

const { t } = useI18n();
const auth = useAuthStore();
const now = useNow(30_000);

const groups = ref<GroupItem[]>([]);
const apiKeys = ref<ApiKeyItem[]>([]);
const usageLogs = ref<UsageLogItem[]>([]);
const loading = ref(false);
const loaded = ref(false);
const errorMessage = ref<string | null>(null);
const notice = ref<string | null>(null);
const toast = useFeedbackToasts(errorMessage, notice);

/* ---------------- Effective per-user rates (lane U1) ---------------- */

const userRates = useUserGroupRates();
/** Groups priced at this user's own multiplier, for every picker and form on the page. */
const ratedGroups = computed(() => userRates.withEffectiveRates(groups.value));
function loadRates() {
  return userRates.load(t("userLimits.mine.loadFailed"));
}

/* ---------------- One-time plaintext ---------------- */

const createdPlaintext = ref<string | null>(null);
/** Key the one-time plaintext belongs to, so "Use key" can fill it into snippets. */
const createdKeyId = ref<string | null>(null);
const copied = ref(false);

async function copySecret() {
  if (!createdPlaintext.value) return;
  try {
    await navigator.clipboard.writeText(createdPlaintext.value);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

function dismissPlaintext() {
  createdPlaintext.value = null;
  copied.value = false;
}

/* ---------------- Stats ---------------- */

const formattedBalance = computed(() => formatNanoUsd(BigInt(auth.wallet?.balanceNanoUsd ?? "0")));
const formattedAvailable = computed(() => auth.wallet?.formattedAvailableUsd ?? "$0.00");
const formattedHeld = computed(() => formatNanoUsd(BigInt(auth.wallet?.heldNanoUsd ?? "0")));
const enabledKeyCount = computed(() => apiKeys.value.filter((k) => k.enabled).length);

/* ---------------- Use-key modal ---------------- */

const useKeyTarget = ref<ApiKeyItem | null>(null);
const useKeyOpen = ref(false);
const useKeyPlaintext = computed(() =>
  useKeyTarget.value && useKeyTarget.value.id === createdKeyId.value ? createdPlaintext.value : null,
);
const useKeyGroup = computed(() => ratedGroups.value.find((g) => g.id === useKeyTarget.value?.groupId) ?? null);

function openUseKey(item: ApiKeyItem) {
  useKeyTarget.value = item;
  useKeyOpen.value = true;
}

function openUseCreatedKey() {
  const item = apiKeys.value.find((k) => k.id === createdKeyId.value);
  if (item) openUseKey(item);
}

/* ---------------- Endpoints ---------------- */

const gatewayOrigin = computed(() => window.location.origin);
const endpoints = [
  { method: "POST", path: "/v1/chat/completions", label: "OpenAI Chat Completions" },
  { method: "POST", path: "/v1/responses", label: "OpenAI Responses / WebSocket" },
  { method: "POST", path: "/v1/messages", label: "Anthropic Messages" },
  { method: "POST", path: "/v1beta/models/:model:generateContent", label: "Google Gemini" },
  { method: "POST", path: "/mcp/", label: "MCP" },
];

/* ---------------- Loading ---------------- */

async function loadData() {
  errorMessage.value = null;
  loading.value = true;
  try {
    await auth.hydrateSession();
    void loadRates();
    const [gRes, kRes, uRes] = await Promise.allSettled([
      apiJson<{ groups: GroupItem[] }>("/api/v1/user/groups"),
      apiJson<{ items: ApiKeyItem[] }>("/api/v1/user/api-keys", { fallbackError: t("user.errors.load") }),
      apiJson<{ items: UsageLogItem[] }>("/api/v1/user/usage?limit=25"),
    ]);
    if (gRes.status === "fulfilled") groups.value = gRes.value.groups;
    if (kRes.status === "fulfilled") {
      apiKeys.value = kRes.value.items;
      const ids = new Set(kRes.value.items.map((k) => k.id));
      selected.value = new Set([...selected.value].filter((id) => ids.has(id)));
      loaded.value = true;
    } else {
      errorMessage.value = errorText(kRes.reason, t("user.errors.load"));
    }
    if (uRes.status === "fulfilled") usageLogs.value = uRes.value.items;
  } finally {
    loading.value = false;
  }
}

function upsert(item: ApiKeyItem) {
  const idx = apiKeys.value.findIndex((k) => k.id === item.id);
  if (idx === -1) apiKeys.value = [item, ...apiKeys.value];
  else apiKeys.value = apiKeys.value.map((k) => (k.id === item.id ? item : k));
}

/* ---------------- Filters ---------------- */

type StatusFilter = "" | "enabled" | "disabled" | "limited" | "expired";
const search = ref("");
const groupFilter = ref("");
const statusFilter = ref<StatusFilter>("");

const hasFilters = computed(() => search.value.trim() !== "" || groupFilter.value !== "" || statusFilter.value !== "");

function resetFilters() {
  search.value = "";
  groupFilter.value = "";
  statusFilter.value = "";
}

function matchesStatus(k: ApiKeyItem, s: StatusFilter): boolean {
  switch (s) {
    case "enabled":
      return k.enabled;
    case "disabled":
      return !k.enabled;
    case "limited":
      return k.limitState !== "ok";
    case "expired":
      return isExpired(k, now.value);
    default:
      return true;
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return apiKeys.value.filter(
    (k) =>
      (!q || k.name.toLowerCase().includes(q) || k.keyPrefix.toLowerCase().includes(q)) &&
      (!groupFilter.value || k.groupId === groupFilter.value) &&
      matchesStatus(k, statusFilter.value),
  );
});

/** Groups referenced by keys (including ones no longer offered) for the filter select. */
const groupOptions = computed(() => {
  const map = new Map<string, string>(groups.value.map((g) => [g.id, g.name]));
  for (const k of apiKeys.value) if (!map.has(k.groupId)) map.set(k.groupId, k.groupName);
  return [...map.entries()].map(([id, name]) => ({ id, name }));
});

const statusOptions = computed(() =>
  (["enabled", "disabled", "limited", "expired"] as const).map((value) => ({
    value,
    label: t(`user.filters.statuses.${value}`),
    count: apiKeys.value.filter((k) => matchesStatus(k, value)).length,
  })),
);

/* ---------------- Selection ---------------- */

const selected = ref(new Set<string>());
const allSelected = computed(() => filtered.value.length > 0 && filtered.value.every((k) => selected.value.has(k.id)));
const someSelected = computed(() => !allSelected.value && filtered.value.some((k) => selected.value.has(k.id)));
const selectedKeys = computed(() => apiKeys.value.filter((k) => selected.value.has(k.id)));

// Hidden rows must not ride along in a bulk action.
watch(filtered, (rows) => {
  const visible = new Set(rows.map((k) => k.id));
  if ([...selected.value].some((id) => !visible.has(id))) {
    selected.value = new Set([...selected.value].filter((id) => visible.has(id)));
  }
});

function toggleSelect(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(filtered.value.map((k) => k.id));
}

/* ---------------- Row actions ---------------- */

const busyIds = ref(new Set<string>());
function setBusy(id: string, busy: boolean) {
  const next = new Set(busyIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

async function patchKey(item: ApiKeyItem, body: Record<string, unknown>, fallback: string): Promise<ApiKeyItem | null> {
  errorMessage.value = null;
  setBusy(item.id, true);
  try {
    const res = await apiJson<{ item: ApiKeyItem }>(`/api/v1/user/api-keys/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      body,
      fallbackError: fallback,
    });
    upsert(res.item);
    return res.item;
  } catch (err) {
    errorMessage.value = errorText(err, fallback);
    return null;
  } finally {
    setBusy(item.id, false);
  }
}

async function toggleKey(item: ApiKeyItem) {
  await patchKey(item, { enabled: !item.enabled }, t("user.errors.toggle"));
}

async function changeGroup(item: ApiKeyItem, groupId: string) {
  const next = await patchKey(item, { groupId }, t("user.errors.group"));
  if (next) notice.value = t("user.notice.groupChanged", { name: next.name, group: next.groupName });
}

async function deleteKey(item: ApiKeyItem) {
  errorMessage.value = null;
  setBusy(item.id, true);
  try {
    await apiJson(`/api/v1/user/api-keys/${encodeURIComponent(item.id)}`, {
      method: "DELETE",
      fallbackError: t("user.errors.delete"),
    });
    apiKeys.value = apiKeys.value.filter((k) => k.id !== item.id);
    if (selected.value.has(item.id)) toggleSelect(item.id);
    if (createdKeyId.value === item.id) dismissPlaintext();
    notice.value = t("user.notice.deleted", { name: item.name });
  } catch (err) {
    errorMessage.value = errorText(err, t("user.errors.delete"));
  } finally {
    setBusy(item.id, false);
  }
}

const bulkBusy = ref(false);
async function bulkEnabled(enabled: boolean) {
  const ids = [...selected.value];
  if (ids.length === 0 || bulkBusy.value) return;
  bulkBusy.value = true;
  errorMessage.value = null;
  try {
    const res = await apiJson<{ items: ApiKeyItem[]; failed: { keyId: string; message: string }[] }>(
      "/api/v1/user/api-keys/bulk",
      { method: "POST", body: { keyIds: ids, patch: { enabled } }, fallbackError: t("user.errors.bulk") },
    );
    res.items.forEach(upsert);
    if (res.failed.length) toast.warning(t("user.bulk.partial", { ok: res.items.length, failed: res.failed.length }));
    else notice.value = t("user.bulk.done", { n: res.items.length });
    selected.value = new Set();
  } catch (err) {
    errorMessage.value = errorText(err, t("user.errors.bulk"));
  } finally {
    bulkBusy.value = false;
  }
}

/* ---------------- Dialogs ---------------- */

const formOpen = ref(false);
const editing = ref<ApiKeyItem | null>(null);
const bulkOpen = ref(false);

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}
function openEdit(item: ApiKeyItem) {
  editing.value = item;
  formOpen.value = true;
}

function onCreated(res: CreatedApiKeyResponse) {
  copied.value = false;
  createdPlaintext.value = res.plaintextKey;
  createdKeyId.value = res.item.id;
  upsert(res.item);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function onSaved(item: ApiKeyItem) {
  upsert(item);
  notice.value = t("user.form.saved");
}
function onBulkDone(items: ApiKeyItem[]) {
  items.forEach(upsert);
  selected.value = new Set();
}

/* ---------------- Display helpers ---------------- */

function expiryText(k: ApiKeyItem): string {
  if (!k.expiresAtIso) return t("user.keys.noExpiry");
  if (isExpired(k, now.value)) return t("user.keys.expired");
  return t("user.keys.expiresIn", { time: formatRelative(k.expiresAtIso, now.value) });
}
/** Within three days of expiry → amber. */
function expirySoon(k: ApiKeyItem): boolean {
  if (!k.expiresAtIso || isExpired(k, now.value)) return false;
  return Date.parse(k.expiresAtIso) - now.value < 3 * 86_400_000;
}

onMounted(() => {
  void loadData();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.keys')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadData">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button type="button" class="btn btn-primary" @click="openCreate">
          <UiIcon name="plus" :size="15" />
          {{ t("user.createKey") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
        :label="t('user.stats.available')"
        :value="formattedAvailable"
        icon="wallet"
        tone="accent"
      />
      <StatCard
        class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
        :style="stagger(1, 40)"
        :label="t('user.stats.balance')"
        :value="formattedBalance"
        icon="database"
      />
      <StatCard
        class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
        :style="stagger(2, 40)"
        :label="t('user.stats.held')"
        :value="formattedHeld"
        icon="clock"
        tone="warning"
      />
      <StatCard
        class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
        :style="stagger(3, 40)"
        :label="t('user.stats.enabledKeys')"
        :value="enabledKeyCount"
        icon="key"
        tone="success"
        :hint="t('user.stats.totalKeys', { count: apiKeys.length })"
      />
    </div>

    <MyRatesPanel
      class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
      :style="stagger(4, 40)"
      :data="userRates.data.value"
      :loading="userRates.loading.value"
      :error="userRates.error.value"
      @retry="loadRates"
    />

    <!-- One-time plaintext reveal -->
    <div
      v-if="createdPlaintext"
      class="animate-slide-up rounded-xl border border-success/30 bg-success/[0.06] p-4"
      role="status"
    >
      <div class="flex items-start gap-3">
        <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success/15 text-success">
          <UiIcon name="check-circle" :size="16" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-fg">{{ t("user.reveal.title") }}</p>
          <p class="mt-0.5 text-xs text-fg-muted">{{ t("user.reveal.notice") }}</p>
          <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code class="min-w-0 flex-1 break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-fg">
              {{ createdPlaintext }}
            </code>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn btn-sm" :class="copied ? 'btn-success' : 'btn-primary'" @click="copySecret">
                <UiIcon :name="copied ? 'check' : 'copy'" :size="14" />
                {{ copied ? t("common.copied") : t("common.copy") }}
              </button>
              <button
                v-if="createdKeyId && apiKeys.some((k) => k.id === createdKeyId)"
                type="button"
                class="btn btn-secondary btn-sm"
                @click="openUseCreatedKey"
              >
                <UiIcon name="terminal" :size="14" />
                {{ t("user.useKey.action") }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" @click="dismissPlaintext">{{ t("user.reveal.saved") }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <UiCard :title="t('user.keys.title')" icon="key" flush>
      <template #actions>
        <span v-if="loaded" class="font-mono text-xs tabular-nums text-fg-subtle">
          {{ hasFilters ? `${filtered.length} / ${apiKeys.length}` : apiKeys.length }}
        </span>
      </template>

      <!-- Toolbar -->
      <div v-if="apiKeys.length > 0" class="flex flex-wrap items-center gap-2 border-b border-line/70 px-4 py-3 sm:px-5">
        <label class="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span class="sr-only">{{ t("common.search") }}</span>
          <UiIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input v-model="search" type="search" class="input input-sm pl-8" :placeholder="t('user.filters.searchPlaceholder')" />
        </label>
        <UiSelect v-model="groupFilter" class="select input-sm w-auto min-w-[8rem] max-w-[12rem]" :aria-label="t('user.keys.group')">
          <option value="">{{ t("user.filters.allGroups") }}</option>
          <option v-for="g in groupOptions" :key="g.id" :value="g.id">{{ g.name }}</option>
        </UiSelect>
        <UiSelect v-model="statusFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('common.status')">
          <option value="">{{ t("user.filters.allStatuses") }}</option>
          <option v-for="s in statusOptions" :key="s.value" :value="s.value">{{ s.label }} ({{ s.count }})</option>
        </UiSelect>
        <button v-if="hasFilters" type="button" class="btn btn-ghost btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="13" />
          {{ t("user.filters.clear") }}
        </button>
        <label v-if="filtered.length > 0" class="ml-auto flex cursor-pointer items-center gap-2 text-xs text-fg-muted lg:hidden">
          <input
            type="checkbox"
            class="checkbox"
            :checked="allSelected"
            :indeterminate="someSelected"
            @change="toggleAll"
          />
          {{ t("user.keys.selectAll") }}
        </label>
      </div>

      <!-- Bulk bar -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        leave-active-class="transition duration-150 ease-in"
        enter-from-class="-translate-y-1 opacity-0"
        leave-to-class="-translate-y-1 opacity-0"
      >
        <div
          v-if="selected.size > 0"
          class="flex flex-wrap items-center gap-2 border-b border-accent/20 bg-accent/[0.05] px-4 py-2.5 sm:px-5"
        >
          <span class="text-xs font-medium text-accent">{{ t("user.bulk.selected", { n: selected.size }) }}</span>
          <div class="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" class="btn btn-primary btn-sm" :disabled="bulkBusy" @click="bulkOpen = true">
              <UiIcon name="sliders" :size="13" />
              {{ t("user.bulk.edit") }}
            </button>
            <button type="button" class="btn btn-success btn-sm" :disabled="bulkBusy" @click="bulkEnabled(true)">
              <UiIcon :name="bulkBusy ? 'loader' : 'play'" :size="13" :spin="bulkBusy" />
              {{ t("common.enable") }}
            </button>
            <button type="button" class="btn btn-danger btn-sm" :disabled="bulkBusy" @click="bulkEnabled(false)">
              <UiIcon :name="bulkBusy ? 'loader' : 'pause'" :size="13" :spin="bulkBusy" />
              {{ t("common.disable") }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="bulkBusy" @click="selected = new Set()">
              <UiIcon name="x" :size="13" />
              {{ t("user.bulk.clear") }}
            </button>
          </div>
        </div>
      </Transition>

      <!-- First-load skeleton -->
      <div v-if="!loaded && loading" class="divide-y divide-line/60" aria-busy="true">
        <div v-for="i in 4" :key="i" class="flex animate-pulse items-center gap-4 px-5 py-4">
          <span class="h-4 w-4 rounded bg-surface-2" />
          <span class="flex-1 space-y-1.5">
            <span class="block h-3 w-36 max-w-full rounded bg-surface-2" />
            <span class="block h-2.5 w-24 rounded bg-surface-2" />
          </span>
          <span class="hidden h-2 w-40 rounded-full bg-surface-2 md:block" />
          <span class="h-4 w-8 rounded-full bg-surface-2" />
        </div>
      </div>

      <EmptyState v-else-if="apiKeys.length === 0" icon="key" :title="t('user.keys.empty')">
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <UiIcon name="plus" :size="14" />
          {{ t("user.createKey") }}
        </button>
      </EmptyState>

      <EmptyState v-else-if="filtered.length === 0" icon="search" :title="t('user.keys.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("user.filters.clear") }}
        </button>
      </EmptyState>

      <template v-else>
        <!-- Cards (narrow screens) -->
        <div class="grid gap-3 p-4 sm:grid-cols-2 lg:hidden">
          <KeyMobileCard
            v-for="(item, i) in filtered"
            :key="item.id"
            class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
            :style="stagger(i)"
            :item="item"
            :groups="ratedGroups"
            :selected="selected.has(item.id)"
            :busy="busyIds.has(item.id)"
            :now="now"
            @select="toggleSelect(item.id)"
            @toggle="toggleKey(item)"
            @group="(id) => changeGroup(item, id)"
            @edit="openEdit(item)"
            @use="openUseKey(item)"
            @delete="deleteKey(item)"
          />
        </div>

        <!-- Table (lg+) -->
        <div class="table-wrap hidden lg:block">
          <table class="data-table">
            <thead>
              <tr>
                <th class="w-10">
                  <input
                    type="checkbox"
                    class="checkbox"
                    :checked="allSelected"
                    :indeterminate="someSelected"
                    :aria-label="t('user.keys.selectAll')"
                    @change="toggleAll"
                  />
                </th>
                <th>{{ t("common.name") }}</th>
                <th>{{ t("user.keys.group") }}</th>
                <th class="min-w-[12rem]">{{ t("user.keys.usage") }}</th>
                <th class="text-right">{{ t("user.keys.limits") }}</th>
                <th>{{ t("user.keys.expiry") }}</th>
                <th>{{ t("common.status") }}</th>
                <th class="text-right">{{ t("common.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(item, i) in filtered"
                :key="item.id"
                class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
                :class="[selected.has(item.id) ? '!bg-accent/[0.06]' : '', item.enabled ? '' : 'text-fg-muted']"
                :style="stagger(i)"
              >
                <td>
                  <input
                    type="checkbox"
                    class="checkbox"
                    :checked="selected.has(item.id)"
                    :aria-label="t('user.keys.select', { name: item.name })"
                    @change="toggleSelect(item.id)"
                  />
                </td>
                <td class="min-w-[12rem] max-w-[18rem]">
                  <button
                    type="button"
                    class="block max-w-full cursor-pointer truncate text-left font-medium text-fg transition-colors hover:text-accent"
                    :title="t('common.edit')"
                    @click="openEdit(item)"
                  >
                    {{ item.name }}
                  </button>
                  <div class="mt-1 flex flex-wrap items-center gap-1.5">
                    <span class="code-chip">{{ item.keyPrefix }}</span>
                    <KeyFlags :item="item" :now="now" />
                  </div>
                </td>
                <td>
                  <KeyGroupSwitcher
                    :item="item"
                    :groups="ratedGroups"
                    :busy="busyIds.has(item.id)"
                    @change="(id) => changeGroup(item, id)"
                  />
                </td>
                <td class="min-w-[12rem] max-w-[16rem]">
                  <KeyUsageCell :item="item" />
                </td>
                <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">
                  {{ t("user.keys.limitsValue", { rpm: item.rpmLimit, concurrency: item.concurrencyLimit }) }}
                </td>
                <td class="whitespace-nowrap text-xs">
                  <p
                    :class="isExpired(item, now) ? 'font-medium text-danger' : expirySoon(item) ? 'text-warning' : 'text-fg-muted'"
                    :title="formatDateTime(item.expiresAtIso)"
                  >
                    {{ expiryText(item) }}
                  </p>
                  <p class="mt-0.5 text-2xs text-fg-subtle" :title="formatDateTime(item.lastUsedAtIso)">
                    {{
                      item.lastUsedAtIso
                        ? t("user.keys.lastUsedAt", { time: formatRelative(item.lastUsedAtIso, now) })
                        : t("user.keys.neverUsed")
                    }}
                  </p>
                </td>
                <td>
                  <UiSwitch
                    :model-value="item.enabled"
                    :disabled="busyIds.has(item.id)"
                    :label="item.enabled ? t('common.enabled') : t('common.disabled')"
                    @update:model-value="toggleKey(item)"
                  />
                </td>
                <td class="whitespace-nowrap text-right">
                  <div class="inline-flex items-center gap-0.5">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs"
                      :title="t('user.useKey.action')"
                      @click="openUseKey(item)"
                    >
                      <UiIcon name="terminal" :size="13" />
                      <span class="hidden xl:inline">{{ t("user.useKey.action") }}</span>
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-icon btn-xs"
                      :title="t('common.edit')"
                      :aria-label="`${t('common.edit')} ${item.name}`"
                      @click="openEdit(item)"
                    >
                      <UiIcon name="pencil" :size="13" />
                    </button>
                    <ConfirmButton icon-only :disabled="busyIds.has(item.id)" @confirm="deleteKey(item)" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </UiCard>

    <UiCard :title="t('user.usage.title')" icon="activity" flush>
      <template #actions>
        <UiBadge>{{ t("user.usage.recent", { count: 25 }) }}</UiBadge>
      </template>
      <EmptyState v-if="usageLogs.length === 0" icon="activity" :title="t('user.usage.empty')" />
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("user.usage.time") }}</th>
              <th>{{ t("user.usage.model") }}</th>
              <th>{{ t("user.usage.protocol") }}</th>
              <th class="text-right">{{ t("user.usage.tokens") }}</th>
              <th class="text-right">{{ t("user.usage.cost") }}</th>
              <th class="text-right">{{ t("user.usage.latency") }}</th>
              <th>{{ t("common.status") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in usageLogs" :key="log.id">
              <td class="whitespace-nowrap font-mono text-xs text-fg-subtle">{{ formatDateTime(log.createdAtIso) }}</td>
              <td>
                <p class="font-medium text-fg">{{ log.publicModel }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">→ {{ log.upstreamModel }}</p>
              </td>
              <td class="whitespace-nowrap font-mono text-xs text-fg-muted" :title="`${log.ingressCodec} → ${log.egressCodec}`">
                {{ recognizeEndpoint(log.ingressCodec).endpoint }} → {{ recognizeEndpoint(log.egressCodec).endpoint }}
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                {{ formatNumber(log.inputTokens) }} / {{ formatNumber(log.outputTokens) }}
              </td>
              <td class="text-right font-mono text-xs font-medium tabular-nums text-fg">{{ log.formattedCostUsd }}</td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">
                {{ log.ttftMs }} / {{ log.durationMs }} ms
              </td>
              <td>
                <UiBadge :tone="log.statusCode < 400 ? 'success' : 'danger'" mono>{{ log.statusCode }}</UiBadge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard :title="t('user.endpoints.title')" icon="plug">
      <div class="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 sm:flex-row sm:items-center">
        <span class="text-xs text-fg-subtle">Base URL</span>
        <code class="min-w-0 flex-1 truncate font-mono text-sm text-fg">{{ gatewayOrigin }}</code>
        <CopyButton :text="gatewayOrigin" :label="t('common.copy')" />
      </div>
      <ul class="mt-3 divide-y divide-line/70">
        <li v-for="ep in endpoints" :key="ep.path" class="flex items-center gap-3 py-2.5">
          <UiBadge tone="accent" mono>{{ ep.method }}</UiBadge>
          <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg">{{ ep.path }}</code>
          <span class="hidden text-xs text-fg-subtle sm:inline">{{ ep.label }}</span>
          <CopyButton :text="`${gatewayOrigin}${ep.path}`" />
        </li>
      </ul>
    </UiCard>

    <KeyFormModal
      v-model:open="formOpen"
      :api-key="editing"
      :groups="ratedGroups"
      :limits="userRates.data.value"
      @created="onCreated"
      @saved="onSaved"
      @updated="upsert"
    />
    <BulkEditKeysModal v-model:open="bulkOpen" :keys="selectedKeys" :groups="ratedGroups" @done="onBulkDone" />
    <UseKeyModal
      v-model:open="useKeyOpen"
      :api-key="useKeyTarget"
      :plaintext="useKeyPlaintext"
      :group="useKeyGroup"
    />
  </div>
</template>
