CREATE TABLE ask_plans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  source_id text NOT NULL,
  turn_id uuid,
  template_id text NOT NULL,
  template_version integer NOT NULL CONSTRAINT ask_plans_version_positive CHECK (template_version >= 1),
  params jsonb NOT NULL,
  state text NOT NULL DEFAULT 'proposed' CONSTRAINT ask_plans_state_known CHECK (state IN ('proposed', 'confirmed', 'run', 'cancelled', 'expired')),
  parent_plan_id uuid REFERENCES ask_plans (id),
  planning_trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX ask_plans_user_state ON ask_plans (user_id, state);
CREATE INDEX ask_plans_proposed_expiry ON ask_plans (expires_at) WHERE state = 'proposed';

ALTER TABLE ask_runs ADD CONSTRAINT ask_runs_plan_known FOREIGN KEY (plan_id) REFERENCES ask_plans (id);

CREATE INDEX audit_events_trace ON audit_events (trace_id);
