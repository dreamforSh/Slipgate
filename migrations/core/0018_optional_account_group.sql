-- Accounts no longer need a group: NULL = ungrouped. Ungrouped accounts stay testable and editable
-- but only composite groups (which draw on every account of a platform) schedule them.
-- Deleting a group ungroups its accounts instead of cascading the delete onto them.
-- Idempotent; the BFF applies the same statements at startup.

ALTER TABLE core.accounts ALTER COLUMN group_id DROP NOT NULL;

DO $$
DECLARE
    fk record;
BEGIN
    FOR fk IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.conrelid = 'core.accounts'::regclass
          AND c.contype = 'f'
          AND c.confrelid = 'core.groups'::regclass
          AND a.attname = 'group_id'
          AND c.confdeltype <> 'n'
    LOOP
        EXECUTE format('ALTER TABLE core.accounts DROP CONSTRAINT %I', fk.conname);
        EXECUTE format(
            'ALTER TABLE core.accounts ADD CONSTRAINT %I FOREIGN KEY (group_id) REFERENCES core.groups(id) ON DELETE SET NULL',
            fk.conname
        );
    END LOOP;
END $$;
