import { afterAll, beforeAll } from "bun:test";

const ENV = "SLIPGATE_ALLOW_PRIVATE_UPSTREAMS";

function restore(prev: string | undefined) {
  if (prev === undefined) delete process.env[ENV];
  else process.env[ENV] = prev;
}

/**
 * Local stand-ins (fake S3, webhook sinks) listen on 127.0.0.1, which the outbound SSRF guard
 * refuses unless the operator opts in. Call inside a describe() to opt in for that suite only, so
 * the suites asserting the guard itself still see it on.
 */
export function allowPrivateUpstreamsInSuite(): void {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env[ENV];
    process.env[ENV] = "true";
  });
  afterAll(() => restore(prev));
}

/** Runs fn with private upstreams allowed. */
export function withPrivateUpstreams<T>(fn: () => T): T {
  const prev = process.env[ENV];
  process.env[ENV] = "true";
  try {
    return fn();
  } finally {
    restore(prev);
  }
}
