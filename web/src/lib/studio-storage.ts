import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, rmdirSync, existsSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  caseSchema,
  companyProfileSchema,
  type AnalysisContent,
  type BusinessPlan,
  type CaseMutation,
  type CaseSummary,
  type CompanyProfile,
  type PlanContent,
  type ReviewFinding,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import { StudioError } from "./studio-http";

type StoredRow = { body: string; evidence_revision: number };
/** Encrypted connector data is deliberately kept outside StudioCase and its AI/export payloads. */
export type VentureAccountEnvelope = {
  encryptedPayload: Uint8Array | null;
  maskedLoginId: string | null;
  revision: number;
  updatedAt: string | null;
};
type Reviewer = (record: StudioCase, content: PlanContent) => ReviewFinding[];
const uuid = z.string().uuid();
export const MAX_SOURCE_TEXT = 160000;

function validateCapacity(record: StudioCase) {
  if (record.sources.length > 40)
    throw new StudioError("기업별 자료는 40개까지 등록할 수 있습니다.", 413, "SOURCE_LIMIT");
  if (record.plans.length > 100)
    throw new StudioError(
      "사업계획서는 기업별 100개 버전까지 저장할 수 있습니다.",
      413,
      "PLAN_LIMIT",
    );
  caseSchema.parse(record);
  const chars =
    record.sources.reduce((total, source) => total + source.text.length, 0) +
    Object.values(record.profile).join("").length;
  if (chars > MAX_SOURCE_TEXT)
    throw new StudioError(
      "기업정보와 자료 본문은 합계 160,000자까지 저장할 수 있습니다. 자료를 정리해 다시 등록해 주세요.",
      413,
      "SOURCE_TEXT_LIMIT",
    );
}

function invalidateEvidence(record: StudioCase) {
  record.analysis = null;
  record.selectedCandidateId = null;
  record.plans = record.plans.map((plan) => ({ ...plan, confirmedAt: null }));
}

export class StudioStore {
  private db: DatabaseSync;
  private root: string;
  constructor(directory = process.env.VENTURE_DATA_DIR || resolve(process.cwd(), ".venture-pass")) {
    this.root = resolve(directory);
    mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(join(this.root, "studio.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS studio_cases (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, evidence_revision INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS venture_accounts (case_id TEXT PRIMARY KEY REFERENCES studio_cases(id) ON DELETE CASCADE, encrypted_payload BLOB, masked_login_id TEXT, revision INTEGER NOT NULL CHECK (revision > 0), updated_at TEXT NOT NULL, CHECK ((encrypted_payload IS NULL AND masked_login_id IS NULL) OR (encrypted_payload IS NOT NULL AND masked_login_id IS NOT NULL)));",
    );
  }
  close() {
    this.db.close();
  }
  private filePath(caseId: string, sourceId: string) {
    uuid.parse(caseId);
    uuid.parse(sourceId);
    const target = resolve(this.root, "originals", caseId, `${sourceId}.bin`);
    const boundary = relative(this.root, target);
    if (boundary.startsWith("..") || isAbsolute(boundary))
      throw new StudioError("잘못된 파일 경로입니다.", 400, "INVALID_PATH");
    return target;
  }
  private row(id: string): StoredRow {
    uuid.parse(id);
    const row = this.db
      .prepare("SELECT body, evidence_revision FROM studio_cases WHERE id = ?")
      .get(id) as StoredRow | undefined;
    if (!row) throw new StudioError("기업을 찾을 수 없습니다.", 404, "NOT_FOUND");
    return row;
  }
  get(id: string): StudioCase {
    return caseSchema.parse(JSON.parse(this.row(id).body));
  }
  list(): CaseSummary[] {
    return (
      this.db
        .prepare("SELECT body FROM studio_cases ORDER BY json_extract(body, '$.updatedAt') DESC")
        .all() as { body: string }[]
    ).map(({ body }) => {
      const record = caseSchema.parse(JSON.parse(body));
      return {
        id: record.id,
        companyName: record.profile.companyName,
        industry: record.profile.industry,
        stage: record.stage,
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        sourceCount: record.sources.length,
        planCount: record.plans.length,
        pendingTaskCount: record.tasks.filter((task) => task.status === "pending").length,
      };
    });
  }
  getVentureAccountEnvelope(id: string): VentureAccountEnvelope {
    this.row(id);
    const account = this.db
      .prepare(
        "SELECT encrypted_payload, masked_login_id, revision, updated_at FROM venture_accounts WHERE case_id = ?",
      )
      .get(id) as
      | {
          encrypted_payload: Uint8Array | null;
          masked_login_id: string | null;
          revision: number;
          updated_at: string;
        }
      | undefined;
    return account
      ? {
          encryptedPayload: account.encrypted_payload,
          maskedLoginId: account.masked_login_id,
          revision: account.revision,
          updatedAt: account.updated_at,
        }
      : { encryptedPayload: null, maskedLoginId: null, revision: 0, updatedAt: null };
  }
  saveVentureAccountEnvelope(
    id: string,
    expectedRevision: number,
    encryptedPayload: Uint8Array,
    maskedLoginId: string,
  ): VentureAccountEnvelope {
    if (
      !(encryptedPayload instanceof Uint8Array) ||
      encryptedPayload.byteLength === 0 ||
      encryptedPayload.byteLength > 32768 ||
      typeof maskedLoginId !== "string" ||
      !maskedLoginId ||
      maskedLoginId.length > 30
    )
      throw new StudioError("계정 보관 정보를 확인해 주세요.", 400, "INVALID_ACCOUNT_ENVELOPE");
    return this.updateVentureAccountEnvelope(id, expectedRevision, encryptedPayload, maskedLoginId);
  }
  deleteVentureAccountEnvelope(id: string, expectedRevision: number): VentureAccountEnvelope {
    // Retain the version even when disconnected so an old save cannot resurrect credentials.
    return this.updateVentureAccountEnvelope(id, expectedRevision, null, null);
  }
  private updateVentureAccountEnvelope(
    id: string,
    expectedRevision: number,
    encryptedPayload: Uint8Array | null,
    maskedLoginId: string | null,
  ): VentureAccountEnvelope {
    z.number().int().nonnegative().safe().parse(expectedRevision);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getVentureAccountEnvelope(id);
      if (current.revision !== expectedRevision)
        throw new StudioError(
          "벤처인 연결 정보가 변경되었습니다. 다시 불러와 주세요.",
          409,
          "STALE_ACCOUNT_REVISION",
        );
      const revision = expectedRevision + 1;
      z.number().int().positive().safe().parse(revision);
      const updatedAt = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO venture_accounts (case_id, encrypted_payload, masked_login_id, revision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(case_id) DO UPDATE SET encrypted_payload=excluded.encrypted_payload, masked_login_id=excluded.masked_login_id, revision=excluded.revision, updated_at=excluded.updated_at",
        )
        .run(id, encryptedPayload, maskedLoginId, revision, updatedAt);
      this.db.exec("COMMIT");
      return { encryptedPayload, maskedLoginId, revision, updatedAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  create(profile: CompanyProfile): StudioCase {
    const now = new Date().toISOString();
    const record: StudioCase = {
      id: randomUUID(),
      profile: companyProfileSchema.parse(profile),
      sources: [],
      analysis: null,
      selectedCandidateId: null,
      plans: [],
      tasks: [],
      stage: "preparing",
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    validateCapacity(record);
    this.db
      .prepare(
        "INSERT INTO studio_cases (id, revision, evidence_revision, body) VALUES (?, ?, ?, ?)",
      )
      .run(record.id, 0, 0, JSON.stringify(record));
    return record;
  }
  private update(
    id: string,
    expected: number,
    alter: (record: StudioCase, evidenceRevision: number) => boolean,
  ): StudioCase {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.row(id);
      const record = caseSchema.parse(JSON.parse(row.body));
      if (record.revision !== expected)
        throw new StudioError(
          "다른 작업에서 기업정보가 변경되었습니다. 새로고침 후 다시 시도해 주세요.",
          409,
          "STALE_REVISION",
        );
      const evidenceChanged = alter(record, row.evidence_revision);
      record.revision += 1;
      record.updatedAt = new Date().toISOString();
      validateCapacity(record);
      const saved = this.db
        .prepare(
          "UPDATE studio_cases SET revision = ?, evidence_revision = ?, body = ? WHERE id = ? AND revision = ?",
        )
        .run(
          record.revision,
          evidenceChanged ? record.revision : row.evidence_revision,
          JSON.stringify(record),
          id,
          expected,
        );
      if (saved.changes !== 1)
        throw new StudioError(
          "기업정보가 변경되었습니다. 다시 불러와 주세요.",
          409,
          "STALE_REVISION",
        );
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  mutate(id: string, mutation: CaseMutation, review: Reviewer): StudioCase {
    const result = this.update(id, mutation.revision, (record, evidenceRevision) => {
      switch (mutation.action) {
        case "profile":
          record.profile = mutation.profile;
          invalidateEvidence(record);
          return true;
        case "source": {
          if (!mutation.source.text.trim())
            throw new StudioError("자료 내용을 입력해 주세요.", 400, "SOURCE_TEXT_REQUIRED");
          const existing = record.sources.find((source) => source.id === mutation.source.id);
          const now = new Date().toISOString();
          // File ownership and extraction metadata are assigned by the server only.
          const source: SourceDocument = {
            ...mutation.source,
            originalName: existing?.originalName ?? null,
            mimeType: existing?.mimeType ?? null,
            extraction: "manual",
            warnings: existing?.warnings ?? [],
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          record.sources = existing
            ? record.sources.map((entry) => (entry.id === source.id ? source : entry))
            : [...record.sources, source];
          invalidateEvidence(record);
          return true;
        }
        case "delete-source": {
          if (!record.sources.some((source) => source.id === mutation.sourceId))
            throw new StudioError("자료를 찾을 수 없습니다.", 404, "SOURCE_NOT_FOUND");
          record.sources = record.sources.filter((source) => source.id !== mutation.sourceId);
          invalidateEvidence(record);
          return true;
        }
        case "select-candidate": {
          if (
            !record.analysis?.candidates.some((candidate) => candidate.id === mutation.candidateId)
          )
            throw new StudioError(
              "기업 분석에서 추천된 아이템을 선택해 주세요.",
              400,
              "INVALID_CANDIDATE",
            );
          record.selectedCandidateId = mutation.candidateId;
          record.plans = record.plans.map((plan) =>
            plan.candidateId === mutation.candidateId ? plan : { ...plan, confirmedAt: null },
          );
          return false;
        }
        case "save-plan": {
          const old = record.plans.find((plan) => plan.id === mutation.planId);
          if (!old) throw new StudioError("사업계획서를 찾을 수 없습니다.", 404, "PLAN_NOT_FOUND");
          const plan: BusinessPlan = {
            ...old,
            id: randomUUID(),
            version: Math.max(0, ...record.plans.map((item) => item.version)) + 1,
            generatedAt: new Date().toISOString(),
            mode: "manual",
            content: mutation.content,
            review: review(record, mutation.content),
            confirmedAt: null,
          };
          record.plans.push(plan);
          return false;
        }
        case "confirm-plan": {
          const plan = record.plans.find((item) => item.id === mutation.planId);
          if (!plan) throw new StudioError("사업계획서를 찾을 수 없습니다.", 404, "PLAN_NOT_FOUND");
          if (
            !record.analysis ||
            plan.sourceRevision < evidenceRevision ||
            plan.candidateId !== record.selectedCandidateId
          )
            throw new StudioError(
              "기업 자료 또는 아이템이 변경되었습니다. 분석·계획서를 다시 생성해 주세요.",
              409,
              "PLAN_OUTDATED",
            );
          plan.review = review(record, plan.content);
          if (
            plan.review.some(
              (finding) => finding.severity === "error" || finding.category === "confirmation",
            ) ||
            plan.content.sections.some((section) => section.needsConfirmation)
          )
            throw new StudioError(
              "오류와 확인이 필요한 항목을 먼저 검토해 주세요.",
              400,
              "REVIEW_REQUIRED",
            );
          plan.confirmedAt = new Date().toISOString();
          return false;
        }
        case "stage":
          record.stage = mutation.stage;
          return false;
        case "task":
          record.tasks = record.tasks.some((task) => task.id === mutation.task.id)
            ? record.tasks.map((task) => (task.id === mutation.task.id ? mutation.task : task))
            : [...record.tasks, mutation.task];
          return false;
        case "delete-task":
          record.tasks = record.tasks.filter((task) => task.id !== mutation.taskId);
          return false;
      }
    });
    if (mutation.action === "delete-source") this.removeOriginal(id, mutation.sourceId);
    return result;
  }
  saveAnalysis(id: string, revision: number, content: AnalysisContent, mode: "ai" | "assisted") {
    return this.update(id, revision, (record) => {
      record.analysis = {
        ...content,
        generatedAt: new Date().toISOString(),
        sourceRevision: revision,
        mode,
      };
      record.selectedCandidateId = null;
      record.plans = record.plans.map((plan) => ({ ...plan, confirmedAt: null }));
      // A newly recommended strategy invalidates old plans even if a model reuses candidate IDs.
      return true;
    });
  }
  saveGeneratedPlan(
    id: string,
    revision: number,
    candidateId: string,
    content: PlanContent,
    review: ReviewFinding[],
    mode: "ai" | "assisted",
  ) {
    return this.update(id, revision, (record) => {
      if (
        !record.analysis ||
        record.selectedCandidateId !== candidateId ||
        !record.analysis.candidates.some((candidate) => candidate.id === candidateId)
      )
        throw new StudioError("아이템을 선택하고 다시 시도해 주세요.", 409, "INVALID_CANDIDATE");
      record.plans.push({
        id: randomUUID(),
        version: Math.max(0, ...record.plans.map((plan) => plan.version)) + 1,
        generatedAt: new Date().toISOString(),
        mode,
        candidateId,
        sourceRevision: revision,
        content,
        review,
        confirmedAt: null,
      });
      if (record.stage === "preparing") record.stage = "drafting";
      return false;
    });
  }
  addUpload(id: string, revision: number, source: SourceDocument, buffer: Uint8Array) {
    const file = this.filePath(id, source.id);
    let written = false;
    try {
      return this.update(id, revision, (record) => {
        if (record.sources.some((item) => item.id === source.id))
          throw new StudioError("이미 등록된 자료입니다.", 409, "DUPLICATE_SOURCE");
        record.sources.push(source);
        invalidateEvidence(record);
        validateCapacity(record);
        mkdirSync(resolve(file, ".."), { recursive: true });
        writeFileSync(file, buffer, { flag: "wx" });
        written = true;
        return true;
      });
    } catch (error) {
      if (written) this.removeOriginal(id, source.id);
      throw error;
    }
  }
  original(id: string, sourceId: string) {
    const source = this.get(id).sources.find((item) => item.id === sourceId);
    if (!source?.originalName)
      throw new StudioError("원본 파일을 찾을 수 없습니다.", 404, "SOURCE_NOT_FOUND");
    const file = this.filePath(id, sourceId);
    if (!existsSync(file))
      throw new StudioError("원본 파일이 저장소에 없습니다.", 404, "SOURCE_NOT_FOUND");
    return { source, buffer: readFileSync(file) };
  }
  private removeOriginal(id: string, sourceId: string) {
    const file = this.filePath(id, sourceId);
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  isPlanCurrent(id: string, plan: BusinessPlan) {
    const row = this.row(id);
    const record = caseSchema.parse(JSON.parse(row.body));
    return Boolean(
      record.analysis &&
      plan.sourceRevision >= row.evidence_revision &&
      plan.candidateId === record.selectedCandidateId,
    );
  }
  delete(id: string, revision: number) {
    const record = this.get(id);
    if (record.revision !== revision)
      throw new StudioError(
        "기업정보가 변경되었습니다. 다시 불러와 주세요.",
        409,
        "STALE_REVISION",
      );
    const deleted = this.db
      .prepare("DELETE FROM studio_cases WHERE id = ? AND revision = ?")
      .run(id, revision);
    if (deleted.changes !== 1)
      throw new StudioError(
        "기업정보가 변경되었습니다. 다시 불러와 주세요.",
        409,
        "STALE_REVISION",
      );
    for (const source of record.sources) this.removeOriginal(id, source.id);
    const directory = resolve(this.filePath(id, randomUUID()), "..");
    try {
      rmdirSync(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
}

let defaultStore: StudioStore | undefined;
export function getStudioStore() {
  return (defaultStore ??= new StudioStore());
}
