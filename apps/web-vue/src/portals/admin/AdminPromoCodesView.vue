<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { PromoCodeItem, UpdatePromoCodeRequest } from "@slipgate/contracts";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import PromoFormModal from "../../components/admin/ops/PromoFormModal.vue";
import PromoUsagesDrawer from "../../components/admin/ops/PromoUsagesDrawer.vue";
import { isPast, STAGGER_CLASS, stagger } from "../../components/admin/ops/opsUtil";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import { apiJson, errorText } from "../../lib/api";
import { formatDateTime, formatNumber, formatRelative, formatUsd, type Tone } from "../../lib/format";
import { usePortalStore } from "../../stores/portal";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const portal = usePortalStore();
const toast = useToastStore();

const items = ref<PromoCodeItem[]>([]);
const loading = ref(false);
const loaded = ref(false);
const busyIds = ref(new Set<string>());

function setBusy(id: string, busy: boolean) {
  const next = new Set(busyIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

async function load() {
  loading.value = true;
  try {
    items.value = (await apiJson<{ items: PromoCodeItem[] }>("/api/v1/admin/promo-codes", { fallbackError: t("promo.errors.load") })).items;
    loaded.value = true;
  } catch (err) {
    toast.error(errorText(err, t("promo.errors.load")));
  } finally {
    loading.value = false;
  }
}

/* ---------------- Derived status ---------------- */

type PromoStatus = "enabled" | "disabled" | "expired" | "exhausted";

function statusOf(p: PromoCodeItem): PromoStatus {
  if (!p.enabled) return "disabled";
  if (isPast(p.expiresAtIso)) return "expired";
  if (p.maxUses > 0 && p.usedCount >= p.maxUses) return "exhausted";
  return "enabled";
}

const statusTone: Record<PromoStatus, Tone> = {
  enabled: "success",
  disabled: "neutral",
  expired: "warning",
  exhausted: "info",
};

const activeCount = computed(() => items.value.filter((p) => statusOf(p) === "enabled").length);
const totalUses = computed(() => items.value.reduce((sum, p) => sum + p.usedCount, 0));

/* ---------------- Filters ---------------- */

type Filter = "all" | "active" | "inactive";
const filter = ref<Filter>("all");
const search = ref("");

const filterOptions = computed(() => [
  { value: "all" as const, label: t("promo.filters.all"), count: items.value.length },
  { value: "active" as const, label: t("promo.filters.active"), count: activeCount.value },
  { value: "inactive" as const, label: t("promo.filters.inactive"), count: items.value.length - activeCount.value },
]);

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return items.value
    .filter((p) => {
      const active = statusOf(p) === "enabled";
      if (filter.value === "active" && !active) return false;
      if (filter.value === "inactive" && active) return false;
      if (q && !p.code.toLowerCase().includes(q) && !p.notes.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
});

function resetFilters() {
  filter.value = "all";
  search.value = "";
}

/* ---------------- Row actions ---------------- */

function usagePercent(p: PromoCodeItem): number {
  if (p.maxUses <= 0) return 0;
  return Math.min(100, Math.round((p.usedCount / p.maxUses) * 100));
}

async function copyLink(p: PromoCodeItem) {
  const url = `${location.origin}/register?promo=${encodeURIComponent(p.code)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast.success(t("promo.actions.linkCopied"));
  } catch {
    toast.error(t("promo.errors.copy"));
  }
}

async function toggle(p: PromoCodeItem) {
  setBusy(p.id, true);
  try {
    const body: UpdatePromoCodeRequest = { enabled: !p.enabled };
    const { item } = await apiJson<{ item: PromoCodeItem }>(`/api/v1/admin/promo-codes/${encodeURIComponent(p.id)}`, {
      method: "PATCH",
      body,
      fallbackError: t("promo.errors.toggle"),
    });
    items.value = items.value.map((x) => (x.id === item.id ? item : x));
    toast.success(item.enabled ? t("promo.notice.enabled", { code: item.code }) : t("promo.notice.disabled", { code: item.code }));
  } catch (err) {
    toast.error(errorText(err, t("promo.errors.toggle")));
  } finally {
    setBusy(p.id, false);
  }
}

async function remove(p: PromoCodeItem) {
  setBusy(p.id, true);
  try {
    await apiJson(`/api/v1/admin/promo-codes/${encodeURIComponent(p.id)}`, { method: "DELETE", fallbackError: t("promo.errors.delete") });
    items.value = items.value.filter((x) => x.id !== p.id);
    toast.success(t("promo.notice.deleted", { code: p.code }));
  } catch (err) {
    toast.error(errorText(err, t("promo.errors.delete")));
  } finally {
    setBusy(p.id, false);
  }
}

/* ---------------- Modals ---------------- */

const formOpen = ref(false);
const editing = ref<PromoCodeItem | null>(null);
const usagesOpen = ref(false);
const usagesItem = ref<PromoCodeItem | null>(null);

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}

function openEdit(p: PromoCodeItem) {
  editing.value = p;
  formOpen.value = true;
}

function openUsages(p: PromoCodeItem) {
  usagesItem.value = p;
  usagesOpen.value = true;
}

function onSaved(item: PromoCodeItem, created: boolean) {
  if (created) items.value = [item, ...items.value];
  else items.value = items.value.map((x) => (x.id === item.id ? item : x));
  toast.success(created ? t("promo.notice.created", { code: item.code }) : t("promo.notice.saved", { code: item.code }));
}

onMounted(() => {
  void portal.load();
  void load();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.promoCodes')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <button type="button" class="btn btn-primary" @click="openCreate">
          <UiIcon name="plus" :size="15" />
          {{ t("promo.actions.create") }}
        </button>
      </template>
    </PageHeader>

    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="-translate-y-1 opacity-0"
    >
      <UiAlert v-if="portal.settings && !portal.settings.promoCodeEnabled" tone="warning" :title="t('promo.disabledAlert.title')">
        {{ t("promo.disabledAlert.body") }}
        <template #action>
          <RouterLink to="/admin/settings" class="btn btn-secondary btn-sm shrink-0 self-center">
            <UiIcon name="settings" :size="14" />
            <span class="hidden sm:inline">{{ t("promo.disabledAlert.action") }}</span>
          </RouterLink>
        </template>
      </UiAlert>
    </Transition>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard :label="t('promo.stats.total')" :value="formatNumber(items.length)" icon="percent" tone="accent" />
      <StatCard :label="t('promo.stats.active')" :value="formatNumber(activeCount)" icon="check-circle" tone="success" />
      <StatCard :label="t('promo.stats.uses')" :value="formatNumber(totalUses)" icon="user-plus" tone="info" />
      <StatCard
        :label="t('promo.stats.inactive')"
        :value="formatNumber(items.length - activeCount)"
        icon="x-circle"
        tone="warning"
      />
    </div>

    <UiCard icon="percent" :title="t('promo.list.title')" flush>
      <template #actions>
        <SegmentedControl v-model="filter" :options="filterOptions" />
      </template>

      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span class="sr-only">{{ t("common.search") }}</span>
          <UiIcon
            name="search"
            :size="14"
            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input v-model="search" type="search" class="input input-sm pl-8" :placeholder="t('promo.list.searchPlaceholder')" />
        </label>
      </div>

      <ListSkeleton v-if="!loaded && loading" :rows="4" />
      <EmptyState v-else-if="items.length === 0" icon="percent" :title="t('promo.list.empty')">
        <p class="w-full max-w-xs text-xs text-fg-subtle">{{ t("promo.list.emptyHint") }}</p>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <UiIcon name="plus" :size="14" />
          {{ t("promo.actions.create") }}
        </button>
      </EmptyState>
      <EmptyState v-else-if="visible.length === 0" icon="search" :title="t('promo.list.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("promo.list.clearFilters") }}
        </button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("promo.table.code") }}</th>
              <th class="text-right">{{ t("promo.table.bonus") }}</th>
              <th>{{ t("promo.table.uses") }}</th>
              <th>{{ t("promo.table.status") }}</th>
              <th>{{ t("promo.table.expires") }}</th>
              <th>{{ t("promo.table.notes") }}</th>
              <th>{{ t("promo.table.created") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(p, i) in visible"
              :key="p.id"
              :class="[STAGGER_CLASS, statusOf(p) === 'enabled' ? '' : 'opacity-75']"
              :style="stagger(i)"
            >
              <td class="whitespace-nowrap">
                <span class="inline-flex items-center gap-1">
                  <span class="font-mono text-xs font-semibold tracking-wider text-fg">{{ p.code }}</span>
                  <CopyButton :text="p.code" />
                </span>
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs font-semibold tabular-nums text-success">
                +{{ formatUsd(p.bonusNanoUsd) }}
              </td>
              <td class="min-w-[7rem]">
                <p class="font-mono text-xs tabular-nums text-fg">
                  {{ formatNumber(p.usedCount) }}
                  <span class="text-fg-subtle">/ {{ p.maxUses > 0 ? formatNumber(p.maxUses) : "∞" }}</span>
                </p>
                <div v-if="p.maxUses > 0" class="mt-1 h-1 w-20 overflow-hidden rounded-full bg-surface-2">
                  <div
                    class="h-full rounded-full transition-[width] duration-500 ease-out"
                    :class="usagePercent(p) >= 100 ? 'bg-info' : usagePercent(p) >= 80 ? 'bg-warning' : 'bg-accent'"
                    :style="{ width: `${usagePercent(p)}%` }"
                  />
                </div>
              </td>
              <td>
                <UiBadge :tone="statusTone[statusOf(p)]" dot>{{ t(`promo.status.${statusOf(p)}`) }}</UiBadge>
              </td>
              <td class="whitespace-nowrap text-xs">
                <span v-if="!p.expiresAtIso" class="text-fg-subtle">{{ t("promo.never") }}</span>
                <span v-else :class="isPast(p.expiresAtIso) ? 'text-warning' : 'text-fg-muted'" :title="formatRelative(p.expiresAtIso)">
                  {{ formatDateTime(p.expiresAtIso) }}
                </span>
              </td>
              <td class="max-w-[12rem]">
                <p v-if="p.notes" class="truncate text-xs text-fg-muted" :title="p.notes">{{ p.notes }}</p>
                <span v-else class="text-xs text-fg-subtle">-</span>
              </td>
              <td class="whitespace-nowrap text-xs text-fg-subtle" :title="formatDateTime(p.createdAtIso)">
                {{ formatRelative(p.createdAtIso) }}
              </td>
              <td class="text-right">
                <div class="inline-flex items-center gap-0.5">
                  <UiSwitch
                    class="mr-1.5"
                    :model-value="p.enabled"
                    :disabled="busyIds.has(p.id)"
                    :label="p.enabled ? t('promo.actions.disable') : t('promo.actions.enable')"
                    hide-label
                    @update:model-value="toggle(p)"
                  />
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :title="t('promo.actions.copyLink')"
                    :aria-label="t('promo.actions.copyLink')"
                    @click="copyLink(p)"
                  >
                    <UiIcon name="link" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :title="t('promo.actions.usages')"
                    :aria-label="t('promo.actions.usages')"
                    @click="openUsages(p)"
                  >
                    <UiIcon name="users" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :title="t('promo.actions.edit')"
                    :aria-label="t('promo.actions.edit')"
                    @click="openEdit(p)"
                  >
                    <UiIcon name="pencil" :size="13" />
                  </button>
                  <ConfirmButton icon-only :disabled="busyIds.has(p.id)" @confirm="remove(p)" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <PromoFormModal v-model:open="formOpen" :item="editing" @saved="onSaved" />
    <PromoUsagesDrawer v-model:open="usagesOpen" :item="usagesItem" />
  </div>
</template>
