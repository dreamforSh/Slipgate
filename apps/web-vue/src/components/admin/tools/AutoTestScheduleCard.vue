<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ACCOUNT_TEST_MODELS, type GroupItem } from "@slipgate/contracts";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import {
  CONCURRENCY_MAX,
  INTERVAL_PRESETS,
  formatInterval,
  type AutoTestConfig,
  type AutoTestResponse,
  type AutoTestStatus,
} from "./toolsTypes";
import UiSelect from "../../ui/UiSelect.vue";

/**
 * Scheduled account tests: settings form, last/next run and "run now" (polls every 2s while a
 * run is in progress, so a run started by the scheduler shows up live too).
 */
const props = defineProps<{ now: number }>();
const emit = defineEmits<{
  /** Saved settings (on load and after every save). */
  (e: "config", config: AutoTestConfig): void;
  /** A poll saw the run still going: account results may have changed. */
  (e: "progress"): void;
  /** The run that was being watched has finished. */
  (e: "finished", status: AutoTestStatus): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

const PATH = "/api/v1/admin/account-autotest";
const POLL_MS = 2000;

const saved = ref<AutoTestConfig | null>(null);
const status = ref<AutoTestStatus | null>(null);
const draft = reactive<AutoTestConfig>({ enabled: false, intervalMinutes: 60, concurrency: 2, groupIds: [], model: "" });
const groups = ref<GroupItem[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const saving = ref(false);
const starting = ref(false);

/* ---------------- Loading ---------------- */

function applyDraft(cfg: AutoTestConfig) {
  draft.enabled = cfg.enabled;
  draft.intervalMinutes = cfg.intervalMinutes;
  draft.concurrency = cfg.concurrency;
  draft.groupIds = [...cfg.groupIds];
  draft.model = cfg.model;
}

async function load() {
  loading.value = true;
  try {
    const [res, groupRes] = await Promise.all([
      apiJson<AutoTestResponse>(PATH, { fallbackError: t("adminTools.monitor.errors.loadSchedule") }),
      apiJson<{ groups: GroupItem[] }>("/api/v1/admin/groups").catch(() => {
        toast.error(t("adminTools.monitor.errors.loadGroups"));
        return { groups: [] as GroupItem[] };
      }),
    ]);
    saved.value = res.config;
    status.value = res.status;
    applyDraft(res.config);
    groups.value = [...groupRes.groups].sort(
      (a, b) => Number(b.enabled) - Number(a.enabled) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
    loadError.value = null;
    emit("config", res.config);
    if (res.status.running) schedulePoll();
  } catch (err) {
    loadError.value = errorText(err, t("adminTools.monitor.errors.loadSchedule"));
  } finally {
    loading.value = false;
  }
}

/* ---------------- Form ---------------- */

const intervalOptions = computed(() => {
  const set = new Set<number>(INTERVAL_PRESETS);
  set.add(draft.intervalMinutes);
  return [...set].sort((a, b) => a - b).map((value) => ({ value, label: formatInterval(value) }));
});

const concurrencyOptions = Array.from({ length: CONCURRENCY_MAX }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
const concurrencyValue = computed({
  get: () => String(draft.concurrency),
  set: (v: string) => (draft.concurrency = Number(v)),
});

const groupNames = computed(() => new Map(groups.value.map((g) => [g.id, g.name])));
/** Selected ids whose group no longer exists, shown so they can be removed. */
const orphanGroupIds = computed(() => draft.groupIds.filter((id) => !groupNames.value.has(id)));

function toggleGroup(id: string) {
  draft.groupIds = draft.groupIds.includes(id) ? draft.groupIds.filter((g) => g !== id) : [...draft.groupIds, id];
}

const modelSuggestions = computed(() => [...new Set(Object.values(ACCOUNT_TEST_MODELS).flat())].sort());

const dirty = computed(() => {
  const s = saved.value;
  if (!s) return false;
  const a = [...s.groupIds].sort().join("\u0000");
  const b = [...draft.groupIds].sort().join("\u0000");
  return (
    s.enabled !== draft.enabled ||
    s.intervalMinutes !== draft.intervalMinutes ||
    s.concurrency !== draft.concurrency ||
    s.model !== draft.model.trim() ||
    a !== b
  );
});

function discard() {
  if (saved.value) applyDraft(saved.value);
}

async function save() {
  if (!dirty.value || saving.value) return;
  saving.value = true;
  try {
    const body: AutoTestConfig = {
      enabled: draft.enabled,
      intervalMinutes: draft.intervalMinutes,
      concurrency: draft.concurrency,
      groupIds: [...draft.groupIds],
      model: draft.model.trim(),
    };
    const res = await apiJson<AutoTestResponse>(PATH, {
      method: "PATCH",
      body,
      fallbackError: t("adminTools.monitor.errors.saveSchedule"),
    });
    saved.value = res.config;
    status.value = res.status;
    applyDraft(res.config);
    emit("config", res.config);
    toast.success(t("adminTools.monitor.schedule.saved"));
  } catch (err) {
    toast.error(errorText(err, t("adminTools.monitor.errors.saveSchedule")));
  } finally {
    saving.value = false;
  }
}

/* ---------------- Run now & polling ---------------- */

let pollTimer: number | undefined;
let disposed = false;

function schedulePoll(delay = POLL_MS) {
  window.clearTimeout(pollTimer);
  if (!disposed) pollTimer = window.setTimeout(() => void poll(), delay);
}

async function poll() {
  try {
    const res = await apiJson<AutoTestResponse>(PATH);
    if (disposed) return;
    status.value = res.status;
    if (res.status.running) {
      emit("progress");
      schedulePoll();
    } else {
      finish(res.status);
    }
  } catch {
    // Transient failure: keep watching, a little slower.
    schedulePoll(POLL_MS * 2);
  }
}

function finish(s: AutoTestStatus) {
  emit("finished", s);
  if (s.lastError) toast.error(`${t("adminTools.monitor.schedule.status.lastError")}: ${s.lastError}`);
  else toast.success(t("adminTools.monitor.schedule.runDone", { tested: s.lastRunTested, failed: s.lastRunFailed }));
}

const running = computed(() => status.value?.running === true);

async function runNow() {
  if (running.value || starting.value) return;
  starting.value = true;
  const before = status.value?.lastRunAtIso ?? null;
  try {
    const res = await apiJson<{ status: AutoTestStatus }>(`${PATH}/run`, {
      method: "POST",
      fallbackError: t("adminTools.monitor.errors.run"),
    });
    status.value = res.status;
    if (res.status.running) {
      toast.info(t("adminTools.monitor.schedule.runStarted"));
      schedulePoll();
    } else if (res.status.lastRunAtIso !== before) {
      // Nothing to test: the run finished before the answer.
      finish(res.status);
    } else {
      toast.warning(t("adminTools.monitor.schedule.runNotStarted"));
    }
  } catch (err) {
    toast.error(errorText(err, t("adminTools.monitor.errors.run")));
  } finally {
    starting.value = false;
  }
}

onMounted(() => void load());
onBeforeUnmount(() => {
  disposed = true;
  window.clearTimeout(pollTimer);
});
</script>

<template>
  <UiCard icon="clock" :title="t('adminTools.monitor.schedule.title')">
    <template #actions>
      <UiBadge v-if="saved" :tone="saved.enabled ? 'success' : 'neutral'" dot :pulse="saved.enabled && running">
        {{ saved.enabled ? formatInterval(saved.intervalMinutes) : t("adminTools.monitor.schedule.status.off") }}
      </UiBadge>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="!saved || running || starting"
        :title="dirty ? t('adminTools.monitor.schedule.runUsesSaved') : undefined"
        @click="runNow"
      >
        <UiIcon :name="running || starting ? 'loader' : 'play'" :size="14" :spin="running || starting" />
        {{ running ? t("adminTools.monitor.schedule.running") : t("adminTools.monitor.schedule.runNow") }}
      </button>
    </template>

    <UiAlert v-if="loadError" tone="danger">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs shrink-0" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="13" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </UiAlert>

    <!-- First load -->
    <div v-else-if="!saved" class="space-y-4 motion-safe:animate-pulse" aria-busy="true" role="status">
      <span class="block h-12 rounded-lg bg-surface-2" />
      <div class="grid gap-4 md:grid-cols-2">
        <span class="block h-9 rounded-lg bg-surface-2/70" />
        <span class="block h-9 rounded-lg bg-surface-2/70" />
      </div>
      <span class="sr-only">{{ t("common.loading") }}</span>
    </div>

    <div v-else class="space-y-5">
      <!-- Status strip -->
      <div class="relative overflow-hidden rounded-xl border border-line bg-surface-2/40">
        <span
          v-if="running"
          class="absolute inset-x-0 top-0 h-0.5 bg-accent/70 motion-safe:animate-pulse"
          aria-hidden="true"
        />
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-4">
          <div class="min-w-0">
            <dt class="text-2xs text-fg-subtle">{{ t("adminTools.monitor.schedule.status.lastRun") }}</dt>
            <dd class="mt-0.5 truncate text-sm font-medium text-fg">
              <span v-if="running" class="inline-flex items-center gap-1.5 text-accent">
                <UiIcon name="loader" :size="13" spin />
                {{ t("adminTools.monitor.schedule.running") }}
              </span>
              <span v-else-if="status?.lastRunAtIso" :title="formatDateTime(status.lastRunAtIso)">
                {{ formatRelative(status.lastRunAtIso, props.now) }}
              </span>
              <span v-else class="text-fg-subtle">{{ t("adminTools.monitor.schedule.status.never") }}</span>
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-2xs text-fg-subtle">{{ t("adminTools.monitor.schedule.status.tested") }}</dt>
            <dd class="mt-0.5 font-mono text-sm font-medium tabular-nums text-fg">{{ status?.lastRunTested ?? 0 }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-2xs text-fg-subtle">{{ t("adminTools.monitor.schedule.status.failed") }}</dt>
            <dd
              class="mt-0.5 font-mono text-sm font-medium tabular-nums"
              :class="status?.lastRunFailed ? 'text-danger' : 'text-fg'"
            >
              {{ status?.lastRunFailed ?? 0 }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-2xs text-fg-subtle">{{ t("adminTools.monitor.schedule.status.nextRun") }}</dt>
            <dd class="mt-0.5 truncate text-sm font-medium text-fg">
              <span v-if="saved.enabled && status?.nextRunAtIso" :title="formatDateTime(status.nextRunAtIso)">
                {{ formatRelative(status.nextRunAtIso, props.now) }}
              </span>
              <span v-else class="text-fg-subtle">{{ t("adminTools.monitor.schedule.status.off") }}</span>
            </dd>
          </div>
        </dl>
      </div>
      <UiAlert v-if="status?.lastError && !running" tone="danger" :title="t('adminTools.monitor.schedule.status.lastError')">
        <span class="font-mono text-xs">{{ status.lastError }}</span>
      </UiAlert>

      <p class="text-xs leading-relaxed text-fg-muted">{{ t("adminTools.monitor.schedule.intro") }}</p>

      <!-- Settings -->
      <form class="grid gap-x-6 gap-y-5 md:grid-cols-2" @submit.prevent="save">
        <div
          class="flex items-center justify-between gap-4 rounded-lg border px-4 py-3 transition-colors duration-200 md:col-span-2"
          :class="draft.enabled ? 'border-success/30 bg-success/[0.05]' : 'border-line bg-surface-2/30'"
        >
          <div class="min-w-0">
            <p class="text-sm font-medium text-fg">{{ t("adminTools.monitor.schedule.enabled") }}</p>
            <p class="mt-0.5 text-xs text-fg-subtle">
              {{ draft.enabled ? formatInterval(draft.intervalMinutes) : t("adminTools.monitor.schedule.status.off") }}
            </p>
          </div>
          <UiSwitch v-model="draft.enabled" :label="t('adminTools.monitor.schedule.enabled')" hide-label :disabled="saving" />
        </div>

        <label class="block min-w-0">
          <span class="label">{{ t("adminTools.monitor.schedule.interval") }}</span>
          <UiSelect v-model.number="draft.intervalMinutes" class="select" :disabled="saving">
            <option v-for="opt in intervalOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </UiSelect>
        </label>

        <div class="min-w-0">
          <span class="label">{{ t("adminTools.monitor.schedule.concurrency") }}</span>
          <SegmentedControl v-model="concurrencyValue" :options="concurrencyOptions" size="md" block />
          <p class="hint">{{ t("adminTools.monitor.schedule.concurrencyHint") }}</p>
        </div>

        <div class="min-w-0 md:col-span-2">
          <div class="mb-1.5 flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-fg-muted">{{ t("adminTools.monitor.schedule.groups") }}</span>
            <span class="text-2xs text-fg-subtle">
              {{
                draft.groupIds.length
                  ? t("adminTools.monitor.schedule.groupsSelected", { n: draft.groupIds.length })
                  : t("adminTools.monitor.schedule.groupsHint")
              }}
            </span>
          </div>
          <div class="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto" role="group" :aria-label="t('adminTools.monitor.schedule.groups')">
            <button
              type="button"
              class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs ring-1 ring-inset transition-colors duration-150"
              :class="
                draft.groupIds.length === 0
                  ? 'bg-accent/10 font-medium text-accent ring-accent/30'
                  : 'text-fg-muted ring-line hover:bg-surface-2 hover:text-fg'
              "
              :aria-pressed="draft.groupIds.length === 0"
              :disabled="saving"
              @click="draft.groupIds = []"
            >
              <UiIcon v-if="draft.groupIds.length === 0" name="check" :size="12" />
              {{ t("adminTools.monitor.schedule.groupsAll") }}
            </button>
            <button
              v-for="g in groups"
              :key="g.id"
              type="button"
              class="inline-flex h-7 max-w-full cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs ring-1 ring-inset transition-colors duration-150"
              :class="[
                draft.groupIds.includes(g.id)
                  ? 'bg-accent/10 font-medium text-accent ring-accent/30'
                  : 'text-fg-muted ring-line hover:bg-surface-2 hover:text-fg',
                g.enabled ? '' : 'opacity-60',
              ]"
              :aria-pressed="draft.groupIds.includes(g.id)"
              :disabled="saving"
              @click="toggleGroup(g.id)"
            >
              <UiIcon v-if="draft.groupIds.includes(g.id)" name="check" :size="12" />
              <span class="truncate">{{ g.name }}</span>
            </button>
            <button
              v-for="id in orphanGroupIds"
              :key="id"
              type="button"
              class="inline-flex h-7 max-w-full cursor-pointer items-center gap-1 rounded-full bg-warning/10 px-2.5 font-mono text-2xs text-warning ring-1 ring-inset ring-warning/30"
              :aria-pressed="true"
              :disabled="saving"
              @click="toggleGroup(id)"
            >
              <span class="truncate">{{ id }}</span>
              <UiIcon name="x" :size="11" />
            </button>
            <span v-if="groups.length === 0" class="inline-flex h-7 items-center text-xs text-fg-subtle">
              {{ t("adminTools.monitor.schedule.groupsEmpty") }}
            </span>
          </div>
        </div>

        <label class="block min-w-0 md:col-span-2">
          <span class="label">
            {{ t("adminTools.monitor.schedule.model") }}
            <span class="font-normal text-fg-subtle">· {{ t("common.optional") }}</span>
          </span>
          <input
            v-model="draft.model"
            type="text"
            class="input font-mono text-xs"
            list="autotest-model-suggestions"
            maxlength="128"
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('adminTools.monitor.schedule.modelPlaceholder')"
            :disabled="saving"
          />
          <datalist id="autotest-model-suggestions">
            <option v-for="m in modelSuggestions" :key="m" :value="m" />
          </datalist>
          <p class="hint">{{ t("adminTools.monitor.schedule.modelHint") }}</p>
        </label>

        <div class="flex flex-wrap items-center justify-end gap-2 md:col-span-2">
          <Transition
            enter-active-class="transition duration-150 ease-out"
            enter-from-class="opacity-0"
            leave-active-class="transition duration-100 ease-in"
            leave-to-class="opacity-0"
          >
            <span v-if="dirty" class="mr-auto inline-flex items-center gap-1.5 text-xs text-warning">
              <span class="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
              {{ t("adminTools.monitor.schedule.dirty") }}
            </span>
          </Transition>
          <button type="button" class="btn btn-ghost" :disabled="!dirty || saving" @click="discard">
            {{ t("adminTools.monitor.schedule.discard") }}
          </button>
          <button type="submit" class="btn btn-primary" :disabled="!dirty || saving">
            <UiIcon :name="saving ? 'loader' : 'check'" :size="15" :spin="saving" />
            {{ saving ? t("common.saving") : t("adminTools.monitor.schedule.save") }}
          </button>
        </div>
      </form>
    </div>
  </UiCard>
</template>
