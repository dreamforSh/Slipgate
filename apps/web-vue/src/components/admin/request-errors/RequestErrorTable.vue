<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { RequestErrorItem } from "@slipgate/contracts";
import { formatDateTime, formatRelative } from "../../../lib/format";
import CopyButton from "../../ui/CopyButton.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { statusTone } from "../ops-monitor/opsFormat";
import { phaseTone } from "./requestErrorDisplay";

/** Request-error rows (ops error center, usage page errors tab): inspect and resolve / reopen. */
defineProps<{
  items: RequestErrorItem[];
  now: number;
  togglingId: string | null;
}>();
const emit = defineEmits<{
  (e: "inspect", item: RequestErrorItem): void;
  (e: "toggle", item: RequestErrorItem): void;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>{{ t("security.ops.requestErrors.table.time") }}</th>
          <th>{{ t("security.ops.requestErrors.table.phase") }}</th>
          <th>{{ t("security.ops.requestErrors.table.status") }}</th>
          <th>{{ t("security.ops.requestErrors.table.model") }}</th>
          <th>{{ t("security.ops.requestErrors.table.accountUser") }}</th>
          <th>{{ t("security.ops.requestErrors.table.error") }}</th>
          <th>{{ t("security.ops.requestErrors.table.attempt") }}</th>
          <th>{{ t("security.ops.requestErrors.table.state") }}</th>
          <th class="text-right">{{ t("common.actions") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.id">
          <td class="whitespace-nowrap">
            <p class="text-xs text-fg" :title="formatDateTime(item.createdAtIso)">
              {{ formatRelative(item.createdAtIso, now) }}
            </p>
            <p v-if="item.requestId" class="mt-0.5 flex items-center gap-0.5">
              <span class="max-w-[8rem] truncate font-mono text-2xs text-fg-subtle" :title="item.requestId">
                {{ item.requestId }}
              </span>
              <CopyButton :text="item.requestId" class="!h-5 !w-5" />
            </p>
          </td>
          <td>
            <UiBadge :tone="phaseTone(item.phase)">
              {{ t(`security.ops.requestErrors.phases.${item.phase}`) }}
            </UiBadge>
          </td>
          <td class="whitespace-nowrap">
            <div class="flex items-center gap-1">
              <UiBadge :tone="statusTone(item.statusCode)" mono>{{ item.statusCode }}</UiBadge>
              <UiBadge v-if="item.upstreamStatus > 0 && item.upstreamStatus !== item.statusCode" tone="neutral" mono>
                ↑{{ item.upstreamStatus }}
              </UiBadge>
            </div>
          </td>
          <td class="max-w-[11rem]">
            <p class="truncate font-mono text-xs text-fg" :title="item.model">{{ item.model || "—" }}</p>
            <p v-if="item.platform" class="truncate text-2xs text-fg-subtle">{{ item.platform }}</p>
          </td>
          <td class="max-w-[11rem]">
            <p class="truncate text-xs text-fg" :title="item.accountName || item.accountId || ''">
              {{ item.accountName || item.accountId || "—" }}
            </p>
            <p v-if="item.userEmail" class="truncate text-2xs text-fg-subtle" :title="item.userEmail">
              {{ item.userEmail }}
            </p>
          </td>
          <td class="max-w-[20rem]">
            <p class="truncate font-mono text-2xs text-fg-muted" :title="item.errorCode || item.kind">
              {{ item.errorCode || item.kind || "—" }}
            </p>
            <p class="truncate text-xs text-fg" :title="item.errorMessage">
              {{ item.errorMessage || "—" }}
            </p>
          </td>
          <td class="whitespace-nowrap">
            <div class="flex flex-col gap-0.5">
              <span class="font-mono text-xs text-fg-muted">
                {{ t("security.ops.requestErrors.table.attemptN", { n: item.attempt }) }}
              </span>
              <UiBadge v-if="item.failoverUsed" tone="info">
                {{ t("security.ops.requestErrors.table.failoverTag") }}
              </UiBadge>
            </div>
          </td>
          <td class="whitespace-nowrap">
            <UiBadge :tone="item.resolved ? 'success' : 'danger'" dot>
              {{ item.resolved ? t("security.ops.requestErrors.table.resolvedBadge") : t("security.ops.requestErrors.table.openBadge") }}
            </UiBadge>
          </td>
          <td class="whitespace-nowrap text-right">
            <div class="inline-flex items-center gap-1">
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :title="t('security.ops.requestErrors.table.inspect')"
                :aria-label="t('security.ops.requestErrors.table.inspect')"
                @click="emit('inspect', item)"
              >
                <UiIcon name="eye" :size="14" />
              </button>
              <button type="button" class="btn btn-secondary btn-xs" :disabled="togglingId === item.id" @click="emit('toggle', item)">
                {{ item.resolved ? t("security.ops.requestErrors.table.reopen") : t("security.ops.requestErrors.table.resolve") }}
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
