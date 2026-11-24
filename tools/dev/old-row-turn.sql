-- Makes the newest turn of an investigation's thread an old row: a turn stored before the thread kept text. The four text columns of a turn (the question, the mask state, the answer and the sensitivity version) become null, and nothing else of the row changes.
-- Run it with `old-row-turn.sh`, which refuses any database that is not a nbx_test_ one; never against a shared database.
-- psql variable: investigation (the id of the investigation).
UPDATE assistant_turns
SET question_text = NULL, mask_on = NULL, answer = NULL, sensitivity_version = NULL
WHERE id = (
  SELECT t.id
  FROM assistant_turns t
  JOIN assistant_threads h ON h.id = t.thread_id
  WHERE h.investigation_id = :'investigation'
  ORDER BY t.seq DESC
  LIMIT 1
);
