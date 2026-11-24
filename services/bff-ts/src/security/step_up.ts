import type { Context } from "hono";
import type { AdminStepUp, AuditStepUpError } from "@slipgate/contracts";
import { WindowLimiter } from "../insights.ts";
import type { SessionManager } from "../middleware/auth.ts";
import type { PasskeyStepUpRegistry } from "../routes/passkeys.ts";
import type { ControlStore } from "../store/types.ts";
import { clientIp } from "./client_ip.ts";
import { decryptSecret } from "./crypto.ts";
import { verifyTotp } from "./totp.ts";

/** Codes one administrator may try per window across every guarded action (and 2FA enable/disable). */
export const STEP_UP_ATTEMPTS = 8;
export const STEP_UP_WINDOW_MS = 5 * 60_000;

export interface StepUpFailure {
  status: 403 | 429;
  error: AuditStepUpError;
  message: string;
}

/**
 * A fresh two-factor code for destructive audit-log actions (clear, shortening the retention
 * period, an on-demand retention sweep), as Linksyncx AuditLogHandler.Clear does: the code only
 * (never a password), checked on every call against the per-user replay guard, so a step already
 * accepted (the sign-in one included) is refused and no earlier session or step-up covers it.
 * Administrators without two-factor authentication are refused outright.
 */
export class TotpStepUp {
  readonly limiter = new WindowLimiter(STEP_UP_ATTEMPTS, STEP_UP_WINDOW_MS);

  constructor(
    private readonly store: ControlStore,
    private readonly vaultSecret: string,
  ) {}

  /** null when `code` is a fresh valid code for `userId`. */
  async verify(userId: string, code: string | undefined): Promise<StepUpFailure | null> {
    const state = await this.store.ops.getTotp(userId);
    if (!state?.enabled || !state.secretEnc) {
      return {
        status: 403,
        error: "totp_not_enabled",
        message: "Turn on two-factor authentication for your account first",
      };
    }
    if (!code) return { status: 403, error: "totp_required", message: "Enter the code from your authenticator app" };
    if (!this.limiter.allow(userId)) return { status: 429, error: "too_many_attempts", message: "Too many attempts, try again later" };
    let secret: string | null = null;
    try {
      secret = await decryptSecret(state.secretEnc, this.vaultSecret);
    } catch {
      // A secret that no longer decrypts (vault secret changed) cannot vouch for anything.
      secret = null;
    }
    if (!secret || !(await verifyTotp(secret, code, userId))) {
      return { status: 403, error: "invalid_totp", message: "The two-factor code is not valid" };
    }
    return null;
  }

  /** null when confirmed; otherwise the JSON refusal to return from the route. */
  async require(c: Context, userId: string, code: string | undefined): Promise<Response | null> {
    const failure = await this.verify(userId, code);
    if (!failure) return null;
    if (failure.status === 429) c.header("Retry-After", String(STEP_UP_WINDOW_MS / 1000));
    return c.json({ error: failure.error, message: failure.message }, failure.status);
  }

  /**
   * Re-confirms the administrator behind a session before an action that could hand over the
   * deployment or its data (an administrator account, another user's sign-in, the backup target):
   * the account password through the per-user attempt limit, plus a fresh code when two-factor
   * sign-in is on. A stolen session token alone is not enough for any of them.
   */
  async confirmAdmin(c: Context, sessions: SessionManager, userId: string, confirm: AdminStepUp | undefined): Promise<Response | null> {
    if (!confirm) return c.json({ error: "step_up_required", message: "Confirm this change with your password or passkey" }, 403);
    if (confirm.passkeyStepUpToken) {
      const registry = passkeyRegistries.get(this.store);
      if (registry && registry.consume(confirm.passkeyStepUpToken, userId)) {
        return null;
      }
      return c.json({ error: "invalid_passkey_step_up", message: "Passkey verification expired or invalid" }, 403);
    }
    if (!confirm.password) {
      return c.json({ error: "step_up_required", message: "Confirm this change with your password or passkey" }, 403);
    }
    const check = await sessions.confirmPassword(userId, clientIp(c), confirm.password);
    if (!check.ok) {
      if (check.retryAfterSeconds !== null) {
        c.header("Retry-After", String(check.retryAfterSeconds));
        return c.json({ error: "too_many_attempts", message: "Too many wrong passwords, try again later" }, 429);
      }
      return c.json({ error: "invalid_password", message: "Password confirmation failed" }, 403);
    }
    const totp = await this.store.ops.getTotp(userId);
    if (!totp?.enabled) return null;
    return this.require(c, userId, confirm.totpCode);
  }
}

const guards = new WeakMap<ControlStore, Map<string, TotpStepUp>>();
const passkeyRegistries = new WeakMap<ControlStore, PasskeyStepUpRegistry>();

export function attachPasskeyStepUpRegistry(store: ControlStore, registry: PasskeyStepUpRegistry): void {
  passkeyRegistries.set(store, registry);
}

/**
 * The step-up guard of one app (store + vault secret): every route asking for a code shares its
 * attempt limiter, so spreading guesses across endpoints gains nothing.
 */
export function totpStepUp(store: ControlStore, vaultSecret: string): TotpStepUp {
  let bySecret = guards.get(store);
  if (!bySecret) {
    bySecret = new Map();
    guards.set(store, bySecret);
  }
  let guard = bySecret.get(vaultSecret);
  if (!guard) {
    guard = new TotpStepUp(store, vaultSecret);
    bySecret.set(vaultSecret, guard);
  }
  return guard;
}
