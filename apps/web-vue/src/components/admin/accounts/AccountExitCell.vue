<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountExitBinding, ClashExitNode, ExecutionMode } from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import { isStaticExit, modeUsesExit } from "./exitPool";

/**
 * An account's exit proxy for the table and the cards: node name, exit IP, latency and health, or
 * why there is none. Unbound exit-routed accounts (HTTP direct / VM slot) are flagged because
 * slipgate-net refuses their traffic until an exit is bound.
 */
const props = defineProps<{
  mode: ExecutionMode;
  binding: AccountExitBinding | null;
  node: ClashExitNode | null;
  /** False when the exit pool is unknown (no slipgate-net or the overview failed). */
  ready: boolean;
  /** One line (cards) instead of two (table). */
  inline?: boolean;
  /** Render as a button that asks to change the exit. */
  editable?: boolean;
}>();
const emit = defineEmits<{ (e: "change"): void }>();

const { t } = useI18n();

const HEALTH_DOT: Record<string, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  circuit_open: "bg-danger",
  unknown: "bg-fg-subtle",
};

const state = computed<"unknown" | "bound" | "gone" | "missing" | "direct">(() => {
  if (!props.ready) return "unknown";
  if (props.binding) return props.node ? "bound" : "gone";
  return modeUsesExit(props.mode) ? "missing" : "direct";
});

const problem = computed(() => {
  const n = props.node;
  if (!n) return "";
  if (n.enabled === false) return t("accounts.exit.problems.disabled");
  if (n.driftUnconfirmed) return t("accounts.exit.problems.drift");
  if (n.healthStatus !== "healthy") return t("accounts.exit.problems.unhealthy");
  return "";
});

const detail = computed(() => {
  const n = props.node;
  if (!n) return "";
  return [n.exitIp || t("accounts.exit.unprobed"), n.latencyMs > 0 ? `${n.latencyMs} ms` : ""].filter(Boolean).join(" · ");
});

const title = computed(() => {
  switch (state.value) {
    case "unknown":
      return t("accounts.exit.unknownHint");
    case "missing":
      return t("accounts.exit.missingHint");
    case "direct":
      return t("accounts.exit.directHint");
    case "gone":
      return t("accounts.exit.goneHint", { id: props.binding?.nodeId ?? "" });
    default: {
      const n = props.node!;
      const where = n.server ? `${n.proxyType ? `${n.proxyType.toUpperCase()} ` : ""}${n.server}${n.serverPort ? `:${n.serverPort}` : ""}` : "";
      const note = modeUsesExit(props.mode) ? "" : t("accounts.exit.directBoundHint");
      return [n.name, where, detail.value, problem.value, note].filter(Boolean).join("\n");
    }
  }
});
</script>

<template>
  <component
    :is="editable ? 'button' : 'div'"
    :type="editable ? 'button' : undefined"
    class="min-w-0 text-left"
    :class="[
      inline ? 'flex items-center gap-1.5 text-xs' : 'block',
      editable ? 'group -mx-1 cursor-pointer rounded-md px-1 py-0.5 hover:bg-accent/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent' : '',
    ]"
    :title="editable ? `${title}\n${t('accounts.exitPicker.clickToChange')}` : title"
    @click="editable && emit('change')"
  >
    <template v-if="state === 'bound' && node">
      <!-- Inline (cards): the name keeps up to 60% of the row, the IP / latency shrink first -->
      <span class="flex min-w-0 items-center gap-1.5" :class="inline ? 'max-w-[60%] shrink-0' : 'text-xs'">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="problem ? HEALTH_DOT[node.healthStatus] ?? 'bg-warning' : 'bg-success'" />
        <span class="truncate font-medium text-fg">{{ node.name }}</span>
        <span
          v-if="isStaticExit(node)"
          class="shrink-0 rounded bg-surface-2 px-1 py-px text-[0.625rem] font-semibold uppercase tracking-wide text-fg-subtle"
        >
          IP
        </span>
      </span>
      <span class="truncate font-mono text-2xs" :class="[inline ? 'min-w-0 flex-1' : 'mt-0.5 block', problem ? 'text-warning' : 'text-fg-subtle']">
        {{ problem || detail }}
      </span>
    </template>
    <span v-else-if="state === 'gone'" class="inline-flex items-center gap-1 text-xs text-warning">
      <UiIcon name="alert" :size="12" />
      {{ t("accounts.exit.gone") }}
    </span>
    <span v-else-if="state === 'missing'" class="inline-flex items-center gap-1 text-xs font-medium text-warning">
      <UiIcon name="alert" :size="12" />
      {{ t("accounts.exit.missing") }}
    </span>
    <span v-else-if="state === 'direct'" class="inline-flex items-center gap-1 text-xs text-fg-subtle">
      <UiIcon name="zap" :size="11" />
      {{ t("accounts.exit.direct") }}
    </span>
    <span v-else class="text-xs text-fg-subtle">—</span>
    <UiIcon v-if="editable" name="pencil" :size="10" class="ml-0.5 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" />
  </component>
</template>
