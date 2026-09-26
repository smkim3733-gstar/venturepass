import { createHash, randomUUID } from "node:crypto";
import {
  assertPreparationAutomationCapacity,
  configurePreparationAutomation,
  collectPreparationAutomationChanges,
  beginPreparationAutomation as beginAutomation,
  finishPreparationAutomation as finishAutomation,
  type AutomationTransition,
} from "./studio-preparation-automation";
import {
  emptyPreparationAutomation,
  preparationAutomationSettingInputSchema,
  preparationAutomationRequestSchema,
  type PreparationAutomationSettingInput,
  type PreparationAutomationRequest,
} from "./studio-preparation-automation-types";
import {
  assertExternalIntakeResultBinding,
  buildExternalIntakeApproval,
  buildExternalIntakeAttempt,
  currentExternalIntakeAttempt,
  externalIntakeError,
  externalIntakeNeedsDuplicateAcknowledgement,
  externalIntakeRequestDigest,
  unknownExternalIntakeAttempt,
} from "./studio-source-intake-external-core";
import {
  runExternalSourceIntakeSchema,
  sourceIntakeExternalApprovalPreviewInputSchema,
  sourceIntakeExternalOutcomeSchema,
  type RunExternalSourceIntakeCommand,
  type SourceIntakeExternalApprovalPreview,
  type SourceIntakeExternalApprovalPreviewInput,
  type SourceIntakeExternalConfiguration,
  type SourceIntakeExternalOutcome,
} from "./studio-source-intake-external-types";
import { criteriaVersionMutationSchema } from "./studio-criteria-version-types";
import {
  assertCriteriaVersionCapacity,
  buildCriteriaVersion,
  buildApplicationCriteriaBinding,
  criteriaVersionInputDigest,
  isCriteriaVersionReplay,
  withApplicationCriteriaContexts,
} from "./studio-criteria-version";
import { appendApplicationProcedureSchema } from "./studio-application-procedure-types";
import {
  applicationProcedureDigest,
  assertApplicationProcedureCapacity,
  buildApplicationProcedure,
  isApplicationProcedureReplay,
} from "./studio-application-procedure";
import { adoptSourceSuggestionsMutationSchema } from "./studio-source-suggestion-types";
import {
  assertSourceSuggestionCapacity,
  buildSourceSuggestionAdoption,
  isSourceSuggestionReplay,
  sourceSuggestionInputDigest,
  sourceSuggestionError,
} from "./studio-source-suggestion";
import {
  assertIntakeCapacity,
  assertIntakeOriginal,
  intakeDigest,
  intakeError,
  intakeItem,
  intakeReplay,
  intakeRequest,
  intakeResponse,
  intakeRetainedCharacters,
  intakeSha,
  intakeTouch,
  newSourceIntakeBatch,
  pendingIntakeSource,
  retainIntakeLocations,
} from "./studio-source-intake";
import {
  adoptSourceIntakeSchema,
  cancelSourceIntakeSchema,
  createSourceIntakeSchema,
  discardSourceIntakeSchema,
  resumeSourceIntakeSchema,
  runSourceIntakeSchema,
  sourceIntakeContentSchema,
  sourceIntakeEngineSupports,
  sourceIntakeLimits,
  sourceIntakeOriginalInputSchema,
  sourceIntakeResultText,
  type AdoptSourceIntakeCommand,
  type CancelSourceIntakeCommand,
  type CreateSourceIntakeCommand,
  type DiscardSourceIntakeCommand,
  type ResumeSourceIntakeCommand,
  type RunSourceIntakeCommand,
  type SourceIntakeAttemptBinding,
  type SourceIntakeEngine,
  type SourceIntakeOriginalInput,
  type SourceIntakeOutcome,
} from "./studio-source-intake-types";
import { appendClaimReviewMutationSchema } from "./studio-claim-review-types";
import {
  assertClaimReviewCapacity,
  buildClaimReview,
  claimReviewInputDigest,
  isClaimReviewReplay,
} from "./studio-claim-review";
import { appendCompanyContactsMutationSchema } from "./studio-company-contacts-types";
import {
  assertCompanyContactsCapacity,
  buildCompanyContacts,
  companyContactsInputDigest,
  isCompanyContactsReplay,
} from "./studio-company-contacts";
import { currentVerifiedCandidateSelection } from "./studio-candidate-selection";
import {
  assertCandidateSelectionCapacity,
  buildCandidateSelection,
  isCandidateSelectionReplay,
} from "./studio-candidate-selection";
import { candidateSelectionMutationSchema } from "./studio-candidate-selection-types";
import { createCertificateTaskMutationSchema } from "./studio-certificate-renewal-types";
import { buildCertificateTask, existingCertificateTask } from "./studio-certificate-renewal";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  rmdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  fsyncSync,
  constants,
  type BigIntStats,
} from "node:fs";
import { resolve, join, relative, isAbsolute, parse, posix, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { isApplicationMutation, applicationMutationSchema } from "./studio-application-types";
import {
  applyApplicationMutation,
  applicationSourceReferenced,
  assertApplicationCapacity,
  isApplicationReplay,
} from "./studio-applications";
import { originalConflicts } from "./studio-evidence-history";
import { numericCheckAppendMutationSchema } from "./studio-numeric-check-types";
import {
  assertNumericCheckCapacity,
  buildNumericCheck,
  isNumericCheckReplay,
  numericCheckInputDigest,
} from "./studio-numeric-check";
import { appendPlanReviewMutationSchema } from "./studio-plan-review-types";
import {
  assertPlanReviewCapacity,
  buildPlanReviewDecision,
  isPlanReviewReplay,
  planReviewInputDigest,
  refreshPlanReviewStaleness,
} from "./studio-plan-review";
import { visitAnswerAppendMutationSchema } from "./studio-visit-answer-types";
import {
  assertVisitAnswerCapacity,
  buildVisitAnswer,
  isVisitAnswerReplay,
  visitAnswerInputDigest,
} from "./studio-visit-answer";
import {
  appendResponsePreparationMutationSchema,
  registerPreparedResponseMutationSchema,
} from "./studio-response-preparation-types";
import {
  assertResponsePreparationCapacity,
  buildPreparedAgencyResponse,
  buildResponsePreparation,
  isResponsePreparationReplay,
  preparedResponseRegistrationDigest,
  responsePreparationDigest,
} from "./studio-response-preparation";
import {
  caseSchema,
  companyProfileSchema,
  mutationSchema,
  originalOnlyWarnings,
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
import {
  MAX_PREPARATION_REQUESTS,
  MAX_PREPARATION_RUNS,
  preparationRequestSchema,
  type PreparationRequest,
  type PreparationRun,
} from "./studio-preparation-types";
import { preparationDigest, refreshPreparationStaleness } from "./studio-preparation-state";
import {
  diagnosisCriteriaVersion,
  emptyDiagnosisAnswers,
  MAX_DIAGNOSES,
  MAX_DIAGNOSIS_TEXT,
} from "./studio-diagnosis-types";
import {
  assertDiagnosisAnswers,
  buildLocalDiagnosis,
  diagnosisHistoryCharacters,
  diagnosisInputFingerprint,
  refreshDiagnosisStaleness,
} from "./studio-diagnosis";
import { assertVentureCompanyWritable } from "./venturein-input-lock";
import { changeStage } from "./studio-stage-history";
import { currentAgencyTaskRequest } from "./studio-agency-tasks";
import { resolveTaskPlanReference } from "./studio-task-processing-types";
import { summarizeCase } from "./studio-case-summary";
import { appealAppendMutationSchema } from "./studio-appeal-types";
import {
  appealInputDigest,
  assertAppealCapacity,
  buildAppealPreparation,
  isAppealReplay,
} from "./studio-appeal";
import {
  localOcrReviewedWarning,
  MAX_OCR_REVIEWS,
  reviewLocalOcrMutationSchema,
} from "./studio-ocr-review";
import {
  agencyAppendMutationSchema,
  assertAgencyCapacity,
  buildAgencyRecord,
  isAgencyRecordReplay,
  MAX_AGENCY_EVIDENCE_BYTES,
  MAX_AGENCY_RECORDS,
  type AgencyEvidenceSnapshot,
} from "./studio-agency-records";

type StoredRow = { body: string; evidence_revision: number };
/** Encrypted connector data is deliberately kept outside StudioCase and its AI/export payloads. */
export type VentureAccountEnvelope = {
  encryptedPayload: Uint8Array | null;
  maskedLoginId: string | null;
  revision: number;
  updatedAt: string | null;
};
export type VentureWorkflowEnvelope = {
  revision: number;
  body: string | null;
  updatedAt: string | null;
};
type Reviewer = (record: StudioCase, content: PlanContent) => ReviewFinding[];
const uuid = z.string().uuid();
export const MAX_SOURCE_TEXT = 160000;
export const MAX_VENTURE_ORIGINAL_BYTES = 12 * 1024 * 1024;

function originalReadError(code: string, status = 409): StudioError {
  return new StudioError(
    "첨부 원본의 경로·메타데이터 또는 내용을 확인하지 못했습니다. 자료를 다시 확인해 주세요.",
    status,
    code,
  );
}

function sameOriginalIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOriginalStat(left: BigIntStats, right: BigIntStats) {
  return (
    sameOriginalIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink &&
    right.isFile() &&
    !right.isSymbolicLink()
  );
}

function normalizedOriginalPath(value: string) {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Node exposes symlinks/junctions, but Windows has other reparse-point kinds as well. */
function assertNoOriginalReparsePoints(paths: string[]) {
  if (process.platform !== "win32") return;
  const encodedPaths = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  const command = `$ErrorActionPreference='Stop'; $items=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}'))); foreach($item in $items) { if (([IO.File]::GetAttributes($item) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 31 } }; exit 0`;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024,
        stdio: "pipe",
      },
    );
  } catch {
    throw originalReadError("UNSAFE_ORIGINAL_PATH");
  }
}

function inspectOriginalPath(root: string, file: string, directory = false) {
  const paths: string[] = [];
  let current = parse(file).root;
  paths.push(current);
  for (const part of relative(current, file).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    paths.push(current);
  }
  const chain = paths.map((path, index) => {
    const stat = lstatSync(path, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (index === paths.length - 1 && !directory ? !stat.isFile() : !stat.isDirectory())
    )
      throw originalReadError("UNSAFE_ORIGINAL_PATH");
    if (normalizedOriginalPath(realpathSync(path)) !== normalizedOriginalPath(path))
      throw originalReadError("UNSAFE_ORIGINAL_PATH");
    return stat;
  });
  assertNoOriginalReparsePoints(paths);
  const boundary = relative(realpathSync(root), realpathSync(file));
  if ((!boundary && !directory) || boundary.startsWith("..") || isAbsolute(boundary))
    throw originalReadError("UNSAFE_ORIGINAL_PATH");
  return chain;
}

function validateVentureOriginalMetadata(source: SourceDocument) {
  const name = source.originalName;
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name !== posix.basename(name) ||
    name !== win32.basename(name) ||
    /[\\/:\u0000-\u001f\u007f]/.test(name) ||
    /[. ]$/.test(name) ||
    name !== name.trim() ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw originalReadError("INVALID_ORIGINAL_NAME");
  const mime = source.mimeType;
  if (mime === null) return;
  if (
    !mime ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; ?charset=(?:utf-8|us-ascii))?$/i.test(
      mime,
    ) ||
    (mime.includes(";") && !mime.toLowerCase().startsWith("text/"))
  )
    throw originalReadError("INVALID_ORIGINAL_MIME");
}

function validateCapacity(record: StudioCase) {
  // Transition functions reserve space for a final disable; existing histories must remain writable.
  assertPreparationAutomationCapacity(record.preparationAutomation, true);
  assertCriteriaVersionCapacity(record);
  assertApplicationProcedureCapacity(record.applicationProcedures);
  assertSourceSuggestionCapacity(record.sourceSuggestionAdoptions);
  assertIntakeCapacity(record);
  if (record.sources.length > 40)
    throw new StudioError("기업별 자료는 40개까지 등록할 수 있습니다.", 413, "SOURCE_LIMIT");
  if (record.plans.length > 100)
    throw new StudioError(
      "사업계획서는 기업별 100개 버전까지 저장할 수 있습니다.",
      413,
      "PLAN_LIMIT",
    );
  caseSchema.parse(record);
  assertCompanyContactsCapacity(record.companyContacts);
  if (diagnosisHistoryCharacters(record.diagnoses) > MAX_DIAGNOSIS_TEXT)
    throw new StudioError(
      "사전진단 이력의 보관 한도에 도달했습니다. 기존 이력을 보존하고 추가 저장을 중단합니다.",
      413,
      "DIAGNOSIS_TEXT_LIMIT",
    );
  assertAgencyCapacity(record.agencyRecords);
  assertApplicationCapacity(record);
  assertAppealCapacity(record.appealPreparations);
  assertVisitAnswerCapacity(record.visitAnswers);
  assertNumericCheckCapacity(record.numericChecks);
  assertClaimReviewCapacity(record.claimReviews);
  assertResponsePreparationCapacity(record.responsePreparations);
  assertPlanReviewCapacity(record.planReviewDecisions);
  assertCandidateSelectionCapacity(record.candidateSelections);
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

function applyAnalysis(
  record: StudioCase,
  content: AnalysisContent,
  mode: "ai" | "assisted",
  revision: number,
) {
  record.analysis = {
    ...content,
    generatedAt: new Date().toISOString(),
    sourceRevision: revision,
    mode,
  };
  record.selectedCandidateId = null;
  record.plans = record.plans.map((plan) => ({ ...plan, confirmedAt: null }));
}
function appendGeneratedPlan(
  record: StudioCase,
  revision: number,
  candidateId: string,
  content: PlanContent,
  review: ReviewFinding[],
  mode: "ai" | "assisted",
) {
  if (
    !record.analysis ||
    record.selectedCandidateId !== candidateId ||
    !record.analysis.candidates.some((item) => item.id === candidateId)
  )
    throw new StudioError("아이템을 선택하고 다시 시도해 주세요.", 409, "INVALID_CANDIDATE");
  const plan: BusinessPlan = {
    id: randomUUID(),
    version: Math.max(0, ...record.plans.map((item) => item.version)) + 1,
    generatedAt: new Date().toISOString(),
    mode,
    candidateId,
    sourceRevision: revision,
    content,
    review,
    confirmedAt: null,
  };
  record.plans.push(plan);
  if (record.stage === "preparing")
    changeStage(record, "drafting", {
      origin: "plan-created",
      occurredOn: "",
      note: "로컬 사업계획서 초안 생성에 따른 단계 변경입니다.",
    });
  return plan;
}
function preparationError(code: string): never {
  throw new StudioError(
    "로컬 준비 기록과 현재 기업자료·선택을 확인해 주세요. 완료한 산출물은 보존합니다.",
    409,
    code,
  );
}

/** Keep source review bindings distinct even within one millisecond or after clock rollback. */
function nextSourceTimestamp(previous?: string) {
  const prior = previous ? Date.parse(previous) : NaN;
  const value = Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0);
  if (!Number.isFinite(value) || value > 8_640_000_000_000_000)
    throw new StudioError(
      "자료의 수정 시각을 갱신할 수 없습니다. 현재 자료 기록을 확인해 주세요.",
      409,
      "SOURCE_TIMESTAMP_INVALID",
    );
  return new Date(value).toISOString();
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
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS venture_workflows (case_id TEXT PRIMARY KEY REFERENCES studio_cases(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK (revision > 0), body TEXT NOT NULL, updated_at TEXT NOT NULL)",
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
    const row = this.row(id);
    const record = caseSchema.parse(JSON.parse(row.body));
    refreshDiagnosisStaleness(record);
    refreshPreparationStaleness(record);
    refreshPlanReviewStaleness(record, row.evidence_revision);
    return withApplicationCriteriaContexts(record);
  }
  list(): CaseSummary[] {
    return (
      this.db
        .prepare("SELECT body FROM studio_cases ORDER BY json_extract(body, '$.updatedAt') DESC")
        .all() as { body: string }[]
    ).map(({ body }) => {
      const record = caseSchema.parse(JSON.parse(body));
      refreshDiagnosisStaleness(record);
      refreshPreparationStaleness(record);
      return summarizeCase(record);
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
  getVentureWorkflowEnvelope(id: string): VentureWorkflowEnvelope {
    this.row(id);
    const row = this.db
      .prepare("SELECT revision, body, updated_at FROM venture_workflows WHERE case_id = ?")
      .get(id) as { revision: number; body: string; updated_at: string } | undefined;
    return row
      ? { revision: row.revision, body: row.body, updatedAt: row.updated_at }
      : { revision: 0, body: null, updatedAt: null };
  }
  saveVentureWorkflowEnvelope(
    id: string,
    expectedRevision: number,
    body: string,
  ): VentureWorkflowEnvelope {
    z.number().int().nonnegative().safe().parse(expectedRevision);
    if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 512 * 1024)
      throw new StudioError(
        "신청 연결 기록의 크기가 허용 범위를 초과했습니다.",
        413,
        "WORKFLOW_TOO_LARGE",
      );
    JSON.parse(body);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getVentureWorkflowEnvelope(id);
      if (current.revision !== expectedRevision)
        throw new StudioError(
          "신청 연결 기록이 변경되었습니다. 새로 불러와 주세요.",
          409,
          "STALE_WORKFLOW",
        );
      const revision = z
        .number()
        .int()
        .positive()
        .safe()
        .parse(expectedRevision + 1);
      const updatedAt = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO venture_workflows (case_id, revision, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(case_id) DO UPDATE SET revision=excluded.revision, body=excluded.body, updated_at=excluded.updated_at",
        )
        .run(id, revision, body, updatedAt);
      this.db.exec("COMMIT");
      return { revision, body, updatedAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    assertVentureCompanyWritable(id);
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
      companyContacts: [],
      sources: [],
      analysis: null,
      selectedCandidateId: null,
      candidateSelections: [],
      plans: [],
      planReviewDecisions: [],
      tasks: [],
      stage: "preparing",
      stageHistory: [],
      agencyRecords: [],
      applications: [],
      applicationEvents: [],
      criteriaVersions: [],
      applicationCriteriaBindings: [],
      appealPreparations: [],
      visitAnswers: [],
      numericChecks: [],
      claimReviews: [],
      sourceIntakes: [],
      sourceSuggestionAdoptions: [],
      applicationProcedures: [],
      responsePreparations: [],
      sourceOcrReviews: [],
      diagnosisAnswers: emptyDiagnosisAnswers(),
      diagnoses: [],
      preparationRuns: [],
      preparationAutomation: emptyPreparationAutomation(),
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
    return withApplicationCriteriaContexts(record);
  }
  private update(
    id: string,
    expected: number,
    alter: (record: StudioCase, evidenceRevision: number) => boolean,
    replay?: (record: StudioCase) => boolean,
  ): StudioCase {
    assertVentureCompanyWritable(id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.row(id);
      const record = caseSchema.parse(JSON.parse(row.body));
      delete record.applicationCriteriaContexts;
      refreshDiagnosisStaleness(record);
      refreshPreparationStaleness(record);
      if (replay?.(record)) {
        this.db.exec("COMMIT");
        refreshPlanReviewStaleness(record, row.evidence_revision);
        return withApplicationCriteriaContexts(record);
      }
      if (record.revision !== expected)
        throw new StudioError(
          "다른 작업에서 기업정보가 변경되었습니다. 새로고침 후 다시 시도해 주세요.",
          409,
          "STALE_REVISION",
        );
      const before = structuredClone(record);
      const evidenceChanged = alter(record, row.evidence_revision);
      record.revision += 1;
      record.updatedAt = new Date().toISOString();
      record.preparationAutomation = collectPreparationAutomationChanges(
        before,
        record,
        record.updatedAt,
      );
      refreshDiagnosisStaleness(record);
      refreshPreparationStaleness(record);
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
      // Derived review context is response-only; do not rewrite saved judgement history.
      refreshPlanReviewStaleness(record, evidenceChanged ? record.revision : row.evidence_revision);
      return withApplicationCriteriaContexts(record);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  mutate(id: string, mutation: CaseMutation, review: Reviewer): StudioCase {
    if (mutation.action === "set-preparation-automation")
      return this.setPreparationAutomation(id, mutation);
    if (
      mutation.action === "append-criteria-version" ||
      mutation.action === "pin-application-criteria"
    ) {
      const parsed = criteriaVersionMutationSchema.parse(mutation),
        inputDigest = criteriaVersionInputDigest(parsed);
      return this.update(
        id,
        parsed.revision,
        (record) => {
          const metadata = {
            id: randomUUID(),
            clientRequestId: parsed.clientRequestId,
            inputDigest,
            recordedAt: new Date().toISOString(),
          };
          if (parsed.action === "append-criteria-version") {
            const { criteriaId, previousVersionId, details, recordedBy, reason } = parsed;
            record.criteriaVersions.push(
              buildCriteriaVersion(
                record,
                { criteriaId, previousVersionId, details, recordedBy, reason },
                metadata,
              ),
            );
          } else {
            const {
              applicationId,
              applicationMetadataVersionId,
              criteriaVersionId,
              criteriaContentSha256,
              previousBindingId,
              recordedBy,
              reason,
            } = parsed;
            record.applicationCriteriaBindings.push(
              buildApplicationCriteriaBinding(
                record,
                {
                  applicationId,
                  applicationMetadataVersionId,
                  criteriaVersionId,
                  criteriaContentSha256,
                  previousBindingId,
                  recordedBy,
                  reason,
                },
                metadata,
              ),
            );
          }
          // Manual reference records do not revise the built-in diagnosis rules or company evidence.
          return false;
        },
        (record) => isCriteriaVersionReplay(record, parsed.clientRequestId, inputDigest),
      );
    }
    if (mutation.action === "adopt-source-suggestions") {
      const parsed = adoptSourceSuggestionsMutationSchema.parse(mutation);
      const input = {
        binding: parsed.binding,
        selections: parsed.selections,
        reviewed: parsed.reviewed,
      };
      const inputDigest = sourceSuggestionInputDigest(input);
      return this.update(
        id,
        parsed.revision,
        (record) => {
          const built = buildSourceSuggestionAdoption(
            record,
            input,
            {
              id: randomUUID(),
              clientRequestId: parsed.clientRequestId,
              inputDigest,
              recordedAt: new Date().toISOString(),
            },
            (sourceId) => this.originalForVentureInput(id, sourceId),
          );
          const source = record.sources.find((entry) => entry.id === parsed.binding.sourceId)!;
          const reviewContextChanged = (
            [
              "companyName",
              "businessNumber",
              "industry",
              "applicationDate",
              "applicationKind",
            ] as const
          ).some((key) => record.profile[key] !== built.profile[key]);
          if (reviewContextChanged)
            for (const key of ["sme", "industryEligibility"] as const)
              record.diagnosisAnswers[key] = {
                ...record.diagnosisAnswers[key],
                status: "unknown",
                reviewed: false,
              };
          record.profile = built.profile;
          if (built.receipt.sourceKindChanged) {
            source.kind = built.sourceKind;
            source.updatedAt = nextSourceTimestamp(source.updatedAt);
          }
          built.receipt.sourceUpdatedAtAfter = source.updatedAt;
          record.sourceSuggestionAdoptions.push(built.receipt);
          const changed = built.receipt.profileChanged || built.receipt.sourceKindChanged;
          if (changed) invalidateEvidence(record);
          return changed;
        },
        (record) =>
          isSourceSuggestionReplay(
            record.sourceSuggestionAdoptions,
            parsed.clientRequestId,
            inputDigest,
          ),
      );
    }
    if (mutation.action === "append-company-contacts") {
      const input = appendCompanyContactsMutationSchema.parse(mutation);
      const inputDigest = companyContactsInputDigest({
        previousVersionId: input.previousVersionId,
        contacts: input.contacts,
      });
      return this.update(
        id,
        input.revision,
        (record) => {
          record.companyContacts.push(
            buildCompanyContacts(record.companyContacts, input, {
              id: randomUUID(),
              recordedAt: new Date().toISOString(),
            }),
          );
          return false;
        },
        (record) =>
          isCompanyContactsReplay(record.companyContacts, input.clientRequestId, inputDigest),
      );
    }
    if (
      ["diagnose", "diagnosis-answers", "diagnosis-tasks", "create-agency-task"].includes(
        mutation.action,
      )
    )
      mutation = mutationSchema.parse(mutation);
    if (mutation.action === "select-candidate") {
      const input = candidateSelectionMutationSchema.parse(mutation);
      return this.update(
        id,
        input.revision,
        (record) => {
          const entry = buildCandidateSelection(record, input, {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
          });
          record.candidateSelections.push(entry);
          if (record.selectedCandidateId !== input.candidateId)
            record.plans = record.plans.map((plan) => ({ ...plan, confirmedAt: null }));
          record.selectedCandidateId = input.candidateId;
          return false;
        },
        (record) => isCandidateSelectionReplay(record, input),
      );
    }
    if (isApplicationMutation(mutation)) {
      const input = applicationMutationSchema.parse(mutation);
      return this.update(
        id,
        input.revision,
        (record, evidenceRevision) => {
          applyApplicationMutation(record, input, {
            evidenceRevision,
            readOriginal: (sourceId) => this.originalForVentureInput(id, sourceId),
          });
          return false;
        },
        (record) => isApplicationReplay(record, input),
      );
    }
    if (mutation.action === "create-certificate-task") {
      const input = createCertificateTaskMutationSchema.parse(mutation);
      return this.update(
        id,
        input.revision,
        (record) => {
          record.tasks.push(buildCertificateTask(record, input, randomUUID()));
          return false;
        },
        (record) => existingCertificateTask(record, input) !== null,
      );
    }
    if (mutation.action === "create-agency-task") {
      const input = mutation;
      return this.update(
        id,
        input.revision,
        (record) => {
          const request = currentAgencyTaskRequest(
            record,
            input.requestRecordId,
            input.requestVersionId,
          );
          if (record.tasks.length >= 200)
            throw new StudioError("기업별 업무는 200개까지 저장할 수 있습니다.", 413, "TASK_LIMIT");
          record.tasks.push({
            id: randomUUID(),
            title: `기관 요청 대응: ${request.title}`.slice(0, 300),
            category: "supplement",
            dueDate: request.dueOn,
            status: "pending",
            notes: `기관 요청 v${request.version}에 연결한 업무입니다.\n기관: ${request.institution}\n기록된 요청 기한: ${request.dueOn || "미확인"}\n기한 근거: ${request.dueNote || "미확인"}\n요청 원문과 연결 증빙은 위 기관 요청 기록에서 확인하세요. 업무 완료는 기관 발송·접수 확인이 아닙니다.`,
            agencyOrigin: {
              requestRecordId: input.requestRecordId,
              requestVersionId: input.requestVersionId,
            },
          });
          return false;
        },
        (record) => {
          // A lost response cannot create a duplicate task. Corrections still require
          // explicit review of the new request version before creating another task.
          currentAgencyTaskRequest(record, input.requestRecordId, input.requestVersionId);
          return record.tasks.some(
            (task) =>
              task.agencyOrigin?.requestRecordId === input.requestRecordId &&
              task.agencyOrigin.requestVersionId === input.requestVersionId,
          );
        },
      );
    }
    if (mutation.action === "diagnose") {
      // Only server-generated findings can enter the append-only diagnosis history.
      const requestDigest = createHash("sha256")
        .update(JSON.stringify({ action: "diagnose", revision: mutation.revision }))
        .digest("hex");
      return this.update(
        id,
        mutation.revision,
        (record) => {
          if (record.diagnoses.length >= MAX_DIAGNOSES)
            throw new StudioError(
              "사전진단은 기업별 50개 버전까지 보존합니다. 이전 이력을 지우지 않고 추가 진단을 중단합니다.",
              409,
              "DIAGNOSIS_LIMIT",
            );
          record.diagnoses.push({
            ...buildLocalDiagnosis(record),
            id: randomUUID(),
            clientRequestId: mutation.clientRequestId,
            requestDigest,
            version: Math.max(0, ...record.diagnoses.map((entry) => entry.version)) + 1,
            sourceRevision: record.revision,
            inputFingerprint: diagnosisInputFingerprint(record),
            criteriaVersion: diagnosisCriteriaVersion,
            generatedAt: new Date().toISOString(),
            stale: false,
          });
          return false;
        },
        (record) => {
          const matches = record.diagnoses.filter(
            (entry) => entry.clientRequestId === mutation.clientRequestId,
          );
          if (!matches.length) {
            const latest = record.diagnoses.at(-1);
            // A new click with unchanged inputs reuses the current result without
            // consuming history capacity. An old revision still follows normal CAS.
            return record.revision === mutation.revision && Boolean(latest && !latest.stale);
          }
          if (matches.length !== 1 || matches[0].requestDigest !== requestDigest)
            throw new StudioError(
              "이미 사용한 진단 요청과 내용이 다릅니다. 최신 내용을 불러와 주세요.",
              409,
              "DIAGNOSIS_REPLAY_CONFLICT",
            );
          // A lost response must not append another result, even after sources changed.
          // The old result remains explicitly stale in the current company response.
          return true;
        },
      );
    }
    if (mutation.action === "review-local-ocr") {
      const parsed = reviewLocalOcrMutationSchema.parse(mutation);
      const { revision, clientRequestId, ...input } = parsed;
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const inputDigest = digest(JSON.stringify(input));
      const textSha256 = digest(parsed.text);
      const assertOriginal = () => {
        const original = this.originalForVentureInput(id, parsed.sourceId);
        if (original.sha256 !== parsed.originalSha256)
          throw new StudioError(
            "판독한 원본이 변경되었습니다. 원본을 다시 확인해 주세요.",
            409,
            "OCR_ORIGINAL_CHANGED",
          );
        return original;
      };
      return this.update(
        id,
        revision,
        (record) => {
          if (record.sourceOcrReviews.length >= MAX_OCR_REVIEWS)
            throw new StudioError(
              "판독문 검토 기록의 보관 한도에 도달했습니다. 기존 기록을 보존했습니다.",
              409,
              "OCR_REVIEW_LIMIT",
            );
          const source = record.sources.find((item) => item.id === parsed.sourceId);
          if (!source?.originalName)
            throw new StudioError(
              "이 기업에 보관한 원본 자료를 찾을 수 없습니다.",
              404,
              "SOURCE_NOT_FOUND",
            );
          if (source.extraction !== "pending" || source.text !== "")
            throw new StudioError(
              "본문이 이미 등록된 자료입니다. 현재 본문을 확인해 주세요.",
              409,
              "OCR_SOURCE_NOT_PENDING",
            );
          if (source.updatedAt !== parsed.sourceUpdatedAt)
            throw new StudioError(
              "자료가 변경되었습니다. 새 판독문으로 다시 확인해 주세요.",
              409,
              "OCR_SOURCE_CHANGED",
            );
          assertOriginal();
          const now = new Date().toISOString();
          const sourceUpdatedAt = nextSourceTimestamp(source.updatedAt);
          source.text = parsed.text;
          source.extraction = "manual";
          source.updatedAt = sourceUpdatedAt;
          const warnings = source.warnings.filter(
            (warning) => !originalOnlyWarnings.some((pending) => pending === warning),
          );
          source.warnings = [...new Set([...warnings, localOcrReviewedWarning])];
          if (source.warnings.length > 30)
            throw new StudioError(
              "자료의 기존 주의사항을 모두 보존할 수 없어 저장하지 않았습니다. 자료 구성을 확인해 주세요.",
              409,
              "OCR_REVIEW_WARNING_LIMIT",
            );
          record.sourceOcrReviews.push({
            id: randomUUID(),
            clientRequestId,
            inputDigest,
            sourceId: source.id,
            originalSha256: parsed.originalSha256,
            textSha256,
            reviewedAt: now,
            sourceUpdatedAt,
          });
          invalidateEvidence(record);
          return true;
        },
        (record) => {
          const matches = record.sourceOcrReviews.filter(
            (entry) => entry.clientRequestId === clientRequestId,
          );
          if (!matches.length) return false;
          if (matches.length !== 1 || matches[0].inputDigest !== inputDigest)
            throw new StudioError(
              "같은 저장 요청에 다른 내용이 포함되어 있습니다. 교정 내용을 다시 확인해 주세요.",
              409,
              "OCR_REVIEW_CONFLICT",
            );
          const previous = matches[0];
          const source = record.sources.find((item) => item.id === previous.sourceId);
          if (
            !source ||
            source.extraction !== "manual" ||
            source.updatedAt !== previous.sourceUpdatedAt ||
            digest(source.text) !== previous.textSha256
          )
            throw new StudioError(
              "저장 후 자료가 변경되었습니다. 최신 내용을 다시 확인해 주세요.",
              409,
              "OCR_REVIEW_CHANGED",
            );
          assertOriginal();
          return true;
        },
      );
    }
    if (mutation.action === "append-plan-review") {
      const parsed = appendPlanReviewMutationSchema.parse(mutation);
      const inputDigest = planReviewInputDigest(parsed.decision);
      return this.update(
        id,
        parsed.revision,
        (record, evidenceRevision) => {
          record.planReviewDecisions.push(
            buildPlanReviewDecision(record, parsed.decision, evidenceRevision, {
              id: randomUUID(),
              clientRequestId: parsed.clientRequestId,
              inputDigest,
              recordedAt: new Date().toISOString(),
            }),
          );
          return false;
        },
        (record) =>
          isPlanReviewReplay(record.planReviewDecisions, parsed.clientRequestId, inputDigest),
      );
    }
    if (mutation.action === "append-numeric-check") {
      const parsed = numericCheckAppendMutationSchema.parse(mutation);
      const inputDigest = numericCheckInputDigest(parsed.check);
      return this.update(
        id,
        parsed.revision,
        (record) => {
          record.numericChecks.push(
            buildNumericCheck(
              record,
              parsed.check,
              {
                id: randomUUID(),
                clientRequestId: parsed.clientRequestId,
                inputDigest,
                recordedAt: new Date().toISOString(),
              },
              (sourceId) => this.originalForVentureInput(id, sourceId),
            ),
          );
          return false;
        },
        (record) => isNumericCheckReplay(record.numericChecks, parsed.clientRequestId, inputDigest),
      );
    }
    if (mutation.action === "append-application-procedure") {
      const parsed = appendApplicationProcedureSchema.parse(mutation);
      const inputDigest = applicationProcedureDigest(parsed.procedure);
      return this.update(
        id,
        parsed.revision,
        (record) => {
          record.applicationProcedures.push(
            buildApplicationProcedure(
              record,
              record.applicationProcedures,
              parsed.procedure,
              {
                id: randomUUID(),
                clientRequestId: parsed.clientRequestId,
                recordedAt: new Date().toISOString(),
              },
              (sourceId) => this.originalForVentureInput(id, sourceId),
            ),
          );
          return false;
        },
        (record) =>
          isApplicationProcedureReplay(
            record.applicationProcedures,
            parsed.clientRequestId,
            inputDigest,
          ),
      );
    }
    if (mutation.action === "append-claim-review") {
      const parsed = appendClaimReviewMutationSchema.parse(mutation);
      const inputDigest = claimReviewInputDigest(parsed.claim);
      return this.update(
        id,
        parsed.revision,
        (record) => {
          record.claimReviews.push(
            buildClaimReview(
              record,
              parsed.claim,
              {
                id: randomUUID(),
                clientRequestId: parsed.clientRequestId,
                inputDigest,
                recordedAt: new Date().toISOString(),
              },
              (sourceId) => this.originalForVentureInput(id, sourceId),
            ),
          );
          return false;
        },
        (record) => isClaimReviewReplay(record.claimReviews, parsed.clientRequestId, inputDigest),
      );
    }
    if (mutation.action === "append-visit-answer") {
      const parsed = visitAnswerAppendMutationSchema.parse(mutation);
      const inputDigest = visitAnswerInputDigest(parsed.answer);
      return this.update(
        id,
        parsed.revision,
        (record) => {
          record.visitAnswers.push(
            buildVisitAnswer(
              record,
              parsed.answer,
              {
                id: randomUUID(),
                clientRequestId: parsed.clientRequestId,
                inputDigest,
                recordedAt: new Date().toISOString(),
              },
              (sourceId) => this.originalForVentureInput(id, sourceId),
            ),
          );
          return false;
        },
        (record) => isVisitAnswerReplay(record.visitAnswers, parsed.clientRequestId, inputDigest),
      );
    }
    if (mutation.action === "append-response-preparation") {
      const parsed = appendResponsePreparationMutationSchema.parse(mutation);
      const inputDigest = responsePreparationDigest(parsed.preparation);
      return this.update(
        id,
        parsed.revision,
        (record) => {
          record.responsePreparations.push(
            buildResponsePreparation(
              record,
              parsed.preparation,
              {
                id: randomUUID(),
                clientRequestId: parsed.clientRequestId,
                inputDigest,
                recordedAt: new Date().toISOString(),
              },
              (sourceId) => this.originalForVentureInput(id, sourceId),
            ),
          );
          return false;
        },
        (record) =>
          isResponsePreparationReplay(
            record.responsePreparations,
            parsed.clientRequestId,
            inputDigest,
          ),
      );
    }
    if (mutation.action === "register-prepared-response") {
      const parsed = registerPreparedResponseMutationSchema.parse(mutation);
      const inputDigest = preparedResponseRegistrationDigest(parsed);
      return this.update(
        id,
        parsed.revision,
        (record) => {
          record.agencyRecords.push(
            buildPreparedAgencyResponse(
              record,
              parsed,
              {
                id: randomUUID(),
                clientRequestId: parsed.clientRequestId,
                inputDigest,
                recordedAt: new Date().toISOString(),
              },
              (sourceId) => this.originalForVentureInput(id, sourceId),
            ),
          );
          return false;
        },
        (record) => isAgencyRecordReplay(record.agencyRecords, parsed.clientRequestId, inputDigest),
      );
    }
    if (mutation.action === "append-appeal-preparation") {
      const parsed = appealAppendMutationSchema.parse(mutation);
      const inputDigest = appealInputDigest(parsed.preparation);
      return this.update(
        id,
        parsed.revision,
        (record) => {
          record.appealPreparations.push(
            buildAppealPreparation(
              record,
              parsed.preparation,
              {
                id: randomUUID(),
                clientRequestId: parsed.clientRequestId,
                inputDigest,
                recordedAt: new Date().toISOString(),
              },
              (sourceId) => this.originalForVentureInput(id, sourceId),
            ),
          );
          return false;
        },
        (record) => isAppealReplay(record.appealPreparations, parsed.clientRequestId, inputDigest),
      );
    }
    if (mutation.action === "append-agency-record") {
      const parsed = agencyAppendMutationSchema.parse(mutation);
      const inputDigest = createHash("sha256").update(JSON.stringify(parsed.record)).digest("hex");
      return this.update(
        id,
        parsed.revision,
        (record) => {
          if (record.agencyRecords.length >= MAX_AGENCY_RECORDS)
            throw new StudioError(
              "기관 기록 보관 한도에 도달했습니다. 기존 기록을 보존하며 새 기록은 저장하지 않았습니다.",
              409,
              "AGENCY_RECORD_LIMIT",
            );
          // Membership is checked before opening any original, including another company's source ID.
          for (const sourceId of parsed.record.sourceIds)
            if (!record.sources.some((source) => source.id === sourceId && source.originalName))
              throw new StudioError(
                "이 기업에 보관된 원본 자료를 선택해 주세요.",
                404,
                "SOURCE_NOT_FOUND",
              );
          const recordedAt = new Date().toISOString();
          const evidence: AgencyEvidenceSnapshot[] = [];
          let totalBytes = 0;
          for (const sourceId of parsed.record.sourceIds) {
            const { source, buffer, sha256 } = this.originalForVentureInput(id, sourceId);
            if (
              originalConflicts(record, {
                sourceId,
                sha256,
                sizeBytes: buffer.length,
                originalName: source.originalName!,
                mimeType: source.mimeType,
              })
            )
              throw new StudioError(
                "이전에 기록한 원본과 현재 파일이 다릅니다. 새 원본은 별도 자료로 등록해 주세요.",
                409,
                "AGENCY_EVIDENCE_CHANGED",
              );
            totalBytes += buffer.length;
            if (totalBytes > MAX_AGENCY_EVIDENCE_BYTES)
              throw new StudioError(
                "한 기록의 원본 합계는 24MiB 이하여야 합니다.",
                413,
                "AGENCY_EVIDENCE_LIMIT",
              );
            evidence.push({
              sourceId,
              sourceName: source.name,
              originalName: source.originalName!,
              mimeType: source.mimeType,
              sizeBytes: buffer.length,
              sha256,
              capturedAt: recordedAt,
              sourceUpdatedAt: source.updatedAt,
            });
          }
          record.agencyRecords.push(
            buildAgencyRecord(record.agencyRecords, parsed.record, {
              id: randomUUID(),
              clientRequestId: parsed.clientRequestId,
              inputDigest,
              recordedAt,
              evidence,
            }),
          );
          return false;
        },
        (record) => isAgencyRecordReplay(record.agencyRecords, parsed.clientRequestId, inputDigest),
      );
    }
    const result = this.update(id, mutation.revision, (record, evidenceRevision) => {
      switch (mutation.action) {
        case "diagnosis-answers":
          assertDiagnosisAnswers(record, mutation.answers);
          record.diagnosisAnswers = mutation.answers;
          invalidateEvidence(record);
          return true;
        case "diagnosis-tasks": {
          const diagnosis = record.diagnoses.at(-1);
          if (!diagnosis || diagnosis.id !== mutation.diagnosisId || diagnosis.stale)
            throw new StudioError(
              "최신 자료로 사전진단한 뒤 과제를 등록해 주세요.",
              409,
              "DIAGNOSIS_OUTDATED",
            );
          const selected = mutation.actionIds.map((actionId) => {
            const action = diagnosis.actions.find((entry) => entry.id === actionId);
            if (!action)
              throw new StudioError(
                "진단 결과에 없는 과제입니다.",
                400,
                "INVALID_DIAGNOSIS_ACTION",
              );
            return action;
          });
          if (new Set(mutation.actionIds).size !== mutation.actionIds.length)
            throw new StudioError(
              "중복 과제는 선택할 수 없습니다.",
              400,
              "INVALID_DIAGNOSIS_ACTION",
            );
          const missing = selected.filter(
            (action) =>
              !record.tasks.some(
                (task) =>
                  task.diagnosisOrigin?.diagnosisId === diagnosis.id &&
                  task.diagnosisOrigin.actionId === action.id,
              ),
          );
          if (record.tasks.length + missing.length > 200)
            throw new StudioError("기업별 업무는 200개까지 저장할 수 있습니다.", 413, "TASK_LIMIT");
          for (const action of missing)
            record.tasks.push({
              id: randomUUID(),
              title: action.title,
              notes: action.notes,
              category: "evidence",
              dueDate: "",
              status: "pending",
              diagnosisOrigin: { diagnosisId: diagnosis.id, actionId: action.id },
            });
          return false;
        }
        case "profile": {
          const reviewContextChanged = (
            [
              "companyName",
              "businessNumber",
              "industry",
              "applicationDate",
              "applicationKind",
            ] as const
          ).some((key) => record.profile[key] !== mutation.profile[key]);
          if (reviewContextChanged) {
            for (const key of ["sme", "industryEligibility"] as const)
              record.diagnosisAnswers[key] = {
                ...record.diagnosisAnswers[key],
                status: "unknown",
                reviewed: false,
              };
          }
          record.profile = mutation.profile;
          invalidateEvidence(record);
          return true;
        }
        case "source": {
          if (!mutation.source.text.trim())
            throw new StudioError("자료 내용을 입력해 주세요.", 400, "SOURCE_TEXT_REQUIRED");
          const existing = record.sources.find((source) => source.id === mutation.source.id);
          if (
            !existing &&
            record.sourceIntakes.some((item) => item.sourceId === mutation.source.id)
          )
            throw new StudioError(
              "원본 접수에 예약된 자료 식별자는 수동 등록에 사용할 수 없습니다.",
              409,
              "INTAKE_SOURCE_RESERVED",
            );
          const now = nextSourceTimestamp(existing?.updatedAt);
          // File ownership and extraction metadata are assigned by the server only.
          const source: SourceDocument = {
            ...mutation.source,
            originalName: existing?.originalName ?? null,
            mimeType: existing?.mimeType ?? null,
            extraction: "manual",
            warnings:
              existing?.extraction === "pending"
                ? existing.warnings.filter(
                    (warning) => !originalOnlyWarnings.some((pending) => pending === warning),
                  )
                : (existing?.warnings ?? []),
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
          if (
            record.applicationProcedures.some((entry) =>
              entry.sourceSnapshots.some((source) => source.sourceId === mutation.sourceId),
            )
          )
            throw new StudioError(
              "신청 절차 이력에 연결한 자료는 삭제할 수 없습니다. 기존 근거를 보존해 주세요.",
              409,
              "PROCEDURE_SOURCE_REFERENCED",
            );
          if (
            record.sourceSuggestionAdoptions.some(
              (entry) => entry.binding.sourceId === mutation.sourceId,
            )
          )
            throw new StudioError(
              "기업정보 제안 채택 이력에 연결한 자료는 삭제할 수 없습니다.",
              409,
              "SUGGESTION_SOURCE_REFERENCED",
            );
          if (record.sourceIntakes.some((item) => item.sourceId === mutation.sourceId))
            throw new StudioError(
              "접수 이력에 연결한 원본은 삭제할 수 없습니다.",
              409,
              "INTAKE_SOURCE_REFERENCED",
            );
          if (
            record.claimReviews.some((entry) =>
              entry.sourceSnapshots.some((source) => source.sourceId === mutation.sourceId),
            )
          )
            throw new StudioError(
              "주장 검토 이력에 연결한 자료는 삭제할 수 없습니다. 기존 근거를 보존해 주세요.",
              409,
              "CLAIM_SOURCE_REFERENCED",
            );
          if (
            record.numericChecks.some((entry) =>
              entry.sourceSnapshots.some((source) => source.sourceId === mutation.sourceId),
            )
          )
            throw new StudioError(
              "수치 대조 이력에 연결한 자료는 삭제할 수 없습니다. 기존 근거를 보존해 주세요.",
              409,
              "NUMERIC_SOURCE_REFERENCED",
            );
          if (
            record.visitAnswers.some((entry) =>
              entry.sourceSnapshots.some((source) => source.sourceId === mutation.sourceId),
            )
          )
            throw new StudioError(
              "실사 답변 이력에 연결한 자료는 삭제할 수 없습니다. 기존 근거를 보존해 주세요.",
              409,
              "VISIT_SOURCE_REFERENCED",
            );
          if (
            record.responsePreparations.some((entry) =>
              entry.sourceSnapshots.some((source) => source.sourceId === mutation.sourceId),
            )
          )
            throw new StudioError(
              "보완 답변 준비 이력에 연결한 자료는 삭제할 수 없습니다.",
              409,
              "RESPONSE_SOURCE_REFERENCED",
            );
          if (applicationSourceReferenced(record, mutation.sourceId))
            throw new StudioError(
              "제출 당시 기록에 연결한 원본은 삭제할 수 없습니다. 기존 이력을 보존해 주세요.",
              409,
              "APPLICATION_SOURCE_REFERENCED",
            );
          if (
            record.appealPreparations.some((entry) =>
              entry.sourceSnapshots.some((item) => item.sourceId === mutation.sourceId),
            )
          )
            throw new StudioError(
              "소명 준비 이력에 연결한 자료는 삭제할 수 없습니다. 기존 근거를 보존해 주세요.",
              409,
              "APPEAL_SOURCE_REFERENCED",
            );
          if (
            record.agencyRecords.some((entry) =>
              entry.evidence.some((item) => item.sourceId === mutation.sourceId),
            )
          )
            throw new StudioError(
              "기관 요청·답변 기록에 연결된 원본은 삭제할 수 없습니다. 기존 증빙을 보존해 주세요.",
              409,
              "AGENCY_SOURCE_REFERENCED",
            );
          record.sources = record.sources.filter((source) => source.id !== mutation.sourceId);
          invalidateEvidence(record);
          return true;
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
          changeStage(record, mutation.stage, {
            origin: "manual",
            occurredOn: mutation.occurredOn ?? "",
            note: mutation.note ?? "",
          });
          return false;
        case "task": {
          const previous = record.tasks.find((task) => task.id === mutation.task.id);
          const input = { ...mutation.task };
          delete input.diagnosisOrigin;
          delete input.agencyOrigin;
          delete input.certificateOrigin;
          if (
            input.processing?.planRefs.some(
              (reference) => resolveTaskPlanReference(record.plans, reference).state !== "matched",
            )
          )
            throw new StudioError(
              "연결할 원고 버전과 항목의 인용을 확인해 주세요. 다른 기업이나 일치하지 않는 원고는 연결할 수 없습니다.",
              409,
              "TASK_PLAN_REFERENCE_INVALID",
            );
          const task = {
            ...input,
            ...(input.processing === undefined && previous?.processing
              ? { processing: previous.processing }
              : {}),
            ...(input.owners === undefined && previous?.owners ? { owners: previous.owners } : {}),
            ...(previous?.diagnosisOrigin ? { diagnosisOrigin: previous.diagnosisOrigin } : {}),
            ...(previous?.agencyOrigin ? { agencyOrigin: previous.agencyOrigin } : {}),
            ...(previous?.certificateOrigin
              ? { certificateOrigin: previous.certificateOrigin }
              : {}),
          };
          record.tasks = record.tasks.some((task) => task.id === mutation.task.id)
            ? record.tasks.map((entry) => (entry.id === task.id ? task : entry))
            : [...record.tasks, task];
          return false;
        }
        case "delete-task":
          record.tasks = record.tasks.filter((task) => task.id !== mutation.taskId);
          return false;
        default:
          throw new StudioError("지원하지 않는 변경 요청입니다.", 400, "INVALID_ACTION");
      }
    });
    if (mutation.action === "delete-source") this.removeOriginal(id, mutation.sourceId);
    return result;
  }
  saveAnalysis(id: string, revision: number, content: AnalysisContent, mode: "ai" | "assisted") {
    return this.update(id, revision, (record) => {
      applyAnalysis(record, content, mode, revision);
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
      if (record.selectedCandidateId !== candidateId || !currentVerifiedCandidateSelection(record))
        throw new StudioError(
          "현재 분석의 후보와 선택 이유를 먼저 저장해 주세요.",
          409,
          "CANDIDATE_SELECTION_REQUIRED",
        );
      appendGeneratedPlan(record, revision, candidateId, content, review, mode);
      return false;
    });
  }

  /** Only fixed local orchestration calls these methods; no client artifact payload is accepted. */
  setPreparationAutomation(id: string, rawInput: PreparationAutomationSettingInput): StudioCase {
    const input = preparationAutomationSettingInputSchema.parse(rawInput);
    const meta = { id: randomUUID(), at: new Date().toISOString() };
    let transition: ReturnType<typeof configurePreparationAutomation> | undefined;
    return this.update(
      id,
      input.revision,
      (record) => {
        transition ??= configurePreparationAutomation(record, input, meta);
        record.preparationAutomation = transition.state;
        return false;
      },
      (record) => {
        transition = configurePreparationAutomation(record, input, meta);
        return !transition.changed;
      },
    );
  }
  beginPreparationAutomation(id: string, rawInput: PreparationAutomationRequest) {
    const input = preparationAutomationRequestSchema.parse(rawInput);
    const meta = { id: randomUUID(), at: new Date().toISOString() };
    let transition: AutomationTransition | undefined;
    const company = this.update(
      id,
      input.revision,
      (record) => {
        transition ??= beginAutomation(record, input, meta);
        record.preparationAutomation = transition.state;
        return false;
      },
      (record) => {
        transition = beginAutomation(record, input, meta);
        return transition.replayed;
      },
    );
    return {
      company,
      batch: transition!.batch,
      command: transition!.command,
      replayed: transition!.replayed,
    };
  }
  finishPreparationAutomation(id: string, revision: number, batchId: string, runId: string) {
    let transition: AutomationTransition | undefined;
    const company = this.update(id, revision, (record) => {
      transition = finishAutomation(record, batchId, runId, new Date().toISOString());
      record.preparationAutomation = transition.state;
      return false;
    });
    return { company, batch: transition!.batch };
  }
  beginPreparation(id: string, rawInput: PreparationRequest): StudioCase {
    const input = preparationRequestSchema.parse(rawInput);
    const digest = preparationDigest(input);
    return this.update(
      id,
      input.revision,
      (record, evidenceRevision) => {
        const now = new Date().toISOString();
        if (input.action === "start") {
          if (record.preparationRuns.length >= MAX_PREPARATION_RUNS)
            preparationError("PREPARATION_LIMIT");
          if (
            record.preparationRuns.some(
              (run) => !run.stale && ["running", "failed", "awaiting_choice"].includes(run.status),
            )
          )
            preparationError("PREPARATION_ACTIVE");
          const selected = currentVerifiedCandidateSelection(record)
            ? record.analysis?.candidates.find((item) => item.id === record.selectedCandidateId)
            : undefined;
          const existingPlan = selected
            ? record.plans
                .filter(
                  (plan) =>
                    plan.candidateId === selected.id && plan.sourceRevision >= evidenceRevision,
                )
                .at(-1)
            : undefined;
          const run: PreparationRun = {
            id: randomUUID(),
            mode: "assisted",
            inputFingerprint: diagnosisInputFingerprint(record),
            criteriaVersion: diagnosisCriteriaVersion,
            sourceRevision: record.revision,
            createdAt: now,
            updatedAt: now,
            status: "running",
            phase: "diagnosis",
            stale: false,
            code: null,
            diagnosisId: null,
            analysisDigest: record.analysis ? preparationDigest(record.analysis) : null,
            candidates: [],
            selectedCandidateId: selected?.id ?? null,
            selectedCandidateDigest: selected ? preparationDigest(selected) : null,
            planId: existingPlan?.id ?? null,
            planDigest: existingPlan ? preparationDigest(existingPlan) : null,
            steps: [],
            requests: [{ clientRequestId: input.clientRequestId, digest }],
          };
          record.preparationRuns.push(run);
          return false;
        }
        const run = record.preparationRuns.find((item) => item.id === input.runId);
        if (!run) preparationError("PREPARATION_NOT_FOUND");
        if (run.stale) preparationError("PREPARATION_STALE");
        if (run.requests.length >= MAX_PREPARATION_REQUESTS)
          preparationError("PREPARATION_REQUEST_LIMIT");
        if (input.action === "continue") {
          if (run.status !== "awaiting_choice" || run.phase !== "choice")
            preparationError("PREPARATION_STEP_INVALID");
          const selected = record.analysis?.candidates.filter(
            (item) => item.id === input.candidateId,
          );
          const binding = run.candidates.find((item) => item.id === input.candidateId);
          if (
            selected?.length !== 1 ||
            !binding ||
            binding.digest !== input.candidateDigest ||
            preparationDigest(selected[0]) !== input.candidateDigest
          )
            preparationError("PREPARATION_CANDIDATE_CHANGED");
          if (
            record.selectedCandidateId !== input.candidateId ||
            !currentVerifiedCandidateSelection(record)
          )
            preparationError("PREPARATION_SELECTION_REQUIRED");
          run.selectedCandidateId = input.candidateId;
          run.selectedCandidateDigest = input.candidateDigest;
          const plan = record.plans
            .filter(
              (item) =>
                item.candidateId === input.candidateId && item.sourceRevision >= evidenceRevision,
            )
            .at(-1);
          run.planId = plan?.id ?? null;
          run.planDigest = plan ? preparationDigest(plan) : null;
          run.steps.push({
            phase: "selection",
            state: "selected",
            artifactId: input.candidateId,
            at: now,
          });
          run.phase = "plan";
          run.status = "running";
        } else if (run.status === "failed" || run.status === "running") {
          run.status = "running";
        } else if (
          !["awaiting_choice", "awaiting_materials", "awaiting_review"].includes(run.status)
        )
          preparationError("PREPARATION_STEP_INVALID");
        run.code = null;
        run.updatedAt = now;
        run.requests.push({ clientRequestId: input.clientRequestId, digest });
        return false;
      },
      (record) => {
        const found = record.preparationRuns.flatMap((run) =>
          run.requests
            .filter((request) => request.clientRequestId === input.clientRequestId)
            .map((request) => ({ run, request })),
        );
        if (!found.length) return false;
        if (
          found.length !== 1 ||
          found[0].request.digest !== digest ||
          (input.action !== "start" && found[0].run.id !== input.runId)
        )
          preparationError("PREPARATION_REQUEST_CONFLICT");
        return true;
      },
    );
  }

  /** A checkpoint and its artifact are committed by one existing Studio transaction. */
  commitPreparation(
    id: string,
    revision: number,
    runId: string,
    step:
      | { phase: "diagnosis" }
      | { phase: "analysis"; content: AnalysisContent | null }
      | { phase: "plan"; content: PlanContent | null; review: ReviewFinding[] },
  ): StudioCase {
    return this.update(id, revision, (record) => {
      const run = record.preparationRuns.find((item) => item.id === runId);
      if (!run) preparationError("PREPARATION_NOT_FOUND");
      if (run.stale) preparationError("PREPARATION_STALE");
      if (run.status !== "running" || run.phase !== step.phase)
        preparationError("PREPARATION_STEP_INVALID");
      const now = new Date().toISOString();
      let evidenceChanged = false;
      if (step.phase === "diagnosis") {
        let diagnosis = record.diagnoses.at(-1);
        const reused = Boolean(diagnosis && !diagnosis.stale);
        if (!reused) {
          if (record.diagnoses.length >= MAX_DIAGNOSES) preparationError("DIAGNOSIS_LIMIT");
          diagnosis = {
            ...buildLocalDiagnosis(record),
            id: randomUUID(),
            clientRequestId: randomUUID(),
            requestDigest: preparationDigest({ runId, phase: "diagnosis" }),
            version: Math.max(0, ...record.diagnoses.map((item) => item.version)) + 1,
            sourceRevision: record.revision,
            inputFingerprint: diagnosisInputFingerprint(record),
            criteriaVersion: diagnosisCriteriaVersion,
            generatedAt: now,
            stale: false,
          };
          record.diagnoses.push(diagnosis);
        }
        run.diagnosisId = diagnosis!.id;
        run.steps.push({
          phase: "diagnosis",
          state: reused ? "reused" : "created",
          artifactId: diagnosis!.id,
          at: now,
        });
        run.phase = "analysis";
      } else if (step.phase === "analysis") {
        const reused = Boolean(record.analysis);
        if (reused && step.content !== null) preparationError("PREPARATION_STEP_INVALID");
        if (!record.analysis) {
          if (!step.content) preparationError("PREPARATION_STEP_INVALID");
          applyAnalysis(record, step.content, "assisted", revision);
          evidenceChanged = true;
        }
        const analysis = record.analysis!;
        if (new Set(analysis.candidates.map((item) => item.id)).size !== analysis.candidates.length)
          preparationError("PREPARATION_CANDIDATE_CHANGED");
        run.analysisDigest = preparationDigest(analysis);
        run.candidates = analysis.candidates.map((candidate) => ({
          id: candidate.id,
          digest: preparationDigest(candidate),
        }));
        run.steps.push({
          phase: "analysis",
          state: reused ? "reused" : "created",
          artifactId: null,
          at: now,
        });
        if (run.selectedCandidateId) {
          if (
            record.selectedCandidateId !== run.selectedCandidateId ||
            !currentVerifiedCandidateSelection(record)
          )
            preparationError("PREPARATION_SELECTION_REQUIRED");
          run.steps.push({
            phase: "selection",
            state: "reused",
            artifactId: run.selectedCandidateId,
            at: now,
          });
          run.phase = "plan";
        } else {
          run.phase = "choice";
          run.status = analysis.candidates.length ? "awaiting_choice" : "awaiting_materials";
        }
      } else {
        if (!run.selectedCandidateId) preparationError("PREPARATION_CANDIDATE_CHANGED");
        if (
          record.selectedCandidateId !== run.selectedCandidateId ||
          !currentVerifiedCandidateSelection(record)
        )
          preparationError("PREPARATION_SELECTION_REQUIRED");
        let plan = run.planId ? record.plans.find((item) => item.id === run.planId) : undefined;
        const reused = Boolean(plan);
        if (reused && step.content !== null) preparationError("PREPARATION_STEP_INVALID");
        if (!plan) {
          if (!step.content || step.content.sections.some((section) => !section.needsConfirmation))
            preparationError("PREPARATION_REVIEW_REQUIRED");
          plan = appendGeneratedPlan(
            record,
            revision,
            run.selectedCandidateId,
            step.content,
            step.review,
            "assisted",
          );
        }
        run.planId = plan.id;
        run.planDigest = preparationDigest(plan);
        run.steps.push({
          phase: "plan",
          state: reused ? "reused" : "created",
          artifactId: plan.id,
          at: now,
        });
        run.phase = "review";
        run.status = "awaiting_review";
      }
      run.updatedAt = now;
      run.code = null;
      return evidenceChanged;
    });
  }

  failPreparation(
    id: string,
    revision: number,
    runId: string,
    code: "PREPARATION_FAILED" | "PREPARATION_STALE",
  ): StudioCase {
    return this.update(id, revision, (record) => {
      const run = record.preparationRuns.find((item) => item.id === runId);
      if (!run || run.status !== "running") preparationError("PREPARATION_STEP_INVALID");
      run.status = run.stale || code === "PREPARATION_STALE" ? "blocked" : "failed";
      run.code = code;
      run.updatedAt = new Date().toISOString();
      return false;
    });
  }
  createSourceIntakeBatch(id: string, input: CreateSourceIntakeCommand) {
    const parsed = createSourceIntakeSchema.parse(input),
      digest = intakeDigest(parsed);
    let batchId = "";
    const company = this.update(
      id,
      parsed.revision,
      (record) => {
        const items = newSourceIntakeBatch(parsed);
        batchId = items[0].batchId;
        record.sourceIntakes.push(...items);
        return false;
      },
      (record) => {
        const item = intakeReplay(record, parsed.clientRequestId, digest);
        if (item) batchId = item.batchId;
        return Boolean(item);
      },
    );
    return intakeResponse(company, null, batchId);
  }
  /** Commit ownership before touching disk. Only this durable ID may be recovered. */
  storeSourceIntakeOriginal(
    id: string,
    itemId: string,
    input: SourceIntakeOriginalInput,
    upload: { name: string; mimeType: string | null; buffer: Buffer },
  ) {
    const parsed = sourceIntakeOriginalInputSchema.parse(input);
    const buffer = Buffer.from(upload.buffer);
    if (!buffer.length || buffer.length > sourceIntakeLimits.fileBytes)
      intakeError("INTAKE_ORIGINAL_INVALID", 413);
    const sha256 = intakeSha(buffer);
    const digest = intakeDigest({
      action: "original",
      itemId,
      ...parsed,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: buffer.length,
      sha256,
    });
    const checkpoint = this.update(
      id,
      parsed.revision,
      (record) => {
        const item = intakeItem(record, itemId);
        if (item.phase !== "awaiting_original" || item.original)
          intakeError("INTAKE_PHASE_INVALID");
        if (upload.name !== item.declared.originalName || buffer.length !== item.declared.sizeBytes)
          intakeError("INTAKE_ORIGINAL_INVALID");
        intakeTouch(item, parsed.expectedItemVersion);
        item.original = {
          originalName: upload.name,
          mimeType: upload.mimeType,
          sizeBytes: buffer.length,
          sha256,
          sourceUpdatedAt: new Date().toISOString(),
        };
        validateVentureOriginalMetadata(pendingIntakeSource(item));
        item.phase = "storing_original";
        intakeRequest(item, "original", parsed.clientRequestId, digest);
        return false;
      },
      (record) => Boolean(intakeReplay(record, parsed.clientRequestId, digest)),
    );
    const item = intakeItem(checkpoint, itemId);
    if (item.phase !== "storing_original") return intakeResponse(checkpoint, itemId);
    if (
      !item.original ||
      item.original.sha256 !== sha256 ||
      item.original.sizeBytes !== buffer.length ||
      item.original.originalName !== upload.name ||
      item.original.mimeType !== upload.mimeType
    )
      intakeError("INTAKE_ORIGINAL_CHANGED");
    const file = this.filePath(id, item.sourceId);
    this.ensureIntakeDirectory(id, item.sourceId);
    let present = false;
    try {
      lstatSync(file);
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw originalReadError("UNSAFE_ORIGINAL_PATH");
    }
    if (!present) this.writeIntakeOriginal(id, item.sourceId, buffer);
    const original = this.readIntakeCheckpoint(id, itemId, checkpoint.revision);
    assertIntakeOriginal(item, original);
    const company = this.update(id, checkpoint.revision, (record) => {
      const current = intakeItem(record, itemId);
      if (
        current.phase !== "storing_original" ||
        current.version !== item.version ||
        record.sources.some((source) => source.id === item.sourceId)
      )
        intakeError("INTAKE_STALE");
      assertIntakeOriginal(current, this.readIntakeCheckpoint(id, itemId, checkpoint.revision));
      record.sources.push(pendingIntakeSource(current));
      current.phase = "original_stored";
      intakeTouch(current);
      invalidateEvidence(record);
      return true;
    });
    return intakeResponse(company, itemId);
  }
  private ensureIntakeDirectory(id: string, sourceId: string) {
    inspectOriginalPath(this.root, this.root, true);
    const parent = resolve(this.filePath(id, sourceId), "..");
    for (const path of [resolve(this.root, "originals"), parent]) {
      try {
        mkdirSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw originalReadError("UNSAFE_ORIGINAL_PATH");
      }
      inspectOriginalPath(this.root, path, true);
    }
  }
  private writeIntakeOriginal(id: string, sourceId: string, buffer: Buffer) {
    const file = this.filePath(id, sourceId),
      parent = resolve(file, "..");
    const parents = inspectOriginalPath(this.root, parent, true);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        file,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
        0o600,
      );
      const before = fstatSync(descriptor, { bigint: true });
      const path = inspectOriginalPath(this.root, file);
      if (
        before.nlink !== BigInt(1) ||
        !sameOriginalIdentity(before, path.at(-1)!) ||
        parents.some((stat, index) => !sameOriginalIdentity(stat, path[index]))
      )
        throw originalReadError("UNSAFE_ORIGINAL_PATH");
      writeFileSync(descriptor, buffer);
      fsyncSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true }),
        finalPath = inspectOriginalPath(this.root, file);
      if (
        after.size !== BigInt(buffer.length) ||
        !sameOriginalStat(after, finalPath.at(-1)!) ||
        !sameOriginalIdentity(before, after) ||
        parents.some((stat, index) => !sameOriginalIdentity(stat, finalPath[index]))
      )
        throw originalReadError("ORIGINAL_CHANGED");
    } catch (error) {
      if (error instanceof StudioError) throw error;
      throw originalReadError("ORIGINAL_UNAVAILABLE");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  private readIntakeCheckpoint(id: string, itemId: string, revision: number) {
    const company = this.get(id),
      item = intakeItem(company, itemId);
    if (company.revision !== revision || item.phase !== "storing_original")
      intakeError("INTAKE_STALE");
    return this.readSafeOriginal(id, pendingIntakeSource(item), () => {
      const current = this.get(id);
      if (
        current.revision !== revision ||
        JSON.stringify(intakeItem(current, itemId)) !== JSON.stringify(item)
      )
        intakeError("INTAKE_STALE");
    });
  }
  resumeSourceIntakeOriginal(id: string, input: ResumeSourceIntakeCommand) {
    const parsed = resumeSourceIntakeSchema.parse(input),
      digest = intakeDigest(parsed);
    const company = this.update(
      id,
      parsed.revision,
      (record) => {
        const item = intakeItem(record, parsed.itemId);
        if (item.phase !== "storing_original") intakeError("INTAKE_PHASE_INVALID");
        if (item.version !== parsed.expectedItemVersion) intakeError("INTAKE_STALE");
        const file = this.filePath(id, item.sourceId);
        let missing = false;
        try {
          lstatSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
          else throw originalReadError("UNSAFE_ORIGINAL_PATH");
        }
        if (missing) {
          // A missing leaf is accepted only beneath verified existing parents.
          this.ensureIntakeDirectory(id, item.sourceId);
          item.original = null;
          item.phase = "awaiting_original";
        } else {
          const original = this.readIntakeCheckpoint(id, item.id, record.revision);
          assertIntakeOriginal(item, original);
          if (record.sources.some((source) => source.id === item.sourceId))
            intakeError("INTAKE_STALE");
          record.sources.push(pendingIntakeSource(item));
          item.phase = "original_stored";
          invalidateEvidence(record);
        }
        intakeRequest(item, "resume", parsed.clientRequestId, digest);
        intakeTouch(item);
        return !missing;
      },
      (record) => Boolean(intakeReplay(record, parsed.clientRequestId, digest)),
    );
    return intakeResponse(company, parsed.itemId);
  }
  beginSourceIntakeAttempt(
    id: string,
    input: RunSourceIntakeCommand | ResumeSourceIntakeCommand,
    engine: SourceIntakeEngine,
  ) {
    // External engines require a separate, exact per-file approval and durable request checkpoint.
    if (engine !== "local-document" && engine !== "windows-ko") intakeError("INTAKE_PHASE_INVALID");
    const parsed =
      input.action === "run-next"
        ? runSourceIntakeSchema.parse(input)
        : resumeSourceIntakeSchema.parse(input);
    const digest = intakeDigest(parsed);
    let started = false,
      attemptId: string | null = null;
    const company = this.update(
      id,
      parsed.revision,
      (record) => {
        const item = intakeItem(record, parsed.itemId);
        if (["awaiting_review", "adopted"].includes(item.phase))
          intakeError("INTAKE_PHASE_INVALID");
        if (
          !item.original ||
          ![
            "original_stored",
            "awaiting_method",
            "awaiting_capacity",
            "retryable_failure",
            "result_discarded",
            ...(parsed.action === "resume" ? ["extracting_local"] : []),
          ].includes(item.phase)
        )
          intakeError("INTAKE_PHASE_INVALID");
        if (item.version !== parsed.expectedItemVersion) intakeError("INTAKE_STALE");
        if (
          !sourceIntakeEngineSupports(item.original.originalName, engine) ||
          (parsed.action === "run-next" && parsed.engine !== engine)
        )
          intakeError("INTAKE_PHASE_INVALID");
        if (item.attempts.length >= sourceIntakeLimits.attempts) intakeError("INTAKE_LIMIT", 413);
        assertIntakeOriginal(item, this.originalForVentureInput(id, item.sourceId));
        if (item.phase === "extracting_local") {
          const previous = item.attempts.at(-1);
          if (
            !previous ||
            previous.externalRequestStarted ||
            previous.status !== "running" ||
            previous.engine !== engine
          )
            intakeError("INTAKE_STALE");
          previous.status = "failed";
          previous.code = "INTAKE_INTERRUPTED";
          previous.finishedAt = new Date().toISOString();
        }
        if (item.result) {
          if (item.result.content !== null) intakeError("INTAKE_PHASE_INVALID");
          item.previousResults.push(item.result);
          item.result = null;
        }
        attemptId = randomUUID();
        item.attempts.push({
          id: attemptId,
          engine,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          originalSha256: item.original.sha256,
          sourceUpdatedAt: item.original.sourceUpdatedAt,
          externalRequestStarted: false,
          status: "running",
          code: null,
          resultId: null,
        });
        item.phase = "extracting_local";
        item.code = null;
        intakeRequest(item, parsed.action, parsed.clientRequestId, digest);
        intakeTouch(item);
        started = true;
        return false;
      },
      (record) => Boolean(intakeReplay(record, parsed.clientRequestId, digest)),
    );
    return { response: intakeResponse(company, parsed.itemId), started, attemptId };
  }
  finishSourceIntakeAttempt(
    id: string,
    binding: SourceIntakeAttemptBinding,
    outcome: SourceIntakeOutcome,
  ) {
    const company = this.update(id, binding.revision, (record) => {
      const item = intakeItem(record, binding.itemId),
        attempt = item.attempts.at(-1);
      if (
        item.version !== binding.itemVersion ||
        item.phase !== "extracting_local" ||
        !attempt ||
        attempt.externalRequestStarted ||
        attempt.id !== binding.attemptId ||
        attempt.status !== "running"
      )
        intakeError("INTAKE_STALE");
      assertIntakeOriginal(item, this.originalForVentureInput(id, item.sourceId));
      if (
        attempt.originalSha256 !== item.original?.sha256 ||
        attempt.sourceUpdatedAt !== item.original?.sourceUpdatedAt
      )
        intakeError("INTAKE_STALE");
      const now = new Date().toISOString();
      if (outcome.status === "completed") {
        const content = sourceIntakeContentSchema.parse(outcome.content),
          text = sourceIntakeResultText(content);
        const retained = retainIntakeLocations(record.sourceIntakes, text, outcome.locations);
        if (
          !(content.kind === "plain"
            ? content.text.trim()
            : content.pages.some((page) => page.text.trim()))
        )
          intakeError("INTAKE_RESULT_INVALID", 422);
        if (
          text.length > sourceIntakeLimits.resultText ||
          intakeRetainedCharacters(record.sourceIntakes) + text.length >
            sourceIntakeLimits.retainedText
        ) {
          attempt.status = "failed";
          attempt.code = "INTAKE_RESULT_LIMIT";
          item.phase = "awaiting_capacity";
          item.code = attempt.code;
        } else {
          const resultId = randomUUID();
          item.result = {
            id: resultId,
            attemptId: attempt.id,
            engine: attempt.engine,
            generatedAt: now,
            originalSha256: attempt.originalSha256,
            sourceUpdatedAt: attempt.sourceUpdatedAt,
            textSha256: intakeSha(text),
            content,
            warnings: z.array(z.string().max(1000)).max(30).parse(outcome.warnings),
            reviewStatus: "unreviewed",
            discardedAt: null,
            ...(retained.locations ? { locations: retained.locations } : {}),
          };
          if (retained.limited && item.result.warnings.length < 30)
            item.result.warnings.push(
              "위치 정보 보관 한도로 일부 구조 위치를 보관하지 못했습니다. 본문은 유지되며 누락 위치는 미확인입니다.",
            );
          attempt.status = "completed";
          attempt.resultId = resultId;
          item.phase = "awaiting_review";
          item.code = null;
        }
      } else {
        const failure = z
          .object({
            status: z.literal("failed"),
            code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
            phase: z.enum(["awaiting_method", "retryable_failure", "awaiting_capacity"]),
          })
          .strict()
          .parse(outcome);
        attempt.status = "failed";
        attempt.code = failure.code;
        item.phase = failure.phase;
        item.code = failure.code;
      }
      attempt.finishedAt = now;
      intakeTouch(item);
      return false;
    });
    return intakeResponse(company, binding.itemId);
  }
  previewSourceIntakeExternal(
    id: string,
    input: SourceIntakeExternalApprovalPreviewInput,
    configuration: SourceIntakeExternalConfiguration,
  ): SourceIntakeExternalApprovalPreview {
    const parsed = sourceIntakeExternalApprovalPreviewInputSchema.parse(input);
    assertVentureCompanyWritable(id);
    const record = this.get(id),
      item = intakeItem(record, parsed.itemId);
    if (
      record.revision !== parsed.revision ||
      item.version !== parsed.expectedItemVersion ||
      configuration.engine !== parsed.engine
    )
      externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
    const approval = buildExternalIntakeApproval(
      record,
      item,
      configuration,
      this.originalForVentureInput(id, item.sourceId),
    );
    assertVentureCompanyWritable(id);
    if (JSON.stringify(this.get(id)) !== JSON.stringify(record))
      externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
    return {
      companyRevision: record.revision,
      approval,
      requiresDuplicateAcknowledgement: externalIntakeNeedsDuplicateAcknowledgement(item),
      externalTransmissionPerformed: false,
    };
  }
  /** Only invoked by the provider's beforeRequest hook, after its local setup succeeded. */
  beginSourceIntakeExternalAttempt(
    id: string,
    input: RunExternalSourceIntakeCommand,
    configuration: SourceIntakeExternalConfiguration,
  ) {
    const parsed = runExternalSourceIntakeSchema.parse(input),
      digest = externalIntakeRequestDigest(parsed);
    let started = false,
      attemptId: string | null = null;
    const company = this.update(
      id,
      parsed.revision,
      (record) => {
        const item = intakeItem(record, parsed.itemId);
        const attempt = buildExternalIntakeAttempt(
          record,
          item,
          parsed,
          configuration,
          this.originalForVentureInput(id, item.sourceId),
          { id: randomUUID(), startedAt: new Date().toISOString() },
        );
        if (item.result) {
          if (item.result.content !== null) externalIntakeError("INTAKE_EXTERNAL_PHASE_INVALID");
          item.previousResults.push(item.result);
          item.result = null;
        }
        item.attempts.push(attempt);
        item.phase = "requesting_external";
        item.code = null;
        intakeRequest(item, parsed.action, parsed.clientRequestId, digest);
        intakeTouch(item);
        attemptId = attempt.id;
        started = true;
        return false;
      },
      (record) => Boolean(intakeReplay(record, parsed.clientRequestId, digest)),
    );
    return { response: intakeResponse(company, parsed.itemId), started, attemptId };
  }
  finishSourceIntakeExternalAttempt(
    id: string,
    binding: SourceIntakeAttemptBinding,
    outcome: SourceIntakeExternalOutcome,
  ) {
    const parsed = sourceIntakeExternalOutcomeSchema.parse(outcome);
    const company = this.update(id, binding.revision, (record) => {
      const item = intakeItem(record, binding.itemId),
        attempt = currentExternalIntakeAttempt(item);
      if (
        item.version !== binding.itemVersion ||
        attempt.id !== binding.attemptId ||
        attempt.externalApproval.caseId !== id
      )
        externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
      const now = new Date().toISOString();
      if (parsed.status === "completed") {
        assertExternalIntakeResultBinding(
          record,
          item,
          binding,
          this.originalForVentureInput(id, item.sourceId),
        );
        const text = parsed.content.text;
        if (
          intakeRetainedCharacters(record.sourceIntakes) + text.length >
          sourceIntakeLimits.retainedText
        ) {
          item.attempts[item.attempts.length - 1] = unknownExternalIntakeAttempt(item, now);
          item.phase = "external_result_unknown";
          item.code = "INTAKE_EXTERNAL_RESULT_UNKNOWN";
        } else {
          const resultId = randomUUID();
          item.result = {
            id: resultId,
            attemptId: attempt.id,
            engine: attempt.engine,
            generatedAt: now,
            originalSha256: attempt.originalSha256,
            sourceUpdatedAt: attempt.sourceUpdatedAt,
            textSha256: intakeSha(text),
            content: parsed.content,
            warnings: parsed.warnings,
            reviewStatus: "unreviewed",
            discardedAt: null,
          };
          item.attempts[item.attempts.length - 1] = {
            ...attempt,
            status: "completed",
            finishedAt: now,
            resultId,
          };
          item.phase = "awaiting_review";
          item.code = null;
        }
      } else {
        // Unknown completion must remain recordable even if the original became unreadable.
        item.attempts[item.attempts.length - 1] = unknownExternalIntakeAttempt(item, now);
        item.phase = "external_result_unknown";
        item.code = "INTAKE_EXTERNAL_RESULT_UNKNOWN";
      }
      intakeTouch(item);
      return false;
    });
    return intakeResponse(company, binding.itemId);
  }
  /** Restart recovery records uncertainty only. Never creates an attempt or invokes a provider. */
  resumeSourceIntakeExternal(id: string, input: ResumeSourceIntakeCommand) {
    const parsed = resumeSourceIntakeSchema.parse(input),
      digest = intakeDigest(parsed);
    const company = this.update(
      id,
      parsed.revision,
      (record) => {
        const item = intakeItem(record, parsed.itemId);
        if (item.version !== parsed.expectedItemVersion) intakeError("INTAKE_STALE");
        const attempt = currentExternalIntakeAttempt(item);
        if (attempt.externalApproval.caseId !== id)
          externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
        item.attempts[item.attempts.length - 1] = unknownExternalIntakeAttempt(
          item,
          new Date().toISOString(),
        );
        item.phase = "external_result_unknown";
        item.code = "INTAKE_EXTERNAL_RESULT_UNKNOWN";
        intakeRequest(item, parsed.action, parsed.clientRequestId, digest);
        intakeTouch(item);
        return false;
      },
      (record) => Boolean(intakeReplay(record, parsed.clientRequestId, digest)),
    );
    return intakeResponse(company, parsed.itemId);
  }
  adoptSourceIntakeResult(id: string, input: AdoptSourceIntakeCommand) {
    const parsed = adoptSourceIntakeSchema.parse(input),
      digest = intakeDigest(parsed);
    const company = this.update(
      id,
      parsed.revision,
      (record) => {
        const item = intakeItem(record, parsed.itemId),
          result = item.result;
        if (
          item.phase !== "awaiting_review" ||
          !result?.content ||
          result.id !== parsed.resultId ||
          item.adoption
        )
          intakeError("INTAKE_PHASE_INVALID");
        if (
          item.version !== parsed.expectedItemVersion ||
          item.original?.sha256 !== parsed.originalSha256 ||
          item.original?.sourceUpdatedAt !== parsed.sourceUpdatedAt ||
          result.originalSha256 !== parsed.originalSha256 ||
          result.sourceUpdatedAt !== parsed.sourceUpdatedAt ||
          result.textSha256 !== intakeSha(sourceIntakeResultText(result.content))
        )
          intakeError("INTAKE_STALE");
        assertIntakeOriginal(item, this.originalForVentureInput(id, item.sourceId));
        const source = record.sources.find((entry) => entry.id === item.sourceId);
        if (!source || source.extraction !== "pending" || source.text)
          intakeError("INTAKE_SOURCE_NOT_PENDING");
        const sourceUpdatedAt = nextSourceTimestamp(source.updatedAt),
          adoptedAt = new Date().toISOString();
        source.text = parsed.text;
        source.extraction = "manual";
        source.updatedAt = sourceUpdatedAt;
        source.warnings = [
          ...source.warnings.filter(
            (warning) => !(originalOnlyWarnings as readonly string[]).includes(warning),
          ),
          localOcrReviewedWarning,
        ];
        item.adoption = {
          id: randomUUID(),
          clientRequestId: parsed.clientRequestId,
          inputDigest: digest,
          resultId: result.id,
          resultTextSha256: result.textSha256,
          adoptedTextSha256: intakeSha(parsed.text),
          sourceUpdatedAt,
          adoptedAt,
        };
        item.phase = "adopted";
        intakeRequest(item, "adopt", parsed.clientRequestId, digest);
        intakeTouch(item);
        invalidateEvidence(record);
        return true;
      },
      (record) => Boolean(intakeReplay(record, parsed.clientRequestId, digest)),
    );
    return intakeResponse(company, parsed.itemId);
  }
  discardSourceIntakeResult(id: string, input: DiscardSourceIntakeCommand) {
    const parsed = discardSourceIntakeSchema.parse(input),
      digest = intakeDigest(parsed);
    const company = this.update(
      id,
      parsed.revision,
      (record) => {
        const item = intakeItem(record, parsed.itemId);
        if (item.version !== parsed.expectedItemVersion) intakeError("INTAKE_STALE");
        if (
          !item.result?.content ||
          item.result.id !== parsed.resultId ||
          !["awaiting_review", "adopted"].includes(item.phase)
        )
          intakeError("INTAKE_PHASE_INVALID");
        item.result.content = null;
        item.result.discardedAt = new Date().toISOString();
        if (item.phase !== "adopted") item.phase = "result_discarded";
        intakeRequest(item, "discard-result", parsed.clientRequestId, digest);
        intakeTouch(item);
        return false;
      },
      (record) => Boolean(intakeReplay(record, parsed.clientRequestId, digest)),
    );
    return intakeResponse(company, parsed.itemId);
  }
  cancelSourceIntakeItem(id: string, input: CancelSourceIntakeCommand) {
    const parsed = cancelSourceIntakeSchema.parse(input),
      digest = intakeDigest(parsed);
    const company = this.update(
      id,
      parsed.revision,
      (record) => {
        const item = intakeItem(record, parsed.itemId);
        if (item.version !== parsed.expectedItemVersion) intakeError("INTAKE_STALE");
        if (
          item.phase !== "awaiting_original" ||
          item.original ||
          item.attempts.length ||
          item.result ||
          item.adoption ||
          record.sources.some((source) => source.id === item.sourceId)
        )
          intakeError("INTAKE_PHASE_INVALID");
        inspectOriginalPath(this.root, this.root, true);
        for (const directory of [
          resolve(this.root, "originals"),
          resolve(this.filePath(id, item.sourceId), ".."),
        ]) {
          try {
            lstatSync(directory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
            throw originalReadError("UNSAFE_ORIGINAL_PATH");
          }
          inspectOriginalPath(this.root, directory, true);
        }
        try {
          lstatSync(this.filePath(id, item.sourceId));
          intakeError("INTAKE_RECOVERY_REQUIRED");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        item.phase = "cancelled";
        intakeRequest(item, "cancel-awaiting-original", parsed.clientRequestId, digest);
        intakeTouch(item);
        return false;
      },
      (record) => Boolean(intakeReplay(record, parsed.clientRequestId, digest)),
    );
    return intakeResponse(company, parsed.itemId);
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
  /** Approved attachment reads use only stored source IDs. No filesystem paths leave this method. */
  originalForVentureInput(
    id: string,
    sourceId: string,
  ): { source: SourceDocument; buffer: Buffer; sha256: string } {
    const company = this.get(id);
    const source = company.sources.find((item) => item.id === sourceId);
    if (!source?.originalName) throw originalReadError("SOURCE_NOT_FOUND", 404);
    const original = this.readSafeOriginal(id, source, () => {
      const latest = this.get(id);
      if (
        latest.revision !== company.revision ||
        JSON.stringify(latest.sources.find((item) => item.id === sourceId)) !==
          JSON.stringify(source)
      )
        throw originalReadError("ORIGINAL_METADATA_CHANGED");
    });
    // Intake hashes bind original bytes across every consumer, including download,
    // ZIP export and official-form attachments. Reviewed text may have a newer timestamp.
    for (const item of company.sourceIntakes) {
      if (item.sourceId !== sourceId || !item.original) continue;
      const saved = item.original;
      if (
        saved.sha256 !== original.sha256 ||
        saved.sizeBytes !== original.buffer.length ||
        saved.originalName !== source.originalName ||
        saved.mimeType !== source.mimeType
      )
        intakeError("INTAKE_ORIGINAL_CHANGED");
    }
    for (const receipt of company.sourceSuggestionAdoptions) {
      const saved = receipt.binding.original;
      if (
        saved?.sourceId === sourceId &&
        (saved.sha256 !== original.sha256 ||
          saved.sizeBytes !== original.buffer.length ||
          saved.originalName !== source.originalName ||
          saved.mimeType !== source.mimeType)
      )
        sourceSuggestionError("SUGGESTION_ORIGINAL_CHANGED");
    }
    for (const snapshot of company.applicationProcedures.flatMap(
      (entry) => entry.sourceSnapshots,
    )) {
      const saved = snapshot.original;
      if (
        saved?.sourceId === sourceId &&
        (saved.sha256 !== original.sha256 ||
          saved.sizeBytes !== original.buffer.length ||
          saved.originalName !== source.originalName ||
          saved.mimeType !== source.mimeType)
      )
        throw new StudioError(
          "신청 절차에 보관한 원본과 현재 파일이 다릅니다. 기존 근거를 보존해 주세요.",
          409,
          "PROCEDURE_ORIGINAL_CHANGED",
        );
    }
    return original;
  }
  private readSafeOriginal(
    id: string,
    source: SourceDocument,
    assertCurrent: () => void,
  ): { source: SourceDocument; buffer: Buffer; sha256: string } {
    let descriptor: number | undefined;
    try {
      assertCurrent();
      validateVentureOriginalMetadata(source);
      const file = this.filePath(id, source.id);
      const pathBefore = inspectOriginalPath(this.root, file);
      const leaf = pathBefore.at(-1)!;
      if (leaf.nlink !== BigInt(1)) throw originalReadError("UNSAFE_ORIGINAL_PATH");
      if (leaf.size > BigInt(MAX_VENTURE_ORIGINAL_BYTES))
        throw originalReadError("ORIGINAL_TOO_LARGE", 413);
      descriptor = openSync(
        file,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      const before = fstatSync(descriptor, { bigint: true });
      if (!sameOriginalStat(leaf, before)) throw originalReadError("ORIGINAL_CHANGED");
      const buffer = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
        if (!count) throw originalReadError("ORIGINAL_CHANGED");
        offset += count;
      }
      if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0)
        throw originalReadError("ORIGINAL_CHANGED");
      const after = fstatSync(descriptor, { bigint: true });
      const pathAfter = inspectOriginalPath(this.root, file);
      const finalStat = fstatSync(descriptor, { bigint: true });
      if (
        !sameOriginalStat(before, after) ||
        !sameOriginalStat(before, finalStat) ||
        !sameOriginalStat(before, pathAfter.at(-1)!) ||
        pathBefore.length !== pathAfter.length ||
        pathBefore.some((stat, index) => !sameOriginalIdentity(stat, pathAfter[index]))
      )
        throw originalReadError("ORIGINAL_CHANGED");
      assertCurrent();
      return { source, buffer, sha256: createHash("sha256").update(buffer).digest("hex") };
    } catch (error) {
      if (error instanceof StudioError) throw error;
      throw originalReadError("ORIGINAL_UNAVAILABLE");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  originalMetadata(id: string, sourceId: string) {
    const source = this.get(id).sources.find((item) => item.id === sourceId);
    if (!source?.originalName)
      throw new StudioError("원본 파일을 찾을 수 없습니다.", 404, "SOURCE_NOT_FOUND");
    let sizeBytes = 0;
    let exists = false;
    try {
      const stat = lstatSync(this.filePath(id, sourceId));
      exists = stat.isFile();
      sizeBytes = exists ? stat.size : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      sourceId,
      originalName: source.originalName,
      mimeType: source.mimeType,
      sizeBytes,
      exists,
    };
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
    assertVentureCompanyWritable(id);
    const record = this.get(id);
    if (record.sourceIntakes.some((item) => item.phase === "storing_original"))
      intakeError("INTAKE_RECOVERY_REQUIRED");
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
