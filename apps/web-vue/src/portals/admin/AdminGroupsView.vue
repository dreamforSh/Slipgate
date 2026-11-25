<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type {
  CreateGroupRequest,
  GroupItem,
  GroupPlatform,
  GroupSubscriptionType,
  UpdateGroupRequest,
} from "@slipgate/contracts";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiModal from "../../components/ui/UiModal.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import { nanoToUsdInput, normalizeUsdInput, parseUsdToNano, USD_INPUT_PATTERN } from "../../components/admin/users/money";
import GroupApiKeysDrawer from "../../components/admin/groups/GroupApiKeysDrawer.vue";
import GroupRateMultipliersModal from "../../components/admin/groups/GroupRateMultipliersModal.vue";
import { parseLimit, useLimitText } from "../../components/admin/users/limits";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { PROVIDER_OPTIONS, formatUsd } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import UiSelect from "../../components/ui/UiSelect.vue";

const { t } = useI18n();
const { capText: limitText } = useLimitText();
const auth = useAuthStore();

const groups = ref<GroupItem[]>([]);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const notice = ref<string | null>(null);
const busyIds = ref(new Set<string>());

useFeedbackToasts(errorMessage, notice);

/* ---------------- Labels ---------------- */

function platformLabel(platform: string): string {
  if (platform === "composite") return t("groups.platforms.composite");
  return PROVIDER_OPTIONS.find((p) => p.value === platform)?.label ?? platform;
}

const platformOptions = computed<{ value: GroupPlatform; label: string }[]>(() => [
  { value: "composite", label: t("groups.platforms.composite") },
  ...PROVIDER_OPTIONS.map((p) => ({ value: p.value as GroupPlatform, label: p.label })),
]);

const billingOptions = computed<{ value: GroupSubscriptionType; label: string }[]>(() => [
  { value: "balance", label: t("groups.billing.balance") },
  { value: "subscription", label: t("groups.billing.subscription") },
]);

/* ---------------- Stats ---------------- */

const enabledCount = computed(() => groups.value.filter((g) => g.enabled).length);
const exclusiveCount = computed(() => groups.value.filter((g) => g.isExclusive).length);
const accountTotals = computed(() =>
  groups.value.reduce(
    (acc, g) => ({ active: acc.active + g.activeAccountCount, total: acc.total + g.accountCount }),
    { active: 0, total: 0 },
  ),
);
const apiKeyTotal = computed(() => groups.value.reduce((sum, g) => sum + g.apiKeyCount, 0));

/* ---------------- Filters ---------------- */

type StatusFilter = "all" | "enabled" | "disabled";
type TypeFilter = "all" | "public" | "exclusive";

const search = ref("");
const platformFilter = ref<"all" | GroupPlatform>("all");
const statusFilter = ref<StatusFilter>("all");
const typeFilter = ref<TypeFilter>("all");

const statusOptions = computed(() => [
  { value: "all" as const, label: t("common.all"), count: groups.value.length },
  { value: "enabled" as const, label: t("common.enabled"), count: enabledCount.value },
  { value: "disabled" as const, label: t("common.disabled"), count: groups.value.length - enabledCount.value },
]);

const typeOptions = computed<{ value: TypeFilter; label: string }[]>(() => [
  { value: "all", label: t("groups.filters.allTypes") },
  { value: "public", label: t("groups.type.public") },
  { value: "exclusive", label: t("groups.type.exclusive") },
]);

const hasFilters = computed(
  () =>
    search.value.trim() !== "" ||
    platformFilter.value !== "all" ||
    statusFilter.value !== "all" ||
    typeFilter.value !== "all",
);

const visibleGroups = computed(() => {
  const q = search.value.trim().toLowerCase();
  return groups.value
    .filter((g) => {
      if (q && ![g.name, g.description, g.id].some((v) => v.toLowerCase().includes(q))) return false;
      if (platformFilter.value !== "all" && g.platform !== platformFilter.value) return false;
      if (statusFilter.value === "enabled" && !g.enabled) return false;
      if (statusFilter.value === "disabled" && g.enabled) return false;
      if (typeFilter.value === "public" && g.isExclusive) return false;
      if (typeFilter.value === "exclusive" && !g.isExclusive) return false;
      return true;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
});

function resetFilters() {
  search.value = "";
  platformFilter.value = "all";
  statusFilter.value = "all";
  typeFilter.value = "all";
}

/* ---------------- API helpers ---------------- */

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string };
    return data.message || fallback;
  } catch {
    return fallback;
  }
}

function setBusy(id: string, busy: boolean) {
  const next = new Set(busyIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

async function loadGroups() {
  errorMessage.value = null;
  loading.value = true;
  try {
    const res = await auth.apiFetch("/api/v1/admin/groups");
    if (!res.ok) {
      errorMessage.value = await readError(res, t("groups.errors.load"));
      return;
    }
    groups.value = ((await res.json()) as { groups: GroupItem[] }).groups;
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("groups.errors.load");
  } finally {
    loading.value = false;
  }
}

async function toggleGroup(group: GroupItem) {
  errorMessage.value = null;
  notice.value = null;
  setBusy(group.id, true);
  try {
    const res = await auth.apiFetch(`/api/v1/admin/groups/${group.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !group.enabled } satisfies UpdateGroupRequest),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("groups.errors.toggle"));
      return;
    }
    notice.value = group.enabled
      ? t("groups.notice.disabled", { name: group.name })
      : t("groups.notice.enabled", { name: group.name });
    await loadGroups();
  } finally {
    setBusy(group.id, false);
  }
}

async function duplicateGroup(group: GroupItem) {
  errorMessage.value = null;
  notice.value = null;
  setBusy(group.id, true);
  try {
    const res = await auth.apiFetch(`/api/v1/admin/groups/${group.id}/duplicate`, { method: "POST" });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("groups.errors.duplicate"));
      return;
    }
    const { group: copy } = (await res.json()) as { group: GroupItem };
    notice.value = t("groups.notice.duplicated", { name: copy.name });
    await loadGroups();
  } finally {
    setBusy(group.id, false);
  }
}

async function deleteGroup(group: GroupItem) {
  errorMessage.value = null;
  notice.value = null;
  setBusy(group.id, true);
  try {
    const res = await auth.apiFetch(`/api/v1/admin/groups/${group.id}`, { method: "DELETE" });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("groups.errors.delete"));
      return;
    }
    const { ungroupedAccounts = 0 } = (await res.json().catch(() => ({}))) as { ungroupedAccounts?: number };
    notice.value =
      ungroupedAccounts > 0 ? t("groups.notice.deletedUngrouped", { n: ungroupedAccounts }) : t("groups.notice.deleted");
    await loadGroups();
  } finally {
    setBusy(group.id, false);
  }
}

/** API keys pin their group; accounts do not (deleting the group leaves them ungrouped). */
function deleteBlocked(group: GroupItem) {
  return group.apiKeyCount > 0;
}

function deleteLabel(group: GroupItem): string {
  if (deleteBlocked(group)) return t("groups.actions.deleteBlocked");
  return group.accountCount > 0 ? t("groups.actions.deleteUngroups", { n: group.accountCount }) : t("common.delete");
}

/* ---------------- Create / edit form ---------------- */

interface GroupForm {
  name: string;
  description: string;
  platform: GroupPlatform;
  subscriptionType: GroupSubscriptionType;
  rateMultiplier: number;
  sortOrder: number;
  allowlistText: string;
  isExclusive: boolean;
  enabled: boolean;
  /** Subscription caps as typed USD ("0" or empty = unlimited). */
  dailyLimitUsd: string;
  weeklyLimitUsd: string;
  monthlyLimitUsd: string;
  defaultValidityDays: number;
  /** Per-user caps inside the group across the user's keys (0 = none). Typed text or number. */
  rpmLimit: number | string;
  concurrencyLimit: number | string;
}

type CapField = "dailyLimitUsd" | "weeklyLimitUsd" | "monthlyLimitUsd";
type CapNanoField = "dailyLimitNanoUsd" | "weeklyLimitNanoUsd" | "monthlyLimitNanoUsd";
const CAP_FIELDS: { field: CapField; nano: CapNanoField; key: "daily" | "weekly" | "monthly" }[] = [
  { field: "dailyLimitUsd", nano: "dailyLimitNanoUsd", key: "daily" },
  { field: "weeklyLimitUsd", nano: "weeklyLimitNanoUsd", key: "weekly" },
  { field: "monthlyLimitUsd", nano: "monthlyLimitNanoUsd", key: "monthly" },
];

const formOpen = ref(false);
const saving = ref(false);
const editing = ref<GroupItem | null>(null);

function blankForm(): GroupForm {
  return {
    name: "",
    description: "",
    platform: "composite",
    subscriptionType: "balance",
    rateMultiplier: 1,
    sortOrder: 0,
    allowlistText: "",
    isExclusive: false,
    enabled: true,
    dailyLimitUsd: "0",
    weeklyLimitUsd: "0",
    monthlyLimitUsd: "0",
    defaultValidityDays: 30,
    rpmLimit: 0,
    concurrencyLimit: 0,
  };
}

const form = reactive<GroupForm>(blankForm());

/** Empty input means unlimited. */
function capText(value: string): string {
  return value.trim() === "" ? "0" : value;
}

function capInvalid(field: CapField): boolean {
  return normalizeUsdInput(capText(form[field])) === null;
}

const validityInvalid = computed(
  () => !Number.isInteger(form.defaultValidityDays) || form.defaultValidityDays < 1 || form.defaultValidityDays > 3650,
);

const capsInvalid = computed(
  () => form.subscriptionType === "subscription" && (CAP_FIELDS.some((c) => capInvalid(c.field)) || validityInvalid.value),
);

/** Per-user caps: empty means 0 (no cap). */
const userCap = (v: number | string) => (String(v).trim() === "" ? 0 : parseLimit(v));
const userCapsInvalid = computed(() => userCap(form.rpmLimit) === null || userCap(form.concurrencyLimit) === null);

/** Compact "D $10 · W $50" chips for the table; windows without a cap are left out. */
function groupCaps(group: GroupItem): { key: string; text: string }[] {
  return CAP_FIELDS.filter((c) => /^\d+$/.test(group[c.nano]) && !/^0+$/.test(group[c.nano])).map((c) => ({
    key: c.key,
    text: `${t(`groups.caps.short.${c.key}`)} ${formatUsd(group[c.nano])}`,
  }));
}

function parseAllowlist(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,]/)) {
    const model = raw.trim();
    if (model) seen.add(model);
  }
  return [...seen];
}

function openCreate() {
  editing.value = null;
  Object.assign(form, blankForm());
  formOpen.value = true;
}

function openEdit(group: GroupItem) {
  editing.value = group;
  Object.assign(form, {
    name: group.name,
    description: group.description,
    platform: group.platform,
    subscriptionType: group.subscriptionType,
    rateMultiplier: group.rateMultiplier,
    sortOrder: group.sortOrder,
    allowlistText: group.modelAllowlist.join("\n"),
    isExclusive: group.isExclusive,
    enabled: group.enabled,
    dailyLimitUsd: nanoToUsdInput(group.dailyLimitNanoUsd),
    weeklyLimitUsd: nanoToUsdInput(group.weeklyLimitNanoUsd),
    monthlyLimitUsd: nanoToUsdInput(group.monthlyLimitNanoUsd),
    defaultValidityDays: group.defaultValidityDays,
    rpmLimit: group.rpmLimit ?? 0,
    concurrencyLimit: group.concurrencyLimit ?? 0,
  } satisfies GroupForm);
  formOpen.value = true;
}

function buildPatch(original: GroupItem): UpdateGroupRequest {
  const patch: UpdateGroupRequest = {};
  const name = form.name.trim();
  const description = form.description.trim();
  const allowlist = parseAllowlist(form.allowlistText);
  if (name !== original.name) patch.name = name;
  if (description !== original.description) patch.description = description;
  if (form.subscriptionType !== original.subscriptionType) patch.subscriptionType = form.subscriptionType;
  if (form.rateMultiplier !== original.rateMultiplier) patch.rateMultiplier = form.rateMultiplier;
  if (form.sortOrder !== original.sortOrder) patch.sortOrder = form.sortOrder;
  if (allowlist.join("\n") !== original.modelAllowlist.join("\n")) patch.modelAllowlist = allowlist;
  if (form.isExclusive !== original.isExclusive) patch.isExclusive = form.isExclusive;
  if (form.enabled !== original.enabled) patch.enabled = form.enabled;
  const rpmCap = userCap(form.rpmLimit);
  const concCap = userCap(form.concurrencyLimit);
  if (rpmCap !== null && rpmCap !== (original.rpmLimit ?? 0)) patch.rpmLimit = rpmCap;
  if (concCap !== null && concCap !== (original.concurrencyLimit ?? 0)) patch.concurrencyLimit = concCap;
  // Caps only matter (and are only shown) for subscription billing.
  if (form.subscriptionType === "subscription") {
    for (const c of CAP_FIELDS) {
      const next = parseUsdToNano(capText(form[c.field]));
      let current: bigint | null;
      try {
        current = BigInt(original[c.nano] || "0");
      } catch {
        current = null;
      }
      if (next !== null && next !== current) patch[c.field] = nanoToUsdInput(next);
    }
    if (form.defaultValidityDays !== original.defaultValidityDays) patch.defaultValidityDays = form.defaultValidityDays;
  }
  return patch;
}

async function submitForm() {
  if (capsInvalid.value || userCapsInvalid.value) return;
  errorMessage.value = null;
  notice.value = null;
  saving.value = true;
  try {
    const original = editing.value;
    if (original) {
      const patch = buildPatch(original);
      if (Object.keys(patch).length === 0) {
        formOpen.value = false;
        return;
      }
      const res = await auth.apiFetch(`/api/v1/admin/groups/${original.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        errorMessage.value = await readError(res, t("groups.errors.save"));
        return;
      }
      const { group } = (await res.json()) as { group: GroupItem };
      notice.value = t("groups.notice.saved", { name: group.name });
    } else {
      const body: CreateGroupRequest = {
        name: form.name.trim(),
        description: form.description.trim(),
        platform: form.platform,
        subscriptionType: form.subscriptionType,
        rateMultiplier: form.rateMultiplier,
        modelAllowlist: parseAllowlist(form.allowlistText),
        isExclusive: form.isExclusive,
        sortOrder: form.sortOrder,
        enabled: form.enabled,
        rpmLimit: userCap(form.rpmLimit) ?? 0,
        concurrencyLimit: userCap(form.concurrencyLimit) ?? 0,
        ...(form.subscriptionType === "subscription"
          ? {
              dailyLimitUsd: normalizeUsdInput(capText(form.dailyLimitUsd)) ?? "0",
              weeklyLimitUsd: normalizeUsdInput(capText(form.weeklyLimitUsd)) ?? "0",
              monthlyLimitUsd: normalizeUsdInput(capText(form.monthlyLimitUsd)) ?? "0",
              defaultValidityDays: form.defaultValidityDays,
            }
          : { dailyLimitUsd: "0", weeklyLimitUsd: "0", monthlyLimitUsd: "0", defaultValidityDays: 30 }),
      };
      const res = await auth.apiFetch("/api/v1/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        errorMessage.value = await readError(res, t("groups.errors.create"));
        return;
      }
      const { group } = (await res.json()) as { group: GroupItem };
      notice.value = t("groups.notice.created", { name: group.name });
    }
    formOpen.value = false;
    await loadGroups();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("common.networkError");
  } finally {
    saving.value = false;
  }
}

/* ---------------- Per-user rates & group keys ---------------- */

const ratesOpen = ref(false);
const keysOpen = ref(false);
const target = ref<GroupItem | null>(null);

function openRates(group: GroupItem) {
  target.value = group;
  ratesOpen.value = true;
}
function openKeys(group: GroupItem) {
  target.value = group;
  keysOpen.value = true;
}

onMounted(() => {
  void loadGroups();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.groups')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadGroups">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button type="button" class="btn btn-primary" @click="openCreate">
          <UiIcon name="plus" :size="15" />
          {{ t("groups.actions.create") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        :label="t('groups.stats.groups')"
        :value="`${enabledCount} / ${groups.length}`"
        icon="layers"
        tone="accent"
      />
      <StatCard :label="t('groups.stats.exclusive')" :value="exclusiveCount" icon="lock" tone="violet" />
      <StatCard
        :label="t('groups.stats.accounts')"
        :value="`${accountTotals.active} / ${accountTotals.total}`"
        icon="users"
        tone="success"
      />
      <StatCard :label="t('groups.stats.apiKeys')" :value="apiKeyTotal" icon="key" tone="info" />
    </div>

    <UiCard icon="layers" :title="t('groups.list.title')" flush>
      <template #actions>
        <SegmentedControl v-model="statusFilter" :options="statusOptions" />
      </template>

      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span class="sr-only">{{ t("common.search") }}</span>
          <UiIcon
            name="search"
            :size="14"
            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            v-model="search"
            type="search"
            class="input input-sm pl-8"
            :placeholder="t('groups.list.searchPlaceholder')"
          />
        </label>
        <UiSelect v-model="platformFilter" class="select input-sm w-auto min-w-[9rem]" :aria-label="t('groups.table.platform')">
          <option value="all">{{ t("groups.filters.allPlatforms") }}</option>
          <option v-for="opt in platformOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </UiSelect>
        <UiSelect v-model="typeFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('groups.table.type')">
          <option v-for="opt in typeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </UiSelect>
      </div>

      <EmptyState v-if="groups.length === 0 && !loading" icon="layers" :title="t('groups.list.empty')">
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <UiIcon name="plus" :size="14" />
          {{ t("groups.actions.create") }}
        </button>
      </EmptyState>
      <EmptyState v-else-if="visibleGroups.length === 0 && hasFilters" icon="search" :title="t('groups.list.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("groups.list.clearFilters") }}
        </button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("groups.table.name") }}</th>
              <th>{{ t("groups.table.platform") }}</th>
              <th>{{ t("groups.table.billing") }}</th>
              <th class="text-right">{{ t("groups.table.rate") }}</th>
              <th>{{ t("groups.table.type") }}</th>
              <th class="text-right">{{ t("groups.table.accounts") }}</th>
              <th class="text-right">{{ t("groups.table.apiKeys") }}</th>
              <th>{{ t("common.status") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in visibleGroups" :key="g.id" :class="g.enabled ? '' : 'opacity-70'">
              <td class="max-w-[18rem]">
                <p class="truncate font-semibold text-fg">{{ g.name }}</p>
                <p v-if="g.description" class="mt-0.5 truncate text-xs text-fg-muted" :title="g.description">
                  {{ g.description }}
                </p>
                <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{{ g.id }}</p>
              </td>
              <td><UiBadge tone="accent">{{ platformLabel(g.platform) }}</UiBadge></td>
              <td class="whitespace-nowrap text-xs text-fg">
                <template v-if="g.subscriptionType === 'subscription'">
                  <p class="flex items-center gap-1.5">
                    <UiIcon name="badge-check" :size="12" class="text-violet" />
                    {{ t("groups.billing.subscription") }}
                    <span class="text-2xs text-fg-subtle">· {{ t("groups.caps.days", { n: g.defaultValidityDays }) }}</span>
                  </p>
                  <p class="mt-1 flex flex-wrap gap-1">
                    <template v-if="groupCaps(g).length">
                      <span v-for="c in groupCaps(g)" :key="c.key" class="code-chip tabular-nums">{{ c.text }}</span>
                    </template>
                    <span v-else class="code-chip">∞ {{ t("groups.caps.unlimited") }}</span>
                  </p>
                </template>
                <template v-else>{{ t("groups.billing.balance") }}</template>
              </td>
              <td class="whitespace-nowrap text-right">
                <p class="font-mono text-xs tabular-nums text-fg">{{ g.rateMultiplier }}×</p>
                <p v-if="g.rpmLimit > 0 || g.concurrencyLimit > 0" class="mt-1 flex justify-end gap-1">
                  <span v-if="g.rpmLimit > 0" class="code-chip tabular-nums" :title="t('userLimits.groupForm.rpm')">{{ limitText(g.rpmLimit, "rpm") }}</span>
                  <span v-if="g.concurrencyLimit > 0" class="code-chip tabular-nums" :title="t('userLimits.groupForm.concurrency')">
                    {{ limitText(g.concurrencyLimit, "concurrency") }}
                  </span>
                </p>
              </td>
              <td>
                <UiBadge :tone="g.isExclusive ? 'violet' : 'neutral'">
                  {{ g.isExclusive ? t("groups.type.exclusive") : t("groups.type.public") }}
                </UiBadge>
              </td>
              <td class="text-right">
                <RouterLink
                  :to="{ path: '/admin/accounts', query: { groupId: g.id } }"
                  class="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums text-accent transition-colors hover:bg-accent/10"
                  :title="t('groups.actions.viewAccounts')"
                >
                  {{ g.activeAccountCount }} / {{ g.accountCount }}
                  <UiIcon name="chevron-right" :size="12" />
                </RouterLink>
              </td>
              <td class="text-right">
                <button
                  type="button"
                  class="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums transition-colors hover:bg-accent/10 hover:text-accent"
                  :class="g.apiKeyCount > 0 ? 'text-fg' : 'text-fg-subtle'"
                  :title="t('userLimits.groupKeys.open')"
                  :aria-label="t('userLimits.groupKeys.openFor', { name: g.name })"
                  @click="openKeys(g)"
                >
                  {{ g.apiKeyCount }}
                  <UiIcon name="chevron-right" :size="12" />
                </button>
              </td>
              <td>
                <UiSwitch
                  :model-value="g.enabled"
                  :disabled="busyIds.has(g.id)"
                  :label="g.enabled ? t('common.enabled') : t('common.disabled')"
                  @update:model-value="toggleGroup(g)"
                />
              </td>
              <td class="text-right">
                <div class="inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :title="t('userLimits.groupRates.open')"
                    :aria-label="t('userLimits.groupRates.openFor', { name: g.name })"
                    @click="openRates(g)"
                  >
                    <UiIcon name="percent" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :title="t('groups.actions.edit')"
                    :aria-label="t('groups.actions.edit')"
                    @click="openEdit(g)"
                  >
                    <UiIcon name="pencil" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :disabled="busyIds.has(g.id)"
                    :title="t('groups.actions.duplicate')"
                    :aria-label="t('groups.actions.duplicate')"
                    @click="duplicateGroup(g)"
                  >
                    <UiIcon name="copy" :size="13" />
                  </button>
                  <ConfirmButton
                    icon-only
                    :disabled="deleteBlocked(g) || busyIds.has(g.id)"
                    :label="deleteLabel(g)"
                    :confirm-label="g.accountCount > 0 ? t('groups.actions.confirmDeleteUngroups', { n: g.accountCount }) : undefined"
                    @confirm="deleteGroup(g)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiModal
      v-model:open="formOpen"
      width="lg"
      :title="editing ? t('groups.form.editTitle') : t('groups.form.createTitle')"
    >
      <template #icon>
        <span class="icon-chip icon-chip-accent h-8 w-8">
          <UiIcon :name="editing ? 'pencil' : 'layers'" :size="15" />
        </span>
      </template>
      <form id="group-form" class="grid gap-4 sm:grid-cols-2" @submit.prevent="submitForm">
        <FormField :label="t('groups.form.name')" required>
          <input
            v-model="form.name"
            type="text"
            required
            maxlength="64"
            :placeholder="t('groups.form.namePlaceholder')"
            class="input"
          />
        </FormField>
        <FormField :label="t('groups.form.platform')">
          <span class="relative block">
            <UiSelect v-model="form.platform" class="select" :disabled="Boolean(editing)">
              <option v-for="opt in platformOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </UiSelect>
            <UiIcon
              v-if="editing"
              name="lock"
              :size="13"
              class="pointer-events-none absolute right-8 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
          </span>
        </FormField>
        <FormField :label="t('groups.form.description')" class="sm:col-span-2">
          <textarea
            v-model="form.description"
            rows="2"
            maxlength="500"
            :placeholder="t('groups.form.descriptionPlaceholder')"
            class="textarea"
          />
        </FormField>
        <div class="sm:col-span-2">
          <p class="label">{{ t("groups.form.billing") }}</p>
          <SegmentedControl v-model="form.subscriptionType" :options="billingOptions" size="md" block />
        </div>
        <Transition
          enter-active-class="transition duration-200 ease-out"
          leave-active-class="transition duration-150 ease-in"
          enter-from-class="-translate-y-1 opacity-0"
          leave-to-class="-translate-y-1 opacity-0"
        >
          <fieldset
            v-if="form.subscriptionType === 'subscription'"
            class="min-w-0 rounded-lg border border-violet/25 bg-violet/[0.04] p-3.5 sm:col-span-2"
          >
            <legend class="sr-only">{{ t("groups.caps.title") }}</legend>
            <div class="mb-3 flex items-start gap-2.5">
              <span class="icon-chip icon-chip-violet h-7 w-7"><UiIcon name="gauge" :size="14" /></span>
              <div class="min-w-0">
                <p class="text-sm font-medium text-fg">{{ t("groups.caps.title") }}</p>
                <p class="text-xs text-fg-subtle">{{ t("groups.caps.hint") }}</p>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <FormField v-for="c in CAP_FIELDS" :key="c.field" :label="t(`groups.caps.${c.key}`)">
                <span class="relative block">
                  <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-fg-subtle">$</span>
                  <input
                    v-model="form[c.field]"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    :pattern="USD_INPUT_PATTERN"
                    placeholder="0"
                    class="input pl-7 font-mono"
                    :class="capInvalid(c.field) ? '!border-danger focus:!ring-danger/20' : ''"
                    :aria-invalid="capInvalid(c.field)"
                  />
                </span>
              </FormField>
              <FormField :label="t('groups.caps.validity')">
                <input
                  v-model.number="form.defaultValidityDays"
                  type="number"
                  min="1"
                  max="3650"
                  step="1"
                  required
                  class="input font-mono"
                  :class="validityInvalid ? '!border-danger focus:!ring-danger/20' : ''"
                />
              </FormField>
            </div>
            <p class="hint" :class="capsInvalid ? '!text-danger' : ''">
              {{ capsInvalid ? t("groups.caps.invalid") : t("groups.caps.validityHint") }}
            </p>
          </fieldset>
        </Transition>
        <FormField :label="t('groups.form.rate')">
          <input
            v-model.number="form.rateMultiplier"
            type="number"
            step="0.1"
            min="0.01"
            max="100"
            required
            class="input font-mono"
          />
        </FormField>
        <FormField :label="t('groups.form.sortOrder')">
          <input v-model.number="form.sortOrder" type="number" step="1" class="input font-mono" />
        </FormField>
        <fieldset class="min-w-0 rounded-lg border border-line/80 bg-surface-2/30 p-3.5 sm:col-span-2">
          <legend class="sr-only">{{ t("userLimits.groupForm.title") }}</legend>
          <div class="mb-3 flex items-start gap-2.5">
            <span class="icon-chip icon-chip-accent h-7 w-7"><UiIcon name="gauge" :size="14" /></span>
            <div class="min-w-0">
              <p class="text-sm font-medium text-fg">{{ t("userLimits.groupForm.title") }}</p>
              <p class="text-xs text-fg-subtle">{{ t("userLimits.groupForm.hint") }}</p>
            </div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <FormField :label="t('userLimits.groupForm.rpm')">
              <input
                v-model.number="form.rpmLimit"
                type="number"
                min="0"
                max="1000000"
                step="1"
                placeholder="0"
                class="input font-mono"
                :class="userCap(form.rpmLimit) === null ? '!border-danger focus:!ring-danger/20' : ''"
                :aria-invalid="userCap(form.rpmLimit) === null || undefined"
              />
            </FormField>
            <FormField :label="t('userLimits.groupForm.concurrency')">
              <input
                v-model.number="form.concurrencyLimit"
                type="number"
                min="0"
                max="1000000"
                step="1"
                placeholder="0"
                class="input font-mono"
                :class="userCap(form.concurrencyLimit) === null ? '!border-danger focus:!ring-danger/20' : ''"
                :aria-invalid="userCap(form.concurrencyLimit) === null || undefined"
              />
            </FormField>
          </div>
          <p class="hint" :class="userCapsInvalid ? '!text-danger' : ''">
            {{ userCapsInvalid ? t("userLimits.groupForm.invalid") : t("userLimits.groupForm.zeroNone") }}
          </p>
        </fieldset>
        <FormField :label="t('groups.form.allowlist')" class="sm:col-span-2">
          <textarea
            v-model="form.allowlistText"
            rows="4"
            spellcheck="false"
            :placeholder="t('groups.form.allowlistPlaceholder')"
            class="textarea font-mono text-xs"
          />
        </FormField>
        <div class="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/40 px-3.5 py-3">
          <p class="flex items-center gap-2 text-sm font-medium text-fg">
            <UiIcon name="lock" :size="14" class="text-violet" />
            {{ t("groups.form.exclusive") }}
          </p>
          <UiSwitch v-model="form.isExclusive" tone="accent" :label="t('groups.form.exclusive')" hide-label />
        </div>
        <div class="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/40 px-3.5 py-3">
          <p class="flex items-center gap-2 text-sm font-medium text-fg">
            <UiIcon name="check-circle" :size="14" class="text-success" />
            {{ t("groups.form.enabled") }}
          </p>
          <UiSwitch v-model="form.enabled" :label="t('groups.form.enabled')" hide-label />
        </div>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="formOpen = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="group-form" class="btn btn-primary" :disabled="saving || capsInvalid || userCapsInvalid">
          <UiIcon v-if="saving" name="loader" :size="15" spin />
          {{ editing ? t("groups.form.submitSave") : t("groups.form.submitCreate") }}
        </button>
      </template>
    </UiModal>

    <GroupRateMultipliersModal v-model:open="ratesOpen" :group="target" />
    <GroupApiKeysDrawer v-model:open="keysOpen" :group="target" />
  </div>
</template>
