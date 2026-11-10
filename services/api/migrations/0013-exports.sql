CREATE TABLE exports (
  id uuid PRIMARY KEY,
  investigation_id uuid REFERENCES investigations (id) ON DELETE CASCADE,
  view_id uuid REFERENCES saved_views (id) ON DELETE SET NULL,
  requested_by uuid NOT NULL REFERENCES users (id),
  policy_version text NOT NULL,
  kind text NOT NULL CONSTRAINT exports_kind_known CHECK (kind IN ('view', 'table-csv', 'audit-csv')),
  format text NOT NULL CONSTRAINT exports_format_known CHECK (format IN ('json', 'csv', 'png')),
  masked boolean NOT NULL DEFAULT false,
  masked_field_count integer NOT NULL DEFAULT 0 CONSTRAINT exports_masked_field_count_positive CHECK (masked_field_count >= 0),
  status text NOT NULL DEFAULT 'pending' CONSTRAINT exports_status_known CHECK (status IN ('pending', 'ready', 'failed', 'expired')),
  filename text,
  storage_key text,
  size_bytes bigint CONSTRAINT exports_size_positive CHECK (size_bytes >= 0),
  sha256 text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT exports_audit_has_no_investigation CHECK ((kind = 'audit-csv') = (investigation_id IS NULL))
);

CREATE INDEX exports_investigation ON exports (investigation_id) WHERE investigation_id IS NOT NULL;
CREATE INDEX exports_expiry ON exports (expires_at) WHERE status = 'ready';
