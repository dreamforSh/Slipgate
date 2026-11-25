import type { DataPlanePushOutcome, DataPlaneSyncState, DataPlaneSyncStatus } from "@slipgate/contracts";

/**
 * Config publish confirmation. A config change is exported as a snapshot (revisionUnixMs), pushed
 * to the edge (slipgate Go) and forwarded by it to slipgate-core (Zig). It is published only once
 * the core has acknowledged that revision: the edge answers 202 / coreApplied=false while the core
 * is offline or rejected it, and reports both revisions on /internal/net/dataplane/sync-status.
 * This tracker keeps the BFF's side (the newest exported revision, the last push) and combines it
 * with the edge's report into one state for the console.
 */

/** The edge's report (GET /internal/net/dataplane/sync-status, net-go dataplane.SyncStatus). */
export interface EdgeSyncStatus {
  revisionUnixMs: number;
  coreConfigured: boolean;
  coreRevisionUnixMs: number;
  corePending: boolean;
  lastCoreError?: string;
}

/** Body of POST /internal/net/dataplane/sync (200 ack, or 202 when the core sync failed). */
export interface EdgePushBody {
  coreApplied?: boolean;
  degradedCoreSync?: boolean;
  stale?: boolean;
  warning?: string;
}

/**
 * How one push went. Only "applied" (the core acknowledged this revision; an edge that predates
 * the coreApplied field signalled that with a plain 200) may retire state the push carried, such
 * as pending risk unbans.
 */
export function pushOutcome(status: number, body: EdgePushBody | null): { outcome: DataPlanePushOutcome; error: string | null } {
  if (status < 200 || status >= 300) return { outcome: "failed", error: `HTTP ${status}` };
  if (body?.stale) return { outcome: "stale", error: null };
  if (status !== 200 || body?.degradedCoreSync || body?.coreApplied === false) {
    return { outcome: "pending_core", error: body?.warning ?? null };
  }
  return { outcome: "applied", error: null };
}

/** Where the newest config stands: not yet on the edge, on the edge but not in the core, or applied. */
export function syncState(desiredRevisionUnixMs: number | null, edge: EdgeSyncStatus): Exclude<DataPlaneSyncState, "unreachable" | "standalone"> {
  if (desiredRevisionUnixMs !== null && edge.revisionUnixMs < desiredRevisionUnixMs) return "pending_edge";
  if (edge.coreConfigured) {
    if (edge.corePending || edge.coreRevisionUnixMs < edge.revisionUnixMs) return "pending_core";
    if (desiredRevisionUnixMs !== null && edge.coreRevisionUnixMs < desiredRevisionUnixMs) return "pending_core";
  }
  return "applied";
}

export class DataPlanePublishTracker {
  private desired: number | null = null;
  private lastPushAtMs: number | null = null;
  private lastOutcome: DataPlanePushOutcome | null = null;
  private lastError: string | null = null;

  /** A snapshot was exported (pushed, or pulled by the edge): the newest one is the desired config. */
  noteExported(revisionUnixMs: number): void {
    if (Number.isFinite(revisionUnixMs) && (this.desired === null || revisionUnixMs > this.desired)) this.desired = revisionUnixMs;
  }

  notePush(atMs: number, outcome: DataPlanePushOutcome, error: string | null): void {
    this.lastPushAtMs = atMs;
    this.lastOutcome = outcome;
    this.lastError = error;
  }

  /**
   * `legacyEdge`: the edge answered but has no status endpoint (an older edge): the state then
   * follows the last push's outcome instead of reading as unreachable.
   */
  status(edge: EdgeSyncStatus | null, opts: { standalone: boolean; edgeError: string | null; nowMs: number; legacyEdge?: boolean }): DataPlaneSyncStatus {
    const base = {
      checkedAtIso: new Date(opts.nowMs).toISOString(),
      desiredRevisionUnixMs: this.desired,
      lastPushAtIso: this.lastPushAtMs !== null ? new Date(this.lastPushAtMs).toISOString() : null,
      lastPushOutcome: this.lastOutcome,
    };
    if (opts.standalone) {
      return { ...base, state: "standalone", edgeRevisionUnixMs: null, coreRevisionUnixMs: null, coreConfigured: null, error: null };
    }
    if (!edge && opts.legacyEdge && (this.lastOutcome === "applied" || this.lastOutcome === "pending_core")) {
      return {
        ...base,
        state: this.lastOutcome,
        edgeRevisionUnixMs: null,
        coreRevisionUnixMs: null,
        coreConfigured: null,
        error: this.lastOutcome === "applied" ? null : this.lastError,
      };
    }
    if (!edge) {
      return {
        ...base,
        state: "unreachable",
        edgeRevisionUnixMs: null,
        coreRevisionUnixMs: null,
        coreConfigured: null,
        error: opts.edgeError ?? this.lastError,
      };
    }
    const state = syncState(this.desired, edge);
    return {
      ...base,
      state,
      edgeRevisionUnixMs: edge.revisionUnixMs,
      coreRevisionUnixMs: edge.coreRevisionUnixMs,
      coreConfigured: edge.coreConfigured,
      error: state === "applied" ? null : edge.lastCoreError || this.lastError,
    };
  }
}
