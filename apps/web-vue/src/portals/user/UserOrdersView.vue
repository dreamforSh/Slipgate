<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { PaymentOrderItem, PaymentOrderStatus } from "@slipgate/contracts";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import ChannelGlyph from "../../components/payments/ChannelGlyph.vue";
import OrderStatusBadge from "../../components/payments/OrderStatusBadge.vue";
import PaymentQrModal from "../../components/payments/PaymentQrModal.vue";
import RefundRequestModal from "../../components/payments/RefundRequestModal.vue";
import { canResume, resultLink, usePayErrors } from "../../components/payments/paymentFlow";
import { formatFiat, STAGGER_CLASS, stagger } from "../../components/payments/paymentUtil";
import { useCheckoutFlow } from "../../components/payments/useCheckoutFlow";
import { usePaymentLabels } from "../../components/payments/usePaymentLabels";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import { useNow } from "../../composables/useNow";
import { apiJson, toQuery } from "../../lib/api";
import { formatDateTime, formatRelative } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const { channelLabel, itemLabel, deliveredText, amountText, kindLabel, statusLabel } = usePaymentLabels();
const toast = useToastStore();
const payError = usePayErrors();
const now = useNow(30_000);
const checkout = useCheckoutFlow();
const { qrOrder, qrOpen } = checkout;

type StatusFilter = "all" | PaymentOrderStatus;

const items = ref<PaymentOrderItem[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);
const status = ref<StatusFilter>("all");
const page = ref(1);
const pageSize = ref(20);

const statusOptions = computed<{ value: StatusFilter; label: string }[]>(() => [
  { value: "all", label: t("common.all") },
  ...(["pending", "paid", "refund_requested", "partially_refunded", "refunded", "expired", "cancelled"] as const).map((s) => ({
    value: s,
    label: statusLabel(s),
  })),
]);

let seq = 0;

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const res = await apiJson<{ items: PaymentOrderItem[]; total: number }>(
      `/api/v1/user/orders${toQuery({
        page: page.value,
        pageSize: pageSize.value,
        status: status.value === "all" ? undefined : status.value,
      })}`,
      { fallbackError: t("payments.orders.loadFailed") },
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
    const message = payError(err, t("payments.orders.loadFailed"));
    if (loaded.value) toast.error(message);
    else loadError.value = message;
  } finally {
    if (mine === seq) loading.value = false;
  }
}

/** Coalesces a filter change and the page reset it causes into one request. */
let scheduled = false;
function scheduleLoad() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void load();
  });
}

watch([status, pageSize], () => {
  page.value = 1;
  scheduleLoad();
});
watch(page, scheduleLoad);
onMounted(() => void load());

/* ---------------- Actions ---------------- */

const busy = ref(new Set<string>());

function setBusy(id: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
}

function replace(order: PaymentOrderItem) {
  items.value = items.value.map((o) => (o.id === order.id ? { ...order, checkout: order.checkout ?? o.checkout } : o));
}

async function cancel(order: PaymentOrderItem) {
  setBusy(order.id, true);
  try {
    const res = await apiJson<{ order: PaymentOrderItem }>(`/api/v1/user/orders/${encodeURIComponent(order.id)}/cancel`, {
      method: "POST",
      fallbackError: t("payments.orders.cancelFailed"),
    });
    replace(res.order);
    if (res.order.status === "cancelled") toast.success(t("payments.orders.cancelled"));
  } catch (err) {
    toast.error(payError(err, t("payments.orders.cancelFailed")));
    void load();
  } finally {
    setBusy(order.id, false);
  }
}

/** Pick up a pending order where it was left: QR again, the provider page, WeChat or Airwallex. */
async function resume(order: PaymentOrderItem) {
  setBusy(order.id, true);
  try {
    await checkout.proceed(order);
  } finally {
    setBusy(order.id, false);
  }
}

function resumeIcon(order: PaymentOrderItem): IconName {
  switch (order.checkout?.flow) {
    case "qrcode":
      return "qr-code";
    case "jsapi":
      return "smartphone";
    case "airwallex":
      return "credit-card";
    default:
      return "external-link";
  }
}

function resumeLabel(order: PaymentOrderItem) {
  return order.checkout?.flow === "qrcode" ? t("payFlow.checkout.showQr") : t("payments.orders.continue");
}

/* Refund request */
const refundTarget = ref<PaymentOrderItem | null>(null);
const refundOpen = ref(false);

function openRefund(order: PaymentOrderItem) {
  refundTarget.value = order;
  refundOpen.value = true;
}

/* ---------------- Display ---------------- */

function shortId(id: string) {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}

function closesIn(order: PaymentOrderItem) {
  // Reads `now` so the label ticks.
  return formatRelative(order.expiresAtIso, now.value);
}

/** One quiet line under the status about the refund, or "". */
function refundLine(o: PaymentOrderItem): string {
  if (o.status === "refund_requested") return t("payFlow.refundInfo.requestedShort");
  if (o.refundAmountMinor > 0 && (o.status === "partially_refunded" || o.status === "refunded" || o.status === "refund_pending")) {
    return t("payFlow.refundInfo.refundedShort", { amount: formatFiat(o.refundAmountMinor, o.currency) });
  }
  return "";
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.orders')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <RouterLink to="/purchase" class="btn btn-primary">
          <UiIcon name="plus" :size="15" />
          {{ t("payments.orders.buy") }}
        </RouterLink>
      </template>
    </PageHeader>

    <UiCard icon="list" :title="t('nav.orders')" flush>
      <template #actions>
        <div class="scrollbar-hide max-w-full overflow-x-auto">
          <SegmentedControl v-model="status" :options="statusOptions" />
        </div>
      </template>

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
      <EmptyState v-else-if="items.length === 0 && status === 'all' && !loading" icon="box" :title="t('payments.orders.empty')">
        <p class="w-full max-w-xs text-xs text-fg-subtle">{{ t("payments.orders.emptyHint") }}</p>
        <RouterLink to="/purchase" class="btn btn-primary btn-sm">
          <UiIcon name="plus" :size="14" />
          {{ t("payments.orders.buy") }}
        </RouterLink>
      </EmptyState>
      <EmptyState v-else-if="items.length === 0 && !loading" icon="search" :title="t('payments.orders.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="status = 'all'">
          {{ t("payments.orders.showAll") }}
        </button>
      </EmptyState>

      <template v-else>
        <!-- Desktop table -->
        <div class="table-wrap hidden transition-opacity duration-200 md:block" :class="loading ? 'opacity-60' : ''">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("payments.orders.table.order") }}</th>
                <th>{{ t("payments.orders.table.item") }}</th>
                <th class="text-right">{{ t("payments.orders.table.amount") }}</th>
                <th>{{ t("payments.orders.table.delivered") }}</th>
                <th>{{ t("payments.orders.table.method") }}</th>
                <th>{{ t("payments.orders.table.status") }}</th>
                <th>{{ t("payments.orders.table.time") }}</th>
                <th class="text-right">{{ t("payments.orders.table.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(o, i) in items" :key="o.id" :class="STAGGER_CLASS" :style="stagger(i)">
                <td class="whitespace-nowrap">
                  <span class="inline-flex items-center gap-0.5">
                    <RouterLink
                      :to="resultLink(o.id)"
                      class="font-mono text-xs text-fg transition-colors hover:text-accent"
                      :title="o.id"
                    >
                      {{ shortId(o.id) }}
                    </RouterLink>
                    <CopyButton :text="o.id" />
                  </span>
                </td>
                <td class="max-w-[14rem]">
                  <p class="truncate text-sm font-medium text-fg" :title="itemLabel(o)">{{ itemLabel(o) }}</p>
                  <p class="mt-0.5 text-2xs text-fg-subtle">{{ kindLabel(o.kind) }}</p>
                </td>
                <td class="whitespace-nowrap text-right font-mono text-xs font-semibold tabular-nums text-fg">
                  {{ amountText(o) }}
                </td>
                <td class="max-w-[14rem] text-xs">
                  <span class="flex min-w-0 items-center gap-1.5" :class="o.status === 'paid' ? 'text-fg' : 'text-fg-muted'">
                    <UiIcon
                      :name="o.kind === 'subscription' ? 'crown' : 'zap'"
                      :size="12"
                      class="shrink-0"
                      :class="o.kind === 'subscription' ? 'text-violet' : 'text-accent'"
                    />
                    <span class="truncate tabular-nums">{{ deliveredText(o) }}</span>
                  </span>
                </td>
                <td class="whitespace-nowrap text-xs text-fg-muted">
                  <span class="inline-flex items-center gap-1.5">
                    <ChannelGlyph :provider="o.provider" :method="o.method" size="xs" />
                    {{ channelLabel(o.provider, o.method) }}
                  </span>
                </td>
                <td>
                  <OrderStatusBadge :status="o.status" />
                  <p v-if="refundLine(o)" class="mt-1 text-2xs tabular-nums text-fg-subtle">{{ refundLine(o) }}</p>
                </td>
                <td class="whitespace-nowrap text-xs">
                  <p class="text-fg-muted" :title="formatDateTime(o.createdAtIso)">{{ formatDateTime(o.createdAtIso) }}</p>
                  <p v-if="o.paidAtIso" class="mt-0.5 text-2xs text-success" :title="formatDateTime(o.paidAtIso)">
                    {{ t("payments.orders.paidAt", { time: formatRelative(o.paidAtIso, now) }) }}
                  </p>
                  <p v-else-if="o.status === 'pending'" class="mt-0.5 text-2xs text-warning">
                    {{ t("payments.orders.closesIn", { time: closesIn(o) }) }}
                  </p>
                </td>
                <td class="whitespace-nowrap text-right">
                  <div class="inline-flex items-center justify-end gap-1">
                    <template v-if="o.status === 'pending'">
                      <button
                        v-if="canResume(o)"
                        type="button"
                        class="btn btn-primary btn-xs"
                        :disabled="busy.has(o.id) || checkout.leaving.value"
                        @click="resume(o)"
                      >
                        <UiIcon :name="resumeIcon(o)" :size="12" />
                        {{ resumeLabel(o) }}
                      </button>
                      <RouterLink v-else-if="o.provider === 'manual'" :to="resultLink(o.id)" class="btn btn-secondary btn-xs">
                        <UiIcon name="file" :size="12" />
                        {{ t("payments.orders.instructions") }}
                      </RouterLink>
                      <ConfirmButton
                        icon="x-circle"
                        :disabled="busy.has(o.id)"
                        :label="t('payments.orders.cancel')"
                        :confirm-label="t('payments.orders.confirmCancel')"
                        @confirm="cancel(o)"
                      />
                    </template>
                    <template v-else>
                      <button v-if="o.canRequestRefund" type="button" class="btn btn-ghost btn-xs" @click="openRefund(o)">
                        <UiIcon name="rotate-ccw" :size="12" />
                        {{ t("payFlow.refundRequest.button") }}
                      </button>
                      <RouterLink :to="resultLink(o.id)" class="btn btn-ghost btn-xs">
                        {{ t("payments.orders.details") }}
                        <UiIcon name="chevron-right" :size="12" />
                      </RouterLink>
                    </template>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Mobile cards -->
        <ul class="divide-y divide-line/60 transition-opacity duration-200 md:hidden" :class="loading ? 'opacity-60' : ''">
          <li v-for="(o, i) in items" :key="o.id" class="px-4 py-4" :class="STAGGER_CLASS" :style="stagger(i)">
            <div class="flex items-start gap-3">
              <ChannelGlyph :provider="o.provider" :method="o.method" size="md" />
              <div class="min-w-0 flex-1">
                <div class="flex items-start justify-between gap-2">
                  <RouterLink :to="resultLink(o.id)" class="min-w-0 truncate text-sm font-semibold text-fg">
                    {{ itemLabel(o) }}
                  </RouterLink>
                  <span class="shrink-0 font-mono text-sm font-semibold tabular-nums text-fg">{{ amountText(o) }}</span>
                </div>
                <div class="mt-1 flex items-center justify-between gap-2">
                  <span class="min-w-0 truncate text-xs text-fg-muted">{{ deliveredText(o) }}</span>
                  <OrderStatusBadge :status="o.status" />
                </div>
                <p class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-subtle">
                  <span class="font-mono">{{ shortId(o.id) }}</span>
                  <span>·</span>
                  <span>{{ channelLabel(o.provider, o.method) }}</span>
                  <span>·</span>
                  <span>{{ formatDateTime(o.createdAtIso) }}</span>
                  <template v-if="refundLine(o)">
                    <span>·</span>
                    <span class="tabular-nums">{{ refundLine(o) }}</span>
                  </template>
                </p>
                <div v-if="o.status === 'pending'" class="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    v-if="canResume(o)"
                    type="button"
                    class="btn btn-primary btn-sm"
                    :disabled="busy.has(o.id) || checkout.leaving.value"
                    @click="resume(o)"
                  >
                    <UiIcon :name="resumeIcon(o)" :size="13" />
                    {{ resumeLabel(o) }}
                  </button>
                  <RouterLink v-else-if="o.provider === 'manual'" :to="resultLink(o.id)" class="btn btn-secondary btn-sm">
                    <UiIcon name="file" :size="13" />
                    {{ t("payments.orders.instructions") }}
                  </RouterLink>
                  <ConfirmButton
                    size="sm"
                    icon="x-circle"
                    :disabled="busy.has(o.id)"
                    :label="t('payments.orders.cancel')"
                    :confirm-label="t('payments.orders.confirmCancel')"
                    @confirm="cancel(o)"
                  />
                  <span class="ml-auto text-2xs text-warning">{{ t("payments.orders.closesIn", { time: closesIn(o) }) }}</span>
                </div>
                <div v-else-if="o.canRequestRefund" class="mt-3">
                  <button type="button" class="btn btn-secondary btn-sm" @click="openRefund(o)">
                    <UiIcon name="rotate-ccw" :size="13" />
                    {{ t("payFlow.refundRequest.button") }}
                  </button>
                </div>
              </div>
            </div>
          </li>
        </ul>
      </template>

      <UiPagination
        v-if="total > 0"
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="total"
        :disabled="loading"
      />
    </UiCard>

    <PaymentQrModal v-model:open="qrOpen" :order="qrOrder" @paid="checkout.onQrPaid" @changed="replace" />
    <RefundRequestModal v-model:open="refundOpen" :order="refundTarget" @done="replace" />
  </div>
</template>
