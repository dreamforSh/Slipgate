<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ClashExitNode, ClashSubscription } from "@slipgate/contracts";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { formatRelative, healthTone } from "../../../lib/format";

/** One Clash subscription as a card: source, sync state, node health split, refresh/delete. */
const props = defineProps<{
  sub: ClashSubscription;
  /** Nodes this subscription produced. */
  nodes: ClashExitNode[];
  statusLabel: string;
  busy: boolean;
  now: number;
}>();
const emit = defineEmits<{ (e: "refresh" | "force-refresh" | "delete"): void }>();

const { t } = useI18n();

/** Subscription URLs usually carry a token in the path or query: show the origin only. */
const source = computed(() => {
  if (props.sub.sourceKind === "inline") {
    const lines = (props.sub.sourceUrl ?? "").split("\n").filter((l) => l.trim()).length;
    return t("clash.subscriptions.card.inlineLines", { count: lines });
  }
  try {
    const url = new URL(props.sub.sourceUrl ?? "");
    return url.pathname.length > 1 || url.search ? `${url.origin}/…` : url.origin;
  } catch {
    return "-";
  }
});

const healthy = computed(() => props.nodes.filter((n) => n.healthStatus === "healthy" && n.enabled !== false).length);
const bound = computed(() => props.nodes.reduce((sum, n) => sum + n.boundAccounts, 0));
const total = computed(() => Math.max(props.nodes.length, props.sub.lastNodeCount));
const healthyPct = computed(() => (total.value ? Math.round((healthy.value / total.value) * 100) : 0));
</script>

<template>
  <article class="card card-hover flex min-w-0 flex-col" :class="sub.enabled ? '' : 'opacity-70'">
    <header class="flex items-start gap-2.5 px-4 pt-4">
      <span class="icon-chip icon-chip-accent h-8 w-8 shrink-0">
        <UiIcon :name="sub.sourceKind === 'inline' ? 'file' : 'download'" :size="15" />
      </span>
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-sm font-semibold text-fg" :title="sub.name">{{ sub.name }}</h3>
        <p class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          <UiBadge class="shrink-0">{{ t(`clash.subscriptions.sourceKind.${sub.sourceKind}`) }}</UiBadge>
          <span class="truncate font-mono text-2xs" :title="source">{{ source }}</span>
        </p>
      </div>
      <UiBadge :tone="healthTone(sub.lastSyncStatus)" dot class="shrink-0" :title="sub.lastSyncStatus">{{ statusLabel }}</UiBadge>
    </header>

    <!-- Key figures -->
    <div class="mx-4 mt-3 grid grid-cols-3 divide-x divide-line rounded-lg bg-surface-2/60 py-2 text-center">
      <div class="px-1.5">
        <p class="text-2xs text-fg-subtle">{{ t("clash.subscriptions.card.nodes") }}</p>
        <p class="mt-0.5 font-mono text-sm tabular-nums text-fg">{{ total }}</p>
      </div>
      <div class="px-1.5">
        <p class="text-2xs text-fg-subtle">{{ t("clash.subscriptions.card.healthy") }}</p>
        <p class="mt-0.5 font-mono text-sm tabular-nums" :class="healthy ? 'text-success' : 'text-fg-subtle'">{{ healthy }}</p>
      </div>
      <div class="px-1.5">
        <p class="text-2xs text-fg-subtle">{{ t("clash.subscriptions.card.bound") }}</p>
        <p class="mt-0.5 font-mono text-sm tabular-nums text-fg">{{ bound }}</p>
      </div>
    </div>

    <!-- Health split -->
    <div class="mx-4 mt-3">
      <div class="flex items-center justify-between text-2xs text-fg-subtle">
        <span>{{ t("clash.subscriptions.card.healthRate") }}</span>
        <span class="font-mono tabular-nums">{{ healthyPct }}%</span>
      </div>
      <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" role="presentation">
        <div class="h-full rounded-full bg-success transition-[width] duration-300" :style="{ width: `${healthyPct}%` }" />
      </div>
    </div>

    <p class="mx-4 mb-3 mt-3 flex items-center gap-1.5 text-2xs text-fg-subtle" :title="sub.lastSyncAt ?? undefined">
      <UiIcon name="clock" :size="12" />
      {{ sub.lastSyncAt ? t("clash.subscriptions.card.lastSync", { time: formatRelative(sub.lastSyncAt, now) }) : t("clash.subscriptions.card.neverSynced") }}
    </p>

    <footer class="mt-auto flex items-center gap-1 border-t border-line/70 px-3 py-2.5">
      <button type="button" class="btn btn-ghost btn-xs" :disabled="busy" @click="emit('refresh')">
        <UiIcon name="refresh" :size="13" />
        {{ t("clash.actions.refreshNow") }}
      </button>
      <button type="button" class="btn btn-xs text-warning hover:bg-warning/10" :disabled="busy" @click="emit('force-refresh')">
        {{ t("clash.actions.forceRefresh") }}
      </button>
      <ConfirmButton icon-only class="ml-auto" :disabled="busy" @confirm="emit('delete')" />
    </footer>
  </article>
</template>
