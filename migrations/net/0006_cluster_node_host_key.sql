-- Pinned SSH host key per cluster node ("<type> <base64>"), set by the admin or recorded on the
-- first connection (trust on first use) and enforced on every later one.
-- Owned exclusively by slipgate-net (Go); PostgresVmStore.Init re-applies it on existing databases.

ALTER TABLE net.cluster_nodes
    ADD COLUMN IF NOT EXISTS ssh_host_key TEXT NOT NULL DEFAULT '';
