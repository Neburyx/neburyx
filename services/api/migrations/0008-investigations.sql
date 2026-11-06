CREATE TABLE investigations (
  id uuid PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources (id),
  source_identity_hash text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  title text NOT NULL CONSTRAINT investigations_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  case_ref text CONSTRAINT investigations_case_ref_length CHECK (char_length(case_ref) BETWEEN 1 AND 100),
  starting_entity_type text,
  starting_stable_id text CONSTRAINT investigations_stable_id_length CHECK (char_length(starting_stable_id) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'open' CONSTRAINT investigations_status_known CHECK (status IN ('open', 'closed', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_edited_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  purge_after timestamptz,
  deleted_by uuid REFERENCES users (id),
  version integer NOT NULL DEFAULT 1 CONSTRAINT investigations_version_positive CHECK (version >= 1),
  CONSTRAINT investigations_starting_entity_whole CHECK ((starting_entity_type IS NULL) = (starting_stable_id IS NULL))
);

CREATE INDEX investigations_owner_edited ON investigations (owner_id, last_edited_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX investigations_source_edited ON investigations (source_id, last_edited_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX investigations_title_trigram ON investigations USING gin (title gin_trgm_ops);
CREATE INDEX investigations_case_ref_trigram ON investigations USING gin (case_ref gin_trgm_ops);
CREATE INDEX investigations_open_case_ref ON investigations (owner_id, source_id, case_ref) WHERE status = 'open' AND deleted_at IS NULL;

CREATE TABLE saved_views (
  id uuid PRIMARY KEY,
  investigation_id uuid NOT NULL REFERENCES investigations (id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT saved_views_kind_known CHECK (kind IN ('draft', 'named')),
  name text CONSTRAINT saved_views_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  notes text CONSTRAINT saved_views_notes_length CHECK (char_length(notes) <= 10000),
  ai_notes jsonb,
  layout jsonb NOT NULL,
  query_context jsonb NOT NULL,
  mapping_hash text NOT NULL,
  content_hash text NOT NULL,
  based_on_view_id uuid REFERENCES saved_views (id) ON DELETE SET NULL,
  node_count integer NOT NULL DEFAULT 0 CONSTRAINT saved_views_node_count_positive CHECK (node_count >= 0),
  edge_count integer NOT NULL DEFAULT 0 CONSTRAINT saved_views_edge_count_positive CHECK (edge_count >= 0),
  counts_policy_version text NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CONSTRAINT saved_views_version_positive CHECK (version >= 1),
  CONSTRAINT saved_views_named_has_name CHECK (kind <> 'named' OR name IS NOT NULL)
);

CREATE UNIQUE INDEX saved_views_one_draft ON saved_views (investigation_id, created_by) WHERE kind = 'draft';
CREATE INDEX saved_views_investigation ON saved_views (investigation_id);
