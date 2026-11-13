-- The history of a pattern: one row for each save, change, share, unshare, copy and delete.
-- A row holds the pattern's id, its source, the actor, the action and the pattern's version, and nothing else:
-- no definition, no property value and no free text, so none can be recorded here.
-- Written in every edition. pattern_id has no foreign key: the history must outlive a purged pattern.
--
-- Rollback note: migrations are forward-only. The previous image does not know this table and ignores it (the expand step),
-- so running it against this schema works. Removing the table is a later contract migration, after nothing writes it.
CREATE TABLE pattern_events (
  id uuid PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources (id),
  pattern_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users (id),
  action text NOT NULL CONSTRAINT pattern_events_action_known CHECK (action IN ('saved', 'changed', 'shared', 'unshared', 'copied', 'deleted')),
  pattern_version integer NOT NULL CONSTRAINT pattern_events_version_positive CHECK (pattern_version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX pattern_events_pattern ON pattern_events (pattern_id, created_at, id);
CREATE INDEX pattern_events_source ON pattern_events (source_id, created_at, id);

-- Append-only, in two layers. The migration cannot name the application role, so it takes the rights that change or remove a row from every role but the owner.
DO $$
DECLARE
  holder name;
BEGIN
  FOR holder IN
    SELECT DISTINCT roles.rolname
    FROM pg_class AS tables
    CROSS JOIN LATERAL aclexplode(tables.relacl) AS granted
    JOIN pg_roles AS roles ON roles.oid = granted.grantee
    WHERE tables.oid = 'public.pattern_events'::regclass AND granted.grantee <> tables.relowner
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.pattern_events FROM %I', holder);
  END LOOP;
END
$$;

-- The owner keeps its rights, so a trigger refuses the same statements for it.
CREATE FUNCTION pattern_events_are_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pattern events are append-only' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER pattern_events_no_change BEFORE UPDATE OR DELETE ON pattern_events FOR EACH ROW EXECUTE FUNCTION pattern_events_are_append_only();
CREATE TRIGGER pattern_events_no_truncate BEFORE TRUNCATE ON pattern_events FOR EACH STATEMENT EXECUTE FUNCTION pattern_events_are_append_only();
