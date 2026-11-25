<script setup lang="ts">
import { computed, ref } from "vue";
import type { SystemUpdateStatus } from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { useNow } from "../../../composables/useNow";
import CopyButton from "../../ui/CopyButton.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { formatBytes, formatDateTime, formatDurationMs, formatRelative, shortHash } from "../../../lib/format";

const props = defineProps<{
  status: SystemUpdateStatus | null;
  checking: boolean;
  applying: boolean;
  rollingBack: boolean;
  restarting?: boolean;
  restartStage?: "scheduled" | "draining" | "stopping" | "starting" | null;
  /** When the console started following the current restart (epoch ms). */
  restartStartedAt?: number | null;
  stepUpRequired?: boolean;
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "check"): void;
  (e: "apply"): void;
  (e: "rollback"): void;
  (e: "restart"): void;
  (e: "dismiss-error"): void;
}>();

const { t } = useI18n();
// Drives the drain countdown, the restart's elapsed time and relative timestamps.
const now = useNow(1000);

const PIPELINE_STEPS = ["checking", "downloading", "applying", "reloading_planes", "done"] as const;

const activeStepIndex = computed(() => {
  const s = props.status?.state;
  if (!s || s === "idle" || s === "error" || s === "failed") return -1;
  if (s === "rolling_back") return 2;
  const idx = PIPELINE_STEPS.indexOf(s as (typeof PIPELINE_STEPS)[number]);
  return idx >= 0 ? idx : 0;
});

const showRestartBanner = computed(
  () => Boolean(props.restarting) || Boolean(props.status?.restartScheduled) || props.status?.state === "restarting",
);

// Once a restart is under way its own banner takes over from the update pipeline.
const showPipeline = computed(
  () =>
    !showRestartBanner.value &&
    (props.busy || (props.status?.progress !== null && props.status?.progress !== undefined)),
);

const progressPercent = computed(() => Math.round(props.status?.progress?.percent ?? 0));

const progressLabel = computed(() => {
  const p = props.status?.progress;
  if (!p) return "";
  return t("updates.hero.progressLabel", {
    percent: progressPercent.value,
    downloaded: formatBytes(p.downloadedBytes),
    total: p.totalBytes > 0 ? formatBytes(p.totalBytes) : "—",
  });
});

// Graceful restart, as the console sees it: the old process drains and stops, the new one boots
// and passes its readiness check before serving.
const RESTART_STEPS = ["draining", "stopping", "starting", "done"] as const;

const restartStepIndex = computed(() => {
  const stage = props.restartStage ?? props.status?.restartProgress?.phase ?? "scheduled";
  if (stage === "scheduled") return 0;
  const idx = RESTART_STEPS.indexOf(stage as (typeof RESTART_STEPS)[number]);
  return idx >= 0 ? idx : 0;
});

const drainDetail = computed(() => {
  const prog = props.status?.restartProgress;
  if (!prog || prog.phase !== "draining" || props.restartStage === "starting") return "";
  const deadlineMs = prog.drainDeadlineIso ? Date.parse(prog.drainDeadlineIso) : Number.NaN;
  const seconds = Number.isFinite(deadlineMs) ? Math.max(0, Math.ceil((deadlineMs - now.value) / 1000)) : null;
  return seconds === null
    ? t("updates.hero.restartDrainCount", { count: prog.inflight })
    : t("updates.hero.restartDrainDetail", { count: prog.inflight, seconds });
});

const restartElapsed = computed(() => {
  if (!props.restartStartedAt) return "";
  const seconds = Math.max(0, Math.floor((now.value - props.restartStartedAt) / 1000));
  const duration =
    seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return t("updates.hero.restartElapsed", { duration });
});

// The store error clears itself on the next action; a backend lastError stays until the next
// successful run, so the admin can hide one they have read.
const dismissedError = ref<string | null>(null);
const shownError = computed(() => {
  const text = props.error ?? props.status?.lastError ?? null;
  return text && text !== dismissedError.value ? text : null;
});

function dismissError() {
  dismissedError.value = shownError.value;
  emit("dismiss-error");
}

const lastRestart = computed(() => props.status?.lastRestart ?? null);

const lastRestartTone = computed(() => {
  const outcome = lastRestart.value?.outcome;
  if (outcome === "rolled_back") return "danger" as const;
  if (outcome === "degraded") return "warning" as const;
  return "success" as const;
});

const dockerRestartCmd = "docker compose restart slipgate";
const systemdRestartCmd = "systemctl restart slipgate";

const stateTone = computed(() => {
  const s = props.status?.state;
  if (s === "error" || s === "failed") return "danger" as const;
  if (props.restarting || s === "restarting" || props.busy) return "accent" as const;
  if (props.status?.edgeBinaryStaged) return "warning" as const;
  if (props.status?.updateAvailable) return "accent" as const;
  return "success" as const;
});
</script>

<template>
  <section class="card overflow-hidden">
    <div class="p-5 sm:p-6">
      <div class="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <!-- Left: version identity & status -->
        <div class="flex min-w-0 items-start gap-4">
          <div
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset"
            :class="
              status?.updateAvailable
                ? 'bg-accent/10 text-accent ring-accent/25'
                : status?.state === 'error' || status?.state === 'failed'
                  ? 'bg-danger/10 text-danger ring-danger/25'
                  : 'bg-success/10 text-success ring-success/25'
            "
          >
            <UiIcon
              :name="busy ? 'loader' : status?.updateAvailable ? 'download' : status?.state === 'error' || status?.state === 'failed' ? 'alert' : 'check-circle'"
              :size="22"
              :spin="busy"
            />
          </div>

          <div class="min-w-0 space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-base font-semibold tracking-tight text-fg">
                {{
                  status?.updateAvailable
                    ? t("updates.hero.updateAvailable")
                    : t("updates.hero.upToDate")
                }}
              </h2>
              <UiBadge :tone="status?.channel === 'dev' ? 'warning' : 'accent'" dot>
                {{ status?.channel === "dev" ? t("updates.channels.shortDev") : t("updates.channels.shortStable") }}
              </UiBadge>
              <UiBadge :tone="status?.mode === 'dev' ? 'info' : 'neutral'" mono>
                {{ status?.mode === "dev" ? t("updates.modes.dev") : t("updates.modes.release") }}
              </UiBadge>
              <UiBadge :tone="stateTone" :pulse="busy" dot>
                {{ t(`updates.states.${status?.state ?? "idle"}`) }}
              </UiBadge>
            </div>

            <!-- Version + commit comparison strip -->
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-fg-muted">
              <div class="inline-flex items-center gap-1.5">
                <span class="text-fg-subtle">{{ t("updates.hero.currentVersion") }}:</span>
                <code class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-fg">
                  {{ status?.version ?? "0.1.0" }}
                </code>
                <span class="font-mono text-2xs text-fg-subtle">
                  ({{ shortHash(status?.activeCommit ?? "dev", 9) }})
                </span>
              </div>

              <template v-if="status?.remoteVersion || status?.remoteTag || (status?.remoteCommit && status.remoteCommit !== status.activeCommit)">
                <UiIcon name="arrow-right" :size="13" class="text-fg-subtle" />
                <div class="inline-flex items-center gap-1.5">
                  <span class="text-fg-subtle">{{ t("updates.hero.targetVersion") }}:</span>
                  <code class="rounded bg-accent/10 px-1.5 py-0.5 font-mono font-medium text-accent">
                    {{ status?.remoteVersion ?? status?.remoteTag ?? shortHash(status?.remoteCommit, 9) }}
                  </code>
                  <span v-if="status?.remoteCommit" class="font-mono text-2xs text-fg-subtle">
                    ({{ shortHash(status.remoteCommit, 9) }})
                  </span>
                </div>
              </template>
            </div>

            <!-- Last check / update timestamps -->
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-subtle">
              <span class="inline-flex items-center gap-1">
                <UiIcon name="clock" :size="12" />
                {{ t("updates.hero.lastChecked") }}:
                {{ status?.lastCheckedAtIso ? `${formatRelative(status.lastCheckedAtIso, now)} (${formatDateTime(status.lastCheckedAtIso)})` : t("updates.hero.neverChecked") }}
              </span>
              <span class="inline-flex items-center gap-1">
                <UiIcon name="branch" :size="12" />
                {{ t("updates.hero.lastUpdated") }}:
                {{ status?.lastUpdatedAtIso ? formatDateTime(status.lastUpdatedAtIso) : t("updates.hero.neverUpdated") }}
              </span>
            </div>

            <!-- Last full-service restart, as confirmed by the boot that followed it -->
            <div v-if="lastRestart" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-fg-subtle">
              <UiIcon name="refresh" :size="12" />
              <span>{{ t("updates.hero.lastRestart") }}:</span>
              <span class="text-fg-muted">{{ t(`updates.hero.restartReasons.${lastRestart.reason}`) }}</span>
              <span class="font-mono text-fg-muted">
                {{ lastRestart.fromVersion }}
                <template v-if="lastRestart.toVersion !== lastRestart.fromVersion"> → {{ lastRestart.toVersion }}</template>
              </span>
              <span>· {{ t("updates.hero.restartTook", { duration: formatDurationMs(lastRestart.durationMs) }) }}</span>
              <span :title="formatDateTime(lastRestart.completedAtIso)">· {{ formatRelative(lastRestart.completedAtIso, now) }}</span>
              <span v-if="lastRestart.coldBoots > 0">· {{ t("updates.hero.restartColdBoots", { count: lastRestart.coldBoots }) }}</span>
              <UiBadge :tone="lastRestartTone" dot>{{ t(`updates.hero.restartOutcomes.${lastRestart.outcome}`) }}</UiBadge>
            </div>
            <p v-if="lastRestart?.message && lastRestart.outcome !== 'succeeded'" class="text-2xs text-fg-muted">
              {{ lastRestart.message }}
            </p>
          </div>
        </div>

        <!-- Right: primary actions -->
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <!-- Staged edge binaries get their own restart button in the banner below. -->
          <button
            v-if="status && !status.standalone && !status.edgeBinaryStaged"
            type="button"
            class="btn btn-secondary"
            :disabled="busy || restarting"
            :title="t('updates.hero.restartServicesHint')"
            @click="emit('restart')"
          >
            <UiIcon :name="restarting ? 'loader' : 'zap'" :size="15" :spin="Boolean(restarting)" />
            {{ restarting ? t("updates.hero.restartingBtn") : t("updates.hero.restartServices") }}
            <UiIcon v-if="stepUpRequired && !restarting" name="shield" :size="13" class="opacity-80" />
          </button>

          <button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('check')">
            <UiIcon :name="checking ? 'loader' : 'refresh'" :size="15" :spin="checking" />
            {{ checking ? t("updates.hero.checking") : t("updates.hero.checkNow") }}
          </button>

          <button
            v-if="status?.canRollback && status.previousRelease"
            type="button"
            class="btn btn-secondary"
            :disabled="busy || status?.standalone"
            @click="emit('rollback')"
          >
            <UiIcon :name="rollingBack ? 'loader' : 'rotate-ccw'" :size="15" :spin="rollingBack" />
            {{ t("updates.hero.rollbackPrev", { version: status.previousRelease.version }) }}
            <UiIcon v-if="stepUpRequired && !rollingBack" name="shield" :size="13" class="opacity-80" />
          </button>

          <button
            type="button"
            class="btn btn-primary"
            :disabled="busy || status?.standalone || !status?.updateAvailable"
            @click="emit('apply')"
          >
            <UiIcon :name="applying ? 'loader' : 'download'" :size="15" :spin="applying" />
            {{ applying ? t("updates.hero.updating") : t("updates.hero.updateNow") }}
            <UiIcon v-if="stepUpRequired && !applying" name="shield" :size="13" class="opacity-80" />
          </button>
        </div>
      </div>

      <!-- Step-up policy hint -->
      <p
        v-if="status && !status.standalone && stepUpRequired && status.updateAvailable"
        class="mt-3 flex items-center gap-1.5 text-2xs text-fg-subtle"
      >
        <UiIcon name="lock" :size="12" />
        {{ t("updates.hero.stepUpHint") }}
      </p>
      <p
        v-else-if="status && !status.standalone && !stepUpRequired"
        class="mt-3 flex items-center gap-1.5 text-2xs text-fg-subtle"
      >
        <UiIcon name="unlock" :size="12" />
        {{ t("updates.hero.devNoStepUpHint") }}
      </p>

      <!-- Live pipeline stepper + progress bar -->
      <div v-if="showPipeline" class="mt-5 rounded-xl border border-line bg-surface-2/60 p-4 space-y-3">
        <ol class="grid grid-cols-3 gap-2 sm:grid-cols-5">
          <li
            v-for="(step, idx) in PIPELINE_STEPS"
            :key="step"
            class="flex flex-col gap-1.5"
            :aria-current="idx === activeStepIndex ? 'step' : undefined"
          >
            <div
              class="h-1.5 w-full rounded-full transition-colors duration-300"
              :class="
                idx < activeStepIndex
                  ? 'bg-success'
                  : idx === activeStepIndex
                    ? 'bg-accent animate-pulse'
                    : 'bg-surface-3'
              "
            />
            <span
              class="truncate text-2xs font-medium"
              :class="idx === activeStepIndex ? 'text-accent' : idx < activeStepIndex ? 'text-success' : 'text-fg-subtle'"
            >
              {{ t(`updates.hero.pipeline.${step}`) }}
            </span>
          </li>
        </ol>

        <div v-if="status?.progress" class="space-y-1">
          <div class="flex items-center justify-between text-2xs text-fg-muted">
            <span class="font-medium">{{ t(`updates.states.${status.progress.stage}`) }}</span>
            <span class="font-mono tabular-nums">{{ progressLabel }}</span>
          </div>
          <div
            class="h-2 w-full overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="progressPercent"
            :aria-valuetext="progressLabel"
          >
            <div
              class="h-full rounded-full bg-accent transition-all duration-200"
              :style="{ width: `${Math.max(4, progressPercent)}%` }"
            />
          </div>
        </div>
      </div>

      <!-- Live graceful restart banner -->
      <UiAlert v-if="showRestartBanner" tone="info" class="mt-4">
        <div class="flex items-start gap-2.5" role="status" aria-live="polite">
          <UiIcon name="loader" :size="16" spin class="mt-0.5 text-accent" />
          <div class="min-w-0 flex-1 space-y-2.5">
            <div class="space-y-1">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="font-semibold text-fg">{{ t("updates.hero.restartingTitle") }}</p>
                <span v-if="restartElapsed" class="font-mono text-2xs tabular-nums text-fg-subtle">{{ restartElapsed }}</span>
              </div>
              <p class="text-xs leading-relaxed text-fg-muted">{{ t("updates.hero.restartingDesc") }}</p>
            </div>
            <ol class="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <li
                v-for="(step, idx) in RESTART_STEPS"
                :key="step"
                class="flex flex-col gap-1.5"
                :aria-current="idx === restartStepIndex ? 'step' : undefined"
              >
                <div
                  class="h-1.5 w-full rounded-full transition-colors duration-300"
                  :class="
                    idx < restartStepIndex
                      ? 'bg-success'
                      : idx === restartStepIndex
                        ? 'bg-accent animate-pulse'
                        : 'bg-surface-3'
                  "
                />
                <span
                  class="truncate text-2xs font-medium"
                  :class="idx === restartStepIndex ? 'text-accent' : idx < restartStepIndex ? 'text-success' : 'text-fg-subtle'"
                >
                  {{ t(`updates.hero.restartSteps.${step}`) }}
                </span>
              </li>
            </ol>
            <p v-if="drainDetail" class="font-mono text-2xs tabular-nums text-fg-muted">{{ drainDetail }}</p>
          </div>
        </div>
      </UiAlert>

      <!-- Edge binary restart notice banner -->
      <UiAlert v-else-if="status?.edgeBinaryStaged" tone="warning" class="mt-4">
        <div class="space-y-2.5">
          <p class="font-semibold text-fg">{{ t("updates.hero.edgeRestartTitle") }}</p>
          <p class="text-xs leading-relaxed text-fg-muted">
            {{ t("updates.hero.edgeRestartDesc", { path: status.edgeBinaryPath ?? "staged/slipgate" }) }}
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="!status?.standalone"
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="busy || restarting"
              @click="emit('restart')"
            >
              <UiIcon :name="restarting ? 'loader' : 'refresh'" :size="14" :spin="Boolean(restarting)" />
              {{ restarting ? t("updates.hero.restartingBtn") : t("updates.hero.restartNow") }}
              <UiIcon v-if="stepUpRequired && !restarting" name="shield" :size="12" class="opacity-80" />
            </button>
            <div class="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1 font-mono text-xs text-fg">
              <span>{{ dockerRestartCmd }}</span>
              <CopyButton :text="dockerRestartCmd" />
            </div>
            <div class="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1 font-mono text-xs text-fg">
              <span>{{ systemdRestartCmd }}</span>
              <CopyButton :text="systemdRestartCmd" />
            </div>
          </div>
        </div>
      </UiAlert>

      <!-- Error alert -->
      <UiAlert v-if="shownError" tone="danger" class="mt-4">
        <div class="flex items-start justify-between gap-3">
          <span class="break-all font-mono text-xs">{{ shownError }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs shrink-0"
            :aria-label="t('updates.hero.dismissError')"
            :title="t('updates.hero.dismissError')"
            @click="dismissError"
          >
            <UiIcon name="x" :size="13" />
          </button>
        </div>
      </UiAlert>
    </div>
  </section>
</template>
