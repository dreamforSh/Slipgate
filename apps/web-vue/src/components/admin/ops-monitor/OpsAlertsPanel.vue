<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ALERT_METRICS,
  ALERT_OPERATORS,
  ALERT_SEVERITIES,
  type AlertEvaluateResponse,
  type AlertEvent,
  type AlertEventListResponse,
  type AlertEventStatus,
  type AlertMetric,
  type AlertOperator,
  type AlertRule,
  type AlertSeverity,
  type AlertSilence,
} from "@slipgate/contracts";
import { apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatNumber, formatRelative, type Tone } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import FormField from "../../ui/FormField.vue";
import StatCard from "../../ui/StatCard.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiPagination from "../../ui/UiPagination.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import UiSelect from "../../ui/UiSelect.vue";

const props = defineProps<{
  now: number;
  refreshToken: number;
}>();

const emit = defineEmits<{
  (e: "firingCount", count: number): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

const rules = ref<AlertRule[]>([]);
const events = ref<AlertEvent[]>([]);
const eventsTotal = ref(0);
const firingCount = ref(0);
const silences = ref<AlertSilence[]>([]);
const loading = ref(false);
const evaluating = ref(false);
const error = ref<string | null>(null);

const eventPage = ref(1);
const eventPageSize = ref(20);
const eventStatusFilter = ref<"" | AlertEventStatus>("");

/* Rule Modal */
const ruleModalOpen = ref(false);
const editingRuleId = ref<string | null>(null);
const savingRule = ref(false);
const ruleForm = reactive<{
  name: string;
  description: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  severity: AlertSeverity;
  emailsText: string;
  enabled: boolean;
}>({
  name: "",
  description: "",
  metric: "error_rate",
  operator: "gte",
  threshold: 5,
  windowMinutes: 15,
  cooldownMinutes: 30,
  severity: "warning",
  emailsText: "",
  enabled: true,
});

/* Silence Modal */
const silenceModalOpen = ref(false);
const savingSilence = ref(false);
const silenceForm = reactive<{
  ruleId: string;
  reason: string;
  durationMinutes: number;
}>({
  ruleId: "",
  reason: "",
  durationMinutes: 60,
});

function severityTone(sev: AlertSeverity): Tone {
  switch (sev) {
    case "critical":
      return "danger";
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

function eventStatusTone(st: AlertEventStatus): Tone {
  switch (st) {
    case "firing":
      return "danger";
    case "silenced":
      return "warning";
    default:
      return "success";
  }
}

const kpis = computed(() => [
  {
    key: "rules",
    label: t("security.ops.alerts.kpis.rules"),
    value: formatNumber(rules.value.length),
    icon: "sliders" as const,
    tone: "accent" as const,
  },
  {
    key: "firing",
    label: t("security.ops.alerts.kpis.firing"),
    value: formatNumber(firingCount.value),
    icon: "bell" as const,
    tone: firingCount.value > 0 ? ("danger" as const) : ("success" as const),
  },
  {
    key: "silences",
    label: t("security.ops.alerts.kpis.silences"),
    value: formatNumber(silences.value.length),
    icon: "pause" as const,
    tone: silences.value.length > 0 ? ("warning" as const) : ("neutral" as const),
  },
]);

let seq = 0;
async function load() {
  const mySeq = ++seq;
  loading.value = true;
  error.value = null;
  try {
    const qs = new URLSearchParams({
      page: String(eventPage.value),
      pageSize: String(eventPageSize.value),
    });
    if (eventStatusFilter.value) qs.set("status", eventStatusFilter.value);

    const [rulesRes, eventsRes, silRes] = await Promise.all([
      apiJson<{ items: AlertRule[] }>("/api/v1/admin/ops/alerts/rules"),
      apiJson<AlertEventListResponse>(`/api/v1/admin/ops/alerts/events?${qs.toString()}`),
      apiJson<{ items: AlertSilence[] }>("/api/v1/admin/ops/alerts/silences?activeOnly=true"),
    ]);
    if (mySeq !== seq) return;
    rules.value = rulesRes.items;
    events.value = eventsRes.items;
    eventsTotal.value = eventsRes.total;
    firingCount.value = eventsRes.firingCount;
    silences.value = silRes.items;
    emit("firingCount", eventsRes.firingCount);
  } catch (err) {
    if (mySeq === seq) error.value = errorText(err, t("security.ops.errors.load"));
  } finally {
    if (mySeq === seq) loading.value = false;
  }
}

async function evaluateNow() {
  evaluating.value = true;
  try {
    const res = await apiJson<AlertEvaluateResponse>("/api/v1/admin/ops/alerts/evaluate", { method: "POST" });
    toast.success(
      t("security.ops.alerts.evaluatedToast", {
        evaluated: res.evaluated,
        fired: res.fired,
        resolved: res.resolved,
      }),
    );
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  } finally {
    evaluating.value = false;
  }
}

function openCreateRule() {
  editingRuleId.value = null;
  ruleForm.name = "";
  ruleForm.description = "";
  ruleForm.metric = "error_rate";
  ruleForm.operator = "gte";
  ruleForm.threshold = 5;
  ruleForm.windowMinutes = 15;
  ruleForm.cooldownMinutes = 30;
  ruleForm.severity = "warning";
  ruleForm.emailsText = "";
  ruleForm.enabled = true;
  ruleModalOpen.value = true;
}

function openEditRule(r: AlertRule) {
  editingRuleId.value = r.id;
  ruleForm.name = r.name;
  ruleForm.description = r.description;
  ruleForm.metric = r.metric;
  ruleForm.operator = r.operator;
  ruleForm.threshold = r.threshold;
  ruleForm.windowMinutes = r.windowMinutes;
  ruleForm.cooldownMinutes = r.cooldownMinutes;
  ruleForm.severity = r.severity;
  ruleForm.emailsText = r.notifyEmails.join(", ");
  ruleForm.enabled = r.enabled;
  ruleModalOpen.value = true;
}

async function saveRule() {
  savingRule.value = true;
  try {
    const notifyEmails = ruleForm.emailsText
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const body = {
      name: ruleForm.name.trim(),
      description: ruleForm.description.trim(),
      metric: ruleForm.metric,
      operator: ruleForm.operator,
      threshold: Number(ruleForm.threshold),
      windowMinutes: Number(ruleForm.windowMinutes),
      cooldownMinutes: Number(ruleForm.cooldownMinutes),
      severity: ruleForm.severity,
      notifyEmails,
      enabled: ruleForm.enabled,
    };
    if (editingRuleId.value) {
      await apiJson(`/api/v1/admin/ops/alerts/rules/${encodeURIComponent(editingRuleId.value)}`, {
        method: "PATCH",
        body,
      });
    } else {
      await apiJson("/api/v1/admin/ops/alerts/rules", { method: "POST", body });
    }
    ruleModalOpen.value = false;
    toast.success(t("security.ops.alerts.savedRuleToast"));
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  } finally {
    savingRule.value = false;
  }
}

async function toggleRuleEnabled(r: AlertRule, enabled: boolean) {
  try {
    await apiJson(`/api/v1/admin/ops/alerts/rules/${encodeURIComponent(r.id)}`, {
      method: "PATCH",
      body: { enabled },
    });
    r.enabled = enabled;
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  }
}

async function deleteRule(id: string) {
  try {
    await apiJson(`/api/v1/admin/ops/alerts/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast.success(t("security.ops.alerts.deletedRuleToast"));
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  }
}

async function ackEvent(ev: AlertEvent) {
  try {
    await apiJson(`/api/v1/admin/ops/alerts/events/${encodeURIComponent(ev.id)}/ack`, { method: "POST" });
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  }
}

async function resolveEvent(ev: AlertEvent) {
  try {
    await apiJson(`/api/v1/admin/ops/alerts/events/${encodeURIComponent(ev.id)}/resolve`, { method: "POST" });
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  }
}

function openCreateSilence(ruleId = "") {
  silenceForm.ruleId = ruleId;
  silenceForm.reason = "";
  silenceForm.durationMinutes = 60;
  silenceModalOpen.value = true;
}

async function saveSilence() {
  savingSilence.value = true;
  try {
    const endsAtIso = new Date(Date.now() + Number(silenceForm.durationMinutes) * 60_000).toISOString();
    await apiJson("/api/v1/admin/ops/alerts/silences", {
      method: "POST",
      body: {
        ruleId: silenceForm.ruleId || null,
        reason: silenceForm.reason.trim(),
        endsAtIso,
      },
    });
    silenceModalOpen.value = false;
    toast.success(t("security.ops.alerts.savedSilenceToast"));
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  } finally {
    savingSilence.value = false;
  }
}

async function deleteSilence(id: string) {
  try {
    await apiJson(`/api/v1/admin/ops/alerts/silences/${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.errors.load")));
  }
}

watch(() => props.refreshToken, () => {
  void load();
});

watch([eventPage, eventPageSize, eventStatusFilter], () => {
  void load();
});

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
      <StatCard
        v-for="card in kpis"
        :key="card.key"
        :label="card.label"
        :value="card.value"
        :icon="card.icon"
        :tone="card.tone"
        mono
      />
    </div>

    <UiAlert v-if="error" tone="danger" :title="t('security.ops.errors.load')">
      {{ error }}
    </UiAlert>

    <!-- Rules card -->
    <UiCard icon="sliders" :title="t('security.ops.alerts.rulesTitle')" flush>
      <template #actions>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="evaluating" @click="evaluateNow">
          <UiIcon name="play" :size="14" :spin="evaluating" />
          {{ evaluating ? t("security.ops.alerts.evaluating") : t("security.ops.alerts.evaluateNow") }}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" @click="openCreateSilence('')">
          <UiIcon name="pause" :size="14" />
          {{ t("security.ops.alerts.newSilence") }}
        </button>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreateRule">
          <UiIcon name="plus" :size="14" />
          {{ t("security.ops.alerts.newRule") }}
        </button>
      </template>

      <EmptyState
        v-if="!loading && rules.length === 0"
        compact
        icon="bell"
        :title="t('security.ops.alerts.rulesEmpty')"
      />

      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("security.ops.alerts.ruleCols.name") }}</th>
              <th>{{ t("security.ops.alerts.ruleCols.condition") }}</th>
              <th>{{ t("security.ops.alerts.ruleCols.severity") }}</th>
              <th>{{ t("security.ops.alerts.ruleCols.recipients") }}</th>
              <th>{{ t("security.ops.alerts.ruleCols.lastTriggered") }}</th>
              <th>{{ t("security.ops.alerts.ruleCols.enabled") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rules" :key="r.id">
              <td class="max-w-[14rem]">
                <p class="truncate text-xs font-semibold text-fg" :title="r.name">{{ r.name }}</p>
                <p v-if="r.description" class="truncate text-2xs text-fg-subtle" :title="r.description">
                  {{ r.description }}
                </p>
              </td>
              <td class="whitespace-nowrap font-mono text-xs text-fg-muted">
                {{ t(`security.ops.alerts.metrics.${r.metric}`) }} {{ r.operator }} {{ r.threshold }} ({{ r.windowMinutes }}m)
              </td>
              <td>
                <UiBadge :tone="severityTone(r.severity)">
                  {{ t(`security.ops.alerts.severities.${r.severity}`) }}
                </UiBadge>
              </td>
              <td class="max-w-[12rem] truncate text-xs text-fg-muted" :title="r.notifyEmails.join(', ')">
                {{ r.notifyEmails.length > 0 ? r.notifyEmails.join(", ") : "—" }}
              </td>
              <td class="whitespace-nowrap text-xs text-fg-subtle">
                <span v-if="r.lastTriggeredAtIso" :title="formatDateTime(r.lastTriggeredAtIso)">
                  {{ formatRelative(r.lastTriggeredAtIso, now) }}
                </span>
                <span v-else>—</span>
              </td>
              <td>
                <UiSwitch
                  :model-value="r.enabled"
                  hide-label
                  :label="r.name"
                  @update:model-value="toggleRuleEnabled(r, $event)"
                />
              </td>
              <td class="whitespace-nowrap text-right">
                <div class="inline-flex items-center gap-1">
                  <button type="button" class="btn btn-ghost btn-xs" @click="openEditRule(r)">
                    <UiIcon name="pencil" :size="13" />
                  </button>
                  <button type="button" class="btn btn-ghost btn-xs" @click="openCreateSilence(r.id)">
                    <UiIcon name="pause" :size="13" />
                  </button>
                  <ConfirmButton
                    size="xs"
                    icon="trash"
                    icon-only
                    :confirm-label="t('common.confirm')"
                    @confirm="deleteRule(r.id)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Events card -->
    <UiCard icon="bell" :title="t('security.ops.alerts.eventsTitle')" flush>
      <template #actions>
        <UiSelect v-model="eventStatusFilter" class="select input-sm w-auto">
          <option value="">{{ t("security.ops.alerts.allStatuses") }}</option>
          <option value="firing">{{ t("security.ops.alerts.eventStatuses.firing") }}</option>
          <option value="silenced">{{ t("security.ops.alerts.eventStatuses.silenced") }}</option>
          <option value="resolved">{{ t("security.ops.alerts.eventStatuses.resolved") }}</option>
        </UiSelect>
      </template>

      <EmptyState
        v-if="!loading && events.length === 0"
        compact
        icon="check-circle"
        :title="t('security.ops.alerts.eventsEmpty')"
      />

      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("security.ops.alerts.eventCols.time") }}</th>
              <th>{{ t("security.ops.alerts.eventCols.rule") }}</th>
              <th>{{ t("security.ops.alerts.eventCols.severity") }}</th>
              <th>{{ t("security.ops.alerts.eventCols.status") }}</th>
              <th>{{ t("security.ops.alerts.eventCols.message") }}</th>
              <th>{{ t("security.ops.alerts.eventCols.notified") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ev in events" :key="ev.id">
              <td class="whitespace-nowrap text-xs text-fg" :title="formatDateTime(ev.firedAtIso)">
                {{ formatRelative(ev.firedAtIso, now) }}
              </td>
              <td class="max-w-[12rem] truncate text-xs font-medium text-fg" :title="ev.ruleName">
                {{ ev.ruleName || ev.ruleId }}
              </td>
              <td>
                <UiBadge :tone="severityTone(ev.severity)">
                  {{ t(`security.ops.alerts.severities.${ev.severity}`) }}
                </UiBadge>
              </td>
              <td>
                <UiBadge :tone="eventStatusTone(ev.status)" dot>
                  {{ t(`security.ops.alerts.eventStatuses.${ev.status}`) }}
                </UiBadge>
              </td>
              <td class="max-w-[18rem]">
                <p class="truncate text-xs text-fg" :title="ev.message">{{ ev.message }}</p>
                <p v-if="ev.acknowledgedBy" class="text-2xs text-fg-subtle">
                  ack: {{ ev.acknowledgedBy }}
                </p>
              </td>
              <td class="whitespace-nowrap">
                <UiBadge v-if="ev.notified" tone="success">{{ t("security.ops.alerts.mailSent") }}</UiBadge>
                <UiBadge v-else-if="ev.notifyError" tone="danger" :title="ev.notifyError">
                  {{ t("security.ops.alerts.mailFailed") }}
                </UiBadge>
                <span v-else class="text-xs text-fg-subtle">—</span>
              </td>
              <td class="whitespace-nowrap text-right">
                <div v-if="ev.status === 'firing'" class="inline-flex items-center gap-1">
                  <button
                    v-if="!ev.acknowledgedAtIso"
                    type="button"
                    class="btn btn-secondary btn-xs"
                    @click="ackEvent(ev)"
                  >
                    {{ t("security.ops.alerts.ack") }}
                  </button>
                  <button type="button" class="btn btn-primary btn-xs" @click="resolveEvent(ev)">
                    {{ t("security.ops.alerts.resolve") }}
                  </button>
                </div>
                <span v-else class="text-xs text-fg-subtle">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <UiPagination
        v-if="eventsTotal > 0"
        v-model:page="eventPage"
        v-model:page-size="eventPageSize"
        :total="eventsTotal"
        :disabled="loading"
      />
    </UiCard>

    <!-- Active silences -->
    <UiCard v-if="silences.length > 0" icon="pause" :title="t('security.ops.alerts.silencesTitle')" flush>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("security.ops.alerts.silenceCols.scope") }}</th>
              <th>{{ t("security.ops.alerts.silenceCols.reason") }}</th>
              <th>{{ t("security.ops.alerts.silenceCols.endsAt") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in silences" :key="s.id">
              <td class="text-xs font-medium text-fg">
                {{ s.ruleId ? (s.ruleName || s.ruleId) : t("security.ops.alerts.globalSilence") }}
              </td>
              <td class="text-xs text-fg-muted">{{ s.reason || "—" }}</td>
              <td class="whitespace-nowrap text-xs text-fg-subtle" :title="formatDateTime(s.endsAtIso)">
                {{ formatRelative(s.endsAtIso, now) }}
              </td>
              <td class="text-right">
                <ConfirmButton
                  size="xs"
                  icon="trash"
                  icon-only
                  :confirm-label="t('common.confirm')"
                  @confirm="deleteSilence(s.id)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Create / Edit Rule Modal -->
    <UiModal
      v-model:open="ruleModalOpen"
      :title="editingRuleId ? t('security.ops.alerts.editRule') : t('security.ops.alerts.newRule')"
      width="md"
    >
      <form class="space-y-4 p-5" @submit.prevent="saveRule">
        <FormField :label="t('security.ops.alerts.ruleCols.name')">
          <input v-model="ruleForm.name" type="text" required class="input w-full" />
        </FormField>

        <FormField :label="t('security.ops.alerts.form.description')">
          <input v-model="ruleForm.description" type="text" class="input w-full" />
        </FormField>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField :label="t('security.ops.alerts.form.metric')">
            <UiSelect v-model="ruleForm.metric" class="select w-full">
              <option v-for="m in ALERT_METRICS" :key="m" :value="m">
                {{ t(`security.ops.alerts.metrics.${m}`) }}
              </option>
            </UiSelect>
          </FormField>
          <FormField :label="t('security.ops.alerts.form.operator')">
            <UiSelect v-model="ruleForm.operator" class="select w-full">
              <option v-for="op in ALERT_OPERATORS" :key="op" :value="op">{{ op }}</option>
            </UiSelect>
          </FormField>
          <FormField :label="t('security.ops.alerts.form.threshold')">
            <input v-model.number="ruleForm.threshold" type="number" step="any" min="0" required class="input w-full" />
          </FormField>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField :label="t('security.ops.alerts.form.windowMinutes')">
            <input v-model.number="ruleForm.windowMinutes" type="number" min="1" max="10080" required class="input w-full" />
          </FormField>
          <FormField :label="t('security.ops.alerts.form.cooldownMinutes')">
            <input v-model.number="ruleForm.cooldownMinutes" type="number" min="0" max="10080" required class="input w-full" />
          </FormField>
          <FormField :label="t('security.ops.alerts.ruleCols.severity')">
            <UiSelect v-model="ruleForm.severity" class="select w-full">
              <option v-for="sev in ALERT_SEVERITIES" :key="sev" :value="sev">
                {{ t(`security.ops.alerts.severities.${sev}`) }}
              </option>
            </UiSelect>
          </FormField>
        </div>

        <FormField :label="t('security.ops.alerts.form.notifyEmails')">
          <input
            v-model="ruleForm.emailsText"
            type="text"
            class="input w-full"
            placeholder="ops@example.com, oncall@example.com"
          />
        </FormField>

        <div class="flex items-center justify-between pt-2">
          <UiSwitch v-model="ruleForm.enabled" :label="t('security.ops.alerts.ruleCols.enabled')" />
          <div class="flex items-center gap-2">
            <button type="button" class="btn btn-secondary" @click="ruleModalOpen = false">
              {{ t("common.cancel") }}
            </button>
            <button type="submit" class="btn btn-primary" :disabled="savingRule">
              {{ savingRule ? t("common.saving") : t("common.save") }}
            </button>
          </div>
        </div>
      </form>
    </UiModal>

    <!-- Create Silence Modal -->
    <UiModal v-model:open="silenceModalOpen" :title="t('security.ops.alerts.newSilence')" width="sm">
      <form class="space-y-4 p-5" @submit.prevent="saveSilence">
        <FormField :label="t('security.ops.alerts.silenceCols.scope')">
          <UiSelect v-model="silenceForm.ruleId" class="select w-full">
            <option value="">{{ t("security.ops.alerts.globalSilence") }}</option>
            <option v-for="r in rules" :key="r.id" :value="r.id">{{ r.name }}</option>
          </UiSelect>
        </FormField>

        <FormField :label="t('security.ops.alerts.form.silenceMinutes')">
          <input v-model.number="silenceForm.durationMinutes" type="number" min="5" max="43200" required class="input w-full" />
        </FormField>

        <FormField :label="t('security.ops.alerts.silenceCols.reason')">
          <input v-model="silenceForm.reason" type="text" class="input w-full" />
        </FormField>

        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="btn btn-secondary" @click="silenceModalOpen = false">
            {{ t("common.cancel") }}
          </button>
          <button type="submit" class="btn btn-primary" :disabled="savingSilence">
            {{ savingSilence ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </form>
    </UiModal>
  </div>
</template>
