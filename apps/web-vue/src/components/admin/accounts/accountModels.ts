import { ref } from "vue";
import { ACCOUNT_TEST_MODELS, type AccountModelsResponse, type Provider } from "@slipgate/contracts";
import { useAuthStore } from "../../../stores/auth";

/**
 * Models an account can use, fetched once per account and session from
 * `GET /api/v1/admin/accounts/:id/models` (the provider's list over the account's egress, or the
 * built-in suggestions with the reason). Shared by the test and scheduled-test dialogs.
 */
const cache = new Map<string, AccountModelsResponse>();

export function useAccountModels() {
  const auth = useAuthStore();
  const loading = ref(false);
  const result = ref<AccountModelsResponse | null>(null);
  const error = ref<string | null>(null);

  /** Cached answer for an account, if it was fetched this session. */
  function cached(accountId: string): AccountModelsResponse | null {
    return cache.get(accountId) ?? null;
  }

  function show(accountId: string | null | undefined) {
    result.value = accountId ? cached(accountId) : null;
    error.value = null;
  }

  async function load(accountId: string): Promise<AccountModelsResponse | null> {
    loading.value = true;
    error.value = null;
    try {
      const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/models`);
      const body = (await res.json().catch(() => ({}))) as Partial<AccountModelsResponse> & { message?: string };
      if (!res.ok || !Array.isArray(body.models)) {
        error.value = body.message ?? `HTTP ${res.status}`;
        return null;
      }
      const answer = body as AccountModelsResponse;
      cache.set(accountId, answer);
      result.value = answer;
      return answer;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      loading.value = false;
    }
  }

  /** Fetched models first, then the built-in suggestions not already listed. */
  function suggestions(platform: Provider | undefined): string[] {
    const builtin = platform ? (ACCOUNT_TEST_MODELS[platform] ?? []) : [];
    const fetched = result.value?.models ?? [];
    return [...new Set([...fetched, ...builtin])];
  }

  return { loading, result, error, cached, show, load, suggestions };
}
