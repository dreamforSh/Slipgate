import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { BackupActiveOperation, BackupListResponse, BackupRecord, BackupSystemStatus } from "@slipgate/contracts";
import { apiJson } from "../../../lib/api";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";
import { backupErrorText, DB_BACKUP_API, formatSize, isBusy } from "./dbBackupUtil";

/** While something runs: poll the cheap status route this often. */
const ACTIVE_POLL_MS = 2_000;
/** A record says "running" but this instance runs nothing (another instance, or not yet marked failed). */
const REMOTE_POLL_MS = 6_000;
/** Idle: still notice scheduled runs that start while the page is open. */
const IDLE_POLL_MS = 30_000;

type WatchedOp = Pick<BackupActiveOperation, "kind" | "backupId">;

/**
 * Database backup state for the admin page: system status, backup history, and polling that
 * follows a running backup / restore and announces how it ended. The returned object is reactive
 * (refs unwrapped), so it can be handed to child components as one prop.
 */
export function useDbBackups() {
  const { t } = useI18n();
  const toast = useToastStore();
  const auth = useAuthStore();
  const router = useRouter();

  const status = ref<BackupSystemStatus | null>(null);
  const statusLoading = ref(false);
  const statusError = ref<string | null>(null);
  const records = ref<BackupRecord[]>([]);
  const recordsLoaded = ref(false);
  const recordsLoading = ref(false);
  const recordsError = ref<string | null>(null);
  const nowMs = ref(Date.now());

  const active = computed(() => status.value?.activeOperation ?? null);
  const remoteBusy = computed(() => !active.value && records.value.some(isBusy));
  const busy = computed(() => Boolean(active.value) || remoteBusy.value);

  let timer: number | undefined;
  let ticker: number | undefined;
  let disposed = false;
  /** The operation seen on the last poll, to notice when it ends. */
  let watched: WatchedOp | null = null;
  /** A restore was followed in this tab: a lost session afterwards is the expected token rollback. */
  let restoreFollowed = false;

  /* ---------------- Records ---------------- */

  function upsert(record: BackupRecord) {
    const i = records.value.findIndex((r) => r.id === record.id);
    if (i >= 0) records.value.splice(i, 1, record);
    else records.value = [record, ...records.value];
  }

  function remove(id: string) {
    records.value = records.value.filter((r) => r.id !== id);
  }

  async function loadRecords(silent = false): Promise<void> {
    if (!silent) recordsLoading.value = true;
    try {
      const res = await apiJson<BackupListResponse>(DB_BACKUP_API, { fallbackError: t("dbBackups.history.loadFailed") });
      records.value = res.items;
      recordsLoaded.value = true;
      recordsError.value = null;
    } catch (err) {
      if (sessionEnded()) return;
      if (!silent || !recordsLoaded.value) recordsError.value = backupErrorText(err, t("dbBackups.history.loadFailed"));
    } finally {
      if (!silent) recordsLoading.value = false;
    }
  }

  /* ---------------- Status & operation tracking ---------------- */

  /** The session was dropped (a restore rolls token versions back): send the admin to sign in. */
  function sessionEnded(): boolean {
    if (auth.isAuthenticated || disposed) return false;
    stop();
    if (restoreFollowed) toast.info(t("dbBackups.restore.signInAgain"));
    void router.push({ path: "/login", query: { redirect: "/admin/backup" } });
    return true;
  }

  async function announce(op: WatchedOp): Promise<void> {
    if (!op.backupId) return;
    let record: BackupRecord;
    try {
      record = await apiJson<BackupRecord>(`${DB_BACKUP_API}/${op.backupId}`);
    } catch {
      sessionEnded();
      return;
    }
    upsert(record);
    if (op.kind === "backup") {
      if (record.status === "completed") toast.success(t("dbBackups.run.done", { file: record.fileName, size: formatSize(record.sizeBytes) }));
      else if (record.status === "failed") toast.error(t("dbBackups.run.failed", { error: record.errorMessage || t("dbBackups.status.failed") }));
    } else if (record.restoreStatus === "completed") {
      toast.success(t("dbBackups.restore.done", { id: record.id }));
    } else if (record.restoreStatus === "failed") {
      toast.error(t("dbBackups.restore.failed", { error: record.restoreError || t("dbBackups.status.failed") }));
    }
  }

  async function refreshStatus(): Promise<void> {
    statusLoading.value = true;
    try {
      const next = await apiJson<BackupSystemStatus>(`${DB_BACKUP_API}/status`);
      statusError.value = null;
      const prev = watched;
      const op = next.activeOperation;
      // A backup's id is set a moment after the lock is taken: keep following the one we know.
      watched = op ? { kind: op.kind, backupId: op.backupId || (prev?.kind === op.kind ? prev.backupId : "") } : null;
      if (op?.kind === "restore") restoreFollowed = true;
      status.value = next;
      if (prev && (!watched || watched.backupId !== prev.backupId || watched.kind !== prev.kind)) {
        await announce(prev);
        // Retention may have pruned other records; the list is the source of truth again.
        await loadRecords(true);
      }
    } catch (err) {
      if (sessionEnded()) return;
      statusError.value = backupErrorText(err, t("common.loadFailed"));
    } finally {
      statusLoading.value = false;
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([refreshStatus(), loadRecords()]);
    schedule();
  }

  /** A backup or restore was just started from this tab (202): follow it closely. */
  function follow(kind: WatchedOp["kind"], record: BackupRecord) {
    upsert(record);
    watched = { kind, backupId: record.id };
    if (kind === "restore") restoreFollowed = true;
    if (status.value && !status.value.activeOperation) {
      status.value = {
        ...status.value,
        activeOperation: {
          kind,
          backupId: record.id,
          progress: kind === "backup" ? "pending" : "downloading",
          startedAtIso: new Date().toISOString(),
        },
      };
    }
    schedule(ACTIVE_POLL_MS);
  }

  /* ---------------- Polling ---------------- */

  function schedule(delay?: number) {
    window.clearTimeout(timer);
    if (disposed || document.visibilityState === "hidden") return;
    const ms = delay ?? (active.value ? ACTIVE_POLL_MS : remoteBusy.value ? REMOTE_POLL_MS : IDLE_POLL_MS);
    timer = window.setTimeout(() => void tick(), ms);
  }

  async function tick() {
    await refreshStatus();
    if (disposed) return;
    // Running on another instance: only the list shows its progress.
    if (!active.value && records.value.some(isBusy)) await loadRecords(true);
    schedule();
  }

  function stop() {
    disposed = true;
    window.clearTimeout(timer);
    window.clearInterval(ticker);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  function onVisibility() {
    if (document.visibilityState === "visible") void tick();
    else window.clearTimeout(timer);
  }

  // A one-second clock only while something runs (elapsed times in the banner and rows).
  watch(
    busy,
    (on) => {
      window.clearInterval(ticker);
      nowMs.value = Date.now();
      if (on) ticker = window.setInterval(() => (nowMs.value = Date.now()), 1_000);
    },
    { immediate: true },
  );

  onMounted(() => {
    document.addEventListener("visibilitychange", onVisibility);
    void refreshAll();
  });
  onBeforeUnmount(stop);

  return reactive({
    status,
    statusLoading,
    statusError,
    records,
    recordsLoaded,
    recordsLoading,
    recordsError,
    nowMs,
    active,
    busy,
    refreshStatus,
    loadRecords,
    refreshAll,
    follow,
    upsert,
    remove,
  });
}

export type DbBackupsController = ReturnType<typeof useDbBackups>;
