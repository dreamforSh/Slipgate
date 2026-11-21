import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  AuthSessionResponse,
  SetupStatus,
  UserProfile,
  WalletSummary,
} from "@slipgate/contracts";

const TOKEN_STORAGE_KEY = "slipgate_access_token";

export const useAuthStore = defineStore("auth", () => {
  const token = ref<string>(localStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
  const user = ref<UserProfile | null>(null);
  const wallet = ref<WalletSummary | null>(null);
  const setupStatus = ref<SetupStatus | null>(null);
  const hydrated = ref(false);

  const isAuthenticated = computed(() => Boolean(token.value && user.value));
  const isAdmin = computed(() => user.value?.role === "admin");

  function setSession(session: AuthSessionResponse) {
    token.value = session.accessToken;
    user.value = session.user;
    hydrated.value = true;
    localStorage.setItem(TOKEN_STORAGE_KEY, session.accessToken);
  }

  function logout() {
    token.value = "";
    user.value = null;
    wallet.value = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }

  async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (token.value) {
      headers.set("Authorization", `Bearer ${token.value}`);
    }
    const res = await fetch(input, { ...init, headers });
    if (res.status === 401) {
      logout();
    }
    return res;
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
    isAuthenticated,
    isAdmin,
    setSession,
    logout,
    apiFetch,
    fetchSetupStatus,
    hydrateSession,
  };
});
