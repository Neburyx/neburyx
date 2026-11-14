-- A run now names the intent it ran. Rows written before this have none to name, so they are marked unknown; the column is then required, with no default.
ALTER TABLE ask_runs ADD COLUMN intent text;
UPDATE ask_runs SET intent = 'unknown';
ALTER TABLE ask_runs ALTER COLUMN intent SET NOT NULL;
