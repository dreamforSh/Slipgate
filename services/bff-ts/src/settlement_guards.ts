/**
 * Coalescing primitives for the settlement hot path and the data-plane sync.
 */

/**
 * Runs `task` at most once at a time and coalesces every request made while it runs into exactly
 * one more run. Each request's promise settles after a run that *started after the request* has
 * finished, so a caller that just wrote something is guaranteed a run that sees its write; 20
 * concurrent requests cost at most 2 runs instead of 20. Task errors are swallowed (best effort).
 */
export class CoalescingRunner {
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;

  constructor(private readonly task: () => Promise<void>) {}

  request(): Promise<void> {
    if (this.queued) return this.queued;
    if (!this.running) return this.start();
    const after = this.running;
    this.queued = after.then(() => {
      this.queued = null;
      return this.start();
    });
    return this.queued;
  }

  /** Resolves when nothing is running or queued (tests). */
  async idle(): Promise<void> {
    while (this.running || this.queued) await (this.queued ?? this.running);
  }

  private start(): Promise<void> {
    let run: Promise<void>;
    try {
      run = this.task();
    } catch (err) {
      run = Promise.reject(err);
    }
    const p: Promise<void> = run
      .catch(() => undefined)
      .finally(() => {
        if (this.running === p) this.running = null;
      });
    this.running = p;
    return p;
  }
}

interface ThrottleSlot {
  task: () => Promise<void>;
  busy: boolean;
  dirty: boolean;
  lastAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Per-key throttle with a trailing run: a key's task runs at most once per `intervalMs` and never
 * concurrently with itself, and every request is followed by a run that starts after it (a request
 * that lands inside the interval, or while a run is in flight, is folded into one trailing run).
 * So nothing a request should observe is missed, but a hot key costs one run per interval instead
 * of one per request. Idle keys are forgotten after one interval, so the map stays small.
 */
export class KeyedThrottle {
  private readonly slots = new Map<string, ThrottleSlot>();

  constructor(
    private readonly intervalMs: number,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  /** Runs now (the returned promise settles when it finishes) or schedules the trailing run. */
  request(key: string, task: () => Promise<void>): Promise<void> {
    const now = Date.now();
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { task, busy: false, dirty: false, lastAt: 0, timer: null };
      this.slots.set(key, slot);
    }
    slot.task = task;
    if (slot.busy || slot.timer || now - slot.lastAt < this.intervalMs) {
      slot.dirty = true;
      this.arm(key, slot);
      return Promise.resolve();
    }
    return this.fire(key, slot);
  }

  /** Keys currently tracked (tests). */
  get size(): number {
    return this.slots.size;
  }

  private fire(key: string, slot: ThrottleSlot): Promise<void> {
    slot.busy = true;
    slot.dirty = false;
    slot.lastAt = Date.now();
    let run: Promise<void>;
    try {
      run = slot.task();
    } catch (err) {
      run = Promise.reject(err);
    }
    return run
      .catch((err) => this.onError(err))
      .finally(() => {
        slot.busy = false;
        this.arm(key, slot);
      });
  }

  /** One timer per busy-free slot: runs the trailing request, or forgets an idle key. */
  private arm(key: string, slot: ThrottleSlot): void {
    if (slot.busy || slot.timer) return;
    const wait = Math.max(0, slot.lastAt + this.intervalMs - Date.now());
    slot.timer = setTimeout(() => {
      slot.timer = null;
      if (slot.dirty) void this.fire(key, slot);
      else if (this.slots.get(key) === slot) this.slots.delete(key);
    }, wait);
    (slot.timer as { unref?: () => void }).unref?.();
  }
}
