import type { UserRole } from "@slipgate/contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface JwtClaims {
  sub: string;
  email: string;
  role: UserRole;
  /**
   * The user's token version when the token was issued. Password changes and resets, suspension,
   * role changes and "sign out everywhere" bump the stored version, which ends every older token.
   */
  ver: number;
  /** Unique token id: a signed-out token's id stays on the denylist until the token expires. */
  jti: string;
  iat: number;
  exp: number;
  /** Group IDs scoped to a group_manager account (populated on request authentication). */
  managedGroupIds?: string[];
  /** How this caller authenticated on admin routes (admin_api_key refuses step-up checks). */
  authKind?: "jwt" | "admin_api_key";
}

/** Access token lifetime (the console signs in again after it; revocation is checked per request). */
export const ACCESS_TOKEN_TTL_SECONDS = 86_400;
/** Anything longer is not a token this service issued; refused before any parsing. */
const MAX_TOKEN_LENGTH = 4096;
const JTI_RE = /^[A-Za-z0-9_-]{16,128}$/;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }
  const buf = new ArrayBuffer(hex.length / 2);
  const out = new Uint8Array(buf);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(new ArrayBuffer(16));
  crypto.getRandomValues(salt);
  const iterations = 100_000;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `pbkdf2_sha256$${iterations}$${toHex(salt)}$${toHex(new Uint8Array(derived))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number.parseInt(parts[1]!, 10);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const salt = fromHex(parts[2]!);
  const expected = fromHex(parts[3]!);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return timingSafeEqual(new Uint8Array(derived), expected);
}

let dummyHash: Promise<string> | null = null;

/**
 * verifyPassword against `stored`, or against a throwaway hash when there is none (unknown email,
 * account without a password), so a failed sign-in costs the same time whether or not the account
 * exists. Always false without a stored hash.
 */
export async function verifyPasswordOrDummy(password: string, stored: string | null | undefined): Promise<boolean> {
  if (stored) return verifyPassword(password, stored);
  dummyHash ??= hashPassword(toHex(crypto.getRandomValues(new Uint8Array(16))));
  await verifyPassword(password, await dummyHash);
  return false;
}

async function importHmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

/** Signs an HS256 access token; a fresh random `jti` and the iat/exp pair are added here. */
export async function signJwt(
  claims: Omit<JwtClaims, "iat" | "exp" | "jti">,
  secret: string,
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAtIso: string; claims: JwtClaims }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: JwtClaims = {
    sub: claims.sub,
    email: claims.email,
    role: claims.role,
    ver: claims.ver,
    jti: toHex(crypto.getRandomValues(new Uint8Array(16))),
    iat: nowSec,
    exp: nowSec + ttlSeconds,
  };
  const headerSeg = bytesToBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payloadSeg = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerSeg}.${payloadSeg}`;

  const key = await importHmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, toArrayBuffer(encoder.encode(signingInput)));
  return {
    token: `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`,
    expiresAtIso: new Date(payload.exp * 1000).toISOString(),
    claims: payload,
  };
}

/**
 * Signature, shape and expiry of an access token. Tokens without a token version or id (issued
 * before sessions became revocable) are refused, so every accepted token can be signed out.
 * Whether the session is still valid (user, status, version, denylist) is SessionManager's job.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = segments;
  if (!headerSeg || !payloadSeg || !sigSeg) return null;

  try {
    const key = await importHmacKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(sigSeg),
      toArrayBuffer(encoder.encode(`${headerSeg}.${payloadSeg}`)),
    );
    if (!valid) return null;

    const claims = JSON.parse(decoder.decode(base64UrlToBytes(payloadSeg))) as JwtClaims;
    if (!claims || typeof claims !== "object") return null;
    if (typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string" || !claims.email) return null;
    if (claims.role !== "admin" && claims.role !== "group_manager" && claims.role !== "user") return null;
    if (!Number.isSafeInteger(claims.ver) || claims.ver < 0) return null;
    if (typeof claims.jti !== "string" || !JTI_RE.test(claims.jti)) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSec) {
      return null;
    }
    if (typeof claims.iat !== "number") return null;
    return {
      sub: claims.sub,
      email: claims.email,
      role: claims.role,
      ver: claims.ver,
      jti: claims.jti,
      iat: claims.iat,
      exp: claims.exp,
    };
  } catch {
    return null;
  }
}

async function deriveVaultKey(vaultSecret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(encoder.encode(vaultSecret)));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, usage);
}

export async function encryptSecret(plaintext: string, vaultSecret: string): Promise<Uint8Array> {
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(iv);
  const key = await deriveVaultKey(vaultSecret, ["encrypt"]);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    toArrayBuffer(encoder.encode(plaintext)),
  );
  const cipherBytes = new Uint8Array(cipher);
  const combined = new Uint8Array(new ArrayBuffer(iv.length + cipherBytes.length));
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.length);
  return combined;
}

export async function decryptSecret(blob: Uint8Array, vaultSecret: string): Promise<string> {
  if (blob.byteLength <= 12) {
    throw new Error("Encrypted secret blob is too short");
  }
  const iv = new Uint8Array(new ArrayBuffer(12));
  iv.set(blob.subarray(0, 12));
  const payload = new Uint8Array(new ArrayBuffer(blob.byteLength - 12));
  payload.set(blob.subarray(12));
  const key = await deriveVaultKey(vaultSecret, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, payload);
  return decoder.decode(plain);
}

/**
 * Keyed fingerprint of a credential for duplicate detection. HMAC (not a bare hash) so a
 * leaked fingerprint column cannot be brute-forced offline against short API keys.
 * Callers pass the canonical form (`canonicalCredentialText`).
 */
export async function credentialFingerprint(canonicalSecret: string, vaultSecret: string): Promise<string> {
  const key = await importHmacKey(`slipgate-credential-fingerprint:${vaultSecret}`, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, toArrayBuffer(encoder.encode(canonicalSecret)));
  return toHex(new Uint8Array(sig));
}

/** Token fields of JSON credentials, in the order the data plane's vault prefers them. */
const PREVIEW_TOKEN_KEYS = ["apiKey", "api_key", "accessToken", "access_token", "setupToken", "setup_token", "sessionKey", "token"];

/**
 * The token a JSON credential (sub2api / CPA auth file, `.claude/.credentials.json`,
 * `.codex/auth.json`) is used with, so its preview shows the key and not `{"emai...`.
 */
function primaryJsonToken(trimmed: string): string | null {
  if (!trimmed.startsWith("{")) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const rec = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  if (!rec) return null;
  const nested = ["claudeAiOauth", "tokens", "token"].flatMap((key) => {
    const value = rec[key];
    return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
  });
  for (const source of [rec, ...nested]) {
    for (const key of PREVIEW_TOKEN_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  const openAiKey = rec.OPENAI_API_KEY;
  return typeof openAiKey === "string" && openAiKey.trim() ? openAiKey.trim() : null;
}

/** `https://relay|key` (a key behind a custom base URL) previews the key, not the URL scheme. */
const RELAY_SECRET = /^https?:\/\/[^|\s]+\|(.+)$/s;

export function maskSecret(raw: string): string {
  const trimmed = raw.trim();
  const shown = primaryJsonToken(trimmed) ?? RELAY_SECRET.exec(trimmed)?.[1]?.trim() ?? trimmed;
  if (shown.length < 14) {
    return "****";
  }
  return `${shown.slice(0, 6)}...${shown.slice(-4)}`;
}

export async function generateApiKey(): Promise<{
  plaintextKey: string;
  keyPrefix: string;
  keyHash: Uint8Array;
}> {
  const randomBytes = new Uint8Array(new ArrayBuffer(20));
  crypto.getRandomValues(randomBytes);
  const plaintextKey = `sk-sg-${toHex(randomBytes)}`;
  const keyPrefix = `${plaintextKey.slice(0, 12)}...${plaintextKey.slice(-4)}`;
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(encoder.encode(plaintextKey)));
  return {
    plaintextKey,
    keyPrefix,
    keyHash: new Uint8Array(digest),
  };
}
