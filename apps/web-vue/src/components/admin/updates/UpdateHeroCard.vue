<script setup lang="ts">
import { computed } from "vue";
import type { SystemUpdateStatus } from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import CopyButton from "../../ui/CopyButton.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { formatBytes, formatDateTime, formatRelative, shortHash } from "../../../lib/format";

const props = defineProps<{
  status: SystemUpdateStatus | null;
  checking: boolean;
  applying: boolean;
  rollingBack: boolean;
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "check"): void;
  (e: "apply"): void;
  (e: "rollback"): void;
}>();

const { t } = useI18n();

const PIPELINE_STEPS = ["checking", "downloading", "applying", "reloading_planes", "done"] as const;

const activeStepIndex = computed(() => {
  const s = props.status?.state;
  if (!s || s === "idle" || s === "error" || s === "failed") return -1;
  if (s === "rolling_back") return 2;
  const idx = PIPELINE_STEPS.indexOf(s as (typeof PIPELINE_STEPS)[number]);
  return idx >= 0 ? idx : 0;
});

const showPipeline = computed(
  () => props.busy || (props.status?.progress !== null && props.status?.progress !== undefined),
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

const dockerRestartCmd = "docker compose restart slipgate";
const systemdRestartCmd = "systemctl restart slipgate";

const stateTone = computed(() => {
  const s = props.status?.state;
  if (s === "error" || s === "failed") return "danger" as const;
  if (props.busy) return "accent" as const;
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
                {{ status?.lastCheckedAtIso ? `${formatRelative(status.lastCheckedAtIso)} (${formatDateTime(status.lastCheckedAtIso)})` : t("updates.hero.neverChecked") }}
              </span>
              <span class="inline-flex items-center gap-1">
                <UiIcon name="branch" :size="12" />
                {{ t("updates.hero.lastUpdated") }}:
                {{ status?.lastUpdatedAtIso ? formatDateTime(status.lastUpdatedAtIso) : t("updates.hero.neverUpdated") }}
              </span>
            </div>
          </div>
        </div>

        <!-- Right: primary actions -->
        <div class="flex shrink-0 flex-wrap items-center gap-2">
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
          </button>

          <button
            type="button"
            class="btn btn-primary"
            :disabled="busy || status?.standalone || !status?.updateAvailable"
            @click="emit('apply')"
          >
            <UiIcon :name="applying ? 'loader' : 'download'" :size="15" :spin="applying" />
            {{ applying ? t("updates.hero.updating") : t("updates.hero.updateNow") }}
            <UiIcon v-if="status?.mode !== 'dev' && !applying" name="shield" :size="13" class="opacity-80" />
          </button>
        </div>
      </div>

      <!-- Release step-up hint when applicable -->
      <p
        v-if="status?.updateAvailable && status.mode !== 'dev' && !status.standalone"
        class="mt-3 flex items-center gap-1.5 text-2xs text-fg-subtle"
      >
        <UiIcon name="lock" :size="12" />
        {{ t("updates.hero.stepUpHint") }}
      </p>

      <!-- Live pipeline stepper + progress bar -->
      <div v-if="showPipeline" class="mt-5 rounded-xl border border-line bg-surface-2/60 p-4 space-y-3">
        <div class="grid grid-cols-5 gap-2">
          <div
            v-for="(step, idx) in PIPELINE_STEPS"
            :key="step"
            class="flex flex-col gap-1.5"
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
          </div>
        </div>

        <div v-if="status?.progress" class="space-y-1">
          <div class="flex items-center justify-between text-2xs text-fg-muted">
            <span class="font-medium">{{ t(`updates.states.${status.progress.stage}`) }}</span>
            <span class="font-mono tabular-nums">{{ progressLabel }}</span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded-full bg-surface-3">
            <div
              class="h-full rounded-full bg-accent transition-all duration-200"
              :style="{ width: `${Math.max(4, progressPercent)}%` }"
            />
          </div>
        </div>
      </div>

      <!-- Edge binary restart notice banner -->
      <UiAlert v-if="status?.edgeBinaryStaged" tone="warning" class="mt-4">
        <div class="space-y-2">
          <p class="font-semibold text-fg">{{ t("updates.hero.edgeRestartTitle") }}</p>
          <p class="text-xs leading-relaxed text-fg-muted">
            {{ t("updates.hero.edgeRestartDesc", { path: status.edgeBinaryPath ?? "staged/slipgate" }) }}
          </p>
          <div class="flex flex-wrap gap-2">
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
      <UiAlert v-if="error || status?.lastError" tone="danger" class="mt-4">
        <span class="font-mono text-xs">{{ error ?? status?.lastError }}</span>
      </UiAlert>
    </div>
  </section>
</template>
