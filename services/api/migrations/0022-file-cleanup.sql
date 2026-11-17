-- The storage keys of export files whose rows a purge deleted, kept until the files are gone. A purge writes them in the
-- transaction that deletes the investigation and writes its audit event; a task then removes the files after the commit
-- and deletes a row only when its file is gone. A row holds a key and a time, never a value.
--
-- Rollback note: migrations are forward-only. The previous image does not know this table and ignores it (the expand step):
-- it removes the files itself before it deletes, so running it against this schema works. Removing the table is a later
-- contract migration, after nothing writes it.
CREATE TABLE file_cleanup (
  storage_key text PRIMARY KEY CONSTRAINT file_cleanup_key_not_empty CHECK (storage_key <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A cleanup record is written once and deleted once, never changed. The migration cannot name the application role, so it takes the rights that
-- change or empty the table from every role but the owner.
DO $$
DECLARE
  holder name;
BEGIN
  FOR holder IN
    SELECT DISTINCT roles.rolname
    FROM pg_class AS tables
    CROSS JOIN LATERAL aclexplode(tables.relacl) AS granted
    JOIN pg_roles AS roles ON roles.oid = granted.grantee
    WHERE tables.oid = 'public.file_cleanup'::regclass AND granted.grantee <> tables.relowner
  LOOP
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON public.file_cleanup FROM %I', holder);
  END LOOP;
END
$$;
