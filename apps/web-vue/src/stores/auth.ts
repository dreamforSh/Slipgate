import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type {
  AuthSessionResponse,
  RevokeAllSessionsResponse,
  SetupStatus,
  UserProfile,
  WalletSummary,
} from "@slipgate/contracts";

const TOKEN_STORAGE_KEY = "slipgate_access_token";
/** A sign-out request never holds the console hostage: the local session ends regardless. */
const LOGOUT_TIMEOUT_MS = 5_000;

function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredToken(value: string) {
  try {
    if (value) localStorage.setItem(TOKEN_STORAGE_KEY, value);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage blocked (private mode): the session simply lasts for this tab.
  }
}

/** Issue / expiry times read from the access token (display only; the server decides validity). */
export interface SessionTimes {
  issuedAtIso: string | null;
  expiresAtIso: string | null;
}

function decodeClaims(accessToken: string): Record<string, unknown> {
  try {
    const payload = accessToken.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function decodeSessionTimes(accessToken: string): SessionTimes {
  const claims = decodeClaims(accessToken);
  const iso = (sec: unknown) => (typeof sec === "number" && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);
  return { issuedAtIso: iso(claims.iat), expiresAtIso: iso(claims.exp) };
}

function decodeSubject(accessToken: string): string | null {
  const sub = decodeClaims(accessToken).sub;
  return typeof sub === "string" ? sub : null;
}

export const useAuthStore = defineStore("auth", () => {
  const token = ref<string>(readStoredToken());
  const user = ref<UserProfile | null>(null);
  const wallet = ref<WalletSummary | null>(null);
  const setupStatus = ref<SetupStatus | null>(null);
  const hydrated = ref(false);
  /** Why the session was ended by the server ("backend_mode": the site went admin-only); the login page shows it once. */
  const sessionNotice = ref<"backend_mode" | null>(null);

  const isAuthenticated = computed(() => Boolean(token.value && user.value));
  const isAdmin = computed(() => user.value?.role === "admin");
  const sessionTimes = computed<SessionTimes>(() =>
    token.value ? decodeSessionTimes(token.value) : { issuedAtIso: null, expiresAtIso: null },
  );

  function setSession(session: AuthSessionResponse) {
    token.value = session.accessToken;
    user.value = session.user;
    hydrated.value = true;
    writeStoredToken(session.accessToken);
  }

  /** Takes over a session token minted elsewhere (third-party sign-in); call hydrateSession next. */
  function adoptToken(accessToken: string) {
    token.value = accessToken;
    user.value = null;
    hydrated.value = false;
    writeStoredToken(accessToken);
  }

  function clearLocal() {
    token.value = "";
    user.value = null;
    wallet.value = null;
  }

  /**
   * Drops the session locally (the server already refused it). Storage is only cleared while it
   * still holds this tab's token: another tab may have stored a newer one (password change).
   */
  function logout() {
    const current = token.value;
    clearLocal();
    if (readStoredToken() === current) writeStoredToken("");
  }

  /**
   * Signs this device out on the server first (its token is revoked there, so a copy of it stops
   * working too), then locally. The local session ends even when the server can't be reached.
   */
  async function signOut(): Promise<void> {
    const current = token.value;
    if (current) {
      try {
        await fetch("/api/v1/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${current}` },
          signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
        });
      } catch {
        // Offline or slow: the token still leaves this device and expires on its own.
      }
    }
    clearLocal();
    writeStoredToken("");
  }

  /**
   * Ends every session of this account. With `keepCurrent` this device carries on with the fresh
   * session the server returns; otherwise it is signed out as well.
   */
  async function revokeAllSessions(keepCurrent: boolean): Promise<void> {
    const res = await apiFetch("/api/v1/user/sessions/revoke-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keepCurrent }),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { message?: string };
        if (data.message) message = data.message;
      } catch {
        // Keep the status text.
      }
      throw new Error(message);
    }
    const data = (await res.json()) as RevokeAllSessionsResponse;
    if (keepCurrent && data.session) setSession(data.session);
    else logout();
  }

  /**
   * The account this tab last showed. Unlike `user` it survives a sign-out, so a later sign-in from
   * another tab is still compared against the account whose views this page has loaded.
   */
  let shownSubject: string | null = null;
  watch(
    () => user.value?.id,
    (id) => {
      if (id) shownSubject = id;
    },
    { immediate: true },
  );

  // Another tab signed out, or was handed a fresh token (password change): follow it. A token of
  // another account, or any sign-in after this tab's session ended, means the loaded views are
  // stale (or belong to someone else), so the page starts over instead of adopting the token.
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key !== TOKEN_STORAGE_KEY && e.key !== null) return;
      const next = readStoredToken();
      if (next === token.value) return;
      if (!next) {
        clearLocal();
        return;
      }
      if (shownSubject && (!user.value || decodeSubject(next) !== shownSubject)) {
        window.location.reload();
        return;
      }
      token.value = next;
    });
  }

  async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const send = (bearer: string) => {
      const headers = new Headers(init.headers);
      if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
      return fetch(input, { ...init, headers });
    };
    const sent = token.value;
    const res = await send(sent);
    if (res.status === 403 && sent) await endIfBackendMode(res, sent);
    if (res.status !== 401) return res;
    // The token may have been replaced while this request was out (another tab changed the
    // password and stored the fresh token): retry once with the newest one before signing out.
    // A refused token never reaches a handler, so the retry cannot repeat any side effect. Only a
    // token of the same account is used: a request made for one account never runs as another.
    const latest = token.value !== sent ? token.value : readStoredToken();
    if (latest && latest !== sent && decodeSubject(latest) === decodeSubject(sent)) {
      if (token.value === sent) token.value = latest;
      const retried = await send(latest);
      if (retried.status === 401 && token.value === latest) logout();
      return retried;
    }
    if (token.value === sent) logout();
    return res;
  }

  /**
   * Backend (admin-only) mode switched on: the server refuses this non-admin session everywhere
   * (403 backend_mode), so it ends here as well and the login page says why.
   */
  async function endIfBackendMode(res: Response, sent: string): Promise<void> {
    if (user.value?.role === "admin") return;
    try {
      const data = (await res.clone().json()) as { error?: unknown };
      if (data.error !== "backend_mode" || token.value !== sent) return;
    } catch {
      return;
    }
    sessionNotice.value = "backend_mode";
    logout();
  }

  /** The pending session notice, cleared once read. */
  function consumeSessionNotice(): "backend_mode" | null {
    const notice = sessionNotice.value;
    sessionNotice.value = null;
    return notice;
  }

  async function fetchSetupStatus(force = false): Promise<SetupStatus | null> {
    if (setupStatus.value && !force) {
      return setupStatus.value;
    }
    try {
      const res = await fetch("/api/v1/setup/status");
      if (res.ok) {
        setupStatus.value = (await res.json()) as SetupStatus;
      }
    } catch {
      // Ignore transient offline error during isolated dev.
    }
    return setupStatus.value;
  }

  async function hydrateSession(): Promise<void> {
    if (!token.value) {
      hydrated.value = true;
      return;
    }
    try {
      const res = await apiFetch("/api/v1/auth/me");
      if (res.ok) {
        const data = (await res.json()) as { user: UserProfile; wallet: WalletSummary };
        user.value = data.user;
        wallet.value = data.wallet;
      } else {
        logout();
      }
    } catch {
      logout();
    } finally {
      hydrated.value = true;
    }
  }

  return {
    token,
    user,
    wallet,
    setupStatus,
    hydrated,
    sessionNotice,
    consumeSessionNotice,
    isAuthenticated,
    isAdmin,
    sessionTimes,
    setSession,
    adoptToken,
    logout,
    signOut,
    revokeAllSessions,
    apiFetch,
    fetchSetupStatus,
    hydrateSession,
  };
});
