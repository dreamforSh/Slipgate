<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { parseUsdToNano, type AffiliateWithdrawalItem } from "@slipgate/contracts";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import UiModal from "../../components/ui/UiModal.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import { useNow } from "../../composables/useNow";
import { apiJson, errorText } from "../../lib/api";
import { formatDateShort, formatDateTime, formatRelative, formatUsd, type Tone } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

interface Invitee {
  email: string;
  username: string;
  joinedAtIso: string;
}

interface RebateEntry {
  amountNanoUsd: string;
  /** Masked by the BFF. */
  inviteeEmail: string;
  creditedTo?: "wallet" | "commission_pool";
  createdAtIso: string;
}

interface AffiliateInfo {
  enabled: boolean;
  creditMode?: "wallet" | "commission_pool";
  minWithdrawUsd?: string;
  rebateBps: number;
  globalRebateBps?: number;
  customRebateBps?: number | null;
  inviteCode: string;
  inviteCount: number;
  invitees: Invitee[];
  rebateTotalNanoUsd?: string;
  commissionBalanceNanoUsd?: string;
  totalEarnedNanoUsd?: string;
  totalTransferredNanoUsd?: string;
  totalWithdrawnNanoUsd?: string;
  withdrawals?: AffiliateWithdrawalItem[];
  rebates?: RebateEntry[];
}

const { t } = useI18n();
const toast = useToastStore();
const now = useNow(60_000);

const info = ref<AffiliateInfo | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    info.value = await apiJson<AffiliateInfo>("/api/v1/user/affiliate");
    loadError.value = null;
  } catch (err) {
    loadError.value = errorText(err, t("affiliate.loadFailed"));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/* ---------------- Derived ---------------- */

const ratePercent = computed(() => `${Number(((info.value?.rebateBps ?? 0) / 100).toFixed(2))}%`);
const hasCustomRate = computed(
  () => info.value?.customRebateBps !== null && info.value?.customRebateBps !== undefined,
);
const poolNano = computed(() => BigInt(info.value?.commissionBalanceNanoUsd ?? "0"));
const showPoolSection = computed(
  () =>
    info.value?.creditMode === "commission_pool" ||
    poolNano.value > 0n ||
    (info.value?.withdrawals?.length ?? 0) > 0,
);
const inviteLink = computed(() =>
  info.value ? `${window.location.origin}/register?aff=${encodeURIComponent(info.value.inviteCode)}` : "",
);
const recentJoins = computed(() => {
  const cutoff = now.value - 30 * 86_400_000;
  return (info.value?.invitees ?? []).filter((i) => Date.parse(i.joinedAtIso) >= cutoff).length;
});

const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

async function share() {
  if (!info.value) return;
  try {
    await navigator.share({ title: t("affiliate.shareTitle"), text: t("affiliate.shareText"), url: inviteLink.value });
  } catch (err) {
    // A dismissed share sheet is not an error worth reporting.
    if (err instanceof DOMException && err.name === "AbortError") return;
    toast.error(errorText(err, t("affiliate.shareFailed")));
  }
}

const steps = computed<{ icon: IconName; title: string; body: string }[]>(() => [
  { icon: "share", title: t("affiliate.steps.share.title"), body: t("affiliate.steps.share.body") },
  { icon: "user-plus", title: t("affiliate.steps.join.title"), body: t("affiliate.steps.join.body") },
  { icon: "gift", title: t("affiliate.steps.earn.title"), body: t("affiliate.steps.earn.body", { rate: ratePercent.value }) },
]);

/* ---------------- Commission pool modals ---------------- */

const transferOpen = ref(false);
const transferAmountUsd = ref("");
const transferAttempted = ref(false);
const transferBusy = ref(false);

function nanoToInput(nano: bigint): string {
  const whole = nano / 1_000_000_000n;
  const frac = (nano % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function parseAmount(raw: string): bigint | null {
  try {
    const v = parseUsdToNano(raw);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

function openTransfer() {
  transferAmountUsd.value = poolNano.value > 0n ? nanoToInput(poolNano.value) : "";
  transferAttempted.value = false;
  transferOpen.value = true;
}

const transferError = computed(() => {
  if (!transferAttempted.value) return undefined;
  const n = parseAmount(transferAmountUsd.value);
  if (!n) return t("affiliate.pool.errors.amount");
  if (n > poolNano.value) return t("affiliate.pool.errors.exceeds");
  return undefined;
});

async function submitTransfer() {
  transferAttempted.value = true;
  const n = parseAmount(transferAmountUsd.value);
  if (!n || n > poolNano.value) return;
  transferBusy.value = true;
  try {
    await apiJson("/api/v1/user/affiliate/transfer", {
      method: "POST",
      body: { amountUsd: transferAmountUsd.value.trim().replace(/^\$/, "") },
    });
    toast.success(t("affiliate.pool.transferSuccess"));
    transferOpen.value = false;
    await load();
  } catch (err) {
    toast.error(errorText(err, t("affiliate.loadFailed")));
  } finally {
    transferBusy.value = false;
  }
}

const withdrawOpen = ref(false);
const withdrawAttempted = ref(false);
const withdrawBusy = ref(false);
const withdrawForm = reactive({
  amountUsd: "",
  payoutMethod: "alipay",
  payoutAccount: "",
  notes: "",
});

function openWithdraw() {
  withdrawForm.amountUsd = poolNano.value > 0n ? nanoToInput(poolNano.value) : "";
  withdrawForm.payoutMethod = "alipay";
  withdrawForm.payoutAccount = "";
  withdrawForm.notes = "";
  withdrawAttempted.value = false;
  withdrawOpen.value = true;
}

const minWithdrawNano = computed(() => {
  try {
    return parseUsdToNano(info.value?.minWithdrawUsd ?? "10");
  } catch {
    return 10_000_000_000n;
  }
});

const withdrawErrors = computed(() => {
  if (!withdrawAttempted.value) return {} as Record<string, string | undefined>;
  const e: Record<string, string | undefined> = {};
  const n = parseAmount(withdrawForm.amountUsd);
  if (!n) e.amount = t("affiliate.pool.errors.amount");
  else if (n > poolNano.value) e.amount = t("affiliate.pool.errors.exceeds");
  else if (n < minWithdrawNano.value) {
    e.amount = t("affiliate.pool.errors.belowMin", { min: info.value?.minWithdrawUsd ?? "10" });
  }
  if (!withdrawForm.payoutAccount.trim()) e.account = t("affiliate.pool.errors.account");
  return e;
});

async function submitWithdraw() {
  withdrawAttempted.value = true;
  const n = parseAmount(withdrawForm.amountUsd);
  if (!n || n > poolNano.value || n < minWithdrawNano.value || !withdrawForm.payoutAccount.trim()) return;
  withdrawBusy.value = true;
  try {
    await apiJson("/api/v1/user/affiliate/withdraw", {
      method: "POST",
      body: {
        amountUsd: withdrawForm.amountUsd.trim().replace(/^\$/, ""),
        payoutMethod: withdrawForm.payoutMethod,
        payoutAccount: withdrawForm.payoutAccount.trim(),
        notes: withdrawForm.notes.trim(),
      },
    });
    toast.success(t("affiliate.pool.withdrawSuccess"));
    withdrawOpen.value = false;
    await load();
  } catch (err) {
    toast.error(errorText(err, t("affiliate.loadFailed")));
  } finally {
    withdrawBusy.value = false;
  }
}

const withdrawalStatusTone: Record<AffiliateWithdrawalItem["status"], Tone> = {
  pending: "warning",
  approved: "info",
  paid: "success",
  rejected: "danger",
};

/* ---------------- Invitees table (client-side paging) ---------------- */

const page = ref(1);
const pageSize = ref(10);
const sortedInvitees = computed(() =>
  [...(info.value?.invitees ?? [])].sort((a, b) => Date.parse(b.joinedAtIso) - Date.parse(a.joinedAtIso)),
);
const pagedInvitees = computed(() =>
  sortedInvitees.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
);
watch(pageSize, () => (page.value = 1));

/* ---------------- Rebates (latest entries from the BFF, client-side paging) ---------------- */

const rebatePage = ref(1);
const rebatePageSize = ref(10);
const sortedRebates = computed(() =>
  [...(info.value?.rebates ?? [])].sort((a, b) => Date.parse(b.createdAtIso) - Date.parse(a.createdAtIso)),
);
const pagedRebates = computed(() =>
  sortedRebates.value.slice((rebatePage.value - 1) * rebatePageSize.value, rebatePage.value * rebatePageSize.value),
);
watch(rebatePageSize, () => (rebatePage.value = 1));

const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 7) * 50}ms`, animationFillMode: "both" });
const enter = "animate-slide-up motion-reduce:animate-none";
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('affiliate.title')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </PageHeader>

    <UiAlert v-if="loadError && !info" tone="warning">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="load">
          {{ t("affiliate.retry") }}
        </button>
      </template>
    </UiAlert>

    <!-- Skeleton -->
    <div v-if="!info && loading" class="space-y-6" aria-busy="true">
      <div class="card h-48 animate-pulse bg-surface-2/40 motion-reduce:animate-none" />
      <div class="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        <div v-for="i in 4" :key="i" class="card h-[6.5rem] animate-pulse bg-surface-2/40 motion-reduce:animate-none" />
      </div>
    </div>

    <!-- Program off -->
    <section v-else-if="info && !info.enabled" class="card relative overflow-hidden" :class="enter">
      <div class="pointer-events-none absolute inset-0 bg-gradient-to-b from-accent/[0.06] to-transparent" />
      <div class="relative flex flex-col items-center px-6 py-16 text-center">
        <span class="relative inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-fg-subtle ring-1 ring-inset ring-line">
          <UiIcon name="gift" :size="28" :stroke-width="1.6" />
          <span class="absolute -right-1.5 -top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface ring-1 ring-line">
            <UiIcon name="clock" :size="13" class="text-warning" />
          </span>
        </span>
        <h2 class="mt-5 text-lg font-semibold text-fg">{{ t("affiliate.disabled.title") }}</h2>
        <p class="mt-1.5 max-w-md text-sm leading-relaxed text-fg-subtle">{{ t("affiliate.disabled.body") }}</p>
        <RouterLink to="/dashboard" class="btn btn-secondary mt-6">
          <UiIcon name="home" :size="15" />
          {{ t("affiliate.disabled.back") }}
        </RouterLink>
      </div>
    </section>

    <template v-else-if="info">
      <!-- Invite hero -->
      <section class="card relative overflow-hidden" :class="enter" :style="stagger(0)">
        <div class="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/[0.12] via-transparent to-violet/[0.08]" />
        <div class="pointer-events-none absolute inset-0 bg-grid [mask-image:linear-gradient(to_bottom,black,transparent)]" />
        <div class="relative grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-center">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="icon-chip icon-chip-accent h-10 w-10 rounded-xl">
                <UiIcon name="gift" :size="19" />
              </span>
              <UiBadge v-if="hasCustomRate" tone="accent">{{ t("affiliate.stats.customBadge") }}</UiBadge>
            </div>
            <h2 class="mt-4 text-xl font-bold tracking-tight text-fg">
              {{ t("affiliate.hero.title", { rate: ratePercent }) }}
            </h2>
            <p class="mt-1.5 text-sm leading-relaxed text-fg-muted">{{ t("affiliate.hero.body") }}</p>
          </div>

          <div class="min-w-0 space-y-3">
            <div>
              <p class="label">{{ t("affiliate.hero.link") }}</p>
              <div class="flex flex-col gap-2 sm:flex-row">
                <code
                  class="flex min-w-0 flex-1 items-center truncate rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-fg dark:bg-surface-2/60"
                  :title="inviteLink"
                >
                  {{ inviteLink }}
                </code>
                <div class="flex shrink-0 gap-2">
                  <CopyButton :text="inviteLink" :label="t('affiliate.hero.copyLink')" size="sm" class="btn-secondary max-sm:flex-1" />
                  <button v-if="canShare" type="button" class="btn btn-secondary btn-sm max-sm:flex-1" @click="share">
                    <UiIcon name="external-link" :size="13" />
                    {{ t("affiliate.hero.share") }}
                  </button>
                </div>
              </div>
            </div>
            <div>
              <p class="label">{{ t("affiliate.hero.code") }}</p>
              <div class="flex items-center gap-2">
                <span
                  class="inline-flex h-9 items-center rounded-lg border border-dashed border-accent/40 bg-accent/[0.06] px-3 font-mono text-base font-semibold tracking-[0.2em] text-accent"
                >
                  {{ info.inviteCode }}
                </span>
                <CopyButton :text="info.inviteCode" size="sm" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Commission Pool Wallet (shown in commission_pool mode or when pool/withdrawals exist) -->
      <UiCard
        v-if="showPoolSection"
        :class="enter"
        :style="stagger(1)"
        icon="wallet"
        :title="t('affiliate.pool.title')"
      >
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-xs text-fg-subtle">{{ t("affiliate.stats.poolBalance") }}</p>
            <p class="mt-0.5 font-mono text-2xl font-bold tabular-nums text-fg">
              {{ formatUsd(info.commissionBalanceNanoUsd ?? "0") }}
            </p>
            <div class="mt-1 flex flex-wrap gap-3 text-xs text-fg-subtle">
              <span>{{ t("affiliate.stats.transferredOut", { amount: formatUsd(info.totalTransferredNanoUsd ?? "0") }) }}</span>
              <span>{{ t("affiliate.stats.withdrawnOut", { amount: formatUsd(info.totalWithdrawnNanoUsd ?? "0") }) }}</span>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="btn btn-primary"
              :disabled="poolNano <= 0n"
              @click="openTransfer"
            >
              <UiIcon name="arrow-right" :size="14" />
              {{ t("affiliate.pool.transfer") }}
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="poolNano < minWithdrawNano"
              @click="openWithdraw"
            >
              <UiIcon name="wallet" :size="14" />
              {{ t("affiliate.pool.withdraw") }}
            </button>
          </div>
        </div>
      </UiCard>

      <!-- Stats -->
      <div class="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        <StatCard
          :class="enter"
          :style="stagger(1)"
          :label="t('affiliate.stats.earned')"
          :value="formatUsd(info.totalEarnedNanoUsd ?? info.rebateTotalNanoUsd ?? '0')"
          icon="wallet"
          tone="violet"
          :hint="t('affiliate.stats.earnedHint')"
        />
        <StatCard
          :class="enter"
          :style="stagger(2)"
          :label="t('affiliate.stats.rate')"
          :value="ratePercent"
          icon="percent"
          tone="accent"
          :hint="hasCustomRate ? t('affiliate.stats.customBadge') : t('affiliate.stats.rateHint')"
        />
        <StatCard
          :class="enter"
          :style="stagger(3)"
          :label="t('affiliate.stats.invitees')"
          :value="info.inviteCount"
          icon="users"
          tone="info"
          :hint="t('affiliate.stats.inviteesHint')"
        />
        <StatCard
          :class="enter"
          :style="stagger(4)"
          :label="t('affiliate.stats.recent')"
          :value="recentJoins"
          icon="user-plus"
          tone="success"
          :hint="t('affiliate.stats.recentHint')"
        />
      </div>

      <!-- How it works -->
      <UiCard :class="enter" :style="stagger(5)" icon="book-open" :title="t('affiliate.steps.title')">
        <ol class="grid gap-5 sm:grid-cols-3 sm:gap-4">
          <li v-for="(step, i) in steps" :key="i" class="relative flex gap-3 sm:flex-col sm:gap-0">
            <!-- connector -->
            <span
              v-if="i < steps.length - 1"
              class="absolute left-[1.1rem] top-10 h-[calc(100%-1.75rem)] w-px bg-line sm:left-11 sm:-right-2 sm:top-[1.1rem] sm:h-px sm:w-auto"
              aria-hidden="true"
            />
            <span
              class="relative z-10 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-solid text-sm font-semibold text-accent-fg shadow-glow"
            >
              {{ i + 1 }}
            </span>
            <div class="min-w-0 sm:mt-3 sm:pr-4">
              <p class="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <UiIcon :name="step.icon" :size="14" class="text-accent" />
                {{ step.title }}
              </p>
              <p class="mt-1 text-xs leading-relaxed text-fg-subtle">{{ step.body }}</p>
            </div>
          </li>
        </ol>
      </UiCard>

      <!-- Transfers & Withdrawals -->
      <UiCard v-if="showPoolSection" :class="enter" :style="stagger(6)" icon="list" :title="t('affiliate.pool.historyTitle')" flush>
        <EmptyState v-if="!(info.withdrawals?.length)" compact icon="wallet" :title="t('affiliate.pool.historyEmpty')" />
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("payments.admin.rebates.withdrawals.kind") }}</th>
                <th>{{ t("payments.admin.rebates.withdrawals.amount") }}</th>
                <th>{{ t("payments.admin.rebates.withdrawals.target") }}</th>
                <th>{{ t("payments.admin.rebates.withdrawals.status") }}</th>
                <th>{{ t("payments.admin.rebates.withdrawals.reviewNote") }}</th>
                <th class="text-right">{{ t("payments.admin.rebates.withdrawals.time") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in info.withdrawals" :key="w.id">
                <td class="whitespace-nowrap text-xs">{{ t(`affiliate.pool.kinds.${w.kind}`) }}</td>
                <td class="whitespace-nowrap font-mono text-xs font-semibold tabular-nums text-fg">
                  {{ formatUsd(w.amountNanoUsd) }}
                </td>
                <td class="max-w-[14rem] truncate text-xs text-fg-muted">
                  {{ w.kind === "payout" ? `${w.payoutMethod}: ${w.payoutAccount}` : "API Wallet" }}
                </td>
                <td>
                  <UiBadge :tone="withdrawalStatusTone[w.status]" dot>{{ t(`affiliate.pool.statuses.${w.status}`) }}</UiBadge>
                </td>
                <td class="max-w-[14rem] truncate text-xs text-fg-subtle">{{ w.reviewNote || "—" }}</td>
                <td class="whitespace-nowrap text-right text-xs text-fg-subtle" :title="formatDateTime(w.createdAtIso)">
                  {{ formatRelative(w.createdAtIso, now) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <!-- Rebates -->
      <UiCard :class="enter" :style="stagger(6)" icon="gift" :title="t('affiliate.rebates.title')" flush>
        <template #actions>
          <span v-if="sortedRebates.length" class="text-xs tabular-nums text-fg-subtle">
            {{ t("affiliate.rebates.recent", { n: sortedRebates.length }) }}
          </span>
        </template>
        <EmptyState v-if="!sortedRebates.length" compact icon="gift" :title="t('affiliate.rebates.empty')">
          <p class="w-full max-w-sm text-xs text-fg-subtle">{{ t("affiliate.rebates.emptyHint") }}</p>
        </EmptyState>
        <template v-else>
          <ul class="divide-y divide-line/60">
            <li
              v-for="(r, i) in pagedRebates"
              :key="`${r.createdAtIso}-${i}`"
              class="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-2/40"
            >
              <span class="icon-chip icon-chip-success h-8 w-8"><UiIcon name="gift" :size="15" /></span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-fg">
                  {{ t("affiliate.rebates.from", { email: r.inviteeEmail }) }}
                </p>
                <p class="mt-0.5 text-2xs text-fg-subtle" :title="formatDateTime(r.createdAtIso)">
                  {{ formatDateShort(r.createdAtIso) }} · {{ formatRelative(r.createdAtIso, now) }}
                </p>
              </div>
              <UiBadge v-if="r.creditedTo" :tone="r.creditedTo === 'commission_pool' ? 'accent' : 'neutral'">
                {{ r.creditedTo === "commission_pool" ? t("affiliate.rebates.creditedPool") : t("affiliate.rebates.creditedWallet") }}
              </UiBadge>
              <span class="shrink-0 font-mono text-sm font-semibold tabular-nums text-success">+{{ formatUsd(r.amountNanoUsd) }}</span>
            </li>
          </ul>
          <UiPagination
            v-if="sortedRebates.length > 10"
            v-model:page="rebatePage"
            v-model:page-size="rebatePageSize"
            :total="sortedRebates.length"
            :page-sizes="[10, 20, 50]"
          />
        </template>
      </UiCard>

      <!-- Invitees -->
      <UiCard :class="enter" :style="stagger(7)" icon="users" :title="t('affiliate.invitees.title')" flush>
        <template #actions>
          <span class="text-xs tabular-nums text-fg-subtle">{{ t("affiliate.invitees.count", { n: info.inviteCount }) }}</span>
        </template>
        <EmptyState v-if="!sortedInvitees.length" icon="user-plus" :title="t('affiliate.invitees.empty')">
          <CopyButton :text="inviteLink" :label="t('affiliate.hero.copyLink')" size="sm" class="btn-secondary" />
        </EmptyState>
        <template v-else>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>{{ t("affiliate.invitees.email") }}</th>
                  <th>{{ t("affiliate.invitees.username") }}</th>
                  <th class="text-right">{{ t("affiliate.invitees.joined") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in pagedInvitees" :key="`${row.email}-${row.joinedAtIso}`">
                  <td class="font-mono text-xs text-fg">{{ row.email }}</td>
                  <td class="text-fg-muted">{{ row.username || "—" }}</td>
                  <td class="whitespace-nowrap text-right">
                    <span class="text-xs text-fg">{{ formatDateShort(row.joinedAtIso) }}</span>
                    <span class="ml-1.5 text-2xs text-fg-subtle">{{ formatRelative(row.joinedAtIso, now) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <UiPagination
            v-if="sortedInvitees.length > 10"
            v-model:page="page"
            v-model:pageSize="pageSize"
            :total="sortedInvitees.length"
            :page-sizes="[10, 20, 50]"
          />
        </template>
      </UiCard>
    </template>

    <!-- Transfer to API wallet modal -->
    <UiModal
      v-model:open="transferOpen"
      width="md"
      :title="t('affiliate.pool.transferTitle')"
      :persistent="transferBusy"
    >
      <template #icon>
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="arrow-right" :size="15" /></span>
      </template>
      <form id="aff-transfer-form" class="space-y-4" @submit.prevent="submitTransfer">
        <p class="text-xs leading-relaxed text-fg-muted">{{ t("affiliate.pool.transferBody") }}</p>
        <FormField :label="t('affiliate.pool.amount')" required>
          <div class="flex gap-2">
            <input
              v-model="transferAmountUsd"
              type="text"
              inputmode="decimal"
              class="input flex-1 font-mono"
              :class="transferError ? '!border-danger' : ''"
            />
            <button type="button" class="btn btn-secondary shrink-0" @click="transferAmountUsd = nanoToInput(poolNano)">
              {{ t("affiliate.pool.useAll") }}
            </button>
          </div>
          <p class="mt-1 text-xs" :class="transferError ? 'text-danger' : 'text-fg-subtle'">
            {{ transferError ?? t("affiliate.pool.available", { amount: formatUsd(poolNano.toString()) }) }}
          </p>
        </FormField>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="transferBusy" @click="transferOpen = false">
          {{ t("common.cancel") }}
        </button>
        <button type="submit" form="aff-transfer-form" class="btn btn-primary" :disabled="transferBusy">
          <UiIcon v-if="transferBusy" name="loader" :size="15" spin />
          {{ transferBusy ? t("affiliate.pool.submitting") : t("affiliate.pool.transfer") }}
        </button>
      </template>
    </UiModal>

    <!-- Payout withdrawal modal -->
    <UiModal
      v-model:open="withdrawOpen"
      width="md"
      :title="t('affiliate.pool.withdrawTitle')"
      :persistent="withdrawBusy"
    >
      <template #icon>
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="wallet" :size="15" /></span>
      </template>
      <form id="aff-withdraw-form" class="space-y-4" @submit.prevent="submitWithdraw">
        <p class="text-xs leading-relaxed text-fg-muted">
          {{ t("affiliate.pool.withdrawBody", { min: info?.minWithdrawUsd ?? "10" }) }}
        </p>
        <FormField :label="t('affiliate.pool.amount')" required>
          <input
            v-model="withdrawForm.amountUsd"
            type="text"
            inputmode="decimal"
            class="input font-mono"
            :class="withdrawErrors.amount ? '!border-danger' : ''"
          />
          <p class="mt-1 text-xs" :class="withdrawErrors.amount ? 'text-danger' : 'text-fg-subtle'">
            {{ withdrawErrors.amount ?? t("affiliate.pool.available", { amount: formatUsd(poolNano.toString()) }) }}
          </p>
        </FormField>
        <FormField :label="t('affiliate.pool.method')" required>
          <select v-model="withdrawForm.payoutMethod" class="input">
            <option value="alipay">{{ t("affiliate.pool.methods.alipay") }}</option>
            <option value="wxpay">{{ t("affiliate.pool.methods.wxpay") }}</option>
            <option value="bank">{{ t("affiliate.pool.methods.bank") }}</option>
            <option value="usdt">{{ t("affiliate.pool.methods.usdt") }}</option>
            <option value="other">{{ t("affiliate.pool.methods.other") }}</option>
          </select>
        </FormField>
        <FormField :label="t('affiliate.pool.account')" required>
          <input
            v-model="withdrawForm.payoutAccount"
            type="text"
            maxlength="200"
            class="input"
            :class="withdrawErrors.account ? '!border-danger' : ''"
            :placeholder="t('affiliate.pool.accountPlaceholder')"
          />
          <p v-if="withdrawErrors.account" class="mt-1 text-xs text-danger">{{ withdrawErrors.account }}</p>
        </FormField>
        <FormField :label="t('affiliate.pool.notes')">
          <input
            v-model="withdrawForm.notes"
            type="text"
            maxlength="300"
            class="input"
            :placeholder="t('affiliate.pool.notesPlaceholder')"
          />
        </FormField>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="withdrawBusy" @click="withdrawOpen = false">
          {{ t("common.cancel") }}
        </button>
        <button type="submit" form="aff-withdraw-form" class="btn btn-primary" :disabled="withdrawBusy">
          <UiIcon v-if="withdrawBusy" name="loader" :size="15" spin />
          {{ withdrawBusy ? t("affiliate.pool.submitting") : t("affiliate.pool.withdraw") }}
        </button>
      </template>
    </UiModal>
  </div>
</template>
