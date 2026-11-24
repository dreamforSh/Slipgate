import { describe, expect, test } from "bun:test";
import {
  DEV_JWT_SECRET,
  DEV_VAULT_SECRET,
  allowInsecureSecrets,
  secretProblems,
  weakSecretReason,
} from "../security/secrets.ts";

const STRONG = "3f9a1c0d7e5b42a8916f0c3d2b7e8a41c5d6e7f8091a2b3c4d5e6f708192a3b4";

describe("weakSecretReason", () => {
  test.each([
    ["empty", undefined],
    ["whitespace", "   "],
    ["dev jwt default", DEV_JWT_SECRET],
    ["dev vault default", DEV_VAULT_SECRET],
    ["env example placeholder", "change-me-32-byte-jwt-secret"],
    ["long placeholder", "CHANGE-ME-please-replace-this-with-something-long"],
    ["changeme variant", "changeme0123456789abcdef0123456789abcdef"],
    ["too short", "0123456789abcdef0123456789abcde"],
  ])("rejects %s", (_label, value) => {
    expect(weakSecretReason(value)).not.toBeNull();
  });

  test.each([
    ["exactly 32 bytes", "0123456789abcdef0123456789abcdef"],
    ["openssl hex", STRONG],
  ])("accepts %s", (_label, value) => {
    expect(weakSecretReason(value)).toBeNull();
  });
});

describe("secretProblems", () => {
  test("names each weak secret", () => {
    const problems = secretProblems({ SLIPGATE_VAULT_SECRET: DEV_VAULT_SECRET });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toStartWith("SLIPGATE_JWT_SECRET ");
    expect(problems[1]).toStartWith("SLIPGATE_VAULT_SECRET ");
  });

  test("passes strong secrets", () => {
    expect(secretProblems({ SLIPGATE_JWT_SECRET: STRONG, SLIPGATE_VAULT_SECRET: STRONG })).toEqual([]);
    expect(secretProblems({ SLIPGATE_JWT_SECRET: STRONG, SLIPGATE_VAULT_SECRET: STRONG, SLIPGATE_INTERNAL_TOKEN: STRONG })).toEqual([]);
  });

  test("holds an operator-chosen internal token to the same bar", () => {
    const problems = secretProblems({ SLIPGATE_JWT_SECRET: STRONG, SLIPGATE_VAULT_SECRET: STRONG, SLIPGATE_INTERNAL_TOKEN: "changeme" });
    expect(problems).toEqual(["SLIPGATE_INTERNAL_TOKEN is still the .env.example placeholder"]);
  });
});

describe("allowInsecureSecrets", () => {
  test("accepts Go-style true values only", () => {
    for (const value of ["1", "t", "true", "TRUE", " True "]) {
      expect(allowInsecureSecrets({ SLIPGATE_ALLOW_INSECURE_SECRETS: value })).toBe(true);
    }
    for (const value of [undefined, "", "0", "false", "yes", "on"]) {
      expect(allowInsecureSecrets({ SLIPGATE_ALLOW_INSECURE_SECRETS: value })).toBe(false);
    }
  });
});
