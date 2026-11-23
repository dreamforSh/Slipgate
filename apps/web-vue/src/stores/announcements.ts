import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type { UserAnnouncementItem } from "@slipgate/contracts";
import { useAuthStore } from "./auth";

const REFRESH_MS = 5 * 60_000;
/** An eligibility change re-checks the feed at most this often (targeting can depend on it). */
const RECHECK_MIN_MS = 15_000;

/**
 * Signed-in user's announcement feed: unread count for the header bell and a queue of
 * unread pop-up announcements shown one at a time by AnnouncementPopup.
 */
export const useAnnouncementStore = defineStore("announcements", () => {
  const items = ref<UserAnnouncementItem[]>([]);
  const loadedAt = ref(0);
  const loading = ref(false);
  /** Pop-ups the user dismissed this session (marked read server-side too). */
  const dismissed = ref(new Set<string>());
  /** A forced refresh asked for while a load was in flight runs right after it. */
  let forceQueued = false;
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;

  const unreadCount = computed(() => items.value.filter((a) => !a.read).length);
  const popupQueue = computed(() => items.value.filter((a) => a.popup && !a.read && !dismissed.value.has(a.id)));

  async function refresh(force = false): Promise<void> {
    const auth = useAuthStore();
    if (!auth.isAuthenticated) return;
    if (loading.value) {
      // The load in flight may predate the change that asked for this one.
      if (force) forceQueued = true;
      return;
    }
    if (!force && Date.now() - loadedAt.value < REFRESH_MS) return;
    loading.value = true;
    try {
      const res = await auth.apiFetch("/api/v1/user/announcements");
      if (res.ok) {
        items.value = ((await res.json()) as { items: UserAnnouncementItem[] }).items;
        loadedAt.value = Date.now();
      }
    } catch {
      // The bell simply keeps its last state.
    } finally {
      loading.value = false;
    }
    if (forceQueued) {
      forceQueued = false;
      await refresh(true);
    }
  }

  /**
   * The server only returns announcements the account is eligible for, and a targeting rule looks
   * at the wallet balance and active subscriptions: after a top-up, redeem, charge or subscription
   * purchase, fetch the feed again. Throttled to one load per RECHECK_MIN_MS, with a trailing
   * load at the end of the window so a change right after a load is never dropped.
   */
  function recheck() {
    if (!useAuthStore().isAuthenticated) return;
    const wait = loadedAt.value + RECHECK_MIN_MS - Date.now();
    if (wait <= 0) {
      clearTimeout(recheckTimer);
      recheckTimer = undefined;
      void refresh(true);
      return;
    }
    if (recheckTimer !== undefined) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = undefined;
      void refresh(true);
    }, wait);
  }

  async function markRead(ids: string[] | "all") {
    const auth = useAuthStore();
    const targets = ids === "all" ? items.value.filter((a) => !a.read).map((a) => a.id) : ids;
    if (targets.length === 0) return;
    items.value = items.value.map((a) => (targets.includes(a.id) ? { ...a, read: true } : a));
    try {
      await auth.apiFetch("/api/v1/user/announcements/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ids === "all" ? { all: true } : { ids: targets }),
      });
    } catch {
      // Optimistic: worst case the item shows as unread again after the next refresh.
    }
  }

  function dismissPopup(id: string) {
    dismissed.value = new Set(dismissed.value).add(id);
    void markRead([id]);
  }

  function reset() {
    clearTimeout(recheckTimer);
    recheckTimer = undefined;
    forceQueued = false;
    items.value = [];
    loadedAt.value = 0;
    dismissed.value = new Set();
  }

  watch(
    () => useAuthStore().wallet?.balanceNanoUsd,
    (next, prev) => {
      if (next === undefined || prev === undefined || next === prev) return;
      recheck();
    },
  );

  return { items, loading, unreadCount, popupQueue, refresh, recheck, markRead, dismissPopup, reset };
});
