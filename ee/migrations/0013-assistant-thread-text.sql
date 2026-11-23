-- The text of a turn of the assistant's thread: the question as the person typed it, the answer in its stored form (ordered blocks, each item kept as written and flagged by how it may be returned), whether the request asked for the mask, and the version of the sensitivity of the mapping the items were classified under (null: not classified). It is the person's own thread: cleared with it, by the trigger of 0008, when the investigation is closed, archived or deleted, and read only by the thread route. Rows written before this file keep null in all four columns.
-- Rollback (by hand, before any later file depends on it): ALTER TABLE assistant_turns DROP COLUMN question_text, DROP COLUMN mask_on, DROP COLUMN answer, DROP COLUMN sensitivity_version; no other table is touched.
ALTER TABLE assistant_turns
  ADD COLUMN question_text text CONSTRAINT assistant_turns_question_bounded CHECK (question_text IS NULL OR (char_length(question_text) BETWEEN 1 AND 4000)),
  ADD COLUMN mask_on boolean,
  ADD COLUMN answer jsonb CONSTRAINT assistant_turns_answer_object CHECK (answer IS NULL OR jsonb_typeof(answer) = 'object'),
  ADD COLUMN sensitivity_version text CONSTRAINT assistant_turns_sensitivity_version_short CHECK (sensitivity_version IS NULL OR char_length(sensitivity_version) <= 200);
