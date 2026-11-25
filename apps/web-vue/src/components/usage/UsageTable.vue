<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { recognizeEndpoint, type UsageRow } from "@slipgate/contracts";
import UiBadge from "../ui/UiBadge.vue";
import UiIcon from "../ui/UiIcon.vue";
import { formatDateTime, formatDurationMs, formatNumber, formatRelative, formatTokens, formatUsd } from "../../lib/format";

/** Request rows; admin mode adds the user and upstream-account columns. */
defineProps<{
  rows: UsageRow[];
  mode: "admin" | "user";
  now: number;
}>();
const emit = defineEmits<{
  (e: "filter-user", userId: string): void;
  (e: "filter-group", groupId: string): void;
  (e: "filter-model", model: string): void;
}>();

const { t } = useI18n();

function tokenTitle(r: UsageRow): string {
  return [
    `${t("usageLogs.table.input")}: ${formatNumber(r.inputTokens)}`,
    `${t("usageLogs.table.output")}: ${formatNumber(r.outputTokens)}`,
    `${t("usageLogs.table.cacheRead")}: ${formatNumber(r.cacheReadTokens)}`,
    `${t("usageLogs.table.cacheWrite")}: ${formatNumber(r.cacheWriteTokens)}`,
  ].join("\n");
}

/** Inbound endpoint, plus the upstream one when it differs (recognised from the codecs). */
function endpointOf(r: UsageRow) {
  const inbound = recognizeEndpoint(r.ingressCodec).endpoint;
  const upstream = recognizeEndpoint(r.egressCodec).endpoint;
  return {
    inbound,
    upstream: upstream !== inbound ? upstream : "",
    title: t("usageLogs.table.endpointTitle", { inbound: r.ingressCodec, upstream: r.egressCodec }),
  };
}

function delay(i: number) {
  return { animationDelay: `${Math.min(i, 12) * 20}ms` };
}
</script>

<template>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>{{ t("usageLogs.table.time") }}</th>
          <th v-if="mode === 'admin'">{{ t("usageLogs.table.user") }}</th>
          <th>{{ t("usageLogs.table.apiKey") }}</th>
          <th>{{ t("usageLogs.table.group") }}</th>
          <th v-if="mode === 'admin'">{{ t("usageLogs.table.account") }}</th>
          <th>{{ t("usageLogs.table.model") }}</th>
          <th class="hidden 2xl:table-cell">{{ t("usageLogs.table.endpoint") }}</th>
          <th class="text-right">{{ t("usageLogs.table.tokens") }}</th>
          <th class="text-right">{{ t("usageLogs.table.cost") }}</th>
          <th class="text-right">{{ t("usageLogs.table.latency") }}</th>
          <th>{{ t("usageLogs.table.status") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(r, i) in rows"
          :key="r.id"
          class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
          :style="delay(i)"
        >
          <td class="whitespace-nowrap" :title="t('usageLogs.table.requestId', { id: r.requestId })">
            <p class="font-mono text-xs tabular-nums text-fg">{{ formatDateTime(r.createdAtIso) }}</p>
            <p class="mt-0.5 text-2xs text-fg-subtle">{{ formatRelative(r.createdAtIso, now) }}</p>
          </td>

          <td v-if="mode === 'admin'" class="max-w-[14rem]">
            <button
              type="button"
              class="block max-w-full cursor-pointer truncate text-left text-xs text-fg transition-colors hover:text-accent"
              :title="r.userEmail || r.userId"
              @click="emit('filter-user', r.userId)"
            >
              {{ r.userEmail || r.userId }}
            </button>
          </td>

          <td class="max-w-[10rem]">
            <span class="inline-flex max-w-full items-center gap-1 text-xs text-fg-muted">
              <UiIcon name="key" :size="11" class="shrink-0 text-fg-subtle" />
              <span class="truncate" :title="r.apiKeyName || r.apiKeyId">{{ r.apiKeyName || r.apiKeyId }}</span>
            </span>
          </td>

          <td class="max-w-[10rem]">
            <button
              type="button"
              class="inline-flex max-w-full cursor-pointer items-center gap-1 text-xs text-fg-muted transition-colors hover:text-accent"
              :title="r.groupName || r.groupId"
              @click="emit('filter-group', r.groupId)"
            >
              <UiIcon name="layers" :size="11" class="shrink-0" />
              <span class="truncate">{{ r.groupName || r.groupId }}</span>
            </button>
          </td>

          <td v-if="mode === 'admin'" class="max-w-[10rem]">
            <span class="block truncate text-xs text-fg-muted" :title="r.accountName || r.accountId">
              {{ r.accountName || r.accountId }}
            </span>
          </td>

          <td class="max-w-[16rem]">
            <button
              type="button"
              class="block max-w-full cursor-pointer truncate text-left font-mono text-xs text-fg transition-colors hover:text-accent"
              :title="r.publicModel"
              @click="emit('filter-model', r.publicModel)"
            >
              {{ r.publicModel }}
            </button>
            <p
              v-if="r.upstreamModel && r.upstreamModel !== r.publicModel"
              class="mt-0.5 flex items-center gap-1 truncate font-mono text-2xs text-fg-subtle"
              :title="t('usageLogs.table.upstream', { model: r.upstreamModel })"
            >
              <UiIcon name="arrow-right" :size="10" class="shrink-0" />
              <span class="truncate">{{ r.upstreamModel }}</span>
            </p>
          </td>

          <td class="hidden max-w-[14rem] 2xl:table-cell" :title="endpointOf(r).title">
            <p class="truncate font-mono text-xs text-fg-muted">{{ endpointOf(r).inbound }}</p>
            <p v-if="endpointOf(r).upstream" class="mt-0.5 flex items-center gap-1 truncate font-mono text-2xs text-fg-subtle">
              <UiIcon name="arrow-right" :size="10" class="shrink-0" />
              <span class="truncate">{{ endpointOf(r).upstream }}</span>
            </p>
          </td>

          <td class="whitespace-nowrap text-right" :title="tokenTitle(r)">
            <p class="font-mono text-xs tabular-nums text-fg">
              {{ formatTokens(r.inputTokens) }}
              <span class="text-fg-subtle">/</span>
              {{ formatTokens(r.outputTokens) }}
            </p>
            <p
              v-if="r.cacheReadTokens + r.cacheWriteTokens > 0"
              class="mt-0.5 inline-flex cursor-help items-center gap-1 font-mono text-2xs tabular-nums text-info"
            >
              <UiIcon name="database" :size="10" />
              {{ formatTokens(r.cacheReadTokens) }}<span class="text-fg-subtle">/</span>{{ formatTokens(r.cacheWriteTokens) }}
            </p>
          </td>

          <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg">
            {{ formatUsd(r.costNanoUsd) }}
          </td>

          <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums">
            <span class="text-fg-muted">{{ r.ttftMs > 0 ? formatDurationMs(r.ttftMs) : "—" }}</span>
            <span class="text-fg-subtle"> / </span>
            <span class="text-fg">{{ r.durationMs > 0 ? formatDurationMs(r.durationMs) : "—" }}</span>
          </td>

          <td>
            <UiBadge :tone="r.statusCode < 400 ? 'success' : r.statusCode === 429 ? 'warning' : 'danger'" dot mono>
              {{ r.statusCode }}
            </UiBadge>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
