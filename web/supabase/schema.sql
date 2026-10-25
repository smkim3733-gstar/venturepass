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

ALTER TABLE venture_organizations ENABLE ROW LEVEL SECURITY;

ALTER TABLE venture_cases ENABLE ROW LEVEL SECURITY;

ALTER TABLE venture_memberships ENABLE ROW LEVEL SECURITY;
