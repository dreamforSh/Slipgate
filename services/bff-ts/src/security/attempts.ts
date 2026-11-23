/**
 * Failed-password throttling for sign-in and for every password check made with a session.
 *
 * Only failures count, so a user who types the right password is never slowed down, and a locked
 * key costs no PBKDF2 work. Every attempt reserves its slot *before* the store is read and the
 * password hashed: the check and the reservation are one synchronous step, so a burst of concurrent
 * guesses cannot all pass the check while the first ones are still hashing. Per key and window, at
 * most `limit` attempts are ever evaluated, settled or still in flight.
 *
 * Sign-in, per 15 minutes:
 *  - one account from one client address: 10 failures lock that pair;
 *  - one client address, all accounts: 30 failures (credential stuffing);
 *  - one account, all addresses: 100 failures (guessing spread over many addresses).
 * The last two never apply to an address the account signed in from successfully within the last
 * 30 days. Knowing an email is therefore not enough to shut its owner (the setup admin included)
 * out: an attacker locks only the pairs they send from, and even 100 failures from many addresses
 * only hold back sign-ins from addresses the account has not used before.
 *
 * With a session (change password, two-factor setup / disable, audit-log clear, credential
 * export): 10 failures per user lock that user's password checks. Only the session's holder can
 * cause them, so they can't be turned against anyone else; they still count toward the address's
 * sign-in budget.
 *
 * Client addresses are rate-limit buckets from clientIp() (an IPv6 client is keyed by its /64).
 * Counters live in memory: an account's sign-in limits are lifted by a password reset by email,
 * by an administrator setting the user's password, and by restarting the BFF.
 */

/** Retry-After while a key is full only because attempts are still being checked (they settle in ms). */
const IN_FLIGHT_RETRY_MS = 1_000;

interface Entry {
  /** Failures settled in this window. */
  count: number;
  /** Attempts reserved and not settled yet. */
  inflight: number;
  resetAt: number;
}

/** One reserved attempt on one key, settled once with FailureLimiter.settle. */
export interface AttemptSlot {
  readonly key: string;
  readonly entry: Readonly<Entry>;
}

/**
 * Fixed-window failure counter with a hard key cap. Every window has the same length and a key is
 * (re)inserted when its window opens, so Map order is expiry order: expired keys are dropped from
 * the head (amortised O(1), never a full walk) and, when full, the key closest to expiring goes.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  private prune(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt > nowMs) break;
      this.entries.delete(key);
    }
  }

  private open(key: string, nowMs: number): Entry {
    this.prune(nowMs);
    const found = this.entries.get(key);
    if (found) return found;
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    const entry: Entry = { count: 0, inflight: 0, resetAt: nowMs + this.windowMs };
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Milliseconds until `key` may try again; 0 when it may try now. Attempts still in flight hold
   * their slots, so a key whose settled failures plus pending attempts reach the limit waits too.
   */
  retryAfterMs(key: string, nowMs = Date.now()): number {
    this.prune(nowMs);
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (entry.count >= this.limit) return Math.max(1, entry.resetAt - nowMs);
    return entry.count + entry.inflight >= this.limit ? IN_FLIGHT_RETRY_MS : 0;
  }

  /** Holds one attempt slot on `key` until `settle`. Call right after retryAfterMs(key) returned 0. */
  reserve(key: string, nowMs = Date.now()): AttemptSlot {
    const entry = this.open(key, nowMs);
    entry.inflight += 1;
    return { key, entry };
  }

  /** Ends a reservation: a failure is counted; otherwise the slot is simply freed. */
  settle(slot: AttemptSlot, failed: boolean, nowMs = Date.now()): void {
    const entry = this.entries.get(slot.key);
    if (entry !== slot.entry) {
      // The window ended, or the key was evicted or cleared, while the attempt ran: a failure
      // counts afresh, and nothing is left to free.
      if (failed) this.fail(slot.key, nowMs);
      return;
    }
    entry.inflight = Math.max(0, entry.inflight - 1);
    if (failed) entry.count += 1;
    else if (entry.count === 0 && entry.inflight === 0) this.entries.delete(slot.key);
  }

  /** Counts one failure on `key` without a reservation. */
  fail(key: string, nowMs = Date.now()): void {
    this.open(key, nowMs).count += 1;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Drops every key starting with `prefix` (rare: an account's sign-in limits being lifted). */
  resetPrefix(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Keys (here: an account and a client address) that succeeded recently, with a sliding expiry and
 * a hard cap. A key is re-inserted on every success and the TTL is fixed, so Map order is expiry order.
 */
class RecentSuccesses {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys = 100_000,
  ) {}

  has(key: string, nowMs: number): boolean {
    const expires = this.until.get(key);
    return expires !== undefined && expires > nowMs;
  }

  add(key: string, nowMs: number): void {
    this.until.delete(key);
    for (const [k, expires] of this.until) {
      if (expires > nowMs) break;
      this.until.delete(k);
    }
    while (this.until.size >= this.maxKeys) {
      const oldest = this.until.keys().next();
      if (oldest.done) break;
      this.until.delete(oldest.value);
    }
    this.until.set(key, nowMs + this.ttlMs);
  }
}

export const PASSWORD_WINDOW_MS = 15 * 60_000;
/** Failed sign-ins per account from one client address per window (the only hard per-account lock). */
export const PAIR_FAILURE_LIMIT = 10;
/** Failed passwords per client address per window, across all accounts (bounds credential stuffing). */
export const IP_FAILURE_LIMIT = 30;
/**
 * Failed sign-ins per account across all addresses per window (bounds guessing spread over many
 * addresses). Never applies to an address the account recently signed in from.
 */
export const ACCOUNT_FAILURE_LIMIT = 100;
/** Failed password checks per signed-in user per window. */
export const SESSION_FAILURE_LIMIT = 10;
/** How long a successful sign-in keeps its address exempt from the address- and account-wide limits. */
export const KNOWN_ADDRESS_TTL_MS = 30 * 24 * 60 * 60_000;

/** Account key for sign-in attempts (by address, so unknown and known emails behave alike). */
export function loginAttemptKey(email: string): string {
  return `login:${email.trim().toLowerCase()}`;
}

/** Account key for password checks made with a session (change password, two-factor setup, …). */
export function sessionAttemptKey(userId: string): string {
  return `user:${userId}`;
}

interface Rule {
  limiter: FailureLimiter;
  key: string;
  /** False: the attempt is counted on this key but not refused by it. */
  enforce: boolean;
}

/**
 * One reserved password check. Settle it exactly once: `failed()` for a wrong password,
 * `succeeded()` for a right one, `release()` when the check could not run (an error); or let
 * `run()` do that around the check.
 */
export class PasswordAttempt {
  private settled = false;

  constructor(
    private readonly slots: [FailureLimiter, AttemptSlot][],
    private readonly onSuccess: (nowMs: number) => void,
    private readonly now: () => number,
  ) {}

  private settle(failed: boolean): boolean {
    if (this.settled) return false;
    this.settled = true;
    const nowMs = this.now();
    for (const [limiter, slot] of this.slots) limiter.settle(slot, failed, nowMs);
    return true;
  }

  failed(): void {
    this.settle(true);
  }

  succeeded(): void {
    if (this.settle(false)) this.onSuccess(this.now());
  }

  release(): void {
    this.settle(false);
  }

  /** Runs `verify` on this reservation: false counts a failure, true a success, a throw only frees the slot. */
  async run(verify: () => Promise<boolean>): Promise<boolean> {
    let ok: boolean;
    try {
      ok = await verify();
    } catch (err) {
      this.release();
      throw err;
    }
    if (ok) this.succeeded();
    else this.failed();
    return ok;
  }
}

export type AttemptStart = { ok: true; attempt: PasswordAttempt } | { ok: false; retryAfterSeconds: number };

export interface PasswordAttemptLimits {
  pairLimit?: number;
  ipLimit?: number;
  accountLimit?: number;
  sessionLimit?: number;
  windowMs?: number;
  knownAddressTtlMs?: number;
  /** Clock (tests). */
  now?: () => number;
}

/** Failed-password limits for sign-in and session password checks (one instance per app). */
export class PasswordAttemptGuard {
  private readonly pairs: FailureLimiter;
  private readonly addresses: FailureLimiter;
  private readonly accounts: FailureLimiter;
  private readonly users: FailureLimiter;
  private readonly known: RecentSuccesses;
  private readonly now: () => number;

  constructor(opts: PasswordAttemptLimits = {}) {
    const windowMs = opts.windowMs ?? PASSWORD_WINDOW_MS;
    this.pairs = new FailureLimiter(opts.pairLimit ?? PAIR_FAILURE_LIMIT, windowMs);
    this.addresses = new FailureLimiter(opts.ipLimit ?? IP_FAILURE_LIMIT, windowMs);
    this.accounts = new FailureLimiter(opts.accountLimit ?? ACCOUNT_FAILURE_LIMIT, windowMs);
    this.users = new FailureLimiter(opts.sessionLimit ?? SESSION_FAILURE_LIMIT, windowMs);
    this.known = new RecentSuccesses(opts.knownAddressTtlMs ?? KNOWN_ADDRESS_TTL_MS);
    this.now = opts.now ?? Date.now;
  }

  /** Checks every enforced rule and, when none refuses, reserves a slot on every rule: one synchronous step. */
  private begin(rules: Rule[], nowMs: number, onSuccess: (nowMs: number) => void): AttemptStart {
    let wait = 0;
    for (const rule of rules) if (rule.enforce) wait = Math.max(wait, rule.limiter.retryAfterMs(rule.key, nowMs));
    if (wait > 0) return { ok: false, retryAfterSeconds: Math.ceil(wait / 1000) };
    const slots = rules.map((rule): [FailureLimiter, AttemptSlot] => [rule.limiter, rule.limiter.reserve(rule.key, nowMs)]);
    return { ok: true, attempt: new PasswordAttempt(slots, onSuccess, this.now) };
  }

  /**
   * Reserves one sign-in attempt for `email` from client address `ip`, or says how long to wait.
   * A success clears this pair's failures and remembers the address for the account; the address-
   * and account-wide counts stay (an attacker holding one valid account must not be able to reset
   * their budget with it).
   */
  beginSignIn(email: string, ip: string): AttemptStart {
    const nowMs = this.now();
    const account = loginAttemptKey(email);
    const pair = `${account}|${ip}`;
    const known = this.known.has(pair, nowMs);
    return this.begin(
      [
        { limiter: this.pairs, key: pair, enforce: true },
        { limiter: this.addresses, key: `ip:${ip}`, enforce: !known },
        { limiter: this.accounts, key: account, enforce: !known },
      ],
      nowMs,
      (at) => {
        this.pairs.reset(pair);
        this.known.add(pair, at);
      },
    );
  }

  /** Reserves one password check by signed-in user `userId` (request address `ip`), or says how long to wait. */
  beginSessionCheck(userId: string, ip: string): AttemptStart {
    const key = sessionAttemptKey(userId);
    return this.begin(
      [
        { limiter: this.users, key, enforce: true },
        { limiter: this.addresses, key: `ip:${ip}`, enforce: false },
      ],
      this.now(),
      () => this.users.reset(key),
    );
  }

  /**
   * Lifts every sign-in limit on this account (a password reset, an administrator setting the
   * password). Per-address counts stay: they belong to the addresses, not to the account.
   */
  clearSignIn(email: string): void {
    const account = loginAttemptKey(email);
    this.accounts.reset(account);
    this.pairs.resetPrefix(`${account}|`);
  }
}
