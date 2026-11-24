import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { PasskeyAssertionCredential } from "@slipgate/contracts";

export function b64urlToBuf(input: string): Buffer {
  const norm = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (norm.length % 4)) % 4;
  return Buffer.from(norm + "=".repeat(pad), "base64");
}

export function bufToB64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function constTimeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const MAX_CBOR_DEPTH = 8;
const MAX_CBOR_ITEMS = 64;

/** Minimal bounded CBOR decoder for WebAuthn attestationObject / COSE keys. */
function decodeCbor(buf: Uint8Array): { value: unknown; next: number } {
  let offset = 0;

  function assertAvailable(need: number): void {
    if (!Number.isInteger(need) || need < 0 || offset + need > buf.length) {
      throw new Error("Truncated CBOR input");
    }
  }

  function readUint(lenInfo: number): number {
    if (lenInfo < 24) return lenInfo;
    if (lenInfo === 24) {
      assertAvailable(1);
      const v = buf[offset]!;
      offset += 1;
      return v;
    }
    if (lenInfo === 25) {
      assertAvailable(2);
      const v = (buf[offset]! << 8) | buf[offset + 1]!;
      offset += 2;
      return v;
    }
    if (lenInfo === 26) {
      assertAvailable(4);
      const v =
        ((buf[offset]! << 24) >>> 0) +
        (buf[offset + 1]! << 16) +
        (buf[offset + 2]! << 8) +
        buf[offset + 3]!;
      offset += 4;
      return v;
    }
    throw new Error("Unsupported CBOR integer width");
  }

  function nextVal(depth: number): unknown {
    if (depth > MAX_CBOR_DEPTH) throw new Error("CBOR nesting limit exceeded");
    assertAvailable(1);
    const hdr = buf[offset++]!;
    const major = hdr >> 5;
    const info = hdr & 0x1f;
    switch (major) {
      case 0:
        return readUint(info);
      case 1:
        return -1 - readUint(info);
      case 2: {
        const n = readUint(info);
        assertAvailable(n);
        const slice = Buffer.from(buf.subarray(offset, offset + n));
        offset += n;
        return slice;
      }
      case 3: {
        const n = readUint(info);
        assertAvailable(n);
        const s = Buffer.from(buf.subarray(offset, offset + n)).toString("utf8");
        offset += n;
        return s;
      }
      case 4: {
        const n = readUint(info);
        if (n > MAX_CBOR_ITEMS) throw new Error("CBOR array size limit exceeded");
        const arr: unknown[] = [];
        for (let i = 0; i < n; i++) arr.push(nextVal(depth + 1));
        return arr;
      }
      case 5: {
        const n = readUint(info);
        if (n > MAX_CBOR_ITEMS) throw new Error("CBOR map size limit exceeded");
        const out = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) {
          const k = nextVal(depth + 1);
          out.set(k, nextVal(depth + 1));
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        return undefined;
      default:
        throw new Error(`Unsupported CBOR major type ${major}`);
    }
  }

  return { value: nextVal(0), next: offset };
}

function coseMapToSpki(coseRaw: Uint8Array): { spki: Buffer; alg: number } {
  const { value } = decodeCbor(coseRaw);
  if (!(value instanceof Map)) throw new Error("Invalid COSE key");
  const kty = value.get(1);
  const alg = Number(value.get(3) ?? -7);
  if (kty === 2) {
    // EC2 (crv = 1 -> P-256)
    const crv = value.get(-1);
    const x = value.get(-2);
    const y = value.get(-3);
    if (crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      throw new Error("Unsupported EC2 COSE key");
    }
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: bufToB64url(x), y: bufToB64url(y) },
      format: "jwk",
    });
    return { spki: key.export({ type: "spki", format: "der" }) as Buffer, alg };
  }
  if (kty === 3) {
    // RSA
    const n = value.get(-1);
    const e = value.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
      throw new Error("Unsupported RSA COSE key");
    }
    const key = createPublicKey({
      key: { kty: "RSA", n: bufToB64url(n), e: bufToB64url(e) },
      format: "jwk",
    });
    return { spki: key.export({ type: "spki", format: "der" }) as Buffer, alg };
  }
  throw new Error(`Unsupported COSE key type: ${String(kty)}`);
}

export interface ParsedAuthData {
  rpIdHash: Buffer;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  backedUp: boolean;
  attestedDataIncluded: boolean;
  signCount: number;
  credentialId?: string;
  coseSpki?: Buffer;
  coseAlg?: number;
}

export function parseAuthData(authData: Uint8Array, parseAttested = false): ParsedAuthData {
  if (authData.length < 37) throw new Error("authenticatorData too short");
  const buf = Buffer.from(authData);
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32]!;
  const signCount = buf.readUInt32BE(33);
  const out: ParsedAuthData = {
    rpIdHash,
    flags,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    backedUp: (flags & 0x10) !== 0,
    attestedDataIncluded: (flags & 0x40) !== 0,
    signCount,
  };
  if (parseAttested && out.attestedDataIncluded && buf.length > 55) {
    const credIdLen = buf.readUInt16BE(53);
    const credStart = 55;
    const credEnd = credStart + credIdLen;
    if (credEnd < buf.length) {
      out.credentialId = bufToB64url(buf.subarray(credStart, credEnd));
      const { spki, alg } = coseMapToSpki(buf.subarray(credEnd));
      out.coseSpki = spki;
      out.coseAlg = alg;
    }
  }
  return out;
}

export function verifyClientData(
  clientDataB64: string,
  expectedType: "webauthn.create" | "webauthn.get",
  expectedChallenge: string,
  expectedOrigin: string,
): Buffer {
  const clientBuf = b64urlToBuf(clientDataB64);
  let parsed: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    parsed = JSON.parse(clientBuf.toString("utf8")) as {
      type?: unknown;
      challenge?: unknown;
      origin?: unknown;
      crossOrigin?: unknown;
    };
  } catch {
    throw new Error("Invalid clientDataJSON");
  }
  if (parsed.crossOrigin === true) {
    throw new Error("Cross-origin WebAuthn ceremonies are not allowed");
  }
  if (parsed.type !== expectedType) {
    throw new Error(`Unexpected WebAuthn ceremony type`);
  }
  if (typeof parsed.challenge !== "string" || !constTimeEqualStr(parsed.challenge, expectedChallenge)) {
    throw new Error("WebAuthn challenge mismatch");
  }
  if (typeof parsed.origin !== "string" || !constTimeEqualStr(parsed.origin, expectedOrigin)) {
    throw new Error(`WebAuthn origin mismatch (got ${String(parsed.origin)}, expected ${expectedOrigin})`);
  }
  return clientBuf;
}

export function verifyRpIdHash(rpIdHash: Uint8Array, expectedRpId: string): void {
  const want = sha256(Buffer.from(expectedRpId, "utf8"));
  if (rpIdHash.length !== want.length || !timingSafeEqual(rpIdHash, want)) {
    throw new Error("WebAuthn rpIdHash mismatch");
  }
}

export function extractAttestationCredential(input: {
  credentialId: string;
  authenticatorDataB64?: string;
  publicKeySpkiB64?: string;
  attestationObjectB64?: string;
  publicKeyAlgorithm: number;
  expectedRpId: string;
}): {
  credentialId: string;
  publicKeySpki: Uint8Array;
  algorithm: number;
  signCount: number;
  backedUp: boolean;
} {
  let authDataBuf: Buffer | null = input.authenticatorDataB64 ? b64urlToBuf(input.authenticatorDataB64) : null;
  let attParsed: ParsedAuthData | null = null;

  if (input.attestationObjectB64) {
    const attBuf = b64urlToBuf(input.attestationObjectB64);
    const decoded = decodeCbor(attBuf).value;
    if (!(decoded instanceof Map)) throw new Error("Invalid attestationObject");
    const rawAuth = decoded.get("authData");
    if (!(rawAuth instanceof Uint8Array)) throw new Error("Missing authData in attestationObject");
    if (!authDataBuf) authDataBuf = Buffer.from(rawAuth);
    attParsed = parseAuthData(authDataBuf, true);
  } else if (authDataBuf) {
    attParsed = parseAuthData(authDataBuf, true);
  }

  if (!authDataBuf || !attParsed) {
    throw new Error("Missing authenticatorData or attestationObject");
  }
  verifyRpIdHash(attParsed.rpIdHash, input.expectedRpId);
  if (!attParsed.userPresent) {
    throw new Error("User presence flag not set");
  }
  if (attParsed.credentialId && !constTimeEqualStr(attParsed.credentialId, input.credentialId)) {
    throw new Error("WebAuthn credentialId mismatch against attested credential data");
  }

  let spkiBuf: Buffer | null = null;
  let algorithm = input.publicKeyAlgorithm;
  if (input.publicKeySpkiB64) {
    spkiBuf = b64urlToBuf(input.publicKeySpkiB64);
    if (attParsed.coseSpki) {
      if (spkiBuf.length !== attParsed.coseSpki.length || !timingSafeEqual(spkiBuf, attParsed.coseSpki)) {
        throw new Error("WebAuthn publicKeySpki does not match attested COSE key");
      }
      if (attParsed.coseAlg !== undefined) algorithm = attParsed.coseAlg;
    }
  } else if (attParsed.coseSpki) {
    spkiBuf = attParsed.coseSpki;
    if (attParsed.coseAlg !== undefined) algorithm = attParsed.coseAlg;
  }
  if (!spkiBuf || spkiBuf.length < 32) {
    throw new Error("Missing publicKeySpki");
  }

  // Validate SPKI DER structure & algorithm compatibility.
  const keyObj = createPublicKey({ key: spkiBuf, format: "der", type: "spki" });
  if (algorithm === -7 && keyObj.asymmetricKeyType !== "ec") {
    throw new Error("Algorithm -7 requires an EC public key");
  }
  if (algorithm === -257 && keyObj.asymmetricKeyType !== "rsa") {
    throw new Error("Algorithm -257 requires an RSA public key");
  }
  if (algorithm !== -7 && algorithm !== -257) {
    throw new Error(`Unsupported WebAuthn public key algorithm: ${algorithm}`);
  }

  return {
    credentialId: attParsed.credentialId ?? input.credentialId,
    publicKeySpki: new Uint8Array(spkiBuf),
    algorithm,
    signCount: attParsed.signCount,
    backedUp: attParsed.backedUp,
  };
}

export function verifyAssertionSignature(params: {
  credential: PasskeyAssertionCredential;
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRpId: string;
  storedPublicKeySpki: Uint8Array;
  storedSignCount: number;
}): { newSignCount: number; backedUp: boolean } {
  const clientBuf = verifyClientData(
    params.credential.response.clientDataJSON,
    "webauthn.get",
    params.expectedChallenge,
    params.expectedOrigin,
  );
  const authDataBuf = b64urlToBuf(params.credential.response.authenticatorData);
  const parsedAuth = parseAuthData(authDataBuf, false);
  verifyRpIdHash(parsedAuth.rpIdHash, params.expectedRpId);
  if (!parsedAuth.userPresent) {
    throw new Error("User presence flag not set");
  }
  if (params.storedSignCount > 0 || parsedAuth.signCount > 0) {
    if (parsedAuth.signCount <= params.storedSignCount) {
      throw new Error("Authenticator signCount regression detected");
    }
  }

  const keyObj = createPublicKey({
    key: Buffer.from(params.storedPublicKeySpki),
    format: "der",
    type: "spki",
  });
  const sigBuf = b64urlToBuf(params.credential.response.signature);
  const signedData = Buffer.concat([authDataBuf, sha256(clientBuf)]);
  if (!verify("sha256", signedData, keyObj, sigBuf)) {
    throw new Error("Invalid WebAuthn assertion signature");
  }
  return {
    newSignCount: parsedAuth.signCount,
    backedUp: parsedAuth.backedUp,
  };
}
