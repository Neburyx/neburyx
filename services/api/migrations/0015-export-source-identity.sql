-- the identity of the source an export was made from, so a download can tell that the source was re-pointed since; null for an export made before this column
ALTER TABLE exports ADD COLUMN source_identity_hash text;
