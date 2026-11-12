-- plan_id has no foreign key: the table of plans does not exist yet.
CREATE TABLE ask_runs (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users (id),
  outcome text NOT NULL CONSTRAINT ask_runs_outcome_known CHECK (outcome IN ('complete', 'partial', 'failed')),
  row_count integer NOT NULL CONSTRAINT ask_runs_row_count_not_negative CHECK (row_count >= 0),
  elapsed_ms integer NOT NULL CONSTRAINT ask_runs_elapsed_not_negative CHECK (elapsed_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
