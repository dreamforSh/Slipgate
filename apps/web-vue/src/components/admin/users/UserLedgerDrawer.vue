<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AdminUserItem, BalanceLedgerItem } from "@slipgate/contracts";
import EmptyState from "../../ui/EmptyState.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon, { type IconName } from "../../ui/UiIcon.vue";
import { apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatRelative, formatUsd } from "../../../lib/format";
import { displayName, staggerStyle } from "./userDisplay";

/** Wallet movements of one user, newest first, with signed amounts. */
const props = defineProps<{ user: AdminUserItem | null }>();
const open = defineModel<boolean>("open", { required: true });

const { t, te } = useI18n();

const PAGE = 50;
const MAX = 1000;

const items = ref<BalanceLedgerItem[]>([]);
const limit = ref(PAGE);
const loading = ref(false);
const error = ref<string | null>(null);
const exhausted = ref(false);
let seq = 0;

const KIND_ICON: Record<BalanceLedgerItem["kind"], IconName> = {
  credit: "plus",
  settle: "zap",
  adjust: "sliders",
  hold: "lock",
  release: "unlink",
};

async function load() {
  const u = props.user;
  if (!u) return;
  const id = ++seq;
  loading.value = true;
  error.value = null;
  try {
    const res = await apiJson<{ items: BalanceLedgerItem[] }>(
      `/api/v1/admin/users/${encodeURIComponent(u.id)}/ledger?limit=${limit.value}`,
      { fallbackError: t("adminUsers.errors.ledger") },
    );
    if (id !== seq) return;
    items.value = res.items;
    exhausted.value = res.items.length < limit.value || limit.value >= MAX;
  } catch (err) {
    if (id === seq) error.value = errorText(err, t("adminUsers.errors.ledger"));
  } finally {
    if (id === seq) loading.value = false;
  }
}

function loadMore() {
  limit.value = Math.min(MAX, limit.value + PAGE);
  void load();
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  items.value = [];
  limit.value = PAGE;
  exhausted.value = false;
  void load();
});

function sign(nano: string): -1 | 0 | 1 {
  if (nano.startsWith("-")) return -1;
  return /^0+$/.test(nano) ? 0 : 1;
}
function abs(nano: string): string {
  return nano.replace(/^-/, "");
}
function balanceText(nano: string): string {
  return nano.startsWith("-") ? `−${formatUsd(abs(nano))}` : formatUsd(nano);
}
function kindLabel(kind: string): string {
  const key = `adminUsers.ledger.kinds.${kind}`;
  return te(key) ? t(key) : kind;
}
</script>

<template>
  <UiDrawer
    v-model:open="open"
    width="lg"
    :title="t('adminUsers.ledger.title', { name: user ? displayName(user) : '' })"
  >
    <UiAlert v-if="error" tone="danger" class="mb-4">{{ error }}</UiAlert>

    <div v-if="loading && items.length === 0" class="space-y-2" aria-busy="true">
      <div v-for="i in 6" :key="i" class="flex animate-pulse items-center gap-3 rounded-lg border border-line/60 p-3">
        <span class="h-8 w-8 rounded-lg bg-surface-2" />
        <span class="flex-1 space-y-1.5">
          <span class="block h-3 w-1/3 rounded bg-surface-2" />
          <span class="block h-2.5 w-1/2 rounded bg-surface-2" />
        </span>
        <span class="h-3.5 w-16 rounded bg-surface-2" />
      </div>
    </div>

    <EmptyState v-else-if="items.length === 0 && !error" icon="wallet" compact :title="t('adminUsers.ledger.empty')" />

    <ol v-else class="space-y-2">
      <li
        v-for="(item, i) in items"
        :key="item.id"
        class="flex animate-slide-up items-start gap-3 rounded-lg border border-line/60 bg-surface px-3 py-2.5 [animation-fill-mode:backwards] motion-reduce:animate-none dark:bg-surface-2/30"
        :style="staggerStyle(i)"
      >
        <span
          class="icon-chip mt-0.5 h-8 w-8"
          :class="sign(item.deltaNanoUsd) > 0 ? 'icon-chip-success' : sign(item.deltaNanoUsd) < 0 ? 'icon-chip-danger' : ''"
        >
          <UiIcon :name="KIND_ICON[item.kind] ?? 'wallet'" :size="14" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 text-sm font-medium text-fg">
            {{ kindLabel(item.kind) }}
          </p>
          <p v-if="item.reason" class="mt-0.5 break-words text-xs text-fg-muted">{{ item.reason }}</p>
          <p class="mt-0.5 text-2xs text-fg-subtle" :title="formatDateTime(item.createdAtIso)">
            {{ formatRelative(item.createdAtIso) }} · {{ formatDateTime(item.createdAtIso) }}
          </p>
        </div>
        <div class="shrink-0 text-right">
          <p
            class="font-mono text-sm font-semibold tabular-nums"
            :class="sign(item.deltaNanoUsd) > 0 ? 'text-success' : sign(item.deltaNanoUsd) < 0 ? 'text-danger' : 'text-fg-subtle'"
          >
            {{ sign(item.deltaNanoUsd) > 0 ? "+" : sign(item.deltaNanoUsd) < 0 ? "−" : "" }}{{ formatUsd(abs(item.deltaNanoUsd)) }}
          </p>
          <p class="mt-0.5 font-mono text-2xs tabular-nums text-fg-subtle">
            {{ t("adminUsers.ledger.balanceAfter", { amount: balanceText(item.balanceAfterNanoUsd) }) }}
          </p>
        </div>
      </li>
    </ol>

    <div v-if="items.length > 0 && !exhausted" class="mt-4 flex justify-center">
      <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="loadMore">
        <UiIcon :name="loading ? 'loader' : 'chevron-down'" :size="14" :spin="loading" />
        {{ t("adminUsers.ledger.loadMore") }}
      </button>
    </div>
  </UiDrawer>
</template>
