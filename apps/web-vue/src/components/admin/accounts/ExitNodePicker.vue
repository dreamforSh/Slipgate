<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountExitBinding, ClashExitNode } from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import { compareNodes, matchesNode, nodeStatus, EMPTY_NODE_FILTER, type NodeSortKey } from "../clash/nodeFilters";
import { exitAvailability, isStaticExit, type ExitAvailability, type ExitPool } from "./exitPool";

/**
 * Exit proxy picker for one account (sub2api-style proxy selector): a summary button that opens an
 * inline panel with search, scope chips (usable / Clash / static IP), sorting, per-node and bulk
 * latency checks, and the reason an exit cannot take the account. Inline rather than a popover so
 * it never gets clipped inside the scrolling account dialog.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    pool: ExitPool;
    /** The account's current binding (its own node does not count as occupied). */
    current: AccountExitBinding | null;
    disabled?: boolean;
    /** Offer "no exit". */
    allowNone?: boolean;
    inputId?: string;
  }>(),
  { disabled: false, allowNone: true, inputId: undefined },
);
const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const { t } = useI18n();

type Scope = "all" | "usable" | "clash" | "static";
const open = ref(false);
const query = ref("");
const scope = ref<Scope>("usable");
const sort = ref<NodeSortKey>("recommended");
const probing = ref<Set<string>>(new Set());
const probeError = ref<string | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);

interface Row {
  node: ClashExitNode;
  availability: ExitAvailability;
  selectable: boolean;
  isStatic: boolean;
}

const rows = computed<Row[]>(() =>
  props.pool.nodes.map((node) => {
    const availability = exitAvailability(node, props.current);
    return {
      node,
      availability,
      // The account's current exit stays selectable even when it is no longer healthy.
      selectable: availability === "ok" || node.nodeId === props.current?.nodeId,
      isStatic: isStaticExit(node),
    };
  }),
);

const counts = computed(() => ({
  all: rows.value.length,
  usable: rows.value.filter((r) => r.selectable).length,
  clash: rows.value.filter((r) => !r.isStatic).length,
  static: rows.value.filter((r) => r.isStatic).length,
}));

const shown = computed(() =>
  rows.value
    .filter((r) => {
      if (scope.value === "usable" && !r.selectable) return false;
      if (scope.value === "clash" && r.isStatic) return false;
      if (scope.value === "static" && !r.isStatic) return false;
      return matchesNode(r.node, { ...EMPTY_NODE_FILTER, query: query.value });
    })
    .sort((a, b) => compareNodes(a.node, b.node, sort.value)),
);

const selected = computed(() => (props.modelValue ? (props.pool.nodeById.get(props.modelValue) ?? null) : null));

const STATUS_DOT: Record<string, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  unhealthy: "bg-danger",
  unprobed: "bg-fg-subtle",
  drift: "bg-danger",
  disabled: "bg-fg-subtle",
};

function latencyClass(ms: number): string {
  if (ms <= 0) return "text-fg-subtle";
  if (ms < 150) return "text-success";
  if (ms < 400) return "text-warning";
  return "text-danger";
}

async function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    // Start from every exit when nothing usable is left, so the reasons are visible.
    if (counts.value.usable === 0) scope.value = "all";
    await nextTick();
    searchInput.value?.focus();
  }
}

function pick(value: string) {
  emit("update:modelValue", value);
  open.value = false;
  query.value = "";
}

async function probe(nodeIds: string[]) {
  if (!nodeIds.length) return;
  probeError.value = null;
  probing.value = new Set([...probing.value, ...nodeIds]);
  try {
    const err = await props.pool.probe(nodeIds);
    if (err) probeError.value = err;
  } finally {
    const next = new Set(probing.value);
    for (const id of nodeIds) next.delete(id);
    probing.value = next;
  }
}

const SCOPES: Scope[] = ["usable", "all", "clash", "static"];
</script>

<template>
  <div class="space-y-2">
    <!-- Summary / trigger -->
    <button
      :id="inputId"
      type="button"
      class="input flex h-auto min-h-[2.5rem] w-full items-center gap-2 py-1.5 text-left"
      :class="disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
    >
      <template v-if="selected">
        <span class="h-2 w-2 shrink-0 rounded-full" :class="STATUS_DOT[nodeStatus(selected)]" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-fg">{{ selected.name }}</span>
          <span class="block truncate font-mono text-2xs text-fg-subtle">
            {{ selected.proxyType ? selected.proxyType.toUpperCase() + " · " : "" }}{{ selected.exitIp || t("accounts.form.exit.unprobed") }}
            <template v-if="selected.latencyMs > 0"> · {{ selected.latencyMs }} ms</template>
          </span>
        </span>
      </template>
      <span v-else class="flex-1 text-sm text-fg-muted">{{ t("accounts.form.exit.none") }}</span>
      <UiIcon name="chevron-down" :size="14" class="shrink-0 text-fg-subtle transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>

    <!-- Inline panel -->
    <div v-if="open" class="rounded-xl border border-line bg-surface shadow-sm">
      <div class="space-y-2 border-b border-line/70 p-2.5">
        <div class="relative">
          <UiIcon name="search" :size="13" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            ref="searchInput"
            v-model="query"
            type="search"
            class="input input-sm pl-8"
            :placeholder="t('accounts.exitPicker.search')"
            :aria-label="t('accounts.exitPicker.search')"
            @keydown.escape.prevent="open = false"
          />
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="s in SCOPES"
            :key="s"
            type="button"
            class="rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset transition-colors"
            :class="scope === s ? 'bg-accent/10 text-accent ring-accent/30' : 'text-fg-muted ring-line hover:text-fg'"
            :aria-pressed="scope === s"
            @click="scope = s"
          >
            {{ t(`accounts.exitPicker.scopes.${s}`) }} {{ counts[s] }}
          </button>
          <select v-model="sort" class="ml-auto rounded-md border border-line bg-surface px-1.5 py-0.5 text-2xs text-fg-muted" :aria-label="t('clash.filters.sort')">
            <option value="recommended">{{ t("clash.filters.sorts.recommended") }}</option>
            <option value="latency">{{ t("clash.filters.sorts.latency") }}</option>
            <option value="name">{{ t("clash.filters.sorts.name") }}</option>
          </select>
          <button
            type="button"
            class="inline-flex items-center gap-1 text-2xs font-medium text-accent hover:underline disabled:opacity-50"
            :disabled="probing.size > 0 || shown.length === 0"
            @click="probe(shown.slice(0, 50).map((r) => r.node.nodeId))"
          >
            <UiIcon :name="probing.size > 0 ? 'loader' : 'radar'" :size="11" :spin="probing.size > 0" />
            {{ t("accounts.exitPicker.probeShown", { n: Math.min(shown.length, 50) }) }}
          </button>
        </div>
        <p v-if="probeError" class="truncate text-2xs text-danger" :title="probeError">{{ probeError }}</p>
      </div>

      <ul class="max-h-72 overflow-y-auto p-1" role="listbox" :aria-label="t('accounts.form.exit.node')">
        <li v-if="allowNone">
          <button
            type="button"
            role="option"
            :aria-selected="!modelValue"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
            :class="!modelValue ? 'bg-accent/[0.07]' : ''"
            @click="pick('')"
          >
            <UiIcon name="unlink" :size="13" class="text-fg-subtle" />
            <span class="flex-1 text-fg-muted">{{ t("accounts.form.exit.none") }}</span>
            <UiIcon v-if="!modelValue" name="check" :size="13" class="text-accent" />
          </button>
        </li>
        <li v-for="r in shown" :key="r.node.nodeId">
          <div
            role="option"
            :aria-selected="modelValue === r.node.nodeId"
            :aria-disabled="!r.selectable || undefined"
            :tabindex="r.selectable ? 0 : -1"
            class="group flex items-center gap-2 rounded-lg px-2.5 py-2"
            :class="[
              r.selectable ? 'cursor-pointer hover:bg-surface-2' : 'cursor-not-allowed opacity-55',
              modelValue === r.node.nodeId ? 'bg-accent/[0.07] ring-1 ring-inset ring-accent/25' : '',
            ]"
            @click="r.selectable && pick(r.node.nodeId)"
            @keydown.enter.prevent="r.selectable && pick(r.node.nodeId)"
          >
            <span class="h-2 w-2 shrink-0 rounded-full" :class="STATUS_DOT[nodeStatus(r.node)]" />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate text-sm text-fg">{{ r.node.name }}</span>
                <span class="shrink-0 rounded bg-surface-2 px-1 text-[10px] font-medium uppercase text-fg-muted">
                  {{ r.isStatic ? t("accounts.exitPicker.static") : r.node.proxyType || "clash" }}
                </span>
                <span v-if="r.node.nodeId === current?.nodeId" class="shrink-0 text-[10px] font-medium text-accent">
                  {{ t("accounts.exitPicker.current") }}
                </span>
              </span>
              <span class="mt-0.5 flex items-center gap-2 font-mono text-2xs text-fg-subtle">
                <span class="truncate">{{ r.node.exitIp || t("accounts.form.exit.unprobed") }}</span>
                <span v-if="r.node.server" class="hidden truncate sm:inline">{{ r.node.server }}{{ r.node.serverPort ? `:${r.node.serverPort}` : "" }}</span>
              </span>
              <span v-if="!r.selectable" class="mt-0.5 block text-2xs text-warning">
                {{ t(`accounts.form.exit.reasons.${r.availability}`) }}
              </span>
            </span>
            <span class="shrink-0 text-right">
              <span class="block font-mono text-xs tabular-nums" :class="latencyClass(r.node.latencyMs)">
                {{ r.node.latencyMs > 0 ? `${r.node.latencyMs} ms` : "—" }}
              </span>
              <span class="block font-mono text-2xs tabular-nums text-fg-subtle" :title="t('accounts.exitPicker.occupancy')">
                {{ r.node.boundAccounts }}/{{ r.node.maxAccounts }}
              </span>
            </span>
            <button
              type="button"
              class="shrink-0 rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-accent disabled:opacity-50"
              :title="t('accounts.exitPicker.probe')"
              :aria-label="t('accounts.exitPicker.probe')"
              :disabled="probing.has(r.node.nodeId)"
              @click.stop="probe([r.node.nodeId])"
            >
              <UiIcon :name="probing.has(r.node.nodeId) ? 'loader' : 'radar'" :size="12" :spin="probing.has(r.node.nodeId)" />
            </button>
            <UiIcon v-if="modelValue === r.node.nodeId" name="check" :size="13" class="shrink-0 text-accent" />
          </div>
        </li>
        <li v-if="shown.length === 0" class="px-3 py-6 text-center text-xs text-fg-subtle">
          {{ rows.length === 0 ? t("accounts.exitPicker.empty") : t("clash.filters.noMatch") }}
        </li>
      </ul>
      <p class="border-t border-line/70 px-3 py-1.5 text-2xs text-fg-subtle">
        {{ t("clash.filters.count", { shown: shown.length, total: rows.length }) }}
      </p>
    </div>
  </div>
</template>
