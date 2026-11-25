import { computed, reactive, ref } from "vue";
import {
  isStaticIpSubscription,
  type AccountExitBinding,
  type ClashExitNode,
  type ExecutionMode,
  type TlsProfile,
} from "@slipgate/contracts";
import { useAuthStore } from "../../../stores/auth";

/**
 * Exit pool (Clash nodes + static IPs) as the account pages see it: which exit each account is
 * bound to, and which exits can take a new binding. Bindings live in slipgate-net
 * (`/api/v1/admin/clash/*`); an account keeps at most one exit and an exit IP serves one account.
 */

/** Why an exit cannot take this account right now (`ok` = selectable). */
export type ExitAvailability = "ok" | "occupied" | "disabled" | "unprobed" | "drift" | "unhealthy";

/**
 * Mirrors slipgate-net's BindAccount guard: the node must be enabled, probed, healthy, drift-free
 * and below its account cap (the account's own current binding does not count).
 */
export function exitAvailability(node: ClashExitNode, current: AccountExitBinding | null): ExitAvailability {
  if (node.enabled === false) return "disabled";
  if (!node.exitIp) return "unprobed";
  if (node.driftUnconfirmed) return "drift";
  if (node.healthStatus !== "healthy") return "unhealthy";
  const own = current?.nodeId === node.nodeId && !current.isShadowFollower ? 1 : 0;
  if (node.boundAccounts - own >= node.maxAccounts) return "occupied";
  return "ok";
}

/** Whether requests of this access mode leave through the bound exit (and fail closed without one). */
export function modeUsesExit(mode: ExecutionMode): boolean {
  return mode === "stealth_http" || mode === "vm_slot";
}

export function isStaticExit(node: ClashExitNode): boolean {
  return isStaticIpSubscription(node.subscriptionId);
}

interface OverviewPayload {
  runtime?: { mode?: string };
  nodes?: ClashExitNode[];
  bindings?: AccountExitBinding[];
  profiles?: TlsProfile[];
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return data.message ?? data.error ?? fallback;
}

export function useExitPool() {
  const auth = useAuthStore();
  const nodes = ref<ClashExitNode[]>([]);
  const bindings = ref<AccountExitBinding[]>([]);
  const profiles = ref<TlsProfile[]>([]);
  /** BFF without slipgate-net: nodes are samples and bindings are not kept. */
  const standalone = ref(false);
  const loaded = ref(false);
  const failed = ref(false);

  const nodeById = computed(() => new Map(nodes.value.map((n) => [n.nodeId, n])));
  const bindingByAccount = computed(() => new Map(bindings.value.map((b) => [b.accountId, b])));
  const clashNodes = computed(() => nodes.value.filter((n) => !isStaticExit(n)));
  const staticNodes = computed(() => nodes.value.filter((n) => isStaticExit(n)));

  async function load(): Promise<void> {
    try {
      const res = await auth.apiFetch("/api/v1/admin/clash/overview");
      if (!res.ok) {
        failed.value = true;
        return;
      }
      const data = (await res.json()) as OverviewPayload;
      nodes.value = data.nodes ?? [];
      bindings.value = data.bindings ?? [];
      profiles.value = data.profiles ?? [];
      standalone.value = data.runtime?.mode === "standalone";
      failed.value = false;
      loaded.value = true;
    } catch {
      failed.value = true;
    }
  }

  /** Bind (or move) an account to an exit; returns an error message or null. */
  async function bind(accountId: string, nodeId: string, utlsProfileId: string): Promise<string | null> {
    const res = await auth.apiFetch("/api/v1/admin/clash/bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, nodeId, ...(utlsProfileId ? { utlsProfileId } : {}) }),
    });
    return res.ok ? null : readError(res, "bind failed");
  }

  async function unbind(accountId: string): Promise<string | null> {
    const res = await auth.apiFetch(`/api/v1/admin/clash/bindings/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    return res.ok ? null : readError(res, "unbind failed");
  }

  // reactive() unwraps the refs, so templates and props read `pool.nodes` directly.
  return reactive({
    nodes,
    bindings,
    profiles,
    standalone,
    loaded,
    failed,
    nodeById,
    bindingByAccount,
    clashNodes,
    staticNodes,
    load,
    bind,
    unbind,
  });
}

export type ExitPool = ReturnType<typeof useExitPool>;
