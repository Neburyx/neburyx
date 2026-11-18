-- What an assistant turn sent to the model and what came back, per request to the provider. It holds real names and values and the model's own text, so it is read by no route and removed after the retention period.
CREATE TABLE assistant_runs (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  investigation_id uuid,
  source_id text NOT NULL,
  trace_id text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text,
  calls integer NOT NULL DEFAULT 0,
  settings jsonb NOT NULL
);

CREATE INDEX assistant_runs_started_at ON assistant_runs (started_at);
CREATE INDEX assistant_runs_trace_id ON assistant_runs (trace_id);

CREATE TABLE assistant_run_calls (
  run_id uuid NOT NULL REFERENCES assistant_runs (id) ON DELETE CASCADE,
  call_number integer NOT NULL,
  started_at timestamptz NOT NULL,
  duration_ms integer,
  instructions_sha256 text NOT NULL,
  instructions_text text NOT NULL,
  values_text text NOT NULL,
  reply_text text,
  status text,
  failure_kind text,
  tokens_in integer,
  tokens_out integer,
  PRIMARY KEY (run_id, call_number)
);
