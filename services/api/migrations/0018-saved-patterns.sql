-- A pattern a person saved on a source: either a built-in run (kind 'preset-run': a template, its version and its parameters) or a pattern built in the app
-- (kind 'definition': a declarative structure). Both hold structures, never query text. A held starting entity is two text columns, as on investigations;
-- the stable id is the stored form of the reference (the token of a keyed type), never a raw value.
--
-- Rollback note: migrations are forward-only. The previous image does not know this table and ignores it (the expand step),
-- so running it against this schema works. Removing the table is a later contract migration, after nothing writes it.
CREATE TABLE saved_patterns (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users (id),
  source_id text NOT NULL REFERENCES sources (id),
  name text NOT NULL CONSTRAINT saved_patterns_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  kind text NOT NULL CONSTRAINT saved_patterns_kind_known CHECK (kind IN ('preset-run', 'definition')),
  preset_id text,
  template_id text,
  template_version integer CONSTRAINT saved_patterns_template_version_positive CHECK (template_version >= 1),
  params jsonb,
  definition jsonb,
  ask_for_starting_entity boolean NOT NULL,
  anchor_entity_type text,
  anchor_stable_id text,
  visibility text NOT NULL DEFAULT 'private' CONSTRAINT saved_patterns_visibility_known CHECK (visibility IN ('private', 'shared')),
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  purge_after timestamptz,
  version integer NOT NULL DEFAULT 1 CONSTRAINT saved_patterns_version_positive CHECK (version >= 1),
  CONSTRAINT saved_patterns_one_shape CHECK (
    (kind = 'definition' AND definition IS NOT NULL AND template_id IS NULL AND template_version IS NULL AND params IS NULL AND preset_id IS NULL)
    OR (kind = 'preset-run' AND definition IS NULL AND template_id IS NOT NULL AND template_version IS NOT NULL AND params IS NOT NULL)
  ),
  CONSTRAINT saved_patterns_anchor_whole CHECK ((anchor_entity_type IS NULL) = (anchor_stable_id IS NULL)),
  CONSTRAINT saved_patterns_ask_matches_anchor CHECK (ask_for_starting_entity = (anchor_entity_type IS NULL)),
  CONSTRAINT saved_patterns_deletion_whole CHECK ((deleted_at IS NULL) = (purge_after IS NULL))
);

CREATE INDEX saved_patterns_owner_source ON saved_patterns (owner_id, source_id, updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX saved_patterns_purge ON saved_patterns (purge_after) WHERE deleted_at IS NOT NULL;
