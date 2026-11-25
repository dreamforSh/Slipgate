import { ref } from "vue";
import { apiJson } from "../lib/api";
import { getPasskeyAssertion, isWebAuthnSupported, type ServerRequestOptions } from "../lib/webauthn";

/**
 * Re-confirmation with one of the signed-in user's passkeys: the BFF issues a step-up challenge,
 * the authenticator signs it, and the signed assertion is traded for a one-time
 * `passkeyStepUpToken` that sensitive endpoints accept in place of the password.
 */
export function usePasskeyStepUp() {
  const supported = isWebAuthnSupported();
  /** This browser can use WebAuthn and the account has at least one passkey. */
  const available = ref(false);
  let seq = 0;

  /** Quietly looks the account's passkeys up; the password always remains as a fallback. */
  async function refresh() {
    const mine = ++seq;
    if (!supported) {
      available.value = false;
      return;
    }
    try {
      const res = await apiJson<{ items: unknown[] }>("/api/v1/user/passkeys");
      if (mine === seq) available.value = res.items.length > 0;
    } catch {
      if (mine === seq) available.value = false;
    }
  }

  /** Ignores a lookup still in flight (the dialog closed). */
  function dispose() {
    seq++;
  }

  /** Runs the WebAuthn ceremony and resolves to the step-up token. */
  async function confirm(): Promise<string> {
    const challenge = await apiJson<{ challengeToken: string; options: ServerRequestOptions }>(
      "/api/v1/user/passkeys/step-up/options",
      { method: "POST", body: {} },
    );
    const credential = await getPasskeyAssertion(challenge.options);
    const verified = await apiJson<{ passkeyStepUpToken: string }>("/api/v1/user/passkeys/step-up/verify", {
      method: "POST",
      body: { challengeToken: challenge.challengeToken, credential },
    });
    return verified.passkeyStepUpToken;
  }

  return { supported, available, refresh, dispose, confirm };
}

/** True when the authenticator prompt was dismissed or timed out (not worth an error tone). */
export function isPasskeyCancellation(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");
}
