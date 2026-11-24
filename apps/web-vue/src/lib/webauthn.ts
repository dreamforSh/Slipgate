import type {
  PasskeyAssertionCredential,
  PasskeyRegisterVerifyRequest,
} from "@slipgate/contracts";

function bufToB64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToUint8(b64url: string): Uint8Array<ArrayBuffer> {
  const norm = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (norm.length % 4)) % 4;
  const bin = atob(norm + "=".repeat(pad));
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) {
    view[i] = bin.charCodeAt(i);
  }
  return view;
}

export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.credentials)
  );
}

export interface ServerCreationOptions {
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  excludeCredentials?: { id: string; type: "public-key"; transports?: AuthenticatorTransport[] }[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
}

export interface ServerRequestOptions {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: { id: string; type: "public-key"; transports?: AuthenticatorTransport[] }[];
}

export async function createPasskeyCredential(
  serverOptions: ServerCreationOptions,
  deviceName: string,
  challengeToken: string,
): Promise<PasskeyRegisterVerifyRequest> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: b64urlToUint8(serverOptions.challenge),
    rp: serverOptions.rp,
    user: {
      id: b64urlToUint8(serverOptions.user.id),
      name: serverOptions.user.name,
      displayName: serverOptions.user.displayName,
    },
    pubKeyCredParams: serverOptions.pubKeyCredParams,
    timeout: serverOptions.timeout ?? 60_000,
    attestation: serverOptions.attestation ?? "none",
    authenticatorSelection: serverOptions.authenticatorSelection,
    excludeCredentials: (serverOptions.excludeCredentials ?? []).map((c) => ({
      id: b64urlToUint8(c.id),
      type: "public-key",
      transports: c.transports,
    })),
  };

  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey registration was cancelled");
  const resp = cred.response as AuthenticatorAttestationResponse;

  const publicKeySpkiBuf = typeof resp.getPublicKey === "function" ? resp.getPublicKey() : null;
  const authDataBuf = typeof resp.getAuthenticatorData === "function" ? resp.getAuthenticatorData() : null;
  const transports = typeof resp.getTransports === "function" ? resp.getTransports() : [];
  const alg = typeof resp.getPublicKeyAlgorithm === "function" ? resp.getPublicKeyAlgorithm() : -7;

  return {
    challengeToken,
    deviceName,
    credential: {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      response: {
        clientDataJSON: bufToB64url(resp.clientDataJSON),
        ...(authDataBuf ? { authenticatorData: bufToB64url(authDataBuf) } : {}),
        ...(publicKeySpkiBuf ? { publicKeySpki: bufToB64url(publicKeySpkiBuf) } : {}),
        ...(resp.attestationObject ? { attestationObject: bufToB64url(resp.attestationObject) } : {}),
        publicKeyAlgorithm: alg,
        transports,
      },
    },
  };
}

export async function getPasskeyAssertion(serverOptions: ServerRequestOptions): Promise<PasskeyAssertionCredential> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: b64urlToUint8(serverOptions.challenge),
    rpId: serverOptions.rpId,
    timeout: serverOptions.timeout ?? 60_000,
    userVerification: serverOptions.userVerification ?? "preferred",
    allowCredentials: (serverOptions.allowCredentials ?? []).map((c) => ({
      id: b64urlToUint8(c.id),
      type: "public-key",
      transports: c.transports,
    })),
  };

  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey verification was cancelled");
  const resp = cred.response as AuthenticatorAssertionResponse;

  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    response: {
      clientDataJSON: bufToB64url(resp.clientDataJSON),
      authenticatorData: bufToB64url(resp.authenticatorData),
      signature: bufToB64url(resp.signature),
      userHandle: resp.userHandle ? bufToB64url(resp.userHandle) : null,
    },
  };
}
