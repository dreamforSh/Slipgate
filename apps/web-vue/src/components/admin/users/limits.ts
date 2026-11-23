import { useI18n } from "vue-i18n";
import { USER_LIMIT_MAX, type PortalSettings, type UserCap } from "@slipgate/contracts";
import { ApiError, apiJson, errorText } from "../../../lib/api";

/**
 * Shared helpers for per-user caps, per-user group rates and the admin user tooling (lane U1).
 * Caps are whole numbers where 0 means "no cap"; a user's own cap may be null ("portal default").
 */

export type CapKind = "rpm" | "concurrency";

/** Trims a multiplier for display (1.2500000001 → 1.25). */
export function fmtRate(rate: number): number {
  return Number(rate.toFixed(4));
}

/** Integer in [min, USER_LIMIT_MAX] from typed text, else null. */
export function parseLimit(text: string | number, min = 0): number | null {
  const raw = typeof text === "number" ? String(text) : text.trim();
  if (raw === "" || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= USER_LIMIT_MAX ? n : null;
}

/** Positive multiplier in (0, 100] from typed text, else null. */
export function parseRate(text: string | number): number | null {
  const raw = typeof text === "number" ? String(text) : text.trim();
  if (raw === "" || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/** Same-cap check for UserCap values (null and undefined both mean "default"). */
export function sameCap(a: UserCap | undefined, b: UserCap | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/** Labels, error copy and cap text shared by the lane's views. */
export function useLimitText() {
  const { t, te } = useI18n();

  /** "60 RPM" / "5 并发" / "不限" for an effective cap. */
  function capText(value: number | null | undefined, kind: CapKind): string {
    if (value === null || value === undefined) return "—";
    if (value <= 0) return t("userLimits.cap.unlimited");
    return kind === "rpm" ? t("userLimits.cap.rpm", { n: value }) : t("userLimits.cap.concurrency", { n: value });
  }

  /**
   * Friendly copy for a failed call: the action that failed plus the server's error code mapped to
   * i18n (bad_request / conflict keep the server's detail, which names the field or the blocker).
   */
  function errorOf(err: unknown, action: string): string {
    if (err instanceof ApiError) {
      const code =
        err.status === 429
          ? "rate_limited"
          : (err.code ??
            ({ 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict" } as Record<number, string>)[
              err.status
            ] ??
            (err.status >= 500 ? "server" : null));
      const key = code ? `userLimits.errors.codes.${code}` : "";
      if (key && te(key)) {
        const reason = t(key);
        const detail = (code === "bad_request" || code === "conflict") && err.message && err.message !== action ? err.message : "";
        return t("userLimits.errors.withReason", {
          action,
          reason: detail ? t("userLimits.errors.reasonDetail", { reason, detail }) : reason,
        });
      }
    }
    if (err instanceof TypeError) return t("userLimits.errors.withReason", { action, reason: t("userLimits.errors.codes.network") });
    return errorText(err, action);
  }

  return { t, capText, errorOf };
}

/* ------------------------------------------------------------------------------------------ */
/* Portal defaults (Settings → default user RPM / concurrency), cached per page session        */
/* ------------------------------------------------------------------------------------------ */

export interface PortalCapDefaults {
  rpm: number;
  concurrency: number;
}

let defaultsCache: { at: number; promise: Promise<PortalCapDefaults | null> } | null = null;

/** The portal's default user caps (null when settings cannot be read). Cached for a minute. */
export function loadPortalCapDefaults(force = false): Promise<PortalCapDefaults | null> {
  if (!force && defaultsCache && Date.now() - defaultsCache.at < 60_000) return defaultsCache.promise;
  const promise = apiJson<Pick<PortalSettings, "defaultUserRpm" | "defaultUserConcurrency">>("/api/v1/admin/settings")
    .then((s) => ({ rpm: Number(s.defaultUserRpm ?? 0), concurrency: Number(s.defaultUserConcurrency ?? 0) }))
    .catch(() => {
      defaultsCache = null;
      return null;
    });
  defaultsCache = { at: Date.now(), promise };
  return promise;
}

/** Drops the cached defaults (after Settings changed them). */
export function invalidatePortalCapDefaults(): void {
  defaultsCache = null;
}
