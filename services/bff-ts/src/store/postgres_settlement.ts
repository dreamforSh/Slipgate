import type postgres from "postgres";
import { SETTLEMENT_ID_RETENTION_DAYS } from "./types.ts";

type Sql = ReturnType<typeof postgres>;

/**
 * Startup mirror of migrations/core/0009 (minus the usage_logs index builds, which run in the
 * background, see ensureUsageLogIndexes). Runs inside PostgresControlStore.init() before the BFF
 * listens and before PG_OPS_SCHEMA_SQL, so the spent_nano_usd guard below sees whether this start
 * is the one that adds the column.
 */
export const PG_SETTLEMENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS core.settlement_ids (
      settlement_id    TEXT PRIMARY KEY,
      usage_id         TEXT NOT NULL,
      usage_created_at TIMESTAMPTZ NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_core_settlement_ids_created ON core.settlement_ids (created_at);
  -- listGroups' per-group key count without a sequential scan of api_keys per group (small table).
  CREATE INDEX IF NOT EXISTS idx_core_api_keys_group ON core.api_keys (group_id);

  -- Lifetime wallet spend (0007). When this start is the one adding the column, record the cutoff
  -- in the same transaction: settles before it were never counted, settles after it always are,
  -- so the background backfill can add exactly the older ones without racing live settlements.
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'core' AND table_name = 'quota_wallets' AND column_name = 'spent_nano_usd'
    ) THEN
      ALTER TABLE core.quota_wallets ADD COLUMN spent_nano_usd NUMERIC(39, 0) NOT NULL DEFAULT 0;
      INSERT INTO commerce.portal_settings (key, value_json)
      VALUES ('spent_backfill_cutoff', jsonb_build_object('at', NOW()))
      ON CONFLICT (key) DO NOTHING;
    END IF;
  END $$;
`;

/** How often PostgresControlStore prunes core.settlement_ids, and how soon again when a run left a backlog. */
export const SETTLEMENT_PRUNE_INTERVAL_MS = 5 * 60_000;
export const SETTLEMENT_PRUNE_BACKLOG_RETRY_MS = 30_000;

export interface SettlementPruneOptions {
  retentionDays?: number;
  /** Rows per DELETE (one short transaction each). */
  batch?: number;
  /** Stop starting new batches after this long; the caller comes back soon for the rest. */
  budgetMs?: number;
}

export interface SettlementPruneResult {
  deleted: number;
  /** True when the budget ran out with expired ids still left (call again soon). */
  backlog: boolean;
}

/**
 * Deletes settlement ids older than the retention in short batches until none are left or the time
 * budget runs out, so the prune keeps up with any settlement rate (one batch never holds locks or a
 * pool connection for long, and other queries interleave between batches).
 */
export async function pruneSettlementIds(sql: Sql, opts: SettlementPruneOptions = {}): Promise<SettlementPruneResult> {
  const retentionDays = opts.retentionDays ?? SETTLEMENT_ID_RETENTION_DAYS;
  const batch = Math.max(1, opts.batch ?? 10_000);
  const deadline = Date.now() + Math.max(0, opts.budgetMs ?? 20_000);
  let deleted = 0;
  for (;;) {
    const rows = await sql<{ n: number }[]>`
      WITH gone AS (
        DELETE FROM core.settlement_ids
         WHERE settlement_id IN (
           SELECT settlement_id FROM core.settlement_ids
            WHERE created_at < NOW() - make_interval(days => ${retentionDays}::int)
            ORDER BY created_at
            LIMIT ${batch}
         )
        RETURNING 1
      )
      SELECT COUNT(*)::int AS n FROM gone
    `;
    const n = Number(rows[0]?.n ?? 0);
    deleted += n;
    if (n < batch) return { deleted, backlog: false };
    if (Date.now() >= deadline) return { deleted, backlog: true };
  }
}

/** One canonical index per purpose on core.usage_logs (parent + one attached index per partition). */
export interface UsageLogIndexSpec {
  /** Partitioned index on core.usage_logs (the name migrations use). */
  parent: string;
  /** Short suffix for the per-partition index this job builds. */
  suffix: string;
  /** Key and INCLUDE columns, formatted exactly as pg_get_indexdef prints them. */
  columns: string;
}

export const USAGE_LOG_INDEXES: readonly UsageLogIndexSpec[] = [
  // Per-group status pages and usage queries (0007).
  { parent: "idx_core_usage_logs_group_time", suffix: "group_time", columns: "(group_id, created_at DESC)" },
  // Per-key spend windows on the settlement path: covering, so the sums read index pages only.
  {
    parent: "idx_core_usage_logs_key_time_cost",
    suffix: "key_time_cost",
    columns: "(api_key_id, created_at DESC) INCLUDE (cost_nano_usd)",
  },
  // Time-ordered usage listings (0007).
  { parent: "idx_core_usage_logs_time", suffix: "time", columns: "(created_at DESC)" },
  // Subscription caps: one user's spend in one group over 1/7/30 days, index-only.
  {
    parent: "idx_core_usage_logs_user_group_time_cost",
    suffix: "user_group_time_cost",
    columns: "(user_id, group_id, created_at DESC) INCLUDE (cost_nano_usd)",
  },
];

/** Indexes made redundant by a covering replacement; dropped once the replacement is valid. */
export const SUPERSEDED_USAGE_LOG_INDEXES: readonly { columns: string; parent: string; replacedBy: string }[] = [
  {
    columns: "(api_key_id, created_at DESC)",
    parent: "idx_core_usage_logs_key_time",
    replacedBy: "idx_core_usage_logs_key_time_cost",
  },
];

/** Minimal surface runWithShortLockWait needs (a reserved connection, or a stub in tests). */
interface UnsafeRunner {
  unsafe(statement: string): PromiseLike<unknown>;
}

/**
 * Runs DDL that takes a strong lock on the hot usage_logs tables with lock_timeout set, so it fails
 * fast instead of queueing every settlement behind it while it waits for a long-running query.
 * Lock timeouts (55P03) are retried a few times with backoff, then thrown (the caller logs and the
 * next start tries again).
 */
export async function runWithShortLockWait(
  db: UnsafeRunner,
  statement: string,
  opts: { lockTimeout?: string; attempts?: number; retryDelayMs?: number } = {},
): Promise<void> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const lockTimeout = opts.lockTimeout ?? "3s";
  if (!/^\d+(ms|s)?$/.test(lockTimeout)) throw new Error(`Unsafe lock_timeout: ${lockTimeout}`);
  for (let attempt = 1; ; attempt++) {
    await db.unsafe(`SET lock_timeout = '${lockTimeout}'`);
    try {
      await db.unsafe(statement);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "55P03" || attempt >= attempts) throw err;
    } finally {
      await db.unsafe(`RESET lock_timeout`);
    }
    await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 2000) * attempt));
  }
}

/** Arbitrary constant for pg_try_advisory_lock: one maintenance run per database at a time. */
const USAGE_INDEX_LOCK_KEY = 74_210_009;

type Logger = (message: string) => void;

interface PartitionIndexRow {
  name: string;
  def: string;
  valid: boolean;
  /** Partitioned index this one is attached to, or null when it stands alone. */
  parent: string | null;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return name;
}

function partitionIndexName(partition: string, suffix: string): string {
  return ident(`${partition}_${suffix}_idx`.slice(0, 63));
}

/**
 * True when every canonical parent index exists and is valid (a partitioned index only turns valid
 * once each partition has an attached index), and no standalone duplicate, superseded or invalid
 * usage_logs index is left.
 */
async function usageIndexesConverged(sql: Sql): Promise<boolean> {
  const rows = await sql<{ name: string; def: string; valid: boolean; attached: boolean; partitioned: boolean }[]>`
    SELECT ci.relname AS name,
           regexp_replace(pg_get_indexdef(ix.indexrelid), '^.* USING btree ', '') AS def,
           ix.indisvalid AS valid,
           ih.inhparent IS NOT NULL AS attached,
           t.relkind = 'p' AS partitioned
      FROM pg_index ix
      JOIN pg_class ci ON ci.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      LEFT JOIN pg_inherits ih ON ih.inhrelid = ix.indexrelid
     WHERE NOT ix.indisunique
       AND (t.oid = 'core.usage_logs'::regclass
            OR t.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'core.usage_logs'::regclass))
  `;
  const managed = new Set([...USAGE_LOG_INDEXES.map((s) => s.columns), ...SUPERSEDED_USAGE_LOG_INDEXES.map((s) => s.columns)]);
  if (rows.some((r) => !r.partitioned && managed.has(r.def) && (!r.valid || !r.attached))) return false;
  if (SUPERSEDED_USAGE_LOG_INDEXES.some((s) => rows.some((r) => r.name === s.parent))) return false;
  return USAGE_LOG_INDEXES.every((s) => rows.some((r) => r.name === s.parent && r.partitioned && r.valid));
}

/**
 * Converges core.usage_logs on USAGE_LOG_INDEXES without blocking settlements:
 *  - each parent index is created ON ONLY the partitioned table (instant);
 *  - on each partition, an existing valid index with the same definition is attached instead of
 *    building a second copy (fresh installs, and indexes older builds made standalone);
 *  - otherwise the partition index is built CONCURRENTLY and attached. An INVALID leftover of an
 *    interrupted build is dropped and rebuilt, never skipped by IF NOT EXISTS;
 *  - standalone duplicates of an attached index and superseded indexes are dropped afterwards.
 * Runs on one reserved connection under an advisory lock; errors are logged, never thrown.
 */
export async function ensureUsageLogIndexes(sql: Sql, log: Logger = (m) => console.warn(m)): Promise<void> {
  let conn: Awaited<ReturnType<Sql["reserve"]>> | null = null;
  try {
    // The common case (every start after the first): one catalog read, nothing to do.
    if (await usageIndexesConverged(sql)) return;
    conn = await sql.reserve();
  } catch (err) {
    log(`[slipgate-bff] usage_logs index maintenance skipped: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const db = conn as unknown as Sql;
  let locked = false;
  try {
    const lock = await db<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${USAGE_INDEX_LOCK_KEY}) AS ok`;
    locked = Boolean(lock[0]?.ok);
    if (!locked) return;

    const partitions = (
      await db<{ name: string }[]>`
        SELECT c.relname AS name
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE i.inhparent = 'core.usage_logs'::regclass AND n.nspname = 'core' AND c.relkind = 'r'
         ORDER BY c.relname
      `
    ).map((r) => ident(r.name));

    const indexesOn = async (partition: string): Promise<PartitionIndexRow[]> =>
      db<PartitionIndexRow[]>`
        SELECT ci.relname AS name,
               regexp_replace(pg_get_indexdef(ix.indexrelid), '^.* USING btree ', '') AS def,
               ix.indisvalid AS valid,
               pc.relname AS parent
          FROM pg_index ix
          JOIN pg_class ci ON ci.oid = ix.indexrelid
          JOIN pg_class t ON t.oid = ix.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          LEFT JOIN pg_inherits ih ON ih.inhrelid = ix.indexrelid
          LEFT JOIN pg_class pc ON pc.oid = ih.inhparent
         WHERE n.nspname = 'core' AND t.relname = ${partition} AND NOT ix.indisunique
      `;

    for (const spec of USAGE_LOG_INDEXES) {
      const parent = ident(spec.parent);
      try {
        const parentExists = await db`
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'core' AND c.relname = ${parent}
        `;
        if (parentExists.length === 0) {
          // ShareLock on usage_logs: never queue settlement INSERTs behind a long writer for it.
          await runWithShortLockWait(db, `CREATE INDEX IF NOT EXISTS ${parent} ON ONLY core.usage_logs ${spec.columns}`);
        }
        for (const partition of partitions) {
          let rows = await indexesOn(partition);
          if (rows.some((r) => r.parent === parent)) continue;
          for (const bad of rows.filter((r) => r.parent === null && r.def === spec.columns && !r.valid)) {
            log(`[slipgate-bff] dropping INVALID usage_logs index core.${bad.name} (interrupted build); rebuilding`);
            await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS core.${ident(bad.name)}`);
          }
          rows = await indexesOn(partition);
          let child = rows.find((r) => r.parent === null && r.def === spec.columns && r.valid)?.name;
          if (!child) {
            child = partitionIndexName(partition, spec.suffix);
            await db.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${child} ON core.${partition} ${spec.columns}`);
            const built = (await indexesOn(partition)).find((r) => r.name === child);
            if (!built?.valid) throw new Error(`index build for core.${child} left it invalid`);
          }
          // ACCESS EXCLUSIVE on the partition's index: waiting behind a long reader would stall every
          // settlement INSERT queued behind the ATTACH. On a timeout the valid index stays standalone
          // (still usable by the planner) and the next start attaches it.
          await runWithShortLockWait(db, `ALTER INDEX core.${parent} ATTACH PARTITION core.${ident(child)}`);
        }
        // Standalone copies of what is now attached only cost writes.
        for (const partition of partitions) {
          for (const dup of (await indexesOn(partition)).filter((r) => r.parent === null && r.def === spec.columns)) {
            log(`[slipgate-bff] dropping duplicate usage_logs index core.${dup.name}`);
            await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS core.${ident(dup.name)}`);
          }
        }
      } catch (err) {
        log(`[slipgate-bff] usage_logs index ${parent} not ensured: ${err instanceof Error ? err.message : err}`);
      }
    }

    for (const old of SUPERSEDED_USAGE_LOG_INDEXES) {
      try {
        const replacement = await db<{ valid: boolean }[]>`
          SELECT ix.indisvalid AS valid
            FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'core' AND c.relname = ${old.replacedBy}
        `;
        if (!replacement[0]?.valid) continue;
        // A partitioned index cannot be dropped CONCURRENTLY; keep the exclusive lock wait short
        // and retry on the next start rather than queue settlements behind it.
        await runWithShortLockWait(db, `DROP INDEX IF EXISTS core.${ident(old.parent)}`);
        for (const partition of partitions) {
          for (const stale of (await indexesOn(partition)).filter((r) => r.parent === null && r.def === old.columns)) {
            log(`[slipgate-bff] dropping superseded usage_logs index core.${stale.name}`);
            await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS core.${ident(stale.name)}`);
          }
        }
      } catch (err) {
        log(`[slipgate-bff] superseded usage_logs index ${old.parent} kept: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    log(`[slipgate-bff] usage_logs index maintenance failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    try {
      if (locked) await db`SELECT pg_advisory_unlock(${USAGE_INDEX_LOCK_KEY})`;
    } catch {
      // The lock dies with the session anyway.
    }
    conn.release();
  }
}

/**
 * One-time lifetime-spend backfill, additive and race-free: claims the done flag and adds every
 * settle that predates the recorded cutoff in one transaction. Settlements after the cutoff are
 * counted by recordTurnSettlement itself and keep their increments (spent = spent + older).
 *
 * Without a cutoff the column was added some other way (0007 at initdb on a fresh install, 0007
 * applied by hand, or an older build). That is only safe to mark done when no wallet's spend is
 * below its settle history; otherwise the history was never added and guessing would either drop
 * it for good or count part of it twice, so the flag stays unclaimed and a warning asks for a
 * spent_backfill_cutoff to be recorded (the time the column was added).
 */
export async function backfillWalletSpend(sql: Sql, log: Logger = (m) => console.warn(m)): Promise<void> {
  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql;
    const done = await tx`SELECT 1 FROM commerce.portal_settings WHERE key = 'spent_backfill_v1'`;
    if (done.length > 0) return;
    const cutoff = await tx`SELECT 1 FROM commerce.portal_settings WHERE key = 'spent_backfill_cutoff'`;
    if (cutoff.length === 0) {
      const behind = await tx<{ users: number }[]>`
        SELECT COUNT(*)::int AS users
          FROM (
            SELECT l.user_id, -SUM(l.delta_nano_usd) AS total
              FROM core.ledger_entries l
             WHERE l.entry_kind = 'settle'
             GROUP BY l.user_id
          ) s
          JOIN core.quota_wallets w ON w.user_id = s.user_id
         WHERE w.spent_nano_usd < s.total
      `;
      const users = Number(behind[0]?.users ?? 0);
      if (users > 0) {
        log(
          `[slipgate-bff] lifetime spend backfill needs reconciliation: quota_wallets.spent_nano_usd is below the settle ledger for ${users} user(s) ` +
            `and no spent_backfill_cutoff is recorded. Insert commerce.portal_settings key 'spent_backfill_cutoff' with value {"at": <when spent_nano_usd was added>} ` +
            `and restart to add the older settles; until then lifetime spend is left as is.`,
        );
        return;
      }
    }
    const claimed = await tx<{ key: string }[]>`
      INSERT INTO commerce.portal_settings (key, value_json) VALUES ('spent_backfill_v1', ${tx.json({ done: true })})
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `;
    if (claimed.length === 0) return;
    await tx`
      UPDATE core.quota_wallets w
         SET spent_nano_usd = w.spent_nano_usd + s.total
        FROM (
          SELECT l.user_id, -SUM(l.delta_nano_usd) AS total
            FROM core.ledger_entries l
           WHERE l.entry_kind = 'settle'
             AND l.created_at < (
               SELECT (p.value_json ->> 'at')::timestamptz
                 FROM commerce.portal_settings p
                WHERE p.key = 'spent_backfill_cutoff'
             )
           GROUP BY l.user_id
        ) s
       WHERE w.user_id = s.user_id
    `;
  });
}
