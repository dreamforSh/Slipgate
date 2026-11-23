-- group C: payments, refunds, rebates.
-- Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup
-- (store/postgres_payments.ts PG_PAYMENTS_INTEGRITY_SQL, part of PG_PAYMENTS_SCHEMA_SQL).

-- What a paid order delivered, so a refund can take exactly that back, and paid orders whose
-- delivery failed (subscription group deleted or switched to balance billing after the order was
-- placed): the payment is still accepted and the order flagged for the admin.
ALTER TABLE commerce.payment_orders
    ADD COLUMN IF NOT EXISTS subscription_id TEXT,
    ADD COLUMN IF NOT EXISTS delivery_error TEXT;

-- Rebates reversed by a refund keep their row (status 'reversed') next to the ledger debit
-- `rebate-refund:<order>` on the referrer's wallet.
ALTER TABLE commerce.affiliate_commissions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_commerce_affiliate_commissions_order ON commerce.affiliate_commissions (source_order_id);

-- One-off scrub of secrets the audit-log redaction used to keep: the EasyPay merchant `key` of
-- PATCH /api/v1/admin/payments/config (and any other *Key / *Pem string field) and PEM private keys.
DO $$
BEGIN
    IF to_regclass('commerce.audit_logs') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM commerce.portal_settings WHERE key = 'audit_secret_scrub_v1') THEN
        UPDATE commerce.audit_logs
           SET request_body = regexp_replace(
                   regexp_replace(request_body, '"([A-Za-z0-9_-]*(?:[Kk]eys?|[Pp]em))":"(?:\\.|[^"\\])+("|$)', '"\1":"[redacted]"', 'g'),
                   '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\\.|[^"\\])*', '[redacted]', 'g')
         WHERE request_body ~ '"[A-Za-z0-9_-]*(?:[Kk]eys?|[Pp]em)":"' OR request_body LIKE '%PRIVATE KEY-----%';
        INSERT INTO commerce.portal_settings (key, value_json) VALUES ('audit_secret_scrub_v1', '{"done": true}'::jsonb)
        ON CONFLICT (key) DO NOTHING;
    END IF;
END $$;
-- The BFF then runs its full current redaction once over every stored row at startup
-- (scrubStoredAuditSecrets, marker audit_secret_scrub_v2): credentials in URLs, bearer tokens,
-- JWTs and API-key shapes in free text, signature/mnemonic/otp fields.

-- Orders refunded before refunds reversed the referrer's rebate: reverse those rebates now, once,
-- exactly as a refund does today (ledger debit `rebate-refund:<order>` on the referrer when the
-- `rebate:<order>` credit was paid, commission marked 'reversed'), so a refunded order never
-- counts as earned rebate. The ledger key keeps it idempotent; FOR UPDATE serialises racing runs.
DO $$
DECLARE
    r RECORD;
    after_balance NUMERIC;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM commerce.portal_settings WHERE key = 'rebate_refund_backfill_v1') THEN
        FOR r IN
            SELECT c.id, c.beneficiary_id, c.source_order_id, c.amount_nano_usd
              FROM commerce.affiliate_commissions c
              JOIN commerce.payment_orders o ON o.id = c.source_order_id
             WHERE o.status = 'refunded' AND c.status <> 'reversed'
             ORDER BY c.created_at
               FOR UPDATE OF c
        LOOP
            IF r.amount_nano_usd > 0
               AND EXISTS (SELECT 1 FROM core.ledger_entries WHERE idempotency_key = 'rebate:' || r.source_order_id)
               AND NOT EXISTS (SELECT 1 FROM core.ledger_entries WHERE idempotency_key = 'rebate-refund:' || r.source_order_id) THEN
                INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
                VALUES (r.beneficiary_id, 0, 0) ON CONFLICT (user_id) DO NOTHING;
                UPDATE core.quota_wallets
                   SET balance_nano_usd = balance_nano_usd - r.amount_nano_usd, updated_at = NOW()
                 WHERE user_id = r.beneficiary_id
                RETURNING balance_nano_usd INTO after_balance;
                INSERT INTO core.ledger_entries (id, idempotency_key, user_id, entry_kind, delta_nano_usd, balance_after_nano, metadata)
                VALUES ('ldg_' || gen_random_uuid()::text, 'rebate-refund:' || r.source_order_id, r.beneficiary_id, 'adjust',
                        -r.amount_nano_usd, after_balance, jsonb_build_object('reason', 'rebate-refund:' || r.source_order_id));
            END IF;
            UPDATE commerce.affiliate_commissions SET status = 'reversed', reversed_at = NOW() WHERE id = r.id;
        END LOOP;
        INSERT INTO commerce.portal_settings (key, value_json) VALUES ('rebate_refund_backfill_v1', '{"done": true}'::jsonb)
        ON CONFLICT (key) DO NOTHING;
    END IF;
END $$;
