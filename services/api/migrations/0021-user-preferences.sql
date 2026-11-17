-- Small per-user display settings that carry no security weight (the tour's completion first). One row for each user and key.
-- A row is deleted with its user. Written in every edition.
--
-- Rollback note: migrations are forward-only. The previous image does not know this table and ignores it (the expand step),
-- so running it against this schema works. Removing the table is a later contract migration, after nothing writes it.
CREATE TABLE user_preferences (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
