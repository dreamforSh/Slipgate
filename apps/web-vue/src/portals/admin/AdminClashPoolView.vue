<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  AccountExitBinding,
  ClashExitNode,
  ClashOutboundTestResponse,
  ClashRuntimeStatus,
  ClashSubscription,
  ClientHelloPreset,
  TlsProfile,
  UpstreamAccount,
} from "@slipgate/contracts";
import { isStaticIpSubscription } from "@slipgate/contracts";
import ClashNodeCard from "../../components/admin/clash/ClashNodeCard.vue";
import ClashSubscriptionCard from "../../components/admin/clash/ClashSubscriptionCard.vue";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiDrawer from "../../components/ui/UiDrawer.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { useNow } from "../../composables/useNow";
import { usePersistentState } from "../../composables/usePersistentState";
import { healthLabel, healthTone } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const { t, te } = useI18n();
const auth = useAuthStore();

interface ClashOverviewPayload {
  runtime: ClashRuntimeStatus;
  subscriptions: ClashSubscription[];
  nodes: ClashExitNode[];
  bindings: AccountExitBinding[];
  profiles: TlsProfile[];
  policy: {
    maxAccountsPerExitIp: number;
    failClosed: boolean;
    dropGuardThreshold: number;
  };
}

type TabKey = "nodes" | "subscriptions" | "bindings" | "profiles";

const loading = ref(false);
const busyAction = ref(false);
const errorMessage = ref<string | null>(null);
const actionNotice = ref<string | null>(null);
const activeTab = ref<TabKey>("nodes");
const subDrawerOpen = ref(false);
const tlsDrawerOpen = ref(false);

useFeedbackToasts(errorMessage, actionNotice);

type ViewMode = "card" | "table";
/** Nodes and subscriptions share one table/card preference, cards first (as in linksyncx). */
const viewMode = usePersistentState<ViewMode>("slipgate.clash.view", "card", (v): v is ViewMode => v === "card" || v === "table");
const viewOptions = computed(() => [
  { value: "card" as const, label: t("clash.view.card") },
  { value: "table" as const, label: t("clash.view.table") },
]);
const now = useNow();

const runtime = ref<ClashRuntimeStatus | null>(null);
const subscriptions = ref<ClashSubscription[]>([]);
const nodes = ref<ClashExitNode[]>([]);
const bindings = ref<AccountExitBinding[]>([]);
const profiles = ref<TlsProfile[]>([]);
const accounts = ref<UpstreamAccount[]>([]);

// Subscription form
const subName = ref("");
const subKind = ref<"url" | "inline">("url");
const subSource = ref("");
// Default filter drops the info-only "nodes" providers inject (traffic left / expiry / website).
const DEFAULT_EXCLUDE = "剩余流量|到期时间|官网";
const subExclude = ref(DEFAULT_EXCLUDE);

// Account <-> Exit binding form
const bindAccountId = ref("");
const bindNodeId = ref("");
const bindProfileId = ref("auto");
const bindShadow = ref(false);

// Outbound test target & result
const testTargetUrl = ref("https://api.ipify.org?format=json");
const outboundResult = ref<ClashOutboundTestResponse | null>(null);

// Custom TLS Profile form (supports wire-level linksyncx parameters & PUT updates)
const editingProfileId = ref<string | null>(null);
const tlsName = ref("");
const tlsPreset = ref<ClientHelloPreset>("claude_node_24");
const tlsAlpnRaw = ref("http/1.1");
const tlsUA = ref("");
const tlsJA3 = ref("");
const tlsOsHint = ref("");
const tlsEnableGrease = ref(false);
const tlsCiphersRaw = ref("");
const tlsCurvesRaw = ref("");
const tlsKeySharesRaw = ref("");
const tlsExtensionsRaw = ref("");

// Static IPs share the exit pool but are managed on the IP page; this page shows subscription exits.
const clashSubscriptions = computed(() => subscriptions.value.filter((s) => !isStaticIpSubscription(s.id)));
const clashNodes = computed(() => nodes.value.filter((n) => !isStaticIpSubscription(n.subscriptionId)));
const staticNodes = computed(() => nodes.value.filter((n) => isStaticIpSubscription(n.subscriptionId)));
const healthyCount = computed(() => clashNodes.value.filter((n) => n.healthStatus === "healthy").length);
const driftCount = computed(() => clashNodes.value.filter((n) => n.driftUnconfirmed).length);
const accountNameById = computed(() => new Map(accounts.value.map((a) => [a.id, a.name])));
const nodeNameById = computed(() => new Map(nodes.value.map((n) => [n.nodeId, n.name])));
const subscriptionNameById = computed(() => new Map(subscriptions.value.map((s) => [s.id, s.name])));
const accountNamesByNode = computed(() => {
  const map = new Map<string, string[]>();
  for (const b of bindings.value) {
    const list = map.get(b.nodeId) ?? [];
    list.push(accountNameById.value.get(b.accountId) ?? b.accountId);
    map.set(b.nodeId, list);
  }
  return map;
});
const nodesBySubscription = computed(() => {
  const map = new Map<string, ClashExitNode[]>();
  for (const n of clashNodes.value) map.set(n.subscriptionId, [...(map.get(n.subscriptionId) ?? []), n]);
  return map;
});

const tabs = computed(() => [
  { key: "nodes" as const, label: t("clash.tabs.nodes"), count: clashNodes.value.length, icon: "radar" as const },
  {
    key: "subscriptions" as const,
    label: t("clash.tabs.subscriptions"),
    count: clashSubscriptions.value.length,
    icon: "download" as const,
  },
  { key: "bindings" as const, label: t("clash.tabs.bindings"), count: bindings.value.length, icon: "link" as const },
  { key: "profiles" as const, label: t("clash.tabs.profiles"), count: profiles.value.length, icon: "fingerprint" as const },
]);

const subKindOptions = computed(() => [
  { value: "url" as const, label: t("clash.subscriptions.sourceKind.url") },
  { value: "inline" as const, label: t("clash.subscriptions.sourceKind.inline") },
]);

const PRESET_OPTIONS: ClientHelloPreset[] = [
  "auto",
  "custom_wire",
  "claude_node_24",
  "claude_bun_21",
  "codex_rustls",
  "antigravity_ide",
  "gemini_cli_node",
  "qwen_cli_node",
  "grok_rustls",
  "opencode_bun",
  "cline_node",
  "node_sdk_24",
  "chrome_auto",
  "firefox_auto",
  "safari_auto",
  "ios_auto",
  "edge_auto",
  "randomized",
  "claude_cli",
];

const OS_OPTIONS = [
  { value: "linux", label: "Linux" },
  { value: "darwin", label: "macOS" },
  { value: "windows", label: "Windows" },
  { value: "ios", label: "iOS" },
];

function presetLabel(preset: string): string {
  const key = `clash.presets.${preset}`;
  return te(key) ? t(key) : preset;
}

/** Sync status may carry a detail suffix ("fetch_error: ..."); translate the code part only. */
function syncStatusLabel(status: string): string {
  const code = status.split(":")[0]!.trim();
  const key = `clash.subscriptions.syncStatus.${code}`;
  return te(key) ? t(key) : status;
}

async function loadOverview() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const [ovRes, accRes] = await Promise.all([
      auth.apiFetch("/api/v1/admin/clash/overview"),
      auth.apiFetch("/api/v1/admin/accounts"),
    ]);
    if (ovRes.ok) {
      const ov = (await ovRes.json()) as ClashOverviewPayload;
      runtime.value = ov.runtime;
      subscriptions.value = ov.subscriptions ?? [];
      nodes.value = ov.nodes ?? [];
      bindings.value = ov.bindings ?? [];
      profiles.value = ov.profiles ?? [];
      if (!bindNodeId.value && nodes.value.length > 0) {
        const firstHealthy = nodes.value.find((n) => n.healthStatus === "healthy") ?? nodes.value[0];
        if (firstHealthy) {
          bindNodeId.value = firstHealthy.nodeId;
        }
      }
    }
    if (accRes.ok) {
      const accBody = (await accRes.json()) as { accounts: UpstreamAccount[] };
      accounts.value = accBody.accounts ?? [];
      if (!bindAccountId.value && accounts.value.length > 0 && accounts.value[0]) {
        bindAccountId.value = accounts.value[0].id;
      }
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : t("clash.toast.loadFailed");
  } finally {
    loading.value = false;
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as {
      message?: string;
      error?: string;
      reason?: string;
      field?: string;
      group?: number;
    };
    const base = data.message ?? data.error ?? fallback;
    if (data.reason) {
      const fieldInfo = data.field ? ` (${data.field})` : "";
      return `[${data.reason}]${fieldInfo}: ${base}`;
    }
    return base;
  } catch {
    return fallback;
  }
}

async function createSubscription() {
  busyAction.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/clash/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: subName.value,
        sourceKind: subKind.value,
        sourceUrl: subSource.value,
        excludeRegex: subExclude.value,
        autoSync: true,
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.subscriptionCreateFailed"));
      return;
    }
    subName.value = "";
    subSource.value = "";
    subDrawerOpen.value = false;
    actionNotice.value = t("clash.toast.subscriptionCreated");
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function syncSubscription(subId: string, force = false) {
  busyAction.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/subscriptions/${encodeURIComponent(subId)}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.subscriptionRefreshFailed"));
      return;
    }
    actionNotice.value = force ? t("clash.toast.subscriptionForceRefreshed") : t("clash.toast.subscriptionRefreshed");
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function deleteSubscription(subId: string) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/subscriptions/${encodeURIComponent(subId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.subscriptionDeleteFailed"));
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function probeNodes(nodeIds: string[]) {
  busyAction.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/clash/nodes/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeIds, verifyExitIp: true }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.checkFailed"));
      return;
    }
    actionNotice.value = t("clash.toast.checkDone");
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function confirmDrift(nodeId: string) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/nodes/${encodeURIComponent(nodeId)}/confirm-drift`, {
      method: "POST",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.acceptExitFailed"));
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function toggleNodeEnabled(node: ClashExitNode) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const nextEnabled = !(node.enabled ?? true);
    const res = await auth.apiFetch(`/api/v1/admin/clash/nodes/${encodeURIComponent(node.nodeId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: nextEnabled }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.toggleNodeFailed"));
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function bindAccount() {
  busyAction.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/clash/bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: bindAccountId.value,
        nodeId: bindNodeId.value,
        utlsProfileId: bindProfileId.value || undefined,
        isShadowFollower: bindShadow.value,
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.bindFailed"));
      return;
    }
    actionNotice.value = t("clash.toast.bound");
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function unbindAccount(accountId: string) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/bindings/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.unbindFailed"));
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function runOutboundTest(accountId: string, utlsProfileId?: string) {
  busyAction.value = true;
  errorMessage.value = null;
  outboundResult.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/clash/test-outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        utlsProfileId: utlsProfileId || undefined,
        targetUrl: testTargetUrl.value || undefined,
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.outboundFailed"));
      return;
    }
    outboundResult.value = (await res.json()) as ClashOutboundTestResponse;
  } finally {
    busyAction.value = false;
  }
}

function parseUint16Csv(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => (token.startsWith("0x") || token.startsWith("0X") ? parseInt(token, 16) : parseInt(token, 10)))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 65535);
}

function fillClaudeBunWirePreset() {
  tlsPreset.value = "custom_wire";
  tlsOsHint.value = "linux";
  tlsEnableGrease.value = false;
  tlsAlpnRaw.value = "h2,http/1.1";
  tlsUA.value = "claude-cli/2.1.321 (external, cli)";
  tlsCurvesRaw.value = "4588,29,23,24";
  tlsKeySharesRaw.value = "4588,29";
  tlsExtensionsRaw.value = "0,23,65281,10,11,35,16,5,13,18,51,45,43";
}

function resetTlsForm() {
  editingProfileId.value = null;
  tlsName.value = "";
  tlsPreset.value = "claude_node_24";
  tlsAlpnRaw.value = "http/1.1";
  tlsUA.value = "";
  tlsJA3.value = "";
  tlsOsHint.value = "";
  tlsEnableGrease.value = false;
  tlsCiphersRaw.value = "";
  tlsCurvesRaw.value = "";
  tlsKeySharesRaw.value = "";
  tlsExtensionsRaw.value = "";
}

function openCreateTlsProfile() {
  resetTlsForm();
  tlsDrawerOpen.value = true;
}

function startEditTlsProfile(p: TlsProfile) {
  editingProfileId.value = p.id;
  tlsName.value = p.name;
  tlsPreset.value = p.clientHelloPreset as ClientHelloPreset;
  tlsAlpnRaw.value = (p.alpnProtocols ?? ["h2", "http/1.1"]).join(",");
  tlsUA.value = p.userAgentTemplate ?? "";
  tlsJA3.value = p.ja3Fingerprint ?? "";
  tlsOsHint.value = p.osHint ?? "";
  tlsEnableGrease.value = Boolean(p.enableGrease);
  tlsCiphersRaw.value = (p.cipherSuites ?? []).join(",");
  tlsCurvesRaw.value = (p.curves ?? []).join(",");
  tlsKeySharesRaw.value = (p.keyShareGroups ?? []).join(",");
  tlsExtensionsRaw.value = (p.extensions ?? []).join(",");
  tlsDrawerOpen.value = true;
}

async function saveTlsProfile() {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const alpns = tlsAlpnRaw.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const body = {
      name: tlsName.value,
      clientHelloPreset: tlsPreset.value,
      alpnProtocols: alpns.length > 0 ? alpns : ["h2", "http/1.1"],
      userAgentTemplate: tlsUA.value,
      ja3Fingerprint: tlsJA3.value,
      osHint: tlsOsHint.value.trim(),
      enableGrease: tlsEnableGrease.value,
      cipherSuites: parseUint16Csv(tlsCiphersRaw.value),
      curves: parseUint16Csv(tlsCurvesRaw.value),
      keyShareGroups: parseUint16Csv(tlsKeySharesRaw.value),
      extensions: parseUint16Csv(tlsExtensionsRaw.value),
    };
    const isEdit = Boolean(editingProfileId.value);
    const url = isEdit
      ? `/api/v1/admin/tls-profiles/${encodeURIComponent(editingProfileId.value!)}`
      : "/api/v1/admin/tls-profiles";
    const res = await auth.apiFetch(url, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, isEdit ? t("clash.toast.profileUpdateFailed") : t("clash.toast.profileCreateFailed"));
      return;
    }
    resetTlsForm();
    tlsDrawerOpen.value = false;
    actionNotice.value = isEdit ? t("clash.toast.profileUpdated") : t("clash.toast.profileCreated");
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function deleteTlsProfile(id: string) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/tls-profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("clash.toast.profileDeleteFailed"));
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

onMounted(() => {
  void loadOverview();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.proxyClash')">
      <template #meta>
        <UiBadge v-if="runtime" :tone="runtime.ready ? 'success' : 'warning'" dot :pulse="runtime.ready">
          {{ runtime.ready ? t("clash.runtime.ready") : t("clash.runtime.notReady") }}
        </UiBadge>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading || busyAction" @click="loadOverview">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="busyAction || clashNodes.length === 0"
          @click="probeNodes(clashNodes.map((n) => n.nodeId))"
        >
          <UiIcon :name="busyAction ? 'loader' : 'radar'" :size="15" :spin="busyAction" />
          {{ t("clash.actions.checkAll") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard :label="t('clash.stats.listeners')" :value="runtime?.activeListeners ?? 0" icon="plug" tone="accent" />
      <StatCard :label="t('clash.stats.healthy')" :value="`${healthyCount} / ${clashNodes.length}`" icon="radar" tone="success" />
      <StatCard
        :label="t('clash.stats.exitChanged')"
        :value="driftCount"
        icon="alert"
        :tone="driftCount > 0 ? 'danger' : 'neutral'"
      />
      <StatCard
        :label="t('clash.stats.bound')"
        :value="bindings.length"
        icon="link"
        tone="info"
        :hint="t('clash.stats.activeProxies', { count: runtime?.activeProxies ?? 0 })"
      />
    </div>

    <div class="card">
      <UiTabs v-model="activeTab" :tabs="tabs" class="px-3" />

      <!-- Nodes -->
      <div v-if="activeTab === 'nodes'">
        <div v-if="clashNodes.length" class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <span class="text-xs text-fg-muted">{{ t("clash.nodes.summary", { total: clashNodes.length, healthy: healthyCount }) }}</span>
          <SegmentedControl v-model="viewMode" :options="viewOptions" />
        </div>
        <EmptyState v-if="clashNodes.length === 0" icon="radar" :title="t('clash.nodes.empty')">
          <button type="button" class="btn btn-primary btn-sm" @click="activeTab = 'subscriptions'; subDrawerOpen = true">
            <UiIcon name="plus" :size="14" />
            {{ t("clash.actions.addSubscription") }}
          </button>
        </EmptyState>
        <div v-else-if="viewMode === 'card'" class="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
          <ClashNodeCard
            v-for="n in clashNodes"
            :key="n.nodeId"
            :node="n"
            :subscription-name="subscriptionNameById.get(n.subscriptionId) ?? n.subscriptionId"
            :account-names="accountNamesByNode.get(n.nodeId) ?? []"
            :busy="busyAction"
            :now="now"
            @toggle="toggleNodeEnabled(n)"
            @probe="probeNodes([n.nodeId])"
            @accept-exit="confirmDrift(n.nodeId)"
          />
        </div>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("clash.nodes.columns.name") }}</th>
                <th>{{ t("clash.nodes.columns.server") }}</th>
                <th>{{ t("clash.nodes.columns.listener") }}</th>
                <th>{{ t("clash.nodes.columns.exitIp") }}</th>
                <th>{{ t("clash.nodes.columns.latency") }}</th>
                <th>{{ t("clash.nodes.columns.bound") }}</th>
                <th>{{ t("clash.nodes.columns.enabled") }}</th>
                <th class="text-right">{{ t("common.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="n in clashNodes" :key="n.nodeId" :class="(n.enabled ?? true) ? '' : 'opacity-60'">
                <td class="max-w-[14rem]">
                  <p class="truncate font-medium text-fg">{{ n.name }}</p>
                  <p v-if="n.lastError" class="mt-0.5 truncate text-2xs text-danger" :title="n.lastError">{{ n.lastError }}</p>
                </td>
                <td class="whitespace-nowrap font-mono text-xs text-fg-muted">
                  {{ n.proxyType || "-" }} · {{ n.server || "-" }}:{{ n.serverPort || "-" }}
                </td>
                <td><span class="code-chip">127.0.0.1:{{ n.listenerPort }}</span></td>
                <td class="whitespace-nowrap">
                  <span class="font-mono text-xs" :class="n.exitIp ? 'text-fg' : 'text-fg-subtle'">{{ n.exitIp || t("clash.nodes.unprobed") }}</span>
                  <UiBadge v-if="n.driftUnconfirmed" tone="danger" class="ml-1.5">{{ t("clash.nodes.exitChanged") }}</UiBadge>
                </td>
                <td class="whitespace-nowrap">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-xs tabular-nums text-fg-muted">{{ n.latencyMs }}ms</span>
                    <UiBadge :tone="healthTone(n.healthStatus)" dot>{{ healthLabel(n.healthStatus) }}</UiBadge>
                  </div>
                </td>
                <td class="font-mono text-xs tabular-nums">{{ n.boundAccounts }}/{{ n.maxAccounts }}</td>
                <td>
                  <UiSwitch
                    :model-value="n.enabled ?? true"
                    :disabled="busyAction"
                    :label="(n.enabled ?? true) ? t('clash.nodes.disableNode') : t('clash.nodes.enableNode')"
                    hide-label
                    @update:model-value="toggleNodeEnabled(n)"
                  />
                </td>
                <td class="text-right">
                  <div class="inline-flex gap-1">
                    <button
                      v-if="n.driftUnconfirmed"
                      type="button"
                      class="btn btn-xs bg-warning/10 text-warning hover:bg-warning/20"
                      :disabled="busyAction"
                      @click="confirmDrift(n.nodeId)"
                    >
                      {{ t("clash.actions.acceptExit") }}
                    </button>
                    <button type="button" class="btn btn-ghost btn-xs" :disabled="busyAction" @click="probeNodes([n.nodeId])">
                      <UiIcon name="radar" :size="13" />
                      {{ t("clash.actions.check") }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Subscriptions -->
      <div v-else-if="activeTab === 'subscriptions'">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <SegmentedControl v-if="clashSubscriptions.length" v-model="viewMode" :options="viewOptions" />
          <span v-else />
          <button type="button" class="btn btn-primary btn-sm" @click="subDrawerOpen = true">
            <UiIcon name="plus" :size="14" />
            {{ t("clash.actions.addSubscription") }}
          </button>
        </div>
        <EmptyState
          v-if="!loading && clashSubscriptions.length === 0"
          icon="download"
          :title="t('clash.subscriptions.empty')"
        />
        <div v-else-if="viewMode === 'card'" class="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
          <ClashSubscriptionCard
            v-for="sub in clashSubscriptions"
            :key="sub.id"
            :sub="sub"
            :nodes="nodesBySubscription.get(sub.id) ?? []"
            :status-label="syncStatusLabel(sub.lastSyncStatus)"
            :busy="busyAction"
            :now="now"
            @refresh="syncSubscription(sub.id, false)"
            @force-refresh="syncSubscription(sub.id, true)"
            @delete="deleteSubscription(sub.id)"
          />
        </div>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("clash.subscriptions.columns.name") }}</th>
                <th>{{ t("clash.subscriptions.columns.source") }}</th>
                <th>{{ t("clash.subscriptions.columns.syncStatus") }}</th>
                <th class="text-right">{{ t("clash.subscriptions.columns.nodes") }}</th>
                <th class="text-right">{{ t("common.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="sub in clashSubscriptions" :key="sub.id">
                <td class="font-medium text-fg">{{ sub.name }}</td>
                <td><UiBadge>{{ t(`clash.subscriptions.sourceKind.${sub.sourceKind}`) }}</UiBadge></td>
                <td>
                  <UiBadge :tone="healthTone(sub.lastSyncStatus)" dot :title="sub.lastSyncStatus">
                    {{ syncStatusLabel(sub.lastSyncStatus) }}
                  </UiBadge>
                </td>
                <td class="text-right font-mono text-xs tabular-nums">{{ sub.lastNodeCount }}</td>
                <td class="text-right">
                  <div class="inline-flex gap-1">
                    <button type="button" class="btn btn-ghost btn-xs" :disabled="busyAction" @click="syncSubscription(sub.id, false)">
                      <UiIcon name="refresh" :size="13" />
                      {{ t("clash.actions.refreshNow") }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-xs text-warning hover:bg-warning/10"
                      :disabled="busyAction"
                      @click="syncSubscription(sub.id, true)"
                    >
                      {{ t("clash.actions.forceRefresh") }}
                    </button>
                    <ConfirmButton icon-only :disabled="busyAction" @confirm="deleteSubscription(sub.id)" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Bindings -->
      <div v-else-if="activeTab === 'bindings'" class="grid gap-0 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <form class="space-y-4 border-b border-line p-5 lg:border-b-0 lg:border-r" @submit.prevent="bindAccount">
          <h3 class="text-sm font-semibold text-fg">{{ t("clash.bindings.title") }}</h3>
          <FormField :label="t('clash.bindings.account')" required>
            <input
              v-model="bindAccountId"
              list="slipgate-account-ids"
              required
              :placeholder="t('clash.bindings.accountPlaceholder')"
              class="input font-mono text-xs"
            />
            <datalist id="slipgate-account-ids">
              <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name }} ({{ acc.platform }})</option>
            </datalist>
          </FormField>
          <FormField :label="t('clash.bindings.node')" required>
            <select v-model="bindNodeId" required class="select">
              <template v-for="group in [{ key: 'clash', label: t('clash.bindings.groupClash'), list: clashNodes }, { key: 'ip', label: t('clash.bindings.groupStatic'), list: staticNodes }]" :key="group.key">
                <optgroup v-if="group.list.length" :label="group.label">
                  <option v-for="n in group.list" :key="n.nodeId" :value="n.nodeId">
                    {{
                      t("clash.bindings.nodeOption", {
                        name: n.name,
                        ip: n.exitIp || t("clash.nodes.unprobed"),
                        health: healthLabel(n.healthStatus),
                      })
                    }}
                  </option>
                </optgroup>
              </template>
            </select>
          </FormField>
          <FormField :label="t('clash.bindings.profile')">
            <select v-model="bindProfileId" class="select">
              <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </FormField>
          <label class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
            <input v-model="bindShadow" type="checkbox" class="checkbox mt-0.5" />
            <span class="text-sm text-fg">{{ t("clash.bindings.shadow") }}</span>
          </label>
          <button type="submit" :disabled="busyAction" class="btn btn-primary w-full">
            <UiIcon name="link" :size="14" />
            {{ t("clash.actions.bind") }}
          </button>
        </form>

        <div class="min-w-0">
          <div class="flex flex-col gap-2 border-b border-line px-5 py-3 sm:flex-row sm:items-center">
            <span class="shrink-0 text-xs font-medium text-fg-muted">{{ t("clash.bindings.testTarget") }}</span>
            <input
              v-model="testTargetUrl"
              type="url"
              class="input input-sm font-mono"
              :aria-label="t('clash.bindings.testTarget')"
            />
          </div>

          <div
            v-if="outboundResult"
            class="m-5 mb-0 animate-fade-in overflow-hidden rounded-lg border border-success/30"
          >
            <div class="flex flex-wrap items-center gap-2 bg-success/[0.08] px-3.5 py-2 text-xs">
              <UiIcon name="check-circle" :size="14" class="text-success" />
              <span class="font-medium text-success">{{ t("clash.bindings.testPassed") }}</span>
              <UiBadge tone="success" mono>HTTP {{ outboundResult.statusCode }}</UiBadge>
              <UiBadge mono>{{ outboundResult.tlsVersion }}</UiBadge>
              <UiBadge mono>ALPN {{ outboundResult.negotiatedAlpn || "http/1.1" }}</UiBadge>
              <span class="ml-auto font-mono text-fg-muted">{{ outboundResult.exitIp }} · {{ outboundResult.latencyMs }}ms</span>
            </div>
            <pre class="max-h-28 overflow-auto whitespace-pre-wrap break-all bg-surface-2/50 px-3.5 py-2.5 font-mono text-2xs text-fg-muted">{{ outboundResult.bodySnippet }}</pre>
          </div>

          <EmptyState v-if="bindings.length === 0" compact icon="link" :title="t('clash.bindings.empty')" />
          <div v-else class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>{{ t("clash.bindings.columns.account") }}</th>
                  <th>{{ t("clash.bindings.columns.node") }}</th>
                  <th>{{ t("clash.bindings.columns.exitIp") }}</th>
                  <th>{{ t("clash.bindings.columns.profile") }}</th>
                  <th class="text-right">{{ t("common.actions") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in bindings" :key="b.accountId">
                  <td class="max-w-[12rem]">
                    <p class="truncate text-sm text-fg">{{ accountNameById.get(b.accountId) ?? b.accountId }}</p>
                    <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{{ b.accountId }}</p>
                  </td>
                  <td class="max-w-[10rem] truncate text-xs text-fg-muted">{{ nodeNameById.get(b.nodeId) ?? b.nodeId }}</td>
                  <td class="whitespace-nowrap font-mono text-xs">
                    {{ b.boundExitIp || "-" }}
                    <UiBadge v-if="b.isShadowFollower" tone="violet" class="ml-1">{{ t("clash.bindings.shadowBadge") }}</UiBadge>
                  </td>
                  <td><span class="code-chip">{{ b.utlsProfileId || "auto" }}</span></td>
                  <td class="text-right">
                    <div class="inline-flex gap-1">
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        :disabled="busyAction"
                        @click="runOutboundTest(b.accountId, b.utlsProfileId)"
                      >
                        <UiIcon name="zap" :size="13" />
                        {{ t("clash.actions.testOutbound") }}
                      </button>
                      <ConfirmButton
                        :label="t('clash.actions.unbind')"
                        :confirm-label="t('clash.actions.confirmUnbind')"
                        icon="unlink"
                        icon-only
                        :disabled="busyAction"
                        @confirm="unbindAccount(b.accountId)"
                      />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TLS profiles -->
      <div v-else>
        <div class="flex flex-wrap items-center justify-end gap-3 border-b border-line px-5 py-3">
          <button type="button" class="btn btn-primary btn-sm" @click="openCreateTlsProfile">
            <UiIcon name="plus" :size="14" />
            {{ t("clash.actions.newProfile") }}
          </button>
        </div>
        <EmptyState v-if="profiles.length === 0" icon="fingerprint" :title="t('clash.profiles.empty')" />
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("clash.profiles.columns.name") }}</th>
                <th>{{ t("clash.profiles.columns.preset") }}</th>
                <th>ALPN</th>
                <th>KeyShare</th>
                <th>{{ t("common.type") }}</th>
                <th class="text-right">{{ t("common.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in profiles" :key="p.id">
                <td>
                  <p class="flex items-center gap-1.5 font-medium text-fg">
                    {{ p.name }}
                    <UiBadge v-if="p.enableGrease" tone="success">GREASE</UiBadge>
                  </p>
                  <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ p.id }}</p>
                </td>
                <td><span class="code-chip" :title="p.clientHelloPreset">{{ presetLabel(p.clientHelloPreset) }}</span></td>
                <td class="font-mono text-xs text-fg-muted">{{ p.alpnProtocols.join(", ") }}</td>
                <td class="font-mono text-xs text-fg-muted">
                  {{ p.keyShareGroups && p.keyShareGroups.length > 0 ? p.keyShareGroups.join(",") : "-" }}
                </td>
                <td>
                  <UiBadge :tone="p.builtIn ? 'neutral' : 'accent'">{{ p.builtIn ? t("clash.profiles.builtIn") : t("clash.profiles.custom") }}</UiBadge>
                </td>
                <td class="text-right">
                  <div v-if="!p.builtIn" class="inline-flex gap-1">
                    <button type="button" class="btn btn-ghost btn-xs" @click="startEditTlsProfile(p)">
                      <UiIcon name="pencil" :size="13" />
                      {{ t("common.edit") }}
                    </button>
                    <ConfirmButton icon-only :disabled="busyAction" @confirm="deleteTlsProfile(p.id)" />
                  </div>
                  <span v-else class="text-2xs text-fg-subtle">{{ t("clash.profiles.readOnly") }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Add subscription drawer -->
    <UiDrawer v-model:open="subDrawerOpen" :title="t('clash.subscriptionForm.title')">
      <form id="create-sub-form" class="space-y-4" @submit.prevent="createSubscription">
        <FormField :label="t('clash.subscriptionForm.name')" required>
          <input
            v-model="subName"
            type="text"
            required
            :placeholder="t('clash.subscriptionForm.namePlaceholder')"
            class="input"
          />
        </FormField>
        <div>
          <span class="label">{{ t("clash.subscriptionForm.source") }}</span>
          <SegmentedControl v-model="subKind" block size="md" :options="subKindOptions" />
        </div>
        <FormField v-if="subKind === 'url'" :label="t('clash.subscriptionForm.url')" required>
          <input
            v-model="subSource"
            type="url"
            required
            placeholder="https://example.com/sub?token=..."
            class="input font-mono text-xs"
          />
        </FormField>
        <FormField v-else :label="t('clash.subscriptionForm.inline')" required>
          <textarea
            v-model="subSource"
            rows="8"
            required
            spellcheck="false"
            placeholder="proxies:&#10;  - name: Tokyo-01&#10;    type: socks5&#10;    server: 203.0.113.10&#10;    port: 1080"
            class="textarea font-mono text-xs"
          />
        </FormField>
        <FormField :label="t('clash.subscriptionForm.exclude')">
          <input v-model="subExclude" type="text" :placeholder="DEFAULT_EXCLUDE" class="input font-mono text-xs" />
        </FormField>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="subDrawerOpen = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="create-sub-form" :disabled="busyAction" class="btn btn-primary">
          <UiIcon v-if="busyAction" name="loader" :size="14" spin />
          {{ t("clash.subscriptionForm.submit") }}
        </button>
      </template>
    </UiDrawer>

    <!-- TLS profile drawer -->
    <UiDrawer
      v-model:open="tlsDrawerOpen"
      :title="editingProfileId ? t('clash.profileForm.editTitle') : t('clash.profileForm.createTitle')"
      width="lg"
      @close="resetTlsForm"
    >
      <form id="tls-profile-form" class="space-y-5" @submit.prevent="saveTlsProfile">
        <div class="flex items-center justify-between gap-3 rounded-lg border border-dashed border-line px-3.5 py-2.5">
          <span class="text-sm text-fg">{{ t("clash.profileForm.claudePreset") }}</span>
          <button type="button" class="btn btn-secondary btn-xs" @click="fillClaudeBunWirePreset">
            <UiIcon name="sparkles" :size="13" />
            {{ t("clash.actions.applyPreset") }}
          </button>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField :label="t('clash.profileForm.name')" required>
            <input
              v-model="tlsName"
              type="text"
              required
              :placeholder="t('clash.profileForm.namePlaceholder')"
              class="input"
            />
          </FormField>
          <FormField :label="t('clash.profileForm.preset')">
            <select v-model="tlsPreset" class="select">
              <option v-for="preset in PRESET_OPTIONS" :key="preset" :value="preset">{{ presetLabel(preset) }}</option>
            </select>
          </FormField>
          <FormField label="ALPN">
            <input v-model="tlsAlpnRaw" type="text" placeholder="h2,http/1.1" class="input font-mono text-xs" />
          </FormField>
          <FormField :label="t('clash.profileForm.os')">
            <select v-model="tlsOsHint" class="select">
              <option value="">{{ t("clash.profileForm.anyOs") }}</option>
              <option v-for="os in OS_OPTIONS" :key="os.value" :value="os.value">{{ os.label }}</option>
            </select>
          </FormField>
        </div>

        <div class="flex items-center justify-between rounded-lg border border-line bg-surface-2/40 px-3.5 py-2.5">
          <span class="text-sm text-fg">{{ t("clash.profileForm.grease") }}</span>
          <UiSwitch v-model="tlsEnableGrease" :label="t('clash.profileForm.grease')" tone="accent" hide-label />
        </div>

        <div class="space-y-4 border-t border-line pt-5">
          <p class="eyebrow">{{ t("clash.profileForm.advanced") }}</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <FormField label="Curves">
              <input v-model="tlsCurvesRaw" type="text" placeholder="4588,29,23,24" class="input font-mono text-xs" />
            </FormField>
            <FormField label="KeyShare">
              <input v-model="tlsKeySharesRaw" type="text" placeholder="4588,29" class="input font-mono text-xs" />
            </FormField>
            <FormField label="Extensions">
              <input v-model="tlsExtensionsRaw" type="text" class="input font-mono text-xs" />
            </FormField>
            <FormField label="CipherSuites">
              <input v-model="tlsCiphersRaw" type="text" class="input font-mono text-xs" />
            </FormField>
          </div>
        </div>

        <div class="space-y-4 border-t border-line pt-5">
          <p class="eyebrow">{{ t("common.optional") }}</p>
          <FormField :label="t('clash.profileForm.userAgent')">
            <input v-model="tlsUA" type="text" class="input font-mono text-xs" />
          </FormField>
          <FormField :label="t('clash.profileForm.ja3')">
            <input v-model="tlsJA3" type="text" class="input font-mono text-xs" />
          </FormField>
        </div>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="tlsDrawerOpen = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="tls-profile-form" :disabled="busyAction" class="btn btn-primary">
          {{ editingProfileId ? t("common.save") : t("clash.actions.createProfile") }}
        </button>
      </template>
    </UiDrawer>
  </div>
</template>
