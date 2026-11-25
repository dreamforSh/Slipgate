<script setup lang="ts">
import type { SystemUpdateHistoryEntry } from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { formatDateTime, shortHash } from "../../../lib/format";
import EmptyState from "../../ui/EmptyState.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";

defineProps<{
  history: SystemUpdateHistoryEntry[];
  busy: boolean;
  standalone: boolean;
  stepUpRequired?: boolean;
}>();

const emit = defineEmits<{
  (e: "restore", entry: SystemUpdateHistoryEntry): void;
}>();

const { t } = useI18n();

/**
 * The boot guard records the rollback it performed for a release that never became healthy as a
 * succeeded rollback carrying the reason in `error`.
 */
function isAutoRollback(entry: SystemUpdateHistoryEntry): boolean {
  return entry.action === "rollback" && entry.succeeded && Boolean(entry.error);
}
</script>

<template>
  <UiCard icon="clock" :title="t('updates.history.title')">
    <template #actions>
      <UiBadge tone="neutral">
        {{ t("updates.history.retentionHint", { count: 5 }) }}
      </UiBadge>
    </template>

    <EmptyState
      v-if="history.length === 0"
      compact
      icon="clock"
      :title="t('updates.history.empty')"
      :description="t('updates.history.emptyHint')"
    />

    <ol v-else class="space-y-3">
      <li
        v-for="entry in history"
        :key="entry.id"
        class="flex flex-col gap-3 rounded-xl border border-line bg-surface-2/40 p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex min-w-0 items-start gap-3">
          <span
            class="icon-chip mt-0.5 h-8 w-8"
            :class="entry.action === 'rollback' ? 'bg-warning/10 text-warning' : 'icon-chip-accent'"
          >
            <UiIcon :name="isAutoRollback(entry) ? 'shield' : entry.action === 'rollback' ? 'rotate-ccw' : 'download'" :size="15" />
          </span>

          <div class="min-w-0 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-semibold text-fg">
                {{
                  isAutoRollback(entry)
                    ? t("updates.history.actionAutoRollback")
                    : entry.action === "rollback"
                      ? t("updates.history.actionRollback")
                      : t("updates.history.actionApply")
                }}
              </span>
              <span class="inline-flex items-center gap-1 font-mono text-xs text-fg-muted">
                <span>{{ entry.fromVersion }}</span>
                <UiIcon name="arrow-right" :size="12" class="text-fg-subtle" />
                <span class="font-semibold text-fg">{{ entry.toVersion }}</span>
              </span>
              <UiBadge :tone="entry.succeeded ? 'success' : 'danger'" dot>
                {{ entry.succeeded ? t("updates.history.succeeded") : t("updates.history.failed") }}
              </UiBadge>
              <UiBadge :tone="entry.channel === 'dev' ? 'warning' : 'neutral'">
                {{ entry.channel === "dev" ? t("updates.channels.shortDev") : t("updates.channels.shortStable") }}
              </UiBadge>
              <UiBadge v-if="entry.rollbackAvailable" tone="info">
                {{ t("updates.history.rollbackAvailable") }}
              </UiBadge>
            </div>

            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-fg-subtle">
              <span>{{ shortHash(entry.fromCommit, 8) }} → {{ shortHash(entry.toCommit, 8) }}</span>
              <span v-if="entry.tag">{{ entry.tag }}</span>
              <span>{{ entry.strategy }}</span>
              <span>{{ formatDateTime(entry.createdAtIso) }}</span>
            </div>

            <p v-if="entry.error" class="text-2xs" :class="isAutoRollback(entry) ? 'text-warning' : 'font-mono text-danger'">
              {{ entry.error }}
            </p>
          </div>
        </div>

        <div v-if="entry.rollbackAvailable" class="flex shrink-0 items-center">
          <button
            type="button"
            class="btn btn-secondary btn-xs"
            :disabled="busy || standalone"
            @click="emit('restore', entry)"
          >
            <UiIcon name="rotate-ccw" :size="13" />
            {{ t("updates.history.restore") }}
            <UiIcon v-if="stepUpRequired" name="shield" :size="12" class="opacity-80" />
          </button>
        </div>
      </li>
    </ol>
  </UiCard>
</template>
