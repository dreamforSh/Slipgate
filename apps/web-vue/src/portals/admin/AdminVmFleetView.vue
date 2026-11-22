<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  ClashExitNode,
  ClusterNode,
  SlotSeedSnapshot,
  UpstreamAccount,
  VmFleetOverview,
  VmRuntimeProfile,
  VmSlotSummary,
  VmTerminalTicketResponse,
} from "@slipgate/contracts";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiDrawer from "../../components/ui/UiDrawer.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import UsageMeter from "../../components/ui/UsageMeter.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { RUNTIME_PROFILE_TONE, SLOT_STATE_LABEL, formatUnixMs, healthTone } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const auth = useAuthStore();

const loading = ref(false);
const busy = ref(false);
const errorMessage = ref<string | null>(null);
const actionNotice = ref<string | null>(null);
const provisionOpen = ref(false);
const nodeDrawerOpen = ref(false);

useFeedbackToasts(errorMessage, actionNotice);

const overview = ref<VmFleetOverview | null>(null);
const clashNodes = ref<ClashExitNode[]>([]);
const accounts = ref<UpstreamAccount[]>([]);

// Register SSH Node Form
const nodeName = ref("");
const nodeAddr = ref("");
const nodeUser = ref("root");
const nodeArch = ref<"amd64" | "arm64">("amd64");
const nodeKvm = ref(false);
const nodeKeyPem = ref("");

// Provision VM Slot Form
const slotIdInput = ref("");
const provAccountId = ref("");
const provClashNodeId = ref("");
const provClusterNodeId = ref("local-node");
const provHypervisor = ref<"docker_hardened" | "kvm_qemu" | "macos_native">("docker_hardened");
const provRuntimeProfile = ref<VmRuntimeProfile>("claude_code");
const provMemoryMiB = ref(2048);
const provMaxSubagents = ref(20);
const provCleanse = ref<"zero" | "official" | "template">("zero");
const provTelemetry = ref<"isolated" | "enabled" | "disabled">("isolated");
const provTimezone = ref("UTC");

// Selected slot drawers: Seed / Telemetry / Migration / WS Terminal
const activeSlotId = ref<string | null>(null);
const activeSeed = ref<SlotSeedSnapshot | null>(null);
const seedSettingsJson = ref("{}");
const seedCustomEnv = ref("");
const seedAuthJson = ref("");
const seedRejectSettings = ref(true);
const seedRejectIdentity = ref(true);

const migTargetNode = ref("local-node");
const migTargetMem = ref(4096);

const wsSlotId = ref<string | null>(null);
const wsConnected = ref(false);
const wsLogs = ref<string[]>([]);
const wsCommand = ref("");
let wsConn: WebSocket | null = null;

const terminalPanel = ref<HTMLElement | null>(null);
const terminalOutput = ref<HTMLElement | null>(null);

const slotDrawerOpen = computed({
  get: () => activeSlotId.value !== null,
  set: (open: boolean) => {
    if (!open) {
      activeSlotId.value = null;
      activeSeed.value = null;
    }
  },
});

const activeSlot = computed(() => slotList().find((s) => s.slotId === activeSlotId.value) ?? null);
const readySlots = computed(() => slotList().filter((s) => s.state === "ready").length);
const activeSubagents = computed(() => slotList().reduce((sum, s) => sum + s.activeSubagents, 0));
const maxSubagents = computed(() => slotList().reduce((sum, s) => sum + s.maxSubagents, 0));

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

async function loadFleet() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const [vmRes, clashRes, accRes] = await Promise.all([
      auth.apiFetch("/api/v1/admin/vms/overview"),
      auth.apiFetch("/api/v1/admin/clash/nodes"),
      auth.apiFetch("/api/v1/admin/accounts"),
    ]);
    if (!vmRes.ok) {
      errorMessage.value = await readError(vmRes, "加载 VM 舰队状态失败");
      return;
    }
    overview.value = (await vmRes.json()) as VmFleetOverview;
    if (clashRes.ok) {
      const clashData = (await clashRes.json()) as { nodes?: ClashExitNode[] };
      clashNodes.value = clashData.nodes ?? [];
    }
    if (accRes.ok) {
      const accData = (await accRes.json()) as { accounts?: UpstreamAccount[] };
      accounts.value = accData.accounts ?? [];
      if (!provAccountId.value && accounts.value[0]) {
        provAccountId.value = accounts.value[0].id;
        syncRuntimeFromAccount();
      }
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "加载 VM 舰队异常";
  } finally {
    loading.value = false;
  }
}

async function registerNode() {
  busy.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/vms/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nodeName.value,
        driverKind: "ssh",
        sshAddr: nodeAddr.value,
        sshUser: nodeUser.value || "root",
        sshKeyPem: nodeKeyPem.value || undefined,
        arch: nodeArch.value,
        kvmCapable: nodeKvm.value,
        dockerCapable: true,
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "注册 SSH 节点失败");
      return;
    }
    nodeName.value = "";
    nodeAddr.value = "";
    nodeKeyPem.value = "";
    nodeDrawerOpen.value = false;
    actionNotice.value = "集群主机节点已注册";
    await loadFleet();
  } finally {
    busy.value = false;
  }
}

async function deleteNode(id: string) {
  busy.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/vms/nodes/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "删除集群节点失败");
      return;
    }
    actionNotice.value = `节点 ${id} 已移除`;
    await loadFleet();
  } finally {
    busy.value = false;
  }
}

function syncRuntimeFromAccount() {
  const acc = accounts.value.find((a) => a.id === provAccountId.value.trim());
  if (!acc) return;
  if (acc.platform === "antigravity") {
    provRuntimeProfile.value = "antigravity";
  } else if (acc.platform === "codex" || acc.platform === "openai") {
    provRuntimeProfile.value = "codex_cli";
  } else {
    provRuntimeProfile.value = "claude_code";
  }
}

async function provisionSlot() {
  busy.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/vms/slots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slotId: slotIdInput.value.trim() || undefined,
        clusterNodeId: provClusterNodeId.value,
        accountId: provAccountId.value.trim(),
        clashNodeId: provClashNodeId.value.trim() || undefined,
        hypervisorKind: provHypervisor.value,
        runtimeProfile: provRuntimeProfile.value,
        memoryMiB: provMemoryMiB.value,
        maxSubagents: provMaxSubagents.value,
        cleanseMode: provCleanse.value,
        telemetryMode: provTelemetry.value,
        timezone: provTimezone.value.trim() || "UTC",
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "创建拟真 VM 槽失败");
      return;
    }
    slotIdInput.value = "";
    provisionOpen.value = false;
    actionNotice.value = "VM 完全拟真槽已创建并绑定独立出口 IP";
    await loadFleet();
  } finally {
    busy.value = false;
  }
}

async function slotAction(id: string, action: "start" | "stop" | "delete") {
  busy.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const url =
      action === "delete"
        ? `/api/v1/admin/vms/slots/${encodeURIComponent(id)}`
        : `/api/v1/admin/vms/slots/${encodeURIComponent(id)}/${action}`;
    const res = await auth.apiFetch(url, {
      method: action === "delete" ? "DELETE" : "POST",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, `槽位 ${action} 操作失败`);
      return;
    }
    if (action === "delete" && activeSlotId.value === id) {
      activeSlotId.value = null;
      activeSeed.value = null;
    }
    actionNotice.value = `槽位 ${id} ${action} 执行成功`;
    await loadFleet();
  } finally {
    busy.value = false;
  }
}

async function inspectSlotSeed(slot: VmSlotSummary) {
  activeSlotId.value = slot.slotId;
  migTargetNode.value = slot.clusterNodeId;
  migTargetMem.value = slot.memoryMiB;
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/vms/${encodeURIComponent(slot.slotId)}/seed`);
  if (!res.ok) {
    errorMessage.value = await readError(res, "读取 Seed 配置失败");
    return;
  }
  const snap = (await res.json()) as SlotSeedSnapshot;
  activeSeed.value = snap;
  seedSettingsJson.value = snap.settingsJsonRaw;
  seedCustomEnv.value = snap.customSettingRaw;
  seedAuthJson.value = snap.authJsonRaw ?? "";
  seedRejectSettings.value = snap.rejectClientSettings;
  seedRejectIdentity.value = snap.rejectClientIdentity;
}

function fillRuntimeSeedTemplate(runtime: VmRuntimeProfile) {
  if (runtime === "antigravity") {
    seedSettingsJson.value = JSON.stringify(
      {
        "antigravity.telemetry": "isolated",
        "antigravity.cloudCodeEndpoint": "https://cloudcode-pa.googleapis.com",
      },
      null,
      2,
    );
    seedAuthJson.value = JSON.stringify(
      {
        accessToken: "ya29.replace-me",
        refreshToken: "1//replace-me",
        projectId: "rising-fact-p41fc",
      },
      null,
      2,
    );
    return;
  }
  if (runtime === "codex_cli") {
    seedSettingsJson.value = JSON.stringify(
      {
        model: "gpt-5-codex",
        approval_policy: "never",
        sandbox_mode: "workspace-write",
      },
      null,
      2,
    );
    seedAuthJson.value = JSON.stringify(
      {
        tokens: {
          access_token: "eyJhbGciOi-replace-me",
          refresh_token: "rt_replace_me",
          account_id: "acct_chatgpt_replace_me",
        },
      },
      null,
      2,
    );
    return;
  }
  seedSettingsJson.value = JSON.stringify(
    {
      cleanupPeriodDays: 30,
      includeCoAuthoredBy: false,
      permissions: { allow: [], deny: [] },
    },
    null,
    2,
  );
  seedAuthJson.value = JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-replace-me",
        refreshToken: "sk-ant-ort01-replace-me",
      },
    },
    null,
    2,
  );
}

async function saveSlotSeed() {
  if (!activeSlotId.value) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(
      `/api/v1/admin/vms/slots/${encodeURIComponent(activeSlotId.value)}/seed`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settingsJsonRaw: seedSettingsJson.value,
          customSettingRaw: seedCustomEnv.value,
          authJsonRaw: seedAuthJson.value,
          rejectClientSettings: seedRejectSettings.value,
          rejectClientIdentity: seedRejectIdentity.value,
        }),
      },
    );
    if (!res.ok) {
      errorMessage.value = await readError(res, "保存 Seed 配置失败");
      return;
    }
    activeSeed.value = (await res.json()) as SlotSeedSnapshot;
    actionNotice.value = `槽位 ${activeSlotId.value} Seed 已下发并落盘`;
  } finally {
    busy.value = false;
  }
}

async function updateSlotTelemetry(slot: VmSlotSummary, nextMode: "isolated" | "enabled" | "disabled") {
  busy.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(
      `/api/v1/admin/vms/slots/${encodeURIComponent(slot.slotId)}/telemetry`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telemetryMode: nextMode,
          cleanseMode: slot.cleanseMode,
        }),
      },
    );
    if (!res.ok) {
      errorMessage.value = await readError(res, "切换遥测策略失败");
      return;
    }
    actionNotice.value = `槽位 ${slot.slotId} telemetry -> ${nextMode}`;
    await loadFleet();
  } finally {
    busy.value = false;
  }
}

async function migrateActiveSlot() {
  if (!activeSlotId.value) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(
      `/api/v1/admin/vms/slots/${encodeURIComponent(activeSlotId.value)}/migrate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetClusterNodeId: migTargetNode.value,
          targetMemoryMiB: migTargetMem.value,
        }),
      },
    );
    if (!res.ok) {
      errorMessage.value = await readError(res, "KVM 迁移/扩容失败");
      return;
    }
    actionNotice.value = `槽位 ${activeSlotId.value} 已迁移到 ${migTargetNode.value} (${migTargetMem.value} MiB)`;
    await loadFleet();
  } finally {
    busy.value = false;
  }
}

function closeWebSocket() {
  if (wsConn) {
    wsConn.close();
    wsConn = null;
  }
  wsConnected.value = false;
}

function closeTerminalPanel() {
  closeWebSocket();
  wsSlotId.value = null;
}

async function connectTerminal(slotId: string) {
  closeWebSocket();
  wsSlotId.value = slotId;
  wsLogs.value = [`[client] 正在为 ${slotId} 签发一次性 WS 诊断票据...`];
  errorMessage.value = null;
  await nextTick();
  terminalPanel.value?.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const res = await auth.apiFetch(
    `/api/v1/admin/vms/slots/${encodeURIComponent(slotId)}/terminal-ticket`,
    { method: "POST" },
  );
  if (!res.ok) {
    errorMessage.value = await readError(res, "获取 WebSocket 终端票据失败");
    return;
  }
  const ticket = (await res.json()) as VmTerminalTicketResponse;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${window.location.host}${ticket.wsPath}`;

  wsConn = new WebSocket(wsUrl);
  wsConn.onopen = () => {
    wsConnected.value = true;
  };
  wsConn.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        stdout?: string;
        stderr?: string;
        command?: string;
      };
      if (msg.command) wsLogs.value.push(`$ ${msg.command}`);
      if (msg.stdout) wsLogs.value.push(msg.stdout.trimEnd());
      if (msg.stderr) wsLogs.value.push(`[stderr] ${msg.stderr.trimEnd()}`);
    } catch {
      wsLogs.value.push(String(ev.data));
    }
  };
  wsConn.onclose = () => {
    wsConnected.value = false;
    wsLogs.value.push("[client] WebSocket 连接已关闭");
  };
}

function sendWsCommand(cmd?: string) {
  const value = (cmd ?? wsCommand.value).trim();
  if (!value || !wsConn || wsConn.readyState !== WebSocket.OPEN) return;
  wsConn.send(value);
  if (!cmd) wsCommand.value = "";
}

function nodeList(): ClusterNode[] {
  return overview.value?.nodes ?? [];
}

function slotList(): VmSlotSummary[] {
  return overview.value?.slots ?? [];
}

watch(
  () => wsLogs.value.length,
  async () => {
    await nextTick();
    if (terminalOutput.value) {
      terminalOutput.value.scrollTop = terminalOutput.value.scrollHeight;
    }
  },
);

onMounted(() => {
  void loadFleet();
});

onBeforeUnmount(() => {
  closeWebSocket();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="VM 拟真槽舰队"
      description="在隔离的 KVM / 容器槽位中运行官方 CLI。每槽绑定独立出口、固化不可变硬件指纹，支持 Seed 热同步与排空迁移。"
    >
      <template #meta>
        <UiBadge :tone="overview?.runtime.guestdAvailable ? 'success' : 'neutral'" dot>
          guestd {{ overview?.runtime.guestdAvailable ? "就绪" : "沙盒模式" }}
        </UiBadge>
        <UiBadge :tone="overview?.invariants.oneSlotOneEgress ? 'success' : 'warning'">
          1-Slot-1-Egress {{ overview?.invariants.oneSlotOneEgress ? "强制" : "关闭" }}
        </UiBadge>
        <UiBadge v-if="overview?.invariants.zeroPromptInjection" tone="accent">Zero-Injection</UiBadge>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadFleet">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          刷新
        </button>
        <button type="button" class="btn btn-secondary" @click="nodeDrawerOpen = true">
          <UiIcon name="network" :size="15" />
          注册节点
        </button>
        <button type="button" class="btn btn-primary" @click="provisionOpen = true">
          <UiIcon name="plus" :size="15" />
          部署槽位
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard label="集群节点" :value="nodeList().length" icon="network" tone="accent" />
      <StatCard label="就绪槽位" :value="`${readySlots} / ${slotList().length}`" icon="server" tone="success" />
      <StatCard
        label="活跃 Subagents"
        :value="`${activeSubagents} / ${maxSubagents}`"
        icon="activity"
        tone="info"
        :hint="`默认每槽 ${overview?.invariants.maxSubagentsDefault ?? 20} 路`"
      />
      <StatCard label="迁移任务" :value="overview?.migrations.length ?? 0" icon="migrate" tone="violet" />
    </div>

    <!-- Slots -->
    <UiCard icon="server" title="VM / 容器槽位" :description="`共 ${slotList().length} 个槽位`" flush>
      <EmptyState
        v-if="slotList().length === 0"
        icon="server"
        title="还没有部署槽位"
        description="选择一个已绑定健康出口的上游账号，部署第一个执行槽。"
      >
        <button type="button" class="btn btn-primary btn-sm" @click="provisionOpen = true">
          <UiIcon name="plus" :size="14" />
          部署槽位
        </button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>槽位</th>
              <th>账号 / 出口</th>
              <th class="hidden 2xl:table-cell">硬件指纹</th>
              <th>状态</th>
              <th>配额窗口</th>
              <th>Telemetry</th>
              <th class="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="slot in slotList()" :key="slot.slotId">
              <td>
                <p class="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs font-medium text-fg">
                  {{ slot.slotId }}
                  <UiBadge :tone="RUNTIME_PROFILE_TONE[slot.runtimeProfile] ?? 'neutral'">{{ slot.runtimeProfile }}</UiBadge>
                </p>
                <p class="mt-0.5 whitespace-nowrap font-mono text-2xs text-fg-subtle">
                  {{ slot.clusterNodeId }} · {{ slot.hypervisorKind }} · {{ slot.memoryMiB }} MiB
                </p>
              </td>
              <td class="max-w-[11rem]">
                <p class="truncate font-mono text-xs text-fg" :title="slot.accountId">{{ slot.accountId }}</p>
                <p class="mt-0.5 truncate font-mono text-2xs text-success" :title="`${slot.exitIp} · ${slot.clashNodeId}`">
                  {{ slot.exitIp }} · {{ slot.clashNodeId }}
                </p>
              </td>
              <td class="hidden 2xl:table-cell">
                <p class="font-mono text-2xs text-fg-muted" :title="slot.persona.guestMachineId">
                  {{ slot.persona.guestMachineId.slice(0, 16) }}…
                </p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ slot.persona.macAddress }}</p>
              </td>
              <td>
                <UiBadge :tone="healthTone(slot.state)" dot>{{ SLOT_STATE_LABEL[slot.state] ?? slot.state }}</UiBadge>
                <UsageMeter class="mt-2 w-28" label="Subagents" :value="slot.activeSubagents" :max="slot.maxSubagents" />
              </td>
              <td>
                <div class="flex w-32 flex-col gap-1.5">
                  <UsageMeter label="5h" :bps="slot.window5hUsedBps" />
                  <UsageMeter label="7d" :bps="slot.window7dUsedBps" />
                </div>
              </td>
              <td>
                <select
                  :value="slot.telemetryMode"
                  class="select input-sm w-28"
                  aria-label="Telemetry 策略"
                  :disabled="busy"
                  @change="updateSlotTelemetry(slot, ($event.target as HTMLSelectElement).value as 'isolated' | 'enabled' | 'disabled')"
                >
                  <option value="isolated">isolated</option>
                  <option value="enabled">enabled</option>
                  <option value="disabled">disabled</option>
                </select>
                <p class="mt-1 font-mono text-2xs text-fg-subtle">cleanse={{ slot.cleanseMode }}</p>
              </td>
              <td class="text-right">
                <div class="inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs hover:!text-success"
                    title="启动"
                    aria-label="启动"
                    :disabled="busy"
                    @click="slotAction(slot.slotId, 'start')"
                  >
                    <UiIcon name="play" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs hover:!text-warning"
                    title="停止"
                    aria-label="停止"
                    :disabled="busy"
                    @click="slotAction(slot.slotId, 'stop')"
                  >
                    <UiIcon name="stop" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    title="Seed 与迁移"
                    aria-label="Seed 与迁移"
                    @click="inspectSlotSeed(slot)"
                  >
                    <UiIcon name="sliders" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :class="wsSlotId === slot.slotId ? '!text-accent' : ''"
                    title="诊断终端"
                    aria-label="诊断终端"
                    @click="connectTerminal(slot.slotId)"
                  >
                    <UiIcon name="terminal" :size="13" />
                  </button>
                  <ConfirmButton label="销毁" confirm-label="确认销毁" icon-only :disabled="busy" @confirm="slotAction(slot.slotId, 'delete')" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Terminal -->
    <section
      v-if="wsSlotId"
      ref="terminalPanel"
      class="animate-slide-up overflow-hidden rounded-xl border border-line bg-[#0b0d12] shadow-card"
    >
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
        <div class="flex items-center gap-2.5">
          <UiIcon name="terminal" :size="15" class="text-slate-400" />
          <span class="font-mono text-xs text-slate-200">{{ wsSlotId }}</span>
          <span class="inline-flex items-center gap-1.5 font-mono text-2xs" :class="wsConnected ? 'text-emerald-400' : 'text-slate-500'">
            <span class="h-1.5 w-1.5 rounded-full" :class="wsConnected ? 'bg-emerald-400' : 'bg-slate-500'" />
            {{ wsConnected ? "CONNECTED" : "DISCONNECTED" }}
          </span>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <button
            v-for="quick in ['help', 'status', 'runtime', 'machine-id', 'persona', 'ping', 'ls']"
            :key="quick"
            type="button"
            class="h-6 cursor-pointer rounded border border-white/10 px-2 font-mono text-2xs text-slate-300 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!wsConnected"
            @click="sendWsCommand(quick)"
          >
            {{ quick }}
          </button>
          <button
            type="button"
            class="ml-1 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            title="断开并关闭"
            aria-label="断开并关闭"
            @click="closeTerminalPanel"
          >
            <UiIcon name="x" :size="14" />
          </button>
        </div>
      </div>
      <pre
        ref="terminalOutput"
        class="h-64 overflow-y-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs leading-relaxed text-emerald-200/90"
      >{{ wsLogs.join("\n") }}</pre>
      <form class="flex items-center gap-2 border-t border-white/10 px-4 py-2.5" @submit.prevent="sendWsCommand()">
        <span class="font-mono text-xs text-emerald-400">$</span>
        <input
          v-model="wsCommand"
          type="text"
          spellcheck="false"
          placeholder="输入沙盒命令，如 cat etc/machine-id / env / seed"
          class="min-w-0 flex-1 bg-transparent font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600"
          aria-label="终端命令"
        />
        <button
          type="submit"
          class="h-7 cursor-pointer rounded-md bg-emerald-500/90 px-3 text-xs font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
          :disabled="!wsConnected"
        >
          执行
        </button>
      </form>
    </section>

    <!-- Cluster nodes -->
    <UiCard icon="network" title="集群主机节点" description="通过无 Agent SSH 纳管的算力主机" flush>
      <template #actions>
        <button type="button" class="btn btn-secondary btn-sm" @click="nodeDrawerOpen = true">
          <UiIcon name="plus" :size="14" />
          注册节点
        </button>
      </template>
      <EmptyState v-if="nodeList().length === 0" compact icon="network" title="暂无集群节点" />
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>节点</th>
              <th>驱动 / 地址</th>
              <th>架构</th>
              <th>能力</th>
              <th>状态</th>
              <th class="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in nodeList()" :key="n.id">
              <td>
                <p class="font-medium text-fg">{{ n.name }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ n.id }}</p>
              </td>
              <td class="font-mono text-xs text-fg-muted">
                {{ n.driverKind }}<template v-if="n.sshAddr"> · {{ n.sshUser }}@{{ n.sshAddr }}</template>
              </td>
              <td><span class="code-chip">{{ n.arch }}</span></td>
              <td>
                <div class="flex gap-1">
                  <UiBadge v-if="n.kvmCapable" tone="violet">KVM</UiBadge>
                  <UiBadge v-if="n.dockerCapable" tone="info">Docker</UiBadge>
                  <UiBadge v-if="n.hasSSHKey" tone="neutral">
                    <UiIcon name="lock" :size="10" />
                    SSH Key
                  </UiBadge>
                </div>
              </td>
              <td><UiBadge :tone="healthTone(n.status)" dot>{{ n.status }}</UiBadge></td>
              <td class="text-right">
                <ConfirmButton v-if="n.id !== 'local-node'" label="移除" confirm-label="确认移除" icon-only :disabled="busy" @confirm="deleteNode(n.id)" />
                <span v-else class="text-2xs text-fg-subtle">本机</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Provision drawer -->
    <UiDrawer
      v-model:open="provisionOpen"
      title="部署 VM 执行槽"
      description="创建后生成不可变 Hardware Persona，并绑定账号的独立出口"
      width="lg"
    >
      <form id="provision-form" class="space-y-5" @submit.prevent="provisionSlot">
        <div class="grid gap-4 sm:grid-cols-2">
          <FormField label="上游账号 ID" required hint="账号需已绑定健康的 Clash 出口">
            <input
              v-model="provAccountId"
              type="text"
              list="vm-account-options"
              required
              placeholder="选择或输入账号 ID"
              class="input font-mono text-xs"
              @change="syncRuntimeFromAccount"
            />
            <datalist id="vm-account-options">
              <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name }} ({{ acc.platform }})</option>
            </datalist>
          </FormField>
          <FormField label="槽位 ID" hint="留空自动生成">
            <input v-model="slotIdInput" type="text" class="input font-mono text-xs" />
          </FormField>
          <FormField label="集群节点">
            <select v-model="provClusterNodeId" class="select">
              <option v-for="n in nodeList()" :key="n.id" :value="n.id">{{ n.name }}（{{ n.id }} · {{ n.arch }}）</option>
            </select>
          </FormField>
          <FormField label="Clash 出口">
            <select v-model="provClashNodeId" class="select">
              <option value="">自动读取账号绑定</option>
              <option v-for="cn in clashNodes" :key="cn.nodeId" :value="cn.nodeId">
                {{ cn.name }} · {{ cn.exitIp || "未探测" }}（{{ cn.healthStatus }}）
              </option>
            </select>
          </FormField>
        </div>

        <div class="space-y-4 border-t border-line pt-5">
          <p class="text-2xs font-medium uppercase tracking-wider text-fg-subtle">运行时与资源</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <FormField label="Runtime">
              <select v-model="provRuntimeProfile" class="select">
                <option value="claude_code">claude_code</option>
                <option value="codex_cli">codex_cli</option>
                <option value="antigravity">antigravity（反重力）</option>
              </select>
            </FormField>
            <FormField label="Hypervisor">
              <select v-model="provHypervisor" class="select">
                <option value="docker_hardened">docker_hardened</option>
                <option value="kvm_qemu">kvm_qemu</option>
                <option value="macos_native">macos_native</option>
              </select>
            </FormField>
          </div>
          <div class="grid gap-4 sm:grid-cols-3">
            <FormField label="内存 MiB">
              <input v-model.number="provMemoryMiB" type="number" min="512" class="input font-mono" />
            </FormField>
            <FormField label="Subagents 上限">
              <input v-model.number="provMaxSubagents" type="number" min="1" max="64" class="input font-mono" />
            </FormField>
            <FormField label="时区">
              <input v-model="provTimezone" type="text" class="input font-mono" />
            </FormField>
          </div>
        </div>

        <div class="space-y-4 border-t border-line pt-5">
          <p class="text-2xs font-medium uppercase tracking-wider text-fg-subtle">策略</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <FormField label="Telemetry">
              <select v-model="provTelemetry" class="select">
                <option value="isolated">isolated</option>
                <option value="enabled">enabled</option>
                <option value="disabled">disabled</option>
              </select>
            </FormField>
            <FormField label="Cleanse">
              <select v-model="provCleanse" class="select">
                <option value="zero">zero（无头净化）</option>
                <option value="official">official</option>
                <option value="template">template</option>
              </select>
            </FormField>
          </div>
        </div>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="provisionOpen = false">取消</button>
        <button type="submit" form="provision-form" :disabled="busy" class="btn btn-primary">
          <UiIcon v-if="busy" name="loader" :size="14" spin />
          部署槽位
        </button>
      </template>
    </UiDrawer>

    <!-- Register node drawer -->
    <UiDrawer v-model:open="nodeDrawerOpen" title="注册 SSH 主机节点" description="无 Agent 纳管，私钥以 AES-256-GCM 加密存储">
      <form id="node-form" class="space-y-4" @submit.prevent="registerNode">
        <FormField label="节点名称" required>
          <input v-model="nodeName" type="text" required placeholder="如 Tokyo-KVM-02" class="input" />
        </FormField>
        <div class="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
          <FormField label="SSH 地址" required>
            <input v-model="nodeAddr" type="text" required placeholder="host:port" class="input font-mono text-xs" />
          </FormField>
          <FormField label="用户">
            <input v-model="nodeUser" type="text" placeholder="root" class="input font-mono text-xs" />
          </FormField>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <FormField label="架构">
            <select v-model="nodeArch" class="select">
              <option value="amd64">amd64</option>
              <option value="arm64">arm64</option>
            </select>
          </FormField>
          <div>
            <span class="label">KVM 硬件虚拟化</span>
            <div class="flex h-9 items-center">
              <UiSwitch v-model="nodeKvm" :label="nodeKvm ? '支持' : '不支持'" tone="accent" />
            </div>
          </div>
        </div>
        <FormField label="OpenSSH 私钥" hint="PEM 格式，可留空使用已配置的默认密钥">
          <textarea v-model="nodeKeyPem" rows="6" spellcheck="false" class="textarea font-mono text-xs" />
        </FormField>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="nodeDrawerOpen = false">取消</button>
        <button type="submit" form="node-form" :disabled="busy" class="btn btn-primary">注册节点</button>
      </template>
    </UiDrawer>

    <!-- Slot detail drawer: seed + migration -->
    <UiDrawer
      v-model:open="slotDrawerOpen"
      :title="`槽位 ${activeSlotId ?? ''}`"
      :description="activeSeed ? `Seed 最近同步 ${formatUnixMs(activeSeed.syncedAtUnixMs)}` : '正在读取 Seed 配置…'"
      width="xl"
    >
      <div class="space-y-6">
        <div v-if="activeSlot" class="grid grid-cols-2 gap-3 rounded-lg border border-line bg-surface-2/40 p-3.5 sm:grid-cols-4">
          <div>
            <p class="text-2xs text-fg-subtle">Runtime</p>
            <p class="mt-0.5 font-mono text-xs text-fg">{{ activeSeed?.runtimeProfile ?? activeSlot.runtimeProfile }}</p>
          </div>
          <div>
            <p class="text-2xs text-fg-subtle">状态</p>
            <p class="mt-0.5"><UiBadge :tone="healthTone(activeSlot.state)" dot>{{ SLOT_STATE_LABEL[activeSlot.state] ?? activeSlot.state }}</UiBadge></p>
          </div>
          <div>
            <p class="text-2xs text-fg-subtle">Telemetry 守护进程</p>
            <p class="mt-0.5 font-mono text-xs text-fg">{{ activeSeed?.telemetryDaemonRunning ? "运行中" : "未运行" }}</p>
          </div>
          <div>
            <p class="text-2xs text-fg-subtle">MAC</p>
            <p class="mt-0.5 truncate font-mono text-xs text-fg">{{ activeSlot.persona.macAddress }}</p>
          </div>
          <div class="col-span-2">
            <p class="text-2xs text-fg-subtle">Guest Machine-ID</p>
            <p class="mt-0.5 truncate font-mono text-xs text-fg" :title="activeSlot.persona.guestMachineId">{{ activeSlot.persona.guestMachineId }}</p>
          </div>
          <div class="col-span-2">
            <p class="text-2xs text-fg-subtle">SMBIOS UUID</p>
            <p class="mt-0.5 truncate font-mono text-xs text-fg" :title="activeSlot.persona.smbiosUuid">{{ activeSlot.persona.smbiosUuid }}</p>
          </div>
        </div>

        <section>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 class="text-sm font-semibold text-fg">Seed 热同步</h3>
              <p class="mt-0.5 text-xs text-fg-subtle">修改后保存会热推送到槽内并落盘</p>
            </div>
            <button
              type="button"
              class="btn btn-secondary btn-xs"
              @click="fillRuntimeSeedTemplate(activeSeed?.runtimeProfile ?? 'claude_code')"
            >
              <UiIcon name="sparkles" :size="13" />
              填充运行时模板
            </button>
          </div>
          <div class="mt-4 space-y-4">
            <FormField label="settings.json / config.toml 映射">
              <textarea v-model="seedSettingsJson" rows="7" spellcheck="false" class="textarea font-mono text-xs" />
            </FormField>
            <FormField label="OAuth 种子 JSON" hint=".credentials.json / .codex/auth.json / .antigravity/oauth_creds.json，AES-GCM 加密落盘">
              <textarea v-model="seedAuthJson" rows="6" spellcheck="false" class="textarea font-mono text-xs" />
            </FormField>
            <FormField label="自定义环境变量 / runtime flag">
              <textarea v-model="seedCustomEnv" rows="3" spellcheck="false" class="textarea font-mono text-xs" />
            </FormField>
            <div class="flex flex-wrap gap-x-6 gap-y-2">
              <label class="flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
                <input v-model="seedRejectSettings" type="checkbox" class="checkbox" />
                拒绝客户端设置覆盖
              </label>
              <label class="flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
                <input v-model="seedRejectIdentity" type="checkbox" class="checkbox" />
                拒绝客户端身份覆盖
              </label>
            </div>
            <button type="button" :disabled="busy || !activeSeed" class="btn btn-primary" @click="saveSlotSeed">
              <UiIcon :name="busy ? 'loader' : 'check'" :size="14" :spin="busy" />
              保存并热推送
            </button>
          </div>
        </section>

        <section class="border-t border-line pt-6">
          <h3 class="text-sm font-semibold text-fg">排空迁移 / 内存调整</h3>
          <p class="mt-0.5 text-xs text-fg-subtle">
            仅 <span class="code-chip">kvm_qemu</span> 且 Active Subagents 为 0 时可迁移；保留原 AccountID 与 GuestMachineID。
          </p>
          <div class="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
            <FormField label="目标节点">
              <select v-model="migTargetNode" class="select">
                <option v-for="n in nodeList()" :key="n.id" :value="n.id">{{ n.name }}（{{ n.id }}）</option>
              </select>
            </FormField>
            <FormField label="目标内存 MiB">
              <input v-model.number="migTargetMem" type="number" min="512" step="512" class="input font-mono" />
            </FormField>
            <button type="button" :disabled="busy" class="btn btn-secondary" @click="migrateActiveSlot">
              <UiIcon name="migrate" :size="14" />
              执行迁移
            </button>
          </div>
        </section>
      </div>
    </UiDrawer>
  </div>
</template>
