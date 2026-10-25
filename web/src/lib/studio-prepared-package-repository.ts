import { z } from "zod";
import type { SqlExecutor } from "./studio-postgres-repository";

/** A stored preparation record row: the exact JSON body and its hash. */
export type PreparedPackageRow = { body: string; body_sha256: string };
export type PreparedPackageRequestRow = PreparedPackageRow & { request_digest: string };
export type NewPreparedPackageRow = {
  id: string;
  caseId: string;
  version: number;
  clientRequestId: string;
  requestDigest: string;
  body: string;
  bodySha256: string;
  zipSha256: string;
  zipSizeBytes: number;
};

/**
 * Preserved preparation records (원고·첨부 보관본) of one organization on the web service. The
 * ZIP itself lives in private object storage; this table keeps the record and its hashes.
 */
export interface PreparedPackageRepository {
  /** Newest version first. */
  list(caseId: string): Promise<PreparedPackageRow[]>;
  get(caseId: string, packageId: string): Promise<PreparedPackageRow | null>;
  findByRequest(caseId: string, clientRequestId: string): Promise<PreparedPackageRequestRow | null>;
  count(caseId: string): Promise<number>;
  /**
   * Inserts only while the company still has `expectedCaseRevision` and exactly
   * `row.version - 1` records, so the per-company limit and version order hold under
   * concurrent requests. False when nothing was inserted.
   */
  insert(row: NewPreparedPackageRow, expectedCaseRevision: number): Promise<boolean>;
}

const uuid = z.string().uuid();

export class PostgresPreparedPackageRepository implements PreparedPackageRepository {
  constructor(
    private executor: SqlExecutor,
    private organizationId: string,
  ) {
    uuid.parse(organizationId);
  }
  async list(caseId: string) {
    if (!uuid.safeParse(caseId).success) return [];
    const { rows } = await this.executor.query<PreparedPackageRow>(
      "SELECT body, body_sha256 FROM venture_prepared_packages WHERE organization_id = $1 AND case_id = $2 ORDER BY version DESC",
      [this.organizationId, caseId],
    );
    return rows;
  }
  async get(caseId: string, packageId: string) {
    if (!uuid.safeParse(caseId).success || !uuid.safeParse(packageId).success) return null;
    const { rows } = await this.executor.query<PreparedPackageRow>(
      "SELECT body, body_sha256 FROM venture_prepared_packages WHERE organization_id = $1 AND case_id = $2 AND id = $3",
      [this.organizationId, caseId, packageId],
    );
    return rows[0] ?? null;
  }
  async findByRequest(caseId: string, clientRequestId: string) {
    if (!uuid.safeParse(caseId).success || !uuid.safeParse(clientRequestId).success) return null;
    const { rows } = await this.executor.query<PreparedPackageRequestRow>(
      "SELECT body, body_sha256, request_digest FROM venture_prepared_packages WHERE organization_id = $1 AND case_id = $2 AND client_request_id = $3",
      [this.organizationId, caseId, clientRequestId],
    );
    return rows[0] ?? null;
  }
  async count(caseId: string) {
    const { rows } = await this.executor.query<{ count: number | string }>(
      "SELECT count(*)::integer AS count FROM venture_prepared_packages WHERE organization_id = $1 AND case_id = $2",
      [this.organizationId, uuid.parse(caseId)],
    );
    return Number(rows[0]?.count ?? 0);
  }
  async insert(row: NewPreparedPackageRow, expectedCaseRevision: number) {
    uuid.parse(row.id);
    uuid.parse(row.caseId);
    const { affectedRows } = await this.executor.query(
      `INSERT INTO venture_prepared_packages
        (id, organization_id, case_id, version, client_request_id, request_digest, body, body_sha256, zip_sha256, zip_size_bytes)
      SELECT $1::uuid, c.organization_id, c.id, $4::integer, $5::uuid, $6::text, $7::text, $8::text, $9::text, $10::integer
      FROM venture_cases c
      WHERE c.id = $3::uuid AND c.organization_id = $2::uuid AND c.revision = $11::integer
        AND (SELECT count(*) FROM venture_prepared_packages p WHERE p.case_id = c.id) = $4::integer - 1
      ON CONFLICT DO NOTHING`,
      [
        row.id,
        this.organizationId,
        row.caseId,
        row.version,
        row.clientRequestId,
        row.requestDigest,
        row.body,
        row.bodySha256,
        row.zipSha256,
        row.zipSizeBytes,
        expectedCaseRevision,
      ],
    );
    return affectedRows === 1;
  }
}
