-- group F: email codes, invitations, subscriptions.
-- Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
--
-- Integrity of the ops/commerce flows lives in the statements themselves, so this file has little
-- to add to the schema:
--   * email codes: every guess spends an attempt with a conditional UPDATE (row-locked, attempts < 5)
--     before it is compared, so at most five guesses are ever evaluated per code;
--   * invitation codes: a registration claims the code with UPDATE ... WHERE status = 'unused'
--     RETURNING before the user is created (one winner among concurrent registrations);
--   * subscription grants: a transaction-scoped advisory lock per (user, group) serialises grants,
--     so concurrent grants stack validity on one subscription instead of inserting two.
--
-- Custom (bring-your-own) API keys: only the first four characters are kept for display. Keys
-- created before this stored their first 8 and last 4 characters, i.e. 12 of a 16-character key.
-- Generated keys (sk-sg-<6 hex>...<4 hex> of a 160-bit random key) keep their prefix.
-- Mirrored in services/bff-ts/src/store/postgres_ops.ts PG_OPS_SCHEMA_SQL.

UPDATE core.api_keys
   SET key_prefix = left(key_prefix, 4) || '...'
 WHERE key_prefix !~ '^sk-sg-[0-9a-f]{6}[.][.][.][0-9a-f]{4}$'
   AND key_prefix !~ '^.{0,4}[.][.][.]$';
