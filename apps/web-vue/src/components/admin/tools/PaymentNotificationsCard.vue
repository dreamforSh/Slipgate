<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { PaymentNotification } from "@slipgate/contracts";
import EmptyState from "../../ui/EmptyState.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { apiJson, errorText, toQuery } from "../../../lib/api";
import { formatDateTime } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";

/**
 * Payment notifications sent to plugins: one per paid order, delivered per plugin with retries.
 * Failed / dead-lettered ones can be replayed here, which re-sends the notification only (the
 * order's credit or subscription is never delivered again).
 */
const { t } = useI18n();
const toast = useToastStore();

type Filter = "attention" | "dispatched" | "all";
const filter = ref<Filter>("attention");
const filterOptions = [
  { value: "attention" as const, label: t("adminTools.notifications.filters.attention") },
  { value: "dispatched" as const, label: t("adminTools.notifications.filters.dispatched") },
  { value: "all" as const, label: t("adminTools.notifications.filters.all") },
];

const items = ref<PaymentNotification[]>([]);
const loading = ref(false);
const replaying = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    const fetchStatus = async (status?: PaymentNotification["status"]) =>
      (await apiJson<{ items: PaymentNotification[] }>(`/api/v1/admin/payments/notifications${toQuery({ status, limit: 50 })}`)).items;
    if (filter.value === "attention") {
      const [pending, dead] = await Promise.all([fetchStatus("pending"), fetchStatus("dead_letter")]);
      items.value = [...dead, ...pending.filter((n) => n.attempts > 0)];
    } else {
      items.value = await fetchStatus(filter.value === "all" ? undefined : "dispatched");
    }
  } catch (err) {
    toast.error(errorText(err, t("adminTools.notifications.errors.load")));
  } finally {
    loading.value = false;
  }
}

async function replay(n: PaymentNotification, plugin?: string) {
  replaying.value = `${n.orderId}:${plugin ?? "*"}`;
  try {
    const res = await apiJson<{ item: PaymentNotification }>(`/api/v1/admin/payments/notifications/${encodeURIComponent(n.orderId)}/replay`, {
      method: "POST",
      body: plugin ? { plugin } : {},
    });
    items.value = items.value.map((i) => (i.id === res.item.id ? res.item : i));
    toast.success(res.item.status === "dispatched" ? t("adminTools.notifications.replayed") : t("adminTools.notifications.replayFailed"));
  } catch (err) {
    toast.error(errorText(err, t("adminTools.notifications.errors.replay")));
  } finally {
    replaying.value = null;
  }
}

const STATUS_TONE = { pending: "warning", dispatched: "success", dead_letter: "danger" } as const;
const DELIVERY_TONE = { pending: "neutral", delivered: "success", failed: "danger" } as const;

watch(filter, () => void load());
onMounted(() => void load());
defineExpose({ load });
</script>

<template>
  <UiCard icon="bell" :title="t('adminTools.notifications.title')" flush>
    <template #actions>
      <SegmentedControl v-model="filter" :options="filterOptions" />
      <button type="button" class="btn btn-ghost btn-icon btn-sm" :disabled="loading" :aria-label="t('common.refresh')" @click="load">
        <UiIcon name="refresh" :size="14" :spin="loading" />
      </button>
    </template>
    <p class="border-b border-line/70 px-5 py-2.5 text-xs text-fg-subtle">{{ t("adminTools.notifications.intro") }}</p>
    <EmptyState v-if="!loading && items.length === 0" compact icon="check-circle" :title="t('adminTools.notifications.empty')" />
    <div v-else class="table-wrap" :class="loading ? 'opacity-60' : ''">
      <table class="data-table">
        <thead>
          <tr>
            <th>{{ t("adminTools.notifications.columns.order") }}</th>
            <th>{{ t("adminTools.notifications.columns.status") }}</th>
            <th>{{ t("adminTools.notifications.columns.deliveries") }}</th>
            <th>{{ t("adminTools.notifications.columns.next") }}</th>
            <th class="text-right">{{ t("common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="n in items" :key="n.id">
            <td class="whitespace-nowrap">
              <p class="font-mono text-xs text-fg">{{ n.orderId }}</p>
              <p class="text-2xs text-fg-subtle">{{ formatDateTime(n.createdAtIso) }}</p>
            </td>
            <td>
              <UiBadge :tone="STATUS_TONE[n.status]" dot>{{ t(`adminTools.notifications.status.${n.status}`) }}</UiBadge>
            </td>
            <td class="max-w-[22rem]">
              <div class="flex flex-col gap-1">
                <div v-for="d in n.deliveries" :key="d.plugin" class="flex min-w-0 items-center gap-1.5">
                  <UiBadge :tone="DELIVERY_TONE[d.status]" mono>{{ d.plugin }}</UiBadge>
                  <span class="text-2xs tabular-nums text-fg-subtle">{{ t("adminTools.notifications.attempts", { n: d.attempts }) }}</span>
                  <span v-if="d.lastError" class="truncate text-2xs text-danger" :title="d.lastError">{{ d.lastError }}</span>
                  <button
                    v-if="d.status !== 'delivered'"
                    type="button"
                    class="btn btn-ghost btn-xs ml-auto shrink-0"
                    :disabled="replaying !== null"
                    @click="replay(n, d.plugin)"
                  >
                    {{ t("adminTools.notifications.replayOne") }}
                  </button>
                </div>
                <span v-if="!n.deliveries.length" class="text-2xs text-fg-subtle">—</span>
              </div>
            </td>
            <td class="whitespace-nowrap text-xs text-fg-muted">{{ n.nextRetryAtIso ? formatDateTime(n.nextRetryAtIso) : "—" }}</td>
            <td class="whitespace-nowrap text-right">
              <button type="button" class="btn btn-secondary btn-xs" :disabled="replaying !== null" :title="t('adminTools.notifications.replayHint')" @click="replay(n)">
                <UiIcon :name="replaying === `${n.orderId}:*` ? 'loader' : 'rotate-ccw'" :size="13" :spin="replaying === `${n.orderId}:*`" />
                {{ t("adminTools.notifications.replayAll") }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </UiCard>
</template>
