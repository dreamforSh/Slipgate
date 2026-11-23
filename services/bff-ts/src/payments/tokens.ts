import { createHmac, randomBytes } from "node:crypto";
import { timingSafeEqualText } from "./http.ts";

/**
 * Signed, expiring tokens of the payment flows, keyed by a purpose-specific HMAC key derived
 * from the vault secret (so a token of one purpose never validates as another):
 *  - order resume tokens in provider return URLs (an unauthenticated result page may ask the
 *    status of that one order, and trigger a provider check);
 *  - the WeChat OAuth `state` (letters and digits only, ≤128 bytes, bound to the user and the
 *    WeChat Pay instance);
 *  - the WeChat resume token carrying the payer's openid back into order creation.
 */

const b64url = (b: Buffer) => b.toString("base64url");

function key(vaultSecret: string, purpose: string): Buffer {
  return createHmac("sha256", vaultSecret).update(`slipgate-payments:${purpose}`).digest();
}

function mac(vaultSecret: string, purpose: string, text: string): string {
  return b64url(createHmac("sha256", key(vaultSecret, purpose)).update(text).digest());
}

/** base64url(JSON payload with `e` = expiry seconds) + "." + MAC. */
export function signToken(vaultSecret: string, purpose: string, payload: Record<string, string | number>, ttlSec: number): string {
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, e: Math.floor(Date.now() / 1000) + ttlSec }), "utf8"));
  return `${body}.${mac(vaultSecret, purpose, body)}`;
}

export function verifyToken(vaultSecret: string, purpose: string, token: string): Record<string, unknown> | null {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined || token.length > 2048) return null;
  if (!timingSafeEqualText(sig, mac(vaultSecret, purpose, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.e !== "number" || payload.e < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------------- Order resume tokens ---------------- */

const RESUME_TTL_SEC = 7 * 86_400;

export function orderResumeToken(vaultSecret: string, orderId: string): string {
  return signToken(vaultSecret, "order-resume", { o: orderId }, RESUME_TTL_SEC);
}

export function orderFromResumeToken(vaultSecret: string, token: string): string | null {
  const p = verifyToken(vaultSecret, "order-resume", token);
  return p && typeof p.o === "string" ? p.o : null;
}

/* ---------------- WeChat OAuth state & openid token ---------------- */

const STATE_TTL_SEC = 15 * 60;
export const WECHAT_RESUME_TTL_SEC = 15 * 60;

/** `${instanceId}Z${expiry base36}Z${nonce}Z${mac}`: [A-Za-z0-9] only, ~80 characters. */
export function wechatOAuthState(vaultSecret: string, userId: string, instanceId: string): string {
  const exp = (Math.floor(Date.now() / 1000) + STATE_TTL_SEC).toString(36);
  const n = randomBytes(6).toString("hex");
  const m = createHmac("sha256", key(vaultSecret, "wechat-state")).update(`${userId}|${instanceId}|${exp}|${n}`).digest("hex").slice(0, 32);
  return `${instanceId}Z${exp}Z${n}Z${m}`;
}

/** The WeChat Pay instance the state was issued for, when it is valid for this user. */
export function verifyWechatOAuthState(vaultSecret: string, userId: string, state: string): string | null {
  const parts = state.split("Z");
  if (parts.length !== 4 || !/^[A-Za-z0-9]+$/.test(state.replace(/Z/g, ""))) return null;
  const [instanceId, exp, n, m] = parts as [string, string, string, string];
  const expected = createHmac("sha256", key(vaultSecret, "wechat-state")).update(`${userId}|${instanceId}|${exp}|${n}`).digest("hex").slice(0, 32);
  if (!timingSafeEqualText(m, expected)) return null;
  if (Number.parseInt(exp, 36) < Math.floor(Date.now() / 1000)) return null;
  return instanceId;
}

export function wechatResumeToken(vaultSecret: string, userId: string, instanceId: string, openid: string): string {
  return signToken(vaultSecret, "wechat-openid", { u: userId, i: instanceId, o: openid }, WECHAT_RESUME_TTL_SEC);
}

export function readWechatResumeToken(vaultSecret: string, userId: string, token: string): { instanceId: string; openid: string } | null {
  const p = verifyToken(vaultSecret, "wechat-openid", token);
  if (!p || p.u !== userId || typeof p.i !== "string" || typeof p.o !== "string" || !p.o) return null;
  return { instanceId: p.i, openid: p.o };
}
