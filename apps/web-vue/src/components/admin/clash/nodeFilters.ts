import type { ClashExitNode } from "@slipgate/contracts";

/**
 * Filtering and sorting of exit nodes (Clash nodes and static IPs), shared by the proxy pages and
 * the account exit picker.
 */

/** One status per node, most actionable first: disabled > drift > unprobed > health. */
export type NodeStatus = "disabled" | "drift" | "unprobed" | "healthy" | "degraded" | "unhealthy";
export const NODE_STATUSES: NodeStatus[] = ["healthy", "degraded", "unhealthy", "unprobed", "drift", "disabled"];

export function nodeStatus(n: ClashExitNode): NodeStatus {
  if (n.enabled === false) return "disabled";
  if (n.driftUnconfirmed) return "drift";
  if (!n.exitIp) return "unprobed";
  if (n.healthStatus === "healthy") return "healthy";
  if (n.healthStatus === "degraded") return "degraded";
  return "unhealthy";
}

/** Occupancy: no account, some (below the cap), or at the cap. */
export type NodeBindState = "free" | "partial" | "full";
export type NodeBindFilter = "all" | "bound" | "free" | "full";
export const NODE_BIND_FILTERS: NodeBindFilter[] = ["all", "bound", "free", "full"];

export function nodeBindState(n: ClashExitNode): NodeBindState {
  if (n.boundAccounts <= 0) return "free";
  return n.boundAccounts >= n.maxAccounts ? "full" : "partial";
}

export interface NodeFilter {
  query: string;
  status: "all" | NodeStatus;
  bind: NodeBindFilter;
  /** Proxy type (vmess, trojan, socks5…) or "all". */
  type: string;
  /** Subscription id or "all". */
  subscriptionId: string;
}

export const EMPTY_NODE_FILTER: NodeFilter = { query: "", status: "all", bind: "all", type: "all", subscriptionId: "all" };

export function nodeFilterActive(f: NodeFilter): boolean {
  return !!f.query.trim() || f.status !== "all" || f.bind !== "all" || f.type !== "all" || f.subscriptionId !== "all";
}

/**
 * `extraText` adds searchable text per node (e.g. subscription and bound account names).
 */
export function matchesNode(n: ClashExitNode, f: NodeFilter, extraText = ""): boolean {
  if (f.status !== "all" && nodeStatus(n) !== f.status) return false;
  if (f.bind !== "all") {
    const state = nodeBindState(n);
    if (f.bind === "bound" && state === "free") return false;
    if (f.bind === "free" && state !== "free") return false;
    if (f.bind === "full" && state !== "full") return false;
  }
  if (f.type !== "all" && (n.proxyType ?? "").toLowerCase() !== f.type) return false;
  if (f.subscriptionId !== "all" && n.subscriptionId !== f.subscriptionId) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [n.name, n.nodeId, n.server ?? "", n.exitIp, n.proxyType ?? "", String(n.listenerPort), extraText]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

/** Distinct proxy types present, lower-cased and sorted. */
export function nodeTypes(nodes: ClashExitNode[]): string[] {
  return [...new Set(nodes.map((n) => (n.proxyType ?? "").toLowerCase()).filter(Boolean))].sort();
}

export type NodeSortKey = "recommended" | "latency" | "name" | "bound" | "probed";
export const NODE_SORT_KEYS: NodeSortKey[] = ["recommended", "latency", "name", "bound", "probed"];

const STATUS_RANK: Record<NodeStatus, number> = { healthy: 0, degraded: 1, unprobed: 2, unhealthy: 3, drift: 4, disabled: 5 };

/** Latency 0 means "not measured": sorts after every measured node. */
function latencyKey(n: ClashExitNode): number {
  return n.latencyMs > 0 ? n.latencyMs : Number.MAX_SAFE_INTEGER;
}

export function compareNodes(a: ClashExitNode, b: ClashExitNode, key: NodeSortKey, dir: "asc" | "desc" = "asc"): number {
  const sign = dir === "asc" ? 1 : -1;
  const byName = a.name.localeCompare(b.name, undefined, { numeric: true });
  switch (key) {
    case "recommended": {
      // Usable first (status), then free capacity, then speed.
      const rank = STATUS_RANK[nodeStatus(a)] - STATUS_RANK[nodeStatus(b)];
      if (rank) return rank;
      const room = b.maxAccounts - b.boundAccounts - (a.maxAccounts - a.boundAccounts);
      if (room) return room;
      return latencyKey(a) - latencyKey(b) || byName;
    }
    case "latency":
      return sign * (latencyKey(a) - latencyKey(b)) || byName;
    case "bound":
      return sign * (a.boundAccounts - b.boundAccounts) || byName;
    case "probed": {
      const at = (n: ClashExitNode) => (n.lastProbedAtIso ? Date.parse(n.lastProbedAtIso) : 0);
      return sign * (at(b) - at(a)) || byName;
    }
    default:
      return sign * byName;
  }
}
