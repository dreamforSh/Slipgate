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
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { PROVIDER_OPTIONS } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const { t } = useI18n();
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
    notice.value = t("groups.notice.deleted");
    await loadGroups();
  } finally {
    setBusy(group.id, false);
  }
}

function isInUse(group: GroupItem) {
  return group.accountCount > 0 || group.apiKeyCount > 0;
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
}

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
  };
}

const form = reactive<GroupForm>(blankForm());

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
  return patch;
}

async function submitForm() {
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
        <select v-model="platformFilter" class="select input-sm w-auto min-w-[9rem]" :aria-label="t('groups.table.platform')">
          <option value="all">{{ t("groups.filters.allPlatforms") }}</option>
          <option v-for="opt in platformOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <select v-model="typeFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('groups.table.type')">
          <option v-for="opt in typeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
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
                {{ g.subscriptionType === "subscription" ? t("groups.billing.subscription") : t("groups.billing.balance") }}
              </td>
              <td class="text-right font-mono text-xs tabular-nums text-fg">{{ g.rateMultiplier }}×</td>
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
              <td class="text-right font-mono text-xs tabular-nums text-fg">{{ g.apiKeyCount }}</td>
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
                    :disabled="isInUse(g) || busyIds.has(g.id)"
                    :label="isInUse(g) ? t('groups.actions.deleteBlocked') : t('common.delete')"
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
            <select v-model="form.platform" class="select" :disabled="Boolean(editing)">
              <option v-for="opt in platformOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
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
        <button type="submit" form="group-form" class="btn btn-primary" :disabled="saving">
          <UiIcon v-if="saving" name="loader" :size="15" spin />
          {{ editing ? t("groups.form.submitSave") : t("groups.form.submitCreate") }}
        </button>
      </template>
    </UiModal>
  </div>
</template>
