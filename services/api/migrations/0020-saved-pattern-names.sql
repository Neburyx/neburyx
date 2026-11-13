-- A person's saved patterns on a source have names that differ: the same name, ignoring case, spaces at its ends and Unicode form, is taken once among the patterns that are not deleted.
-- A pattern that already shares its name with an older one of the same person and source is renamed first: the oldest keeps its name, each later one gets " (2)", " (3)" and so on
-- (the name cut to fit the limit of 100 characters, and a number that no other of the person's patterns on the source uses), its version goes up by one, its updated time moves (so it moves in the list),
-- and one `changed` event is written for it with the owner as the actor. These events are written by the migration, so they are not passed to an audit sink.
-- Needs PostgreSQL 13 or later and a UTF-8 database (the name is normalized to Unicode form C before it is lowered).
--
-- Rollback note: migrations are forward-only. The previous image does not know the index: a second save of a name it holds fails there with an internal error,
-- and the previous image writes no name that breaks the index except by a repeat of one. Removing the index is a later contract migration.
DO $$
DECLARE
  dup record;
  attempt integer;
  suffix text;
  candidate text;
BEGIN
  FOR dup IN
    SELECT id, owner_id, source_id, name, version
    FROM (
      SELECT id, owner_id, source_id, name, version,
             row_number() OVER (PARTITION BY owner_id, source_id, lower(normalize(btrim(name), NFC)) ORDER BY created_at, id) AS place
      FROM saved_patterns
      WHERE deleted_at IS NULL
    ) ranked
    WHERE place > 1
    ORDER BY owner_id, source_id, place
  LOOP
    attempt := 2;
    LOOP
      suffix := ' (' || attempt || ')';
      candidate := rtrim(left(btrim(dup.name), 100 - char_length(suffix))) || suffix;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM saved_patterns other
        WHERE other.owner_id = dup.owner_id AND other.source_id = dup.source_id AND other.deleted_at IS NULL AND other.id <> dup.id
          AND lower(normalize(btrim(other.name), NFC)) = lower(normalize(candidate, NFC))
      );
      attempt := attempt + 1;
    END LOOP;
    UPDATE saved_patterns SET name = candidate, version = version + 1, updated_at = clock_timestamp() WHERE id = dup.id;
    INSERT INTO pattern_events (id, source_id, pattern_id, actor_id, action, pattern_version)
    VALUES (gen_random_uuid(), dup.source_id, dup.id, dup.owner_id, 'changed', dup.version + 1);
  END LOOP;
END
$$;

CREATE UNIQUE INDEX saved_patterns_owner_name ON saved_patterns (owner_id, source_id, lower(normalize(btrim(name), NFC))) WHERE deleted_at IS NULL;
