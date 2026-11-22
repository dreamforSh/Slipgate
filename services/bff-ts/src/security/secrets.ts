/**
 * Startup secret checks for slipgate-bff. Mirrors services/net-go/internal/config/secrets.go so
 * the supervised and standalone entrypoints reject the same values.
 */

export const MIN_SECRET_BYTES = 32;

/** Public development fallbacks used by createBffApp when no secret is configured. */
export const DEV_JWT_SECRET = "slipgate-dev-jwt-secret-change-in-prod";
export const DEV_VAULT_SECRET = "slipgate-dev-vault-secret-change-in-prod";

type Env = Record<string, string | undefined>;

/** Why `value` must not be used as a production secret, or `null` when it is acceptable. */
export function weakSecretReason(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === "") return "not set";
  if (trimmed === DEV_JWT_SECRET || trimmed === DEV_VAULT_SECRET) return "is the public built-in development default";
  if (lower.startsWith("change-me") || lower.startsWith("changeme") || lower.includes("change-in-prod")) {
    return "is still the .env.example placeholder";
  }
  if (new TextEncoder().encode(trimmed).length < MIN_SECRET_BYTES) return `is shorter than ${MIN_SECRET_BYTES} bytes`;
  return null;
}

/** Every weak secret in `env`, e.g. `SLIPGATE_JWT_SECRET is not set`. */
export function secretProblems(env: Env): string[] {
  const problems: string[] = [];
  for (const name of ["SLIPGATE_JWT_SECRET", "SLIPGATE_VAULT_SECRET"] as const) {
    const reason = weakSecretReason(env[name]);
    if (reason) problems.push(`${name} ${reason}`);
  }
  return problems;
}

/** `SLIPGATE_ALLOW_INSECURE_SECRETS`, parsed like Go's strconv.ParseBool true values. */
export function allowInsecureSecrets(env: Env): boolean {
  return ["1", "t", "true"].includes((env.SLIPGATE_ALLOW_INSECURE_SECRETS ?? "").trim().toLowerCase());
}
