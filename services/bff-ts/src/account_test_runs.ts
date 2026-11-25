import {
  AccountTestEventSchema,
  type AccountTestEvent,
  type AccountTestKind,
  type AccountTestResult,
  type AccountTestRun,
  type AccountTestSource,
} from "@slipgate/contracts";

/** A test run before the store gives it an id. */
export type NewAccountTestRun = Omit<AccountTestRun, "id">;

const OUTPUT_MAX_CHARS = 500;
const MESSAGE_MAX_CHARS = 500;

/**
 * Folds the SSE stream of one account test (`data:` lines of AccountTestEvent) into its outcome:
 * the account's last test (AccountTestResult) and the entry of its test history. Used by the
 * console test route (as it relays the stream) and by scheduled / automatic tests.
 */
export class AccountTestTally {
  private kind: AccountTestKind;
  private model: string;
  private text = "";
  private lastNote = "";
  private mediaCount = 0;
  private dimensions: number | null = null;
  private end: AccountTestEvent | null = null;
  private buffered = "";
  private readonly startedAt = Date.now();

  constructor(kind: AccountTestKind, model: string) {
    this.kind = kind;
    this.model = model;
  }

  /** Feeds raw stream text; complete lines are parsed, the rest waits for the next chunk. */
  feed(chunk: string): void {
    this.buffered += chunk;
    let nl = this.buffered.indexOf("\n");
    while (nl >= 0) {
      this.line(this.buffered.slice(0, nl));
      this.buffered = this.buffered.slice(nl + 1);
      nl = this.buffered.indexOf("\n");
    }
  }

  /** Parses whatever is left once the stream ended. */
  flush(): void {
    if (this.buffered) this.line(this.buffered);
    this.buffered = "";
  }

  private line(raw: string) {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    let json: unknown;
    try {
      json = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    const ev = AccountTestEventSchema.safeParse(json);
    if (ev.success) this.observe(ev.data);
  }

  observe(e: AccountTestEvent): void {
    switch (e.type) {
      case "start":
        if (e.model) this.model = e.model;
        if (e.kind) this.kind = e.kind;
        break;
      case "delta":
        if (this.text.length < OUTPUT_MAX_CHARS * 2) this.text += e.text ?? "";
        break;
      case "media":
        this.mediaCount++;
        break;
      case "progress":
        if (e.text) this.lastNote = e.text;
        break;
      case "done":
      case "error":
        this.end = e;
        if (e.dimensions) this.dimensions = e.dimensions;
        break;
    }
  }

  get testKind(): AccountTestKind {
    return this.kind;
  }

  /** The outcome as the account's last test; an unfinished stream counts as a failure. */
  result(): AccountTestResult {
    const e = this.end;
    const ok = e?.type === "done" && e.success === true;
    return {
      ok,
      atIso: new Date().toISOString(),
      model: this.model,
      durationMs: Math.max(0, Math.round(e?.durationMs ?? Date.now() - this.startedAt)),
      message: ok ? "" : failureMessage(e),
    };
  }

  /** The history entry of this test. */
  run(accountId: string, source: AccountTestSource): NewAccountTestRun {
    const res = this.result();
    const e = this.end;
    const text = this.text.trim();
    const output = text || (this.kind === "video" && this.mediaCount === 0 ? this.lastNote : "");
    return {
      accountId,
      atIso: res.atIso,
      source,
      kind: this.kind,
      ok: res.ok,
      model: res.model,
      status: Math.max(0, Math.round(e?.status ?? 0)),
      durationMs: res.durationMs,
      ttftMs: this.kind === "text" && e?.ttftMs ? Math.max(0, Math.round(e.ttftMs)) : null,
      code: res.ok ? "" : (e?.code ?? (e ? "" : "stream_interrupted")).slice(0, 128),
      message: res.message,
      output: output.slice(0, OUTPUT_MAX_CHARS),
      mediaCount: this.mediaCount,
      dimensions: this.dimensions,
    };
  }
}

function failureMessage(e: AccountTestEvent | null): string {
  if (!e) return "stream_interrupted";
  return (e.message ?? e.code ?? (e.status ? `HTTP ${e.status}` : "test failed")).slice(0, MESSAGE_MAX_CHARS);
}

/** A failed run for a test that never produced a stream (network service unreachable, …). */
export function failedTestRun(
  accountId: string,
  source: AccountTestSource,
  kind: AccountTestKind,
  model: string,
  message: string,
  code = "",
): NewAccountTestRun {
  return {
    accountId,
    atIso: new Date().toISOString(),
    source,
    kind,
    ok: false,
    model,
    status: 0,
    durationMs: 0,
    ttftMs: null,
    code,
    message: message.slice(0, MESSAGE_MAX_CHARS),
    output: "",
    mediaCount: 0,
    dimensions: null,
  };
}
