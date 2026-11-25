<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  STATIC_IP_SUBSCRIPTION_PREFIX,
  isStaticIpSubscription,
  parseStaticIpLine,
  readStaticIpClashYaml,
  staticIpAddress,
  staticIpClashYaml,
  staticIpKey,
  type AccountExitBinding,
  type ClashExitNode,
  type ClashSubscription,
  type StaticIpParseError,
  type StaticIpProtocol,
  type StaticIpProxy,
  type UpstreamAccount,
} from "@slipgate/contracts";
import StaticIpCard from "../../components/admin/clash/StaticIpCard.vue";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiModal from "../../components/ui/UiModal.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { useNow } from "../../composables/useNow";
import { usePersistentState } from "../../composables/usePersistentState";
import { formatDateShort, healthLabel, healthTone, type Tone } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import { NODE_BIND_FILTERS, nodeBindState, type NodeBindFilter } from "../../components/admin/clash/nodeFilters";
import UiSelect from "../../components/ui/UiSelect.vue";

/**
 * Static IP proxies (SOCKS5 / HTTP / HTTPS), after the linksyncx IP management page. Each IP
 * joins the exit pool as a single-node inline subscription (`ip-*`), so it gets a mihomo
 * listener, exit-IP probing and account binding like any Clash exit and stays fail-closed.
 */
const { t } = useI18n();
const auth = useAuthStore();

interface OverviewPayload {
  subscriptions: ClashSubscription[];
  nodes: ClashExitNode[];
  bindings: AccountExitBinding[];
}

interface IpRow {
  id: string;
  name: string;
  sub: ClashSubscription;
  node: ClashExitNode | null;
  protocol: StaticIpProtocol | null;
  address: string;
  username: string;
  hasPassword: boolean;
  key: string;
  accountNames: string[];
}

const loading = ref(false);
const busy = ref(false);
const errorMessage = ref<string | null>(null);
const notice = ref<string | null>(null);
useFeedbackToasts(errorMessage, notice);

const subscriptions = ref<ClashSubscription[]>([]);
const nodes = ref<ClashExitNode[]>([]);
const bindings = ref<AccountExitBinding[]>([]);
const accounts = ref<UpstreamAccount[]>([]);

const search = ref("");
type ProtocolFilter = "all" | StaticIpProtocol;
type StatusFilter = "all" | "healthy" | "unhealthy" | "disabled" | "pending";
const protocolFilter = ref<ProtocolFilter>("all");
const statusFilter = ref<StatusFilter>("all");
/** Occupancy filter and sort order, shared vocabulary with the Clash node list. */
const bindFilter = ref<NodeBindFilter>("all");
type IpSortKey = "created" | "name" | "latency" | "bound";
const ipSort = ref<IpSortKey>("created");

type ViewMode = "card" | "table";
/** Cards by default, like the Clash node and subscription lists. */
const viewMode = usePersistentState<ViewMode>("slipgate.proxyIps.view", "card", (v): v is ViewMode => v === "card" || v === "table");
const viewOptions = computed(() => [
  { value: "card" as const, label: t("clash.view.card") },
  { value: "table" as const, label: t("clash.view.table") },
]);
const now = useNow();

/* ---------------- Data ---------------- */

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return data.message ?? data.error ?? fallback;
}

async function load() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const [ovRes, accRes] = await Promise.all([
      auth.apiFetch("/api/v1/admin/clash/overview"),
      auth.apiFetch("/api/v1/admin/accounts"),
    ]);
    if (!ovRes.ok) {
      errorMessage.value = await readError(ovRes, t("clash.ips.toast.loadFailed"));
    } else {
      const ov = (await ovRes.json()) as OverviewPayload;
      subscriptions.value = ov.subscriptions ?? [];
      nodes.value = ov.nodes ?? [];
      bindings.value = ov.bindings ?? [];
    }
    if (accRes.ok) accounts.value = ((await accRes.json()) as { accounts: UpstreamAccount[] }).accounts ?? [];
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("clash.ips.toast.loadFailed");
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const accountNameById = computed(() => new Map(accounts.value.map((a) => [a.id, a.name])));

const rows = computed<IpRow[]>(() => {
  const nodeBySub = new Map(nodes.value.map((n) => [n.subscriptionId, n]));
  return subscriptions.value
    .filter((s) => isStaticIpSubscription(s.id))
    .map((sub) => {
      const node = nodeBySub.get(sub.id) ?? null;
      const info = readStaticIpClashYaml(sub.sourceUrl ?? "");
      const host = info?.host ?? node?.server ?? "";
      const port = info?.port ?? node?.serverPort ?? 0;
      return {
        id: sub.id,
        name: sub.name,
        sub,
        node,
        protocol: info?.protocol ?? null,
        address: host ? staticIpAddress({ host, port }) : "-",
        username: info?.username ?? "",
        hasPassword: info?.hasPassword ?? false,
        key: host ? staticIpKey({ host, port, username: info?.username ?? "" }) : sub.id,
        accountNames: node
          ? bindings.value.filter((b) => b.nodeId === node.nodeId).map((b) => accountNameById.value.get(b.accountId) ?? b.accountId)
          : [],
      };
    })
    .sort((a, b) => b.sub.createdAt.localeCompare(a.sub.createdAt));
});

function rowStatus(row: IpRow): Exclude<StatusFilter, "all"> {
  if (!row.node) return "pending";
  if (row.node.enabled === false) return "disabled";
  return row.node.healthStatus === "healthy" ? "healthy" : "unhealthy";
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return rows.value.filter((r) => {
    if (protocolFilter.value !== "all" && r.protocol !== protocolFilter.value) return false;
    if (statusFilter.value !== "all" && rowStatus(r) !== statusFilter.value) return false;
    if (bindFilter.value !== "all") {
      const state = r.node ? nodeBindState(r.node) : "free";
      if (bindFilter.value === "bound" && state === "free") return false;
      if (bindFilter.value === "free" && state !== "free") return false;
      if (bindFilter.value === "full" && state !== "full") return false;
    }
    if (!q) return true;
    return [r.name, r.address, r.username, r.node?.exitIp ?? "", ...r.accountNames].some((v) => v.toLowerCase().includes(q));
  }).sort((a, b) => {
    switch (ipSort.value) {
      case "name":
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      case "latency": {
        const lat = (r: IpRow) => (r.node && r.node.latencyMs > 0 ? r.node.latencyMs : Number.MAX_SAFE_INTEGER);
        return lat(a) - lat(b);
      }
      case "bound":
        return (b.node?.boundAccounts ?? 0) - (a.node?.boundAccounts ?? 0);
      default:
        return 0; // rows already come newest first
    }
  });
});
const filtersActive = computed(
  () => !!search.value.trim() || protocolFilter.value !== "all" || statusFilter.value !== "all" || bindFilter.value !== "all",
);
function clearFilters() {
  search.value = "";
  protocolFilter.value = "all";
  statusFilter.value = "all";
  bindFilter.value = "all";
}

const stats = computed(() => {
  const list = rows.value;
  return {
    total: list.length,
    healthy: list.filter((r) => rowStatus(r) === "healthy").length,
    bound: list.reduce((sum, r) => sum + (r.node?.boundAccounts ?? 0), 0),
    attention: list.filter((r) => rowStatus(r) === "unhealthy" || rowStatus(r) === "pending" || r.node?.driftUnconfirmed).length,
  };
});

const protocolOptions = computed(() => [
  { value: "all" as const, label: t("clash.ips.filters.allProtocols") },
  { value: "socks5" as const, label: "SOCKS5" },
  { value: "http" as const, label: "HTTP" },
  { value: "https" as const, label: "HTTPS" },
]);
const statusOptions = computed(() =>
  (["all", "healthy", "unhealthy", "disabled", "pending"] as const).map((v) => ({ value: v, label: t(`clash.ips.filters.status.${v}`) })),
);

const PROTOCOL_TONE: Record<StaticIpProtocol, Tone> = { socks5: "violet", http: "info", https: "success" };
const PROTOCOL_LABEL: Record<StaticIpProtocol, string> = { socks5: "SOCKS5", http: "HTTP", https: "HTTPS" };

/* ---------------- Row actions ---------------- */

async function probe(nodeIds: string[]) {
  if (!nodeIds.length) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/clash/nodes/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeIds, verifyExitIp: true }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.ips.toast.checkFailed"));
      return;
    }
    notice.value = t("clash.ips.toast.checked", { count: nodeIds.length });
    await load();
  } finally {
    busy.value = false;
  }
}

async function toggleEnabled(row: IpRow) {
  if (!row.node) return;
  busy.value = true;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/nodes/${encodeURIComponent(row.node.nodeId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: row.node.enabled === false }),
    });
    if (!res.ok) errorMessage.value = await readError(res, t("clash.ips.toast.toggleFailed"));
    await load();
  } finally {
    busy.value = false;
  }
}

async function confirmDrift(row: IpRow) {
  if (!row.node) return;
  busy.value = true;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/nodes/${encodeURIComponent(row.node.nodeId)}/confirm-drift`, { method: "POST" });
    if (!res.ok) errorMessage.value = await readError(res, t("clash.ips.toast.acceptFailed"));
    await load();
  } finally {
    busy.value = false;
  }
}

async function resync(row: IpRow) {
  busy.value = true;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/subscriptions/${encodeURIComponent(row.id)}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    if (!res.ok) errorMessage.value = await readError(res, t("clash.ips.toast.syncFailed"));
    await load();
  } finally {
    busy.value = false;
  }
}

async function remove(row: IpRow) {
  busy.value = true;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/subscriptions/${encodeURIComponent(row.id)}`, { method: "DELETE" });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.ips.toast.deleteFailed"));
      return;
    }
    notice.value = t("clash.ips.toast.deleted", { name: row.name });
    await load();
  } finally {
    busy.value = false;
  }
}

/* ---------------- Add dialog (single / batch) ---------------- */

const addOpen = ref(false);
type AddMode = "single" | "batch";
const addMode = ref<AddMode>("single");
const addModeOptions = computed(() => [
  { value: "single" as const, label: t("clash.ips.add.single") },
  { value: "batch" as const, label: t("clash.ips.add.batch") },
]);
const formName = ref("");
const formProtocol = ref<StaticIpProtocol>("socks5");
const formHost = ref("");
const formPort = ref<number | null>(null);
const formUser = ref("");
const formPass = ref("");
const batchText = ref("");
const batchProtocol = ref<StaticIpProtocol>("socks5");
const batchPrefix = ref("");
const adding = ref(false);
const progress = ref({ done: 0, total: 0 });

watch(addOpen, (open) => {
  if (!open) return;
  addMode.value = "single";
  formName.value = "";
  formProtocol.value = "socks5";
  formHost.value = "";
  formPort.value = null;
  formUser.value = "";
  formPass.value = "";
  batchText.value = "";
  batchProtocol.value = "socks5";
  batchPrefix.value = "";
  progress.value = { done: 0, total: 0 };
});

const existingKeys = computed(() => new Set(rows.value.map((r) => r.key)));

/** Host and port go through the line parser for validation; credentials are taken as typed. */
const singleParsed = computed(() => {
  const host = formHost.value.trim().replace(/^\[|\]$/g, "");
  const res = parseStaticIpLine(`${host.includes(":") ? `[${host}]` : host}:${formPort.value ?? ""}`, formProtocol.value);
  return res.ok ? { ok: true as const, proxy: { ...res.proxy, username: formUser.value.trim(), password: formPass.value } } : res;
});
const singleError = computed<StaticIpParseError | "duplicate" | null>(() => {
  if (!formHost.value.trim() && formPort.value === null) return null;
  if (!singleParsed.value.ok) return singleParsed.value.error;
  return existingKeys.value.has(staticIpKey(singleParsed.value.proxy)) ? "duplicate" : null;
});

interface BatchLine {
  line: number;
  text: string;
  proxy: StaticIpProxy | null;
  error: StaticIpParseError | "duplicate" | null;
}

const batchLines = computed<BatchLine[]>(() => {
  const seen = new Set(existingKeys.value);
  const out: BatchLine[] = [];
  batchText.value.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.trim();
    if (!text || text.startsWith("#")) return;
    const parsed = parseStaticIpLine(text, batchProtocol.value);
    if (!parsed.ok) {
      out.push({ line: i + 1, text, proxy: null, error: parsed.error });
      return;
    }
    const key = staticIpKey(parsed.proxy);
    out.push({ line: i + 1, text, proxy: parsed.proxy, error: seen.has(key) ? "duplicate" : null });
    seen.add(key);
  });
  return out;
});
const batchValid = computed(() => batchLines.value.filter((l) => l.proxy && !l.error));
const batchInvalid = computed(() => batchLines.value.filter((l) => l.error));

const canAdd = computed(() => {
  if (adding.value) return false;
  if (addMode.value === "single") return singleParsed.value.ok && !singleError.value;
  return batchValid.value.length > 0;
});

function errorText(error: StaticIpParseError | "duplicate"): string {
  return t(`clash.ips.errors.${error}`);
}

function newSubscriptionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return STATIC_IP_SUBSCRIPTION_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function createOne(proxy: StaticIpProxy, name: string): Promise<{ ok: boolean; message?: string }> {
  const res = await auth.apiFetch("/api/v1/admin/clash/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: newSubscriptionId(),
      name,
      sourceKind: "inline",
      sourceUrl: staticIpClashYaml(proxy, name),
      // Never matches a non-empty name: the default filter is meant for provider info nodes.
      excludeRegex: "$^",
      autoSync: true,
    }),
  });
  return res.ok ? { ok: true } : { ok: false, message: await readError(res, t("clash.ips.toast.addFailed")) };
}

async function submitAdd() {
  if (!canAdd.value) return;
  adding.value = true;
  errorMessage.value = null;
  const items =
    addMode.value === "single" && singleParsed.value.ok
      ? [{ proxy: singleParsed.value.proxy, name: formName.value.trim() || staticIpAddress(singleParsed.value.proxy) }]
      : batchValid.value.map((l, i) => ({
          proxy: l.proxy!,
          name: batchPrefix.value.trim()
            ? `${batchPrefix.value.trim()}-${String(i + 1).padStart(2, "0")}`
            : staticIpAddress(l.proxy!),
        }));
  progress.value = { done: 0, total: items.length };
  let created = 0;
  const failures: string[] = [];
  try {
    // One at a time: each create re-renders the mihomo config, so parallel calls only queue up.
    for (const item of items) {
      const res = await createOne(item.proxy, item.name.slice(0, 100));
      if (res.ok) created += 1;
      else failures.push(`${item.name}: ${res.message}`);
      progress.value = { done: progress.value.done + 1, total: items.length };
    }
  } finally {
    adding.value = false;
  }
  await load();
  if (created) notice.value = t("clash.ips.toast.added", { count: created });
  if (failures.length) {
    errorMessage.value = t("clash.ips.toast.addPartial", { count: failures.length, first: failures[0] });
    return;
  }
  addOpen.value = false;
  // New exits have no verified exit IP yet; check them right away.
  const fresh = nodes.value.filter((n) => isStaticIpSubscription(n.subscriptionId) && !n.exitIp).map((n) => n.nodeId);
  if (fresh.length) void probe(fresh);
}

const uncheckedIds = computed(() => rows.value.filter((r) => r.node).map((r) => r.node!.nodeId));
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.proxyIps')">
      <template #meta>
        <span class="text-sm text-fg-muted">{{ t("clash.ips.subtitle") }}</span>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading || busy" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button type="button" class="btn btn-secondary" :disabled="busy || uncheckedIds.length === 0" @click="probe(uncheckedIds)">
          <UiIcon :name="busy ? 'loader' : 'radar'" :size="15" :spin="busy" />
          {{ t("clash.ips.actions.checkAll") }}
        </button>
        <button type="button" class="btn btn-primary" @click="addOpen = true">
          <UiIcon name="plus" :size="15" />
          {{ t("clash.ips.actions.add") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard :label="t('clash.ips.stats.total')" :value="stats.total" icon="route" tone="accent" />
      <StatCard :label="t('clash.ips.stats.healthy')" :value="`${stats.healthy} / ${stats.total}`" icon="radar" tone="success" />
      <StatCard :label="t('clash.ips.stats.bound')" :value="stats.bound" icon="link" tone="info" />
      <StatCard
        :label="t('clash.ips.stats.attention')"
        :value="stats.attention"
        icon="alert"
        :tone="stats.attention > 0 ? 'warning' : 'neutral'"
      />
    </div>

    <div class="card">
      <!-- Toolbar -->
      <div class="flex flex-col gap-3 border-b border-line px-5 py-3 lg:flex-row lg:items-center">
        <label class="relative min-w-0 flex-1">
          <UiIcon name="search" :size="15" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input v-model="search" type="search" :placeholder="t('clash.ips.filters.search')" class="input input-sm pl-9" />
        </label>
        <div class="flex flex-wrap items-center gap-2">
          <UiSelect v-model="protocolFilter" class="select input-sm w-36" :aria-label="t('clash.ips.columns.protocol')">
            <option v-for="o in protocolOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </UiSelect>
          <UiSelect v-model="statusFilter" class="select input-sm w-36" :aria-label="t('clash.ips.columns.status')">
            <option v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </UiSelect>
          <UiSelect v-model="bindFilter" class="select input-sm w-32" :aria-label="t('clash.filters.bind')">
            <option v-for="b in NODE_BIND_FILTERS" :key="b" :value="b">{{ t(`clash.filters.binds.${b}`) }}</option>
          </UiSelect>
          <UiSelect v-model="ipSort" class="select input-sm w-32" :aria-label="t('clash.filters.sort')">
            <option value="created">{{ t("clash.ips.sortNewest") }}</option>
            <option value="name">{{ t("clash.filters.sorts.name") }}</option>
            <option value="latency">{{ t("clash.filters.sorts.latency") }}</option>
            <option value="bound">{{ t("clash.filters.sorts.bound") }}</option>
          </UiSelect>
          <span class="text-2xs text-fg-subtle">{{ t("clash.filters.count", { shown: filtered.length, total: rows.length }) }}</span>
          <button v-if="filtersActive" type="button" class="btn btn-ghost btn-xs" @click="clearFilters">
            <UiIcon name="x" :size="12" />
            {{ t("clash.filters.clear") }}
          </button>
          <SegmentedControl v-model="viewMode" :options="viewOptions" />
        </div>
      </div>

      <EmptyState v-if="!loading && rows.length === 0" icon="route" :title="t('clash.ips.empty')">
        <div class="flex flex-col items-center gap-3">
          <p class="max-w-md text-sm text-fg-muted">{{ t("clash.ips.emptyHint") }}</p>
          <button type="button" class="btn btn-primary btn-sm" @click="addOpen = true">
            <UiIcon name="plus" :size="14" />
            {{ t("clash.ips.actions.add") }}
          </button>
        </div>
      </EmptyState>
      <EmptyState v-else-if="!loading && filtered.length === 0" compact icon="search" :title="t('clash.ips.noMatch')" />
      <div v-else-if="viewMode === 'card'" class="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
        <StaticIpCard
          v-for="row in filtered"
          :key="row.id"
          :row="row"
          :busy="busy"
          :now="now"
          @toggle="toggleEnabled(row)"
          @probe="row.node && probe([row.node.nodeId])"
          @accept-exit="confirmDrift(row)"
          @retry="resync(row)"
          @delete="remove(row)"
        />
      </div>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("clash.ips.columns.name") }}</th>
              <th>{{ t("clash.ips.columns.protocol") }}</th>
              <th>{{ t("clash.ips.columns.address") }}</th>
              <th>{{ t("clash.ips.columns.auth") }}</th>
              <th>{{ t("clash.ips.columns.exitIp") }}</th>
              <th>{{ t("clash.ips.columns.accounts") }}</th>
              <th>{{ t("clash.ips.columns.latency") }}</th>
              <th>{{ t("clash.ips.columns.createdAt") }}</th>
              <th>{{ t("clash.ips.columns.status") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filtered" :key="row.id" :class="row.node?.enabled === false ? 'opacity-60' : ''">
              <td class="max-w-[12rem]">
                <p class="truncate font-medium text-fg" :title="row.name">{{ row.name }}</p>
                <p v-if="!row.node" class="mt-0.5 truncate text-2xs text-danger" :title="row.sub.lastSyncStatus">
                  {{ t("clash.ips.syncFailed") }}
                </p>
                <p v-else-if="row.node.lastError" class="mt-0.5 truncate text-2xs text-danger" :title="row.node.lastError">
                  {{ row.node.lastError }}
                </p>
              </td>
              <td>
                <UiBadge v-if="row.protocol" :tone="PROTOCOL_TONE[row.protocol]" mono>{{ PROTOCOL_LABEL[row.protocol] }}</UiBadge>
                <span v-else class="text-fg-subtle">-</span>
              </td>
              <td><span class="code-chip">{{ row.address }}</span></td>
              <td class="whitespace-nowrap text-xs">
                <span v-if="row.username" class="inline-flex items-center gap-1 text-fg-muted" :title="row.username">
                  <UiIcon name="lock" :size="12" />
                  <span class="max-w-[7rem] truncate font-mono">{{ row.username }}</span>
                </span>
                <span v-else class="text-fg-subtle">{{ t("clash.ips.noAuth") }}</span>
              </td>
              <td class="whitespace-nowrap">
                <span class="font-mono text-xs" :class="row.node?.exitIp ? 'text-fg' : 'text-fg-subtle'">
                  {{ row.node?.exitIp || t("clash.nodes.unprobed") }}
                </span>
                <UiBadge v-if="row.node?.driftUnconfirmed" tone="danger" class="ml-1.5">{{ t("clash.nodes.exitChanged") }}</UiBadge>
              </td>
              <td class="whitespace-nowrap">
                <span
                  class="font-mono text-xs tabular-nums"
                  :class="row.accountNames.length ? 'text-fg' : 'text-fg-subtle'"
                  :title="row.accountNames.join('\n') || undefined"
                >
                  {{ row.node ? `${row.node.boundAccounts}/${row.node.maxAccounts}` : "-" }}
                </span>
              </td>
              <td class="whitespace-nowrap">
                <div v-if="row.node" class="flex items-center gap-2">
                  <span class="font-mono text-xs tabular-nums text-fg-muted">{{ row.node.latencyMs }}ms</span>
                  <UiBadge :tone="healthTone(row.node.healthStatus)" dot>{{ healthLabel(row.node.healthStatus) }}</UiBadge>
                </div>
                <span v-else class="text-fg-subtle">-</span>
              </td>
              <td class="whitespace-nowrap font-mono text-xs text-fg-muted">{{ formatDateShort(row.sub.createdAt) }}</td>
              <td>
                <UiSwitch
                  v-if="row.node"
                  :model-value="row.node.enabled !== false"
                  :disabled="busy"
                  :label="row.node.enabled === false ? t('clash.nodes.enableNode') : t('clash.nodes.disableNode')"
                  hide-label
                  @update:model-value="toggleEnabled(row)"
                />
                <UiBadge v-else tone="warning">{{ t("clash.ips.filters.status.pending") }}</UiBadge>
              </td>
              <td class="text-right">
                <div class="inline-flex gap-1">
                  <button
                    v-if="row.node?.driftUnconfirmed"
                    type="button"
                    class="btn btn-xs bg-warning/10 text-warning hover:bg-warning/20"
                    :disabled="busy"
                    @click="confirmDrift(row)"
                  >
                    {{ t("clash.actions.acceptExit") }}
                  </button>
                  <button v-if="row.node" type="button" class="btn btn-ghost btn-xs" :disabled="busy" @click="probe([row.node.nodeId])">
                    <UiIcon name="radar" :size="13" />
                    {{ t("clash.actions.check") }}
                  </button>
                  <button v-else type="button" class="btn btn-ghost btn-xs" :disabled="busy" @click="resync(row)">
                    <UiIcon name="refresh" :size="13" />
                    {{ t("clash.ips.actions.retry") }}
                  </button>
                  <ConfirmButton icon-only :disabled="busy" @confirm="remove(row)" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add IP -->
    <UiModal :open="addOpen" :title="t('clash.ips.add.title')" width="lg" :persistent="adding" @update:open="addOpen = $event">
      <template #icon>
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="route" :size="16" /></span>
      </template>
      <form id="ip-add-form" class="space-y-4" @submit.prevent="submitAdd">
        <SegmentedControl v-model="addMode" :options="addModeOptions" block size="md" />

        <template v-if="addMode === 'single'">
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <label class="label" for="ip-name">{{ t("clash.ips.add.name") }}</label>
              <input id="ip-name" v-model="formName" type="text" maxlength="100" :placeholder="t('clash.ips.add.namePlaceholder')" class="input" />
            </div>
            <div>
              <label class="label" for="ip-protocol">{{ t("clash.ips.columns.protocol") }}</label>
              <UiSelect id="ip-protocol" v-model="formProtocol" class="select">
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </UiSelect>
            </div>
            <div class="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
              <div>
                <label class="label" for="ip-host">{{ t("clash.ips.add.host") }} <span class="text-danger">*</span></label>
                <input id="ip-host" v-model="formHost" type="text" required spellcheck="false" placeholder="1.2.3.4" class="input font-mono" />
              </div>
              <div>
                <label class="label" for="ip-port">{{ t("clash.ips.add.port") }} <span class="text-danger">*</span></label>
                <input id="ip-port" v-model.number="formPort" type="number" min="1" max="65535" required placeholder="1080" class="input font-mono" />
              </div>
            </div>
            <div>
              <label class="label" for="ip-user">{{ t("clash.ips.add.username") }}</label>
              <input id="ip-user" v-model="formUser" type="text" autocomplete="off" spellcheck="false" class="input font-mono" />
            </div>
            <div>
              <label class="label" for="ip-pass">{{ t("clash.ips.add.password") }}</label>
              <input id="ip-pass" v-model="formPass" type="password" autocomplete="new-password" class="input font-mono" />
            </div>
          </div>
          <p v-if="singleError" class="text-xs text-danger">{{ errorText(singleError) }}</p>
        </template>

        <template v-else>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="label" for="ip-batch-protocol">{{ t("clash.ips.add.defaultProtocol") }}</label>
              <UiSelect id="ip-batch-protocol" v-model="batchProtocol" class="select">
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </UiSelect>
            </div>
            <div>
              <label class="label" for="ip-batch-prefix">{{ t("clash.ips.add.namePrefix") }}</label>
              <input id="ip-batch-prefix" v-model="batchPrefix" type="text" maxlength="60" :placeholder="t('clash.ips.add.namePrefixPlaceholder')" class="input" />
            </div>
          </div>
          <div>
            <label class="label" for="ip-batch">{{ t("clash.ips.add.lines") }} <span class="text-danger">*</span></label>
            <textarea
              id="ip-batch"
              v-model="batchText"
              rows="8"
              spellcheck="false"
              autocomplete="off"
              :placeholder="'socks5://user:pass@1.2.3.4:1080\nhttp://5.6.7.8:3128\n9.9.9.9:8000:user:pass'"
              class="textarea font-mono text-xs"
            />
            <p class="mt-1 text-2xs text-fg-subtle">{{ t("clash.ips.add.linesHint") }}</p>
          </div>
          <div v-if="batchLines.length" class="space-y-2">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <UiBadge tone="success">{{ t("clash.ips.add.valid", { count: batchValid.length }) }}</UiBadge>
              <UiBadge v-if="batchInvalid.length" tone="danger">{{ t("clash.ips.add.invalid", { count: batchInvalid.length }) }}</UiBadge>
            </div>
            <ul v-if="batchInvalid.length" class="max-h-28 space-y-1 overflow-y-auto rounded-lg bg-surface-2/60 p-2 text-xs">
              <li v-for="l in batchInvalid" :key="l.line" class="flex gap-2">
                <span class="shrink-0 font-mono text-fg-subtle">#{{ l.line }}</span>
                <span class="min-w-0 truncate font-mono text-fg">{{ l.text }}</span>
                <span class="shrink-0 text-danger">{{ errorText(l.error!) }}</span>
              </li>
            </ul>
          </div>
        </template>

        <UiAlert tone="info">{{ t("clash.ips.add.poolHint") }}</UiAlert>
      </form>
      <template #footer>
        <span v-if="adding" class="mr-auto text-xs text-fg-muted">{{ t("clash.ips.add.progress", progress) }}</span>
        <button type="button" class="btn btn-secondary" :disabled="adding" @click="addOpen = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="ip-add-form" class="btn btn-primary" :disabled="!canAdd">
          <UiIcon :name="adding ? 'loader' : 'plus'" :size="14" :spin="adding" />
          {{ addMode === "batch" ? t("clash.ips.add.submitBatch", { count: batchValid.length }) : t("clash.ips.add.submit") }}
        </button>
      </template>
    </UiModal>
  </div>
</template>
