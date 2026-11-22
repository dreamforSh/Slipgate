<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
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
import { RUNTIME_PROFILE_TONE, formatUnixMs, healthLabel, healthTone, hostStatusLabel, slotStateLabel } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const { t } = useI18n();
const auth = useAuthStore();

type TelemetryMode = "isolated" | "enabled" | "disabled";
type CleanseMode = "zero" | "official" | "template";
type HypervisorKind = "docker_hardened" | "kvm_qemu" | "macos_native";

/** Runtime profiles are product names and read the same in every locale. */
const RUNTIME_LABEL: Record<string, string> = {
  claude_code: "Claude Code",
  codex_cli: "Codex CLI",
  antigravity: "Antigravity",
};
const runtimeLabel = (profile: string) => RUNTIME_LABEL[profile] ?? profile;
const runtimeOptions = Object.entries(RUNTIME_LABEL).map(([value, label]) => ({ value: value as VmRuntimeProfile, label }));

const telemetryOptions = computed(() =>
  (["isolated", "enabled", "disabled"] as TelemetryMode[]).map((value) => ({
    value,
    label: t(`vms.options.telemetry.${value}`),
  })),
);
const cleanseOptions = computed(() =>
  (["zero", "official", "template"] as CleanseMode[]).map((value) => ({
    value,
    label: t(`vms.options.cleanse.${value}`),
  })),
);
const hypervisorOptions = computed(() =>
  (["docker_hardened", "kvm_qemu", "macos_native"] as HypervisorKind[]).map((value) => ({
    value,
    label: t(`vms.options.hypervisor.${value}`),
  })),
);
const cleanseLabel = (mode: string) => cleanseOptions.value.find((o) => o.value === mode)?.label ?? mode;
const telemetryLabel = (mode: string) => telemetryOptions.value.find((o) => o.value === mode)?.label ?? mode;

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

// Register SSH node form
const nodeName = ref("");
const nodeAddr = ref("");
const nodeUser = ref("root");
const nodeArch = ref<"amd64" | "arm64">("amd64");
const nodeKvm = ref(false);
const nodeKeyPem = ref("");
const nodeHostKey = ref("");

// Provision VM slot form
const slotIdInput = ref("");
const provAccountId = ref("");
const provClashNodeId = ref("");
const provClusterNodeId = ref("local-node");
const provHypervisor = ref<HypervisorKind>("docker_hardened");
const provRuntimeProfile = ref<VmRuntimeProfile>("claude_code");
const provMemoryMiB = ref(2048);
const provMaxSubagents = ref(20);
const provCleanse = ref<CleanseMode>("zero");
const provTelemetry = ref<TelemetryMode>("isolated");
const provTimezone = ref("UTC");

// Selected slot drawer (runtime config / telemetry / migration) and WS terminal
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
      errorMessage.value = await readError(vmRes, t("vms.toast.loadFailed"));
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
    errorMessage.value = err instanceof Error ? err.message : t("vms.toast.loadFailed");
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
        sshHostKey: nodeHostKey.value.trim() || undefined,
        arch: nodeArch.value,
        kvmCapable: nodeKvm.value,
        dockerCapable: true,
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, t("vms.toast.registerNodeFailed"));
      return;
    }
    nodeName.value = "";
    nodeAddr.value = "";
    nodeKeyPem.value = "";
    nodeHostKey.value = "";
    nodeDrawerOpen.value = false;
    actionNotice.value = t("vms.toast.nodeRegistered");
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
      errorMessage.value = await readError(res, t("vms.toast.removeNodeFailed"));
      return;
    }
    actionNotice.value = t("vms.toast.nodeRemoved", { id });
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
      errorMessage.value = await readError(res, t("vms.toast.provisionFailed"));
      return;
    }
    slotIdInput.value = "";
    provisionOpen.value = false;
    actionNotice.value = t("vms.toast.provisioned");
    await loadFleet();
  } finally {
    busy.value = false;
  }
}

const SLOT_ACTION_TOAST = {
  start: { failed: "vms.toast.startFailed", done: "vms.toast.started" },
  stop: { failed: "vms.toast.stopFailed", done: "vms.toast.stopped" },
  delete: { failed: "vms.toast.destroyFailed", done: "vms.toast.destroyed" },
} as const;

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
      errorMessage.value = await readError(res, t(SLOT_ACTION_TOAST[action].failed));
      return;
    }
    if (action === "delete" && activeSlotId.value === id) {
      activeSlotId.value = null;
      activeSeed.value = null;
    }
    actionNotice.value = t(SLOT_ACTION_TOAST[action].done, { id });
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
    errorMessage.value = await readError(res, t("vms.toast.configLoadFailed"));
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
      errorMessage.value = await readError(res, t("vms.toast.configSaveFailed"));
      return;
    }
    activeSeed.value = (await res.json()) as SlotSeedSnapshot;
    actionNotice.value = t("vms.toast.configSaved", { id: activeSlotId.value });
  } finally {
    busy.value = false;
  }
}

async function updateSlotTelemetry(slot: VmSlotSummary, nextMode: TelemetryMode) {
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
      errorMessage.value = await readError(res, t("vms.toast.telemetryFailed"));
      return;
    }
    actionNotice.value = t("vms.toast.telemetryUpdated", { id: slot.slotId, mode: telemetryLabel(nextMode) });
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
      errorMessage.value = await readError(res, t("vms.toast.migrateFailed"));
      return;
    }
    actionNotice.value = t("vms.toast.migrated", {
      id: activeSlotId.value,
      node: migTargetNode.value,
      memory: migTargetMem.value,
    });
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
  wsLogs.value = [t("vms.terminal.connecting", { slot: slotId })];
  errorMessage.value = null;
  await nextTick();
  terminalPanel.value?.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const res = await auth.apiFetch(
    `/api/v1/admin/vms/slots/${encodeURIComponent(slotId)}/terminal-ticket`,
    { method: "POST" },
  );
  if (!res.ok) {
    errorMessage.value = await readError(res, t("vms.toast.terminalFailed"));
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
    wsLogs.value.push(t("vms.terminal.closed"));
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
    <PageHeader :title="t('nav.vms')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadFleet">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button type="button" class="btn btn-secondary" @click="nodeDrawerOpen = true">
          <UiIcon name="network" :size="15" />
          {{ t("vms.registerNode") }}
        </button>
        <button type="button" class="btn btn-primary" @click="provisionOpen = true">
          <UiIcon name="plus" :size="15" />
          {{ t("vms.deploySlot") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard :label="t('vms.stats.nodes')" :value="nodeList().length" icon="network" tone="accent" />
      <StatCard :label="t('vms.stats.readySlots')" :value="`${readySlots} / ${slotList().length}`" icon="server" tone="success" />
      <StatCard :label="t('vms.stats.subtasks')" :value="`${activeSubagents} / ${maxSubagents}`" icon="activity" tone="info" />
      <StatCard :label="t('vms.stats.migrations')" :value="overview?.migrations.length ?? 0" icon="migrate" tone="violet" />
    </div>

    <!-- Slots -->
    <UiCard icon="server" :title="t('vms.slots.title')" flush>
      <EmptyState v-if="slotList().length === 0" icon="server" :title="t('vms.slots.empty')">
        <button type="button" class="btn btn-primary btn-sm" @click="provisionOpen = true">
          <UiIcon name="plus" :size="14" />
          {{ t("vms.deploySlot") }}
        </button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("vms.slots.columns.slot") }}</th>
              <th>{{ t("vms.slots.columns.accountEgress") }}</th>
              <th class="hidden 2xl:table-cell">{{ t("vms.slots.columns.fingerprint") }}</th>
              <th>{{ t("common.status") }}</th>
              <th>{{ t("vms.slots.columns.quota") }}</th>
              <th>{{ t("vms.slots.columns.telemetry") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="slot in slotList()" :key="slot.slotId">
              <td>
                <p class="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs font-medium text-fg">
                  {{ slot.slotId }}
                  <UiBadge :tone="RUNTIME_PROFILE_TONE[slot.runtimeProfile] ?? 'neutral'">{{ runtimeLabel(slot.runtimeProfile) }}</UiBadge>
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
                <UiBadge :tone="healthTone(slot.state)" dot>{{ slotStateLabel(slot.state) }}</UiBadge>
                <UsageMeter
                  class="mt-2 w-28"
                  :label="t('vms.slots.subtasks')"
                  :value="slot.activeSubagents"
                  :max="slot.maxSubagents"
                />
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
                  :aria-label="t('vms.slots.telemetryPolicy')"
                  :disabled="busy"
                  @change="updateSlotTelemetry(slot, ($event.target as HTMLSelectElement).value as TelemetryMode)"
                >
                  <option v-for="opt in telemetryOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <p class="mt-1 text-2xs text-fg-subtle">
                  {{ t("vms.slots.promptLine", { mode: cleanseLabel(slot.cleanseMode) }) }}
                </p>
              </td>
              <td class="text-right">
                <div class="inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs hover:!text-success"
                    :title="t('vms.slots.start')"
                    :aria-label="t('vms.slots.start')"
                    :disabled="busy"
                    @click="slotAction(slot.slotId, 'start')"
                  >
                    <UiIcon name="play" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs hover:!text-warning"
                    :title="t('vms.slots.stop')"
                    :aria-label="t('vms.slots.stop')"
                    :disabled="busy"
                    @click="slotAction(slot.slotId, 'stop')"
                  >
                    <UiIcon name="stop" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :title="t('vms.slots.configure')"
                    :aria-label="t('vms.slots.configure')"
                    @click="inspectSlotSeed(slot)"
                  >
                    <UiIcon name="sliders" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :class="wsSlotId === slot.slotId ? '!text-accent' : ''"
                    :title="t('vms.slots.terminal')"
                    :aria-label="t('vms.slots.terminal')"
                    @click="connectTerminal(slot.slotId)"
                  >
                    <UiIcon name="terminal" :size="13" />
                  </button>
                  <ConfirmButton
                    :label="t('vms.slots.destroy')"
                    :confirm-label="t('vms.slots.confirmDestroy')"
                    icon-only
                    :disabled="busy"
                    @confirm="slotAction(slot.slotId, 'delete')"
                  />
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
          <span class="inline-flex items-center gap-1.5 text-2xs" :class="wsConnected ? 'text-emerald-400' : 'text-slate-500'">
            <span class="h-1.5 w-1.5 rounded-full" :class="wsConnected ? 'bg-emerald-400' : 'bg-slate-500'" />
            {{ wsConnected ? t("vms.terminal.connected") : t("vms.terminal.disconnected") }}
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
            :title="t('vms.terminal.disconnect')"
            :aria-label="t('vms.terminal.disconnect')"
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
          :placeholder="t('vms.terminal.placeholder')"
          class="min-w-0 flex-1 bg-transparent font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600"
          :aria-label="t('vms.terminal.command')"
        />
        <button
          type="submit"
          class="h-7 cursor-pointer rounded-md bg-emerald-500/90 px-3 text-xs font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
          :disabled="!wsConnected"
        >
          {{ t("vms.terminal.run") }}
        </button>
      </form>
    </section>

    <!-- Host nodes -->
    <UiCard icon="network" :title="t('vms.nodes.title')" flush>
      <template #actions>
        <button type="button" class="btn btn-secondary btn-sm" @click="nodeDrawerOpen = true">
          <UiIcon name="plus" :size="14" />
          {{ t("vms.registerNode") }}
        </button>
      </template>
      <EmptyState v-if="nodeList().length === 0" compact icon="network" :title="t('vms.nodes.empty')" />
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("vms.nodes.columns.node") }}</th>
              <th>{{ t("vms.nodes.columns.driver") }}</th>
              <th>{{ t("vms.nodes.columns.arch") }}</th>
              <th>{{ t("vms.nodes.columns.capabilities") }}</th>
              <th>{{ t("common.status") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
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
                    {{ t("vms.nodes.sshKey") }}
                  </UiBadge>
                </div>
                <p
                  v-if="n.driverKind === 'ssh'"
                  class="mt-1 max-w-[16rem] truncate font-mono text-2xs"
                  :class="n.sshHostKeyFingerprint ? 'text-fg-subtle' : 'text-warning'"
                  :title="n.sshHostKeyFingerprint || t('vms.nodes.hostKeyPendingHint')"
                >
                  {{ n.sshHostKeyFingerprint || t("vms.nodes.hostKeyPending") }}
                </p>
              </td>
              <td><UiBadge :tone="healthTone(n.status)" dot>{{ hostStatusLabel(n.status) }}</UiBadge></td>
              <td class="text-right">
                <ConfirmButton
                  v-if="n.id !== 'local-node'"
                  :label="t('common.remove')"
                  :confirm-label="t('vms.nodes.confirmRemove')"
                  icon-only
                  :disabled="busy"
                  @confirm="deleteNode(n.id)"
                />
                <span v-else class="text-2xs text-fg-subtle">{{ t("vms.nodes.local") }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Provision drawer -->
    <UiDrawer v-model:open="provisionOpen" :title="t('vms.provision.title')" width="lg">
      <form id="provision-form" class="space-y-5" @submit.prevent="provisionSlot">
        <div class="grid gap-4 sm:grid-cols-2">
          <FormField :label="t('vms.provision.account')" required>
            <input
              v-model="provAccountId"
              type="text"
              list="vm-account-options"
              required
              :placeholder="t('vms.provision.accountPlaceholder')"
              class="input font-mono text-xs"
              @change="syncRuntimeFromAccount"
            />
            <datalist id="vm-account-options">
              <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name }} ({{ acc.platform }})</option>
            </datalist>
          </FormField>
          <FormField :label="t('vms.provision.slotId')">
            <input
              v-model="slotIdInput"
              type="text"
              :placeholder="t('vms.provision.slotIdPlaceholder')"
              class="input font-mono text-xs"
            />
          </FormField>
          <FormField :label="t('vms.provision.node')">
            <select v-model="provClusterNodeId" class="select">
              <option v-for="n in nodeList()" :key="n.id" :value="n.id">
                {{ t("vms.nodes.option", { name: n.name, id: n.id, arch: n.arch }) }}
              </option>
            </select>
          </FormField>
          <FormField :label="t('vms.provision.egress')">
            <select v-model="provClashNodeId" class="select">
              <option value="">{{ t("vms.provision.egressAuto") }}</option>
              <option v-for="cn in clashNodes" :key="cn.nodeId" :value="cn.nodeId">
                {{
                  t("vms.provision.egressOption", {
                    name: cn.name,
                    ip: cn.exitIp || t("vms.provision.exitIpUnknown"),
                    health: healthLabel(cn.healthStatus),
                  })
                }}
              </option>
            </select>
          </FormField>
        </div>

        <div class="space-y-4 border-t border-line pt-5">
          <p class="text-2xs font-medium uppercase tracking-wider text-fg-subtle">{{ t("vms.provision.runtimeSection") }}</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <FormField :label="t('vms.provision.runtime')">
              <select v-model="provRuntimeProfile" class="select">
                <option v-for="opt in runtimeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </FormField>
            <FormField :label="t('vms.provision.hypervisor')">
              <select v-model="provHypervisor" class="select">
                <option v-for="opt in hypervisorOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </FormField>
          </div>
          <div class="grid gap-4 sm:grid-cols-3">
            <FormField :label="t('vms.provision.memory')">
              <input v-model.number="provMemoryMiB" type="number" min="512" class="input font-mono" />
            </FormField>
            <FormField :label="t('vms.provision.maxSubtasks')">
              <input v-model.number="provMaxSubagents" type="number" min="1" max="64" class="input font-mono" />
            </FormField>
            <FormField :label="t('vms.provision.timezone')">
              <input v-model="provTimezone" type="text" class="input font-mono" />
            </FormField>
          </div>
        </div>

        <div class="space-y-4 border-t border-line pt-5">
          <p class="text-2xs font-medium uppercase tracking-wider text-fg-subtle">{{ t("vms.provision.policySection") }}</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <FormField :label="t('vms.provision.telemetry')">
              <select v-model="provTelemetry" class="select">
                <option v-for="opt in telemetryOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </FormField>
            <FormField :label="t('vms.provision.cleanse')">
              <select v-model="provCleanse" class="select">
                <option v-for="opt in cleanseOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </FormField>
          </div>
        </div>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="provisionOpen = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="provision-form" :disabled="busy" class="btn btn-primary">
          <UiIcon v-if="busy" name="loader" :size="14" spin />
          {{ t("vms.deploySlot") }}
        </button>
      </template>
    </UiDrawer>

    <!-- Register node drawer -->
    <UiDrawer v-model:open="nodeDrawerOpen" :title="t('vms.nodeForm.title')">
      <form id="node-form" class="space-y-4" @submit.prevent="registerNode">
        <FormField :label="t('vms.nodeForm.name')" required>
          <input v-model="nodeName" type="text" required :placeholder="t('vms.nodeForm.namePlaceholder')" class="input" />
        </FormField>
        <div class="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
          <FormField :label="t('vms.nodeForm.sshAddr')" required>
            <input v-model="nodeAddr" type="text" required placeholder="host:port" class="input font-mono text-xs" />
          </FormField>
          <FormField :label="t('vms.nodeForm.sshUser')">
            <input v-model="nodeUser" type="text" placeholder="root" class="input font-mono text-xs" />
          </FormField>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <FormField :label="t('vms.nodeForm.arch')">
            <select v-model="nodeArch" class="select">
              <option value="amd64">amd64</option>
              <option value="arm64">arm64</option>
            </select>
          </FormField>
          <div>
            <span class="label">{{ t("vms.nodeForm.kvm") }}</span>
            <div class="flex h-9 items-center">
              <UiSwitch
                v-model="nodeKvm"
                :label="nodeKvm ? t('vms.nodeForm.supported') : t('vms.nodeForm.unsupported')"
                tone="accent"
              />
            </div>
          </div>
        </div>
        <FormField :label="t('vms.nodeForm.privateKey')">
          <textarea
            v-model="nodeKeyPem"
            rows="6"
            spellcheck="false"
            :placeholder="t('vms.nodeForm.privateKeyPlaceholder')"
            class="textarea font-mono text-xs"
          />
        </FormField>
        <FormField :label="t('vms.nodeForm.hostKey')">
          <textarea
            v-model="nodeHostKey"
            rows="2"
            spellcheck="false"
            :placeholder="t('vms.nodeForm.hostKeyPlaceholder')"
            class="textarea font-mono text-xs"
          />
          <span class="mt-1 block text-2xs text-fg-subtle">{{ t("vms.nodeForm.hostKeyHint") }}</span>
        </FormField>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="nodeDrawerOpen = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="node-form" :disabled="busy" class="btn btn-primary">{{ t("vms.registerNode") }}</button>
      </template>
    </UiDrawer>

    <!-- Slot detail drawer: runtime config + migration -->
    <UiDrawer v-model:open="slotDrawerOpen" :title="t('vms.detail.title', { id: activeSlotId ?? '' })" width="xl">
      <div class="space-y-6">
        <div v-if="activeSlot" class="grid grid-cols-2 gap-3 rounded-lg border border-line bg-surface-2/40 p-3.5 sm:grid-cols-4">
          <div>
            <p class="text-2xs text-fg-subtle">{{ t("vms.detail.runtime") }}</p>
            <p class="mt-0.5 text-xs text-fg">{{ runtimeLabel(activeSeed?.runtimeProfile ?? activeSlot.runtimeProfile) }}</p>
          </div>
          <div>
            <p class="text-2xs text-fg-subtle">{{ t("common.status") }}</p>
            <p class="mt-0.5"><UiBadge :tone="healthTone(activeSlot.state)" dot>{{ slotStateLabel(activeSlot.state) }}</UiBadge></p>
          </div>
          <div>
            <p class="text-2xs text-fg-subtle">{{ t("vms.detail.telemetryProcess") }}</p>
            <p class="mt-0.5 text-xs text-fg">
              {{ activeSeed?.telemetryDaemonRunning ? t("vms.detail.running") : t("vms.detail.notRunning") }}
            </p>
          </div>
          <div>
            <p class="text-2xs text-fg-subtle">{{ t("vms.detail.lastSynced") }}</p>
            <p class="mt-0.5 font-mono text-xs text-fg">{{ activeSeed ? formatUnixMs(activeSeed.syncedAtUnixMs) : "-" }}</p>
          </div>
          <div>
            <p class="text-2xs text-fg-subtle">{{ t("vms.detail.mac") }}</p>
            <p class="mt-0.5 truncate font-mono text-xs text-fg">{{ activeSlot.persona.macAddress }}</p>
          </div>
          <div class="sm:col-span-3">
            <p class="text-2xs text-fg-subtle">{{ t("vms.detail.machineId") }}</p>
            <p class="mt-0.5 truncate font-mono text-xs text-fg" :title="activeSlot.persona.guestMachineId">
              {{ activeSlot.persona.guestMachineId }}
            </p>
          </div>
          <div class="col-span-2 sm:col-span-4">
            <p class="text-2xs text-fg-subtle">{{ t("vms.detail.hardwareUuid") }}</p>
            <p class="mt-0.5 truncate font-mono text-xs text-fg" :title="activeSlot.persona.smbiosUuid">
              {{ activeSlot.persona.smbiosUuid }}
            </p>
          </div>
        </div>

        <section>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-semibold text-fg">{{ t("vms.detail.configTitle") }}</h3>
            <button
              type="button"
              class="btn btn-secondary btn-xs"
              @click="fillRuntimeSeedTemplate(activeSeed?.runtimeProfile ?? 'claude_code')"
            >
              <UiIcon name="sparkles" :size="13" />
              {{ t("vms.detail.fillTemplate") }}
            </button>
          </div>
          <div class="mt-4 space-y-4">
            <FormField :label="t('vms.detail.settings')">
              <textarea v-model="seedSettingsJson" rows="7" spellcheck="false" class="textarea font-mono text-xs" />
            </FormField>
            <FormField :label="t('vms.detail.credentials')">
              <textarea v-model="seedAuthJson" rows="6" spellcheck="false" class="textarea font-mono text-xs" />
            </FormField>
            <FormField :label="t('vms.detail.env')">
              <textarea v-model="seedCustomEnv" rows="3" spellcheck="false" class="textarea font-mono text-xs" />
            </FormField>
            <div class="flex flex-wrap gap-x-6 gap-y-2">
              <label class="flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
                <input v-model="seedRejectSettings" type="checkbox" class="checkbox" />
                {{ t("vms.detail.blockSettings") }}
              </label>
              <label class="flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
                <input v-model="seedRejectIdentity" type="checkbox" class="checkbox" />
                {{ t("vms.detail.blockIdentity") }}
              </label>
            </div>
            <button type="button" :disabled="busy || !activeSeed" class="btn btn-primary" @click="saveSlotSeed">
              <UiIcon :name="busy ? 'loader' : 'check'" :size="14" :spin="busy" />
              {{ t("vms.detail.saveSync") }}
            </button>
          </div>
        </section>

        <section class="border-t border-line pt-6">
          <h3 class="text-sm font-semibold text-fg">{{ t("vms.detail.migrateTitle") }}</h3>
          <div class="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
            <FormField :label="t('vms.detail.targetNode')">
              <select v-model="migTargetNode" class="select">
                <option v-for="n in nodeList()" :key="n.id" :value="n.id">
                  {{ t("vms.nodes.optionShort", { name: n.name, id: n.id }) }}
                </option>
              </select>
            </FormField>
            <FormField :label="t('vms.detail.targetMemory')">
              <input v-model.number="migTargetMem" type="number" min="512" step="512" class="input font-mono" />
            </FormField>
            <button type="button" :disabled="busy" class="btn btn-secondary" @click="migrateActiveSlot">
              <UiIcon name="migrate" :size="14" />
              {{ t("vms.detail.migrate") }}
            </button>
          </div>
        </section>
      </div>
    </UiDrawer>
  </div>
</template>
