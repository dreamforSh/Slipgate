import { useAuthStore } from "../stores/auth";

/** Error carrying the BFF's `message` (or a fallback) and HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    /** X-Request-Id of the failed call: the server's system log entries carry the same id. */
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Best-effort `message` from a failed response. */
export async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: string };
    return data.message || data.error || fallback;
  } catch {
    return fallback;
  }
}

/** `?a=1&b=x` from an object, skipping undefined, null and empty strings. */
export function toQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const text = sp.toString();
  return text ? `?${text}` : "";
}

/**
 * Authenticated JSON call through the auth store (401 logs out). Throws ApiError with the
 * server's message on non-2xx so views can show it directly.
 */
export async function apiJson<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; fallbackError?: string } = {},
): Promise<T> {
  const auth = useAuthStore();
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await auth.apiFetch(path, { method: init.method ?? "GET", headers, body, signal: init.signal });
  if (!res.ok) {
    let code: string | null = null;
    let message = init.fallbackError ?? `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      code = data.error ?? null;
      message = data.message || data.error || message;
    } catch {
      // Non-JSON error body: keep the fallback.
    }
    throw new ApiError(message, res.status, code, res.headers.get("x-request-id"));
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Unauthenticated JSON GET/POST for public pages. */
export async function publicJson<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  if (!res.ok) {
    // Keep the stable `error` code too (captcha_required, email_domain_limit …) for friendly copy.
    let code: string | null = null;
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      code = typeof data.error === "string" ? data.error : null;
      message = data.message || data.error || message;
    } catch {
      // Non-JSON error body: keep the status text.
    }
    throw new ApiError(message, res.status, code, res.headers.get("x-request-id"));
  }
  return (await res.json()) as T;
}

/** Fetches an authenticated file (CSV export) and saves it with the server's file name. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const auth = useAuthStore();
  const res = await auth.apiFetch(path);
  if (!res.ok) throw new ApiError(await readError(res, `HTTP ${res.status}`), res.status);
  const disposition = res.headers.get("content-disposition") ?? "";
  const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? fallbackName;
  saveBlob(await res.blob(), name);
}

/** Saves an in-memory blob (generated codes, client-side CSV) as a download. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Message text for anything a `catch` receives. */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
