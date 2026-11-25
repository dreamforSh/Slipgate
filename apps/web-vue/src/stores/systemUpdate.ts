import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  AdminStepUp,
  SystemReleaseItem,
  SystemReleasesResponse,
  SystemUpdateChannel,
  SystemUpdateStatus,
  UpdateSystemConfigRequest,
} from "@slipgate/contracts";
import { i18n } from "../i18n";
import { ApiError, apiJson, errorText } from "../lib/api";

const BUSY_STATES = new Set(["checking", "downloading", "applying", "reloading_planes", "restarting", "rolling_back"]);
/** While an update runs: live download bytes and stage. */
const BUSY_POLL_MS = 1500;
/** While the update center is open and idle: notices auto-sync updates and restarts started elsewhere. */
const WATCH_POLL_MS = 10_000;
/** Recovery polling while the service restarts. */
const RECOVERY_POLL_MS = 1500;
/** A status request that hangs this long during a restart means the old process is gone. */
const SLOW_REQUEST_MS = 2500;

/** Refusals of the password / passkey re-confirmation: the dialog shows them on its fields. */
const STEP_UP_ERRORS = new Set([
  "step_up_required",
  "step_up_not_allowed",
  "invalid_password",
  "invalid_totp",
  "totp_required",
  "totp_not_enabled",
  "invalid_passkey_step_up",
  "too_many_attempts",
]);

export type RestartStage = "scheduled" | "draining" | "stopping" | "starting";

export type RecoveryResult =
  | { kind: "recovered"; status: SystemUpdateStatus }
  | { kind: "signed_out" }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

/** What the process looked like before a restart, to tell what changed afterwards. */
export interface ServiceSnapshot {
  bootId: string;
  version: string;
  commit: string;
  lastRestartId: string | null;
}

/** A full-service restart the console followed (or noticed afterwards), for the page to announce. */
export interface RestartEvent {
  seq: number;
  /** True when this console did not ask for it (auto-sync, another administrator, the CLI). */
  external: boolean;
  previous: ServiceSnapshot;
  result: RecoveryResult;
}

export function isStepUpRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.code !== null && STEP_UP_ERRORS.has(err.code);
}

function tr(key: string): string {
  return i18n.global.t(key);
}

function snapshotOf(status: SystemUpdateStatus | null): ServiceSnapshot {
  return {
    bootId: status?.bootId ?? "",
    version: status?.version ?? "",
    commit: status?.activeCommit ?? "",
    lastRestartId: status?.lastRestart?.id ?? null,
  };
}

function isRestarting(status: SystemUpdateStatus | null): boolean {
  return Boolean(status && (status.restartScheduled || status.state === "restarting"));
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export const useSystemUpdateStore = defineStore("systemUpdate", () => {
  const status = ref<SystemUpdateStatus | null>(null);
  const releases = ref<SystemReleaseItem[]>([]);
  const releasesMeta = ref<{ repo: string; fetchedAtIso: string | null; standalone: boolean }>({
    repo: "dreamforSh/Slipgate",
    fetchedAtIso: null,
    standalone: false,
  });

  const loading = ref(false);
  const releasesLoading = ref(false);
  const releasesError = ref<string | null>(null);
  const checking = ref(false);
  const applying = ref(false);
  const rollingBack = ref(false);
  /** A restart request is out or a restart is being followed until the new process answers. */
  const restarting = ref(false);
  /** Where the restart is, as seen from the console: reported by the old process, then inferred. */
  const restartStage = ref<RestartStage | null>(null);
  const restartStartedAt = ref<number | null>(null);
  const restartEvent = ref<RestartEvent | null>(null);
  const savingConfig = ref(false);
  const error = ref<string | null>(null);

  let busyTimer: number | undefined;
  let watchTimer: number | undefined;
  let watchers = 0;
  let inFlightLoad: Promise<SystemUpdateStatus | null> | null = null;
  let recovery: Promise<RecoveryResult> | null = null;
  let eventSeq = 0;
  /** This console asked for the restart that is about to happen (vs. one noticed while polling). */
  let ownRestartIntent = false;
  let lastSeen: ServiceSnapshot | null = null;

  const isBusy = computed(
    () =>
      checking.value ||
      applying.value ||
      rollingBack.value ||
      restarting.value ||
      (status.value !== null && BUSY_STATES.has(status.value.state)),
  );
  const restartActive = computed(() => restarting.value || isRestarting(status.value));
  const updateAvailable = computed(() => Boolean(status.value?.updateAvailable));
  const needsEdgeRestart = computed(() => Boolean(status.value?.edgeBinaryStaged));
  const canRollback = computed(() => Boolean(status.value?.canRollback));
  // Dev-mode deployments skip the password / passkey re-confirmation for every update action;
  // the BFF decides (stepUpRequired), with the mode as a fallback for older backends.
  const requiresStepUp = computed(() => status.value?.stepUpRequired ?? status.value?.mode !== "dev");

  function syncPolling() {
    // The recovery loop polls on its own while a restart is followed.
    const busy = !restarting.value && status.value !== null && BUSY_STATES.has(status.value.state);
    const want = busy || applying.value || rollingBack.value;
    if (want && busyTimer === undefined) {
      busyTimer = window.setInterval(() => void loadStatus(true), BUSY_POLL_MS);
    } else if (!want && busyTimer !== undefined) {
      window.clearInterval(busyTimer);
      busyTimer = undefined;
    }
  }

  function stopPolling() {
    if (busyTimer !== undefined) {
      window.clearInterval(busyTimer);
      busyTimer = undefined;
    }
  }

  function emitRestartEvent(external: boolean, previous: ServiceSnapshot, result: RecoveryResult) {
    eventSeq += 1;
    restartEvent.value = { seq: eventSeq, external, previous, result };
  }

  /** Reacts to a status read outside a followed restart: adopt restarts begun elsewhere. */
  function observe(next: SystemUpdateStatus) {
    if (recovery) return;
    const previous = lastSeen;
    lastSeen = snapshotOf(next);
    if (isRestarting(next)) {
      void followRestart({ external: !ownRestartIntent, previous: previous ?? undefined });
      return;
    }
    if (previous?.bootId && next.bootId && next.bootId !== previous.bootId) {
      // The service restarted between two polls without this console seeing it go down.
      emitRestartEvent(!ownRestartIntent, previous, { kind: "recovered", status: next });
      ownRestartIntent = false;
    }
  }

  async function loadStatus(silent = false): Promise<SystemUpdateStatus | null> {
    if (inFlightLoad) return inFlightLoad;
    if (!silent) {
      loading.value = true;
      error.value = null;
    }
    inFlightLoad = (async () => {
      try {
        const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update");
        if (recovery) return next; // the recovery loop owns status while it runs
        status.value = next;
        observe(next);
        syncPolling();
        return next;
      } catch (err) {
        if (!silent) error.value = errorText(err, tr("updates.errors.load"));
        return null;
      } finally {
        loading.value = false;
        inFlightLoad = null;
      }
    })();
    return inFlightLoad;
  }

  async function loadReleases(refresh = false): Promise<SystemReleasesResponse | null> {
    releasesLoading.value = true;
    releasesError.value = null;
    try {
      const qs = refresh ? "?refresh=1" : "";
      const data = await apiJson<SystemReleasesResponse>(`/api/v1/admin/system/update/releases${qs}`);
      releases.value = data.releases;
      releasesMeta.value = { repo: data.repo, fetchedAtIso: data.fetchedAtIso, standalone: data.standalone };
      return data;
    } catch (err) {
      releasesError.value = errorText(err, tr("updates.errors.releases"));
      return null;
    } finally {
      releasesLoading.value = false;
    }
  }

  async function checkForUpdates(channel?: SystemUpdateChannel): Promise<SystemUpdateStatus | null> {
    checking.value = true;
    error.value = null;
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/sync", {
        method: "POST",
        body: { checkOnly: true, channel },
      });
      status.value = next;
      observe(next);
      return next;
    } catch (err) {
      error.value = errorText(err, tr("updates.errors.check"));
      void loadStatus(true);
      return null;
    } finally {
      checking.value = false;
      syncPolling();
    }
  }

  /**
   * Follows a full-service restart until a new process answers (single-flight: concurrent callers
   * share one loop), then publishes a RestartEvent for the page to announce.
   */
  function followRestart(opts: { external?: boolean; previous?: ServiceSnapshot } = {}): Promise<RecoveryResult> {
    if (recovery) return recovery;
    const previous = opts.previous ?? snapshotOf(status.value);
    const external = opts.external ?? !ownRestartIntent;
    recovery = runRecovery(previous)
      .then((result) => {
        emitRestartEvent(external, previous, result);
        return result;
      })
      .finally(() => {
        recovery = null;
        ownRestartIntent = false;
        lastSeen = snapshotOf(status.value);
        syncPolling();
      });
    return recovery;
  }

  async function runRecovery(previous: ServiceSnapshot): Promise<RecoveryResult> {
    restarting.value = true;
    restartStartedAt.value = Date.now();
    restartStage.value = status.value?.restartProgress?.phase ?? "scheduled";
    stopPolling();
    error.value = null;

    // The old process may spend its whole drain window finishing requests before it re-execs,
    // then the new one waits for its planes before it serves.
    const drainSeconds = status.value?.drainTimeoutSeconds ?? 30;
    const deadline = Date.now() + Math.max(90, drainSeconds + 90) * 1000;
    try {
      await sleep(800);
      while (Date.now() < deadline) {
        const slow = window.setTimeout(() => {
          if (restartStage.value === "stopping") restartStage.value = "starting";
        }, SLOW_REQUEST_MS);
        try {
          const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update");
          status.value = next;
          const newProcess = !previous.bootId || next.bootId !== previous.bootId;
          if (newProcess && !isRestarting(next)) {
            void loadReleases(true);
            return { kind: "recovered", status: next };
          }
          if (newProcess) {
            // A new process that restarts again right away (an automatic rollback).
            restartStage.value = "starting";
          } else if (next.restartProgress) {
            restartStage.value = next.restartProgress.phase;
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) return { kind: "signed_out" };
          if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 404 && err.status !== 429) {
            return { kind: "error", message: err.message };
          }
          // Connection resets, 502 / 503 while Slipgate drains and re-execs are expected.
          restartStage.value = "starting";
        } finally {
          window.clearTimeout(slow);
        }
        await sleep(RECOVERY_POLL_MS);
      }
      return { kind: "timeout" };
    } finally {
      restarting.value = false;
      restartStage.value = null;
      restartStartedAt.value = null;
    }
  }

  function failMutation(err: unknown, fallbackKey: string) {
    ownRestartIntent = false;
    if (!isStepUpRefusal(err)) error.value = errorText(err, tr(fallbackKey));
    void loadStatus(true);
  }

  /** Applies an update; returns once the request is answered (a restart is then followed apart). */
  async function applyUpdate(opts: {
    channel?: SystemUpdateChannel;
    targetTag?: string;
    force?: boolean;
    confirm?: AdminStepUp;
  }): Promise<SystemUpdateStatus> {
    applying.value = true;
    error.value = null;
    ownRestartIntent = true;
    // Poll right away so download bytes and the stage stepper move while the request runs.
    syncPolling();
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/sync", {
        method: "POST",
        body: {
          checkOnly: false,
          channel: opts.channel,
          targetTag: opts.targetTag,
          force: opts.force ?? false,
          confirm: opts.confirm,
        },
      });
      status.value = next;
      if (isRestarting(next)) {
        void followRestart({ external: false });
      } else {
        ownRestartIntent = false;
        lastSeen = snapshotOf(next);
        void loadReleases(true);
      }
      return next;
    } catch (err) {
      failMutation(err, "updates.errors.apply");
      throw err;
    } finally {
      applying.value = false;
      syncPolling();
    }
  }

  async function rollback(opts: { releaseId?: string; confirm?: AdminStepUp }): Promise<SystemUpdateStatus> {
    rollingBack.value = true;
    error.value = null;
    ownRestartIntent = true;
    syncPolling();
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/rollback", {
        method: "POST",
        body: { releaseId: opts.releaseId, confirm: opts.confirm },
      });
      status.value = next;
      if (isRestarting(next)) {
        void followRestart({ external: false });
      } else {
        ownRestartIntent = false;
        lastSeen = snapshotOf(next);
        void loadReleases(true);
      }
      return next;
    } catch (err) {
      failMutation(err, "updates.errors.rollback");
      throw err;
    } finally {
      rollingBack.value = false;
      syncPolling();
    }
  }

  /**
   * Asks for a graceful full-service restart; returns the accepted status, or null when the
   * connection dropped (the restart may already be under way and is followed either way).
   */
  async function restart(opts: { confirm?: AdminStepUp } = {}): Promise<SystemUpdateStatus | null> {
    restarting.value = true;
    error.value = null;
    ownRestartIntent = true;
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/restart", {
        method: "POST",
        body: { confirm: opts.confirm },
      });
      status.value = next;
      void followRestart({ external: false });
      return next;
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        restarting.value = false;
        failMutation(err, "updates.errors.restart");
        throw err;
      }
      void followRestart({ external: false });
      return null;
    }
  }

  async function saveConfig(patch: UpdateSystemConfigRequest): Promise<SystemUpdateStatus | null> {
    savingConfig.value = true;
    error.value = null;
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/config", {
        method: "PUT",
        body: patch,
      });
      status.value = next;
      return next;
    } catch (err) {
      // A refused password / passkey is shown on the confirmation dialog's fields.
      if (!isStepUpRefusal(err)) error.value = errorText(err, tr("updates.errors.policy"));
      throw err;
    } finally {
      savingConfig.value = false;
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible" && !recovery) void loadStatus(true);
  }

  /** Keeps status fresh while a view that shows it is mounted (pair with stopWatching). */
  function startWatching() {
    watchers += 1;
    if (watchTimer !== undefined) return;
    watchTimer = window.setInterval(() => {
      if (document.visibilityState === "hidden" || busyTimer !== undefined || recovery) return;
      void loadStatus(true);
    }, WATCH_POLL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function stopWatching() {
    watchers = Math.max(0, watchers - 1);
    if (watchers > 0 || watchTimer === undefined) return;
    window.clearInterval(watchTimer);
    watchTimer = undefined;
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  function clearError() {
    error.value = null;
  }

  return {
    status,
    releases,
    releasesMeta,
    loading,
    releasesLoading,
    releasesError,
    checking,
    applying,
    rollingBack,
    restarting,
    restartStage,
    restartStartedAt,
    restartEvent,
    savingConfig,
    error,
    isBusy,
    restartActive,
    updateAvailable,
    needsEdgeRestart,
    canRollback,
    requiresStepUp,
    loadStatus,
    loadReleases,
    checkForUpdates,
    applyUpdate,
    rollback,
    restart,
    followRestart,
    saveConfig,
    startWatching,
    stopWatching,
    stopPolling,
    clearError,
  };
});
