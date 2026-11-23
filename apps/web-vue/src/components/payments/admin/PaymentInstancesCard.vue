<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { PaymentCurrency, PaymentInstanceProvider, PaymentProviderInstance } from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import type { Tone } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import ListSkeleton from "../../admin/ops/ListSkeleton.vue";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiDropdown from "../../ui/UiDropdown.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import ChannelGlyph from "../ChannelGlyph.vue";
import { usePayErrors } from "../paymentFlow";
import { formatFiat } from "../paymentUtil";
import { usePaymentLabels } from "../usePaymentLabels";
import { INSTANCE_PROVIDERS } from "./instanceForm";
import PaymentInstanceDrawer from "./PaymentInstanceDrawer.vue";

/**
 * Payment provider instances (/admin/payments/providers): every merchant account with its
 * methods, readiness, today's volume and refund flags. Enable / disable, reorder (the order
 * the load balancer walks), edit in a drawer, delete. Saved per action, not by the page's
 * save bar.
 */
const props = defineProps<{ currency: PaymentCurrency; notifyBase: string }>();

const { t } = useI18n();
const { providerLabel, channelLabel } = usePaymentLabels();
const toast = useToastStore();
const payError = usePayErrors();

const items = ref<PaymentProviderInstance[]>([]);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);
const busy = ref(new Set<string>());
const reordering = ref(false);

function setBusy(id: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
}

async function load() {
  loading.value = true;
  try {
    const res = await apiJson<{ items: PaymentProviderInstance[] }>("/api/v1/admin/payments/providers");
    items.value = res.items;
    loaded.value = true;
    loadError.value = null;
  } catch (err) {
    loadError.value = payError(err, t("payFlow.instances.loadFailed"));
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

/* ---------------- Actions ---------------- */

function upsert(item: PaymentProviderInstance) {
  const i = items.value.findIndex((x) => x.id === item.id);
  if (i === -1) items.value = [...items.value, item];
  else items.value = items.value.map((x) => (x.id === item.id ? item : x));
}

async function toggle(item: PaymentProviderInstance, enabled: boolean) {
  setBusy(item.id, true);
  upsert({ ...item, enabled });
  try {
    const res = await apiJson<{ item: PaymentProviderInstance }>(`/api/v1/admin/payments/providers/${encodeURIComponent(item.id)}`, {
      method: "PUT",
      body: { enabled },
    });
    upsert(res.item);
    toast.success(enabled ? t("payFlow.instances.enabledOn", { name: item.name }) : t("payFlow.instances.enabledOff", { name: item.name }));
  } catch (err) {
    upsert(item);
    toast.error(payError(err, t("payFlow.instances.toggleFailed")));
  } finally {
    setBusy(item.id, false);
  }
}

async function move(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (reordering.value || target < 0 || target >= items.value.length) return;
  const before = items.value;
  const next = [...before];
  [next[index], next[target]] = [next[target]!, next[index]!];
  items.value = next;
  reordering.value = true;
  try {
    const res = await apiJson<{ items: PaymentProviderInstance[] }>("/api/v1/admin/payments/providers/reorder", {
      method: "POST",
      body: { ids: next.map((x) => x.id) },
    });
    items.value = res.items;
  } catch (err) {
    items.value = before;
    toast.error(payError(err, t("payFlow.instances.reorderFailed")));
  } finally {
    reordering.value = false;
  }
}

async function remove(item: PaymentProviderInstance) {
  setBusy(item.id, true);
  try {
    await apiJson(`/api/v1/admin/payments/providers/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    items.value = items.value.filter((x) => x.id !== item.id);
    toast.success(t("payFlow.instances.deleted"));
  } catch (err) {
    toast.error(payError(err, t("payFlow.instances.deleteFailed"), { conflict: t("payFlow.errors.deleteConflict") }));
  } finally {
    setBusy(item.id, false);
  }
}

/* ---------------- Drawer ---------------- */

const drawerOpen = ref(false);
const editing = ref<PaymentProviderInstance | null>(null);
const adding = ref<PaymentInstanceProvider>("easypay");

function add(provider: PaymentInstanceProvider, close?: () => void) {
  close?.();
  editing.value = null;
  adding.value = provider;
  drawerOpen.value = true;
}

function edit(item: PaymentProviderInstance) {
  editing.value = item;
  adding.value = item.provider;
  drawerOpen.value = true;
}

/* ---------------- Display ---------------- */

function state(item: PaymentProviderInstance): { tone: Tone; text: string } {
  if (!item.enabled) return { tone: "neutral", text: t("payFlow.instances.disabled") };
  if (!item.ready) return { tone: "warning", text: t("payFlow.instances.incomplete") };
  return { tone: "success", text: t("payFlow.instances.ready") };
}

function typeLabel(item: PaymentProviderInstance, type: string) {
  return item.provider === "easypay" ? channelLabel("easypay", type) : channelLabel(item.provider, null);
}

/** "Today ¥x" or "Today ¥x / ¥limit" when every method it serves has a daily limit. */
function usageText(item: PaymentProviderInstance) {
  const used = formatFiat(item.todayUsageMinor, props.currency);
  let cap = 0;
  for (const type of item.supportedTypes) {
    const daily = item.limits[type]?.dailyLimitMinor ?? 0;
    if (daily <= 0) return t("payFlow.instances.today", { amount: used });
    cap += daily;
  }
  return cap > 0 ? t("payFlow.instances.todayOf", { amount: used, limit: formatFiat(cap, props.currency) }) : t("payFlow.instances.today", { amount: used });
}

const glyphFor = (p: PaymentInstanceProvider, types: string[] = []) =>
  p === "easypay" ? { provider: "easypay", method: types[0] ?? "alipay" } : { provider: p, method: null };

const count = computed(() => items.value.length);
</script>

<template>
  <UiCard flush>
    <template #header>
      <div class="flex min-w-0 items-center gap-3">
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="layers" :size="16" /></span>
        <div class="min-w-0">
          <h2 class="flex items-center gap-2 truncate text-sm font-semibold text-fg">
            {{ t("payFlow.instances.title") }}
            <span v-if="loaded && count" class="rounded-full bg-surface-2 px-1.5 font-mono text-[10px] leading-4 tabular-nums text-fg-subtle">
              {{ t("payFlow.instances.count", { n: count }) }}
            </span>
          </h2>
          <p class="truncate text-xs text-fg-subtle">{{ t("payFlow.instances.desc") }}</p>
        </div>
      </div>
    </template>
    <template #actions>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" :disabled="loading" :aria-label="t('common.refresh')" :title="t('common.refresh')" @click="load">
        <UiIcon name="refresh" :size="14" :spin="loading" />
      </button>
      <UiDropdown width-class="w-72">
        <template #trigger="{ toggle: open, open: isOpen }">
          <button type="button" class="btn btn-primary btn-sm" aria-haspopup="menu" :aria-expanded="isOpen" @click="open">
            <UiIcon name="plus" :size="14" />
            {{ t("payFlow.instances.add") }}
          </button>
        </template>
        <template #default="{ close }">
          <button
            v-for="p in INSTANCE_PROVIDERS"
            :key="p"
            type="button"
            role="menuitem"
            class="menu-item items-start"
            @click="add(p, close)"
          >
            <ChannelGlyph v-bind="glyphFor(p)" size="sm" />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium text-fg">{{ providerLabel(p) }}</span>
              <span class="mt-0.5 block text-2xs leading-snug text-fg-subtle">{{ t(`payFlow.instances.providerDesc.${p}`) }}</span>
            </span>
          </button>
        </template>
      </UiDropdown>
    </template>

    <div>
      <div v-if="loadError && !loaded" class="p-5">
        <UiAlert tone="warning">
          {{ loadError }}
          <template #action>
            <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="load">
              {{ t("payFlow.instances.retry") }}
            </button>
          </template>
        </UiAlert>
      </div>
      <ListSkeleton v-else-if="!loaded" :rows="3" />
      <EmptyState v-else-if="items.length === 0" compact icon="layers" :title="t('payFlow.instances.empty')">
        <p class="w-full max-w-md text-xs leading-relaxed text-fg-subtle">{{ t("payFlow.instances.emptyHint") }}</p>
      </EmptyState>

      <TransitionGroup
        v-else
        tag="ul"
        class="relative divide-y divide-line/60"
        move-class="transition-transform duration-200 ease-out motion-reduce:transition-none"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-active-class="absolute inset-x-0 transition duration-150 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <li
          v-for="(item, i) in items"
          :key="item.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-3 bg-surface px-5 py-3.5 transition-opacity duration-200 dark:bg-transparent"
          :class="item.enabled ? '' : 'opacity-70'"
        >
          <div class="flex shrink-0 flex-col">
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs h-5"
              :disabled="i === 0 || reordering"
              :aria-label="`${t('payFlow.instances.moveUp')} · ${item.name}`"
              :title="t('payFlow.instances.moveUp')"
              @click="move(i, -1)"
            >
              <UiIcon name="chevron-down" :size="13" class="rotate-180" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs h-5"
              :disabled="i === items.length - 1 || reordering"
              :aria-label="`${t('payFlow.instances.moveDown')} · ${item.name}`"
              :title="t('payFlow.instances.moveDown')"
              @click="move(i, 1)"
            >
              <UiIcon name="chevron-down" :size="13" />
            </button>
          </div>

          <ChannelGlyph v-bind="glyphFor(item.provider, item.supportedTypes)" />

          <div class="min-w-0 flex-1 basis-48">
            <p class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span class="truncate text-sm font-semibold text-fg">{{ item.name }}</span>
              <UiBadge :tone="state(item).tone" dot>{{ state(item).text }}</UiBadge>
            </p>
            <p class="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-2xs text-fg-subtle">
              <span class="font-medium text-fg-muted">{{ providerLabel(item.provider) }}</span>
              <span aria-hidden="true">·</span>
              <span v-for="type in item.supportedTypes" :key="type" class="code-chip">{{ typeLabel(item, type) }}</span>
              <template v-if="item.provider === 'easypay'">
                <span aria-hidden="true">·</span>
                <span>{{ item.paymentMode === "qrcode" ? t("payFlow.instances.modeQrcode") : t("payFlow.instances.modePopup") }}</span>
              </template>
            </p>
            <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-subtle">
              <span class="inline-flex items-center gap-1 tabular-nums">
                <UiIcon name="activity" :size="11" />
                {{ usageText(item) }}
              </span>
              <span v-if="item.refundEnabled" class="inline-flex items-center gap-1">
                <UiIcon name="rotate-ccw" :size="11" />
                {{ t("payFlow.instances.refund") }}
              </span>
              <span v-if="item.allowUserRefund" class="inline-flex items-center gap-1">
                <UiIcon name="user" :size="11" />
                {{ t("payFlow.instances.userRefund") }}
              </span>
            </p>
          </div>

          <div class="ml-auto flex shrink-0 items-center gap-1">
            <UiSwitch
              :model-value="item.enabled"
              :disabled="busy.has(item.id)"
              :label="`${item.name}`"
              hide-label
              @update:model-value="toggle(item, $event)"
            />
            <button
              type="button"
              class="btn btn-ghost btn-xs ml-1"
              :disabled="busy.has(item.id)"
              :aria-label="`${t('payFlow.instances.edit')} · ${item.name}`"
              @click="edit(item)"
            >
              <UiIcon name="pencil" :size="12" />
              <span class="hidden sm:inline">{{ t("payFlow.instances.edit") }}</span>
            </button>
            <ConfirmButton
              icon-only
              :disabled="busy.has(item.id)"
              :label="t('payFlow.instances.delete')"
              :confirm-label="t('payFlow.instances.confirmDelete')"
              @confirm="remove(item)"
            />
          </div>
        </li>
      </TransitionGroup>
    </div>

    <PaymentInstanceDrawer
      v-model:open="drawerOpen"
      :instance="editing"
      :provider="adding"
      :currency="currency"
      :notify-base="notifyBase"
      @saved="upsert"
    />
  </UiCard>
</template>
