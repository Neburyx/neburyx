-- The shared patterns of a source, for the list that shows other people's shared patterns beside a person's own:
-- newest changed first, then by id, only the rows that are shared and not deleted.
--
-- Rollback note: migrations are forward-only. The previous image does not use this index and ignores it (the expand step),
-- so running it against this schema works. Removing the index is a later contract migration.
CREATE INDEX saved_patterns_shared_source ON saved_patterns (source_id, updated_at DESC, id) WHERE visibility = 'shared' AND deleted_at IS NULL;
