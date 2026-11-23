<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import {
  RUNTIME_LOG_STACKTRACE_LEVELS,
  SYSTEM_LOG_LEVELS,
  type RuntimeLogConfig,
  type SystemLogLevel,
  type UpdateRuntimeLogConfigRequest,
} from "@slipgate/contracts";
import SettingField from "../../settings/SettingField.vue";
import SettingSwitchRow from "../../settings/SettingSwitchRow.vue";
import SettingsSaveBar from "../../settings/SettingsSaveBar.vue";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import CopyButton from "../../ui/CopyButton.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { apiJson } from "../../../lib/api";
import { formatDateTime, formatNumber, formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import LogRetentionSelect from "./LogRetentionSelect.vue";
import SystemLogErrorMeta from "./SystemLogErrorMeta.vue";
import { describeError, type ErrorInfo } from "./systemLogUtil";

/**
 * Runtime log configuration: level, what gets stored, sampling, caller/stack detail and the
 * retention. Saved changes apply to this console at once and reach slipgate-net / core within
 * about 30 s; "reset" returns to the environment baseline.
 */
const { t } = useI18n();
const toast = useToastStore();

type StacktraceLevel = (typeof RUNTIME_LOG_STACKTRACE_LEVELS)[number];

interface Draft {
  level: SystemLogLevel;
  persistAccessLogs: boolean;
  enableSampling: boolean;
  /** Number inputs hold "" while empty; validated before saving. */
  samplingInitial: number | string;
  samplingThereafter: number | string;
  caller: boolean;
  stacktraceLevel: StacktraceLevel;
  retentionDays: number | string;
}
type DraftKey = keyof Draft;
const KEYS: DraftKey[] = [
  "level",
  "persistAccessLogs",
  "enableSampling",
  "samplingInitial",
  "samplingThereafter",
  "caller",
  "stacktraceLevel",
  "retentionDays",
];

function fromConfig(c: RuntimeLogConfig): Draft {
  return {
    level: c.level,
    persistAccessLogs: c.persistAccessLogs,
    enableSampling: c.enableSampling,
    samplingInitial: c.samplingInitial,
    samplingThereafter: c.samplingThereafter,
    caller: c.caller,
    stacktraceLevel: c.stacktraceLevel,
    retentionDays: c.retentionDays,
  };
}

const original = ref<RuntimeLogConfig | null>(null);
const draft = reactive<Draft>({
  level: "info",
  persistAccessLogs: false,
  enableSampling: false,
  samplingInitial: 100,
  samplingThereafter: 100,
  caller: false,
  stacktraceLevel: "error",
  retentionDays: 30,
});

const loading = ref(false);
const loadError = ref<ErrorInfo | null>(null);
const saving = ref(false);
const resetting = ref(false);
const saveError = ref<ErrorInfo | null>(null);

function adopt(cfg: RuntimeLogConfig) {
  original.value = cfg;
  Object.assign(draft, fromConfig(cfg));
  saveError.value = null;
}

async function load() {
  loading.value = true;
  try {
    const cfg = await apiJson<RuntimeLogConfig>("/api/v1/admin/ops/runtime/logging", {
      fallbackError: t("systemLogs.config.loadFailed"),
    });
    adopt(cfg);
    loadError.value = null;
  } catch (err) {
    loadError.value = describeError(err, t, t("systemLogs.config.loadFailed"));
    // A failed refresh keeps the settings on screen: say they may be out of date.
    if (original.value) toast.warning(t("systemLogs.config.refreshFailedToast", { reason: loadError.value.message }));
  } finally {
    loading.value = false;
  }
}

function reload() {
  if (dirtyKeys.value.length && !window.confirm(t("systemLogs.config.discardConfirm"))) return;
  void load();
}

/* ---------------- Validation & diff ---------------- */

const intIn = (v: number | string, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return v !== "" && Number.isInteger(n) && n >= min && n <= max;
};

const errors = computed(() => {
  const e: Partial<Record<"samplingInitial" | "samplingThereafter" | "retentionDays", string>> = {};
  if (!intIn(draft.samplingInitial, 1, 100_000)) e.samplingInitial = t("systemLogs.config.errors.sampling");
  if (!intIn(draft.samplingThereafter, 1, 100_000)) e.samplingThereafter = t("systemLogs.config.errors.sampling");
  if (!intIn(draft.retentionDays, 1, 3650)) e.retentionDays = t("systemLogs.config.errors.retention");
  return e;
});
const invalid = computed(() => Object.keys(errors.value).length > 0);

function isDirty(key: DraftKey): boolean {
  const o = original.value;
  if (!o) return false;
  const v = draft[key];
  const base = o[key];
  return typeof base === "number" ? Number(v) !== base || v === "" : v !== base;
}
const dirtyKeys = computed(() => KEYS.filter(isDirty));

function buildPatch(): UpdateRuntimeLogConfigRequest {
  const patch: UpdateRuntimeLogConfigRequest = {};
  for (const key of dirtyKeys.value) {
    switch (key) {
      case "samplingInitial":
      case "samplingThereafter":
      case "retentionDays":
        patch[key] = Number(draft[key]);
        break;
      case "level":
        patch.level = draft.level;
        break;
      case "stacktraceLevel":
        patch.stacktraceLevel = draft.stacktraceLevel;
        break;
      default:
        patch[key] = draft[key];
    }
  }
  return patch;
}

async function save() {
  if (saving.value || !dirtyKeys.value.length) return;
  if (invalid.value) {
    toast.error(t("systemLogs.config.errors.fix"));
    return;
  }
  saving.value = true;
  saveError.value = null;
  try {
    const saved = await apiJson<RuntimeLogConfig>("/api/v1/admin/ops/runtime/logging", {
      method: "PUT",
      body: buildPatch(),
      fallbackError: t("systemLogs.config.saveFailed"),
    });
    adopt(saved);
    toast.success(t("systemLogs.config.saved"));
  } catch (err) {
    saveError.value = describeError(err, t, t("systemLogs.config.saveFailed"));
    toast.error(saveError.value.message);
  } finally {
    saving.value = false;
  }
}

function discard() {
  if (original.value) Object.assign(draft, fromConfig(original.value));
  saveError.value = null;
}

async function reset() {
  if (resetting.value) return;
  resetting.value = true;
  saveError.value = null;
  try {
    const cfg = await apiJson<RuntimeLogConfig>("/api/v1/admin/ops/runtime/logging/reset", {
      method: "POST",
      fallbackError: t("systemLogs.config.resetFailed"),
    });
    adopt(cfg);
    toast.success(t("systemLogs.config.resetDone"));
  } catch (err) {
    toast.error(describeError(err, t, t("systemLogs.config.resetFailed")).message);
  } finally {
    resetting.value = false;
  }
}

/* ---------------- Leaving with unsaved edits ---------------- */

onBeforeRouteLeave(() => {
  if (dirtyKeys.value.length && !window.confirm(t("systemLogs.config.leaveConfirm"))) return false;
  return true;
});
function onBeforeUnload(ev: BeforeUnloadEvent) {
  if (!dirtyKeys.value.length) return;
  ev.preventDefault();
  ev.returnValue = "";
}

const root = ref<HTMLElement | null>(null);
/** Ctrl/⌘ + S saves, like the other settings pages (only while this tab is on screen). */
function onKeydown(ev: KeyboardEvent) {
  if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "s") return;
  if (!root.value || root.value.offsetParent === null || !dirtyKeys.value.length) return;
  ev.preventDefault();
  void save();
}

onMounted(() => {
  void load();
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
  document.removeEventListener("keydown", onKeydown);
});

/* ---------------- Display ---------------- */

const levelOptions = computed(() => SYSTEM_LOG_LEVELS.map((value) => ({ value, label: value })));
const stackOptions = computed(() =>
  RUNTIME_LOG_STACKTRACE_LEVELS.map((value) => ({ value, label: t(`systemLogs.config.stacktrace.${value}`) })),
);
const samplingExample = computed(() =>
  intIn(draft.samplingInitial, 1, 100_000) && intIn(draft.samplingThereafter, 1, 100_000)
    ? t("systemLogs.config.sampling.example", {
        first: formatNumber(Number(draft.samplingInitial)),
        every: formatNumber(Number(draft.samplingThereafter)),
      })
    : "",
);
const retentionShrinks = computed(
  () => !!original.value && intIn(draft.retentionDays, 1, 3650) && Number(draft.retentionDays) < original.value.retentionDays,
);

const enter = "animate-slide-up [animation-fill-mode:both] motion-reduce:animate-none";
const delay = (i: number) => ({ animationDelay: `${i * 50}ms` });
const errorRing = "!border-danger focus:!ring-danger/20";
</script>

<template>
  <div ref="root" class="space-y-6">
    <UiAlert v-if="loadError && !original" tone="warning" :title="t('systemLogs.config.loadFailed')">
      {{ loadError.message }}
      <SystemLogErrorMeta :error="loadError" />
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs shrink-0" :disabled="loading" @click="load">
          {{ t("systemLogs.retry") }}
        </button>
      </template>
    </UiAlert>

    <div v-if="!original && loading" class="space-y-6" aria-busy="true" role="status">
      <div class="card h-16 bg-surface-2/40 motion-safe:animate-pulse" />
      <div class="grid gap-6 xl:grid-cols-2">
        <div v-for="i in 3" :key="i" class="card h-56 bg-surface-2/40 motion-safe:animate-pulse" />
      </div>
      <span class="sr-only">{{ t("common.loading") }}</span>
    </div>

    <template v-else-if="original">
      <!-- Status -->
      <div class="card flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5" :class="enter" :style="delay(0)">
        <span class="icon-chip h-8 w-8" :class="original.source === 'runtime_setting' ? 'icon-chip-accent' : ''">
          <UiIcon name="sliders" :size="15" />
        </span>
        <div class="min-w-[12rem] flex-1">
          <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
            {{ t("systemLogs.config.sourceLabel") }}
            <UiBadge :tone="original.source === 'runtime_setting' ? 'accent' : 'neutral'" dot>
              {{ t(`systemLogs.config.source.${original.source}`) }}
            </UiBadge>
          </p>
          <p class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-subtle">
            <template v-if="original.updatedAtIso">
              <span :title="formatDateTime(original.updatedAtIso)">
                {{ t("systemLogs.config.updatedAt", { time: formatRelative(original.updatedAtIso) }) }}
              </span>
              <template v-if="original.updatedBy">
                <span>·</span>
                <span>{{ t("systemLogs.config.updatedBy") }}</span>
                <span class="max-w-[10rem] truncate font-mono" :title="original.updatedBy">{{ original.updatedBy }}</span>
                <CopyButton :text="original.updatedBy" class="!h-5 !w-5" />
              </template>
            </template>
            <span v-else>{{ t("systemLogs.config.baselineHint") }}</span>
          </p>
          <p v-if="loadError" class="mt-1 flex items-center gap-1.5 text-xs text-warning" role="status">
            <UiIcon name="alert" :size="12" class="shrink-0" />
            {{ t("systemLogs.config.refreshFailed") }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            class="btn btn-ghost btn-icon btn-sm"
            :disabled="loading || saving"
            :title="t('common.refresh')"
            :aria-label="t('common.refresh')"
            @click="reload"
          >
            <UiIcon name="refresh" :size="14" :spin="loading" />
          </button>
          <ConfirmButton
            size="sm"
            icon="rotate-ccw"
            :label="resetting ? t('systemLogs.config.resetting') : t('systemLogs.config.reset')"
            :confirm-label="t('systemLogs.config.resetConfirm')"
            :disabled="resetting || saving || original.source === 'baseline'"
            @confirm="reset"
          />
        </div>
      </div>

      <UiAlert tone="info">{{ t("systemLogs.config.applyHint") }}</UiAlert>

      <div class="grid items-start gap-6 xl:grid-cols-2">
        <!-- Level & detail -->
        <UiCard icon="terminal" :title="t('systemLogs.config.output.title')" :class="enter" :style="delay(1)">
          <div class="space-y-5">
            <SettingField
              :label="t('systemLogs.config.output.level')"
              :hint="t('systemLogs.config.output.levelHint')"
              :dirty="isDirty('level')"
            >
              <SegmentedControl
                v-model="draft.level"
                :options="levelOptions"
                size="md"
                block
                :aria-label="t('systemLogs.config.output.level')"
              />
            </SettingField>
            <SettingField
              :label="t('systemLogs.config.output.stacktrace')"
              :hint="t('systemLogs.config.output.stacktraceHint')"
              :dirty="isDirty('stacktraceLevel')"
            >
              <SegmentedControl
                v-model="draft.stacktraceLevel"
                :options="stackOptions"
                size="md"
                block
                :aria-label="t('systemLogs.config.output.stacktrace')"
              />
            </SettingField>
          </div>
          <div class="mt-5 border-t border-line/70 pt-4">
            <SettingSwitchRow
              v-model="draft.caller"
              icon="branch"
              tone="info"
              :title="t('systemLogs.config.output.caller')"
              :description="t('systemLogs.config.output.callerHint')"
              :dirty="isDirty('caller')"
            />
          </div>
        </UiCard>

        <!-- Storage & retention -->
        <UiCard icon="database" :title="t('systemLogs.config.storage.title')" :class="enter" :style="delay(2)">
          <SettingSwitchRow
            v-model="draft.persistAccessLogs"
            icon="activity"
            tone="warning"
            :title="t('systemLogs.config.storage.access')"
            :description="t('systemLogs.config.storage.accessHint')"
            :dirty="isDirty('persistAccessLogs')"
          >
            <Transition
              enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
              leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
              enter-from-class="-translate-y-1 opacity-0"
              leave-to-class="-translate-y-1 opacity-0"
            >
              <p v-if="draft.persistAccessLogs" class="mt-2 flex items-start gap-1.5 text-xs text-warning">
                <UiIcon name="alert" :size="12" class="mt-0.5 shrink-0" />
                {{ t("systemLogs.config.storage.accessWarning") }}
              </p>
            </Transition>
          </SettingSwitchRow>
          <p class="mt-3 flex items-start gap-1.5 rounded-lg bg-surface-2/60 px-3 py-2 text-xs text-fg-muted">
            <UiIcon name="shield" :size="13" class="mt-0.5 shrink-0 text-fg-subtle" />
            {{ t("systemLogs.config.storage.alwaysKept") }}
          </p>
          <div class="mt-4 border-t border-line/70 pt-4">
            <SettingField
              input-id="syslog-retention"
              :label="t('systemLogs.config.storage.retention')"
              :hint="t('systemLogs.config.storage.retentionHint')"
              :error="errors.retentionDays"
              :dirty="isDirty('retentionDays')"
            >
              <LogRetentionSelect id="syslog-retention" v-model="draft.retentionDays" :invalid="!!errors.retentionDays" />
            </SettingField>
            <Transition
              enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
              enter-from-class="-translate-y-1 opacity-0"
            >
              <p v-if="retentionShrinks" class="mt-2 flex items-start gap-1.5 text-xs text-warning">
                <UiIcon name="alert" :size="12" class="mt-0.5 shrink-0" />
                {{ t("systemLogs.config.storage.retentionShrinks", { days: original.retentionDays }) }}
              </p>
            </Transition>
          </div>
        </UiCard>

        <!-- Sampling -->
        <UiCard icon="filter" :title="t('systemLogs.config.sampling.title')" class="xl:col-span-2" :class="enter" :style="delay(3)">
          <SettingSwitchRow
            v-model="draft.enableSampling"
            icon="filter"
            tone="violet"
            :title="t('systemLogs.config.sampling.enabled')"
            :description="t('systemLogs.config.sampling.enabledHint')"
            :dirty="isDirty('enableSampling')"
          />
          <div class="mt-4 grid gap-4 border-t border-line/70 pt-4 transition-opacity duration-200 sm:grid-cols-2" :class="draft.enableSampling ? '' : 'opacity-60'">
            <SettingField
              input-id="syslog-sampling-initial"
              :label="t('systemLogs.config.sampling.initial')"
              :hint="t('systemLogs.config.sampling.initialHint')"
              :error="errors.samplingInitial"
              :dirty="isDirty('samplingInitial')"
            >
              <input
                id="syslog-sampling-initial"
                v-model.number="draft.samplingInitial"
                type="number"
                inputmode="numeric"
                min="1"
                max="100000"
                step="1"
                class="input tabular-nums"
                :class="errors.samplingInitial ? errorRing : ''"
                :aria-invalid="!!errors.samplingInitial"
              />
            </SettingField>
            <SettingField
              input-id="syslog-sampling-thereafter"
              :label="t('systemLogs.config.sampling.thereafter')"
              :hint="t('systemLogs.config.sampling.thereafterHint')"
              :error="errors.samplingThereafter"
              :dirty="isDirty('samplingThereafter')"
            >
              <input
                id="syslog-sampling-thereafter"
                v-model.number="draft.samplingThereafter"
                type="number"
                inputmode="numeric"
                min="1"
                max="100000"
                step="1"
                class="input tabular-nums"
                :class="errors.samplingThereafter ? errorRing : ''"
                :aria-invalid="!!errors.samplingThereafter"
              />
            </SettingField>
            <p v-if="samplingExample" class="flex items-center gap-2 rounded-lg bg-accent/[0.06] px-3 py-2 text-xs text-fg-muted sm:col-span-2">
              <UiIcon name="zap" :size="13" class="shrink-0 text-accent" />
              {{ draft.enableSampling ? samplingExample : t("systemLogs.config.sampling.off") }}
            </p>
          </div>
        </UiCard>
      </div>

      <div v-if="saveError && (saveError.requestId || saveError.detail)" class="flex items-start gap-1.5 text-xs text-fg-muted" role="alert">
        <UiIcon name="alert" :size="12" class="mt-0.5 shrink-0 text-danger" />
        <div class="min-w-0">
          <p>{{ saveError.message }}</p>
          <SystemLogErrorMeta :error="saveError" />
        </div>
      </div>

      <SettingsSaveBar
        :show="dirtyKeys.length > 0"
        :count="dirtyKeys.length"
        :saving="saving"
        :invalid="invalid"
        @save="save"
        @discard="discard"
      />
    </template>
  </div>
</template>
