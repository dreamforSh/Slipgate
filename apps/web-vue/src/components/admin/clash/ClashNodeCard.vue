<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ClashExitNode } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { formatRelative, healthLabel, healthTone } from "../../../lib/format";

/** One exit node as a card (after the linksyncx node cards): health, exit IP, bindings, actions. */
const props = defineProps<{
  node: ClashExitNode;
  subscriptionName: string;
  accountNames: string[];
  busy: boolean;
  now: number;
}>();
const emit = defineEmits<{ (e: "toggle" | "probe" | "accept-exit"): void }>();

const { t } = useI18n();

const enabled = computed(() => props.node.enabled !== false);
const healthDot = computed(() => {
  const tone = healthTone(props.node.healthStatus);
  return tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : "bg-fg-subtle";
});
const endpoint = computed(() =>
  props.node.server ? `${props.node.server}:${props.node.serverPort ?? "-"}` : "-",
);
</script>

<template>
  <article
    class="card card-hover flex min-w-0 flex-col"
    :class="enabled ? '' : 'opacity-70'"
  >
    <header class="flex items-start gap-2.5 px-4 pt-4">
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-1.5">
          <h3 class="truncate text-sm font-semibold text-fg" :title="node.name">{{ node.name }}</h3>
          <UiBadge v-if="node.proxyType" mono class="shrink-0">{{ node.proxyType }}</UiBadge>
        </div>
        <p class="mt-0.5 truncate text-xs text-fg-muted" :title="`${subscriptionName} · ${endpoint}`">
          {{ subscriptionName }} · {{ t("clash.nodes.card.listener", { port: node.listenerPort }) }}
        </p>
      </div>
      <UiBadge v-if="!enabled" tone="neutral" class="shrink-0">{{ t("clash.nodes.card.disabled") }}</UiBadge>
      <UiBadge v-else :tone="healthTone(node.healthStatus)" dot class="shrink-0">{{ healthLabel(node.healthStatus) }}</UiBadge>
    </header>

    <p v-if="node.lastError" class="mx-4 mt-2 line-clamp-2 break-words text-xs text-danger" :title="node.lastError">
      {{ node.lastError }}
    </p>

    <!-- Key figures -->
    <div class="mx-4 mt-3 grid grid-cols-3 divide-x divide-line rounded-lg bg-surface-2/60 py-2 text-center">
      <div class="min-w-0 px-1.5">
        <p class="text-2xs text-fg-subtle">{{ t("clash.nodes.card.latency") }}</p>
        <p class="mt-0.5 flex items-center justify-center gap-1 text-sm">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="healthDot" aria-hidden="true" />
          <span class="font-mono tabular-nums text-fg">{{ node.latencyMs ? `${node.latencyMs}ms` : "-" }}</span>
        </p>
      </div>
      <div class="min-w-0 px-1.5">
        <p class="text-2xs text-fg-subtle">{{ t("clash.nodes.card.bound") }}</p>
        <p class="mt-0.5 font-mono text-sm tabular-nums" :class="node.boundAccounts >= node.maxAccounts ? 'text-warning' : 'text-fg'">
          {{ node.boundAccounts }}/{{ node.maxAccounts }}
        </p>
      </div>
      <div class="min-w-0 px-1.5" :title="endpoint">
        <p class="text-2xs text-fg-subtle">{{ t("clash.nodes.card.server") }}</p>
        <p class="mt-0.5 truncate font-mono text-xs leading-5 text-fg-muted">{{ endpoint }}</p>
      </div>
    </div>

    <!-- Exit IP -->
    <div class="mx-4 mb-3 mt-3 min-h-[2.75rem] text-xs">
      <div class="flex items-center gap-1.5">
        <UiIcon name="globe" :size="13" class="shrink-0 text-fg-subtle" />
        <span v-if="node.exitIp" class="font-mono text-fg">{{ node.exitIp }}</span>
        <span v-else class="italic text-fg-subtle">{{ t("clash.nodes.unprobed") }}</span>
        <span class="ml-auto shrink-0 text-2xs text-fg-subtle" :title="node.lastProbedAtIso">
          {{ node.lastProbedAtIso ? formatRelative(node.lastProbedAtIso, now) : t("clash.nodes.card.neverProbed") }}
        </span>
      </div>
      <div
        v-if="node.driftUnconfirmed"
        class="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md bg-warning/10 px-2 py-1 text-warning"
      >
        <UiIcon name="alert" :size="12" class="shrink-0" />
        <span>{{ t("clash.nodes.exitChanged") }}</span>
        <button
          type="button"
          class="ml-auto cursor-pointer font-semibold underline decoration-dotted underline-offset-2 disabled:opacity-50"
          :disabled="busy"
          @click="emit('accept-exit')"
        >
          {{ t("clash.actions.acceptExit") }}
        </button>
      </div>
    </div>

    <!-- Bindings + actions -->
    <footer class="mt-auto flex items-center gap-2 border-t border-line/70 px-4 py-2.5">
      <div class="flex min-w-0 flex-1 items-center gap-1 text-xs" :title="accountNames.join('\n') || undefined">
        <UiIcon name="link" :size="12" class="shrink-0 text-fg-subtle" />
        <template v-if="accountNames.length">
          <span class="truncate rounded bg-surface-2 px-1.5 py-0.5 text-fg-muted">{{ accountNames[0] }}</span>
          <span v-if="accountNames.length > 1" class="shrink-0 text-fg-subtle">+{{ accountNames.length - 1 }}</span>
        </template>
        <span v-else class="text-success">{{ t("clash.nodes.card.idle") }}</span>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-icon btn-xs"
        :disabled="busy"
        :title="t('clash.actions.check')"
        :aria-label="t('clash.actions.check')"
        @click="emit('probe')"
      >
        <UiIcon name="radar" :size="14" />
      </button>
      <UiSwitch
        :model-value="enabled"
        :disabled="busy"
        :label="enabled ? t('clash.nodes.disableNode') : t('clash.nodes.enableNode')"
        hide-label
        @update:model-value="emit('toggle')"
      />
    </footer>
  </article>
</template>
