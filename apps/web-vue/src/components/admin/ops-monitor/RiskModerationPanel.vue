<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  ModerationAction,
  ModerationEvent,
  ModerationRule,
  ModerationRuleKind,
  ModerationSettings,
  ModerationSource,
  ModerationTestResponse,
} from "@slipgate/contracts";
import { apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatRelative, type Tone } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import FormField from "../../ui/FormField.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";

const props = defineProps<{
  mode: "moderation" | "events";
  now: number;
  refreshToken: number;
}>();

const { t } = useI18n();
const toast = useToastStore();

const loading = ref(false);
const errorMessage = ref<string | null>(null);

/* ---------------- Settings ---------------- */
const settings = ref<ModerationSettings>({
  enabled: false,
  externalEnabled: false,
  externalEndpoint: "",
  externalApiKeySet: false,
  externalModel: "omni-moderation-latest",
  externalTimeoutMs: 3000,
  externalFailOpen: true,
  updatedAtIso: "",
});
const form = reactive({
  enabled: false,
  externalEnabled: false,
  externalEndpoint: "",
  externalApiKey: "",
  clearExternalApiKey: false,
  externalModel: "omni-moderation-latest",
  externalTimeoutMs: 3000,
  externalFailOpen: true,
});
const showApiKey = ref(false);
const savingSettings = ref(false);

/* ---------------- Rules + Modal ---------------- */
const rules = ref<ModerationRule[]>([]);
const ruleModalOpen = ref(false);
const editingRuleId = ref<string | null>(null);
const savingRule = ref(false);
const ruleForm = reactive({
  name: "",
  enabled: true,
  kind: "keyword" as ModerationRuleKind,
  pattern: "",
  caseSensitive: false,
  action: "block" as ModerationAction,
  scopePlatformsText: "",
  scopeGroupIdsText: "",
  rejectMessage: "Request blocked by content moderation policy",
  priority: 100,
});

/* ---------------- Simulator ---------------- */
const testText = ref("");
const testPlatform = ref("");
const testGroupId = ref("");
const testingPrompt = ref(false);
const testResult = ref<ModerationTestResponse | null>(null);

/* ---------------- Events ---------------- */
const events = ref<ModerationEvent[]>([]);
const actionFilter = ref<"all" | ModerationAction>("all");
const sourceFilter = ref<"all" | ModerationSource>("all");

const ACTION_TONE: Record<ModerationAction, Tone> = {
  block: "danger",
  strike: "warning",
  log_only: "info",
};

const actionOptions = computed(() => [
  { value: "all" as const, label: t("security.risk.filters.all") },
  { value: "block" as const, label: t("security.risk.moderation.actions.block") },
  { value: "strike" as const, label: t("security.risk.moderation.actions.strike") },
  { value: "log_only" as const, label: t("security.risk.moderation.actions.log_only") },
]);

const sourceOptions = computed(() => [
  { value: "all" as const, label: t("security.risk.filters.all") },
  { value: "local_rule" as const, label: t("security.risk.moderation.sources.local_rule") },
  { value: "external_api" as const, label: t("security.risk.moderation.sources.external_api") },
]);

function applySettings(s: ModerationSettings) {
  settings.value = s;
  form.enabled = s.enabled;
  form.externalEnabled = s.externalEnabled;
  form.externalEndpoint = s.externalEndpoint;
  form.externalApiKey = "";
  form.clearExternalApiKey = false;
  form.externalModel = s.externalModel;
  form.externalTimeoutMs = s.externalTimeoutMs;
  form.externalFailOpen = s.externalFailOpen;
}

async function loadModeration() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const [s, r] = await Promise.all([
      apiJson<ModerationSettings>("/api/v1/admin/moderation/settings", {
        fallbackError: t("security.risk.moderation.errors.load"),
      }),
      apiJson<{ items: ModerationRule[] }>("/api/v1/admin/moderation/rules", {
        fallbackError: t("security.risk.moderation.errors.load"),
      }),
    ]);
    applySettings(s);
    rules.value = r.items;
  } catch (err) {
    errorMessage.value = errorText(err, t("security.risk.moderation.errors.load"));
  } finally {
    loading.value = false;
  }
}

async function loadEvents() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const qs = new URLSearchParams({ limit: "100" });
    if (actionFilter.value !== "all") qs.set("action", actionFilter.value);
    if (sourceFilter.value !== "all") qs.set("source", sourceFilter.value);
    const res = await apiJson<{ items: ModerationEvent[] }>(`/api/v1/admin/moderation/events?${qs.toString()}`, {
      fallbackError: t("security.risk.moderation.errors.events"),
    });
    events.value = res.items;
  } catch (err) {
    errorMessage.value = errorText(err, t("security.risk.moderation.errors.events"));
  } finally {
    loading.value = false;
  }
}

function reload() {
  if (props.mode === "moderation") void loadModeration();
  else void loadEvents();
}

onMounted(reload);
watch(() => props.refreshToken, reload);
watch(() => props.mode, reload);
watch([actionFilter, sourceFilter], () => {
  if (props.mode === "events") void loadEvents();
});

async function saveSettings() {
  savingSettings.value = true;
  try {
    const payload: Record<string, unknown> = {
      enabled: form.enabled,
      externalEnabled: form.externalEnabled,
      externalEndpoint: form.externalEndpoint.trim(),
      externalModel: form.externalModel.trim() || "omni-moderation-latest",
      externalTimeoutMs: Math.max(500, Math.min(15000, Math.round(Number(form.externalTimeoutMs) || 3000))),
      externalFailOpen: form.externalFailOpen,
    };
    if (form.clearExternalApiKey) {
      payload.externalApiKey = "";
    } else if (form.externalApiKey.trim() !== "") {
      payload.externalApiKey = form.externalApiKey.trim();
    }
    const updated = await apiJson<ModerationSettings>("/api/v1/admin/moderation/settings", {
      method: "PATCH",
      body: payload,
      fallbackError: t("security.risk.moderation.errors.saveSettings"),
    });
    applySettings(updated);
    toast.success(t("security.risk.moderation.settingsSaved"));
  } catch (err) {
    toast.error(errorText(err, t("security.risk.moderation.errors.saveSettings")));
  } finally {
    savingSettings.value = false;
  }
}

function openCreateRule() {
  editingRuleId.value = null;
  ruleForm.name = "";
  ruleForm.enabled = true;
  ruleForm.kind = "keyword";
  ruleForm.pattern = "";
  ruleForm.caseSensitive = false;
  ruleForm.action = "block";
  ruleForm.scopePlatformsText = "";
  ruleForm.scopeGroupIdsText = "";
  ruleForm.rejectMessage = "Request blocked by content moderation policy";
  ruleForm.priority = 100;
  ruleModalOpen.value = true;
}

function openEditRule(r: ModerationRule) {
  editingRuleId.value = r.id;
  ruleForm.name = r.name;
  ruleForm.enabled = r.enabled;
  ruleForm.kind = r.kind;
  ruleForm.pattern = r.pattern;
  ruleForm.caseSensitive = r.caseSensitive;
  ruleForm.action = r.action;
  ruleForm.scopePlatformsText = r.scopePlatforms.join(", ");
  ruleForm.scopeGroupIdsText = r.scopeGroupIds.join(", ");
  ruleForm.rejectMessage = r.rejectMessage;
  ruleForm.priority = r.priority;
  ruleModalOpen.value = true;
}

function splitCsv(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function saveRule() {
  savingRule.value = true;
  try {
    const body = {
      name: ruleForm.name.trim(),
      enabled: ruleForm.enabled,
      kind: ruleForm.kind,
      pattern: ruleForm.pattern.trim(),
      caseSensitive: ruleForm.caseSensitive,
      action: ruleForm.action,
      scopePlatforms: splitCsv(ruleForm.scopePlatformsText),
      scopeGroupIds: splitCsv(ruleForm.scopeGroupIdsText),
      rejectMessage: ruleForm.rejectMessage.trim() || "Request blocked by content moderation policy",
      priority: Math.max(1, Math.min(10000, Math.round(Number(ruleForm.priority) || 100))),
    };
    if (editingRuleId.value) {
      await apiJson(`/api/v1/admin/moderation/rules/${encodeURIComponent(editingRuleId.value)}`, {
        method: "PUT",
        body,
        fallbackError: t("security.risk.moderation.errors.saveRule"),
      });
    } else {
      await apiJson("/api/v1/admin/moderation/rules", {
        method: "POST",
        body,
        fallbackError: t("security.risk.moderation.errors.saveRule"),
      });
    }
    ruleModalOpen.value = false;
    toast.success(t("security.risk.moderation.ruleSaved"));
    await loadModeration();
  } catch (err) {
    toast.error(errorText(err, t("security.risk.moderation.errors.saveRule")));
  } finally {
    savingRule.value = false;
  }
}

async function removeRule(id: string) {
  try {
    await apiJson(`/api/v1/admin/moderation/rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
      fallbackError: t("security.risk.moderation.errors.deleteRule"),
    });
    toast.success(t("security.risk.moderation.ruleDeleted"));
    await loadModeration();
  } catch (err) {
    toast.error(errorText(err, t("security.risk.moderation.errors.deleteRule")));
  }
}

async function runTestPrompt() {
  if (!testText.value.trim()) return;
  testingPrompt.value = true;
  try {
    testResult.value = await apiJson<ModerationTestResponse>("/api/v1/admin/moderation/test", {
      method: "POST",
      body: {
        text: testText.value,
        ...(testPlatform.value.trim() ? { platform: testPlatform.value.trim() } : {}),
        ...(testGroupId.value.trim() ? { groupId: testGroupId.value.trim() } : {}),
      },
      fallbackError: t("security.risk.moderation.errors.test"),
    });
  } catch (err) {
    toast.error(errorText(err, t("security.risk.moderation.errors.test")));
  } finally {
    testingPrompt.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <UiAlert v-if="errorMessage" tone="danger">{{ errorMessage }}</UiAlert>

    <template v-if="mode === 'moderation'">
      <!-- Global & External API Settings -->
      <UiCard icon="sliders" :title="t('security.risk.moderation.settingsTitle')">
        <template #actions>
          <button type="button" class="btn btn-primary btn-sm" :disabled="savingSettings" @click="saveSettings">
            <UiIcon :name="savingSettings ? 'loader' : 'check'" :size="14" :spin="savingSettings" />
            {{ t("common.save") }}
          </button>
        </template>

        <div class="space-y-4">
          <div class="flex flex-wrap items-center gap-6">
            <UiSwitch v-model="form.enabled" :label="t('security.risk.moderation.enableSwitch')" />
            <UiSwitch v-model="form.externalEnabled" :label="t('security.risk.moderation.externalSwitch')" />
            <UiSwitch
              v-model="form.externalFailOpen"
              :disabled="!form.externalEnabled"
              :label="t('security.risk.moderation.failOpenSwitch')"
            />
          </div>

          <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <FormField :label="t('security.risk.moderation.externalEndpoint')" class="md:col-span-2">
              <input
                v-model="form.externalEndpoint"
                type="url"
                class="input font-mono text-xs"
                :placeholder="'https://api.openai.com/v1/moderations'"
              />
            </FormField>
            <FormField :label="t('security.risk.moderation.externalModel')">
              <input v-model="form.externalModel" type="text" class="input font-mono text-xs" />
            </FormField>
            <FormField :label="t('security.risk.moderation.externalTimeout')">
              <input v-model.number="form.externalTimeoutMs" type="number" min="500" max="15000" step="100" class="input font-mono text-xs" />
            </FormField>
          </div>

          <div class="flex flex-wrap items-end gap-4">
            <FormField :label="t('security.risk.moderation.externalApiKey')" class="min-w-[260px] flex-1 max-w-md">
              <div class="relative flex items-center">
                <input
                  v-model="form.externalApiKey"
                  :type="showApiKey ? 'text' : 'password'"
                  autocomplete="new-password"
                  class="input pr-9 font-mono text-xs"
                  :placeholder="settings.externalApiKeySet ? t('security.risk.moderation.keySetPlaceholder') : t('security.risk.moderation.keyUnsetPlaceholder')"
                  :disabled="form.clearExternalApiKey"
                />
                <button
                  type="button"
                  class="absolute right-2 text-fg-muted hover:text-fg"
                  :aria-label="showApiKey ? 'Hide' : 'Show'"
                  @click="showApiKey = !showApiKey"
                >
                  <UiIcon :name="showApiKey ? 'eye-off' : 'eye'" :size="15" />
                </button>
              </div>
            </FormField>
            <div class="flex items-center gap-3 pb-1.5">
              <UiBadge v-if="settings.externalApiKeySet" tone="success">{{ t("security.risk.moderation.keyConfigured") }}</UiBadge>
              <label v-if="settings.externalApiKeySet" class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
                <input v-model="form.clearExternalApiKey" type="checkbox" class="rounded border-line" />
                {{ t("security.risk.moderation.clearKey") }}
              </label>
            </div>
          </div>
        </div>
      </UiCard>

      <!-- Local Rules -->
      <UiCard icon="shield" :title="t('security.risk.moderation.rulesTitle')" flush>
        <template #actions>
          <button type="button" class="btn btn-primary btn-sm" @click="openCreateRule">
            <UiIcon name="plus" :size="14" />
            {{ t("security.risk.moderation.newRule") }}
          </button>
        </template>

        <EmptyState v-if="!loading && rules.length === 0" icon="shield" :title="t('security.risk.moderation.rulesEmpty')" />

        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("security.risk.moderation.ruleCols.name") }}</th>
                <th>{{ t("security.risk.moderation.ruleCols.kindPattern") }}</th>
                <th>{{ t("security.risk.moderation.ruleCols.action") }}</th>
                <th>{{ t("security.risk.moderation.ruleCols.scope") }}</th>
                <th class="text-right">{{ t("security.risk.moderation.ruleCols.priority") }}</th>
                <th>{{ t("security.risk.moderation.ruleCols.state") }}</th>
                <th class="text-right">{{ t("common.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rules" :key="r.id">
                <td class="text-xs font-medium text-fg">
                  {{ r.name }}
                  <p v-if="r.caseSensitive" class="text-2xs text-fg-subtle">{{ t("security.risk.moderation.caseSensitive") }}</p>
                </td>
                <td class="max-w-[18rem]">
                  <div class="flex items-center gap-1.5">
                    <UiBadge tone="neutral">{{ t(`security.risk.moderation.kinds.${r.kind}`) }}</UiBadge>
                    <span class="code-chip max-w-[13rem] truncate" :title="r.pattern">{{ r.pattern }}</span>
                  </div>
                </td>
                <td>
                  <UiBadge :tone="ACTION_TONE[r.action]">{{ t(`security.risk.moderation.actions.${r.action}`) }}</UiBadge>
                </td>
                <td class="text-2xs text-fg-muted">
                  <span v-if="r.scopePlatforms.length === 0 && r.scopeGroupIds.length === 0">
                    {{ t("security.risk.moderation.allScopes") }}
                  </span>
                  <span v-else class="font-mono">
                    {{ [...r.scopePlatforms, ...r.scopeGroupIds].join(", ") }}
                  </span>
                </td>
                <td class="text-right font-mono text-xs tabular-nums text-fg">{{ r.priority }}</td>
                <td>
                  <UiBadge :tone="r.enabled ? 'success' : 'neutral'" dot>
                    {{ r.enabled ? t("common.enabled") : t("common.disabled") }}
                  </UiBadge>
                </td>
                <td class="text-right whitespace-nowrap">
                  <div class="inline-flex items-center gap-1">
                    <button type="button" class="btn btn-ghost btn-xs" @click="openEditRule(r)">
                      <UiIcon name="pencil" :size="13" />
                      {{ t("common.edit") }}
                    </button>
                    <ConfirmButton size="xs" @confirm="removeRule(r.id)" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <!-- Test Simulator -->
      <UiCard icon="play" :title="t('security.risk.moderation.testTitle')">
        <div class="space-y-3">
          <FormField :label="t('security.risk.moderation.testText')">
            <textarea
              v-model="testText"
              rows="3"
              class="input min-h-[72px] py-2 font-mono text-xs"
              :placeholder="t('security.risk.moderation.testPlaceholder')"
            />
          </FormField>
          <div class="flex flex-wrap items-end gap-3">
            <FormField :label="t('security.risk.moderation.testPlatform')" class="w-44">
              <input v-model="testPlatform" type="text" class="input font-mono text-xs" placeholder="openai / anthropic" />
            </FormField>
            <FormField :label="t('security.risk.moderation.testGroupId')" class="w-48">
              <input v-model="testGroupId" type="text" class="input font-mono text-xs" placeholder="grp_default" />
            </FormField>
            <button type="button" class="btn btn-secondary btn-sm" :disabled="testingPrompt || !testText.trim()" @click="runTestPrompt">
              <UiIcon :name="testingPrompt ? 'loader' : 'play'" :size="14" :spin="testingPrompt" />
              {{ t("security.risk.moderation.runTest") }}
            </button>
          </div>
          <UiAlert v-if="testResult" :tone="testResult.matched ? (testResult.action === 'log_only' ? 'warning' : 'danger') : 'success'">
            <template v-if="testResult.matched">
              <strong>{{ testResult.ruleName }}</strong> ({{ t(`security.risk.moderation.actions.${testResult.action}`) }})
              — {{ testResult.rejectMessage }}
              <span v-if="testResult.matchedExcerpt" class="ml-2 font-mono text-2xs">[{{ testResult.matchedExcerpt }}]</span>
            </template>
            <template v-else>{{ t("security.risk.moderation.testClean") }}</template>
          </UiAlert>
        </div>
      </UiCard>
    </template>

    <template v-else>
      <UiCard icon="list" :title="t('security.risk.moderation.eventsTitle')" flush>
        <template #actions>
          <button type="button" class="btn btn-secondary btn-xs" :disabled="loading" @click="loadEvents">
            <UiIcon name="refresh" :size="13" :spin="loading" />
            {{ t("common.refresh") }}
          </button>
        </template>

        <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-4 py-3 sm:px-5">
          <SegmentedControl v-model="actionFilter" :options="actionOptions" />
          <SegmentedControl v-model="sourceFilter" :options="sourceOptions" class="lg:ml-auto" />
        </div>

        <EmptyState v-if="!loading && events.length === 0" icon="shield" :title="t('security.risk.moderation.eventsEmpty')" />

        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("security.risk.moderation.eventCols.time") }}</th>
                <th>{{ t("security.risk.moderation.eventCols.rule") }}</th>
                <th>{{ t("security.risk.moderation.eventCols.source") }}</th>
                <th>{{ t("security.risk.moderation.eventCols.action") }}</th>
                <th>{{ t("security.risk.moderation.eventCols.target") }}</th>
                <th>{{ t("security.risk.moderation.eventCols.excerpt") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ev in events" :key="ev.id">
                <td class="whitespace-nowrap">
                  <p class="text-xs text-fg">{{ formatRelative(ev.createdAtIso, now) }}</p>
                  <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ formatDateTime(ev.createdAtIso) }}</p>
                </td>
                <td class="text-xs text-fg">
                  {{ ev.ruleName || "—" }}
                  <p v-if="ev.requestId" class="font-mono text-2xs text-fg-subtle">{{ ev.requestId }}</p>
                </td>
                <td>
                  <UiBadge tone="neutral">{{ t(`security.risk.moderation.sources.${ev.source}`) }}</UiBadge>
                </td>
                <td>
                  <UiBadge :tone="ACTION_TONE[ev.action]">{{ t(`security.risk.moderation.actions.${ev.action}`) }}</UiBadge>
                </td>
                <td class="font-mono text-2xs text-fg-muted">
                  {{ [ev.platform, ev.publicModel].filter(Boolean).join(" / ") || "—" }}
                </td>
                <td class="max-w-[16rem]">
                  <span class="code-chip max-w-full truncate" :title="ev.matchedExcerpt">{{ ev.matchedExcerpt || "—" }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>
    </template>

    <UiModal
      :open="ruleModalOpen"
      :title="editingRuleId ? t('security.risk.moderation.editRule') : t('security.risk.moderation.newRule')"
      width="lg"
      @close="ruleModalOpen = false"
    >
      <div class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <FormField :label="t('security.risk.moderation.ruleCols.name')">
            <input v-model="ruleForm.name" type="text" class="input text-xs" />
          </FormField>
          <FormField :label="t('security.risk.moderation.ruleCols.priority')">
            <input v-model.number="ruleForm.priority" type="number" min="1" max="10000" class="input font-mono text-xs" />
          </FormField>
          <FormField :label="t('security.risk.moderation.kindLabel')">
            <select v-model="ruleForm.kind" class="input text-xs">
              <option value="keyword">{{ t("security.risk.moderation.kinds.keyword") }}</option>
              <option value="regex">{{ t("security.risk.moderation.kinds.regex") }}</option>
            </select>
          </FormField>
          <FormField :label="t('security.risk.moderation.ruleCols.action')">
            <select v-model="ruleForm.action" class="input text-xs">
              <option value="block">{{ t("security.risk.moderation.actions.block") }}</option>
              <option value="strike">{{ t("security.risk.moderation.actions.strike") }}</option>
              <option value="log_only">{{ t("security.risk.moderation.actions.log_only") }}</option>
            </select>
          </FormField>
        </div>

        <FormField :label="t('security.risk.moderation.patternLabel')">
          <textarea
            v-model="ruleForm.pattern"
            rows="3"
            class="input min-h-[72px] py-2 font-mono text-xs"
            :placeholder="ruleForm.kind === 'keyword' ? 'badword1, badword2' : '\\bsecret-[0-9]{4}\\b'"
          />
        </FormField>

        <FormField :label="t('security.risk.moderation.rejectMessage')">
          <input v-model="ruleForm.rejectMessage" type="text" class="input text-xs" />
        </FormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField :label="t('security.risk.moderation.scopePlatforms')">
            <input v-model="ruleForm.scopePlatformsText" type="text" class="input font-mono text-xs" placeholder="openai, anthropic" />
          </FormField>
          <FormField :label="t('security.risk.moderation.scopeGroups')">
            <input v-model="ruleForm.scopeGroupIdsText" type="text" class="input font-mono text-xs" placeholder="grp_default" />
          </FormField>
        </div>

        <div class="flex flex-wrap items-center gap-6">
          <UiSwitch v-model="ruleForm.enabled" :label="t('common.enabled')" />
          <UiSwitch v-model="ruleForm.caseSensitive" :label="t('security.risk.moderation.caseSensitive')" />
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-secondary btn-sm" @click="ruleModalOpen = false">{{ t("common.cancel") }}</button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="savingRule || !ruleForm.name.trim() || !ruleForm.pattern.trim()"
            @click="saveRule"
          >
            <UiIcon :name="savingRule ? 'loader' : 'check'" :size="14" :spin="savingRule" />
            {{ t("common.save") }}
          </button>
        </div>
      </template>
    </UiModal>
  </div>
</template>
