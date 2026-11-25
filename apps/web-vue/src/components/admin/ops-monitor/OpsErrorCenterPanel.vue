<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  REQUEST_ERROR_PHASES,
  type OpsRange,
  type RequestErrorCleanupResponse,
  type RequestErrorItem,
  type RequestErrorListResponse,
  type RequestErrorPhase,
  type RequestErrorResolvedFilter,
  type RequestErrorStatusClass,
  type RequestErrorSummary,
} from "@slipgate/contracts";
import { apiJson, errorText } from "../../../lib/api";
import { formatNumber } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import RequestErrorDrawer from "../request-errors/RequestErrorDrawer.vue";
import RequestErrorTable from "../request-errors/RequestErrorTable.vue";
import { useRequestErrorActions } from "../request-errors/useRequestErrorActions";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import StatCard from "../../ui/StatCard.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiPagination from "../../ui/UiPagination.vue";
import UiSelect from "../../ui/UiSelect.vue";

const props = defineProps<{
  range: OpsRange;
  now: number;
  refreshToken: number;
}>();

const emit = defineEmits<{
  (e: "openCount", count: number): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

const items = ref<RequestErrorItem[]>([]);
const total = ref(0);
const summary = ref<RequestErrorSummary | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const page = ref(1);
const pageSize = ref(20);
const cleaning = ref(false);
const { selected, drawerOpen, togglingId, inspect, toggleResolved } = useRequestErrorActions((updated) => {
  const idx = items.value.findIndex((r) => r.id === updated.id);
  if (idx >= 0) items.value[idx] = updated;
  void load();
});

const filters = reactive<{
  phase: "" | RequestErrorPhase;
  statusClass: "" | RequestErrorStatusClass;
  resolved: RequestErrorResolvedFilter;
  q: string;
}>({
  phase: "",
  statusClass: "",
  resolved: "all",
  q: "",
});

const summaryCards = computed(() => {
  const s = summary.value;
  return [
    {
      key: "total",
      label: t("security.ops.requestErrors.total"),
      value: formatNumber(s?.total ?? 0),
      icon: "activity" as const,
      tone: "accent" as const,
    },
    {
      key: "open",
      label: t("security.ops.requestErrors.openCount"),
      value: formatNumber(s?.openCount ?? 0),
      icon: "alert" as const,
      tone: (s?.openCount ?? 0) > 0 ? ("danger" as const) : ("success" as const),
    },
    {
      key: "s5xx",
      label: t("security.ops.requestErrors.status5xx"),
      value: formatNumber(s?.status5xx ?? 0),
      icon: "x-circle" as const,
      tone: (s?.status5xx ?? 0) > 0 ? ("warning" as const) : ("neutral" as const),
    },
    {
      key: "s4xx",
      label: t("security.ops.requestErrors.status4xx"),
      value: formatNumber(s?.status4xx ?? 0),
      icon: "shield" as const,
      tone: "info" as const,
    },
  ];
});

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = null;
  try {
    const qs = new URLSearchParams({
      timeRange: props.range,
      page: String(page.value),
      pageSize: String(pageSize.value),
      resolved: filters.resolved,
    });
    if (filters.phase) qs.set("phase", filters.phase);
    if (filters.statusClass) qs.set("statusClass", filters.statusClass);
    if (filters.q.trim()) qs.set("q", filters.q.trim());

    const sumQs = new URLSearchParams({ timeRange: props.range });
    const [listRes, sumRes] = await Promise.all([
      apiJson<RequestErrorListResponse>(`/api/v1/admin/ops/request-errors?${qs.toString()}`),
      apiJson<RequestErrorSummary>(`/api/v1/admin/ops/request-errors/summary?${sumQs.toString()}`),
    ]);
    if (seq !== loadSeq) return;
    items.value = listRes.items;
    total.value = listRes.total;
    summary.value = sumRes;
    emit("openCount", sumRes.openCount);
  } catch (err) {
    if (seq === loadSeq) error.value = errorText(err, t("security.ops.errors.load"));
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

function applySearch() {
  page.value = 1;
  void load();
}

async function cleanupResolved() {
  cleaning.value = true;
  try {
    const res = await apiJson<RequestErrorCleanupResponse>("/api/v1/admin/ops/request-errors/cleanup", {
      method: "POST",
      body: { resolvedOnly: true },
    });
    toast.success(t("security.ops.requestErrors.filters.cleanupDone", { n: res.deleted }));
    page.value = 1;
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  } finally {
    cleaning.value = false;
  }
}

watch([() => props.range, () => props.refreshToken], () => {
  void load();
});

watch([() => filters.phase, () => filters.statusClass, () => filters.resolved], () => {
  page.value = 1;
  void load();
});

watch([page, pageSize], () => {
  void load();
});

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatCard
        v-for="card in summaryCards"
        :key="card.key"
        :label="card.label"
        :value="card.value"
        :icon="card.icon"
        :tone="card.tone"
        mono
      />
    </div>

    <div
      v-if="summary && (summary.topModels.length > 0 || summary.topAccounts.length > 0)"
      class="grid gap-4 lg:grid-cols-2"
    >
      <UiCard :title="t('security.ops.requestErrors.topModels')" icon="cpu">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="m in summary.topModels"
            :key="m.model"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2/60 px-2.5 py-1 text-xs transition-colors hover:border-accent"
            @click="filters.q = m.model; applySearch()"
          >
            <span class="font-mono text-fg">{{ m.model }}</span>
            <UiBadge tone="warning" mono>{{ m.count }}</UiBadge>
          </button>
          <span v-if="summary.topModels.length === 0" class="text-xs text-fg-subtle">—</span>
        </div>
      </UiCard>

      <UiCard :title="t('security.ops.requestErrors.topAccounts')" icon="server">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="a in summary.topAccounts"
            :key="a.accountId"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2/60 px-2.5 py-1 text-xs transition-colors hover:border-accent"
            @click="filters.q = a.accountName || a.accountId; applySearch()"
          >
            <span class="text-fg">{{ a.accountName || a.accountId }}</span>
            <UiBadge tone="danger" mono>{{ a.count }}</UiBadge>
          </button>
          <span v-if="summary.topAccounts.length === 0" class="text-xs text-fg-subtle">—</span>
        </div>
      </UiCard>
    </div>

    <UiAlert v-if="error" tone="danger" :title="t('security.ops.errors.load')">
      {{ error }}
    </UiAlert>

    <UiCard icon="alert" :title="t('security.ops.tabs.errors')" flush>
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <UiSelect v-model="filters.phase" class="select input-sm w-auto" :aria-label="t('security.ops.requestErrors.filters.phase')">
            <option value="">{{ t("security.ops.requestErrors.filters.allPhases") }}</option>
            <option v-for="ph in REQUEST_ERROR_PHASES" :key="ph" :value="ph">
              {{ t(`security.ops.requestErrors.phases.${ph}`) }}
            </option>
          </UiSelect>

          <UiSelect
            v-model="filters.statusClass"
            class="select input-sm w-auto"
            :aria-label="t('security.ops.requestErrors.filters.statusClass')"
          >
            <option value="">{{ t("security.ops.requestErrors.filters.allStatus") }}</option>
            <option value="5xx">{{ t("security.ops.requestErrors.filters.status5xx") }}</option>
            <option value="4xx">{{ t("security.ops.requestErrors.filters.status4xx") }}</option>
            <option value="upstream">{{ t("security.ops.requestErrors.filters.statusUpstream") }}</option>
          </UiSelect>

          <UiSelect
            v-model="filters.resolved"
            class="select input-sm w-auto"
            :aria-label="t('security.ops.requestErrors.filters.resolved')"
          >
            <option value="all">{{ t("security.ops.requestErrors.filters.allStates") }}</option>
            <option value="open">{{ t("security.ops.requestErrors.filters.open") }}</option>
            <option value="resolved">{{ t("security.ops.requestErrors.filters.onlyResolved") }}</option>
          </UiSelect>

          <form class="flex items-center gap-1.5" @submit.prevent="applySearch">
            <div class="relative">
              <UiIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <input
                v-model="filters.q"
                type="search"
                class="input input-sm w-56 pl-8"
                :placeholder="t('security.ops.requestErrors.filters.searchPlaceholder')"
              />
            </div>
          </form>

          <ConfirmButton
            size="sm"
            icon="trash"
            :label="t('security.ops.requestErrors.filters.cleanupResolved')"
            :confirm-label="t('security.ops.requestErrors.filters.confirmCleanup')"
            :disabled="cleaning || (summary?.resolvedCount ?? 0) === 0"
            @confirm="cleanupResolved"
          />

          <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="load">
            <UiIcon name="refresh" :size="14" :spin="loading" />
          </button>
        </div>
      </template>

      <EmptyState
        v-if="!loading && items.length === 0"
        compact
        icon="check-circle"
        :title="t('security.ops.requestErrors.table.empty')"
      />

      <RequestErrorTable v-else :items="items" :now="now" :toggling-id="togglingId" @inspect="inspect" @toggle="toggleResolved" />

      <UiPagination
        v-if="total > 0"
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="total"
        :disabled="loading"
      />
    </UiCard>

    <RequestErrorDrawer v-model:open="drawerOpen" :item="selected" :toggling-id="togglingId" @toggle="toggleResolved" />
  </div>
</template>
