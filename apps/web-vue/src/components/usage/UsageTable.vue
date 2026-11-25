<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { recognizeEndpoint, type UsageRow, type UsageSortBy, type UsageSortDir } from "@slipgate/contracts";
import CopyButton from "../ui/CopyButton.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiIcon from "../ui/UiIcon.vue";
import { formatDateTime, formatDurationMs, formatNumber, formatRelative, formatTokens, formatUsd } from "../../lib/format";
import type { UsageColumnKey } from "./usageColumns";

/**
 * Request rows. Admin mode adds the user and upstream-account columns; `hidden` drops columns the
 * viewer switched off (usageColumns.ts); sortable headers emit `sort` (server-side order).
 */
const props = withDefaults(
  defineProps<{
    rows: UsageRow[];
    mode: "admin" | "user";
    now: number;
    hidden?: UsageColumnKey[];
    sort?: { by: UsageSortBy; dir: UsageSortDir };
  }>(),
  { hidden: () => [], sort: () => ({ by: "time", dir: "desc" }) },
);
const emit = defineEmits<{
  (e: "filter-user", userId: string): void;
  (e: "filter-group", groupId: string): void;
  (e: "filter-model", model: string): void;
  (e: "sort", by: UsageSortBy): void;
}>();

const { t } = useI18n();

const hiddenSet = computed(() => new Set(props.hidden));
/** Whether a column is shown (admin-only columns never in user mode). */
function show(key: UsageColumnKey): boolean {
  if ((key === "user" || key === "account") && props.mode !== "admin") return false;
  return !hiddenSet.value.has(key);
}

function ariaSort(by: UsageSortBy): "ascending" | "descending" | "none" {
  if (props.sort.by !== by) return "none";
  return props.sort.dir === "asc" ? "ascending" : "descending";
}

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

/** Images / video seconds a multimodal request was billed for, as text (empty when none). */
function mediaOf(r: UsageRow): string {
  const parts: string[] = [];
  if (r.imageCount) parts.push(t("usageLogs.table.images", { n: r.imageCount }));
  if (r.videoSeconds) parts.push(t("usageLogs.table.videoSeconds", { n: Math.round(r.videoSeconds * 10) / 10 }));
  return parts.join(" · ");
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
          <th :aria-sort="ariaSort('time')">
            <button type="button" class="sort-th" :class="sort.by === 'time' ? 'text-fg' : ''" @click="emit('sort', 'time')">
              {{ t("usageLogs.table.time") }}
              <UiIcon v-if="sort.by === 'time'" :name="sort.dir === 'asc' ? 'arrow-up' : 'arrow-down'" :size="11" />
            </button>
          </th>
          <th v-if="show('user')">{{ t("usageLogs.table.user") }}</th>
          <th v-if="show('apiKey')">{{ t("usageLogs.table.apiKey") }}</th>
          <th v-if="show('group')">{{ t("usageLogs.table.group") }}</th>
          <th v-if="show('account')">{{ t("usageLogs.table.account") }}</th>
          <th v-if="show('model')" :aria-sort="ariaSort('model')">
            <button type="button" class="sort-th" :class="sort.by === 'model' ? 'text-fg' : ''" @click="emit('sort', 'model')">
              {{ t("usageLogs.table.model") }}
              <UiIcon v-if="sort.by === 'model'" :name="sort.dir === 'asc' ? 'arrow-up' : 'arrow-down'" :size="11" />
            </button>
          </th>
          <th v-if="show('reasoning')">{{ t("usageLogs.table.reasoning") }}</th>
          <th v-if="show('serviceTier')">{{ t("usageLogs.table.serviceTier") }}</th>
          <th v-if="show('endpoint')">{{ t("usageLogs.table.endpoint") }}</th>
          <th v-for="col in (['tokens', 'cost', 'latency'] as const).filter((c) => show(c))" :key="col" class="text-right" :aria-sort="ariaSort(col)">
            <button type="button" class="sort-th ml-auto" :class="sort.by === col ? 'text-fg' : ''" @click="emit('sort', col)">
              {{ t(`usageLogs.table.${col}`) }}
              <UiIcon v-if="sort.by === col" :name="sort.dir === 'asc' ? 'arrow-up' : 'arrow-down'" :size="11" />
            </button>
          </th>
          <th v-if="show('status')">{{ t("usageLogs.table.status") }}</th>
          <th v-if="show('requestId')">{{ t("usageLogs.table.requestIdColumn") }}</th>
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

          <td v-if="show('user')" class="max-w-[14rem]">
            <button
              type="button"
              class="block max-w-full cursor-pointer truncate text-left text-xs text-fg transition-colors hover:text-accent"
              :title="r.userEmail || r.userId"
              @click="emit('filter-user', r.userId)"
            >
              {{ r.userEmail || r.userId }}
            </button>
          </td>

          <td v-if="show('apiKey')" class="max-w-[10rem]">
            <span class="inline-flex max-w-full items-center gap-1 text-xs text-fg-muted">
              <UiIcon name="key" :size="11" class="shrink-0 text-fg-subtle" />
              <span class="truncate" :title="r.apiKeyName || r.apiKeyId">{{ r.apiKeyName || r.apiKeyId }}</span>
            </span>
          </td>

          <td v-if="show('group')" class="max-w-[10rem]">
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

          <td v-if="show('account')" class="max-w-[10rem]">
            <span class="block truncate text-xs text-fg-muted" :title="r.accountName || r.accountId">
              {{ r.accountName || r.accountId }}
            </span>
          </td>

          <td v-if="show('model')" class="max-w-[16rem]">
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

          <td v-if="show('reasoning')" class="whitespace-nowrap">
            <UiBadge v-if="r.reasoningEffort" tone="violet" mono>{{ r.reasoningEffort }}</UiBadge>
            <span v-else class="text-xs text-fg-subtle">—</span>
          </td>

          <td v-if="show('serviceTier')" class="whitespace-nowrap">
            <UiBadge v-if="r.serviceTier" tone="info" mono>{{ r.serviceTier }}</UiBadge>
            <span v-else class="text-xs text-fg-subtle">—</span>
          </td>

          <td v-if="show('endpoint')" class="max-w-[14rem]" :title="endpointOf(r).title">
            <p class="truncate font-mono text-xs text-fg-muted">{{ endpointOf(r).inbound }}</p>
            <p v-if="endpointOf(r).upstream" class="mt-0.5 flex items-center gap-1 truncate font-mono text-2xs text-fg-subtle">
              <UiIcon name="arrow-right" :size="10" class="shrink-0" />
              <span class="truncate">{{ endpointOf(r).upstream }}</span>
            </p>
          </td>

          <td v-if="show('tokens')" class="whitespace-nowrap text-right" :title="tokenTitle(r)">
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
            <p v-if="mediaOf(r)" class="mt-0.5 text-2xs text-fg-subtle">{{ mediaOf(r) }}</p>
          </td>

          <td v-if="show('cost')" class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg">
            {{ formatUsd(r.costNanoUsd) }}
          </td>

          <td v-if="show('latency')" class="whitespace-nowrap text-right font-mono text-xs tabular-nums">
            <span class="text-fg-muted">{{ r.ttftMs > 0 ? formatDurationMs(r.ttftMs) : "—" }}</span>
            <span class="text-fg-subtle"> / </span>
            <span class="text-fg">{{ r.durationMs > 0 ? formatDurationMs(r.durationMs) : "—" }}</span>
          </td>

          <td v-if="show('status')">
            <UiBadge :tone="r.statusCode < 400 ? 'success' : r.statusCode === 429 ? 'warning' : 'danger'" dot mono>
              {{ r.statusCode }}
            </UiBadge>
          </td>

          <td v-if="show('requestId')" class="max-w-[12rem]">
            <span class="flex min-w-0 items-center gap-0.5">
              <span class="truncate font-mono text-2xs text-fg-muted" :title="r.requestId">{{ r.requestId }}</span>
              <CopyButton :text="r.requestId" class="!h-5 !w-5 shrink-0" />
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.sort-th {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
  border-radius: 0.25rem;
  transition: color 150ms;
}
.sort-th:hover {
  color: rgb(var(--fg));
}
.sort-th:focus-visible {
  outline: 2px solid rgb(var(--accent) / 0.5);
  outline-offset: 2px;
}
</style>
