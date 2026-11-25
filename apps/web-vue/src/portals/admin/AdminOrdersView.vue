<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type {
  AdminOrderActionRequest,
  AdminRefundResult,
  OrderVerifyResult,
  PaymentOrderItem,
  PaymentOrderStatus,
  PaymentProvider,
  PaymentSweepResult,
} from "@slipgate/contracts";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import AdminOrderDetailDrawer from "../../components/payments/AdminOrderDetailDrawer.vue";
import AdminRefundModal from "../../components/payments/AdminRefundModal.vue";
import ChannelGlyph from "../../components/payments/ChannelGlyph.vue";
import OrderStatusBadge from "../../components/payments/OrderStatusBadge.vue";
import { payApi, usePayErrors } from "../../components/payments/paymentFlow";
import { formatFiat, ORDER_STATUSES, STAGGER_CLASS, stagger, useDebounced } from "../../components/payments/paymentUtil";
import { usePaymentLabels } from "../../components/payments/usePaymentLabels";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiModal from "../../components/ui/UiModal.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import { apiJson, toQuery } from "../../lib/api";
import { formatDateTime, formatRelative, formatUsd } from "../../lib/format";
import { useToastStore } from "../../stores/toast";
import UiSelect from "../../components/ui/UiSelect.vue";

const { t, channelLabel, providerLabel, statusLabel, itemLabel, deliveredText, amountText, kindLabel } = usePaymentLabels();
const route = useRoute();
const router = useRouter();
const toast = useToastStore();
const payError = usePayErrors();

/* ---------------- Filters (seeded from ?search= / ?userId= / ?status=) ---------------- */

const PROVIDERS: PaymentProvider[] = ["easypay", "stripe", "alipay", "wxpay", "airwallex", "manual"];

const queryText = (v: unknown) => (typeof v === "string" ? v : "");
const seededStatus = queryText(route.query.status) as PaymentOrderStatus;

const search = ref(queryText(route.query.search));
const debouncedSearch = useDebounced(search);
const statusFilter = ref<"all" | PaymentOrderStatus>(ORDER_STATUSES.includes(seededStatus) ? seededStatus : "all");
const providerFilter = ref<"all" | PaymentProvider>("all");
const userId = ref(queryText(route.query.userId));
const userLabel = ref(queryText(route.query.email));
const page = ref(1);
const pageSize = ref(20);

const hasFilters = computed(
  () => debouncedSearch.value.trim() !== "" || statusFilter.value !== "all" || providerFilter.value !== "all" || userId.value !== "",
);

function resetFilters() {
  search.value = "";
  debouncedSearch.value = "";
  statusFilter.value = "all";
  providerFilter.value = "all";
  clearUser();
}

function filterByUser(order: PaymentOrderItem) {
  userId.value = order.userId;
  userLabel.value = order.userEmail;
}

function clearUser() {
  userId.value = "";
  userLabel.value = "";
}

const params = computed(() => ({
  search: debouncedSearch.value.trim() || undefined,
  status: statusFilter.value === "all" ? undefined : statusFilter.value,
  provider: providerFilter.value === "all" ? undefined : providerFilter.value,
  userId: userId.value || undefined,
}));

// Keep the URL shareable without stacking history entries.
watch([debouncedSearch, userId, statusFilter], () => {
  const query = { ...route.query };
  const s = debouncedSearch.value.trim();
  if (s) query.search = s;
  else delete query.search;
  if (userId.value) {
    query.userId = userId.value;
    if (userLabel.value) query.email = userLabel.value;
  } else {
    delete query.userId;
    delete query.email;
  }
  if (statusFilter.value !== "all") query.status = statusFilter.value;
  else delete query.status;
  void router.replace({ query });
});

/* ---------------- Loading ---------------- */

const items = ref<PaymentOrderItem[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);

let seq = 0;
let scheduled = false;

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const res = await apiJson<{ items: PaymentOrderItem[]; total: number }>(
      `/api/v1/admin/payments/orders${toQuery({ ...params.value, page: page.value, pageSize: pageSize.value })}`,
      { fallbackError: t("payments.admin.orders.errors.load") },
    );
    if (mine !== seq) return;
    items.value = res.items;
    total.value = res.total;
    loaded.value = true;
    loadError.value = null;
    if (res.items.length === 0 && res.total > 0 && page.value > 1) {
      page.value = Math.max(1, Math.ceil(res.total / pageSize.value));
    }
  } catch (err) {
    if (mine !== seq) return;
    const message = payError(err, t("payments.admin.orders.errors.load"));
    if (loaded.value) toast.error(message);
    else loadError.value = message;
  } finally {
    if (mine === seq) loading.value = false;
  }
}

function scheduleLoad() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void load();
  });
}

watch([params, pageSize], () => {
  page.value = 1;
  scheduleLoad();
});
watch(page, scheduleLoad);
onMounted(() => void load());

/* ---------------- Row state ---------------- */

const busy = ref(new Set<string>());

function setBusy(id: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
}

function replace(order: PaymentOrderItem) {
  items.value = items.value.map((o) => (o.id === order.id ? order : o));
  if (detailSnapshot.value?.id === order.id) detailSnapshot.value = order;
}

async function act(
  order: PaymentOrderItem,
  body: AdminOrderActionRequest,
  success: string,
  /** mark_paid: shown instead of `success` when the order is paid but could not be delivered. */
  undelivered?: (reason: string) => string,
): Promise<boolean> {
  setBusy(order.id, true);
  try {
    const res = await apiJson<{ order: PaymentOrderItem }>(
      `/api/v1/admin/payments/orders/${encodeURIComponent(order.id)}/action`,
      { method: "POST", body, fallbackError: t("payments.admin.orders.errors.action") },
    );
    replace(res.order);
    if (undelivered && res.order.deliveryError) toast.warning(undelivered(res.order.deliveryError));
    else toast.success(success);
    return true;
  } catch (err) {
    toast.error(payError(err, t("payments.admin.orders.errors.action"), { conflict: t("payFlow.errors.refundConflict") }));
    void load();
    return false;
  } finally {
    setBusy(order.id, false);
  }
}

function cancelOrder(order: PaymentOrderItem) {
  void act(order, { action: "cancel", reclaimBalance: false }, t("payments.admin.orders.cancelSuccess"));
}

function rejectRefund(order: PaymentOrderItem) {
  void act(order, { action: "reject_refund", reclaimBalance: false }, t("payFlow.adminOrders.rejected"));
}

const canMarkPaid = (o: PaymentOrderItem) => o.status === "pending" || o.status === "expired" || o.status === "cancelled" || o.status === "failed";
const canVerify = (o: PaymentOrderItem) => o.provider !== "manual" && (o.status === "pending" || o.status === "expired");
/** Paid, but the subscription could not be granted (its group was deleted or switched to balance billing). */
const isUndelivered = (o: PaymentOrderItem) => o.status === "paid" && Boolean(o.deliveryError);

function redeliver(order: PaymentOrderItem) {
  void act(order, { action: "mark_paid", reclaimBalance: false }, t("payments.admin.orders.redeliver.success"), (reason) =>
    t("payments.admin.orders.redeliver.failed", { reason }),
  );
}

/* ---------------- Provider checks ---------------- */

function verifyToast(res: OrderVerifyResult) {
  if (res.recovered) toast.success(t("payFlow.verify.recovered"));
  else if (res.providerStatus === "paid" && res.message) toast.warning(t("payFlow.verify.mismatch", { message: res.message }));
  else if (res.providerStatus === "paid") toast.success(t("payFlow.verify.paid"));
  else if (res.providerStatus === "pending") toast.info(t("payFlow.verify.pending"));
  else if (res.providerStatus === "failed") toast.warning(t("payFlow.verify.failed"));
  else toast.warning(res.message ? t("payFlow.verify.unknown", { message: res.message }) : t("payFlow.verify.unknownPlain"));
}

async function verify(order: PaymentOrderItem) {
  setBusy(order.id, true);
  try {
    const res = await apiJson<OrderVerifyResult>(`/api/v1/admin/payments/orders/${encodeURIComponent(order.id)}/verify`, { method: "POST" });
    replace(res.order);
    verifyToast(res);
  } catch (err) {
    toast.error(payError(err, t("payFlow.verify.unknownPlain")));
  } finally {
    setBusy(order.id, false);
  }
}

function refundToast(res: AdminRefundResult) {
  if (res.outcome === "refunded") toast.success(t("payFlow.adminRefund.outcome.refunded"));
  else if (res.outcome === "pending") toast.info(t("payFlow.adminRefund.outcome.pending"));
  else toast.error(t("payFlow.adminRefund.outcome.failed", { message: res.message ?? res.order.refundError ?? "" }));
}

async function queryRefund(order: PaymentOrderItem) {
  setBusy(order.id, true);
  try {
    const res = await payApi<AdminRefundResult>(`/api/v1/admin/payments/orders/${encodeURIComponent(order.id)}/refund/query`, { method: "POST" });
    replace(res.order);
    refundToast(res);
  } catch (err) {
    toast.warning(payError(err, t("payFlow.adminOrders.queryFailed"), { conflict: t("payFlow.errors.refundConflict") }));
  } finally {
    setBusy(order.id, false);
  }
}

const sweeping = ref(false);

async function sweep() {
  if (sweeping.value) return;
  sweeping.value = true;
  try {
    const res = await apiJson<PaymentSweepResult>("/api/v1/admin/payments/orders/sweep", { method: "POST" });
    if (res.recovered + res.expired + res.refundsSettled === 0) toast.info(t("payFlow.adminOrders.sweepNothing"));
    else
      toast.success(
        t("payFlow.adminOrders.sweepDone", { recovered: res.recovered, expired: res.expired, refunds: res.refundsSettled }),
      );
    void load();
  } catch (err) {
    toast.error(payError(err, t("payFlow.adminOrders.sweepFailed")));
  } finally {
    sweeping.value = false;
  }
}

/* ---------------- Mark paid ---------------- */

const markTarget = ref<PaymentOrderItem | null>(null);
const markOpen = ref(false);
const tradeNo = ref("");

function openMarkPaid(order: PaymentOrderItem) {
  markTarget.value = order;
  tradeNo.value = "";
  markOpen.value = true;
}

async function submitMarkPaid() {
  const o = markTarget.value;
  if (!o) return;
  const body: AdminOrderActionRequest = { action: "mark_paid", reclaimBalance: false };
  const no = tradeNo.value.trim();
  if (no) body.providerTradeNo = no;
  const done = await act(o, body, t("payments.admin.orders.markPaid.success"), (reason) =>
    t("payments.admin.orders.markPaid.undelivered", { reason }),
  );
  if (done) markOpen.value = false;
}

const markBusy = computed(() => busy.value.has(markTarget.value?.id ?? ""));

/* ---------------- Refund dialog ---------------- */

const refundTarget = ref<PaymentOrderItem | null>(null);
const refundOpen = ref(false);

function openRefund(order: PaymentOrderItem) {
  refundTarget.value = order;
  refundOpen.value = true;
}

function onRefundDone(res: AdminRefundResult) {
  replace(res.order);
  refundToast(res);
}

function onRejected(order: PaymentOrderItem) {
  replace(order);
  toast.success(t("payFlow.adminOrders.rejected"));
}

/* ---------------- Detail drawer ---------------- */

const detailSnapshot = ref<PaymentOrderItem | null>(null);
const detailOpen = ref(false);

function openDetail(order: PaymentOrderItem) {
  detailSnapshot.value = order;
  detailOpen.value = true;
}

function refundFromDetail(order: PaymentOrderItem) {
  detailOpen.value = false;
  openRefund(order);
}

/* ---------------- Display ---------------- */

function deliverPhrase(o: PaymentOrderItem) {
  return o.kind === "subscription"
    ? t("payments.admin.orders.deliver.subscription", { group: o.groupName || t("payments.unknownGroup"), days: o.validityDays ?? 0 })
    : t("payments.admin.orders.deliver.credit", { amount: formatUsd(o.creditNanoUsd) });
}

function shortId(id: string) {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}

function userLink(email: string) {
  return { path: "/admin/users", query: { search: email } };
}

/** One quiet line under the status badge about the refund flow, or "". */
function refundLine(o: PaymentOrderItem): string {
  if (o.status === "refund_requested" && o.refundRequestedAtIso) {
    return t("payFlow.adminOrders.refundRequested", { time: formatRelative(o.refundRequestedAtIso) });
  }
  if (o.refundAmountMinor > 0 && (o.status === "partially_refunded" || o.status === "refund_pending" || o.status === "refund_failed")) {
    return t("payFlow.adminOrders.refundPart", { amount: formatFiat(o.refundAmountMinor, o.currency), total: formatFiat(o.amountMinor, o.currency) });
  }
  return "";
}

const statusOptions = computed(() => ORDER_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })));
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.paymentOrders')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <button type="button" class="btn btn-secondary" :disabled="sweeping" :title="t('payFlow.adminOrders.sweepHint')" @click="sweep">
          <UiIcon :name="sweeping ? 'loader' : 'radar'" :size="15" :spin="sweeping" />
          <span class="hidden sm:inline">{{ t("payFlow.adminOrders.sweep") }}</span>
        </button>
        <RouterLink to="/admin/payments" class="btn btn-secondary">
          <UiIcon name="trending-up" :size="15" />
          <span class="hidden sm:inline">{{ t("nav.paymentDashboard") }}</span>
        </RouterLink>
      </template>
    </PageHeader>

    <UiCard icon="list" :title="t('nav.paymentOrders')" flush>
      <template #actions>
        <span v-if="loaded" class="text-xs tabular-nums text-fg-subtle">{{ total }}</span>
      </template>

      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span class="sr-only">{{ t("common.search") }}</span>
          <UiIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            v-model="search"
            type="search"
            class="input input-sm pl-8"
            :placeholder="t('payments.admin.orders.searchPlaceholder')"
          />
        </label>
        <UiSelect v-model="statusFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('payments.admin.orders.table.status')">
          <option value="all">{{ t("payments.admin.orders.allStatuses") }}</option>
          <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </UiSelect>
        <UiSelect v-model="providerFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('payments.admin.orders.table.channel')">
          <option value="all">{{ t("payments.admin.orders.allProviders") }}</option>
          <option v-for="p in PROVIDERS" :key="p" :value="p">{{ providerLabel(p) }}</option>
        </UiSelect>
        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          enter-from-class="scale-95 opacity-0"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          leave-to-class="scale-95 opacity-0"
        >
          <span
            v-if="userId"
            class="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-accent/10 pl-3 pr-1 text-xs text-accent ring-1 ring-inset ring-accent/25"
          >
            <UiIcon name="user" :size="12" class="shrink-0" />
            <span class="truncate font-medium">{{ userLabel || userId }}</span>
            <button
              type="button"
              class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent/15"
              :title="t('payments.admin.orders.clearUser')"
              :aria-label="t('payments.admin.orders.clearUser')"
              @click="clearUser"
            >
              <UiIcon name="x" :size="12" />
            </button>
          </span>
        </Transition>
      </div>

      <div v-if="loadError && !loaded" class="p-5">
        <UiAlert tone="warning">
          {{ loadError }}
          <template #action>
            <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="load">
              {{ t("common.refresh") }}
            </button>
          </template>
        </UiAlert>
      </div>
      <ListSkeleton v-else-if="!loaded && loading" />
      <EmptyState v-else-if="items.length === 0 && !hasFilters && !loading" icon="credit-card" :title="t('payments.admin.orders.empty')">
        <p class="w-full max-w-xs text-xs text-fg-subtle">{{ t("payments.admin.orders.emptyHint") }}</p>
      </EmptyState>
      <EmptyState v-else-if="items.length === 0 && !loading" icon="search" :title="t('payments.admin.orders.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("payments.admin.orders.clearFilters") }}
        </button>
      </EmptyState>
      <div v-else class="table-wrap transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("payments.admin.orders.table.order") }}</th>
              <th>{{ t("payments.admin.orders.table.user") }}</th>
              <th>{{ t("payments.admin.orders.table.item") }}</th>
              <th class="text-right">{{ t("payments.admin.orders.table.amount") }}</th>
              <th>{{ t("payments.admin.orders.table.credit") }}</th>
              <th>{{ t("payments.admin.orders.table.channel") }}</th>
              <th>{{ t("payments.admin.orders.table.status") }}</th>
              <th>{{ t("payments.admin.orders.table.tradeNo") }}</th>
              <th>{{ t("payments.admin.orders.table.created") }}</th>
              <th>{{ t("payments.admin.orders.table.paid") }}</th>
              <th class="text-right">{{ t("payments.admin.orders.table.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(o, i) in items" :key="o.id" :class="STAGGER_CLASS" :style="stagger(i)">
              <td class="whitespace-nowrap">
                <span class="inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    class="rounded font-mono text-xs text-fg transition-colors hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    :title="t('payFlow.adminOrders.details')"
                    @click="openDetail(o)"
                  >
                    {{ shortId(o.id) }}
                  </button>
                  <CopyButton :text="o.id" />
                </span>
              </td>
              <td class="max-w-[14rem]">
                <div class="flex min-w-0 items-center gap-0.5">
                  <RouterLink
                    :to="userLink(o.userEmail)"
                    class="truncate text-xs text-fg transition-colors hover:text-accent"
                    :title="t('payments.admin.orders.viewUser')"
                  >
                    {{ o.userEmail || o.userId }}
                  </RouterLink>
                  <button
                    v-if="userId !== o.userId"
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs shrink-0"
                    :title="t('payments.admin.orders.filterUser')"
                    :aria-label="t('payments.admin.orders.filterUser')"
                    @click="filterByUser(o)"
                  >
                    <UiIcon name="filter" :size="12" />
                  </button>
                </div>
              </td>
              <td class="max-w-[12rem]">
                <p class="truncate text-xs font-medium text-fg" :title="itemLabel(o)">{{ itemLabel(o) }}</p>
                <UiBadge class="mt-1" :tone="o.kind === 'subscription' ? 'violet' : 'accent'">{{ kindLabel(o.kind) }}</UiBadge>
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs font-semibold tabular-nums text-fg">{{ amountText(o) }}</td>
              <td class="max-w-[12rem] text-xs">
                <span class="block truncate tabular-nums" :class="o.status === 'paid' ? 'text-fg' : 'text-fg-muted'" :title="deliveredText(o)">
                  {{ deliveredText(o) }}
                </span>
              </td>
              <td class="whitespace-nowrap text-xs text-fg-muted">
                <span class="inline-flex items-center gap-1.5">
                  <ChannelGlyph :provider="o.provider" :method="o.method" size="xs" />
                  {{ channelLabel(o.provider, o.method) }}
                </span>
                <p
                  v-if="o.providerInstanceName"
                  class="mt-0.5 max-w-[10rem] truncate pl-[26px] text-2xs text-fg-subtle"
                  :title="`${t('payFlow.adminOrders.instance')}: ${o.providerInstanceName}`"
                >
                  {{ o.providerInstanceName }}
                </p>
              </td>
              <td>
                <span class="inline-flex flex-wrap items-center gap-1">
                  <OrderStatusBadge :status="o.status" />
                  <span v-if="isUndelivered(o)" :title="t('payments.admin.orders.undeliveredHint', { reason: o.deliveryError ?? '' })">
                    <UiBadge tone="warning">
                      <UiIcon name="alert" :size="11" />
                      {{ t("payments.admin.orders.undelivered") }}
                    </UiBadge>
                  </span>
                </span>
                <p
                  v-if="refundLine(o)"
                  class="mt-1 whitespace-nowrap text-2xs tabular-nums"
                  :class="o.status === 'refund_failed' ? 'text-danger' : 'text-fg-subtle'"
                  :title="o.status === 'refund_failed' ? (o.refundError ?? '') : (o.refundRequestReason ?? '')"
                >
                  {{ refundLine(o) }}
                </p>
              </td>
              <td class="max-w-[10rem]">
                <span v-if="o.providerTradeNo" class="flex min-w-0 items-center gap-0.5">
                  <span class="truncate font-mono text-2xs text-fg-muted" :title="o.providerTradeNo">{{ o.providerTradeNo }}</span>
                  <CopyButton :text="o.providerTradeNo" />
                </span>
                <span v-else class="text-xs text-fg-subtle">-</span>
              </td>
              <td class="whitespace-nowrap text-xs text-fg-subtle" :title="formatDateTime(o.createdAtIso)">
                {{ formatRelative(o.createdAtIso) }}
              </td>
              <td class="whitespace-nowrap text-xs" :title="formatDateTime(o.paidAtIso)">
                <span v-if="o.paidAtIso" class="text-fg-muted">{{ formatRelative(o.paidAtIso) }}</span>
                <span v-else class="text-fg-subtle">-</span>
              </td>
              <td class="whitespace-nowrap text-right">
                <div class="inline-flex items-center justify-end gap-1">
                  <button
                    v-if="canVerify(o)"
                    type="button"
                    class="btn btn-secondary btn-xs"
                    :disabled="busy.has(o.id)"
                    :title="t('payFlow.verify.button')"
                    @click="verify(o)"
                  >
                    <UiIcon :name="busy.has(o.id) ? 'loader' : 'search'" :size="12" :spin="busy.has(o.id)" />
                    {{ t("payFlow.verify.short") }}
                  </button>
                  <button
                    v-if="canMarkPaid(o)"
                    type="button"
                    class="btn btn-success btn-xs"
                    :disabled="busy.has(o.id)"
                    @click="openMarkPaid(o)"
                  >
                    <UiIcon name="check-circle" :size="12" />
                    {{ t("payments.admin.orders.actions.markPaid") }}
                  </button>
                  <button
                    v-if="isUndelivered(o)"
                    type="button"
                    class="btn btn-secondary btn-xs"
                    :disabled="busy.has(o.id)"
                    :title="t('payments.admin.orders.undeliveredHint', { reason: o.deliveryError ?? '' })"
                    @click="redeliver(o)"
                  >
                    <UiIcon name="refresh" :size="12" />
                    {{ t("payments.admin.orders.actions.redeliver") }}
                  </button>
                  <ConfirmButton
                    v-if="o.status === 'pending'"
                    icon="x-circle"
                    :disabled="busy.has(o.id)"
                    :label="t('payments.admin.orders.actions.cancel')"
                    :confirm-label="t('payments.admin.orders.actions.confirmCancel')"
                    @confirm="cancelOrder(o)"
                  />
                  <button
                    v-if="o.status === 'paid'"
                    type="button"
                    class="btn btn-ghost btn-xs hover:!bg-danger/10 hover:!text-danger"
                    :disabled="busy.has(o.id)"
                    @click="openRefund(o)"
                  >
                    <UiIcon name="rotate-ccw" :size="12" />
                    {{ t("payments.admin.orders.actions.refund") }}
                  </button>
                  <button
                    v-if="o.status === 'refund_requested'"
                    type="button"
                    class="btn btn-primary btn-xs"
                    :disabled="busy.has(o.id)"
                    @click="openRefund(o)"
                  >
                    <UiIcon name="badge-check" :size="12" />
                    {{ t("payFlow.adminOrders.review") }}
                  </button>
                  <template v-if="o.status === 'refund_pending'">
                    <button type="button" class="btn btn-secondary btn-xs" :disabled="busy.has(o.id)" @click="queryRefund(o)">
                      <UiIcon :name="busy.has(o.id) ? 'loader' : 'refresh'" :size="12" :spin="busy.has(o.id)" />
                      {{ t("payFlow.adminOrders.queryRefund") }}
                    </button>
                    <button type="button" class="btn btn-ghost btn-xs" :disabled="busy.has(o.id)" @click="openRefund(o)">
                      {{ t("payFlow.adminOrders.retryRefund") }}
                    </button>
                  </template>
                  <template v-if="o.status === 'refund_failed'">
                    <button type="button" class="btn btn-danger btn-xs" :disabled="busy.has(o.id)" @click="openRefund(o)">
                      <UiIcon name="rotate-ccw" :size="12" />
                      {{ t("payFlow.adminOrders.retryRefund") }}
                    </button>
                    <ConfirmButton
                      icon="x-circle"
                      :disabled="busy.has(o.id)"
                      :label="t('payFlow.adminOrders.reject')"
                      :confirm-label="t('payFlow.adminOrders.confirmReject')"
                      @confirm="rejectRefund(o)"
                    />
                  </template>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :title="t('payFlow.adminOrders.details')"
                    :aria-label="t('payFlow.adminOrders.details')"
                    @click="openDetail(o)"
                  >
                    <UiIcon name="chevron-right" :size="13" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <UiPagination v-if="total > 0" v-model:page="page" v-model:page-size="pageSize" :total="total" :disabled="loading" />
    </UiCard>

    <!-- Mark paid -->
    <UiModal v-model:open="markOpen" width="md" :title="t('payments.admin.orders.markPaid.title')" :persistent="markBusy">
      <template #icon>
        <span class="icon-chip icon-chip-success h-8 w-8"><UiIcon name="check-circle" :size="15" /></span>
      </template>
      <form v-if="markTarget" id="order-mark-paid-form" class="space-y-4" @submit.prevent="submitMarkPaid">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-line bg-surface-2/40 p-3.5 text-xs">
          <div class="col-span-2 min-w-0">
            <dt class="text-fg-subtle">{{ t("payments.admin.orders.summary.order") }}</dt>
            <dd class="mt-0.5 truncate font-mono text-fg">{{ markTarget.id }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("payments.admin.orders.summary.user") }}</dt>
            <dd class="mt-0.5 truncate text-fg">{{ markTarget.userEmail }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("payments.admin.orders.summary.amount") }}</dt>
            <dd class="mt-0.5 font-semibold tabular-nums text-fg">{{ amountText(markTarget) }}</dd>
          </div>
        </dl>
        <p class="text-sm leading-relaxed text-fg-muted">
          {{ t("payments.admin.orders.markPaid.body", { deliver: deliverPhrase(markTarget) }) }}
        </p>
        <UiAlert v-if="markTarget.status !== 'pending'" tone="warning">
          {{ t("payments.admin.orders.markPaid.late", { status: statusLabel(markTarget.status) }) }}
        </UiAlert>
        <FormField :label="t('payments.admin.orders.markPaid.tradeNo')">
          <input
            v-model="tradeNo"
            type="text"
            maxlength="128"
            class="input font-mono"
            autocomplete="off"
            :placeholder="t('payments.admin.orders.markPaid.tradeNoPlaceholder')"
          />
          <p class="hint">{{ t("payments.admin.orders.markPaid.tradeNoHint") }}</p>
        </FormField>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="markBusy" @click="markOpen = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="order-mark-paid-form" class="btn btn-primary" :disabled="markBusy">
          <UiIcon v-if="markBusy" name="loader" :size="15" spin />
          {{ t("payments.admin.orders.markPaid.submit") }}
        </button>
      </template>
    </UiModal>

    <AdminRefundModal v-model:open="refundOpen" :order="refundTarget" @done="onRefundDone" @rejected="onRejected" />

    <AdminOrderDetailDrawer
      v-model:open="detailOpen"
      :order="detailSnapshot"
      :busy="busy.has(detailSnapshot?.id ?? '')"
      @verify="verify"
      @query-refund="queryRefund"
      @refund="refundFromDetail"
    />
  </div>
</template>
