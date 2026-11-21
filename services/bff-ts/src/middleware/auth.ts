import type { MiddlewareHandler } from "hono";
import { verifyJwt, type JwtClaims } from "../security/crypto.ts";

export interface AuthEnv {
  Variables: {
    authUser: JwtClaims;
  };
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function requireAuth(jwtSecret: string): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = extractBearer(c.req.header("Authorization"));
    if (!token) {
      return c.json({ error: "unauthorized", message: "Missing bearer token" }, 401);
    }
    const claims = await verifyJwt(token, jwtSecret);
    if (!claims) {
      return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
    }
    c.set("authUser", claims);
    await next();
  };
}

export function requireAdmin(jwtSecret: string): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = extractBearer(c.req.header("Authorization"));
    if (!token) {
      return c.json({ error: "unauthorized", message: "Missing bearer token" }, 401);
    }
    const claims = await verifyJwt(token, jwtSecret);
    if (!claims) {
      return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
    }
    if (claims.role !== "admin") {
      return c.json({ error: "forbidden", message: "Administrator role required" }, 403);
    }
    c.set("authUser", claims);
    await next();
  };
}
