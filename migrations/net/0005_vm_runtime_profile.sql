-- Additive VM runtime persona profile (claude_code, codex_cli, antigravity) and encrypted auth JSON seed column.
-- Owned exclusively by slipgate-net (Go).

ALTER TABLE net.vm_slots
    ADD COLUMN IF NOT EXISTS runtime_profile TEXT NOT NULL DEFAULT 'claude_code'
        CHECK (runtime_profile IN ('claude_code', 'codex_cli', 'antigravity'));

ALTER TABLE net.vm_slot_seeds
    ADD COLUMN IF NOT EXISTS auth_json_enc BYTEA;
