CREATE TABLE IF NOT EXISTS venture_organizations (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS venture_cases (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES venture_organizations(id) ON DELETE RESTRICT,
    revision integer NOT NULL CHECK (revision >= 0),
    evidence_revision integer NOT NULL CHECK (evidence_revision >= 0 AND evidence_revision <= revision),
    body text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

CREATE INDEX IF NOT EXISTS venture_cases_org_updated
    ON venture_cases (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS venture_memberships (
    user_id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES venture_organizations(id) ON DELETE RESTRICT,
    email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
    role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    status text NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS venture_prepared_packages (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES venture_organizations(id) ON DELETE RESTRICT,
    case_id uuid NOT NULL REFERENCES venture_cases(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version BETWEEN 1 AND 20),
    client_request_id uuid NOT NULL,
    request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
    body text NOT NULL,
    body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
    zip_sha256 text NOT NULL CHECK (zip_sha256 ~ '^[a-f0-9]{64}$'),
    zip_size_bytes integer NOT NULL CHECK (zip_size_bytes > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (case_id, version),
    UNIQUE (case_id, client_request_id)
  );

ALTER TABLE venture_organizations ENABLE ROW LEVEL SECURITY;

ALTER TABLE venture_cases ENABLE ROW LEVEL SECURITY;

ALTER TABLE venture_memberships ENABLE ROW LEVEL SECURITY;

ALTER TABLE venture_prepared_packages ENABLE ROW LEVEL SECURITY;
