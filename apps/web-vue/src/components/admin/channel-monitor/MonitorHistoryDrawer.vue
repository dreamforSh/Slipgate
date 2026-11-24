<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ChannelMonitor, ChannelMonitorRun, ChannelMonitorStatus } from "@slipgate/contracts";
import { apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatDurationMs, formatRelative, type Tone } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import EmptyState from "../../ui/EmptyState.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";

const props = defineProps<{
  open: boolean;
  monitor: ChannelMonitor | null;
  now: number;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "probed"): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

const runs = ref<ChannelMonitorRun[]>([]);
const loading = ref(false);
const probing = ref(false);

function statusTone(s: ChannelMonitorStatus): Tone {
  switch (s) {
    case "up":
      return "success";
    case "degraded":
      return "warning";
    case "down":
      return "danger";
    default:
      return "neutral";
  }
}

async function loadRuns() {
  if (!props.monitor) return;
  loading.value = true;
  try {
    const res = await apiJson<{ items: ChannelMonitorRun[] }>(
      `/api/v1/admin/channel-monitors/${encodeURIComponent(props.monitor.id)}/runs?limit=50`,
    );
    runs.value = res.items;
  } catch (err) {
    toast.error(errorText(err, t("adminTools.monitor.errors.loadAccounts")));
  } finally {
    loading.value = false;
  }
}

async function probeNow() {
  if (!props.monitor) return;
  probing.value = true;
  try {
    await apiJson(`/api/v1/admin/channel-monitors/${encodeURIComponent(props.monitor.id)}/run`, {
      method: "POST",
    });
    await loadRuns();
    emit("probed");
  } catch (err) {
    toast.error(errorText(err, t("adminTools.monitor.errors.run")));
  } finally {
    probing.value = false;
  }
}

watch(
  () => [props.open, props.monitor?.id] as const,
  ([isOpen]) => {
    if (isOpen && props.monitor) void loadRuns();
  },
  { immediate: true },
);
</script>

<template>
  <UiDrawer
    :open="open"
    :title="monitor ? `${monitor.name} — ${t('adminTools.monitor.synthetic.historyTitle')}` : ''"
    width="lg"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="monitor" class="space-y-4 p-5">
      <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2/40 p-3.5 text-xs">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <UiBadge :tone="statusTone(monitor.lastStatus)" dot>
              {{ t(`adminTools.monitor.synthetic.statuses.${monitor.lastStatus}`) }}
            </UiBadge>
            <span class="font-mono text-fg-muted">{{ monitor.accountName || monitor.accountId }}</span>
            <span v-if="monitor.model" class="font-mono text-fg-subtle">({{ monitor.model }})</span>
          </div>
          <p v-if="monitor.uptime24hPct !== null" class="text-fg-subtle">
            24h uptime: <span class="font-mono font-semibold text-fg">{{ monitor.uptime24hPct }}%</span>
          </p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" :disabled="probing" @click="probeNow">
          <UiIcon name="play" :size="13" :spin="probing" />
          {{ t("adminTools.monitor.synthetic.probeNow") }}
        </button>
      </div>

      <EmptyState
        v-if="!loading && runs.length === 0"
        compact
        icon="clock"
        :title="t('adminTools.monitor.synthetic.historyEmpty')"
      />

      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("adminTools.monitor.health.table.testedAt") }}</th>
              <th>{{ t("adminTools.monitor.health.table.result") }}</th>
              <th>{{ t("adminTools.monitor.health.table.model") }}</th>
              <th class="text-right">{{ t("adminTools.monitor.health.table.latency") }}</th>
              <th>{{ t("adminTools.monitor.health.table.message") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id">
              <td class="whitespace-nowrap text-xs text-fg" :title="formatDateTime(r.checkedAtIso)">
                {{ formatRelative(r.checkedAtIso, now) }}
              </td>
              <td>
                <UiBadge :tone="statusTone(r.status)" dot>
                  {{ t(`adminTools.monitor.synthetic.statuses.${r.status}`) }}
                </UiBadge>
              </td>
              <td class="font-mono text-2xs text-fg-muted">{{ r.model || "—" }}</td>
              <td class="whitespace-nowrap text-right font-mono text-xs text-fg-muted">
                {{ formatDurationMs(r.latencyMs) }}
              </td>
              <td class="max-w-[16rem] truncate font-mono text-2xs text-danger" :title="r.errorMessage">
                {{ r.errorMessage || "—" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </UiDrawer>
</template>
