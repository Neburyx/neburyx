-- A confirmation of a heavy step of the assistant that waits for the analyst: who it is for, where, and whether it is still open. References and metadata only: never a value, an element, a result, the text of a question or the plan the panel holds. A row makes the signed plan single-use and holds one waiting confirmation per person; it is removed with its investigation, and with a close, an archive or a delete of it. Expired rows of a person are deleted when that person adds or decides a confirmation: no timer runs.
CREATE TABLE assistant_pending_confirmations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  investigation_id uuid NOT NULL REFERENCES investigations (id) ON DELETE CASCADE,
  source_id text NOT NULL,
  mask boolean NOT NULL,
  status text NOT NULL CONSTRAINT assistant_pending_status_known CHECK (status IN ('waiting', 'used', 'dropped')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX assistant_pending_one_waiting_per_person ON assistant_pending_confirmations (user_id) WHERE status = 'waiting';
CREATE INDEX assistant_pending_by_investigation ON assistant_pending_confirmations (investigation_id);

-- A thread keeps the turn that stopped to wait for a decision as a turn of its own, so the panel can say after a reload that it was waiting.
ALTER TABLE assistant_turns DROP CONSTRAINT assistant_turns_outcome_known;
ALTER TABLE assistant_turns ADD CONSTRAINT assistant_turns_outcome_known CHECK (outcome IN ('answered', 'refused', 'waiting'));

CREATE OR REPLACE FUNCTION assistant_clear_threads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO assistant_thread_clears (investigation_id, user_id, cleared_at)
    SELECT investigation_id, user_id, clock_timestamp() FROM assistant_threads WHERE investigation_id = NEW.id
    ON CONFLICT (investigation_id, user_id) DO UPDATE SET cleared_at = EXCLUDED.cleared_at;
  DELETE FROM assistant_threads WHERE investigation_id = NEW.id;
  DELETE FROM assistant_pending_confirmations WHERE investigation_id = NEW.id;
  INSERT INTO assistant_investigation_epochs (investigation_id, epoch) VALUES (NEW.id, 1)
    ON CONFLICT (investigation_id) DO UPDATE SET epoch = assistant_investigation_epochs.epoch + 1;
  RETURN NEW;
END;
$$;
