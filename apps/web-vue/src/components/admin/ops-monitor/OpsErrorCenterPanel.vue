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
import { formatDateTime, formatDurationMs, formatNumber, formatRelative, type Tone } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import CopyButton from "../../ui/CopyButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import StatCard from "../../ui/StatCard.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiPagination from "../../ui/UiPagination.vue";
import { statusTone } from "./opsFormat";
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
const selected = ref<RequestErrorItem | null>(null);
const drawerOpen = ref(false);
const togglingId = ref<string | null>(null);
const cleaning = ref(false);

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

function phaseTone(phase: RequestErrorPhase): Tone {
  switch (phase) {
    case "upstream_http":
      return "warning";
    case "outbound":
    case "stream_relay":
      return "danger";
    case "core_eval":
      return "violet";
    case "ingress":
      return "info";
    default:
      return "neutral";
  }
}

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

async function inspectItem(item: RequestErrorItem) {
  selected.value = item;
  drawerOpen.value = true;
  try {
    const res = await apiJson<{ item: RequestErrorItem }>(`/api/v1/admin/ops/request-errors/${encodeURIComponent(item.id)}`);
    if (selected.value?.id === item.id) selected.value = res.item;
  } catch {
    // Keep row snapshot if detail fetch fails.
  }
}

async function toggleResolved(item: RequestErrorItem) {
  togglingId.value = item.id;
  try {
    const res = await apiJson<{ item: RequestErrorItem }>(
      `/api/v1/admin/ops/request-errors/${encodeURIComponent(item.id)}/resolve`,
      { method: "POST", body: { resolved: !item.resolved } },
    );
    const idx = items.value.findIndex((r) => r.id === item.id);
    if (idx >= 0) items.value[idx] = res.item;
    if (selected.value?.id === item.id) selected.value = res.item;
    toast.success(t("security.ops.requestErrors.table.resolvedToast"));
    void load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  } finally {
    togglingId.value = null;
  }
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

      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("security.ops.requestErrors.table.time") }}</th>
              <th>{{ t("security.ops.requestErrors.table.phase") }}</th>
              <th>{{ t("security.ops.requestErrors.table.status") }}</th>
              <th>{{ t("security.ops.requestErrors.table.model") }}</th>
              <th>{{ t("security.ops.requestErrors.table.accountUser") }}</th>
              <th>{{ t("security.ops.requestErrors.table.error") }}</th>
              <th>{{ t("security.ops.requestErrors.table.attempt") }}</th>
              <th>{{ t("security.ops.requestErrors.table.state") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td class="whitespace-nowrap">
                <p class="text-xs text-fg" :title="formatDateTime(item.createdAtIso)">
                  {{ formatRelative(item.createdAtIso, now) }}
                </p>
                <p v-if="item.requestId" class="mt-0.5 flex items-center gap-0.5">
                  <span class="max-w-[8rem] truncate font-mono text-2xs text-fg-subtle" :title="item.requestId">
                    {{ item.requestId }}
                  </span>
                  <CopyButton :text="item.requestId" class="!h-5 !w-5" />
                </p>
              </td>
              <td>
                <UiBadge :tone="phaseTone(item.phase)">
                  {{ t(`security.ops.requestErrors.phases.${item.phase}`) }}
                </UiBadge>
              </td>
              <td class="whitespace-nowrap">
                <div class="flex items-center gap-1">
                  <UiBadge :tone="statusTone(item.statusCode)" mono>{{ item.statusCode }}</UiBadge>
                  <UiBadge
                    v-if="item.upstreamStatus > 0 && item.upstreamStatus !== item.statusCode"
                    tone="neutral"
                    mono
                  >
                    ↑{{ item.upstreamStatus }}
                  </UiBadge>
                </div>
              </td>
              <td class="max-w-[11rem]">
                <p class="truncate font-mono text-xs text-fg" :title="item.model">{{ item.model || "—" }}</p>
                <p v-if="item.platform" class="truncate text-2xs text-fg-subtle">{{ item.platform }}</p>
              </td>
              <td class="max-w-[11rem]">
                <p class="truncate text-xs text-fg" :title="item.accountName || item.accountId || ''">
                  {{ item.accountName || item.accountId || "—" }}
                </p>
                <p v-if="item.userEmail" class="truncate text-2xs text-fg-subtle" :title="item.userEmail">
                  {{ item.userEmail }}
                </p>
              </td>
              <td class="max-w-[20rem]">
                <p class="truncate font-mono text-2xs text-fg-muted" :title="item.errorCode || item.kind">
                  {{ item.errorCode || item.kind || "—" }}
                </p>
                <p class="truncate text-xs text-fg" :title="item.errorMessage">
                  {{ item.errorMessage || "—" }}
                </p>
              </td>
              <td class="whitespace-nowrap">
                <div class="flex flex-col gap-0.5">
                  <span class="font-mono text-xs text-fg-muted">
                    {{ t("security.ops.requestErrors.table.attemptN", { n: item.attempt }) }}
                  </span>
                  <UiBadge v-if="item.failoverUsed" tone="info">
                    {{ t("security.ops.requestErrors.table.failoverTag") }}
                  </UiBadge>
                </div>
              </td>
              <td class="whitespace-nowrap">
                <UiBadge :tone="item.resolved ? 'success' : 'danger'" dot>
                  {{
                    item.resolved
                      ? t("security.ops.requestErrors.table.resolvedBadge")
                      : t("security.ops.requestErrors.table.openBadge")
                  }}
                </UiBadge>
              </td>
              <td class="whitespace-nowrap text-right">
                <div class="inline-flex items-center gap-1">
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :title="t('security.ops.requestErrors.table.inspect')"
                    @click="inspectItem(item)"
                  >
                    <UiIcon name="eye" :size="14" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-secondary btn-xs"
                    :disabled="togglingId === item.id"
                    @click="toggleResolved(item)"
                  >
                    {{
                      item.resolved
                        ? t("security.ops.requestErrors.table.reopen")
                        : t("security.ops.requestErrors.table.resolve")
                    }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <UiPagination
        v-if="total > 0"
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="total"
        :disabled="loading"
      />
    </UiCard>

    <UiDrawer v-model:open="drawerOpen" :title="t('security.ops.requestErrors.drawer.title')" width="lg">
      <div v-if="selected" class="space-y-5 p-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <UiBadge :tone="phaseTone(selected.phase)">
              {{ t(`security.ops.requestErrors.phases.${selected.phase}`) }}
            </UiBadge>
            <UiBadge :tone="statusTone(selected.statusCode)" mono>{{ selected.statusCode }}</UiBadge>
            <UiBadge v-if="selected.upstreamStatus > 0" tone="neutral" mono>
              upstream {{ selected.upstreamStatus }}
            </UiBadge>
            <UiBadge :tone="selected.resolved ? 'success' : 'danger'" dot>
              {{
                selected.resolved
                  ? t("security.ops.requestErrors.table.resolvedBadge")
                  : t("security.ops.requestErrors.table.openBadge")
              }}
            </UiBadge>
          </div>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="togglingId === selected.id"
            @click="toggleResolved(selected)"
          >
            {{
              selected.resolved
                ? t("security.ops.requestErrors.table.reopen")
                : t("security.ops.requestErrors.table.resolve")
            }}
          </button>
        </div>

        <dl class="grid grid-cols-1 gap-3 rounded-xl border border-line bg-surface-2/40 p-4 text-xs sm:grid-cols-2">
          <div>
            <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.requestId") }}</dt>
            <dd class="mt-0.5 flex items-center gap-1 font-mono text-fg">
              <span class="break-all">{{ selected.requestId || "—" }}</span>
              <CopyButton v-if="selected.requestId" :text="selected.requestId" class="!h-5 !w-5" />
            </dd>
          </div>
          <div>
            <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.clientRequestId") }}</dt>
            <dd class="mt-0.5 font-mono text-fg">{{ selected.clientRequestId || "—" }}</dd>
          </div>
          <div>
            <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.model") }}</dt>
            <dd class="mt-0.5 font-mono text-fg">
              {{ selected.model || "—" }}
              <span v-if="selected.upstreamModel && selected.upstreamModel !== selected.model" class="text-fg-subtle">
                → {{ selected.upstreamModel }}
              </span>
            </dd>
          </div>
          <div>
            <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.account") }}</dt>
            <dd class="mt-0.5 text-fg">
              {{ selected.accountName || selected.accountId || "—" }}
              <span v-if="selected.groupName" class="text-fg-subtle"> ({{ selected.groupName }})</span>
            </dd>
          </div>
          <div>
            <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.user") }}</dt>
            <dd class="mt-0.5 text-fg">
              {{ selected.userEmail || selected.userId || "—" }}
              <span v-if="selected.apiKeyId" class="font-mono text-fg-subtle"> · {{ selected.apiKeyId }}</span>
            </dd>
          </div>
          <div>
            <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.execution") }}</dt>
            <dd class="mt-0.5 font-mono text-fg">
              {{ selected.executionMode || "—" }} · {{ formatDurationMs(selected.durationMs) }} ·
              {{ t("security.ops.requestErrors.table.attemptN", { n: selected.attempt }) }}
            </dd>
          </div>
        </dl>

        <div>
          <div class="mb-1.5 flex items-center justify-between">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              {{ t("security.ops.requestErrors.drawer.errorMessage") }}
            </h3>
            <CopyButton v-if="selected.errorMessage" :text="selected.errorMessage" />
          </div>
          <pre class="max-h-40 overflow-auto rounded-lg border border-line bg-surface-2/60 p-3 font-mono text-xs text-fg whitespace-pre-wrap break-words">{{
            selected.errorMessage || t("security.ops.requestErrors.drawer.emptyText")
          }}</pre>
        </div>

        <div>
          <div class="mb-1.5 flex items-center justify-between">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              {{ t("security.ops.requestErrors.drawer.upstreamBody") }}
            </h3>
            <CopyButton v-if="selected.upstreamBody" :text="selected.upstreamBody" />
          </div>
          <pre class="max-h-64 overflow-auto rounded-lg border border-line bg-surface-2/60 p-3 font-mono text-xs text-fg whitespace-pre-wrap break-words">{{
            selected.upstreamBody || t("security.ops.requestErrors.drawer.emptyText")
          }}</pre>
        </div>

        <div>
          <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            {{ t("security.ops.requestErrors.drawer.metadata") }}
          </h3>
          <pre class="max-h-48 overflow-auto rounded-lg border border-line bg-surface-2/60 p-3 font-mono text-xs text-fg">{{
            JSON.stringify(selected.metadata ?? {}, null, 2)
          }}</pre>
        </div>
      </div>
    </UiDrawer>
  </div>
</template>
