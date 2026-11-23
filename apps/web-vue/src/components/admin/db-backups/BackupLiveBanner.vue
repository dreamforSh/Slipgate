<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { BackupActiveOperation, BackupRecord } from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import { BACKUP_STAGES, formatElapsed, RESTORE_STAGES, spanMs } from "./dbBackupUtil";

/** The backup or restore running right now: what, which stage, for how long. */
const props = defineProps<{ op: BackupActiveOperation; record: BackupRecord | null; nowMs: number }>();
const { t } = useI18n();

const restore = computed(() => props.op.kind === "restore");
const stages = computed(() => (restore.value ? RESTORE_STAGES : BACKUP_STAGES));
const current = computed(() => stages.value.indexOf(props.op.progress));
const fraction = computed(() => (current.value < 0 ? 0.06 : (current.value + 0.5) / stages.value.length));
const elapsed = computed(() => formatElapsed(spanMs(props.op.startedAtIso, null, props.nowMs)));
const stageLabel = computed(() => t(`dbBackups.stages.${props.op.progress || "pending"}`));

function state(i: number): "done" | "current" | "upcoming" {
  if (i < current.value) return "done";
  return i === current.value ? "current" : "upcoming";
}
</script>

<template>
  <section
    class="card relative overflow-hidden p-4 sm:p-5"
    :class="restore ? 'border-warning/40' : 'border-accent/35'"
    role="status"
    aria-live="polite"
  >
    <div
      class="pointer-events-none absolute inset-0 bg-gradient-to-r to-transparent"
      :class="restore ? 'from-warning/[0.07]' : 'from-accent/[0.06]'"
      aria-hidden="true"
    />
    <div class="relative flex flex-wrap items-start gap-x-4 gap-y-3">
      <span class="icon-chip h-10 w-10 rounded-xl" :class="restore ? 'icon-chip-warning' : 'icon-chip-accent'">
        <UiIcon name="loader" :size="18" spin />
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-fg">
          {{ restore ? t("dbBackups.live.restoreTitle") : t("dbBackups.live.backupTitle") }}
          <span class="ml-1 font-normal text-fg-muted">· {{ stageLabel }}</span>
        </p>
        <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle" :title="record?.fileName">
          {{ record?.fileName || op.backupId || "…" }}
        </p>
      </div>
      <span class="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-2xs font-medium tabular-nums text-fg-muted">
        {{ t("dbBackups.live.elapsed", { time: elapsed }) }}
      </span>
    </div>

    <div class="relative mt-4">
      <div class="h-1.5 overflow-hidden rounded-full bg-surface-3/70 dark:bg-surface-3/50">
        <div
          class="h-full origin-left rounded-full transition-transform duration-[250ms] ease-out motion-reduce:transition-none"
          :class="restore ? 'bg-warning' : 'bg-accent'"
          :style="{ transform: `scaleX(${fraction})` }"
        />
      </div>
      <ol class="mt-2.5 grid gap-2" :style="{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }">
        <li
          v-for="(s, i) in stages"
          :key="s"
          class="flex min-w-0 items-center gap-1.5 text-2xs"
          :class="state(i) === 'upcoming' ? 'text-fg-subtle' : 'text-fg'"
          :aria-current="state(i) === 'current' ? 'step' : undefined"
        >
          <span
            class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset transition-colors duration-200"
            :class="
              state(i) === 'done'
                ? 'bg-success/15 text-success ring-success/30'
                : state(i) === 'current'
                  ? restore
                    ? 'bg-warning/15 text-warning ring-warning/40'
                    : 'bg-accent/15 text-accent ring-accent/40'
                  : 'bg-surface-2 ring-line'
            "
          >
            <UiIcon v-if="state(i) === 'done'" name="check" :size="10" :stroke-width="3" />
            <span v-else-if="state(i) === 'current'" class="h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
          </span>
          <span class="truncate">{{ t(`dbBackups.stages.${s}`) }}</span>
        </li>
      </ol>
    </div>

    <p class="relative mt-3 flex items-start gap-1.5 text-xs leading-relaxed" :class="restore ? 'text-warning' : 'text-fg-subtle'">
      <UiIcon :name="restore ? 'alert' : 'info'" :size="13" class="mt-px shrink-0" />
      {{ restore ? t("dbBackups.live.restoreNote") : t("dbBackups.live.backupNote") }}
    </p>
  </section>
</template>
