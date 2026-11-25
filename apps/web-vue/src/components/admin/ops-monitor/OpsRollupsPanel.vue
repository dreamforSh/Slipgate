<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  UsageRollupBackfillResponse,
  UsageRollupCleanupResponse,
  UsageRollupGranularity,
  UsageRollupSeriesResponse,
  UsageRollupStatus,
} from "@slipgate/contracts";
import { apiJson, errorText } from "../../../lib/api";
import {
  formatCompact,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatRelative,
  formatUsd,
} from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import FormField from "../../ui/FormField.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import StatCard from "../../ui/StatCard.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import UiSelect from "../../ui/UiSelect.vue";

const props = defineProps<{
  now: number;
  refreshToken: number;
}>();

const { t } = useI18n();
const toast = useToastStore();

const loading = ref(false);
const errorMessage = ref<string | null>(null);

const status = ref<UsageRollupStatus>({
  rollupEnabled: true,
  usageRetentionDays: 90,
  lastHourlyAtIso: null,
  lastDailyAtIso: null,
  lastCleanupAtIso: null,
  lastCleanupDeleted: 0,
  hourlyRows: 0,
  dailyRows: 0,
  oldestLogIso: null,
});

const configForm = reactive({
  rollupEnabled: true,
  usageRetentionDays: 90,
});
const savingConfig = ref(false);

const backfillDays = ref<number>(30);
const backfillGranularity = ref<"both" | "hourly" | "daily">("both");
const runningBackfill = ref(false);

const cleanupOverrideDays = ref<string>("");
const runningCleanup = ref(false);
const cleanupResult = ref<UsageRollupCleanupResponse | null>(null);

const seriesGranularity = ref<UsageRollupGranularity>("daily");
const seriesDays = ref<"7" | "30" | "90">("30");
const platformFilter = ref("");
const modelFilter = ref("");
const series = ref<UsageRollupSeriesResponse | null>(null);

const granularityOptions = computed(() => [
  { value: "daily" as const, label: t("security.ops.rollups.daily") },
  { value: "hourly" as const, label: t("security.ops.rollups.hourly") },
]);

const daysOptions = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
];

const lastRunIso = computed(() => {
  const h = status.value.lastHourlyAtIso;
  const d = status.value.lastDailyAtIso;
  if (!h) return d;
  if (!d) return h;
  return h >= d ? h : d;
});

async function loadAll() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const qs = new URLSearchParams({
      granularity: seriesGranularity.value,
      days: seriesDays.value,
    });
    if (platformFilter.value.trim()) qs.set("platform", platformFilter.value.trim());
    if (modelFilter.value.trim()) qs.set("publicModel", modelFilter.value.trim());

    const [st, sr] = await Promise.all([
      apiJson<UsageRollupStatus>("/api/v1/admin/usage-rollups/status", {
        fallbackError: t("security.ops.rollups.errors.load"),
      }),
      apiJson<UsageRollupSeriesResponse>(`/api/v1/admin/usage-rollups/series?${qs.toString()}`, {
        fallbackError: t("security.ops.rollups.errors.load"),
      }),
    ]);
    status.value = st;
    configForm.rollupEnabled = st.rollupEnabled;
    configForm.usageRetentionDays = st.usageRetentionDays;
    series.value = sr;
  } catch (err) {
    errorMessage.value = errorText(err, t("security.ops.rollups.errors.load"));
  } finally {
    loading.value = false;
  }
}

onMounted(() => void loadAll());
watch(() => props.refreshToken, () => void loadAll());
watch([seriesGranularity, seriesDays], () => void loadAll());

async function saveConfig() {
  savingConfig.value = true;
  try {
    const days = Math.round(Number(configForm.usageRetentionDays) || 0);
    const updated = await apiJson<UsageRollupStatus>("/api/v1/admin/usage-rollups/config", {
      method: "PATCH",
      body: {
        rollupEnabled: configForm.rollupEnabled,
        usageRetentionDays: days,
      },
      fallbackError: t("security.ops.rollups.errors.saveConfig"),
    });
    status.value = updated;
    configForm.rollupEnabled = updated.rollupEnabled;
    configForm.usageRetentionDays = updated.usageRetentionDays;
    toast.success(t("security.ops.rollups.configSaved"));
  } catch (err) {
    toast.error(errorText(err, t("security.ops.rollups.errors.saveConfig")));
  } finally {
    savingConfig.value = false;
  }
}

async function runBackfill() {
  runningBackfill.value = true;
  try {
    const res = await apiJson<UsageRollupBackfillResponse>("/api/v1/admin/usage-rollups/backfill", {
      method: "POST",
      body: {
        days: backfillDays.value,
        granularity: backfillGranularity.value,
      },
      fallbackError: t("security.ops.rollups.errors.backfill"),
    });
    toast.success(
      t("security.ops.rollups.backfillDone", {
        hourly: formatNumber(res.hourlyUpserted),
        daily: formatNumber(res.dailyUpserted),
      }),
    );
    await loadAll();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.rollups.errors.backfill")));
  } finally {
    runningBackfill.value = false;
  }
}

async function runCleanup(dryRun: boolean) {
  runningCleanup.value = true;
  try {
    const body: Record<string, unknown> = { dryRun };
    const override = Number.parseInt(cleanupOverrideDays.value.trim(), 10);
    if (Number.isFinite(override) && override >= 7 && override <= 3650) {
      body.retentionDays = override;
    }
    const res = await apiJson<UsageRollupCleanupResponse>("/api/v1/admin/usage-rollups/cleanup", {
      method: "POST",
      body,
      fallbackError: t("security.ops.rollups.errors.cleanup"),
    });
    cleanupResult.value = res;
    if (!dryRun) {
      await loadAll();
    }
  } catch (err) {
    toast.error(errorText(err, t("security.ops.rollups.errors.cleanup")));
  } finally {
    runningCleanup.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <UiAlert v-if="errorMessage" tone="danger">{{ errorMessage }}</UiAlert>

    <!-- Status KPIs -->
    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        :label="t('security.ops.rollups.kpis.hourlyRows')"
        :value="formatNumber(status.hourlyRows)"
        :hint="`${t('security.ops.rollups.kpis.dailyRows')}: ${formatNumber(status.dailyRows)}`"
        icon="database"
        tone="accent"
        mono
      />
      <StatCard
        :label="t('security.ops.rollups.kpis.lastRun')"
        :value="lastRunIso ? formatRelative(lastRunIso, now) : t('security.ops.rollups.never')"
        :hint="lastRunIso ? formatDateTime(lastRunIso) : undefined"
        icon="clock"
        tone="info"
      />
      <StatCard
        :label="t('security.ops.rollups.kpis.retention')"
        :value="status.usageRetentionDays === 0 ? t('security.ops.rollups.forever') : t('security.ops.rollups.daysCount', { n: status.usageRetentionDays })"
        :hint="status.lastCleanupAtIso ? t('security.ops.rollups.kpis.deletedLast', { n: formatNumber(status.lastCleanupDeleted) }) : undefined"
        icon="calendar"
        :tone="status.usageRetentionDays > 0 ? 'success' : 'neutral'"
      />
      <StatCard
        :label="t('security.ops.rollups.kpis.oldestLog')"
        :value="status.oldestLogIso ? formatRelative(status.oldestLogIso, now) : '—'"
        :hint="status.oldestLogIso ? formatDateTime(status.oldestLogIso) : undefined"
        icon="activity"
        tone="neutral"
      />
    </div>

    <!-- Config + Manual Backfill & Cleanup -->
    <div class="grid gap-6 xl:grid-cols-2">
      <UiCard icon="sliders" :title="t('security.ops.rollups.configTitle')">
        <template #actions>
          <button type="button" class="btn btn-primary btn-sm" :disabled="savingConfig" @click="saveConfig">
            <UiIcon :name="savingConfig ? 'loader' : 'check'" :size="14" :spin="savingConfig" />
            {{ t("common.save") }}
          </button>
        </template>
        <div class="space-y-4">
          <UiSwitch v-model="configForm.rollupEnabled" :label="t('security.ops.rollups.enableSwitch')" />
          <FormField :label="t('security.ops.rollups.retentionDays')" :hint="t('security.ops.rollups.retentionHint')">
            <input
              v-model.number="configForm.usageRetentionDays"
              type="number"
              min="0"
              max="3650"
              class="input max-w-[200px] font-mono text-xs"
            />
          </FormField>
        </div>
      </UiCard>

      <UiCard icon="refresh" :title="t('security.ops.rollups.backfillTitle')">
        <div class="space-y-4">
          <div class="flex flex-wrap items-end gap-3">
            <FormField :label="t('security.ops.rollups.daysRange')" class="w-32">
              <UiSelect v-model.number="backfillDays" class="input text-xs">
                <option :value="7">7d</option>
                <option :value="30">30d</option>
                <option :value="90">90d</option>
              </UiSelect>
            </FormField>
            <FormField :label="t('security.ops.rollups.granularityLabel')" class="w-40">
              <UiSelect v-model="backfillGranularity" class="input text-xs">
                <option value="both">{{ t("security.ops.rollups.both") }}</option>
                <option value="hourly">{{ t("security.ops.rollups.hourly") }}</option>
                <option value="daily">{{ t("security.ops.rollups.daily") }}</option>
              </UiSelect>
            </FormField>
            <button type="button" class="btn btn-secondary btn-sm" :disabled="runningBackfill" @click="runBackfill">
              <UiIcon :name="runningBackfill ? 'loader' : 'play'" :size="14" :spin="runningBackfill" />
              {{ t("security.ops.rollups.runBackfill") }}
            </button>
          </div>

          <div class="border-t border-line/70 pt-4">
            <p class="mb-2 text-xs font-medium text-fg">{{ t("security.ops.rollups.cleanupTitle") }}</p>
            <div class="flex flex-wrap items-end gap-3">
              <FormField :label="t('security.ops.rollups.cleanupDaysOverride')" class="w-44">
                <input
                  v-model="cleanupOverrideDays"
                  type="number"
                  min="7"
                  max="3650"
                  class="input font-mono text-xs"
                  :placeholder="String(status.usageRetentionDays || 90)"
                />
              </FormField>
              <button type="button" class="btn btn-secondary btn-sm" :disabled="runningCleanup" @click="runCleanup(true)">
                {{ t("security.ops.rollups.previewCleanup") }}
              </button>
              <ConfirmButton
                size="sm"
                :label="t('security.ops.rollups.executeCleanup')"
                :confirm-label="t('security.ops.rollups.confirmCleanup')"
                :disabled="runningCleanup"
                @confirm="runCleanup(false)"
              />
            </div>
            <UiAlert v-if="cleanupResult" class="mt-3" :tone="cleanupResult.dryRun ? 'info' : 'success'">
              {{
                cleanupResult.dryRun
                  ? t("security.ops.rollups.cleanupPreviewResult", {
                      n: formatNumber(cleanupResult.matchedOrDeleted),
                      cutoff: formatDateTime(cleanupResult.cutoffIso),
                    })
                  : t("security.ops.rollups.cleanupDoneResult", {
                      n: formatNumber(cleanupResult.matchedOrDeleted),
                      cutoff: formatDateTime(cleanupResult.cutoffIso),
                    })
              }}
            </UiAlert>
          </div>
        </div>
      </UiCard>
    </div>

    <!-- Series Table -->
    <UiCard icon="chart" :title="t('security.ops.rollups.seriesTitle')" flush>
      <template #actions>
        <span v-if="series" class="font-mono text-xs text-fg-subtle">
          {{
            t("security.ops.rollups.totalsLabel", {
              requests: formatCompact(series.totals.requests),
              cost: formatUsd(series.totals.costNanoUsd),
            })
          }}
        </span>
      </template>

      <div class="flex flex-wrap items-center gap-3 border-b border-line/70 px-4 py-3 sm:px-5">
        <SegmentedControl v-model="seriesGranularity" :options="granularityOptions" />
        <SegmentedControl v-model="seriesDays" :options="daysOptions" />
        <div class="flex flex-wrap items-center gap-2 lg:ml-auto">
          <input
            v-model="platformFilter"
            type="text"
            class="input h-8 w-32 font-mono text-xs"
            :placeholder="t('security.ops.rollups.platformFilter')"
            @keydown.enter="loadAll"
          />
          <input
            v-model="modelFilter"
            type="text"
            class="input h-8 w-40 font-mono text-xs"
            :placeholder="t('security.ops.rollups.modelFilter')"
            @keydown.enter="loadAll"
          />
          <button type="button" class="btn btn-secondary btn-xs" :disabled="loading" @click="loadAll">
            <UiIcon name="refresh" :size="13" :spin="loading" />
            {{ t("common.refresh") }}
          </button>
        </div>
      </div>

      <EmptyState v-if="!loading && (!series || series.points.length === 0)" icon="chart" :title="t('security.ops.rollups.seriesEmpty')" />

      <div v-else-if="series" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("security.ops.rollups.cols.bucket") }}</th>
              <th class="text-right">{{ t("security.ops.rollups.cols.requests") }}</th>
              <th class="text-right">{{ t("security.ops.rollups.cols.errors") }}</th>
              <th class="text-right">{{ t("security.ops.rollups.cols.tokens") }}</th>
              <th class="text-right">{{ t("security.ops.rollups.cols.cost") }}</th>
              <th class="text-right">{{ t("security.ops.rollups.cols.avgLatency") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pt in series.points" :key="pt.bucketIso">
              <td class="whitespace-nowrap font-mono text-xs text-fg">{{ formatDateTime(pt.bucketIso) }}</td>
              <td class="text-right font-mono text-xs tabular-nums text-fg">{{ formatNumber(pt.requests) }}</td>
              <td class="text-right font-mono text-xs tabular-nums" :class="pt.errors > 0 ? 'text-danger' : 'text-fg-subtle'">
                {{ formatNumber(pt.errors) }}
              </td>
              <td class="text-right font-mono text-xs tabular-nums text-fg-muted">
                {{ formatCompact(pt.inputTokens) }} / {{ formatCompact(pt.outputTokens) }}
              </td>
              <td class="text-right font-mono text-xs tabular-nums text-fg">{{ formatUsd(pt.costNanoUsd) }}</td>
              <td class="text-right font-mono text-xs tabular-nums text-fg-muted">
                {{ formatDurationMs(pt.avgDurationMs) }} / {{ formatDurationMs(pt.avgTtftMs) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>
  </div>
</template>
