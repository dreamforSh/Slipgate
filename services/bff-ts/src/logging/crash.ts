import { logger, rawConsole } from "./logger.ts";

/**
 * A crash of slipgate-bff leaves a system-log entry: an uncaught exception or an unhandled promise
 * rejection is logged as an error (component "process", with its stack when the runtime config
 * attaches stacks), the queued entries are written (`flush`, bounded by `flushTimeoutMs`), and the
 * process then exits with status 1 — what Bun does for both when no handler is installed, so the
 * supervisor still sees the crash.
 */

export const CRASH_FLUSH_TIMEOUT_MS = 3_000;

export interface CrashLoggingOptions {
  flushTimeoutMs?: number;
  /** process.exit (tests pass a spy). */
  exit?: (code: number) => void;
}

/** The handler for one kind of fatal event; only the first fatal event of the process is handled. */
export function crashHandler(
  kind: "uncaught exception" | "unhandled rejection",
  flush: () => Promise<void>,
  state: { crashing: boolean },
  opts: CrashLoggingOptions = {},
): (reason: unknown) => void {
  return (reason: unknown) => {
    if (state.crashing) return;
    state.crashing = true;
    const err = reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : String(reason));
    try {
      rawConsole.error(reason);
    } catch {
      // stderr gone: the stored entry below still has it.
    }
    logger.error("process", `${kind}: ${err.message || err.name}`, { error: err, kind });
    const exit = opts.exit ?? ((code: number) => process.exit(code));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.flushTimeoutMs ?? CRASH_FLUSH_TIMEOUT_MS);
    });
    void Promise.race([flush().catch(() => undefined), timeout]).finally(() => {
      clearTimeout(timer);
      exit(1);
    });
  };
}

/** Installs the handlers (server entrypoint only); returns the undo. */
export function installCrashLogging(flush: () => Promise<void>, opts: CrashLoggingOptions = {}): () => void {
  const state = { crashing: false };
  const onException = crashHandler("uncaught exception", flush, state, opts);
  const onRejection = crashHandler("unhandled rejection", flush, state, opts);
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
  };
}
