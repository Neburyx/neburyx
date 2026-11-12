CREATE TABLE audit_events (
  id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  result text NOT NULL CONSTRAINT audit_events_result_known CHECK (result IN ('success', 'denied', 'partial', 'refused', 'failed')),
  source_id text,
  investigation_id uuid,
  resource_type text,
  resource_ref text,
  trace_id text NOT NULL,
  detail jsonb,
  PRIMARY KEY (at, id)
);

CREATE INDEX audit_events_actor_at ON audit_events (actor_id, at DESC);
CREATE INDEX audit_events_action_at ON audit_events (action, at DESC);
CREATE INDEX audit_events_investigation_at ON audit_events (investigation_id, at DESC);
CREATE INDEX audit_events_source_at ON audit_events (source_id, at DESC);

-- The migration cannot name the application role, so it takes the rights that change or remove a row from every role but the owner.
DO $$
DECLARE
  holder name;
BEGIN
  FOR holder IN
    SELECT DISTINCT roles.rolname
    FROM pg_class AS tables
    CROSS JOIN LATERAL aclexplode(tables.relacl) AS granted
    JOIN pg_roles AS roles ON roles.oid = granted.grantee
    WHERE tables.oid = 'public.audit_events'::regclass AND granted.grantee <> tables.relowner
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_events FROM %I', holder);
  END LOOP;
END
$$;
