-- The list of a person's chats reads their threads newest last turn first and pages by (last_turn_at, id). The table has only the unique index on (investigation_id, user_id), so the list would scan every thread of every person.
-- Rollback (by hand, before any later file depends on it): DROP INDEX assistant_threads_by_person_recent; no other object is touched.
CREATE INDEX assistant_threads_by_person_recent ON assistant_threads (user_id, last_turn_at DESC, id DESC);
