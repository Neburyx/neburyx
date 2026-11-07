-- the longest stored reference: the token of a value of 100,000 UTF-16 code units (266,691 characters); an ID of any other type is at most 100,000 units too, and its encoded form (4 characters of marker and base64url of 200,000 bytes) is shorter
ALTER TABLE investigations DROP CONSTRAINT investigations_stable_id_length;
ALTER TABLE investigations ADD CONSTRAINT investigations_stable_id_length CHECK (char_length(starting_stable_id) BETWEEN 1 AND 266691);
