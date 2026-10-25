import { z } from "zod";
import { StudioError } from "./studio-http";
import type { CaseRowRepository } from "./studio-case-session";
import type { CaseRowSnapshot } from "./studio-storage";

/** Minimal parameterized query surface, satisfied by `postgres` adapters and PGlite. */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Row[]; affectedRows: number }>;
}

/**
 * The body is `text`, not `jsonb`: jsonb reorders keys, and the store compares and
 * re-parses the exact JSON it wrote.
 */
export const venturePassSchemaSql = [
  `CREATE TABLE IF NOT EXISTS venture_organizations (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS venture_cases (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES venture_organizations(id) ON DELETE RESTRICT,
    revision integer NOT NULL CHECK (revision >= 0),
    evidence_revision integer NOT NULL CHECK (evidence_revision >= 0 AND evidence_revision <= revision),
    body text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS venture_cases_org_updated
    ON venture_cases (organization_id, updated_at DESC)`,
  // One organization per staff account. user_id is the identity provider's user id; passwords
  // are never stored here. Only an admin-approved "active" member can use the service.
  `CREATE TABLE IF NOT EXISTS venture_memberships (
    user_id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES venture_organizations(id) ON DELETE RESTRICT,
    email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
    role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    status text NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Supabase exposes the public schema over its REST API with the anon key. Row level security
  // with no policies denies that path entirely; the server connects as the database owner.
  `ALTER TABLE venture_organizations ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE venture_cases ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE venture_memberships ENABLE ROW LEVEL SECURITY`,
];

/** The same statements as one script for the Supabase SQL editor (web/supabase/schema.sql). */
export function venturePassSchemaScript() {
  return `${venturePassSchemaSql.map((statement) => `${statement};`).join("\n\n")}\n`;
}

export async function ensureVenturePassSchema(executor: SqlExecutor) {
  for (const statement of venturePassSchemaSql) await executor.query(statement);
}

const uuid = z.string().uuid();
type Row = { id: string; revision: number; evidence_revision: number; body: string };
const toSnapshot = (row: Row): CaseRowSnapshot => ({
  id: row.id,
  revision: Number(row.revision),
  evidenceRevision: Number(row.evidence_revision),
  body: row.body,
});
const notFound = () => new StudioError("기업을 찾을 수 없습니다.", 404, "NOT_FOUND");

/**
 * Company rows of exactly one organization. A case of another organization is reported as
 * not found, so its existence is never revealed.
 */
export class PostgresCaseRowRepository implements CaseRowRepository {
  constructor(
    private executor: SqlExecutor,
    private organizationId: string,
  ) {
    uuid.parse(organizationId);
  }
  async list() {
    const { rows } = await this.executor.query<Row>(
      "SELECT id, revision, evidence_revision, body FROM venture_cases WHERE organization_id = $1 ORDER BY updated_at DESC",
      [this.organizationId],
    );
    return rows.map(toSnapshot);
  }
  async load(id: string) {
    if (!uuid.safeParse(id).success) throw notFound();
    const { rows } = await this.executor.query<Row>(
      "SELECT id, revision, evidence_revision, body FROM venture_cases WHERE id = $1 AND organization_id = $2",
      [id, this.organizationId],
    );
    if (rows.length !== 1) throw notFound();
    return toSnapshot(rows[0]);
  }
  async insert(row: CaseRowSnapshot) {
    uuid.parse(row.id);
    await this.executor.query(
      "INSERT INTO venture_cases (id, organization_id, revision, evidence_revision, body) VALUES ($1, $2, $3, $4, $5)",
      [row.id, this.organizationId, row.revision, row.evidenceRevision, row.body],
    );
  }
  async compareAndSwap(expectedRevision: number, row: CaseRowSnapshot) {
    const { affectedRows } = await this.executor.query(
      "UPDATE venture_cases SET revision = $1, evidence_revision = $2, body = $3, updated_at = now() WHERE id = $4 AND organization_id = $5 AND revision = $6",
      [row.revision, row.evidenceRevision, row.body, row.id, this.organizationId, expectedRevision],
    );
    return affectedRows === 1;
  }
  async remove(id: string, expectedRevision: number) {
    const { affectedRows } = await this.executor.query(
      "DELETE FROM venture_cases WHERE id = $1 AND organization_id = $2 AND revision = $3",
      [id, this.organizationId, expectedRevision],
    );
    return affectedRows === 1;
  }
}
