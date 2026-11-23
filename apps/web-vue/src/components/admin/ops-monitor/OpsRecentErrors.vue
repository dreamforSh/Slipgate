<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { OpsOverview } from "@slipgate/contracts";
import { formatDateTime, formatDurationMs, formatRelative } from "../../../lib/format";
import CopyButton from "../../ui/CopyButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import { statusTone } from "./opsFormat";

/** Latest failed requests in the range. */
defineProps<{ errors: OpsOverview["recentErrors"]; now: number }>();

const { t } = useI18n();
</script>

<template>
  <UiCard icon="alert" :title="t('security.ops.recent.title')" flush>
    <template #actions>
      <span class="font-mono text-xs tabular-nums text-fg-subtle">{{ errors.length }}</span>
    </template>
    <EmptyState v-if="errors.length === 0" compact icon="check-circle" :title="t('security.ops.recent.empty')" />
    <div v-else class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>{{ t("security.ops.recent.time") }}</th>
            <th>{{ t("common.status") }}</th>
            <th>{{ t("security.ops.recent.user") }}</th>
            <th>{{ t("security.ops.recent.model") }}</th>
            <th>{{ t("security.ops.recent.account") }}</th>
            <th>{{ t("security.ops.recent.group") }}</th>
            <th class="text-right">{{ t("security.ops.recent.duration") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in errors" :key="`${e.requestId}-${e.createdAtIso}`">
            <td class="whitespace-nowrap">
              <p class="text-xs text-fg" :title="formatDateTime(e.createdAtIso)">{{ formatRelative(e.createdAtIso, now) }}</p>
              <p v-if="e.requestId" class="mt-0.5 flex items-center gap-0.5">
                <span class="max-w-[7rem] truncate font-mono text-2xs text-fg-subtle" :title="e.requestId">{{ e.requestId }}</span>
                <CopyButton :text="e.requestId" class="!h-5 !w-5" />
              </p>
            </td>
            <td><UiBadge :tone="statusTone(e.statusCode)" mono>{{ e.statusCode || "—" }}</UiBadge></td>
            <td class="max-w-[12rem] truncate text-xs text-fg-muted" :title="e.userEmail">{{ e.userEmail || "—" }}</td>
            <td class="max-w-[12rem] truncate font-mono text-xs text-fg" :title="e.model">{{ e.model || "—" }}</td>
            <td class="max-w-[10rem] truncate text-xs text-fg-muted" :title="e.accountName">{{ e.accountName || "—" }}</td>
            <td class="max-w-[8rem] truncate text-xs text-fg-muted" :title="e.groupName">{{ e.groupName || "—" }}</td>
            <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">{{ formatDurationMs(e.durationMs) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </UiCard>
</template>
