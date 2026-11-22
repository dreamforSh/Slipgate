import type { AccountTestEvent, AccountTestRequest } from "@slipgate/contracts";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** How one streamed connectivity test ended. */
export type AccountTestFinal =
  | { kind: "done"; event: AccountTestEvent }
  /** Rejected before streaming (not configured, VM account, network service down...). */
  | { kind: "rejected"; code?: string; message?: string }
  /** The stream closed without a terminal event. */
  | { kind: "interrupted" }
  | { kind: "aborted" };

/**
 * POST `/api/v1/admin/accounts/:id/test` and consume its SSE stream. `onEvent` sees every
 * event; the promise resolves with the terminal one. The BFF persists the outcome as the
 * account's `lastTest`, so callers only need to refresh afterwards.
 */
export async function streamAccountTest(
  fetcher: Fetcher,
  accountId: string,
  body: AccountTestRequest,
  opts: { signal?: AbortSignal; onEvent?: (ev: AccountTestEvent) => void } = {},
): Promise<AccountTestFinal> {
  let res: Response;
  try {
    res = await fetcher(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) return { kind: "aborted" };
    return { kind: "rejected", message: err instanceof Error ? err.message : String(err) };
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || !contentType.includes("text/event-stream")) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    return { kind: "rejected", code: payload.error, message: payload.message ?? `HTTP ${res.status}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: AccountTestEvent | null = null;
  const consume = (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim()) as AccountTestEvent;
        opts.onEvent?.(ev);
        if (ev.type === "done" || ev.type === "error") final = ev;
      } catch {
        // Ignore malformed lines; the stream continues.
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(`${decoder.decode()}\n`);
  } catch {
    if (opts.signal?.aborted) return { kind: "aborted" };
  }
  return final ? { kind: "done", event: final } : { kind: "interrupted" };
}

/** Run `task` over `items` with at most `limit` in flight; stops picking new items once aborted. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next++]!;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
