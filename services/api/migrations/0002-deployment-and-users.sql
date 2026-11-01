CREATE TABLE deployment (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT deployment_single_row CHECK (id),
  edition text NOT NULL CONSTRAINT deployment_edition_known CHECK (edition IN ('community', 'enterprise')),
  identity_mode text NOT NULL CONSTRAINT deployment_identity_mode_known CHECK (identity_mode IN ('none', 'sso', 'user_based')),
  initialized_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  login_name text,
  break_glass boolean NOT NULL DEFAULT false,
  display_name text NOT NULL,
  email text,
  role text CONSTRAINT users_role_known CHECK (role IN ('administrator', 'investigator', 'viewer')),
  status text NOT NULL DEFAULT 'active' CONSTRAINT users_status_known CHECK (status IN ('active', 'disabled')),
  grants_version integer NOT NULL DEFAULT 0,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_identity_unique UNIQUE (issuer, subject)
);

CREATE UNIQUE INDEX users_active_local_login_name ON users (login_name) WHERE issuer = 'local' AND status = 'active';
CREATE UNIQUE INDEX users_single_break_glass ON users (break_glass) WHERE break_glass;
