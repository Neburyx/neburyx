-- a named view is deleted by marking it: when, by whom and an optional note, kept with the row and returned by no read; only a named view can be marked
ALTER TABLE saved_views
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users (id),
  ADD COLUMN deletion_note text;

ALTER TABLE saved_views ADD CONSTRAINT saved_views_deletion_whole CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));
ALTER TABLE saved_views ADD CONSTRAINT saved_views_deletion_note_needs_deletion CHECK (deletion_note IS NULL OR deleted_at IS NOT NULL);
ALTER TABLE saved_views ADD CONSTRAINT saved_views_deletion_note_length CHECK (char_length(deletion_note) <= 10000);
ALTER TABLE saved_views ADD CONSTRAINT saved_views_only_named_deleted CHECK (deleted_at IS NULL OR kind = 'named');
