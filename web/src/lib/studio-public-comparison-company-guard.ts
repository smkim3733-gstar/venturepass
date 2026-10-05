import {
  ownedComparisonCompanyGuard as owned,
  type ComparisonCompanyGuard,
} from "./studio-comparison-company-capability";
export type { ComparisonCompanyGuard } from "./studio-comparison-company-capability";
import "server-only";
import { z } from "zod";
import { projectStoredCompany } from "./studio-company-read-projection";
import { assertVentureCompanyWritable } from "./venturein-input-lock";
import {
  comparisonStorageFail as fail,
  checkComparisonDatabasePath,
  requireComparisonDatabaseHandle,
  comparisonFileIdentity,
  comparisonRootIdentity,
} from "./studio-public-comparison-file-identity";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";

export function comparisonCompanyBinding(token: ComparisonCompanyGuard) {
  const s = owned(token);
  checkComparisonDatabasePath(s.root, s.file);
  requireComparisonDatabaseHandle(s.db, s.file);
  if (
    digest(s.identity) !== digest(comparisonFileIdentity(s.file)) ||
    digest(s.rootIdentity) !== digest(comparisonRootIdentity(s.root))
  )
    fail("COMPANY_FILE_CHANGED");
  return structuredClone({
    root: s.root,
    file: s.file,
    identity: s.identity,
    rootIdentity: s.rootIdentity,
  });
}
export function beginComparisonCompanyRead(token: ComparisonCompanyGuard, id: string) {
  const s = owned(token);
  if (s.active || s.db.isTransaction) fail("COMPANY_TRANSACTION_ACTIVE");
  comparisonCompanyBinding(token);
  z.string().uuid().parse(id);
  assertVentureCompanyWritable(id);
  s.db.exec("BEGIN IMMEDIATE");
  if (!s.db.isTransaction) fail("COMPANY_LOCK_LOST");
  s.active = true;
  try {
    const size = s.db
      .prepare("SELECT length(CAST(body AS BLOB)) AS n FROM studio_cases WHERE id=?")
      .get(id);
    if (!size || typeof size.n !== "number" || size.n > 32 * 1024 * 1024)
      fail("COMPANY_ROW_INVALID");
    const row = s.db
      .prepare("SELECT id,revision,evidence_revision,body FROM studio_cases WHERE id=?")
      .get(id);
    if (
      !row ||
      typeof row.body !== "string" ||
      !Number.isSafeInteger(row.revision) ||
      !Number.isSafeInteger(row.evidence_revision) ||
      Number(row.evidence_revision) < 0 ||
      Number(row.evidence_revision) > Number(row.revision)
    )
      fail("COMPANY_ROW_INVALID");
    const record = projectStoredCompany({
      body: row.body,
      evidence_revision: Number(row.evidence_revision),
    });
    if (row.id !== id || record.id !== id || record.revision !== row.revision)
      fail("COMPANY_ROW_INVALID");
    assertVentureCompanyWritable(id);
    return record;
  } catch (e) {
    endComparisonCompanyRead(token);
    throw e;
  }
}
export function checkComparisonCompanyRead(token: ComparisonCompanyGuard, id: string) {
  const s = owned(token);
  if (!s.active || !s.db.isTransaction) fail("COMPANY_LOCK_LOST");
  comparisonCompanyBinding(token);
  assertVentureCompanyWritable(id);
}
export function endComparisonCompanyRead(token: ComparisonCompanyGuard) {
  const s = owned(token);
  if (!s.active) return;
  try {
    if (!s.db.isTransaction) fail("COMPANY_LOCK_LOST");
    s.db.exec("ROLLBACK"); // SELECT-only transaction. Never commits changes to the company.
    if (s.db.isTransaction) fail("COMPANY_CLEANUP_REQUIRED");
    s.active = false;
  } catch {
    fail("COMPANY_CLEANUP_REQUIRED");
  }
}
