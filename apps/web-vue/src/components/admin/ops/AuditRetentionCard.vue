<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import {
  AUDIT_LOG_RETENTION_MAX_DAYS,
  auditRetentionShortens,
  type AuditRetentionRunResponse,
  type AuditRetentionStatus,
  type UpdateAuditRetentionRequest,
} from "@slipgate/contracts";
import TotpStepUpModal from "./TotpStepUpModal.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { useNow } from "../../../composables/useNow";
import { ApiError, apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatNumber, formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";

/**
 * Audit-log retention: the period (portal setting `auditLogRetentionDays`, 0 = forever) and this
 * BFF instance's daily sweeper (last / next run), with an on-demand bounded sweep.
 *
 * Anything that removes history sooner (a shorter period, keep-forever included, or sweeping now)
 * asks for a fresh two-factor code, like clearing the log; keeping entries longer saves directly.
 */
const emit = defineEmits<{
  (e: "update:status", status: AuditRetentionStatus): void;
  (e: "swept", deleted: number): void;
}>();

const { t } = useI18n();
const toast = useToastStore();
const now = useNow(60_000);
const uid = useId();

/** While a sweep runs (scheduled or another admin's), the status is re-read this often. */
const RUNNING_POLL_MS = 3_000;

const status = ref<AuditRetentionStatus | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const daysText = ref("");
const saving = ref(false);
const running = ref(false);

const PRESETS = [30, 90, 180, 365, 0] as const;
const presetLabel: Record<(typeof PRESETS)[number], string> = {
  30: "d30",
  90: "d90",
  180: "d180",
  365: "d365",
  0: "forever",
};

let pollTimer: number | undefined;
let unmounted = false;

function schedulePoll() {
  window.clearTimeout(pollTimer);
  pollTimer = undefined;
  if (!unmounted && status.value?.running) pollTimer = window.setTimeout(() => void load(), RUNNING_POLL_MS);
}

function apply(next: AuditRetentionStatus, syncInput = true) {
  status.value = next;
  if (syncInput) daysText.value = String(next.retentionDays);
  emit("update:status", next);
  schedulePoll();
}

async function load() {
  loading.value = true;
  try {
    apply(await apiJson<AuditRetentionStatus>("/api/v1/admin/audit-logs/retention", { fallbackError: t("audit.retention.errors.load") }), !dirty.value);
    loadError.value = null;
  } catch (err) {
    loadError.value = errorText(err, t("audit.retention.errors.load"));
    // A sweep still showing as running is checked again later.
    schedulePoll();
  } finally {
    loading.value = false;
  }
}

/* ---------------- Period ---------------- */

/** Whole days in range, or null (an empty field included). */
const parsedDays = computed<number | null>(() => {
  const v = daysText.value.trim();
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n <= AUDIT_LOG_RETENTION_MAX_DAYS ? n : null;
});
const dirty = computed(() => status.value !== null && parsedDays.value !== status.value.retentionDays);
const invalid = computed(() => parsedDays.value === null);
/** The typed period keeps fewer entries than the saved one: saving asks for a code. */
const shortens = computed(
  () => status.value !== null && parsedDays.value !== null && auditRetentionShortens(status.value.retentionDays, parsedDays.value),
);

function daysLabel(n: number): string {
  return n === 0 ? t("audit.retention.forever") : t("audit.retention.keepDays", { n: formatNumber(n) }, n);
}

function pickPreset(n: number) {
  if (saving.value) return;
  daysText.value = String(n);
}

async function putDays(days: number, totpCode?: string) {
  const body: UpdateAuditRetentionRequest = totpCode ? { retentionDays: days, totpCode } : { retentionDays: days };
  apply(
    await apiJson<AuditRetentionStatus>("/api/v1/admin/audit-logs/retention", {
      method: "PUT",
      body,
      fallbackError: t("audit.retention.errors.save"),
    }),
  );
  toast.success(days === 0 ? t("audit.retention.savedForever") : t("audit.retention.saved", { n: formatNumber(days) }, days));
}

/* ---------------- Two-factor confirmation ---------------- */

type StepUp = "lower" | "run";
const stepUpOpen = ref(false);
/** Kept after closing so the modal's text does not change while it fades out. */
const stepUpMode = ref<StepUp>("lower");
const pendingDays = ref(0);
/** The saved period when the confirmation opened (the status updates before the modal fades out). */
const pendingFrom = ref(0);

function askCode(mode: StepUp) {
  stepUpMode.value = mode;
  pendingFrom.value = status.value?.retentionDays ?? 0;
  stepUpOpen.value = true;
}

async function save() {
  const days = parsedDays.value;
  if (days === null || !dirty.value || saving.value || !status.value) return;
  if (shortens.value) {
    pendingDays.value = days;
    askCode("lower");
    return;
  }
  saving.value = true;
  try {
    await putDays(days);
  } catch (err) {
    if (err instanceof ApiError && (err.code === "totp_required" || err.code === "totp_not_enabled")) {
      // The saved period changed meanwhile and this now shortens it.
      pendingDays.value = days;
      askCode("lower");
      void load();
    } else {
      toast.error(
        err instanceof ApiError && err.status === 400
          ? t("audit.retention.range", { max: AUDIT_LOG_RETENTION_MAX_DAYS })
          : errorText(err, t("audit.retention.errors.save")),
      );
    }
  } finally {
    saving.value = false;
  }
}

async function confirmLower(totpCode: string) {
  saving.value = true;
  try {
    await putDays(pendingDays.value, totpCode);
  } finally {
    saving.value = false;
  }
}

function revert() {
  if (status.value) daysText.value = String(status.value.retentionDays);
}

/* ---------------- Sweep now ---------------- */

async function confirmRun(totpCode: string) {
  running.value = true;
  try {
    const res = await apiJson<AuditRetentionRunResponse>("/api/v1/admin/audit-logs/retention/run", {
      method: "POST",
      body: { totpCode },
      fallbackError: t("audit.retention.errors.run"),
    });
    const { run, ...next } = res;
    apply(next, !dirty.value);
    if (next.lastError) toast.error(t("audit.retention.runFailed", { error: next.lastError }));
    else if (run.skipped) toast.info(t("audit.retention.runSkipped"));
    else if (run.deleted > 0) toast.success(t("audit.retention.runDone", { n: formatNumber(run.deleted) }, run.deleted));
    else toast.info(t("audit.retention.runNothing"));
    if (run.deleted > 0) emit("swept", run.deleted);
  } finally {
    running.value = false;
  }
}

const savedDays = computed(() => status.value?.retentionDays ?? 0);

const stepUpAction = computed(() => (stepUpMode.value === "run" ? confirmRun : confirmLower));

defineExpose({ reload: load });
onMounted(() => void load());
onBeforeUnmount(() => {
  unmounted = true;
  window.clearTimeout(pollTimer);
});
</script>

<template>
  <UiCard icon="clock" :title="t('audit.retention.title')">
    <template #actions>
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0 scale-95"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <UiBadge v-if="status" :key="status.retentionDays" :tone="status.retentionDays > 0 ? 'success' : 'neutral'" dot>
          {{ daysLabel(status.retentionDays) }}
        </UiBadge>
      </Transition>
    </template>

    <!-- First load -->
    <div v-if="!status && !loadError" class="grid gap-5 md:grid-cols-2" aria-busy="true" role="status">
      <div class="space-y-3">
        <span class="block h-2.5 w-3/4 rounded-full bg-surface-2 motion-safe:animate-pulse" />
        <span class="block h-9 w-48 rounded-lg bg-surface-2 motion-safe:animate-pulse" />
        <span class="block h-6 w-64 max-w-full rounded-full bg-surface-2/70 motion-safe:animate-pulse" />
      </div>
      <div class="space-y-3">
        <span class="block h-2.5 w-1/2 rounded-full bg-surface-2 motion-safe:animate-pulse" />
        <span class="block h-2.5 w-2/3 rounded-full bg-surface-2/70 motion-safe:animate-pulse" />
      </div>
      <span class="sr-only">{{ t("common.loading") }}</span>
    </div>

    <!-- Load failed -->
    <UiAlert v-else-if="!status && loadError" tone="danger" :title="t('audit.retention.errors.load')">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs self-center" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="12" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </UiAlert>

    <div v-else-if="status" class="grid gap-6 md:grid-cols-2">
      <!-- Period -->
      <form class="min-w-0" novalidate @submit.prevent="save">
        <p class="text-xs leading-relaxed text-fg-subtle">{{ t("audit.retention.desc") }}</p>
        <div class="mt-3 flex flex-wrap items-end gap-2">
          <div class="min-w-0">
            <label :for="`${uid}-days`" class="label">{{ t("audit.retention.days") }}</label>
            <span class="relative block w-36">
              <input
                :id="`${uid}-days`"
                v-model="daysText"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                maxlength="4"
                class="input pr-10 tabular-nums"
                :class="invalid ? '!border-danger' : ''"
                :disabled="saving"
                :aria-invalid="invalid || undefined"
                :aria-describedby="`${uid}-days-hint`"
              />
              <span class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-subtle" aria-hidden="true">
                {{ t("audit.retention.daysUnit") }}
              </span>
            </span>
          </div>
          <button type="submit" class="btn btn-primary" :disabled="!dirty || invalid || saving">
            <UiIcon v-if="saving" name="loader" :size="14" spin />
            <UiIcon v-else-if="shortens" name="shield" :size="14" />
            {{ saving ? t("common.saving") : t("audit.retention.save") }}
          </button>
          <Transition
            enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
            enter-from-class="opacity-0 -translate-x-1"
            leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
            leave-to-class="opacity-0"
          >
            <button v-if="dirty && !saving" type="button" class="btn btn-ghost" @click="revert">
              {{ t("common.cancel") }}
            </button>
          </Transition>
        </div>
        <p
          :id="`${uid}-days-hint`"
          class="mt-1.5 flex items-start gap-1.5 text-xs"
          :class="invalid ? 'text-danger' : shortens ? 'text-warning' : 'text-fg-subtle'"
          :role="invalid ? 'alert' : undefined"
          aria-live="polite"
        >
          <UiIcon v-if="shortens && !invalid" name="shield" :size="12" class="mt-px shrink-0" />
          <span>
            {{
              invalid
                ? t("audit.retention.range", { max: AUDIT_LOG_RETENTION_MAX_DAYS })
                : shortens
                  ? t("audit.retention.shortenHint")
                  : t("audit.retention.foreverHint")
            }}
          </span>
        </p>

        <div class="mt-3 flex flex-wrap gap-1.5" role="group" :aria-label="t('audit.retention.presets.label')">
          <button
            v-for="p in PRESETS"
            :key="p"
            type="button"
            class="inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium transition-[color,background-color,border-color] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
            :class="
              parsedDays === p
                ? 'border-accent/30 bg-accent/10 text-accent'
                : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg dark:bg-surface-2/60'
            "
            :aria-pressed="parsedDays === p"
            :disabled="saving"
            @click="pickPreset(p)"
          >
            {{ t(`audit.retention.presets.${presetLabel[p]}`) }}
          </button>
        </div>
      </form>

      <!-- This instance's sweeper -->
      <div class="min-w-0 rounded-xl border border-line bg-surface-2/40 p-4 md:self-start">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("audit.retention.lastRun") }}</dt>
            <dd class="mt-0.5 truncate font-medium text-fg" aria-live="polite">
              <template v-if="status.running">
                <span class="inline-flex items-center gap-1 text-accent">
                  <UiIcon name="loader" :size="12" spin />
                  {{ t("audit.retention.running") }}
                </span>
              </template>
              <span v-else-if="status.lastRunAtIso" :title="formatDateTime(status.lastRunAtIso)">
                {{ formatRelative(status.lastRunAtIso, now) }}
              </span>
              <span v-else class="text-fg-muted">{{ t("audit.retention.never") }}</span>
            </dd>
            <dd v-if="status.lastRunAtIso && !status.running" class="mt-0.5 text-2xs tabular-nums text-fg-subtle">
              {{ t("audit.retention.lastDeleted", { n: formatNumber(status.lastDeleted) }, status.lastDeleted) }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("audit.retention.nextRun") }}</dt>
            <dd class="mt-0.5 font-medium text-fg">
              <span v-if="savedDays === 0" class="text-fg-muted">{{ t("audit.retention.forever") }}</span>
              <span v-else-if="status.nextRunAtIso" :title="formatDateTime(status.nextRunAtIso)">
                {{ formatRelative(status.nextRunAtIso, now) }}
              </span>
              <span v-else class="text-fg-muted">{{ t("audit.retention.off") }}</span>
            </dd>
          </div>
        </dl>

        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          enter-from-class="opacity-0 -translate-y-1"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          leave-to-class="opacity-0"
        >
          <UiAlert v-if="status.lastError" tone="warning" :title="t('audit.retention.lastError')" class="mt-3">
            <span class="break-all font-mono text-2xs">{{ status.lastError }}</span>
          </UiAlert>
        </Transition>

        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-3">
          <p class="min-w-0 flex-1 text-2xs text-fg-subtle">{{ t("audit.retention.instanceNote") }}</p>
          <button
            type="button"
            class="btn btn-danger btn-sm"
            :title="savedDays === 0 ? t('audit.retention.runForeverHint') : undefined"
            :disabled="running || savedDays === 0 || status.running"
            @click="askCode('run')"
          >
            <UiIcon :name="running ? 'loader' : 'trash'" :size="13" :spin="running" />
            {{ running ? t("audit.retention.running") : t("audit.retention.runNow") }}
          </button>
        </div>
      </div>
    </div>

    <TotpStepUpModal
      v-model:open="stepUpOpen"
      :title="stepUpMode === 'run' ? t('audit.retention.runModal.title') : t('audit.retention.lowerModal.title')"
      :icon="stepUpMode === 'run' ? 'trash' : 'clock'"
      :submit-label="stepUpMode === 'run' ? t('audit.retention.runModal.submit') : t('audit.retention.lowerModal.submit')"
      :pending-label="stepUpMode === 'run' ? t('audit.retention.running') : t('common.saving')"
      :fallback-error="stepUpMode === 'run' ? t('audit.retention.errors.run') : t('audit.retention.errors.save')"
      :action="stepUpAction"
    >
      <UiAlert v-if="stepUpMode === 'run'" tone="danger">
        {{ t("audit.retention.runModal.warning", { n: formatNumber(savedDays) }, savedDays) }}
      </UiAlert>
      <UiAlert v-else tone="warning">
        {{ t("audit.retention.lowerModal.warning", { from: daysLabel(pendingFrom), to: daysLabel(pendingDays) }) }}
      </UiAlert>
    </TotpStepUpModal>
  </UiCard>
</template>
