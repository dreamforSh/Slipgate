<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { formatNumber } from "../../../lib/format";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";

/**
 * Displays the count of undelivered settlement events parked in slipgate-net's dead-letter spool
 * and lets admins trigger a deduplicated replay once BFF / PostgreSQL connectivity is healthy.
 */
const props = defineProps<{
  count: number;
  mode?: string;
  loading: boolean;
  replaying: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "replay"): void;
  (e: "refresh"): void;
}>();

const { t } = useI18n();

const standalone = computed(() => props.mode === "standalone");
const hasBacklog = computed(() => props.count > 0);
</script>

<template>
  <UiCard icon="inbox" :title="t('security.ops.deadLetters.title')">
    <template #actions>
      <UiBadge v-if="standalone" tone="neutral">{{ t("security.ops.deadLetters.standaloneBadge") }}</UiBadge>
      <UiBadge v-else :tone="hasBacklog ? 'warning' : 'success'" dot :pulse="hasBacklog">
        {{ hasBacklog ? t("security.ops.deadLetters.pendingBadge", { n: formatNumber(count) }) : t("security.ops.deadLetters.emptyBadge") }}
      </UiBadge>
      <button
        type="button"
        class="btn btn-ghost btn-icon btn-sm"
        :disabled="loading || replaying"
        :title="t('common.refresh')"
        :aria-label="t('common.refresh')"
        @click="emit('refresh')"
      >
        <UiIcon name="refresh" :size="14" :spin="loading" />
      </button>
      <ConfirmButton
        v-if="!standalone && hasBacklog"
        size="sm"
        icon="rotate-ccw"
        :label="replaying ? t('security.ops.deadLetters.replaying') : t('security.ops.deadLetters.replay')"
        :confirm-label="t('security.ops.deadLetters.confirmReplay')"
        :disabled="loading || replaying"
        @confirm="emit('replay')"
      />
    </template>

    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-3">
        <span
          class="font-mono text-2xl font-semibold tabular-nums"
          :class="hasBacklog ? 'text-warning' : 'text-fg'"
        >
          {{ formatNumber(count) }}
        </span>
        <p class="text-xs leading-relaxed text-fg-subtle">
          {{ standalone ? t("security.ops.deadLetters.standaloneHint") : t("security.ops.deadLetters.hint") }}
        </p>
      </div>
      <span v-if="!standalone && !hasBacklog" class="inline-flex items-center gap-1.5 text-xs text-success">
        <UiIcon name="check-circle" :size="14" />
        {{ t("security.ops.deadLetters.allClear") }}
      </span>
    </div>

    <UiAlert v-if="error" tone="warning" class="mt-3">{{ error }}</UiAlert>
  </UiCard>
</template>
