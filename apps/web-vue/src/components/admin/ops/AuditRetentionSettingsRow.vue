<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { AuditRetentionStatus } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { apiJson } from "../../../lib/api";
import { formatNumber } from "../../../lib/format";

/**
 * Settings → security: the audit-log retention period, read-only. It is changed on the audit log
 * page (AuditRetentionCard), where shortening it asks for a fresh two-factor code; the settings
 * patch refuses a shorter period (403 retention_step_up).
 */
const { t } = useI18n();

const days = ref<number | null>(null);
const loading = ref(true);
const failed = ref(false);

async function load() {
  loading.value = true;
  failed.value = false;
  try {
    days.value = (await apiJson<AuditRetentionStatus>("/api/v1/admin/audit-logs/retention")).retentionDays;
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <UiCard icon="clock" :title="t('audit.retention.settingsRow.title')">
    <template #actions>
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0 scale-95"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <span v-if="loading" key="loading" class="block h-5 w-20 rounded-full bg-surface-2 motion-safe:animate-pulse" aria-hidden="true" />
        <UiBadge v-else-if="days !== null" :key="days" :tone="days > 0 ? 'success' : 'neutral'" dot>
          {{ days === 0 ? t("audit.retention.forever") : t("audit.retention.keepDays", { n: formatNumber(days) }, days) }}
        </UiBadge>
      </Transition>
    </template>

    <div class="flex flex-wrap items-center gap-3">
      <p class="min-w-0 flex-1 text-xs leading-relaxed text-fg-subtle">
        {{ t("audit.retention.settingsRow.desc") }}
        <span v-if="failed" class="mt-1 flex items-center gap-1.5 text-danger" role="alert">
          <UiIcon name="alert" :size="12" class="shrink-0" />
          {{ t("audit.retention.settingsRow.loadFailed") }}
          <button type="button" class="font-medium text-accent hover:underline" @click="load">{{ t("common.refresh") }}</button>
        </span>
      </p>
      <RouterLink to="/admin/audit-logs" class="btn btn-secondary btn-sm shrink-0">
        {{ t("audit.retention.settingsRow.manage") }}
        <UiIcon name="arrow-right" :size="13" />
      </RouterLink>
    </div>
  </UiCard>
</template>
