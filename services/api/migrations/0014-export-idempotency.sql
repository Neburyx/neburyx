-- the first answer to an export request, kept for 24 hours per person and key so a retry returns it and never builds a second file
CREATE TABLE export_idempotency (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key text NOT NULL CONSTRAINT export_idempotency_key_shape CHECK (key ~ '^[A-Za-z0-9_-]{16,64}$'),
  fingerprint text NOT NULL,
  policy_version text NOT NULL,
  state text NOT NULL DEFAULT 'running' CONSTRAINT export_idempotency_state_known CHECK (state IN ('running', 'done')),
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key),
  CONSTRAINT export_idempotency_done_has_answer CHECK ((state = 'done') = (status_code IS NOT NULL AND response IS NOT NULL))
);

CREATE INDEX export_idempotency_created ON export_idempotency (created_at);
