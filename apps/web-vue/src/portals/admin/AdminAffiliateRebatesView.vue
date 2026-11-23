<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { AffiliateRebateItem } from "@slipgate/contracts";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import { STAGGER_CLASS, stagger, sumNano } from "../../components/payments/paymentUtil";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import { useNow } from "../../composables/useNow";
import { apiJson, errorText } from "../../lib/api";
import { formatDateTime, formatNumber, formatRelative, formatUsd } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

/** The BFF returns at most this many of the latest rebates. */
const API_LIMIT = 200;

const { t } = useI18n();
const toast = useToastStore();
const now = useNow(60_000);

const items = ref<AffiliateRebateItem[]>([]);
const loading = ref(false);
const loaded = ref(false);

async function load() {
  loading.value = true;
  try {
    items.value = (await apiJson<{ items: AffiliateRebateItem[] }>("/api/v1/admin/affiliates/rebates", {
      fallbackError: t("payments.admin.rebates.loadFailed"),
    })).items;
    loaded.value = true;
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.rebates.loadFailed")));
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

/* ---------------- Stats ---------------- */

const totalNano = computed(() => sumNano(items.value.map((r) => r.amountNanoUsd)));
const beneficiaries = computed(() => new Set(items.value.map((r) => r.beneficiaryId)).size);
const recentNano = computed(() => {
  const cutoff = now.value - 30 * 86_400_000;
  return sumNano(items.value.filter((r) => Date.parse(r.createdAtIso) >= cutoff).map((r) => r.amountNanoUsd));
});

/* ---------------- Search & paging (client side) ---------------- */

const search = ref("");
const page = ref(1);
const pageSize = ref(20);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = [...items.value].sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
  if (!q) return list;
  return list.filter((r) => [r.beneficiaryEmail, r.inviteeEmail, r.orderId, r.beneficiaryId].some((v) => v.toLowerCase().includes(q)));
});
const filteredTotal = computed(() => sumNano(filtered.value.map((r) => r.amountNanoUsd)));
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));

watch([search, pageSize], () => (page.value = 1));

function shortId(id: string) {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.affiliateRebates')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
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

    <UiCard icon="gift" :title="t('nav.affiliateRebates')" flush>
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
  </div>
</template>
