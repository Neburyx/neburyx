-- The class and the code of the error a failed model call threw (short codes, never a message), to tell a refused request from a dropped connection.
ALTER TABLE assistant_run_calls ADD COLUMN error_class text;
ALTER TABLE assistant_run_calls ADD COLUMN error_code text;
