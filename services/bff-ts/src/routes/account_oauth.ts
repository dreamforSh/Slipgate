import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  ExchangeAccountOAuthRequestSchema,
  ExchangeAccountOAuthResponseSchema,
  isSubscriptionTierAllowedForProvider,
  resolveTierForPlatform,
  StartAccountOAuthRequestSchema,
  StartAccountOAuthResponseSchema,
  type AccountOAuthMethod,
  type AccountOAuthProvider,
  type SubscriptionTier,
} from "@slipgate/contracts";
import type { AuthEnv } from "../middleware/auth.ts";
import { ssrfSafeFetch } from "../security/ssrf.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

/**
 * Interactive OAuth 2.0 + PKCE account onboarding for upstream provider pools:
 *   - Anthropic Claude Code (`oauth` full scopes & `setup_token` long-lived inference scope)
 *   - OpenAI Codex CLI (`auth.openai.com` PKCE + ChatGPT plan/account_id extraction)
 *   - Antigravity Cloud Code & Google Gemini CLI (`accounts.google.com` offline PKCE)
 *   - Qwen CLI (`chat.qwen.ai` OAuth2 PKCE)
 *
 * All Routes live under `/api/v1/admin/accounts/oauth/*` (protected by `sessions.requireAdmin()`
 * and `auditMiddleware` in `createBffApp`). Ongoing token refreshes after creation run in
 * `slipgate-net` (`oauth_refresh.go`) through each account's bound Clash exit IP + uTLS profile.
 */

export interface AccountOAuthRouteContext {
  store: ControlStore;
  fetchImpl?: typeof fetch;
}

interface PendingAccountOAuthSession {
  platform: AccountOAuthProvider;
  addMethod: AccountOAuthMethod;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  projectId: string;
  verifier: string;
  state: string;
  expiresAtMs: number;
}

const SESSION_TTL_MS = 30 * 60_000;
const MAX_PENDING_SESSIONS = 2_000;

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_SCOPE_OAUTH =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins";
const ANTHROPIC_SCOPE_SETUP = "user:inference";
const ANTHROPIC_UA = "claude-cli/2.1.280 (external, cli)";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_UA = "codex_cli_rs/0.38.0 (Linux 6.8.0; x86_64)";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_REDIRECT_URI = "http://localhost:8085/callback";
const ANTIGRAVITY_DEFAULT_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const GEMINI_DEFAULT_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const ANTIGRAVITY_SCOPES =
  "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";
const GEMINI_SCOPES =
  "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

const QWEN_DEFAULT_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_AUTHORIZE_URL = "https://chat.qwen.ai/api/v1/oauth2/authorize";
const QWEN_TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token";
const QWEN_REDIRECT_URI = "http://localhost:8085/callback";
const QWEN_SCOPES = "openid profile email model.completion";

function parseAuthorizationInput(rawInput: string): { code: string; state: string | null } {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new StoreError("bad_request", "Authorization code or callback URL is required");
  }

  if (/^https?:\/\//i.test(trimmed) || trimmed.includes("?code=") || trimmed.includes("&code=")) {
    let url: URL;
    try {
      url = /^https?:\/\//i.test(trimmed) ? new URL(trimmed) : new URL(trimmed, "http://localhost");
    } catch {
      throw new StoreError("bad_request", "Malformed OAuth callback URL");
    }
    const errCode = url.searchParams.get("error");
    if (errCode) {
      const desc = url.searchParams.get("error_description") || errCode;
      throw new StoreError("bad_request", `Upstream OAuth authorization failed: ${desc}`);
    }
    const code = (url.searchParams.get("code") ?? "").trim();
    const state = (url.searchParams.get("state") ?? "").trim() || null;
    if (!code) {
      throw new StoreError("bad_request", "No authorization code found in callback URL");
    }
    if (code.includes("#") && !state) {
      const idx = code.indexOf("#");
      return { code: code.slice(0, idx).trim(), state: code.slice(idx + 1).trim() || null };
    }
    return { code, state };
  }

  const hashIdx = trimmed.indexOf("#");
  if (hashIdx > 0) {
    const code = trimmed.slice(0, hashIdx).trim();
    const state = trimmed.slice(hashIdx + 1).trim() || null;
    if (!code) throw new StoreError("bad_request", "Authorization code before '#' is empty");
    return { code, state };
  }

  return { code: trimmed, state: null };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function inferCodexTier(planRaw: string): SubscriptionTier {
  const p = planRaw.trim().toLowerCase();
  if (p === "pro") return "pro_5x";
  if (p === "plus" || p === "team" || p === "business" || p === "enterprise") return "plus";
  return resolveTierForPlatform("codex", p);
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
}

export function registerAccountOAuthRoutes(app: Hono<AuthEnv>, ctx: AccountOAuthRouteContext): void {
  const sessions = new Map<string, PendingAccountOAuthSession>();
  const doFetch = ctx.fetchImpl ?? fetch;

  function pruneSessions(nowMs: number) {
    for (const [id, s] of sessions) {
      if (s.expiresAtMs > nowMs) break;
      sessions.delete(id);
    }
    while (sessions.size >= MAX_PENDING_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  }

  app.post("/api/v1/admin/accounts/oauth/start", async (c) => {
    const raw = await readJsonBody(c);
    const parsed = StartAccountOAuthRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const req = parsed.data;
    const nowMs = Date.now();
    pruneSessions(nowMs);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    const sessionId = `aoa_${randomBytes(24).toString("base64url")}`;

    let authorizeUrl = "";
    let redirectUri = "";
    let clientId = "";
    let clientSecret = req.clientSecret?.trim() ?? "";
    let instructions = "";

    switch (req.platform) {
      case "anthropic": {
        clientId = req.clientId?.trim() || ANTHROPIC_CLIENT_ID;
        redirectUri = req.redirectUri?.trim() || ANTHROPIC_REDIRECT_URI;
        const scope = req.addMethod === "setup_token" ? ANTHROPIC_SCOPE_SETUP : ANTHROPIC_SCOPE_OAUTH;
        const u = new URL(ANTHROPIC_AUTHORIZE_URL);
        u.searchParams.set("code", "true");
        u.searchParams.set("client_id", clientId);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("redirect_uri", redirectUri);
        u.searchParams.set("scope", scope);
        u.searchParams.set("code_challenge", challenge);
        u.searchParams.set("code_challenge_method", "S256");
        u.searchParams.set("state", state);
        authorizeUrl = u.toString();
        instructions = "Open the authorization URL in your browser, approve access, and paste the returned code#state value below.";
        break;
      }
      case "codex": {
        clientId = req.clientId?.trim() || CODEX_CLIENT_ID;
        redirectUri = req.redirectUri?.trim() || CODEX_REDIRECT_URI;
        const u = new URL(CODEX_AUTHORIZE_URL);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("client_id", clientId);
        u.searchParams.set("redirect_uri", redirectUri);
        u.searchParams.set("scope", CODEX_SCOPES);
        u.searchParams.set("code_challenge", challenge);
        u.searchParams.set("code_challenge_method", "S256");
        u.searchParams.set("state", state);
        u.searchParams.set("id_token_add_organizations", "true");
        u.searchParams.set("codex_cli_simplified_flow", "true");
        authorizeUrl = u.toString();
        instructions =
          "Open the authorization URL, sign in with ChatGPT, and copy the full http://localhost:1455/auth/callback?code=... URL from your browser address bar.";
        break;
      }
      case "antigravity":
      case "gemini": {
        const isAg = req.platform === "antigravity";
        clientId =
          req.clientId?.trim() ||
          (isAg
            ? process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || ANTIGRAVITY_DEFAULT_CLIENT_ID
            : process.env.GEMINI_OAUTH_CLIENT_ID || GEMINI_DEFAULT_CLIENT_ID);
        if (!clientSecret) {
          clientSecret = (isAg ? process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET : process.env.GEMINI_OAUTH_CLIENT_SECRET) ?? "";
        }
        redirectUri = req.redirectUri?.trim() || GOOGLE_REDIRECT_URI;
        const u = new URL(GOOGLE_AUTHORIZE_URL);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("client_id", clientId);
        u.searchParams.set("redirect_uri", redirectUri);
        u.searchParams.set("scope", isAg ? ANTIGRAVITY_SCOPES : GEMINI_SCOPES);
        u.searchParams.set("code_challenge", challenge);
        u.searchParams.set("code_challenge_method", "S256");
        u.searchParams.set("state", state);
        u.searchParams.set("access_type", "offline");
        u.searchParams.set("prompt", "consent");
        authorizeUrl = u.toString();
        instructions =
          "Open the Google authorization URL, grant consent, and paste the full http://localhost:8085/callback?code=... redirect URL below.";
        break;
      }
      case "qwen": {
        clientId = req.clientId?.trim() || process.env.QWEN_OAUTH_CLIENT_ID || QWEN_DEFAULT_CLIENT_ID;
        redirectUri = req.redirectUri?.trim() || QWEN_REDIRECT_URI;
        const u = new URL(QWEN_AUTHORIZE_URL);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("client_id", clientId);
        u.searchParams.set("redirect_uri", redirectUri);
        u.searchParams.set("scope", QWEN_SCOPES);
        u.searchParams.set("code_challenge", challenge);
        u.searchParams.set("code_challenge_method", "S256");
        u.searchParams.set("state", state);
        authorizeUrl = u.toString();
        instructions = "Open the Qwen authorization URL, complete sign-in, and paste the callback URL or code below.";
        break;
      }
    }

    sessions.set(sessionId, {
      platform: req.platform,
      addMethod: req.addMethod,
      clientId,
      clientSecret,
      redirectUri,
      projectId: req.projectId?.trim() ?? "",
      verifier,
      state,
      expiresAtMs: nowMs + SESSION_TTL_MS,
    });

    return c.json(
      StartAccountOAuthResponseSchema.parse({
        sessionId,
        authorizeUrl,
        state,
        redirectUri,
        instructions,
      }),
    );
  });

  app.post("/api/v1/admin/accounts/oauth/exchange", async (c) => {
    const raw = await readJsonBody(c);
    const parsed = ExchangeAccountOAuthRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const req = parsed.data;
    const nowMs = Date.now();
    pruneSessions(nowMs);

    const session = sessions.get(req.sessionId);
    if (!session || session.expiresAtMs <= nowMs) {
      sessions.delete(req.sessionId);
      throw new StoreError("bad_request", "OAuth authorization session expired or not found; generate a new link");
    }

    const { code, state: callbackState } = parseAuthorizationInput(req.codeInput);
    if (callbackState && callbackState !== session.state) {
      throw new StoreError("bad_request", "OAuth state mismatch; ensure you pasted the callback from the latest link");
    }

    let tokenUrl = "";
    let init: RequestInit;
    switch (session.platform) {
      case "anthropic": {
        tokenUrl = ANTHROPIC_TOKEN_URL;
        const payload: Record<string, unknown> = {
          grant_type: "authorization_code",
          code,
          redirect_uri: session.redirectUri,
          client_id: session.clientId,
          code_verifier: session.verifier,
          state: callbackState || session.state,
        };
        if (session.addMethod === "setup_token") {
          payload.expires_in = 31_536_000;
        }
        init = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": ANTHROPIC_UA,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(25_000),
        };
        break;
      }
      case "codex": {
        tokenUrl = CODEX_TOKEN_URL;
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: session.clientId,
          code,
          redirect_uri: session.redirectUri,
          code_verifier: session.verifier,
        });
        init = {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": CODEX_UA,
          },
          body: form.toString(),
          signal: AbortSignal.timeout(25_000),
        };
        break;
      }
      case "antigravity":
      case "gemini": {
        tokenUrl = GOOGLE_TOKEN_URL;
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: session.redirectUri,
          client_id: session.clientId,
          code_verifier: session.verifier,
        });
        if (session.clientSecret) form.set("client_secret", session.clientSecret);
        init = {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: form.toString(),
          signal: AbortSignal.timeout(25_000),
        };
        break;
      }
      case "qwen": {
        tokenUrl = QWEN_TOKEN_URL;
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: session.redirectUri,
          client_id: session.clientId,
          code_verifier: session.verifier,
        });
        if (session.clientSecret) form.set("client_secret", session.clientSecret);
        init = {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: form.toString(),
          signal: AbortSignal.timeout(25_000),
        };
        break;
      }
    }

    let res: Response;
    try {
      res = await ssrfSafeFetch(tokenUrl, init, doFetch);
    } catch (err) {
      return c.json(
        { error: "oauth_exchange_unreachable", message: err instanceof Error ? err.message : String(err) },
        502,
      );
    }

    const tokenBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg =
        (typeof tokenBody.error_description === "string" && tokenBody.error_description) ||
        (typeof tokenBody.message === "string" && tokenBody.message) ||
        (typeof tokenBody.error === "string" && tokenBody.error) ||
        `Upstream token endpoint returned HTTP ${res.status}`;
      return c.json({ error: "oauth_exchange_failed", message: msg }, 400);
    }

    const accessToken = typeof tokenBody.access_token === "string" ? tokenBody.access_token.trim() : "";
    if (!accessToken) {
      return c.json({ error: "oauth_exchange_failed", message: "Upstream token response omitted access_token" }, 502);
    }
    // Single-use PKCE session consumed after successful exchange.
    sessions.delete(req.sessionId);

    const refreshToken = typeof tokenBody.refresh_token === "string" ? tokenBody.refresh_token.trim() : "";
    const idToken = typeof tokenBody.id_token === "string" ? tokenBody.id_token.trim() : "";
    const scope = typeof tokenBody.scope === "string" ? tokenBody.scope : "";
    const expiresInSec =
      typeof tokenBody.expires_in === "number" && Number.isFinite(tokenBody.expires_in) && tokenBody.expires_in > 0
        ? Math.floor(tokenBody.expires_in)
        : 3600;
    const expiresAtUnixMs = Date.now() + expiresInSec * 1000;
    const expiresAtIso = new Date(expiresAtUnixMs).toISOString();

    let email = "";
    let accountIdHint = "";
    let subscriptionTier: SubscriptionTier = "standard";

    const claims = (idToken && decodeJwtPayload(idToken)) || decodeJwtPayload(accessToken);
    if (claims) {
      if (typeof claims.email === "string") email = claims.email;
      const authClaim = claims["https://api.openai.com/auth"];
      if (authClaim && typeof authClaim === "object") {
        const authObj = authClaim as Record<string, unknown>;
        if (typeof authObj.chatgpt_account_id === "string") accountIdHint = authObj.chatgpt_account_id;
        if (typeof authObj.chatgpt_plan_type === "string" && session.platform === "codex") {
          const inferred = inferCodexTier(authObj.chatgpt_plan_type);
          if (isSubscriptionTierAllowedForProvider("codex", inferred)) {
            subscriptionTier = inferred;
          }
        }
      }
    }

    if (!email && (session.platform === "antigravity" || session.platform === "gemini")) {
      try {
        const uRes = await ssrfSafeFetch(
          GOOGLE_USERINFO_URL,
          {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
            signal: AbortSignal.timeout(8_000),
          },
          doFetch,
        );
        if (uRes.ok) {
          const uJson = (await uRes.json().catch(() => ({}))) as Record<string, unknown>;
          if (typeof uJson.email === "string") email = uJson.email;
        }
      } catch {
        // Userinfo is optional enrichment; credential issuance still succeeds.
      }
    }

    if (!email && tokenBody.account && typeof tokenBody.account === "object") {
      const accObj = tokenBody.account as Record<string, unknown>;
      if (typeof accObj.email_address === "string") email = accObj.email_address;
      else if (typeof accObj.email === "string") email = accObj.email;
    }

    // For Anthropic setup_token without refresh_token, emit the raw sk-ant-oat01-... token directly
    // when appropriate, or canonical JSON when refresh_token / metadata is present.
    let credentialSecret: string;
    if (session.platform === "anthropic" && session.addMethod === "setup_token" && !refreshToken && accessToken.startsWith("sk-ant-")) {
      credentialSecret = accessToken;
    } else {
      const secretObj: Record<string, unknown> = {
        type: session.platform === "anthropic" ? "claude" : session.platform,
        access_token: accessToken,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        ...(idToken ? { id_token: idToken } : {}),
        expires_at: expiresAtIso,
        expires_at_unix_ms: expiresAtUnixMs,
        ...(scope ? { scope } : {}),
        client_id: session.clientId,
        ...(session.clientSecret ? { client_secret: session.clientSecret } : {}),
        ...(session.projectId ? { project_id: session.projectId } : {}),
        ...(accountIdHint ? { account_id: accountIdHint } : {}),
        ...(email ? { email } : {}),
      };
      credentialSecret = JSON.stringify(secretObj, null, 2);
    }

    return c.json(
      ExchangeAccountOAuthResponseSchema.parse({
        credentialSecret,
        email,
        subscriptionTier,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        ...(accountIdHint ? { accountIdHint } : {}),
        expiresAtIso,
      }),
    );
  });
}
