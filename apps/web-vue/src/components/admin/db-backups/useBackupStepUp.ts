import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BackupStepUpRequest } from "@slipgate/contracts";
import { ApiError, apiJson } from "../../../lib/api";
import { useAuthStore } from "../../../stores/auth";
import { backupErrorText } from "./dbBackupUtil";

/**
 * Re-authentication for download and restore: the password, plus the authenticator code when the
 * admin has two-factor sign-in on. The session's flag is a first guess; it is re-read when the
 * dialog opens, and a `totp_required` refusal switches the code field on as well.
 */
export function useBackupStepUp() {
  const { t } = useI18n();
  const auth = useAuthStore();

  const password = ref("");
  const code = ref("");
  const needTotp = ref(Boolean(auth.user?.totpEnabled));
  const checking = ref(false);
  const passwordError = ref<string | null>(null);
  const codeError = ref<string | null>(null);
  const formError = ref<string | null>(null);
  let seq = 0;

  // Editing a field retracts the refusal that was shown for it.
  watch(password, () => {
    passwordError.value = null;
    formError.value = null;
  });
  watch(code, (value) => {
    if (value) codeError.value = null;
  });

  function setTotp(enabled: boolean) {
    needTotp.value = enabled;
    if (auth.user && auth.user.totpEnabled !== enabled) auth.user.totpEnabled = enabled;
  }

  async function refresh() {
    const mine = ++seq;
    checking.value = true;
    try {
      const res = await apiJson<{ enabled: boolean }>("/api/v1/user/totp");
      if (mine === seq) setTotp(res.enabled);
    } catch {
      // Keep the session's value: the server enforces the right factors anyway.
    } finally {
      if (mine === seq) checking.value = false;
    }
  }

  function clearErrors() {
    passwordError.value = null;
    codeError.value = null;
    formError.value = null;
  }

  /** Fresh fields for a new opening (never keep a password around). */
  function reset() {
    password.value = "";
    code.value = "";
    clearErrors();
    needTotp.value = Boolean(auth.user?.totpEnabled);
    void refresh();
  }

  /** Dialog closed: forget the secrets and ignore a late two-factor check. */
  function dispose() {
    seq++;
    checking.value = false;
    password.value = "";
    code.value = "";
    clearErrors();
  }

  const ready = computed(() => password.value.length > 0 && (!needTotp.value || code.value.length === 6));

  function payload(): BackupStepUpRequest {
    return needTotp.value ? { password: password.value, totpCode: code.value } : { password: password.value };
  }

  /** Puts a step-up refusal on the right field; false when `err` is something else. */
  function absorb(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    const text = backupErrorText(err, t("common.requestFailed"));
    switch (err.code) {
      case "invalid_password":
        passwordError.value = text;
        return true;
      case "totp_required":
        setTotp(true);
        codeError.value = text;
        return true;
      case "invalid_totp":
        code.value = "";
        codeError.value = text;
        return true;
      case "too_many_attempts":
        formError.value = text;
        return true;
      default:
        if (err.status === 429) {
          formError.value = text;
          return true;
        }
        return false;
    }
  }

  return { password, code, needTotp, checking, passwordError, codeError, formError, ready, reset, dispose, payload, absorb, clearErrors };
}
