<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { RequestErrorItem } from "@slipgate/contracts";
import { formatDurationMs } from "../../../lib/format";
import CopyButton from "../../ui/CopyButton.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import { statusTone } from "../ops-monitor/opsFormat";
import { phaseTone } from "./requestErrorDisplay";

/** Detail drawer of one request error: identity, routing, error text, upstream body, metadata. */
defineProps<{
  item: RequestErrorItem | null;
  togglingId: string | null;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ (e: "toggle", item: RequestErrorItem): void }>();

const { t } = useI18n();
</script>

<template>
  <UiDrawer v-model:open="open" :title="t('security.ops.requestErrors.drawer.title')" width="lg">
    <div v-if="item" class="space-y-5 p-5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <UiBadge :tone="phaseTone(item.phase)">
            {{ t(`security.ops.requestErrors.phases.${item.phase}`) }}
          </UiBadge>
          <UiBadge :tone="statusTone(item.statusCode)" mono>{{ item.statusCode }}</UiBadge>
          <UiBadge v-if="item.upstreamStatus > 0" tone="neutral" mono>upstream {{ item.upstreamStatus }}</UiBadge>
          <UiBadge :tone="item.resolved ? 'success' : 'danger'" dot>
            {{ item.resolved ? t("security.ops.requestErrors.table.resolvedBadge") : t("security.ops.requestErrors.table.openBadge") }}
          </UiBadge>
        </div>
        <button type="button" class="btn btn-primary btn-sm" :disabled="togglingId === item.id" @click="emit('toggle', item)">
          {{ item.resolved ? t("security.ops.requestErrors.table.reopen") : t("security.ops.requestErrors.table.resolve") }}
        </button>
      </div>

      <dl class="grid grid-cols-1 gap-3 rounded-xl border border-line bg-surface-2/40 p-4 text-xs sm:grid-cols-2">
        <div>
          <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.requestId") }}</dt>
          <dd class="mt-0.5 flex items-center gap-1 font-mono text-fg">
            <span class="break-all">{{ item.requestId || "—" }}</span>
            <CopyButton v-if="item.requestId" :text="item.requestId" class="!h-5 !w-5" />
          </dd>
        </div>
        <div>
          <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.clientRequestId") }}</dt>
          <dd class="mt-0.5 font-mono text-fg">{{ item.clientRequestId || "—" }}</dd>
        </div>
        <div>
          <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.model") }}</dt>
          <dd class="mt-0.5 font-mono text-fg">
            {{ item.model || "—" }}
            <span v-if="item.upstreamModel && item.upstreamModel !== item.model" class="text-fg-subtle">→ {{ item.upstreamModel }}</span>
          </dd>
        </div>
        <div>
          <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.account") }}</dt>
          <dd class="mt-0.5 text-fg">
            {{ item.accountName || item.accountId || "—" }}
            <span v-if="item.groupName" class="text-fg-subtle"> ({{ item.groupName }})</span>
          </dd>
        </div>
        <div>
          <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.user") }}</dt>
          <dd class="mt-0.5 text-fg">
            {{ item.userEmail || item.userId || "—" }}
            <span v-if="item.apiKeyId" class="font-mono text-fg-subtle"> · {{ item.apiKeyId }}</span>
          </dd>
        </div>
        <div>
          <dt class="text-fg-subtle">{{ t("security.ops.requestErrors.drawer.execution") }}</dt>
          <dd class="mt-0.5 font-mono text-fg">
            {{ item.executionMode || "—" }} · {{ formatDurationMs(item.durationMs) }} ·
            {{ t("security.ops.requestErrors.table.attemptN", { n: item.attempt }) }}
          </dd>
        </div>
      </dl>

      <div>
        <div class="mb-1.5 flex items-center justify-between">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            {{ t("security.ops.requestErrors.drawer.errorMessage") }}
          </h3>
          <CopyButton v-if="item.errorMessage" :text="item.errorMessage" />
        </div>
        <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2/60 p-3 font-mono text-xs text-fg">{{
          item.errorMessage || t("security.ops.requestErrors.drawer.emptyText")
        }}</pre>
      </div>

      <div>
        <div class="mb-1.5 flex items-center justify-between">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            {{ t("security.ops.requestErrors.drawer.upstreamBody") }}
          </h3>
          <CopyButton v-if="item.upstreamBody" :text="item.upstreamBody" />
        </div>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2/60 p-3 font-mono text-xs text-fg">{{
          item.upstreamBody || t("security.ops.requestErrors.drawer.emptyText")
        }}</pre>
      </div>

      <div>
        <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          {{ t("security.ops.requestErrors.drawer.metadata") }}
        </h3>
        <pre class="max-h-48 overflow-auto rounded-lg border border-line bg-surface-2/60 p-3 font-mono text-xs text-fg">{{
          JSON.stringify(item.metadata ?? {}, null, 2)
        }}</pre>
      </div>
    </div>
  </UiDrawer>
</template>
