import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { originalObjectKey, type OriginalObjectStore } from "./studio-original-store";
import { PostgresCaseRowRepository, type SqlExecutor } from "./studio-postgres-repository";
import { StudioStore, type CaseRowSnapshot } from "./studio-storage";

/**
 * One-way copy of this PC app's companies to one organization of the web service.
 * The local data is only read. The web copy is never overwritten: a company that already
 * exists there is skipped, and a probable duplicate (same business number or name) is
 * skipped unless explicitly allowed.
 */
export type WebMigrationOptions = {
  /** The PC app data folder (`web/.venture-pass` unless VENTURE_DATA_DIR says otherwise). */
  dataDirectory: string;
  organizationId: string;
  executor: SqlExecutor;
  originals: OriginalObjectStore;
  /** False (default) only checks and reports; nothing is written anywhere. */
  apply?: boolean;
  /** Limit to these local company ids. */
  caseIds?: string[];
  /** Local company ids to copy even though a similar company is already on the web. */
  allowDuplicateCaseIds?: string[];
};

export type CaseOutcome =
  | "ready"
  | "migrated"
  | "already-migrated"
  | "changed-on-web"
  | "other-organization"
  | "duplicate-company"
  | "invalid-record"
  | "original-missing"
  | "failed";

export type CaseMigrationReport = {
  caseId: string;
  companyName: string;
  outcome: CaseOutcome;
  originals: number;
  message: string;
  duplicateOf?: string;
};

export type WebMigrationReport = {
  organization: { id: string; name: string };
  apply: boolean;
  cases: CaseMigrationReport[];
  /** PC-only data that stays on this PC. */
  notMigrated: {
    ventureAccounts: number;
    ventureWorkflows: number;
    preparedPackages: number;
    intakeOnlyOriginals: number;
  };
};

export class WebMigrationError extends Error {
  override name = "WebMigrationError";
}

const uuid = z.string().uuid();
const maxOriginalBytes = 64 * 1024 * 1024;
const messages: Record<CaseOutcome, string> = {
  ready: "옮길 수 있습니다(미리 보기).",
  migrated: "웹 서비스로 옮겼습니다.",
  "already-migrated": "이미 같은 내용으로 옮겨져 있습니다.",
  "changed-on-web": "웹에 같은 기업이 있고 내용이 다릅니다. 웹 기록을 덮어쓰지 않았습니다.",
  "other-organization": "같은 기업 기록이 다른 조직에 있습니다. 옮기지 않았습니다.",
  "duplicate-company": "웹에 같은 회사로 보이는 기업이 있습니다. 중복을 막으려고 건너뛰었습니다.",
  "invalid-record": "기업 기록을 확인할 수 없어 옮기지 않았습니다.",
  "original-missing": "원본 파일이 이 PC에 없거나 읽을 수 없어 옮기지 않았습니다.",
  failed: "옮기는 중 문제가 생겨 이 기업은 옮기지 않았습니다. 올린 원본은 되돌렸습니다.",
};

type LocalRow = { id: string; revision: number; evidence_revision: number; body: string };
type Identity = { caseId: string; companyName: string; businessNumber: string };
type OriginalCopy = { key: string; bytes: Uint8Array; mimeType: string };

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && sha(left) === sha(right);

/** Digits only; a business number counts when it has at least 10 of them. */
function businessKey(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits : "";
}
/** Company name without spacing and legal-form words, so "(주) 가나" equals "가나 주식회사". */
function nameKey(value: string) {
  return value
    .normalize("NFKC")
    .replace(/주식회사|유한회사|\(주\)|\(유\)|㈜/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}
function sameCompany(left: Identity, right: Identity) {
  const leftNumber = businessKey(left.businessNumber);
  const rightNumber = businessKey(right.businessNumber);
  if (leftNumber && rightNumber) return leftNumber === rightNumber;
  const leftName = nameKey(left.companyName);
  return Boolean(leftName) && leftName === nameKey(right.companyName);
}
function identityOf(caseId: string, body: string): Identity {
  try {
    const parsed = JSON.parse(body) as {
      profile?: { companyName?: unknown; businessNumber?: unknown };
    };
    return {
      caseId,
      companyName: String(parsed.profile?.companyName ?? ""),
      businessNumber: String(parsed.profile?.businessNumber ?? ""),
    };
  } catch {
    return { caseId, companyName: "", businessNumber: "" };
  }
}

function count(db: DatabaseSync, table: string, where = "") {
  try {
    const row = db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get() as { n: number };
    return Number(row.n);
  } catch {
    // Older data folders may not have every table yet.
    return 0;
  }
}

/** Reads one stored original without following links or reading outside the data folder. */
function readOriginal(root: string, caseId: string, sourceId: string) {
  const file = resolve(root, "originals", uuid.parse(caseId), `${uuid.parse(sourceId)}.bin`);
  for (const path of [resolve(root, "originals"), resolve(file, ".."), file]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) return null;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > maxOriginalBytes) return null;
  return new Uint8Array(readFileSync(file));
}

async function targetOrganization(executor: SqlExecutor, organizationId: string) {
  if (!uuid.safeParse(organizationId).success)
    throw new WebMigrationError("조직 ID 형식이 올바르지 않습니다.");
  const { rows } = await executor.query<{ id: string; name: string }>(
    "SELECT id, name FROM venture_organizations WHERE id = $1",
    [organizationId],
  );
  if (!rows[0]) throw new WebMigrationError("웹 서비스에 그 조직이 없습니다.");
  return rows[0];
}

/** Uploads first and verifies by reading back; an equal object left by a crashed run is reused. */
async function copyOriginals(store: OriginalObjectStore, copies: OriginalCopy[]) {
  const created: string[] = [];
  try {
    for (const copy of copies) {
      const existing = await store.get(copy.key);
      if (existing) {
        if (!sameBytes(existing, copy.bytes))
          throw new WebMigrationError("웹 저장소에 다른 내용의 원본이 이미 있습니다.");
        continue;
      }
      await store.put(copy.key, copy.bytes, copy.mimeType);
      created.push(copy.key);
      const stored = await store.get(copy.key);
      if (!stored || !sameBytes(stored, copy.bytes))
        throw new WebMigrationError("올린 원본을 다시 읽어 대조하지 못했습니다.");
    }
    return created;
  } catch (error) {
    await removeQuietly(store, created);
    throw error;
  }
}
async function removeQuietly(store: OriginalObjectStore, keys: string[]) {
  for (const key of keys) await store.remove(key).catch(() => {});
}

export async function migrateLocalDataToWeb(
  options: WebMigrationOptions,
): Promise<WebMigrationReport> {
  const apply = options.apply === true;
  const root = resolve(options.dataDirectory);
  const databaseFile = join(root, "studio.sqlite");
  if (!lstatSync(databaseFile, { throwIfNoEntry: false })?.isFile())
    throw new WebMigrationError("이 PC 앱 자료(studio.sqlite)를 찾지 못했습니다.");
  const organization = await targetOrganization(options.executor, options.organizationId);
  const caseId = (id: string) => {
    if (!uuid.safeParse(id).success)
      throw new WebMigrationError(`기업 ID 형식이 올바르지 않습니다: ${id.slice(0, 40)}`);
    return id.toLowerCase();
  };
  const only = options.caseIds?.map(caseId);
  const allowDuplicate = new Set(options.allowDuplicateCaseIds?.map(caseId));

  const local = new DatabaseSync(databaseFile, { readOnly: true });
  let rows: LocalRow[];
  let notMigrated: WebMigrationReport["notMigrated"];
  try {
    rows = local
      .prepare("SELECT id, revision, evidence_revision, body FROM studio_cases ORDER BY id")
      .all() as LocalRow[];
    if (only) rows = rows.filter((row) => only.includes(row.id));
    notMigrated = {
      ventureAccounts: count(local, "venture_accounts", "WHERE encrypted_payload IS NOT NULL"),
      ventureWorkflows: count(local, "venture_workflows"),
      preparedPackages: count(local, "studio_prepared_packages"),
      intakeOnlyOriginals: 0,
    };
  } finally {
    local.close();
  }
  if (only?.some((id) => !rows.some((row) => row.id === id)))
    throw new WebMigrationError("지정한 기업 중 이 PC에 없는 기업이 있습니다.");

  const webIdentities = (
    await options.executor.query<{ id: string; body: string }>(
      "SELECT id, body FROM venture_cases WHERE organization_id = $1",
      [organization.id],
    )
  ).rows.map((row) => identityOf(row.id, row.body));
  const repository = new PostgresCaseRowRepository(options.executor, organization.id);
  const cases: CaseMigrationReport[] = [];

  // The same validation as a server session: the row must load into a StudioStore.
  const scratch = mkdtempSync(join(tmpdir(), "venturepass-migration-"));
  const validator = new StudioStore(scratch, { memory: true });
  try {
    for (const row of rows) {
      const identity = identityOf(row.id, row.body);
      const report = (outcome: CaseOutcome, originals = 0, duplicateOf?: string) =>
        cases.push({
          caseId: row.id,
          companyName: identity.companyName || "(이름 없음)",
          outcome,
          originals,
          message: messages[outcome],
          ...(duplicateOf ? { duplicateOf } : {}),
        });
      const snapshot: CaseRowSnapshot = {
        id: row.id,
        revision: Number(row.revision),
        evidenceRevision: Number(row.evidence_revision),
        body: row.body,
      };
      let record;
      try {
        validator.importCaseRow(snapshot);
        record = validator.get(row.id);
      } catch {
        report("invalid-record");
        continue;
      }
      const sourceIds = new Set(record.sources.map((source) => source.id));
      notMigrated.intakeOnlyOriginals += record.sourceIntakes.filter(
        (item) => item.original && !sourceIds.has(item.sourceId),
      ).length;

      const existing = (
        await options.executor.query<{ organization_id: string; body: string }>(
          "SELECT organization_id, body FROM venture_cases WHERE id = $1",
          [row.id],
        )
      ).rows[0];
      if (existing) {
        if (existing.organization_id !== organization.id) report("other-organization");
        else report(existing.body === row.body ? "already-migrated" : "changed-on-web");
        continue;
      }
      const duplicate = webIdentities.find((other) => sameCompany(identity, other));
      if (duplicate && !allowDuplicate.has(row.id)) {
        report("duplicate-company", 0, duplicate.caseId);
        continue;
      }

      const copies: OriginalCopy[] = [];
      let missing = false;
      for (const source of record.sources.filter((item) => item.originalName)) {
        let bytes: Uint8Array | null = null;
        try {
          bytes = readOriginal(root, row.id, source.id);
        } catch {
          bytes = null;
        }
        if (!bytes) {
          missing = true;
          break;
        }
        copies.push({
          key: originalObjectKey(organization.id, row.id, source.id),
          bytes,
          mimeType: source.mimeType || "application/octet-stream",
        });
      }
      if (missing) {
        report("original-missing");
        continue;
      }
      if (!apply) {
        report("ready", copies.length);
        webIdentities.push(identity);
        continue;
      }
      let created: string[] = [];
      try {
        created = await copyOriginals(options.originals, copies);
        await repository.insert(snapshot);
      } catch {
        await removeQuietly(options.originals, created);
        report("failed");
        continue;
      }
      report("migrated", copies.length);
      webIdentities.push(identity);
    }
  } finally {
    validator.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  return { organization, apply, cases, notMigrated };
}

/** Plain Korean lines for the command window. */
export function formatMigrationReport(report: WebMigrationReport) {
  const lines = [
    `${report.apply ? "옮기기 결과" : "미리 보기(아무것도 쓰지 않음)"} · 대상 조직: ${report.organization.name}`,
    "",
  ];
  for (const item of report.cases) {
    const originals = item.originals ? ` · 원본 ${item.originals}개` : "";
    const duplicate = item.duplicateOf ? ` · 웹의 기업 ID ${item.duplicateOf}` : "";
    lines.push(`- ${item.companyName} (${item.caseId}): ${item.message}${originals}${duplicate}`);
  }
  if (!report.cases.length) lines.push("- 옮길 기업이 없습니다.");
  const tally = new Map<CaseOutcome, number>();
  for (const item of report.cases) tally.set(item.outcome, (tally.get(item.outcome) ?? 0) + 1);
  lines.push(
    "",
    `합계: ${[...tally].map(([outcome, total]) => `${outcome} ${total}`).join(", ") || "0"}`,
  );
  const kept = report.notMigrated;
  lines.push(
    "이 PC에만 남는 자료: " +
      `벤처인 계정 ${kept.ventureAccounts}개, 벤처인 진행 기록 ${kept.ventureWorkflows}개, ` +
      `제출 준비 ZIP ${kept.preparedPackages}개, 접수 단계 원본 ${kept.intakeOnlyOriginals}개`,
  );
  if (!report.apply && report.cases.some((item) => item.outcome === "ready"))
    lines.push("", "실제로 옮기려면 같은 명령에 --apply를 붙여 다시 실행합니다.");
  return lines.join("\n");
}
