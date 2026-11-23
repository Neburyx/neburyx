-- The sentences the checks removed from a reply of a summary click, with the reason, one row each, in the order the reply held them. It holds the model's own text, so it is read by no route and removed with its run after the retention period.
CREATE TABLE summary_run_removals (
  run_id uuid NOT NULL REFERENCES summary_runs (id) ON DELETE CASCADE,
  call_number integer NOT NULL,
  position integer NOT NULL,
  text text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('verdict', 'key', 'citation', 'number', 'count', 'comparison', 'name', 'label', 'cell', 'row')),
  PRIMARY KEY (run_id, call_number, position)
);
