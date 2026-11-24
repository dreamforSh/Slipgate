import type { Context, Hono } from "hono";
import {
  AuthSessionResponseSchema,
  configuredPublicBaseUrl,
  PasskeyLoginOptionsRequestSchema,
  PasskeyLoginVerifyRequestSchema,
  PasskeyRegisterOptionsRequestSchema,
  PasskeyRegisterVerifyRequestSchema,
  PasskeyStepUpVerifyRequestSchema,
  RenamePasskeyRequestSchema,
} from "@slipgate/contracts";
import type { z } from "zod";
import type { AuthGuards } from "../auth_guards.ts";
import type { AuthEnv, SessionManager } from "../middleware/auth.ts";
import { WindowLimiter } from "../insights.ts";
import { clientIp, safeRequestOrigin } from "../security/client_ip.ts";
import {
  bufToB64url,
  extractAttestationCredential,
  verifyAssertionSignature,
  verifyClientData,
} from "../security/webauthn.ts";
import { FlowStateMap } from "./oauth.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

type App = Hono<AuthEnv>;

interface ChallengeEntry {
  challenge: string;
  purpose: "register" | "login" | "step_up";
  userId?: string;
  origin: string;
  rpId: string;
  expiresAt: number;
}

interface StepUpGrant {
  userId: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const STEP_UP_TOKEN_TTL_MS = 5 * 60_000;

function issuesMessage(issues: z.ZodIssue[]): string {
  return (
    issues
      .slice(0, 3)
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ") || "Invalid request"
  );
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
}

export class PasskeyStepUpRegistry {
  private readonly grants = new FlowStateMap<StepUpGrant>(2000);

  issue(userId: string): string {
    const token = bufToB64url(crypto.getRandomValues(new Uint8Array(32)));
    this.grants.set(token, { userId, expiresAt: Date.now() + STEP_UP_TOKEN_TTL_MS });
    return token;
  }

  consume(token: string, expectedUserId: string): boolean {
    const entry = this.grants.take(token);
    return Boolean(entry && entry.userId === expectedUserId);
  }
}

export function registerPasskeyRoutes(
  app: App,
  ctx: {
    store: ControlStore;
    sessions: SessionManager;
    guards?: AuthGuards;
    stepUpRegistry: PasskeyStepUpRegistry;
  },
): void {
  const { store, sessions, stepUpRegistry } = ctx;
  const challenges = new FlowStateMap<ChallengeEntry>(5000);
  const limiter = new WindowLimiter(30, 10 * 60_000);

  async function resolveRpAndOrigin(c: Context): Promise<{ origin: string; rpId: string; siteName: string }> {
    const settings = await store.ops.getSettings();
    const configured = configuredPublicBaseUrl(settings);
    const origin = configured ? new URL(configured).origin : safeRequestOrigin(c);
    const rpId = new URL(origin).hostname;
    return { origin, rpId, siteName: settings.siteName || "Slipgate" };
  }

  /* ---------------- Authenticated user passkey management ---------------- */

  app.get("/api/v1/user/passkeys", async (c) => {
    const claims = c.get("authUser");
    const items = await store.passkeys.listByUser(claims.sub);
    return c.json({ items });
  });

  app.post("/api/v1/user/passkeys/register/options", async (c) => {
    const claims = c.get("authUser");
    const parsed = PasskeyRegisterOptionsRequestSchema.safeParse(await jsonBody(c).catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const user = await store.getUserById(claims.sub);
    if (!user) throw new StoreError("not_found", "User no longer exists");
    const { origin, rpId, siteName } = await resolveRpAndOrigin(c);
    const existing = await store.passkeys.listByUser(claims.sub);
    const challenge = bufToB64url(crypto.getRandomValues(new Uint8Array(32)));
    const challengeToken = bufToB64url(crypto.getRandomValues(new Uint8Array(24)));
    challenges.set(challengeToken, {
      challenge,
      purpose: "register",
      userId: claims.sub,
      origin,
      rpId,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });

    return c.json({
      challengeToken,
      options: {
        challenge,
        rp: { name: siteName, id: rpId },
        user: {
          id: bufToB64url(Buffer.from(user.id, "utf8")),
          name: user.email,
          displayName: user.username || user.email,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: 60_000,
        attestation: "none",
        excludeCredentials: existing.map((k) => ({ id: k.credentialId, type: "public-key", transports: k.transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      },
    });
  });

  app.post("/api/v1/user/passkeys/register/verify", async (c) => {
    const claims = c.get("authUser");
    const parsed = PasskeyRegisterVerifyRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const entry = challenges.take(parsed.data.challengeToken);
    if (!entry || entry.purpose !== "register" || entry.userId !== claims.sub) {
      throw new StoreError("bad_request", "Passkey registration challenge expired or invalid");
    }

    try {
      const att = extractAttestationCredential({
        credentialId: parsed.data.credential.id,
        authenticatorDataB64: parsed.data.credential.response.authenticatorData,
        publicKeySpkiB64: parsed.data.credential.response.publicKeySpki,
        attestationObjectB64: parsed.data.credential.response.attestationObject,
        publicKeyAlgorithm: parsed.data.credential.response.publicKeyAlgorithm,
        expectedRpId: entry.rpId,
      });
      verifyClientData(
        parsed.data.credential.response.clientDataJSON,
        "webauthn.create",
        entry.challenge,
        entry.origin,
      );

      const item = await store.passkeys.create({
        userId: claims.sub,
        credentialId: att.credentialId,
        publicKeySpki: att.publicKeySpki,
        algorithm: att.algorithm,
        signCount: att.signCount,
        transports: parsed.data.credential.response.transports ?? [],
        deviceName: parsed.data.deviceName,
        backedUp: att.backedUp,
      });
      return c.json({ item }, 201);
    } catch (err) {
      if (err instanceof StoreError) throw err;
      throw new StoreError("bad_request", err instanceof Error ? err.message : "Passkey verification failed");
    }
  });

  app.patch("/api/v1/user/passkeys/:id", async (c) => {
    const claims = c.get("authUser");
    const parsed = RenamePasskeyRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const item = await store.passkeys.rename(claims.sub, c.req.param("id"), parsed.data.deviceName);
    return c.json({ item });
  });

  app.delete("/api/v1/user/passkeys/:id", async (c) => {
    const claims = c.get("authUser");
    const deleted = await store.passkeys.delete(claims.sub, c.req.param("id"));
    if (!deleted) throw new StoreError("not_found", "Passkey not found");
    return c.json({ deleted: true });
  });

  /* ---------------- Authenticated step-up ---------------- */

  app.post("/api/v1/user/passkeys/step-up/options", async (c) => {
    const claims = c.get("authUser");
    const { origin, rpId } = await resolveRpAndOrigin(c);
    const creds = await store.passkeys.listByUser(claims.sub);
    if (creds.length === 0) {
      throw new StoreError("bad_request", "No passkeys registered for this account");
    }
    const challenge = bufToB64url(crypto.getRandomValues(new Uint8Array(32)));
    const challengeToken = bufToB64url(crypto.getRandomValues(new Uint8Array(24)));
    challenges.set(challengeToken, {
      challenge,
      purpose: "step_up",
      userId: claims.sub,
      origin,
      rpId,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return c.json({
      challengeToken,
      options: {
        challenge,
        rpId,
        timeout: 60_000,
        userVerification: "preferred",
        allowCredentials: creds.map((k) => ({ id: k.credentialId, type: "public-key", transports: k.transports })),
      },
    });
  });

  app.post("/api/v1/user/passkeys/step-up/verify", async (c) => {
    const claims = c.get("authUser");
    const parsed = PasskeyStepUpVerifyRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const entry = challenges.take(parsed.data.challengeToken);
    if (!entry || entry.purpose !== "step_up" || entry.userId !== claims.sub) {
      throw new StoreError("bad_request", "Passkey step-up challenge expired or invalid");
    }
    const cred = await store.passkeys.findByCredentialId(parsed.data.credential.id);
    if (!cred || cred.userId !== claims.sub) {
      throw new StoreError("forbidden", "Passkey does not belong to this account");
    }
    try {
      const verified = verifyAssertionSignature({
        credential: parsed.data.credential,
        expectedChallenge: entry.challenge,
        expectedOrigin: entry.origin,
        expectedRpId: entry.rpId,
        storedPublicKeySpki: cred.publicKeySpki,
        storedSignCount: cred.signCount,
      });
      await store.passkeys.touchUsage(cred.id, verified.newSignCount, verified.backedUp);
      const passkeyStepUpToken = stepUpRegistry.issue(claims.sub);
      return c.json({ ok: true, passkeyStepUpToken });
    } catch (err) {
      throw new StoreError("forbidden", err instanceof Error ? err.message : "Passkey step-up failed");
    }
  });

  /* ---------------- Public passwordless passkey login ---------------- */

  app.post("/api/v1/auth/passkey/login/options", async (c) => {
    const ip = clientIp(c);
    if (!limiter.allow(`pk-opt:${ip}`)) {
      return c.json({ error: "too_many_attempts", message: "Too many attempts, try again later" }, 429);
    }
    const parsed = PasskeyLoginOptionsRequestSchema.safeParse(await jsonBody(c).catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const { origin, rpId } = await resolveRpAndOrigin(c);
    let allowCredentials: { id: string; type: "public-key"; transports: string[] }[] = [];
    if (parsed.data.email) {
      const user = await store.findUserByEmail(parsed.data.email);
      if (user) {
        const creds = await store.passkeys.listByUser(user.id);
        allowCredentials = creds.map((k) => ({ id: k.credentialId, type: "public-key", transports: k.transports }));
      }
    }
    const challenge = bufToB64url(crypto.getRandomValues(new Uint8Array(32)));
    const challengeToken = bufToB64url(crypto.getRandomValues(new Uint8Array(24)));
    challenges.set(challengeToken, {
      challenge,
      purpose: "login",
      origin,
      rpId,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return c.json({
      challengeToken,
      options: {
        challenge,
        rpId,
        timeout: 60_000,
        userVerification: "preferred",
        ...(allowCredentials.length > 0 ? { allowCredentials } : {}),
      },
    });
  });

  app.post("/api/v1/auth/passkey/login/verify", async (c) => {
    const ip = clientIp(c);
    if (!limiter.allow(`pk-login:${ip}`)) {
      return c.json({ error: "too_many_attempts", message: "Too many attempts, try again later" }, 429);
    }
    const parsed = PasskeyLoginVerifyRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const entry = challenges.take(parsed.data.challengeToken);
    if (!entry || entry.purpose !== "login") {
      return c.json({ error: "invalid_challenge", message: "Passkey login challenge expired or invalid" }, 400);
    }
    const cred = await store.passkeys.findByCredentialId(parsed.data.credential.id);
    if (!cred) {
      return c.json({ error: "unauthorized", message: "Unknown passkey" }, 401);
    }
    try {
      const verified = verifyAssertionSignature({
        credential: parsed.data.credential,
        expectedChallenge: entry.challenge,
        expectedOrigin: entry.origin,
        expectedRpId: entry.rpId,
        storedPublicKeySpki: cred.publicKeySpki,
        storedSignCount: cred.signCount,
      });
      await store.passkeys.touchUsage(cred.id, verified.newSignCount, verified.backedUp);
    } catch (err) {
      return c.json(
        { error: "unauthorized", message: err instanceof Error ? err.message : "Passkey signature failed" },
        401,
      );
    }
    const user = await store.getUserById(cred.userId);
    if (!user) return c.json({ error: "unauthorized", message: "User no longer exists" }, 401);
    if (user.status !== "active") {
      return c.json({ error: "account_suspended", message: "Account is suspended" }, 403);
    }
    if (user.role !== "admin" && ctx.guards && (await ctx.guards.backendMode())) {
      return c.json({ error: "backend_mode", message: "Backend mode is on: only administrators can sign in" }, 403);
    }
    await store.ops.touchLastLogin(user.id);
    const session = await sessions.issue(user);
    return c.json(AuthSessionResponseSchema.parse(session));
  });
}
