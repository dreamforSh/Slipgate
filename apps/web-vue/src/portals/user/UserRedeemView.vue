<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BalanceLedgerItem, RedeemCodeItem, RedeemResult, WalletSummary } from "@slipgate/contracts";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import RedeemSuccessCard from "../../components/admin/ops/RedeemSuccessCard.vue";
import { formatUsdAny, formatUsdDelta, maskCode, STAGGER_CLASS, stagger } from "../../components/admin/ops/opsUtil";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { apiJson, errorText } from "../../lib/api";
import { formatDateTime, formatRelative, formatUsd, type Tone } from "../../lib/format";
import { useAnnouncementStore } from "../../stores/announcements";
import { useAuthStore } from "../../stores/auth";
import { usePortalStore } from "../../stores/portal";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const auth = useAuthStore();
const portal = usePortalStore();
const toast = useToastStore();

/* ---------------- Balance hero (animated count) ---------------- */

const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const displayNano = ref(0);
const bump = ref(false);
let raf = 0;
let bumpTimer: number | undefined;

watch(
  () => auth.wallet?.availableNanoUsd,
  (next, prev) => {
    const target = Number(next ?? "0");
    if (prev === undefined || reduceMotion) {
      displayNano.value = target;
      return;
    }
    if (next === prev) return;
    const from = displayNano.value;
    const start = performance.now();
    const duration = 900;
    cancelAnimationFrame(raf);
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      displayNano.value = from + (target - from) * eased;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    bump.value = true;
    window.clearTimeout(bumpTimer);
    bumpTimer = window.setTimeout(() => (bump.value = false), 1200);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.clearTimeout(bumpTimer);
});

const displayBalance = computed(() => formatUsdAny(String(Math.round(displayNano.value))));
const heldNano = computed(() => auth.wallet?.heldNanoUsd ?? "0");

async function refreshWallet() {
  try {
    const { wallet } = await apiJson<{ wallet: WalletSummary }>("/api/v1/user/wallet");
    auth.wallet = wallet;
  } catch {
    // The shell already shows a balance; a failed refresh is not worth a toast.
  }
}

/* ---------------- Redeem form ---------------- */

const code = ref("");
const submitting = ref(false);
const result = ref<RedeemResult | null>(null);
const failure = ref<string | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const trimmed = computed(() => code.value.trim());

async function redeem() {
  if (submitting.value) return;
  const value = trimmed.value;
  if (value.length < 4) {
    result.value = null;
    failure.value = t("redeem.user.form.tooShort");
    return;
  }
  submitting.value = true;
  failure.value = null;
  result.value = null;
  try {
    const res = await apiJson<{ result: RedeemResult; wallet: WalletSummary }>("/api/v1/user/redeem", {
      method: "POST",
      body: { code: value },
      fallbackError: t("redeem.user.errors.redeem"),
    });
    auth.wallet = res.wallet;
    // A subscription code changes no balance but can make targeted announcements visible.
    useAnnouncementStore().recheck();
    result.value = res.result;
    code.value = "";
    void loadHistory();
    void loadLedger();
  } catch (err) {
    failure.value = errorText(err, t("redeem.user.errors.redeem"));
  } finally {
    submitting.value = false;
  }
}

async function again() {
  result.value = null;
  failure.value = null;
  await nextTick();
  inputEl.value?.focus();
}

function onInput() {
  if (failure.value) failure.value = null;
}

/* ---------------- History tabs ---------------- */

type TabKey = "history" | "ledger";
const tab = ref<TabKey>("history");

const history = ref<RedeemCodeItem[]>([]);
const historyLoading = ref(false);
const historyLoaded = ref(false);
const ledger = ref<BalanceLedgerItem[]>([]);
const ledgerLoading = ref(false);
const ledgerLoaded = ref(false);

const tabs = computed(() => [
  { key: "history" as const, label: t("redeem.user.tabs.history"), icon: "ticket" as const, count: historyLoaded.value ? history.value.length : undefined },
  { key: "ledger" as const, label: t("redeem.user.tabs.ledger"), icon: "wallet" as const, count: ledgerLoaded.value ? ledger.value.length : undefined },
]);

async function loadHistory() {
  historyLoading.value = true;
  try {
    history.value = (await apiJson<{ items: RedeemCodeItem[] }>("/api/v1/user/redeem/history")).items;
    historyLoaded.value = true;
  } catch (err) {
    toast.error(errorText(err, t("redeem.user.errors.history")));
  } finally {
    historyLoading.value = false;
  }
}

async function loadLedger() {
  ledgerLoading.value = true;
  try {
    ledger.value = (await apiJson<{ items: BalanceLedgerItem[] }>("/api/v1/user/ledger?limit=50")).items;
    ledgerLoaded.value = true;
  } catch (err) {
    toast.error(errorText(err, t("redeem.user.errors.ledger")));
  } finally {
    ledgerLoading.value = false;
  }
}

const kindTone: Record<RedeemCodeItem["kind"], Tone> = { balance: "accent", subscription: "violet", invitation: "info" };

function historyValue(item: RedeemCodeItem): string {
  if (item.kind === "balance") return formatUsd(item.amountNanoUsd);
  if (item.kind === "subscription") {
    return t("redeem.value.subscription", {
      days: item.validityDays ?? 0,
      group: item.groupName ?? t("redeem.value.unknownGroup"),
    });
  }
  return t("redeem.value.invitation");
}

const ledgerTone: Record<BalanceLedgerItem["kind"], Tone> = {
  credit: "success",
  settle: "neutral",
  adjust: "info",
  hold: "warning",
  release: "violet",
};

function ledgerReason(item: BalanceLedgerItem): string {
  const r = item.reason.trim();
  if (r === "initial_balance") return t("redeem.user.ledger.reasons.initial");
  if (r === "admin_add") return t("redeem.user.ledger.reasons.adminAdd");
  if (r === "admin_subtract") return t("redeem.user.ledger.reasons.adminSubtract");
  if (r === "admin_set") return t("redeem.user.ledger.reasons.adminSet");
  const redeemMatch = /^redeem:(.+)$/.exec(r);
  if (redeemMatch) return t("redeem.user.ledger.reasons.redeem", { code: maskCode(redeemMatch[1] ?? "") });
  const promoMatch = /^promo:(.+)$/.exec(r);
  if (promoMatch) return t("redeem.user.ledger.reasons.promo", { code: promoMatch[1] ?? "" });
  if (item.kind === "settle" && r) return t("redeem.user.ledger.reasons.usage", { model: r });
  return r || t("redeem.user.ledger.reasons.none");
}

function isNegative(nano: string): boolean {
  return nano.startsWith("-");
}

const contactInfo = computed(() => portal.settings?.contactInfo?.trim() ?? "");

onMounted(() => {
  void portal.load();
  void refreshWallet();
  void loadHistory();
  void loadLedger();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.myRedeem')" />

    <div class="grid gap-6 lg:grid-cols-5">
      <div class="space-y-4 lg:col-span-3">
        <!-- Balance hero -->
        <section
          class="card relative overflow-hidden p-5 sm:p-6"
          :class="bump ? '!border-success/40 shadow-card-hover' : ''"
        >
          <div class="bg-grid pointer-events-none absolute inset-0 opacity-70 [mask-image:linear-gradient(to_left,black,transparent_70%)]" />
          <div class="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-accent/10 blur-3xl" />
          <div class="relative flex items-start justify-between gap-4">
            <div class="min-w-0">
              <p class="flex items-center gap-2 text-xs font-medium text-fg-subtle">
                <span class="icon-chip icon-chip-accent h-7 w-7"><UiIcon name="wallet" :size="15" /></span>
                {{ t("redeem.user.balance") }}
              </p>
              <p
                class="mt-3 truncate font-mono text-3xl font-bold tabular-nums tracking-tight transition-colors duration-500 sm:text-4xl"
                :class="bump ? 'text-success' : 'text-fg'"
                aria-live="polite"
              >
                {{ displayBalance }}
              </p>
              <p class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
                <span>{{ t("redeem.user.balanceHint") }}</span>
                <span v-if="heldNano !== '0'" class="inline-flex items-center gap-1 text-warning">
                  <UiIcon name="clock" :size="12" />
                  {{ t("redeem.user.held", { amount: formatUsd(heldNano) }) }}
                </span>
              </p>
            </div>
            <span class="icon-chip icon-chip-violet hidden h-12 w-12 rounded-2xl sm:inline-flex">
              <UiIcon name="gift" :size="22" />
            </span>
          </div>
        </section>

        <!-- Redeem form -->
        <UiCard icon="gift" :title="t('redeem.user.form.title')">
          <form class="space-y-2" @submit.prevent="redeem">
            <label for="redeem-code" class="label">{{ t("redeem.user.form.label") }}</label>
            <div class="flex flex-col gap-2 sm:flex-row">
              <span class="relative block flex-1">
                <UiIcon
                  name="ticket"
                  :size="17"
                  class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle"
                />
                <input
                  id="redeem-code"
                  ref="inputEl"
                  v-model="code"
                  type="text"
                  autocomplete="off"
                  autocapitalize="characters"
                  spellcheck="false"
                  maxlength="64"
                  class="input h-11 pl-10 font-mono text-base tracking-wider placeholder:font-sans placeholder:text-sm placeholder:tracking-normal"
                  :class="failure ? '!border-danger/60' : ''"
                  :placeholder="t('redeem.user.form.placeholder')"
                  :disabled="submitting"
                  @input="onInput"
                />
              </span>
              <button type="submit" class="btn btn-primary h-11 px-5" :disabled="submitting || trimmed.length === 0">
                <UiIcon :name="submitting ? 'loader' : 'sparkles'" :size="16" :spin="submitting" />
                {{ submitting ? t("redeem.user.form.submitting") : t("redeem.user.form.submit") }}
              </button>
            </div>
            <p class="text-xs text-fg-subtle">{{ t("redeem.user.form.hint") }}</p>
          </form>
        </UiCard>

        <!-- Outcome -->
        <Transition
          mode="out-in"
          enter-active-class="transition duration-300 ease-out"
          enter-from-class="translate-y-2 opacity-0"
          leave-active-class="transition duration-150 ease-in"
          leave-to-class="opacity-0"
        >
          <RedeemSuccessCard v-if="result" :key="result.code" :result="result" :wallet="auth.wallet" @again="again" />
          <div
            v-else-if="failure"
            key="failure"
            class="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/[0.06] p-4"
            role="alert"
          >
            <span class="icon-chip icon-chip-danger h-9 w-9 shrink-0"><UiIcon name="x-circle" :size="18" /></span>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-fg">{{ t("redeem.user.error.title") }}</p>
              <p class="mt-0.5 break-words text-sm text-fg-muted">{{ failure }}</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm shrink-0" @click="again">
              <UiIcon name="rotate-ccw" :size="14" />
              <span class="hidden sm:inline">{{ t("redeem.user.error.retry") }}</span>
            </button>
          </div>
        </Transition>
      </div>

      <!-- About -->
      <aside class="lg:col-span-2">
        <UiCard icon="info" :title="t('redeem.user.about.title')">
          <ul class="space-y-3 text-sm text-fg-muted">
            <li v-for="n in 4" :key="n" class="flex gap-2.5">
              <UiIcon name="check-circle" :size="15" class="mt-0.5 shrink-0 text-success" />
              <span>{{ t(`redeem.user.about.item${n}`) }}</span>
            </li>
          </ul>
          <div v-if="contactInfo" class="mt-5 rounded-lg border border-accent/20 bg-accent/[0.05] p-3.5">
            <p class="flex items-center gap-1.5 text-xs font-semibold text-accent">
              <UiIcon name="mail" :size="13" />
              {{ t("redeem.user.about.contact") }}
            </p>
            <p class="mt-1.5 whitespace-pre-line break-words text-sm text-fg">{{ contactInfo }}</p>
          </div>
        </UiCard>
      </aside>
    </div>

    <!-- History -->
    <section class="card overflow-hidden">
      <div class="px-3 sm:px-4">
        <UiTabs v-model="tab" :tabs="tabs" class="!border-b-0" />
      </div>
      <div class="border-t border-line/70">
        <template v-if="tab === 'history'">
          <ListSkeleton v-if="!historyLoaded && historyLoading" :rows="4" />
          <EmptyState v-else-if="history.length === 0" icon="ticket" :title="t('redeem.user.history.empty')" compact />
          <div v-else class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>{{ t("redeem.user.history.code") }}</th>
                  <th>{{ t("redeem.user.history.kind") }}</th>
                  <th>{{ t("redeem.user.history.value") }}</th>
                  <th class="text-right">{{ t("redeem.user.history.redeemedAt") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(h, i) in history" :key="h.code" :class="STAGGER_CLASS" :style="stagger(i)">
                  <td class="whitespace-nowrap font-mono text-xs tracking-wide text-fg">
                    {{ maskCode(h.code) }}
                  </td>
                  <td><UiBadge :tone="kindTone[h.kind]">{{ t(`redeem.kinds.${h.kind}`) }}</UiBadge></td>
                  <td class="whitespace-nowrap text-xs" :class="h.kind === 'balance' ? 'font-mono font-semibold text-success' : 'text-fg-muted'">
                    {{ h.kind === "balance" ? `+${historyValue(h)}` : historyValue(h) }}
                  </td>
                  <td class="whitespace-nowrap text-right text-xs text-fg-subtle" :title="formatRelative(h.redeemedAtIso)">
                    {{ formatDateTime(h.redeemedAtIso) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-else>
          <ListSkeleton v-if="!ledgerLoaded && ledgerLoading" :rows="5" />
          <EmptyState v-else-if="ledger.length === 0" icon="wallet" :title="t('redeem.user.ledger.empty')" compact />
          <template v-else>
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>{{ t("redeem.user.ledger.time") }}</th>
                    <th>{{ t("redeem.user.ledger.kind") }}</th>
                    <th>{{ t("redeem.user.ledger.reason") }}</th>
                    <th class="text-right">{{ t("redeem.user.ledger.amount") }}</th>
                    <th class="text-right">{{ t("redeem.user.ledger.balanceAfter") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(l, i) in ledger" :key="l.id" :class="STAGGER_CLASS" :style="stagger(i)">
                    <td class="whitespace-nowrap text-xs text-fg-subtle" :title="formatRelative(l.createdAtIso)">
                      {{ formatDateTime(l.createdAtIso) }}
                    </td>
                    <td>
                      <UiBadge :tone="ledgerTone[l.kind]">{{ t(`redeem.user.ledger.kinds.${l.kind}`) }}</UiBadge>
                    </td>
                    <td class="max-w-[16rem]">
                      <p class="truncate text-xs text-fg-muted" :title="l.reason">{{ ledgerReason(l) }}</p>
                    </td>
                    <td
                      class="whitespace-nowrap text-right font-mono text-xs font-semibold tabular-nums"
                      :class="isNegative(l.deltaNanoUsd) ? 'text-danger' : 'text-success'"
                    >
                      {{ formatUsdDelta(l.deltaNanoUsd) }}
                    </td>
                    <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg">
                      {{ formatUsdAny(l.balanceAfterNanoUsd) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="ledger.length >= 50" class="border-t border-line/70 px-5 py-2.5 text-xs text-fg-subtle">
              {{ t("redeem.user.ledger.recentHint") }}
            </p>
          </template>
        </template>
      </div>
    </section>
  </div>
</template>
