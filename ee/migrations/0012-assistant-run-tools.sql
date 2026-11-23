-- The names of the tools the model was bound to for each call of an assistant turn (names only, comma-joined, never a schema or a value), so that the offered tools of a live turn are a record.
ALTER TABLE assistant_run_calls ADD COLUMN tools_offered text;
