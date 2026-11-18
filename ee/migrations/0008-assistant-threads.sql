-- The thread of one person in one investigation: references and metadata only, never the text of a question, an answer, a value or an instruction. It is cleared when the investigation is closed, archived or deleted, by the trigger at the end of this file, in the transaction of that change.
CREATE TABLE assistant_threads (
  id uuid PRIMARY KEY,
  investigation_id uuid NOT NULL REFERENCES investigations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  last_turn_at timestamptz NOT NULL,
  CONSTRAINT assistant_threads_one_per_person UNIQUE (investigation_id, user_id)
);

CREATE TABLE assistant_turns (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES assistant_threads (id) ON DELETE CASCADE,
  seq integer NOT NULL CONSTRAINT assistant_turns_seq_positive CHECK (seq >= 1),
  at timestamptz NOT NULL,
  route text NOT NULL CONSTRAINT assistant_turns_route_known CHECK (route IN ('ask', 'view', 'refuse')),
  outcome text NOT NULL CONSTRAINT assistant_turns_outcome_known CHECK (outcome IN ('answered', 'refused')),
  cause text,
  question_hash text NOT NULL CONSTRAINT assistant_turns_question_hash_hex CHECK (question_hash ~ '^[0-9a-f]{64}$'),
  intent text,
  template_id text,
  entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  citation_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  steps integer NOT NULL DEFAULT 0 CONSTRAINT assistant_turns_steps_not_negative CHECK (steps >= 0),
  model_ref text,
  prompt_version text,
  tokens_in integer CONSTRAINT assistant_turns_tokens_in_not_negative CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out integer CONSTRAINT assistant_turns_tokens_out_not_negative CHECK (tokens_out IS NULL OR tokens_out >= 0),
  run_id uuid,
  CONSTRAINT assistant_turns_seq_unique UNIQUE (thread_id, seq)
);

-- How many times an investigation has been cleared (no row: never). A turn reads it before it does any work and its write is refused when it has moved, so a turn that began before a close cannot write after it, with no comparison of clocks.
CREATE TABLE assistant_investigation_epochs (
  investigation_id uuid PRIMARY KEY REFERENCES investigations (id) ON DELETE CASCADE,
  epoch bigint NOT NULL CONSTRAINT assistant_epoch_not_negative CHECK (epoch >= 0)
);

-- The person whose thread a clearing deleted, and when, so the panel can say that a new thread began.
CREATE TABLE assistant_thread_clears (
  investigation_id uuid NOT NULL REFERENCES investigations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  cleared_at timestamptz NOT NULL,
  PRIMARY KEY (investigation_id, user_id)
);

CREATE FUNCTION assistant_clear_threads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO assistant_thread_clears (investigation_id, user_id, cleared_at)
    SELECT investigation_id, user_id, clock_timestamp() FROM assistant_threads WHERE investigation_id = NEW.id
    ON CONFLICT (investigation_id, user_id) DO UPDATE SET cleared_at = EXCLUDED.cleared_at;
  DELETE FROM assistant_threads WHERE investigation_id = NEW.id;
  INSERT INTO assistant_investigation_epochs (investigation_id, epoch) VALUES (NEW.id, 1)
    ON CONFLICT (investigation_id) DO UPDATE SET epoch = assistant_investigation_epochs.epoch + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assistant_clear_on_close
  AFTER UPDATE OF status, deleted_at ON investigations
  FOR EACH ROW
  WHEN ((NEW.status IN ('closed', 'archived') AND OLD.status IS DISTINCT FROM NEW.status) OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION assistant_clear_threads();
