CREATE TABLE source_checks (
  id uuid PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources (id),
  checked_at timestamptz NOT NULL,
  triggered_by uuid REFERENCES users (id),
  outcome text NOT NULL CONSTRAINT source_checks_outcome_known CHECK (outcome IN ('pass', 'warn', 'fail')),
  server_version text,
  read_only_check text NOT NULL CONSTRAINT source_checks_read_only_check_known CHECK (read_only_check IN ('privileges-inspected', 'write-probe', 'not-verified')),
  schema_hash text,
  report jsonb NOT NULL
);

CREATE INDEX source_checks_latest ON source_checks (source_id, checked_at DESC, id DESC);
