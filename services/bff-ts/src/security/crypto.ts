import type { UserRole } from "@slipgate/contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface JwtClaims {
  sub: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

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

async function importHmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

export async function signJwt(
  claims: Omit<JwtClaims, "iat" | "exp">,
  secret: string,
  ttlSeconds = 86_400,
): Promise<{ token: string; expiresAtIso: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: JwtClaims = {
    ...claims,
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
  };
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
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
    if (!claims.sub || !claims.email || (claims.role !== "admin" && claims.role !== "user")) {
      return null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSec) {
      return null;
    }
    return claims;
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

export function maskSecret(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 14) {
    return "****";
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
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
