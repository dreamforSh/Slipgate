<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type {
  AffiliateAccountItem,
  AffiliateRebateItem,
  AffiliateWithdrawalItem,
  AffiliateWithdrawalStatus,
} from "@slipgate/contracts";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import { STAGGER_CLASS, stagger, sumNano } from "../../components/payments/paymentUtil";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiModal from "../../components/ui/UiModal.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { useNow } from "../../composables/useNow";
import { apiJson, errorText, toQuery } from "../../lib/api";
import { formatDateTime, formatNumber, formatRelative, formatUsd, type Tone } from "../../lib/format";
import { useToastStore } from "../../stores/toast";
import UiSelect from "../../components/ui/UiSelect.vue";

const API_LIMIT = 200;

const { t } = useI18n();
const toast = useToastStore();
const now = useNow(60_000);

type TabKey = "rebates" | "accounts" | "withdrawals";
const activeTab = ref<TabKey>("rebates");

/* ---------------- Rebates ---------------- */

const items = ref<AffiliateRebateItem[]>([]);
const loading = ref(false);
const loaded = ref(false);

async function loadRebates() {
  loading.value = true;
  try {
    items.value = (
      await apiJson<{ items: AffiliateRebateItem[] }>("/api/v1/admin/affiliates/rebates", {
        fallbackError: t("payments.admin.rebates.loadFailed"),
      })
    ).items;
    loaded.value = true;
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.rebates.loadFailed")));
  } finally {
    loading.value = false;
  }
}

const totalNano = computed(() => sumNano(items.value.map((r) => r.amountNanoUsd)));
const beneficiaries = computed(() => new Set(items.value.map((r) => r.beneficiaryId)).size);
const recentNano = computed(() => {
  const cutoff = now.value - 30 * 86_400_000;
  return sumNano(items.value.filter((r) => Date.parse(r.createdAtIso) >= cutoff).map((r) => r.amountNanoUsd));
});

const search = ref("");
const page = ref(1);
const pageSize = ref(20);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = [...items.value].sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
  if (!q) return list;
  return list.filter((r) =>
    [r.beneficiaryEmail, r.inviteeEmail, r.orderId, r.beneficiaryId].some((v) => v.toLowerCase().includes(q)),
  );
});
const filteredTotal = computed(() => sumNano(filtered.value.map((r) => r.amountNanoUsd)));
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));

watch([search, pageSize], () => (page.value = 1));

function shortId(id: string) {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}

/* ---------------- Accounts & Custom Rates ---------------- */

const accounts = ref<AffiliateAccountItem[]>([]);
const accountsLoading = ref(false);
const accountsLoaded = ref(false);
const accountSearch = ref("");

async function loadAccounts() {
  accountsLoading.value = true;
  try {
    const q = toQuery({ search: accountSearch.value.trim() || undefined });
    accounts.value = (
      await apiJson<{ items: AffiliateAccountItem[] }>(`/api/v1/admin/affiliates/accounts${q}`, {
        fallbackError: t("payments.admin.rebates.accounts.loadFailed"),
      })
    ).items;
    accountsLoaded.value = true;
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.rebates.accounts.loadFailed")));
  } finally {
    accountsLoading.value = false;
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(accountSearch, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadAccounts(), 250);
});

const rateModalOpen = ref(false);
const editingAccount = ref<AffiliateAccountItem | null>(null);
const ratePercentInput = ref<string>("10");
const rateSaving = ref(false);

function openRateModal(acc: AffiliateAccountItem) {
  editingAccount.value = acc;
  ratePercentInput.value = String(Number((acc.effectiveRebateBps / 100).toFixed(2)));
  rateModalOpen.value = true;
}

async function saveCustomRate(customBps: number | null) {
  if (!editingAccount.value) return;
  rateSaving.value = true;
  try {
    await apiJson(`/api/v1/admin/affiliates/rates/${encodeURIComponent(editingAccount.value.userId)}`, {
      method: "PUT",
      body: { customRebateBps: customBps },
    });
    toast.success(t("payments.admin.rebates.accounts.savedRate"));
    rateModalOpen.value = false;
    await loadAccounts();
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.rebates.accounts.loadFailed")));
  } finally {
    rateSaving.value = false;
  }
}

function submitCustomRate() {
  const pct = Number(ratePercentInput.value);
  if (!Number.isFinite(pct) || pct < 0 || pct > 50) {
    toast.error(t("payments.admin.rebates.accounts.invalidRate"));
    return;
  }
  void saveCustomRate(Math.round(pct * 100));
}

/* ---------------- Withdrawals ---------------- */

const withdrawals = ref<AffiliateWithdrawalItem[]>([]);
const withdrawalsLoading = ref(false);
const withdrawalsLoaded = ref(false);
const withdrawalFilter = ref<"all" | AffiliateWithdrawalStatus>("all");

async function loadWithdrawals() {
  withdrawalsLoading.value = true;
  try {
    const q = toQuery({
      status: withdrawalFilter.value === "all" ? undefined : withdrawalFilter.value,
    });
    withdrawals.value = (
      await apiJson<{ items: AffiliateWithdrawalItem[] }>(`/api/v1/admin/affiliates/withdrawals${q}`, {
        fallbackError: t("payments.admin.rebates.withdrawals.loadFailed"),
      })
    ).items;
    withdrawalsLoaded.value = true;
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.rebates.withdrawals.loadFailed")));
  } finally {
    withdrawalsLoading.value = false;
  }
}

watch(withdrawalFilter, () => void loadWithdrawals());

const pendingWithdrawalsCount = computed(
  () => withdrawals.value.filter((w) => w.kind === "payout" && w.status === "pending").length,
);

const withdrawalStatusTone: Record<AffiliateWithdrawalStatus, Tone> = {
  pending: "warning",
  approved: "info",
  paid: "success",
  rejected: "danger",
};

const reviewModalOpen = ref(false);
const reviewTarget = ref<AffiliateWithdrawalItem | null>(null);
const reviewAction = ref<"approve" | "mark_paid" | "reject">("approve");
const reviewNote = ref("");
const reviewSaving = ref(false);

function openReview(w: AffiliateWithdrawalItem, action: "approve" | "mark_paid" | "reject") {
  reviewTarget.value = w;
  reviewAction.value = action;
  reviewNote.value = "";
  reviewModalOpen.value = true;
}

async function submitReview() {
  if (!reviewTarget.value) return;
  reviewSaving.value = true;
  try {
    await apiJson(`/api/v1/admin/affiliates/withdrawals/${encodeURIComponent(reviewTarget.value.id)}/review`, {
      method: "POST",
      body: { action: reviewAction.value, reviewNote: reviewNote.value.trim() },
    });
    toast.success(t("payments.admin.rebates.withdrawals.reviewDone"));
    reviewModalOpen.value = false;
    await Promise.all([loadWithdrawals(), accountsLoaded.value ? loadAccounts() : Promise.resolve()]);
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.rebates.withdrawals.loadFailed")));
  } finally {
    reviewSaving.value = false;
  }
}

const tabs = computed<{ key: TabKey; label: string; count?: number; icon: "gift" | "users" | "wallet" }[]>(() => [
  { key: "rebates", label: t("payments.admin.rebates.tabs.rebates"), icon: "gift" },
  { key: "accounts", label: t("payments.admin.rebates.tabs.accounts"), icon: "users" },
  {
    key: "withdrawals",
    label: t("payments.admin.rebates.tabs.withdrawals"),
    count: pendingWithdrawalsCount.value > 0 ? pendingWithdrawalsCount.value : undefined,
    icon: "wallet",
  },
]);

function refreshCurrent() {
  if (activeTab.value === "rebates") void loadRebates();
  else if (activeTab.value === "accounts") void loadAccounts();
  else void loadWithdrawals();
}

watch(activeTab, (tab) => {
  if (tab === "accounts" && !accountsLoaded.value) void loadAccounts();
  if (tab === "withdrawals" && !withdrawalsLoaded.value) void loadWithdrawals();
});

onMounted(() => {
  void Promise.all([loadRebates(), loadWithdrawals()]);
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.affiliateRebates')">
      <template #actions>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="loading || accountsLoading || withdrawalsLoading"
          @click="refreshCurrent"
        >
          <UiIcon name="refresh" :size="15" :spin="loading || accountsLoading || withdrawalsLoading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <RouterLink to="/admin/settings" class="btn btn-secondary" :title="t('payments.admin.rebates.rateHint')">
          <UiIcon name="settings" :size="15" />
          <span class="hidden sm:inline">{{ t("payments.admin.rebates.openSettings") }}</span>
        </RouterLink>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        :class="STAGGER_CLASS"
        :style="stagger(0, 30)"
        :label="t('payments.admin.rebates.stats.total')"
        :value="loaded ? formatUsd(totalNano) : '—'"
        icon="gift"
        tone="violet"
        mono
      />
      <StatCard
        :class="STAGGER_CLASS"
        :style="stagger(1, 30)"
        :label="t('payments.admin.rebates.stats.recent')"
        :value="loaded ? formatUsd(recentNano) : '—'"
        icon="trending-up"
        tone="accent"
        mono
      />
      <StatCard
        :class="STAGGER_CLASS"
        :style="stagger(2, 30)"
        :label="t('payments.admin.rebates.stats.count')"
        :value="loaded ? formatNumber(items.length) : '—'"
        icon="list"
        tone="info"
      />
      <StatCard
        :class="STAGGER_CLASS"
        :style="stagger(3, 30)"
        :label="t('payments.admin.rebates.stats.beneficiaries')"
        :value="loaded ? formatNumber(beneficiaries) : '—'"
        icon="users"
        tone="success"
      />
    </div>

    <UiTabs v-model="activeTab" :tabs="tabs" />

    <!-- Tab 1: Rebates -->
    <UiCard v-if="activeTab === 'rebates'" icon="gift" :title="t('payments.admin.rebates.tabs.rebates')" flush>
      <template #actions>
        <span v-if="loaded && search.trim()" class="text-xs tabular-nums text-fg-subtle">
          {{ formatNumber(filtered.length) }} · {{ formatUsd(filteredTotal) }}
        </span>
      </template>

      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[12rem] flex-1 sm:max-w-sm">
          <span class="sr-only">{{ t("common.search") }}</span>
          <UiIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input v-model="search" type="search" class="input input-sm pl-8" :placeholder="t('payments.admin.rebates.searchPlaceholder')" />
        </label>
        <p v-if="items.length >= API_LIMIT" class="flex items-center gap-1.5 text-xs text-fg-subtle">
          <UiIcon name="info" :size="13" />
          {{ t("payments.admin.rebates.limitNote", { n: API_LIMIT }) }}
        </p>
      </div>

      <ListSkeleton v-if="!loaded && loading" />
      <EmptyState v-else-if="items.length === 0 && !loading" icon="gift" :title="t('payments.admin.rebates.empty')">
        <p class="w-full max-w-xs text-xs text-fg-subtle">{{ t("payments.admin.rebates.emptyHint") }}</p>
      </EmptyState>
      <EmptyState v-else-if="filtered.length === 0" icon="search" :title="t('payments.admin.rebates.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="search = ''">
          <UiIcon name="x" :size="14" />
          {{ t("payments.admin.rebates.clearSearch") }}
        </button>
      </EmptyState>
      <div v-else class="table-wrap transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("payments.admin.rebates.table.beneficiary") }}</th>
              <th>{{ t("payments.admin.rebates.table.invitee") }}</th>
              <th>{{ t("payments.admin.rebates.table.order") }}</th>
              <th>{{ t("payments.admin.rebates.table.creditTo") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.table.amount") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.table.time") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in paged" :key="r.id" :class="STAGGER_CLASS" :style="stagger(i)">
              <td class="max-w-[16rem]">
                <RouterLink
                  :to="{ path: '/admin/users', query: { search: r.beneficiaryEmail } }"
                  class="block truncate text-xs font-medium text-fg transition-colors hover:text-accent"
                  :title="r.beneficiaryEmail"
                >
                  {{ r.beneficiaryEmail || r.beneficiaryId }}
                </RouterLink>
              </td>
              <td class="max-w-[16rem]">
                <RouterLink
                  :to="{ path: '/admin/users', query: { search: r.inviteeEmail } }"
                  class="block truncate text-xs text-fg-muted transition-colors hover:text-accent"
                  :title="r.inviteeEmail"
                >
                  {{ r.inviteeEmail }}
                </RouterLink>
              </td>
              <td class="whitespace-nowrap">
                <span class="inline-flex items-center gap-0.5">
                  <RouterLink
                    :to="{ path: '/admin/orders', query: { search: r.orderId } }"
                    class="font-mono text-xs text-fg-muted transition-colors hover:text-accent"
                    :title="t('payments.admin.rebates.viewOrder')"
                  >
                    {{ shortId(r.orderId) }}
                  </RouterLink>
                  <CopyButton :text="r.orderId" />
                </span>
              </td>
              <td>
                <UiBadge :tone="(r.creditedTo ?? 'wallet') === 'commission_pool' ? 'accent' : 'neutral'">
                  {{ t(`payments.admin.rebates.creditModes.${r.creditedTo ?? "wallet"}`) }}
                </UiBadge>
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs font-semibold tabular-nums text-success">
                +{{ formatUsd(r.amountNanoUsd) }}
              </td>
              <td class="whitespace-nowrap text-right text-xs" :title="formatDateTime(r.createdAtIso)">
                <span class="text-fg-muted">{{ formatDateTime(r.createdAtIso) }}</span>
                <span class="ml-1.5 text-2xs text-fg-subtle">{{ formatRelative(r.createdAtIso, now) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <UiPagination
        v-if="filtered.length > 20"
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="filtered.length"
      />
    </UiCard>

    <!-- Tab 2: Affiliate Accounts & Custom Rates -->
    <UiCard v-else-if="activeTab === 'accounts'" icon="users" :title="t('payments.admin.rebates.tabs.accounts')" flush>
      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[12rem] flex-1 sm:max-w-sm">
          <span class="sr-only">{{ t("common.search") }}</span>
          <UiIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            v-model="accountSearch"
            type="search"
            class="input input-sm pl-8"
            :placeholder="t('payments.admin.rebates.accounts.searchPlaceholder')"
          />
        </label>
      </div>

      <ListSkeleton v-if="!accountsLoaded && accountsLoading" />
      <EmptyState v-else-if="accounts.length === 0" icon="users" :title="t('payments.admin.rebates.accounts.empty')" />
      <div v-else class="table-wrap" :class="accountsLoading ? 'opacity-60' : ''">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("payments.admin.rebates.accounts.user") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.accounts.invitees") }}</th>
              <th>{{ t("payments.admin.rebates.accounts.rate") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.accounts.poolBalance") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.accounts.totalEarned") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.accounts.transferred") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.accounts.withdrawn") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.withdrawals.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="acc in accounts" :key="acc.userId">
              <td class="max-w-[14rem]">
                <p class="truncate text-xs font-medium text-fg">{{ acc.email }}</p>
                <p v-if="acc.username" class="truncate text-2xs text-fg-subtle">{{ acc.username }}</p>
              </td>
              <td class="text-right font-mono text-xs tabular-nums">{{ formatNumber(acc.inviteeCount) }}</td>
              <td class="whitespace-nowrap">
                <div class="inline-flex items-center gap-1.5">
                  <span class="font-mono text-xs font-medium">{{ Number((acc.effectiveRebateBps / 100).toFixed(2)) }}%</span>
                  <UiBadge v-if="acc.customRebateBps !== null" tone="accent">
                    {{ t("payments.admin.rebates.accounts.customRate") }}
                  </UiBadge>
                  <span v-else class="text-2xs text-fg-subtle">
                    {{ t("payments.admin.rebates.accounts.globalRate", { pct: Number((acc.effectiveRebateBps / 100).toFixed(2)) }) }}
                  </span>
                </div>
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg">
                {{ formatUsd(acc.balanceNanoUsd) }}
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-success">
                {{ formatUsd(acc.totalEarnedNanoUsd) }}
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">
                {{ formatUsd(acc.totalTransferredNanoUsd) }}
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">
                {{ formatUsd(acc.totalWithdrawnNanoUsd) }}
              </td>
              <td class="whitespace-nowrap text-right">
                <button type="button" class="btn btn-secondary btn-sm" @click="openRateModal(acc)">
                  <UiIcon name="pencil" :size="13" />
                  {{ t("payments.admin.rebates.accounts.editRate") }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Tab 3: Withdrawals & Transfers -->
    <UiCard v-else icon="wallet" :title="t('payments.admin.rebates.tabs.withdrawals')" flush>
      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <UiSelect v-model="withdrawalFilter" class="input input-sm w-44">
          <option value="all">{{ t("payments.admin.rebates.withdrawals.all") }}</option>
          <option value="pending">{{ t("affiliate.pool.statuses.pending") }}</option>
          <option value="approved">{{ t("affiliate.pool.statuses.approved") }}</option>
          <option value="paid">{{ t("affiliate.pool.statuses.paid") }}</option>
          <option value="rejected">{{ t("affiliate.pool.statuses.rejected") }}</option>
        </UiSelect>
      </div>

      <ListSkeleton v-if="!withdrawalsLoaded && withdrawalsLoading" />
      <EmptyState v-else-if="withdrawals.length === 0" icon="wallet" :title="t('payments.admin.rebates.withdrawals.empty')" />
      <div v-else class="table-wrap" :class="withdrawalsLoading ? 'opacity-60' : ''">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("payments.admin.rebates.withdrawals.user") }}</th>
              <th>{{ t("payments.admin.rebates.withdrawals.kind") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.withdrawals.amount") }}</th>
              <th>{{ t("payments.admin.rebates.withdrawals.target") }}</th>
              <th>{{ t("payments.admin.rebates.withdrawals.status") }}</th>
              <th>{{ t("payments.admin.rebates.withdrawals.reviewNote") }}</th>
              <th>{{ t("payments.admin.rebates.withdrawals.time") }}</th>
              <th class="text-right">{{ t("payments.admin.rebates.withdrawals.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in withdrawals" :key="w.id">
              <td class="max-w-[14rem] truncate text-xs font-medium text-fg">{{ w.userEmail || w.userId }}</td>
              <td class="whitespace-nowrap text-xs">{{ t(`affiliate.pool.kinds.${w.kind}`) }}</td>
              <td class="whitespace-nowrap text-right font-mono text-xs font-semibold tabular-nums text-fg">
                {{ formatUsd(w.amountNanoUsd) }}
              </td>
              <td class="max-w-[14rem]">
                <p class="truncate text-xs text-fg-muted">
                  {{ w.kind === "payout" ? `${w.payoutMethod}: ${w.payoutAccount}` : "API Wallet" }}
                </p>
                <p v-if="w.notes" class="truncate text-2xs text-fg-subtle">{{ w.notes }}</p>
              </td>
              <td>
                <UiBadge :tone="withdrawalStatusTone[w.status]" dot>{{ t(`affiliate.pool.statuses.${w.status}`) }}</UiBadge>
              </td>
              <td class="max-w-[12rem] truncate text-xs text-fg-subtle">{{ w.reviewNote || "—" }}</td>
              <td class="whitespace-nowrap text-xs text-fg-subtle" :title="formatDateTime(w.createdAtIso)">
                {{ formatRelative(w.createdAtIso, now) }}
              </td>
              <td class="whitespace-nowrap text-right">
                <div v-if="w.kind === 'payout' && (w.status === 'pending' || w.status === 'approved')" class="inline-flex gap-1.5">
                  <button
                    v-if="w.status === 'pending'"
                    type="button"
                    class="btn btn-secondary btn-sm"
                    @click="openReview(w, 'approve')"
                  >
                    {{ t("payments.admin.rebates.withdrawals.approve") }}
                  </button>
                  <button type="button" class="btn btn-primary btn-sm" @click="openReview(w, 'mark_paid')">
                    <UiIcon name="check" :size="13" />
                    {{ t("payments.admin.rebates.withdrawals.markPaid") }}
                  </button>
                  <button type="button" class="btn btn-secondary btn-sm text-danger" @click="openReview(w, 'reject')">
                    <UiIcon name="x" :size="13" />
                    {{ t("payments.admin.rebates.withdrawals.reject") }}
                  </button>
                </div>
                <span v-else class="text-xs text-fg-subtle">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Custom Rate Modal -->
    <UiModal
      v-model:open="rateModalOpen"
      width="md"
      :title="t('payments.admin.rebates.accounts.modalTitle')"
      :persistent="rateSaving"
    >
      <template #icon>
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="percent" :size="15" /></span>
      </template>
      <form id="aff-rate-form" class="space-y-4" @submit.prevent="submitCustomRate">
        <p class="text-xs leading-relaxed text-fg-muted">
          {{ t("payments.admin.rebates.accounts.modalHint", { email: editingAccount?.email ?? "" }) }}
        </p>
        <FormField :label="t('payments.admin.rebates.accounts.rateLabel')" required>
          <div class="relative w-40">
            <input v-model="ratePercentInput" type="number" min="0" max="50" step="0.01" class="input pr-7 font-mono" />
            <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-fg-subtle">%</span>
          </div>
        </FormField>
      </form>
      <template #footer>
        <button
          v-if="editingAccount?.customRebateBps !== null"
          type="button"
          class="btn btn-secondary mr-auto"
          :disabled="rateSaving"
          @click="saveCustomRate(null)"
        >
          {{ t("payments.admin.rebates.accounts.resetDefault") }}
        </button>
        <button type="button" class="btn btn-secondary" :disabled="rateSaving" @click="rateModalOpen = false">
          {{ t("common.cancel") }}
        </button>
        <button type="submit" form="aff-rate-form" class="btn btn-primary" :disabled="rateSaving">
          <UiIcon v-if="rateSaving" name="loader" :size="15" spin />
          {{ t("payments.admin.rebates.accounts.saveRate") }}
        </button>
      </template>
    </UiModal>

    <!-- Review Withdrawal Modal -->
    <UiModal
      v-model:open="reviewModalOpen"
      width="md"
      :title="t('payments.admin.rebates.withdrawals.reviewTitle')"
      :persistent="reviewSaving"
    >
      <template #icon>
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="wallet" :size="15" /></span>
      </template>
      <form id="aff-review-form" class="space-y-4" @submit.prevent="submitReview">
        <p class="text-xs text-fg-muted">
          {{ reviewTarget?.userEmail }} · {{ formatUsd(reviewTarget?.amountNanoUsd ?? "0") }}
        </p>
        <p class="text-xs font-medium text-fg">
          {{
            t("payments.admin.rebates.withdrawals.reviewActionLabel", {
              action:
                reviewAction === "approve"
                  ? t("payments.admin.rebates.withdrawals.approve")
                  : reviewAction === "mark_paid"
                    ? t("payments.admin.rebates.withdrawals.markPaid")
                    : t("payments.admin.rebates.withdrawals.reject"),
            })
          }}
        </p>
        <FormField :label="t('payments.admin.rebates.withdrawals.reviewNote')">
          <input
            v-model="reviewNote"
            type="text"
            maxlength="300"
            class="input"
            :placeholder="t('payments.admin.rebates.withdrawals.notePlaceholder')"
          />
        </FormField>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="reviewSaving" @click="reviewModalOpen = false">
          {{ t("common.cancel") }}
        </button>
        <button type="submit" form="aff-review-form" class="btn btn-primary" :disabled="reviewSaving">
          <UiIcon v-if="reviewSaving" name="loader" :size="15" spin />
          {{ t("common.confirm") }}
        </button>
      </template>
    </UiModal>
  </div>
</template>
