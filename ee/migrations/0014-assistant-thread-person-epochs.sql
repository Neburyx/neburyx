-- How many times a person has cleared their own thread of an investigation (no row: never). A turn reads the sum of this count and the investigation's own count (assistant_investigation_epochs) before it does any work, and a write of its thread or of its run record that finds the sum moved is refused or written without text, so a turn that began before a person cleared their thread cannot store anything after it. Both counts only grow: a row here is kept when the investigation is closed, archived or deleted (the trigger of 0008 does not touch it) and goes only when the investigation row itself is deleted, so the sum never takes a value a turn already holds.
-- The run record keeps the sum its turn read, so a late write of the text of a model call can be told from one that belongs to the thread as it is.
-- Rollback (by hand, before any later file depends on it): ALTER TABLE assistant_runs DROP COLUMN thread_epoch; DROP TABLE assistant_thread_person_epochs; no other table is touched.
CREATE TABLE assistant_thread_person_epochs (
  investigation_id uuid NOT NULL REFERENCES investigations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  epoch bigint NOT NULL CONSTRAINT assistant_person_epoch_not_negative CHECK (epoch >= 0),
  PRIMARY KEY (investigation_id, user_id)
);

ALTER TABLE assistant_runs ADD COLUMN thread_epoch bigint CONSTRAINT assistant_runs_thread_epoch_not_negative CHECK (thread_epoch IS NULL OR thread_epoch >= 0);
