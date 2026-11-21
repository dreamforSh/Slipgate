<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type {
  ClashExitNode,
  ClusterNode,
  SlotSeedSnapshot,
  UpstreamAccount,
  VmFleetOverview,
  VmSlotSummary,
  VmTerminalTicketResponse,
} from "@slipgate/contracts";
import { useAuthStore } from "../../stores/auth";

const auth = useAuthStore();

const loading = ref(false);
const busy = ref(false);
const errorMessage = ref<string | null>(null);
const actionNotice = ref<string | null>(null);

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
const seedRejectSettings = ref(true);
const seedRejectIdentity = ref(true);

const migTargetNode = ref("local-node");
const migTargetMem = ref(4096);

const wsSlotId = ref<string | null>(null);
const wsConnected = ref(false);
const wsLogs = ref<string[]>([]);
const wsCommand = ref("");
let wsConn: WebSocket | null = null;

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
  seedRejectSettings.value = snap.rejectClientSettings;
  seedRejectIdentity.value = snap.rejectClientIdentity;
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

async function connectTerminal(slotId: string) {
  closeWebSocket();
  wsSlotId.value = slotId;
  wsLogs.value = [`[client] 正在为 ${slotId} 签发一次性 WS 诊断票据...`];
  errorMessage.value = null;

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

onMounted(() => {
  void loadFleet();
});

onBeforeUnmount(() => {
  closeWebSocket();
});
</script>

<template>
  <div class="space-y-8">
    <section class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-white">VM 完全拟真槽与集群控制台</h1>
        <p class="mt-1 text-sm text-slate-400">
          强制 1-Slot-1-Egress Fail-Closed、不可变 32-Hex Hardware Persona、Seed 注入、KVM 排空迁移与 WebSocket 沙盒控制台。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-3 text-xs">
        <span class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-slate-300">
          guestd: {{ overview?.runtime.guestdAvailable ? "ready (Zig 0.14)" : "sandbox-ready" }}
        </span>
        <span class="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 font-mono text-emerald-300">
          1-Slot-1-Egress: {{ overview?.invariants.oneSlotOneEgress ? "ENFORCED" : "OFF" }}
        </span>
        <button
          type="button"
          :disabled="loading"
          class="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:border-sky-500"
          @click="loadFleet"
        >
          刷新舰队
        </button>
      </div>
    </section>

    <div v-if="errorMessage" class="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
      {{ errorMessage }}
    </div>
    <div v-if="actionNotice" class="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">
      {{ actionNotice }}
    </div>

    <!-- Provision VM Slot + Register SSH Cluster Node -->
    <section class="grid gap-6 lg:grid-cols-2">
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h2 class="text-base font-semibold text-white">创建并启动拟真 VM 槽位</h2>
        <form class="mt-4 space-y-3" @submit.prevent="provisionSlot">
          <div class="grid gap-3 sm:grid-cols-2">
            <input
              v-model="slotIdInput"
              type="text"
              placeholder="槽位 ID（留空自动生成）"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
            />
            <select
              v-model="provClusterNodeId"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            >
              <option v-for="n in nodeList()" :key="n.id" :value="n.id">
                {{ n.name }} ({{ n.id }} · {{ n.arch }})
              </option>
            </select>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <input
              v-model="provAccountId"
              type="text"
              required
              placeholder="上游账号 ID（需已绑定健康 Clash 出口）"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
            />
            <select
              v-model="provClashNodeId"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            >
              <option value="">自动读取账号绑定 Clash 出口</option>
              <option v-for="cn in clashNodes" :key="cn.nodeId" :value="cn.nodeId">
                {{ cn.name }} · {{ cn.exitIp || "未探测" }} ({{ cn.healthStatus }})
              </option>
            </select>
          </div>
          <div class="grid gap-3 sm:grid-cols-4">
            <select
              v-model="provHypervisor"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            >
              <option value="docker_hardened">docker_hardened</option>
              <option value="kvm_qemu">kvm_qemu</option>
              <option value="macos_native">macos_native</option>
            </select>
            <input
              v-model.number="provMemoryMiB"
              type="number"
              min="512"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
              placeholder="RAM MiB"
            />
            <input
              v-model.number="provMaxSubagents"
              type="number"
              min="1"
              max="64"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
              placeholder="Subagents"
            />
            <input
              v-model="provTimezone"
              type="text"
              placeholder="Timezone"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
            />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <select
              v-model="provTelemetry"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            >
              <option value="isolated">Telemetry: isolated</option>
              <option value="enabled">Telemetry: enabled</option>
              <option value="disabled">Telemetry: disabled</option>
            </select>
            <select
              v-model="provCleanse"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            >
              <option value="zero">Cleanse: zero (无头净化)</option>
              <option value="official">Cleanse: official</option>
              <option value="template">Cleanse: template</option>
            </select>
          </div>
          <button
            type="submit"
            :disabled="busy"
            class="w-full rounded-lg bg-sky-500 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400"
          >
            部署拟真槽并生成不可变 Hardware Persona
          </button>
        </form>
      </div>

      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h2 class="text-base font-semibold text-white">注册无 Agent SSH 算力主机节点</h2>
        <form class="mt-4 space-y-3" @submit.prevent="registerNode">
          <div class="grid gap-3 sm:grid-cols-2">
            <input
              v-model="nodeName"
              type="text"
              required
              placeholder="节点名称（如 Tokyo-KVM-02）"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            />
            <input
              v-model="nodeAddr"
              type="text"
              required
              placeholder="SSH 地址 host:port"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
            />
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <input
              v-model="nodeUser"
              type="text"
              placeholder="SSH User (root)"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
            />
            <select
              v-model="nodeArch"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            >
              <option value="amd64">amd64</option>
              <option value="arm64">arm64</option>
            </select>
            <label class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200">
              <input v-model="nodeKvm" type="checkbox" />
              KVM 硬件虚拟化
            </label>
          </div>
          <textarea
            v-model="nodeKeyPem"
            rows="2"
            placeholder="OpenSSH Private Key PEM（由 AES-256-GCM 加密存储）"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
          />
          <button
            type="submit"
            :disabled="busy"
            class="w-full rounded-lg border border-sky-500/40 bg-sky-500/15 py-2 text-xs font-medium text-sky-300 hover:bg-sky-500/25"
          >
            注册 SSH 集群节点
          </button>
        </form>

        <div class="mt-4 space-y-2">
          <div
            v-for="n in nodeList()"
            :key="n.id"
            class="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs"
          >
            <div>
              <span class="font-medium text-white">{{ n.name }}</span>
              <span class="ml-2 font-mono text-slate-400">{{ n.id }} · {{ n.driverKind }} · {{ n.sshAddr }}</span>
              <span v-if="n.kvmCapable" class="ml-2 rounded bg-violet-500/20 px-1.5 py-0.5 text-[11px] text-violet-300">
                KVM
              </span>
            </div>
            <button
              v-if="n.id !== 'local-node'"
              type="button"
              class="rounded border border-rose-500/40 px-2 py-0.5 text-rose-300"
              @click="deleteNode(n.id)"
            >
              移除
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- VM Slots Fleet Table -->
    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="text-base font-semibold text-white">运行中 VM / 容器槽位 ({{ slotList().length }})</h2>
      <div class="mt-4 overflow-x-auto">
        <table class="min-w-full text-left text-xs">
          <thead>
            <tr class="border-b border-slate-800 text-slate-400">
              <th class="px-3 py-2">Slot / Node</th>
              <th class="px-3 py-2">Account / Exit IP</th>
              <th class="px-3 py-2">不可变 Machine-ID / SMBIOS</th>
              <th class="px-3 py-2">运行态 & Subagents</th>
              <th class="px-3 py-2">Telemetry / Cleanse</th>
              <th class="px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800/70">
            <tr v-for="slot in slotList()" :key="slot.slotId">
              <td class="px-3 py-3">
                <p class="font-mono font-semibold text-sky-300">{{ slot.slotId }}</p>
                <p class="text-slate-400">{{ slot.clusterNodeId }} · {{ slot.hypervisorKind }} · {{ slot.memoryMiB }} MiB</p>
              </td>
              <td class="px-3 py-3 font-mono">
                <p class="text-slate-200">{{ slot.accountId }}</p>
                <p class="text-emerald-300">{{ slot.exitIp }} ({{ slot.clashNodeId }})</p>
              </td>
              <td class="px-3 py-3 font-mono text-[11px] text-slate-300">
                <p>id: {{ slot.persona.guestMachineId.slice(0, 16) }}…</p>
                <p class="text-slate-400">mac: {{ slot.persona.macAddress }}</p>
              </td>
              <td class="px-3 py-3">
                <span class="rounded bg-slate-800 px-2 py-0.5 font-mono text-white">{{ slot.state }}</span>
                <p class="mt-1 font-mono text-slate-400">
                  Subagents: {{ slot.activeSubagents }}/{{ slot.maxSubagents }}
                </p>
              </td>
              <td class="px-3 py-3">
                <select
                  :value="slot.telemetryMode"
                  class="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
                  @change="updateSlotTelemetry(slot, ($event.target as HTMLSelectElement).value as 'isolated' | 'enabled' | 'disabled')"
                >
                  <option value="isolated">isolated</option>
                  <option value="enabled">enabled</option>
                  <option value="disabled">disabled</option>
                </select>
                <p class="mt-1 font-mono text-[11px] text-slate-400">cleanse={{ slot.cleanseMode }}</p>
              </td>
              <td class="px-3 py-3">
                <div class="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    class="rounded border border-emerald-500/40 px-2 py-1 text-emerald-300"
                    @click="slotAction(slot.slotId, 'start')"
                  >
                    启动
                  </button>
                  <button
                    type="button"
                    class="rounded border border-amber-500/40 px-2 py-1 text-amber-300"
                    @click="slotAction(slot.slotId, 'stop')"
                  >
                    停止
                  </button>
                  <button
                    type="button"
                    class="rounded border border-sky-500/40 px-2 py-1 text-sky-300"
                    @click="inspectSlotSeed(slot)"
                  >
                    Seed/迁移
                  </button>
                  <button
                    type="button"
                    class="rounded border border-violet-500/40 px-2 py-1 text-violet-300"
                    @click="connectTerminal(slot.slotId)"
                  >
                    终端
                  </button>
                  <button
                    type="button"
                    class="rounded border border-rose-500/40 px-2 py-1 text-rose-300"
                    @click="slotAction(slot.slotId, 'delete')"
                  >
                    销毁
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Seed Editor + KVM Migration -->
    <section v-if="activeSlotId" class="grid gap-6 lg:grid-cols-2">
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h3 class="text-sm font-semibold text-white">
          Seed 热同步编辑器 · {{ activeSlotId }}
          <span class="ml-2 font-mono text-xs font-normal text-slate-400">
            (synced: {{ activeSeed?.syncedAtUnixMs ?? "-" }})
          </span>
        </h3>
        <div class="mt-3 space-y-3">
          <textarea
            v-model="seedSettingsJson"
            rows="6"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-200"
          />
          <textarea
            v-model="seedCustomEnv"
            rows="3"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-200"
          />
          <div class="flex flex-wrap gap-4 text-xs text-slate-300">
            <label class="flex items-center gap-2">
              <input v-model="seedRejectSettings" type="checkbox" /> 拒绝客户端设置覆盖
            </label>
            <label class="flex items-center gap-2">
              <input v-model="seedRejectIdentity" type="checkbox" /> 拒绝客户端身份覆盖
            </label>
          </div>
          <button
            type="button"
            :disabled="busy"
            class="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950"
            @click="saveSlotSeed"
          >
            保存并热推送 Seed
          </button>
        </div>
      </div>

      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h3 class="text-sm font-semibold text-white">KVM 排空迁移 / 内存调整 · {{ activeSlotId }}</h3>
        <p class="mt-1 text-xs text-slate-400">
          仅支持 <code class="text-sky-300">kvm_qemu</code> 且 Active Subagents == 0 时迁移；保留原 AccountID 与 GuestMachineID。
        </p>
        <div class="mt-4 space-y-3">
          <select
            v-model="migTargetNode"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
          >
            <option v-for="n in nodeList()" :key="n.id" :value="n.id">
              {{ n.name }} ({{ n.id }})
            </option>
          </select>
          <input
            v-model.number="migTargetMem"
            type="number"
            min="512"
            step="512"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
          />
          <button
            type="button"
            :disabled="busy"
            class="rounded-lg border border-violet-500/40 bg-violet-500/15 px-4 py-2 text-xs font-medium text-violet-300"
            @click="migrateActiveSlot"
          >
            执行排空迁移 / 调容
          </button>
        </div>
      </div>
    </section>

    <!-- Live Jailed WebSocket Console -->
    <section v-if="wsSlotId" class="rounded-xl border border-slate-800 bg-slate-950 p-6">
      <div class="flex items-center justify-between">
        <h3 class="font-mono text-sm font-semibold text-emerald-300">
          WS 沙盒诊断控制台 · {{ wsSlotId }} ({{ wsConnected ? "CONNECTED" : "DISCONNECTED" }})
        </h3>
        <div class="flex gap-2 text-xs">
          <button
            v-for="quick in ['help', 'status', 'machine-id', 'persona', 'ping', 'ls']"
            :key="quick"
            type="button"
            class="rounded border border-slate-700 px-2 py-1 font-mono text-slate-300 hover:border-sky-500"
            @click="sendWsCommand(quick)"
          >
            {{ quick }}
          </button>
          <button
            type="button"
            class="rounded border border-rose-500/40 px-2 py-1 text-rose-300"
            @click="closeWebSocket"
          >
            断开
          </button>
        </div>
      </div>
      <pre class="mt-3 max-h-64 overflow-y-auto rounded-lg border border-slate-800 bg-black/70 p-3 font-mono text-xs text-emerald-200">{{ wsLogs.join("\n") }}</pre>
      <form class="mt-3 flex gap-2" @submit.prevent="sendWsCommand()">
        <input
          v-model="wsCommand"
          type="text"
          placeholder="输入沙盒命令（如 cat etc/machine-id / env / seed）"
          class="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white"
        />
        <button
          type="submit"
          class="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950"
        >
          执行
        </button>
      </form>
    </section>
  </div>
</template>
