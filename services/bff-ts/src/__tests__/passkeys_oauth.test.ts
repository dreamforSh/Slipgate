import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createBffApp } from "../app.ts";
import { bufToB64url } from "../security/webauthn.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const ORIGIN = "http://localhost";

type StoreFactory = () => Promise<ControlStore>;

function buildAuthData(params: {
  rpId: string;
  signCount: number;
  credentialIdRaw?: Uint8Array;
  coseKey?: Buffer;
}): Buffer {
  const rpIdHash = createHash("sha256").update(params.rpId, "utf8").digest();
  const hasAttested = Boolean(params.credentialIdRaw && params.coseKey);
  const flags = Buffer.from([hasAttested ? 0x45 : 0x05]); // UP | UV | (AT when attested)
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(params.signCount, 0);
  if (!hasAttested) return Buffer.concat([rpIdHash, flags, counter]);

  const aaguid = Buffer.alloc(16, 0);
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(params.credentialIdRaw!.length, 0);
  return Buffer.concat([rpIdHash, flags, counter, aaguid, idLen, params.credentialIdRaw!, params.coseKey!]);
}

function encodeCborBytes(bytes: Uint8Array): Buffer {
  const len = bytes.length;
  if (len < 24) return Buffer.concat([Buffer.from([0x40 | len]), bytes]);
  if (len < 256) return Buffer.concat([Buffer.from([0x58, len]), bytes]);
  const hdr = Buffer.alloc(3);
  hdr[0] = 0x59;
  hdr.writeUInt16BE(len, 1);
  return Buffer.concat([hdr, bytes]);
}

function encodeCborText(text: string): Buffer {
  const b = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x60 | b.length]), b]);
}

function encodeCborInt(n: number): Buffer {
  if (n >= 0 && n < 24) return Buffer.from([n]);
  const neg = -1 - n;
  return Buffer.from([0x20 | neg]);
}

function encodeCoseEc2Key(x: Uint8Array, y: Uint8Array): Buffer {
  // CBOR map with 5 pairs: 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y
  return Buffer.concat([
    Buffer.from([0xa5]),
    encodeCborInt(1),
    encodeCborInt(2),
    encodeCborInt(3),
    encodeCborInt(-7),
    encodeCborInt(-1),
    encodeCborInt(1),
    encodeCborInt(-2),
    encodeCborBytes(x),
    encodeCborInt(-3),
    encodeCborBytes(y),
  ]);
}

function encodeAttestationObject(authData: Uint8Array): Buffer {
  // CBOR map {"fmt": "none", "authData": bstr}
  return Buffer.concat([
    Buffer.from([0xa2]),
    encodeCborText("fmt"),
    encodeCborText("none"),
    encodeCborText("authData"),
    encodeCborBytes(authData),
  ]);
}

function makeEcPasskey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const rawId = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  const credId = bufToB64url(rawId);
  const coseKey = encodeCoseEc2Key(
    Buffer.from(jwk.x.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    Buffer.from(jwk.y.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  );
  return { spki, rawId, credId, privateKey, coseKey };
}

class JarBrowser {
  private readonly cookies = new Map<string, string>();

  async fetch(app: ReturnType<typeof createBffApp>, url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        "Cookie",
        Array.from(this.cookies.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      );
    }
    const res = await app.request(url, { ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      const [nv] = line.split(";");
      if (!nv) continue;
      const eq = nv.indexOf("=");
      if (eq > 0) this.cookies.set(nv.slice(0, eq).trim(), nv.slice(eq + 1).trim());
    }
    return res;
  }
}

async function setup(options: {
  oauthFetch?: unknown;
  mailOutbox?: { to: string; html: string; subject: string }[];
} = {}) {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const store = factory ? await factory() : new MemoryControlStore();
  if (factory) await store.init();
  const mailOutbox = options.mailOutbox ?? [];
  const app = createBffApp({
    store,
    jwtSecret: "passkeys-oauth-test-jwt-secret-32b",
    vaultSecret: "passkeys-oauth-test-vault-secret-32b",
    internalToken: "passkeys-oauth-internal-token",
    oauthFetch: options.oauthFetch as typeof fetch | undefined,
    mailDelivery: async (_cfg, msg) => {
      mailOutbox.push({ to: msg.to, html: msg.html, subject: msg.subject });
    },
  });

  async function api<T>(method: string, path: string, token?: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? JSON_HEADERS : {}),
        ...(extraHeaders ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body: parsed };
  }

  const init = await api<{ accessToken: string; user: { id: string; email: string } }>("POST", "/api/v1/setup/initialize", undefined, {
    siteName: "Slipgate Test",
    adminEmail: "admin@passkeys.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  return { app, store, adminToken: init.body.accessToken, adminId: init.body.user.id, api, mailOutbox };
}

describe("Lanes A2 + A3: Passkeys, Step-Up and OAuth Extras", () => {
  it("registers, renames, authenticates, enforces signCount & origin, and steps up with WebAuthn passkeys", async () => {
    const t = await setup();
    await t.api("PATCH", "/api/v1/admin/settings", t.adminToken, {
      apiBaseUrl: "https://auth.example.test",
    });

    // Register key #1 via CBOR attestationObject (server ignores spoofed Origin header and uses apiBaseUrl origin).
    const key1 = makeEcPasskey();
    const regOpt1 = await t.api<{ challengeToken: string; options: { challenge: string; rp: { id: string } } }>(
      "POST",
      "/api/v1/user/passkeys/register/options",
      t.adminToken,
      { deviceName: "YubiKey" },
      { Origin: "https://evil-attacker.test" },
    );
    expect(regOpt1.status).toBe(200);
    expect(regOpt1.body.options.rp.id).toBe("auth.example.test");

    // Cross-origin clientData must be rejected even if origin matches.
    const crossClientData = bufToB64url(
      Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: regOpt1.body.options.challenge,
          origin: "https://auth.example.test",
          crossOrigin: true,
        }),
      ),
    );
    const badAtt = encodeAttestationObject(
      buildAuthData({ rpId: "auth.example.test", signCount: 1, credentialIdRaw: key1.rawId, coseKey: key1.coseKey }),
    );
    const crossRes = await t.api("POST", "/api/v1/user/passkeys/register/verify", t.adminToken, {
      challengeToken: regOpt1.body.challengeToken,
      deviceName: "YubiKey",
      credential: {
        id: key1.credId,
        rawId: key1.credId,
        response: {
          clientDataJSON: crossClientData,
          attestationObject: bufToB64url(badAtt),
          publicKeyAlgorithm: -7,
        },
      },
    });
    expect(crossRes.status).toBe(400);

    // Mismatched SPKI vs COSE key inside attestationObject must also be rejected.
    const regOptMismatch = await t.api<{ challengeToken: string; options: { challenge: string } }>(
      "POST",
      "/api/v1/user/passkeys/register/options",
      t.adminToken,
      { deviceName: "YubiKey" },
    );
    const decoyKey = makeEcPasskey();
    const attMismatchRes = await t.api("POST", "/api/v1/user/passkeys/register/verify", t.adminToken, {
      challengeToken: regOptMismatch.body.challengeToken,
      deviceName: "YubiKey",
      credential: {
        id: key1.credId,
        rawId: key1.credId,
        response: {
          clientDataJSON: bufToB64url(
            Buffer.from(
              JSON.stringify({
                type: "webauthn.create",
                challenge: regOptMismatch.body.options.challenge,
                origin: "https://auth.example.test",
              }),
            ),
          ),
          attestationObject: bufToB64url(badAtt),
          publicKeySpki: bufToB64url(decoyKey.spki),
          publicKeyAlgorithm: -7,
        },
      },
    });
    expect(attMismatchRes.status).toBe(400);

    // Now valid registration via CBOR attestationObject.
    const regOpt2 = await t.api<{ challengeToken: string; options: { challenge: string } }>(
      "POST",
      "/api/v1/user/passkeys/register/options",
      t.adminToken,
      { deviceName: "YubiKey" },
    );
    const okAtt = encodeAttestationObject(
      buildAuthData({ rpId: "auth.example.test", signCount: 1, credentialIdRaw: key1.rawId, coseKey: key1.coseKey }),
    );
    const created1 = await t.api<{ item: { id: string; deviceName: string; credentialId: string } }>(
      "POST",
      "/api/v1/user/passkeys/register/verify",
      t.adminToken,
      {
        challengeToken: regOpt2.body.challengeToken,
        deviceName: "YubiKey",
        credential: {
          id: key1.credId,
          rawId: key1.credId,
          response: {
            clientDataJSON: bufToB64url(
              Buffer.from(
                JSON.stringify({
                  type: "webauthn.create",
                  challenge: regOpt2.body.options.challenge,
                  origin: "https://auth.example.test",
                }),
              ),
            ),
            attestationObject: bufToB64url(okAtt),
            publicKeyAlgorithm: -7,
            transports: ["usb"],
          },
        },
      },
    );
    expect(created1.status).toBe(201);
    expect(created1.body.item.deviceName).toBe("YubiKey");

    // Rename passkey.
    const renamed = await t.api<{ item: { deviceName: string } }>(
      "PATCH",
      `/api/v1/user/passkeys/${created1.body.item.id}`,
      t.adminToken,
      { deviceName: "Main Security Key" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.item.deviceName).toBe("Main Security Key");

    // Passwordless passkey login (incrementing signCount -> 2) returns standard AuthSessionResponse.
    const signAssertion = (challenge: string, signCount: number) => {
      const clientBuf = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin: "https://auth.example.test" }),
      );
      const authBuf = buildAuthData({ rpId: "auth.example.test", signCount });
      const digest = createHash("sha256").update(clientBuf).digest();
      const sig = sign("sha256", Buffer.concat([authBuf, digest]), key1.privateKey);
      return {
        id: key1.credId,
        rawId: key1.credId,
        response: {
          clientDataJSON: bufToB64url(clientBuf),
          authenticatorData: bufToB64url(authBuf),
          signature: bufToB64url(sig),
          userHandle: null,
        },
      };
    };

    const loginOpt = await t.api<{ challengeToken: string; options: { challenge: string } }>(
      "POST",
      "/api/v1/auth/passkey/login/options",
      undefined,
      { email: "admin@passkeys.test" },
    );
    expect(loginOpt.status).toBe(200);
    const loginVerify = await t.api<{ accessToken: string; expiresAtIso: string; user: { id: string } }>(
      "POST",
      "/api/v1/auth/passkey/login/verify",
      undefined,
      { challengeToken: loginOpt.body.challengeToken, credential: signAssertion(loginOpt.body.options.challenge, 2) },
    );
    expect(loginVerify.status).toBe(200);
    expect(typeof loginVerify.body.accessToken).toBe("string");
    expect(typeof loginVerify.body.expiresAtIso).toBe("string");
    expect(loginVerify.body.user.id).toBe(t.adminId);

    // Replay with non-increasing signCount (2 <= 2) must fail!
    const replayOpt = await t.api<{ challengeToken: string; options: { challenge: string } }>(
      "POST",
      "/api/v1/auth/passkey/login/options",
      undefined,
      {},
    );
    const replayVerify = await t.api("POST", "/api/v1/auth/passkey/login/verify", undefined, {
      challengeToken: replayOpt.body.challengeToken,
      credential: signAssertion(replayOpt.body.options.challenge, 2),
    });
    expect(replayVerify.status).toBe(401);

    // Step-up token works once on confirmAdmin (creating another admin), rejected on reuse.
    const stepOpt = await t.api<{ challengeToken: string; options: { challenge: string } }>(
      "POST",
      "/api/v1/user/passkeys/step-up/options",
      t.adminToken,
      {},
    );
    expect(stepOpt.status).toBe(200);
    const stepVerify = await t.api<{ ok: boolean; passkeyStepUpToken: string }>(
      "POST",
      "/api/v1/user/passkeys/step-up/verify",
      t.adminToken,
      { challengeToken: stepOpt.body.challengeToken, credential: signAssertion(stepOpt.body.options.challenge, 3) },
    );
    expect(stepVerify.status).toBe(200);
    expect(stepVerify.body.ok).toBe(true);

    const createAdmin = await t.api("POST", "/api/v1/admin/users", t.adminToken, {
      email: "second-admin@passkeys.test",
      password: "SecondPassword123!",
      role: "admin",
      confirm: { passkeyStepUpToken: stepVerify.body.passkeyStepUpToken },
    });
    expect(createAdmin.status).toBe(201);

    const reuseStepUp = await t.api("POST", "/api/v1/admin/users", t.adminToken, {
      email: "third-admin@passkeys.test",
      password: "ThirdPassword123!",
      role: "admin",
      confirm: { passkeyStepUpToken: stepVerify.body.passkeyStepUpToken },
    });
    expect(reuseStepUp.status).toBe(403);

    // Delete passkey.
    const delRes = await t.api("DELETE", `/api/v1/user/passkeys/${created1.body.item.id}`, t.adminToken);
    expect(delRes.status).toBe(200);
    const listAfter = await t.api<{ items: unknown[] }>("GET", "/api/v1/user/passkeys", t.adminToken);
    expect(listAfter.body.items).toEqual([]);
  });

  it("handles WeChat/DingTalk presets, avatar & placeholder email binding, and inviteRequired OAuth continuation", async () => {
    const outbox: { to: string; html: string; subject: string }[] = [];
    const mockFetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.weixin.qq.com/sns/oauth2/access_token")) {
        return Response.json({ access_token: "wx_tok", openid: "wx_open_1" });
      }
      if (url.includes("api.weixin.qq.com/sns/userinfo")) {
        return Response.json({
          unionid: "wx_union_99",
          nickname: "WeChatUser",
          headimgurl: "https://cdn.example.test/wx.png",
        });
      }
      if (url.includes("api.dingtalk.com/v1.0/oauth2/userAccessToken")) {
        return Response.json({ accessToken: "dt_tok" });
      }
      if (url.includes("api.dingtalk.com/v1.0/contact/users/me")) {
        return Response.json({
          unionId: "dt_union_88",
          nick: "DingUser",
          avatarUrl: "https://cdn.example.test/dt.png",
          email: "ding@corp.test",
          email_verified: true,
        });
      }
      return Response.json({ error: "unexpected_url" }, { status: 404 });
    };

    const t = await setup({ oauthFetch: mockFetch as unknown as typeof fetch, mailOutbox: outbox });

    // Enable WeChat + DingTalk.
    expect(
      (
        await t.api("PATCH", "/api/v1/admin/oauth/providers/wechat", t.adminToken, {
          enabled: true,
          clientId: "wx_app_id",
          clientSecret: "wx_secret",
          allowSignup: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.api("PATCH", "/api/v1/admin/oauth/providers/dingtalk", t.adminToken, {
          enabled: true,
          clientId: "dt_app_id",
          clientSecret: "dt_secret",
          allowSignup: true,
        })
      ).status,
    ).toBe(200);

    const pubProviders = await t.api<{ items: { id: string }[] }>("GET", "/api/v1/auth/oauth/providers");
    expect(pubProviders.body.items.map((p) => p.id)).toEqual(["wechat", "dingtalk"]);

    // 1) WeChat signup creates placeholder account with extracted headimgurl avatar, then binds real email.
    const browser1 = new JarBrowser();
    const wxStart = await browser1.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/wechat/start?redirect=/profile`);
    expect(wxStart.status).toBe(302);
    const wxAuthUrl = new URL(wxStart.headers.get("location")!);
    expect(wxAuthUrl.searchParams.get("appid")).toBe("wx_app_id");
    const wxState = wxAuthUrl.searchParams.get("state")!;

    const wxCb = await browser1.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/wechat/callback?code=wxcode&state=${wxState}`);
    expect(wxCb.status).toBe(302);
    const wxLoc = new URL(wxCb.headers.get("location")!);
    expect(wxLoc.pathname).toBe("/oauth/complete");
    const handoffCode = new URLSearchParams(wxLoc.hash.slice(1)).get("code")!;

    const wxComplete = await browser1.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/complete`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ code: handoffCode }),
    });
    const wxSession = (await wxComplete.json()) as { accessToken: string };
    const me1 = await t.api<{ user: { id: string; email: string; username: string; avatarUrl: string } }>(
      "GET",
      "/api/v1/auth/me",
      wxSession.accessToken,
    );
    expect(me1.body.user.email).toMatch(/^wechat-wx_union_99@users\.noreply\.slipgate$/);
    expect(me1.body.user.username).toBe("WeChatUser");
    expect(me1.body.user.avatarUrl).toBe("https://cdn.example.test/wx.png");

    // Update avatarUrl + username via PATCH /api/v1/user/profile
    const profPatch = await t.api<{ user: { username: string; avatarUrl: string } }>(
      "PATCH",
      "/api/v1/user/profile",
      wxSession.accessToken,
      { username: "UpdatedWx", avatarUrl: "https://cdn.example.test/new-avatar.png" },
    );
    expect(profPatch.status).toBe(200);
    expect(profPatch.body.user.avatarUrl).toBe("https://cdn.example.test/new-avatar.png");

    // Configure SMTP + emailVerificationRequired to test verified bind-email!
    expect(
      (
        await t.api("PATCH", "/api/v1/admin/email/config", t.adminToken, {
          enabled: true,
          host: "smtp.example.test",
          port: 587,
          username: "mailer",
          password: "secret",
          fromAddress: "noreply@passkeys.test",
        })
      ).status,
    ).toBe(200);
    await t.api("PATCH", "/api/v1/admin/settings", t.adminToken, { emailVerificationRequired: true });

    // Refuses duplicate email.
    expect(
      (await t.api("POST", "/api/v1/user/profile/bind-email/code", wxSession.accessToken, { email: "admin@passkeys.test" })).status,
    ).toBe(409);

    const sendCode = await t.api("POST", "/api/v1/user/profile/bind-email/code", wxSession.accessToken, {
      email: "realwx@example.test",
    });
    expect(sendCode.status).toBe(200);
    const otpMatch = outbox[0]?.subject.match(/(\d{6})/);
    expect(otpMatch?.[1]).toBeDefined();

    // Missing/bad code rejected while verification is on.
    expect(
      (
        await t.api("POST", "/api/v1/user/profile/bind-email", wxSession.accessToken, {
          email: "realwx@example.test",
          emailCode: "000000",
        })
      ).status,
    ).toBe(400);

    const bound = await t.api<{ user: { email: string; emailVerified: boolean } }>(
      "POST",
      "/api/v1/user/profile/bind-email",
      wxSession.accessToken,
      { email: "realwx@example.test", emailCode: otpMatch![1] },
    );
    expect(bound.status).toBe(200);
    expect(bound.body.user.email).toBe("realwx@example.test");
    expect(bound.body.user.emailVerified).toBe(true);

    // Non-placeholder user can no longer use placeholder bind-email endpoint.
    expect(
      (await t.api("POST", "/api/v1/user/profile/bind-email", wxSession.accessToken, { email: "another@example.test" })).status,
    ).toBe(409);

    // 2) Invite-required OAuth continuation flow with DingTalk!
    await t.api("PATCH", "/api/v1/admin/settings", t.adminToken, {
      inviteRequired: true,
      emailVerificationRequired: false,
    });
    const invGen = await t.api<{ items: { code: string }[] }>("POST", "/api/v1/admin/redeem-codes/generate", t.adminToken, {
      kind: "invitation",
      count: 1,
    });
    const inviteCode = invGen.body.items[0]!.code;

    const browser2 = new JarBrowser();
    const dtStart = await browser2.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/dingtalk/start?redirect=/keys`);
    const dtState = new URL(dtStart.headers.get("location")!).searchParams.get("state")!;
    const dtCb = await browser2.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/dingtalk/callback?code=dtcode&state=${dtState}`);
    expect(dtCb.status).toBe(302);
    const dtLoc = new URL(dtCb.headers.get("location")!);
    expect(dtLoc.pathname).toBe("/oauth/complete");
    const continueToken = new URLSearchParams(dtLoc.hash.slice(1)).get("continue")!;
    expect(continueToken.length).toBeGreaterThan(20);

    // Foreign browser without binding cookie is refused without consuming token!
    const stranger = new JarBrowser();
    const foreignGet = await stranger.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/pending/${continueToken}`);
    expect(foreignGet.status).toBe(403);

    // Bound browser inspects pending summary.
    const pendingRes = await browser2.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/pending/${continueToken}`);
    expect(pendingRes.status).toBe(200);
    const summary = (await pendingRes.json()) as { provider: string; suggestedUsername: string; inviteRequired: boolean };
    expect(summary.provider).toBe("dingtalk");
    expect(summary.suggestedUsername).toBe("DingUser");
    expect(summary.inviteRequired).toBe(true);

    // Invalid invite code rejected without consuming token.
    const badInv = await browser2.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/continue`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: continueToken, inviteCode: "INVALID-CODE" }),
    });
    expect(badInv.status).toBe(400);

    // Valid invite code finishes signup, creates user, links DingTalk, returns token & redirect!
    const okCont = await browser2.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/continue`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: continueToken, username: "DingFinished", inviteCode }),
    });
    expect(okCont.status).toBe(200);
    const okJson = (await okCont.json()) as { accessToken: string; redirect: string };
    expect(okJson.redirect).toBe("/keys");
    const me2 = await t.api<{ user: { email: string; username: string; avatarUrl: string; emailVerified: boolean } }>(
      "GET",
      "/api/v1/auth/me",
      okJson.accessToken,
    );
    expect(me2.body.user.email).toBe("ding@corp.test");
    expect(me2.body.user.username).toBe("DingFinished");
    expect(me2.body.user.avatarUrl).toBe("https://cdn.example.test/dt.png");
    expect(me2.body.user.emailVerified).toBe(true);

    // Reusing continuation token fails.
    const replayCont = await browser2.fetch(t.app, `${ORIGIN}/api/v1/auth/oauth/continue`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: continueToken, inviteCode }),
    });
    expect(replayCont.status).toBe(400);
  });
});
