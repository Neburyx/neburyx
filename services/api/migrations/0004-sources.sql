CREATE TABLE sources (
  id text PRIMARY KEY,
  alias text NOT NULL,
  connector text NOT NULL CONSTRAINT sources_connector_known CHECK (connector IN ('neo4j')),
  uri text NOT NULL,
  database text NOT NULL,
  secret_ref text NOT NULL,
  synthetic boolean NOT NULL DEFAULT false,
  config_hash text NOT NULL,
  identity_hash text NOT NULL,
  state text NOT NULL DEFAULT 'unknown' CONSTRAINT sources_state_known CHECK (state IN ('connected', 'degraded', 'unavailable', 'unknown')),
  state_reason text,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
