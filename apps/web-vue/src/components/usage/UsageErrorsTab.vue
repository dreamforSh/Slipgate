<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RequestErrorItem, RequestErrorListResponse, RequestErrorResolvedFilter } from "@slipgate/contracts";
import RequestErrorDrawer from "../admin/request-errors/RequestErrorDrawer.vue";
import RequestErrorTable from "../admin/request-errors/RequestErrorTable.vue";
import { useRequestErrorActions } from "../admin/request-errors/useRequestErrorActions";
import EmptyState from "../ui/EmptyState.vue";
import UiPagination from "../ui/UiPagination.vue";
import UiSelect from "../ui/UiSelect.vue";
import { apiJson, errorText, toQuery } from "../../lib/api";
import { formatNumber } from "../../lib/format";

/**
 * sub2api "errors" tab of the admin usage page: the request errors (phase, upstream status and
 * body, failover) matching the list's window, user, API key, group and model, with the ops error
 * center's detail drawer and resolve / reopen. Admins only (the error center is admin-only).
 */
const props = defineProps<{
  /** Value-compared criteria of the usage list; a change reloads from page 1. */
  criteriaKey: string;
  params: () => Record<string, string | undefined>;
  now: number;
}>();
const emit = defineEmits<{ (e: "error", message: string): void }>();

const { t } = useI18n();

const items = ref<RequestErrorItem[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);
const page = ref(1);
const pageSize = ref(20);
const resolved = ref<RequestErrorResolvedFilter>("all");

const { selected, drawerOpen, togglingId, inspect, toggleResolved } = useRequestErrorActions((updated) => {
  const idx = items.value.findIndex((r) => r.id === updated.id);
  if (idx >= 0) items.value[idx] = updated;
});

let seq = 0;
let controller: AbortController | null = null;

async function load() {
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;
  const id = ++seq;
  loading.value = true;
  const p = props.params();
  try {
    const res = await apiJson<RequestErrorListResponse>(
      `/api/v1/admin/ops/request-errors${toQuery({
        sinceIso: p.sinceIso,
        untilIso: p.untilIso,
        userId: p.userId,
        apiKeyId: p.apiKeyId,
        groupId: p.groupId,
        modelContains: p.model,
        resolved: resolved.value,
        page: page.value,
        pageSize: pageSize.value,
      })}`,
      { signal: ctrl.signal, fallbackError: t("usageLogs.errorsTab.loadFailed") },
    );
    if (id !== seq) return;
    items.value = res.items;
    total.value = res.total;
    loaded.value = true;
  } catch (err) {
    if (id !== seq || ctrl.signal.aborted) return;
    emit("error", errorText(err, t("usageLogs.errorsTab.loadFailed")));
  } finally {
    if (id === seq) loading.value = false;
  }
}

watch([() => props.criteriaKey, resolved], () => {
  if (page.value !== 1) page.value = 1;
  else void load();
});
watch([page, pageSize], () => void load());
onBeforeUnmount(() => controller?.abort());
void load();

defineExpose({ load });
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-5 py-2.5">
      <p class="text-xs text-fg-subtle">{{ t("usageLogs.errorsTab.subtitle") }}</p>
      <div class="flex items-center gap-3">
        <span v-if="loaded" class="text-xs tabular-nums text-fg-subtle">{{ t("usageLogs.errorsTab.count", { n: formatNumber(total) }) }}</span>
        <UiSelect v-model="resolved" class="select input-sm w-auto" :aria-label="t('security.ops.requestErrors.filters.resolved')">
          <option value="all">{{ t("security.ops.requestErrors.filters.allStates") }}</option>
          <option value="open">{{ t("security.ops.requestErrors.filters.open") }}</option>
          <option value="resolved">{{ t("security.ops.requestErrors.filters.onlyResolved") }}</option>
        </UiSelect>
      </div>
    </div>

    <div v-if="!loaded && loading" class="divide-y divide-line/60" aria-busy="true">
      <div v-for="i in 5" :key="i" class="flex animate-pulse items-center gap-4 px-5 py-3.5">
        <span class="h-3 w-20 rounded bg-surface-2" />
        <span class="h-4 w-14 rounded-full bg-surface-2" />
        <span class="h-3 flex-1 rounded bg-surface-2" />
        <span class="h-3 w-24 rounded bg-surface-2" />
      </div>
    </div>
    <EmptyState v-else-if="loaded && items.length === 0" compact icon="check-circle" :title="t('usageLogs.errorsTab.empty')" />
    <div v-else class="transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
      <RequestErrorTable :items="items" :now="now" :toggling-id="togglingId" @inspect="inspect" @toggle="toggleResolved" />
    </div>

    <UiPagination v-if="loaded && total > 0" v-model:page="page" v-model:page-size="pageSize" :total="total" :disabled="loading" />

    <RequestErrorDrawer v-model:open="drawerOpen" :item="selected" :toggling-id="togglingId" @toggle="toggleResolved" />
  </div>
</template>
