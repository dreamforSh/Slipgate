import { createHash, createHmac } from "node:crypto";
import type { CaptchaProof } from "@slipgate/contracts";
import { parseIp } from "./client_ip.ts";

/**
 * Server-side captcha verification against the three supported providers:
 *  - Cloudflare Turnstile: POST siteverify (form) with the site's secret key.
 *  - Tencent Captcha: DescribeCaptchaResult (captcha 2019-07-22), a Tencent Cloud API 3.0 call
 *    signed with TC3-HMAC-SHA256 using the cloud SecretId / SecretKey.
 *  - Aliyun Captcha 2.0: VerifyIntelligentCaptcha (captcha 2023-03-05), an RPC-style OpenAPI call
 *    signed with ACS3-HMAC-SHA256 using the AccessKey pair.
 *
 * Every call goes through the injected `fetch` (tests stub it; nothing here talks to the network
 * on its own) with a 10 s timeout. Outcomes are fail-closed: anything but an explicit "passed"
 * from the provider is a failure, split into `rejected` (the answer is wrong: solve again) and
 * `unavailable` (the provider could not be asked or refused our credentials).
 */

export type CaptchaFetch = typeof fetch;

export type CaptchaOutcome =
  | { ok: true }
  | { ok: false; kind: "rejected" | "unavailable"; detail: string };

/** A credential check (admin save / test): `bad_credentials` when the provider refused the keys. */
export type CredentialOutcome = { ok: true; detail: string } | { ok: false; kind: "bad_credentials" | "unavailable"; detail: string };

export interface TurnstileCredentials {
  secretKey: string;
}

export interface TencentCredentials {
  appId: string;
  appSecretKey: string;
  secretId: string;
  secretKey: string;
  region: "cn" | "intl";
}

export interface AliyunCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  sceneId: string;
  region: "cn" | "sgp";
}

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 10_000;
/** Placeholder answers for credential checks: well formed, never valid. */
const PROBE_TOKEN = "slipgate-credential-check";

export function tencentCaptchaHost(region: "cn" | "intl"): string {
  return region === "intl" ? "captcha.intl.tencentcloudapi.com" : "captcha.tencentcloudapi.com";
}

export function aliyunCaptchaHost(region: "cn" | "sgp"): string {
  return region === "sgp" ? "captcha.ap-southeast-1.aliyuncs.com" : "captcha.cn-shanghai.aliyuncs.com";
}

const sha256Hex = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** The client address providers get as a risk signal: a real IP only, never a rate-limit bucket. */
function providerIp(ip: string | undefined): string {
  const parsed = parseIp(ip ?? "");
  return parsed ? parsed.text : "";
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------------------------------------------------------------------------------------- */
/* Cloudflare Turnstile                                                                      */
/* ---------------------------------------------------------------------------------------- */

interface TurnstileReply {
  success?: unknown;
  "error-codes"?: unknown;
}

async function turnstileCall(doFetch: CaptchaFetch, creds: TurnstileCredentials, token: string, ip: string): Promise<{ reply: TurnstileReply } | { error: string }> {
  const form = new URLSearchParams({ secret: creds.secretKey, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const res = await doFetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const reply = await readJson(res);
    if (!res.ok || !reply || typeof reply !== "object") return { error: `siteverify answered HTTP ${res.status}` };
    return { reply: reply as TurnstileReply };
  } catch (err) {
    return { error: `siteverify unreachable: ${errorText(err)}` };
  }
}

function turnstileCodes(reply: TurnstileReply): string[] {
  return Array.isArray(reply["error-codes"]) ? reply["error-codes"].filter((c): c is string => typeof c === "string") : [];
}

const TURNSTILE_SECRET_ERRORS = new Set(["missing-input-secret", "invalid-input-secret"]);

export async function verifyTurnstile(doFetch: CaptchaFetch, creds: TurnstileCredentials, token: string, ip?: string): Promise<CaptchaOutcome> {
  if (!token) return { ok: false, kind: "rejected", detail: "empty token" };
  const result = await turnstileCall(doFetch, creds, token, providerIp(ip));
  if ("error" in result) return { ok: false, kind: "unavailable", detail: result.error };
  if (result.reply.success === true) return { ok: true };
  const codes = turnstileCodes(result.reply);
  if (codes.some((c) => TURNSTILE_SECRET_ERRORS.has(c) || c === "internal-error")) {
    return { ok: false, kind: "unavailable", detail: codes.join(", ") };
  }
  return { ok: false, kind: "rejected", detail: codes.join(", ") || "not passed" };
}

export async function checkTurnstileCredentials(doFetch: CaptchaFetch, creds: TurnstileCredentials): Promise<CredentialOutcome> {
  const result = await turnstileCall(doFetch, creds, PROBE_TOKEN, "");
  if ("error" in result) return { ok: false, kind: "unavailable", detail: result.error };
  const codes = turnstileCodes(result.reply);
  if (codes.some((c) => TURNSTILE_SECRET_ERRORS.has(c))) return { ok: false, kind: "bad_credentials", detail: codes.join(", ") };
  // invalid-input-response (or a test key's success): the secret itself was accepted.
  return { ok: true, detail: codes.join(", ") || "accepted" };
}

/* ---------------------------------------------------------------------------------------- */
/* Tencent Captcha (DescribeCaptchaResult, TC3-HMAC-SHA256)                                  */
/* ---------------------------------------------------------------------------------------- */

const TENCENT_SERVICE = "captcha";
const TENCENT_ACTION = "DescribeCaptchaResult";
const TENCENT_VERSION = "2019-07-22";

/** Headers of a signed Tencent Cloud API 3.0 POST (exported for the signature test). */
export function tencentSignedHeaders(
  creds: Pick<TencentCredentials, "secretId" | "secretKey" | "region">,
  body: string,
  timestampSec: number,
): Record<string, string> {
  const host = tencentCaptchaHost(creds.region);
  const contentType = "application/json; charset=utf-8";
  const date = new Date(timestampSec * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${TENCENT_ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256Hex(body)].join("\n");
  const scope = `${date}/${TENCENT_SERVICE}/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", String(timestampSec), scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(`TC3${creds.secretKey}`, date), TENCENT_SERVICE), "tc3_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${creds.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "Content-Type": contentType,
    Host: host,
    "X-TC-Action": TENCENT_ACTION,
    "X-TC-Timestamp": String(timestampSec),
    "X-TC-Version": TENCENT_VERSION,
  };
}

interface TencentReply {
  Response?: { CaptchaCode?: unknown; CaptchaMsg?: unknown; Error?: { Code?: unknown; Message?: unknown }; RequestId?: unknown };
}

async function tencentCall(
  doFetch: CaptchaFetch,
  creds: TencentCredentials,
  ticket: string,
  randstr: string,
  ip: string,
): Promise<{ code: number; message: string } | { apiError: string } | { error: string }> {
  const appId = Number(creds.appId);
  const payload: Record<string, unknown> = {
    CaptchaType: 9,
    Ticket: ticket,
    Randstr: randstr,
    CaptchaAppId: appId,
    AppSecretKey: creds.appSecretKey,
  };
  // UserIp is required by the API; an unknown peer sends a neutral placeholder.
  payload.UserIp = ip || "127.0.0.1";
  const body = JSON.stringify(payload);
  // Host is signed; the request carries it from the URL (the same value), not as a set header.
  const { Host: _host, ...headers } = tencentSignedHeaders(creds, body, Math.floor(Date.now() / 1000));
  try {
    const res = await doFetch(`https://${tencentCaptchaHost(creds.region)}/`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const reply = (await readJson(res)) as TencentReply | null;
    const response = reply?.Response;
    if (!response || typeof response !== "object") return { error: `DescribeCaptchaResult answered HTTP ${res.status}` };
    if (response.Error) return { apiError: `${String(response.Error.Code ?? "Error")}: ${String(response.Error.Message ?? "")}`.trim() };
    if (typeof response.CaptchaCode !== "number") return { error: "DescribeCaptchaResult returned no CaptchaCode" };
    return { code: response.CaptchaCode, message: String(response.CaptchaMsg ?? "") };
  } catch (err) {
    return { error: `DescribeCaptchaResult unreachable: ${errorText(err)}` };
  }
}

export async function verifyTencent(
  doFetch: CaptchaFetch,
  creds: TencentCredentials,
  ticket: string,
  randstr: string,
  ip?: string,
): Promise<CaptchaOutcome> {
  // "trerror_" tickets are what the widget hands out when its own script failed: never a pass.
  if (!ticket || !randstr || ticket.startsWith("trerror_")) return { ok: false, kind: "rejected", detail: "missing or fallback ticket" };
  const result = await tencentCall(doFetch, creds, ticket, randstr, providerIp(ip));
  if ("error" in result) return { ok: false, kind: "unavailable", detail: result.error };
  if ("apiError" in result) return { ok: false, kind: "unavailable", detail: result.apiError };
  if (result.code === 1) return { ok: true };
  return { ok: false, kind: "rejected", detail: `CaptchaCode ${result.code} ${result.message}`.trim() };
}

export async function checkTencentCredentials(doFetch: CaptchaFetch, creds: TencentCredentials): Promise<CredentialOutcome> {
  const result = await tencentCall(doFetch, creds, PROBE_TOKEN, "probe", "");
  if ("error" in result) return { ok: false, kind: "unavailable", detail: result.error };
  // AuthFailure.* (SecretId / SecretKey) and InvalidParameter* (CaptchaAppId) come back as errors.
  if ("apiError" in result) return { ok: false, kind: "bad_credentials", detail: result.apiError };
  // A CaptchaCode for the placeholder ticket: the signed call (cloud key pair) was accepted.
  return { ok: true, detail: `CaptchaCode ${result.code} ${result.message}`.trim() };
}

/* ---------------------------------------------------------------------------------------- */
/* Aliyun Captcha 2.0 (VerifyIntelligentCaptcha, ACS3-HMAC-SHA256)                           */
/* ---------------------------------------------------------------------------------------- */

const ALIYUN_ACTION = "VerifyIntelligentCaptcha";
const ALIYUN_VERSION = "2023-03-05";
/** Errors that mean the AccessKey pair itself is unusable (anything else: the call was signed fine). */
const ALIYUN_CREDENTIAL_ERRORS = new Set([
  "InvalidAccessKeyId.NotFound",
  "InvalidAccessKeyId.Inactive",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
  "Forbidden.AccessKeyDisabled",
  "InvalidSecurityToken.Expired",
  "Forbidden.RAM",
  "NoPermission",
]);

/** RFC 3986 percent-encoding (what Aliyun's form decoder and signature expect). */
function percentEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Headers of a signed Aliyun OpenAPI V3 POST with a form body (exported for the signature test). */
export function aliyunSignedHeaders(
  creds: Pick<AliyunCredentials, "accessKeyId" | "accessKeySecret" | "region">,
  body: string,
  isoDate: string,
  nonce: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host: aliyunCaptchaHost(creds.region),
    "x-acs-action": ALIYUN_ACTION,
    "x-acs-content-sha256": sha256Hex(body),
    "x-acs-date": isoDate,
    "x-acs-signature-nonce": nonce,
    "x-acs-version": ALIYUN_VERSION,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, headers["x-acs-content-sha256"]].join("\n");
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = createHmac("sha256", creds.accessKeySecret).update(stringToSign, "utf8").digest("hex");
  return {
    ...headers,
    authorization: `ACS3-HMAC-SHA256 Credential=${creds.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

interface AliyunReply {
  Code?: unknown;
  Message?: unknown;
  Result?: { VerifyResult?: unknown; VerifyCode?: unknown };
}

async function aliyunCall(
  doFetch: CaptchaFetch,
  creds: AliyunCredentials,
  verifyParam: string,
): Promise<{ passed: boolean; code: string } | { apiError: string; code: string } | { error: string }> {
  const body = `CaptchaVerifyParam=${percentEncode(verifyParam)}&SceneId=${percentEncode(creds.sceneId)}`;
  const isoDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const { host: _host, ...headers } = aliyunSignedHeaders(creds, body, isoDate, crypto.randomUUID());
  try {
    const res = await doFetch(`https://${aliyunCaptchaHost(creds.region)}/`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const reply = (await readJson(res)) as AliyunReply | null;
    if (!reply || typeof reply !== "object") return { error: `VerifyIntelligentCaptcha answered HTTP ${res.status}` };
    const result = reply.Result;
    if (res.ok && result && typeof result === "object") {
      return { passed: result.VerifyResult === true, code: String(result.VerifyCode ?? "") };
    }
    const code = String(reply.Code ?? `HTTP ${res.status}`);
    return { apiError: `${code}: ${String(reply.Message ?? "")}`.trim(), code };
  } catch (err) {
    return { error: `VerifyIntelligentCaptcha unreachable: ${errorText(err)}` };
  }
}

export async function verifyAliyun(doFetch: CaptchaFetch, creds: AliyunCredentials, verifyParam: string): Promise<CaptchaOutcome> {
  if (!verifyParam) return { ok: false, kind: "rejected", detail: "empty captchaVerifyParam" };
  const result = await aliyunCall(doFetch, creds, verifyParam);
  if ("error" in result) return { ok: false, kind: "unavailable", detail: result.error };
  if ("apiError" in result) return { ok: false, kind: "unavailable", detail: result.apiError };
  return result.passed ? { ok: true } : { ok: false, kind: "rejected", detail: `VerifyCode ${result.code}`.trim() };
}

export async function checkAliyunCredentials(doFetch: CaptchaFetch, creds: AliyunCredentials): Promise<CredentialOutcome> {
  const result = await aliyunCall(doFetch, creds, PROBE_TOKEN);
  if ("error" in result) return { ok: false, kind: "unavailable", detail: result.error };
  if ("apiError" in result) {
    if (ALIYUN_CREDENTIAL_ERRORS.has(result.code)) return { ok: false, kind: "bad_credentials", detail: result.apiError };
    // Signed and authorised, just not a valid answer (or a scene-level complaint): keys are fine.
    return { ok: true, detail: result.apiError };
  }
  return { ok: true, detail: `VerifyCode ${result.code}`.trim() };
}

/* ---------------------------------------------------------------------------------------- */

/** The secrets and public parameters one provider needs, as resolved from the saved config. */
export type ResolvedCaptcha =
  | { provider: "turnstile"; creds: TurnstileCredentials }
  | { provider: "tencent"; creds: TencentCredentials }
  | { provider: "aliyun"; creds: AliyunCredentials };

/** Verifies a widget answer with the configured provider. */
export function verifyCaptchaProof(doFetch: CaptchaFetch, resolved: ResolvedCaptcha, proof: CaptchaProof, ip?: string): Promise<CaptchaOutcome> {
  switch (resolved.provider) {
    case "turnstile":
      return verifyTurnstile(doFetch, resolved.creds, proof.turnstileToken ?? "", ip);
    case "tencent":
      return verifyTencent(doFetch, resolved.creds, proof.tencentTicket ?? "", proof.tencentRandstr ?? "", ip);
    case "aliyun":
      return verifyAliyun(doFetch, resolved.creds, proof.aliyunVerifyParam ?? "");
  }
}

export function checkCaptchaCredentials(doFetch: CaptchaFetch, resolved: ResolvedCaptcha): Promise<CredentialOutcome> {
  switch (resolved.provider) {
    case "turnstile":
      return checkTurnstileCredentials(doFetch, resolved.creds);
    case "tencent":
      return checkTencentCredentials(doFetch, resolved.creds);
    case "aliyun":
      return checkAliyunCredentials(doFetch, resolved.creds);
  }
}

/** True when the proof carries an answer for `provider` (a pass is checked separately). */
export function proofHasAnswer(provider: ResolvedCaptcha["provider"], proof: CaptchaProof | undefined): boolean {
  if (!proof) return false;
  switch (provider) {
    case "turnstile":
      return Boolean(proof.turnstileToken);
    case "tencent":
      return Boolean(proof.tencentTicket);
    case "aliyun":
      return Boolean(proof.aliyunVerifyParam);
  }
}
