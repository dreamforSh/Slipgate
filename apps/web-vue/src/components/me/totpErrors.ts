import { ApiError, errorText } from "../../lib/api";
import { i18n } from "../../i18n";

/**
 * Localised message for a failed two-factor call. The BFF answers wrong passwords and rate
 * limits with `forbidden`, bad codes with `bad_request` and state races with `conflict`.
 */
export function totpErrorText(err: unknown, stage: "setup" | "code", fallback: string): string {
  const t = i18n.global.t;
  if (err instanceof ApiError) {
    if (err.status === 429 || /too many/i.test(err.message)) return t("security.totp.errors.tooMany");
    if (err.code === "forbidden") return t("security.totp.errors.password");
    if (err.code === "conflict") return t("security.totp.errors.conflict");
    if (stage === "code" && (err.code === "bad_request" || err.code === "invalid_request")) {
      return /setup/i.test(err.message) ? t("security.totp.errors.restart") : t("security.totp.errors.code");
    }
    if (err.code === "invalid_request") return fallback;
  }
  return errorText(err, fallback);
}
