import {
  ProviderLedgerStore,
  type ProviderBudgetConfigure,
} from "./studio-plan-quality-provider-store";
import type {
  ProviderEnvironment,
  ProviderStart,
  ProviderCancel,
} from "./studio-plan-quality-provider-types";
import { randomUUID } from "node:crypto";
import {
  createProviderProductionDispatchStore,
  requireProviderProductionRuntime,
  type ProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import {
  snapshotProviderSdkTestNetwork,
  type ProviderSdkTestNetwork,
} from "./studio-plan-quality-provider-sdk-dispatch";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { nativePaths, safePath } from "../../scripts/local-data-files.mjs";
import {
  inspectQualityDatabase,
  migrateQualitySchemaV9,
} from "../../scripts/local-data-quality.mjs";
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { ProviderPolicyAdoptionStore } from "./studio-plan-quality-provider-policy-adoption-store";
import { ProviderReservationReviewStore } from "./studio-plan-quality-provider-reservation-review-store";
import { ProviderReservationStore } from "./studio-plan-quality-provider-reservation-store";
import { ProviderTransmissionApprovalStore } from "./studio-plan-quality-provider-transmission-approval-store";
import {
  ProviderGenerationDispatchStore,
  type ProviderDispatchContext,
  type ProviderGenerationMockTransport,
  type ProviderReviewMockTransport,
} from "./studio-plan-quality-provider-dispatch-store";
import { ProviderTransmissionReviewStore } from "./studio-plan-quality-provider-transmission-review-store";
import type { ProviderExecutionCommand } from "./studio-plan-quality-provider-execution-types";
import {
  ActualLedgerStore,
  type ActualBudgetConfigure,
  type ActualPreparedInput,
  type ActualDispatchInput,
  type ActualResponseInput,
  type ActualValidatedInput,
  type ActualFinishInput,
} from "./studio-plan-quality-actual-store";
import type { ActualLedgerStart } from "./studio-plan-quality-actual-ledger-types";
import { StudioError } from "./studio-http";
import type { EngineExecutionContract } from "./studio-engine-execution-types";
import {
  createQualityExecutionPreparation,
  validateQualityExecutionLedger,
  qualityExecutionCreateRun,
  qualityExecutionCreateEvent,
  qualityExecutionIsUnsettled,
} from "./studio-plan-quality-execution";
import {
  qualityExecutionLimits,
  qualityExecutionRunSchema,
  qualityExecutionEventSchema,
  qualityExecutionReceiptSchema,
  qualityExecutionStartSchema,
  qualityExecutionEventPayloadSchema,
  qualityExecutionRequestDigestInput,
  type QualityExecutionStart,
  type QualityExecutionEventPayload,
  type QualityExecutionReceipt,
  type QualityExecutionSnapshot,
} from "./studio-plan-quality-execution-types";
import { createPlanQualityFixtures } from "./studio-plan-quality-fixtures";
import {
  createCandidateRegistrySource,
  candidateRegistrySummary,
  candidateRegistryVersionDigest,
  validateCandidateRegistrySnapshot,
} from "./studio-plan-quality-candidate-registry";
import {
  candidateRegistryLimits,
  candidateRegistryNotice,
  candidateRegistrySetId,
  candidateRegistryRegisterSchema,
  candidateRegistryReceiptSchema,
  candidateRegistrySnapshotSchema,
  candidateRegistryRequestDigestInput,
  type CandidateRegistryRegisterRequest,
  type CandidateRegistryReceipt,
  type CandidateRegistrySnapshot,
} from "./studio-plan-quality-candidate-registry-types";
import {
  createPlanQualityEvaluationManifest,
  planQualityEvaluationDigest as digest,
  planQualityEvaluationSchema,
  summarizePlanQualityEvaluations,
  validatePlanQualityEvaluation,
} from "./studio-plan-quality-evaluation";
import {
  createPlanQualityRecordTemplate,
  planQualityCreateRunSchema,
  planQualitySaveRecordSchema,
  planQualityFixtureSchema,
  planQualityManifestSchema,
  planQualityReceiptSchema,
  planQualityRequestDigestInput,
  planQualityRunSnapshotSchema,
  planQualityStoreLimits as limits,
  type PlanQualityCreateRunRequest,
  type PlanQualitySaveRecordRequest,
  type PlanQualityRunSnapshot,
  type PlanQualityReceipt,
} from "./studio-plan-quality-store-types";

const uuid = z.string().uuid();
const storedRunSchema = z
  .object({
    id: uuid,
    title: z.string().min(1).max(120),
    createdAt: z.string().datetime(),
    clientRequestId: uuid,
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    manifest: planQualityManifestSchema,
    fixtures: z.array(planQualityFixtureSchema).length(50),
  })
  .strict();
type StoredRun = z.infer<typeof storedRunSchema>;
const storedRevisionSchema = z
  .object({
    runId: uuid,
    revision: z.number().int().min(1).max(limits.revisions),
    fixtureRevision: z.number().int().min(1).max(limits.revisions),
    clientRequestId: uuid,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    recordDigest: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: z.string().datetime(),
    record: planQualityEvaluationSchema,
  })
  .strict();
function fail(code: string, message: string, status = 409): never {
  throw new StudioError(message, status, code);
}
const corrupt = (): never =>
  fail("QUALITY_STORAGE_CORRUPT", "평가 저장소의 무결성을 확인하지 못했습니다.");
function ensureDirectory(path: string) {
  if (!existsSync(path)) {
    ensureDirectory(dirname(path));
    safePath(dirname(path), "directory");
    mkdirSync(path, { mode: 0o700 });
  }
  return safePath(path, "directory");
}
function decode<T>(row: { body: unknown; body_hash: unknown }, schema: z.ZodType<T>): T {
  try {
    if (typeof row.body !== "string" || typeof row.body_hash !== "string") return corrupt();
    const parsed = JSON.parse(row.body);
    if (digest(parsed) !== row.body_hash) return corrupt();
    return schema.parse(parsed);
  } catch {
    return corrupt();
  }
}

/** Separate local database. Never opens studio.sqlite or company originals. */
export class PlanQualityStore {
  private db: DatabaseSync;
  private root: string;
  private file: string;
  private identity: { dev: bigint; ino: bigint };
  private rootIdentity: { dev: bigint; ino: bigint };
  private currentManifest = createPlanQualityEvaluationManifest();
  private currentDigest = digest(this.currentManifest);
  private actual: ActualLedgerStore;
  private provider: ProviderLedgerStore;
  private providerPolicy: ProviderPolicyAdoptionStore;
  private providerReservation: ProviderReservationReviewStore;
  private providerReservationCommands: ProviderReservationStore;
  private providerTransmission: ProviderTransmissionReviewStore;
  private providerTransmissionCommands: ProviderTransmissionApprovalStore;
  private providerGenerationDispatch: ProviderGenerationDispatchStore;

  constructor(
    directory = process.env.VENTURE_DATA_DIR || resolve(process.cwd(), ".venture-pass"),
    options: {
      actualEnvironment?: "synthetic-test";
      providerEnvironment?: "synthetic-test";
      /** Explicit test-only network; never populated by application routes or environment. */
      providerSdkTestNetwork?: ProviderSdkTestNetwork;
      /** Explicit server runtime; only the dedicated approval-scoped runner may write/send. */
      providerProductionRuntime?: ProviderProductionRuntime;
      /** Server construction only. Pins policy/reservation selection; v2 native writes remain blocked. */
      providerPolicySelection?: { version: PlanPromptVersion; configuration: unknown };
    } = {},
  ) {
    // Validate/snapshot the explicit selection before opening or creating any database.
    const policySelection =
      options.providerPolicySelection === undefined
        ? undefined
        : createServerProviderPolicyContext(
            options.providerPolicySelection.version,
            options.providerPolicySelection.configuration,
          );
    const suppliedRuntime = options.providerProductionRuntime;
    if (
      suppliedRuntime !== undefined &&
      (options.actualEnvironment !== undefined ||
        options.providerEnvironment !== undefined ||
        options.providerSdkTestNetwork !== undefined)
    )
      throw new Error("PROVIDER_PRODUCTION_RUNTIME_TEST_MIXED");
    const productionRuntime =
      suppliedRuntime === undefined ? undefined : requireProviderProductionRuntime(suppliedRuntime);
    if (options.providerSdkTestNetwork && options.providerEnvironment !== "synthetic-test")
      throw new Error("PROVIDER_SDK_TEST_NETWORK_DISABLED");
    const sdkTestNetwork =
      options.providerSdkTestNetwork === undefined
        ? undefined
        : snapshotProviderSdkTestNetwork(options.providerSdkTestNetwork);
    this.root = join(resolve(directory), "quality-evaluation");
    this.file = join(this.root, "quality.sqlite");
    try {
      if (existsSync(join(this.root, ".restore-pending"))) throw new Error("restore pending");
      let existingParent = this.root;
      while (!existsSync(existingParent)) existingParent = dirname(existingParent);
      safePath(existingParent, "directory");
      // Reject native Windows reparse ancestors before creating even a child directory.
      nativePaths([existingParent]);
      this.rootIdentity = ensureDirectory(this.root);
      const paths: string[] = [];
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        if (existsSync(this.file + suffix)) {
          const stat = safePath(this.file + suffix);
          if (stat.size > BigInt(limits.totalBytes + limits.pinnedBytes))
            throw new Error("oversize");
          paths.push(this.file + suffix);
        }
      }
      if (paths.length) nativePaths(paths);
      if (existsSync(join(this.root, ".restore-pending"))) throw new Error("restore pending");
      this.db = new DatabaseSync(this.file);
      this.identity = safePath(this.file);
    } catch {
      fail("QUALITY_STORAGE_UNSAFE", "안전한 로컬 평가 저장소를 열 수 없습니다.");
    }
    this.checkPaths();
    this.actual = new ActualLedgerStore({
      db: this.db,
      transaction: (work, write) => this.transaction(work, write),
      registry: (version) => {
        const found = this.candidateSnapshots().find((value) => value.version === version);
        if (!found)
          fail("QUALITY_ACTUAL_CANDIDATE_NOT_FOUND", "정확한 등록 후보를 찾을 수 없습니다.", 404);
        return found;
      },
      capacity: (bytes) => this.budget(bytes),
      synthetic: options.actualEnvironment === "synthetic-test",
    });
    this.provider = new ProviderLedgerStore({
      db: this.db,
      transaction: (work, write) => this.transaction(work, write),
      registry: (version) => {
        const found = this.candidateSnapshots().find((value) => value.version === version);
        if (!found)
          fail("QUALITY_PROVIDER_CANDIDATE_NOT_FOUND", "정확한 등록 후보를 찾을 수 없습니다.", 404);
        return found;
      },
      capacity: (bytes) => this.budget(bytes),
      synthetic: options.providerEnvironment === "synthetic-test",
    });
    this.providerPolicy = new ProviderPolicyAdoptionStore({
      selection: policySelection,
      db: this.db,
      transaction: (work, write) => this.transaction(work, write),
      registry: (version) => {
        const found = this.candidateSnapshots().find((value) => value.version === version);
        if (!found)
          fail("QUALITY_PROVIDER_CANDIDATE_NOT_FOUND", "정확한 등록 후보를 찾을 수 없습니다.", 404);
        return found;
      },
      capacity: (bytes) => this.budget(bytes),
    });
    this.providerReservation = new ProviderReservationReviewStore({
      selection: policySelection,
      db: this.db,
      transaction: (work) => this.transaction(work),
      registry: (version) => {
        const found = this.candidateSnapshots().find((value) => value.version === version);
        if (!found)
          fail("QUALITY_PROVIDER_CANDIDATE_NOT_FOUND", "정확한 등록 후보를 찾을 수 없습니다.", 404);
        return found;
      },
    });
    this.providerReservationCommands = new ProviderReservationStore({
      selection: policySelection,
      db: this.db,
      transaction: (work, write) => this.transaction(work, write),
      registry: (version) => {
        const found = this.candidateSnapshots().find((value) => value.version === version);
        if (!found)
          fail("QUALITY_PROVIDER_CANDIDATE_NOT_FOUND", "정확한 등록 후보를 찾을 수 없습니다.", 404);
        return found;
      },
      capacity: (bytes) => this.budget(bytes),
    });
    this.providerTransmission = new ProviderTransmissionReviewStore({
      db: this.db,
      transaction: (work) => this.transaction(work),
      registry: (version) => {
        const found = this.candidateSnapshots().find((value) => value.version === version);
        if (!found)
          fail("QUALITY_PROVIDER_CANDIDATE_NOT_FOUND", "정확한 등록 후보를 찾을 수 없습니다.", 404);
        return found;
      },
    });
    this.providerTransmissionCommands = new ProviderTransmissionApprovalStore({
      db: this.db,
      transaction: (work, write) => this.transaction(work, write),
      registry: (version) => {
        const found = this.candidateSnapshots().find((value) => value.version === version);
        if (!found)
          fail("QUALITY_PROVIDER_CANDIDATE_NOT_FOUND", "정확한 등록 후보를 찾을 수 없습니다.", 404);
        return found;
      },
      capacity: (bytes) => this.budget(bytes),
    });
    const dispatchContext: ProviderDispatchContext = {
      db: this.db,
      transaction: (work, write) => this.transaction(work, write),
      registry: (version) => {
        const found = this.candidateSnapshots().find((value) => value.version === version);
        if (!found)
          fail("QUALITY_PROVIDER_CANDIDATE_NOT_FOUND", "정확한 등록 후보를 찾을 수 없습니다.", 404);
        return found;
      },
      capacity: (bytes) => this.budget(bytes),
      get: (id, revision) => this.provider.get(id, revision),
      artifact: (id, key) => this.provider.artifact(id, key),
    };
    this.providerGenerationDispatch = productionRuntime
      ? createProviderProductionDispatchStore(dispatchContext, productionRuntime)
      : new ProviderGenerationDispatchStore({
          ...dispatchContext,
          synthetic: options.providerEnvironment === "synthetic-test",
          sdkTestNetwork,
        });
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
      PRAGMA journal_mode=DELETE; PRAGMA max_page_count=70000;`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      migrateQualitySchemaV9(this.db);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
    this.checkPaths();
  }
  close() {
    this.db.close();
  }
  /** Complete audited metadata only; no writer, transport, or customer store is exposed. */
  inspectDatabase() {
    return this.transaction(() => inspectQualityDatabase(this.db, { inTransaction: true }));
  }
  private checkPaths() {
    try {
      if (existsSync(join(this.root, ".restore-pending"))) throw new Error("restore pending");
      const root = safePath(this.root, "directory"),
        file = safePath(this.file);
      if (
        root.dev !== this.rootIdentity.dev ||
        root.ino !== this.rootIdentity.ino ||
        file.dev !== this.identity.dev ||
        file.ino !== this.identity.ino
      )
        throw new Error("replaced");
      for (const suffix of ["-wal", "-shm", "-journal"])
        if (existsSync(this.file + suffix)) safePath(this.file + suffix);
    } catch {
      fail("QUALITY_STORAGE_UNSAFE", "평가 저장소 경로가 변경되어 작업을 중단했습니다.");
    }
  }
  private transaction<T>(work: () => T, write = false): T {
    this.checkPaths();
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const counts = this.db
        .prepare(
          `SELECT
        (SELECT COUNT(*) FROM quality_runs) AS runs,
        (SELECT COUNT(*) FROM quality_revisions) AS revisions,
        (SELECT COUNT(*) FROM quality_requests) AS requests,
        (SELECT COUNT(*) FROM quality_candidate_versions) AS candidateVersions,
        (SELECT COUNT(*) FROM quality_candidate_requests) AS candidateRequests,
        (SELECT COUNT(*) FROM quality_execution_runs) AS executionRuns,
        (SELECT COUNT(*) FROM quality_execution_events) AS executionEvents,
        (SELECT COUNT(*) FROM quality_execution_requests) AS executionRequests,
        (SELECT COUNT(*) FROM quality_provider_policies) AS providerPolicies`,
        )
        .get()!;
      if (
        Number(counts.providerPolicies) > 100 ||
        Number(counts.requests) !== Number(counts.runs) + Number(counts.revisions) ||
        Number(counts.runs) > limits.runs ||
        Number(counts.revisions) > limits.runs * limits.revisions ||
        Number(counts.candidateVersions) !== Number(counts.candidateRequests) ||
        Number(counts.candidateVersions) > candidateRegistryLimits.versions ||
        Number(counts.executionRuns) !== Number(counts.executionRequests) ||
        Number(counts.executionRuns) > qualityExecutionLimits.runs ||
        Number(counts.executionEvents) >
          Number(counts.executionRuns) * qualityExecutionLimits.events
      )
        return corrupt();
      const nonceConflict = this.db.prepare(
        `SELECT nonce FROM (
        SELECT nonce FROM quality_requests UNION ALL SELECT nonce FROM quality_candidate_requests
        UNION ALL SELECT nonce FROM quality_execution_requests UNION ALL SELECT nonce FROM quality_actual_requests
        UNION ALL SELECT nonce FROM quality_provider_policies
      ) GROUP BY nonce HAVING COUNT(*) > 1 LIMIT 1`,
      );
      if (nonceConflict.get()) return corrupt();
      // Missing coverage/bindings must block legacy reads and replays, even with no policy rows.
      this.budget(0);
      const result = work();
      if (write && nonceConflict.get()) return corrupt();
      if (write) this.budget(0);
      this.checkPaths();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private budget(bytes: number) {
    const row = this.db
      .prepare(
        `SELECT
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_runs) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_revisions) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_requests) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_candidate_versions) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_candidate_requests) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_execution_runs) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_execution_events) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_execution_requests) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_actual_budget_events) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_actual_runs) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_actual_events) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_actual_requests) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_provider_policies) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_provider_reservation_bindings) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_provider_reservation_coverage) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_provider_transmission_bindings) +
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM quality_provider_transmission_coverage) +
      (SELECT COALESCE(SUM(length(payload)),0) FROM quality_actual_artifacts) AS total`,
      )
      .get()!;
    if (Number(row.total) + bytes + this.actual.reservedStorageBytes() > limits.totalBytes)
      fail("QUALITY_STORAGE_LIMIT", "평가 기록 보관 용량 한도에 도달했습니다.");
  }
  private rawRun(id: string): StoredRun {
    const row = this.db.prepare("SELECT body,body_hash FROM quality_runs WHERE id=?").get(id);
    if (!row) fail("QUALITY_RUN_NOT_FOUND", "평가 묶음을 찾을 수 없습니다.", 404);
    const run = decode(row as { body: unknown; body_hash: unknown }, storedRunSchema);
    if (
      run.id !== id ||
      digest(run.manifest) !== run.manifestDigest ||
      new Set(run.manifest.map((v) => v.fixtureId)).size !== 50 ||
      new Set(run.fixtures.map((v) => v.id)).size !== 50
    )
      return corrupt();
    for (const entry of run.manifest) {
      const fixture = run.fixtures.find((v) => v.id === entry.fixtureId);
      if (
        !fixture ||
        fixture.label !== entry.label ||
        digest({ profile: fixture.profile, sources: fixture.sources }) !== entry.sourceDigest ||
        digest(fixture.candidate) !== entry.candidateDigest ||
        digest(fixture.plan) !== entry.inputPlanDigest ||
        digest({
          deterministic: fixture.deterministicExpectation,
          semantic: fixture.semanticRubric,
        }) !== entry.rubricDigest
      )
        return corrupt();
    }
    return run;
  }
  private receipt(nonce: string): PlanQualityReceipt | null {
    const row = this.db
      .prepare("SELECT body,body_hash FROM quality_requests WHERE nonce=?")
      .get(nonce);
    if (!row) return null;
    const value = decode(row as { body: unknown; body_hash: unknown }, planQualityReceiptSchema);
    if (value.clientRequestId !== nonce) return corrupt();
    return value;
  }
  private insertReceipt(receipt: PlanQualityReceipt) {
    this.db
      .prepare("INSERT INTO quality_requests(nonce,body,body_hash) VALUES(?,?,?)")
      .run(receipt.clientRequestId, JSON.stringify(receipt), digest(receipt));
  }
  private snapshot(id: string, revision?: number): PlanQualityRunSnapshot {
    const run = this.rawRun(id);
    const rows = this.db
      .prepare(
        "SELECT revision,body,body_hash FROM quality_revisions WHERE run_id=? ORDER BY revision",
      )
      .all(id);
    if (rows.length > limits.revisions) return corrupt();
    const target = revision ?? rows.length;
    if (!Number.isInteger(target) || target < 0 || target > rows.length)
      fail("QUALITY_REVISION_NOT_FOUND", "평가 기록 버전을 찾을 수 없습니다.", 404);
    const records = run.manifest.map(createPlanQualityRecordTemplate);
    const createReceipt = this.receipt(run.clientRequestId);
    const createInput = {
      clientRequestId: run.clientRequestId,
      title: run.title,
      manifestDigest: run.manifestDigest,
    };
    if (
      !createReceipt ||
      createReceipt.kind !== "create" ||
      createReceipt.runId !== id ||
      createReceipt.revision !== 0 ||
      createReceipt.inputDigest !== digest(planQualityRequestDigestInput("create", createInput))
    )
      return corrupt();
    const history: PlanQualityRunSnapshot["history"] = [
      {
        ...createReceipt,
        fixtureId: null,
        fixtureRevision: 0,
        recordDigest: null,
        recordedAt: run.createdAt,
      },
    ];
    const fixtureVersions = new Map<string, number>();
    // Revision numbers establish ordering; a user's PC wall clock may move backwards.
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index],
        item = decode(row as { body: unknown; body_hash: unknown }, storedRevisionSchema);
      if (
        item.runId !== id ||
        item.revision !== index + 1 ||
        row.revision !== item.revision ||
        item.recordDigest !== digest(item.record) ||
        item.fixtureRevision !== (fixtureVersions.get(item.record.fixtureId) ?? 0) + 1
      )
        return corrupt();
      fixtureVersions.set(item.record.fixtureId, item.fixtureRevision);
      const entry = run.manifest.find((v) => v.fixtureId === item.record.fixtureId);
      if (
        !entry ||
        ["sourceDigest", "candidateDigest", "inputPlanDigest", "rubricDigest"].some(
          (key) => item.record[key as "sourceDigest"] !== entry[key as "sourceDigest"],
        )
      )
        return corrupt();
      const receipt = this.receipt(item.clientRequestId);
      const expectedDigest = digest(
        planQualityRequestDigestInput(
          "record",
          { revision: index, clientRequestId: item.clientRequestId, record: item.record },
          id,
        ),
      );
      if (
        !receipt ||
        receipt.kind !== "record" ||
        receipt.runId !== id ||
        receipt.revision !== item.revision ||
        receipt.inputDigest !== item.inputDigest ||
        item.inputDigest !== expectedDigest
      )
        return corrupt();
      // A future validator may reject previously accepted records. Immutable hashes and
      // pinned bindings govern archival reads; current validation governs new writes.
      if (item.revision <= target) {
        records[records.findIndex((v) => v.fixtureId === item.record.fixtureId)] = item.record;
        history.push({
          ...receipt,
          fixtureId: item.record.fixtureId,
          fixtureRevision: item.fixtureRevision,
          recordDigest: item.recordDigest,
          recordedAt: item.recordedAt,
        });
      }
    }
    const manifestCurrent = run.manifestDigest === this.currentDigest;
    return planQualityRunSnapshotSchema.parse({
      id,
      title: run.title,
      revision: target,
      currentRevision: rows.length,
      clientRequestId: run.clientRequestId,
      manifestDigest: run.manifestDigest,
      manifestCurrent,
      createdAt: run.createdAt,
      updatedAt: history.at(-1)!.recordedAt,
      recordSource: "user-supplied-records",
      manifest: run.manifest,
      records,
      history,
      summary: manifestCurrent ? summarizePlanQualityEvaluations(records) : null,
    });
  }
  list() {
    return this.transaction(() => ({
      manifestDigest: this.currentDigest,
      manifest: this.currentManifest,
      runs: this.db
        .prepare("SELECT id FROM quality_runs ORDER BY rowid DESC")
        .all()
        .map((row) => {
          const {
            id,
            title,
            revision,
            clientRequestId,
            manifestDigest,
            manifestCurrent,
            createdAt,
            updatedAt,
            recordSource,
          } = this.snapshot(String(row.id));
          return {
            id,
            title,
            revision,
            clientRequestId,
            manifestDigest,
            manifestCurrent,
            createdAt,
            updatedAt,
            recordSource,
          };
        }),
    }));
  }
  get(id: string, revision?: number) {
    uuid.parse(id);
    return this.transaction(() => this.snapshot(id, revision));
  }
  fixture(id: string, fixtureId: string) {
    uuid.parse(id);
    return this.transaction(() => {
      const run = this.rawRun(id),
        fixture = run.fixtures.find((item) => item.id === fixtureId),
        entry = run.manifest.find((item) => item.fixtureId === fixtureId);
      if (!fixture || !entry)
        fail("QUALITY_FIXTURE_NOT_FOUND", "고정 합성 사례를 찾을 수 없습니다.", 404);
      return { fixture, template: createPlanQualityRecordTemplate(entry) };
    });
  }
  lookup(nonce: string) {
    uuid.parse(nonce);
    return this.transaction(() => {
      const receipt = this.receipt(nonce);
      if (!receipt) return { state: "not-observed" as const };
      const snapshot = this.snapshot(receipt.runId, receipt.revision);
      if (
        !snapshot.history.some(
          (item) => item.clientRequestId === nonce && item.inputDigest === receipt.inputDigest,
        )
      )
        return corrupt();
      return { state: "committed" as const, receipt };
    });
  }
  create(value: PlanQualityCreateRunRequest) {
    const input = planQualityCreateRunSchema.parse(value),
      inputDigest = digest(planQualityRequestDigestInput("create", input));
    return this.transaction(() => {
      this.assertEvaluationNonce(input.clientRequestId);
      const previous = this.receipt(input.clientRequestId);
      if (previous) {
        if (previous.inputDigest !== inputDigest || previous.kind !== "create")
          fail("QUALITY_NONCE_CONFLICT", "같은 요청 번호에 다른 내용이 기록되어 있습니다.");
        return { run: this.snapshot(previous.runId, previous.revision), replayed: true };
      }
      if (input.manifestDigest !== this.currentDigest)
        fail(
          "QUALITY_MANIFEST_CHANGED",
          "고정 합성 사례 기준이 변경됐습니다. 새 기준을 확인해 주세요.",
        );
      if (
        Number(this.db.prepare("SELECT COUNT(*) AS count FROM quality_runs").get()!.count) >=
        limits.runs
      )
        fail("QUALITY_RUN_LIMIT", "평가 묶음은 최대 20개까지 보관할 수 있습니다.");
      const run = storedRunSchema.parse({
        id: randomUUID(),
        title: input.title,
        createdAt: new Date().toISOString(),
        clientRequestId: input.clientRequestId,
        manifestDigest: this.currentDigest,
        manifest: this.currentManifest,
        fixtures: createPlanQualityFixtures().map((v) => ({
          id: v.id,
          label: v.label,
          synthetic: true,
          profile: v.company.profile,
          sources: v.company.sources,
          candidate: v.candidate,
          plan: v.plan,
          semanticRubric: v.semanticRubric,
          deterministicExpectation: v.deterministicExpectation,
        })),
      });
      const body = JSON.stringify(run),
        bytes = Buffer.byteLength(body);
      if (bytes > limits.pinnedBytes)
        fail("QUALITY_PIN_LIMIT", "고정 합성 사례 보관 용량을 초과했습니다.");
      this.budget(bytes + 1024);
      this.db
        .prepare("INSERT INTO quality_runs(id,body,body_hash) VALUES(?,?,?)")
        .run(run.id, body, digest(run));
      this.insertReceipt({
        kind: "create",
        runId: run.id,
        revision: 0,
        clientRequestId: input.clientRequestId,
        inputDigest,
      });
      return { run: this.snapshot(run.id), replayed: false };
    }, true);
  }
  save(id: string, value: PlanQualitySaveRecordRequest) {
    uuid.parse(id);
    const input = planQualitySaveRecordSchema.parse(value),
      inputDigest = digest(planQualityRequestDigestInput("record", input, id));
    if (Buffer.byteLength(JSON.stringify(input.record)) > limits.recordBytes)
      fail("QUALITY_RECORD_LIMIT", "사례별 평가 기록은 512KiB를 넘을 수 없습니다.", 413);
    return this.transaction(() => {
      this.assertEvaluationNonce(input.clientRequestId);
      const previous = this.receipt(input.clientRequestId);
      if (previous) {
        if (
          previous.inputDigest !== inputDigest ||
          previous.kind !== "record" ||
          previous.runId !== id
        )
          fail("QUALITY_NONCE_CONFLICT", "같은 요청 번호에 다른 내용이 기록되어 있습니다.");
        return { run: this.snapshot(id, previous.revision), replayed: true };
      }
      const current = this.snapshot(id);
      if (!current.manifestCurrent)
        fail(
          "QUALITY_MANIFEST_CHANGED",
          "이 묶음의 합성 사례 기준은 현재 기준과 다릅니다. 과거 기록만 조회할 수 있습니다.",
        );
      if (current.revision !== input.revision)
        fail(
          "QUALITY_REVISION_CONFLICT",
          "다른 평가 기록이 먼저 저장됐습니다. 최신 버전을 확인해 주세요.",
        );
      if (current.revision >= limits.revisions)
        fail("QUALITY_REVISION_LIMIT", "묶음별 200회 기록 보관 한도에 도달했습니다.");
      const validated = validatePlanQualityEvaluation(input.record);
      if (!validated.ok)
        fail("QUALITY_INVALID_RECORD", "고정 사례·출력·평가자의 연결 정보를 확인해 주세요.", 422);
      const item = storedRevisionSchema.parse({
        runId: id,
        revision: current.revision + 1,
        fixtureRevision:
          current.history.filter((v) => v.fixtureId === input.record.fixtureId).length + 1,
        clientRequestId: input.clientRequestId,
        inputDigest,
        recordDigest: digest(validated.record),
        recordedAt: new Date().toISOString(),
        record: validated.record,
      });
      const body = JSON.stringify(item);
      this.budget(Buffer.byteLength(body) + 1024);
      this.db
        .prepare("INSERT INTO quality_revisions(run_id,revision,body,body_hash) VALUES(?,?,?,?)")
        .run(id, item.revision, body, digest(item));
      this.insertReceipt({
        kind: "record",
        runId: id,
        revision: item.revision,
        clientRequestId: input.clientRequestId,
        inputDigest,
      });
      return { run: this.snapshot(id), replayed: false };
    }, true);
  }
  private assertEvaluationNonce(nonce: string) {
    this.assertPolicyNonce(nonce);
    if (this.db.prepare("SELECT nonce FROM quality_actual_requests WHERE nonce=?").get(nonce))
      fail("QUALITY_NONCE_CONFLICT", "같은 요청 번호가 비용 원장에 사용됐습니다.");
    if (this.db.prepare("SELECT nonce FROM quality_candidate_requests WHERE nonce=?").get(nonce))
      fail("QUALITY_NONCE_CONFLICT", "같은 요청 번호가 후보 등록에 사용됐습니다.");
    if (this.db.prepare("SELECT nonce FROM quality_execution_requests WHERE nonce=?").get(nonce))
      fail("QUALITY_NONCE_CONFLICT", "같은 요청 번호가 후보 실행에 사용됐습니다.");
  }
  private assertPolicyNonce(nonce: string) {
    if (this.db.prepare("SELECT nonce FROM quality_provider_policies WHERE nonce=?").get(nonce))
      fail("QUALITY_NONCE_CONFLICT", "같은 요청 번호가 정책 채택 기록에 사용됐습니다.");
  }
  private candidateReceipt(nonce: string): CandidateRegistryReceipt | null {
    const row = this.db
      .prepare("SELECT body,body_hash FROM quality_candidate_requests WHERE nonce=?")
      .get(nonce);
    if (!row) return null;
    const receipt = decode(
      row as { body: unknown; body_hash: unknown },
      candidateRegistryReceiptSchema,
    );
    if (receipt.clientRequestId !== nonce) return corrupt();
    return receipt;
  }
  private candidateSnapshots(): CandidateRegistrySnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT set_id,version,body,body_hash FROM quality_candidate_versions ORDER BY version",
      )
      .all();
    const snapshots: CandidateRegistrySnapshot[] = [];
    const sourceDigests = new Set<string>();
    for (const row of rows) {
      if (
        typeof row.body !== "string" ||
        Buffer.byteLength(row.body) > candidateRegistryLimits.pinnedBytes
      )
        return corrupt();
      let snapshot = decode(
        row as { body: unknown; body_hash: unknown },
        candidateRegistrySnapshotSchema,
      );
      try {
        snapshot = validateCandidateRegistrySnapshot(snapshot);
      } catch {
        return corrupt();
      }
      const previous = snapshots.at(-1);
      if (
        row.set_id !== candidateRegistrySetId ||
        row.version !== snapshots.length + 1 ||
        snapshot.version !== row.version ||
        sourceDigests.has(snapshot.sourceDigest) ||
        snapshot.previousDigest !== (previous?.versionDigest ?? null) ||
        this.db
          .prepare("SELECT nonce FROM quality_requests WHERE nonce=?")
          .get(snapshot.clientRequestId)
      )
        return corrupt();
      const receipt = this.candidateReceipt(snapshot.clientRequestId);
      const input = {
        expectedVersion: snapshot.version - 1,
        clientRequestId: snapshot.clientRequestId,
        sourceDigest: snapshot.sourceDigest,
        acknowledgedCandidateStatus: true as const,
      };
      if (
        !receipt ||
        receipt.version !== snapshot.version ||
        receipt.versionDigest !== snapshot.versionDigest ||
        receipt.inputDigest !== digest(candidateRegistryRequestDigestInput(input))
      )
        return corrupt();
      sourceDigests.add(snapshot.sourceDigest);
      snapshots.push(snapshot);
    }
    return snapshots;
  }
  candidateRegistryList() {
    return this.transaction(() => ({
      source: createCandidateRegistrySource(),
      versions: this.candidateSnapshots().map(candidateRegistrySummary),
    }));
  }
  candidateRegistryGet(version: number) {
    z.number().int().min(1).max(candidateRegistryLimits.versions).parse(version);
    return this.transaction(() => {
      const snapshot = this.candidateSnapshots().find((value) => value.version === version);
      if (!snapshot) fail("QUALITY_CANDIDATE_NOT_FOUND", "후보 등록 버전을 찾을 수 없습니다.", 404);
      return snapshot;
    });
  }
  candidateRegistryLookup(nonce: string) {
    uuid.parse(nonce);
    return this.transaction(() => {
      const snapshots = this.candidateSnapshots();
      const receipt = this.candidateReceipt(nonce);
      if (!receipt) return { state: "not-observed" as const };
      if (
        !snapshots.some(
          (snapshot) => snapshot.clientRequestId === nonce && snapshot.version === receipt.version,
        )
      )
        return corrupt();
      return { state: "committed" as const, receipt };
    });
  }
  candidateRegistryRegister(value: CandidateRegistryRegisterRequest) {
    const input = candidateRegistryRegisterSchema.parse(value);
    const inputDigest = digest(candidateRegistryRequestDigestInput(input));
    return this.transaction(() => {
      const snapshots = this.candidateSnapshots();
      const previous = this.candidateReceipt(input.clientRequestId);
      if (previous) {
        if (previous.inputDigest !== inputDigest)
          fail(
            "QUALITY_CANDIDATE_NONCE_CONFLICT",
            "같은 요청 번호에 다른 후보 등록 내용이 기록되어 있습니다.",
          );
        return { snapshot: snapshots[previous.version - 1], replayed: true };
      }
      if (this.receipt(input.clientRequestId))
        fail("QUALITY_CANDIDATE_NONCE_CONFLICT", "같은 요청 번호가 기존 평가 기록에 사용됐습니다.");
      this.assertPolicyNonce(input.clientRequestId);
      if (
        this.db
          .prepare("SELECT nonce FROM quality_actual_requests WHERE nonce=?")
          .get(input.clientRequestId)
      )
        fail("QUALITY_CANDIDATE_NONCE_CONFLICT", "같은 요청 번호가 비용 원장에 사용됐습니다.");
      if (
        this.db
          .prepare("SELECT nonce FROM quality_execution_requests WHERE nonce=?")
          .get(input.clientRequestId)
      )
        fail("QUALITY_CANDIDATE_NONCE_CONFLICT", "같은 요청 번호가 후보 실행에 사용됐습니다.");
      if (input.expectedVersion !== snapshots.length)
        fail(
          "QUALITY_CANDIDATE_VERSION_CONFLICT",
          "다른 후보 버전이 먼저 등록됐습니다. 최신 기록을 확인해 주세요.",
        );
      const source = createCandidateRegistrySource();
      if (input.sourceDigest !== source.sourceDigest)
        fail(
          "QUALITY_CANDIDATE_SOURCE_CHANGED",
          "준비된 합성 후보 내용이 바뀌었습니다. 새 내용을 확인해 주세요.",
        );
      if (snapshots.some((snapshot) => snapshot.sourceDigest === source.sourceDigest))
        fail(
          "QUALITY_CANDIDATE_ALREADY_REGISTERED",
          "같은 합성 후보 원문이 이미 등록되어 있습니다.",
        );
      if (snapshots.length >= candidateRegistryLimits.versions)
        fail(
          "QUALITY_CANDIDATE_VERSION_LIMIT",
          "후보 등록본은 최대 20개 버전까지 보관할 수 있습니다.",
        );
      const payload: Omit<CandidateRegistrySnapshot, "versionDigest"> = {
        ...source,
        kind: "validation-candidate-set" as const,
        version: snapshots.length + 1,
        previousVersion: snapshots.at(-1)?.version ?? null,
        previousDigest: snapshots.at(-1)?.versionDigest ?? null,
        registeredAt: new Date().toISOString(),
        clientRequestId: input.clientRequestId,
        notice: candidateRegistryNotice,
      };
      const snapshot = validateCandidateRegistrySnapshot({
        ...payload,
        versionDigest: candidateRegistryVersionDigest(payload),
      });
      const receipt = candidateRegistryReceiptSchema.parse({
        kind: "register-candidate-set",
        setId: candidateRegistrySetId,
        version: snapshot.version,
        clientRequestId: input.clientRequestId,
        inputDigest,
        versionDigest: snapshot.versionDigest,
      });
      const body = JSON.stringify(snapshot, null, 2) + "\n",
        receiptBody = JSON.stringify(receipt);
      if (Buffer.byteLength(body) > candidateRegistryLimits.pinnedBytes)
        fail("QUALITY_CANDIDATE_PIN_LIMIT", "후보 원문 보관 용량을 초과했습니다.", 413);
      this.budget(Buffer.byteLength(body) + Buffer.byteLength(receiptBody));
      this.db
        .prepare(
          "INSERT INTO quality_candidate_versions(set_id,version,body,body_hash) VALUES(?,?,?,?)",
        )
        .run(candidateRegistrySetId, snapshot.version, body, digest(snapshot));
      this.db
        .prepare("INSERT INTO quality_candidate_requests(nonce,body,body_hash) VALUES(?,?,?)")
        .run(input.clientRequestId, receiptBody, digest(receipt));
      return { snapshot, replayed: false };
    }, true);
  }
  candidateRegistryDownload(version: number) {
    z.number().int().min(1).max(candidateRegistryLimits.versions).parse(version);
    return this.transaction(() => {
      const snapshot = this.candidateSnapshots().find((value) => value.version === version);
      if (!snapshot) fail("QUALITY_CANDIDATE_NOT_FOUND", "후보 등록 버전을 찾을 수 없습니다.", 404);
      const row = this.db
        .prepare("SELECT body FROM quality_candidate_versions WHERE set_id=? AND version=?")
        .get(candidateRegistrySetId, version)!;
      // Return exactly the stored archive bytes, never today's schema serialization.
      return { snapshot, body: String(row.body) };
    });
  }
  private executionReceipt(nonce: string): QualityExecutionReceipt | null {
    const row = this.db
      .prepare("SELECT body,body_hash FROM quality_execution_requests WHERE nonce=?")
      .get(nonce);
    if (!row) return null;
    if (typeof row.body !== "string" || Buffer.byteLength(row.body) > 4096) return corrupt();
    const receipt = decode(
      row as { body: unknown; body_hash: unknown },
      qualityExecutionReceiptSchema,
    );
    if (receipt.clientRequestId !== nonce) return corrupt();
    return receipt;
  }
  private executionSnapshots(): QualityExecutionSnapshot[] {
    const registry = this.candidateSnapshots();
    const rows = this.db.prepare("SELECT id,body,body_hash FROM quality_execution_runs").all();
    const snapshots: QualityExecutionSnapshot[] = [];
    let totalEvents = 0;
    for (const row of rows) {
      if (
        typeof row.body !== "string" ||
        Buffer.byteLength(row.body) > qualityExecutionLimits.runBytes
      )
        return corrupt();
      const run = decode(row as { body: unknown; body_hash: unknown }, qualityExecutionRunSchema);
      const source = registry.find((item) => item.version === run.preparation.version);
      if (
        run.id !== row.id ||
        !source ||
        this.db
          .prepare("SELECT nonce FROM quality_requests WHERE nonce=?")
          .get(run.clientRequestId) ||
        this.db
          .prepare("SELECT nonce FROM quality_candidate_requests WHERE nonce=?")
          .get(run.clientRequestId)
      )
        return corrupt();
      const receipt = this.executionReceipt(run.clientRequestId);
      if (
        !receipt ||
        receipt.executionId !== run.id ||
        receipt.runDigest !== run.runDigest ||
        receipt.planDigest !== run.preparation.planDigest ||
        receipt.inputDigest !== run.inputDigest
      )
        return corrupt();
      const eventRows = this.db
        .prepare(
          "SELECT revision,body,body_hash FROM quality_execution_events WHERE run_id=? ORDER BY revision",
        )
        .all(run.id);
      if (eventRows.length > qualityExecutionLimits.events) return corrupt();
      const events = eventRows.map((eventRow, index) => {
        if (
          typeof eventRow.body !== "string" ||
          Buffer.byteLength(eventRow.body) > qualityExecutionLimits.eventBytes ||
          eventRow.revision !== index + 1
        )
          return corrupt();
        return decode(
          eventRow as { body: unknown; body_hash: unknown },
          qualityExecutionEventSchema,
        );
      });
      try {
        snapshots.push(validateQualityExecutionLedger(run, events, source));
      } catch {
        return corrupt();
      }
      totalEvents += events.length;
    }
    if (
      Number(
        this.db.prepare("SELECT COUNT(*) AS count FROM quality_execution_events").get()!.count,
      ) !== totalEvents
    )
      return corrupt();
    snapshots.sort(
      (left, right) =>
        left.run.preparation.expectedRunCount - right.run.preparation.expectedRunCount,
    );
    if (
      snapshots.some(
        (item, index) =>
          item.run.preparation.expectedRunCount !== index ||
          snapshots
            .slice(0, index)
            .some(
              (prior) =>
                prior.run.preparation.candidateId === item.run.preparation.candidateId &&
                qualityExecutionIsUnsettled(prior),
            ),
      )
    )
      return corrupt();
    return snapshots;
  }
  executionPrepare(
    input: { version: number; candidateId: string },
    contract: EngineExecutionContract,
  ) {
    const parsed = z
      .object({
        version: z.number().int().min(1).max(20),
        candidateId: z
          .string()
          .regex(/^validation-candidate-[a-z0-9-]+$/)
          .max(120),
      })
      .strict()
      .parse(input);
    return this.transaction(() => {
      const registry = this.candidateSnapshots().find((item) => item.version === parsed.version);
      if (!registry || !registry.entries.some((entry) => entry.candidateId === parsed.candidateId))
        fail("QUALITY_EXECUTION_CANDIDATE_NOT_FOUND", "정확한 등록 후보를 찾을 수 없습니다.", 404);
      return createQualityExecutionPreparation(
        registry,
        parsed.candidateId,
        contract,
        this.executionSnapshots().length,
      );
    });
  }
  executionStart(value: QualityExecutionStart, contract: EngineExecutionContract) {
    const input = qualityExecutionStartSchema.parse(value),
      inputDigest = digest(qualityExecutionRequestDigestInput(input));
    return this.transaction(() => {
      const snapshots = this.executionSnapshots();
      const prior = this.executionReceipt(input.clientRequestId);
      if (prior) {
        if (prior.inputDigest !== inputDigest)
          fail(
            "QUALITY_EXECUTION_NONCE_CONFLICT",
            "같은 요청 번호에 다른 실행 범위가 기록되어 있습니다.",
          );
        const snapshot = snapshots.find((item) => item.run.id === prior.executionId);
        if (!snapshot) return corrupt();
        return { snapshot, replayed: true };
      }
      this.assertPolicyNonce(input.clientRequestId);
      if (
        this.receipt(input.clientRequestId) ||
        this.candidateReceipt(input.clientRequestId) ||
        this.db
          .prepare("SELECT nonce FROM quality_actual_requests WHERE nonce=?")
          .get(input.clientRequestId)
      )
        fail(
          "QUALITY_EXECUTION_NONCE_CONFLICT",
          "같은 요청 번호가 다른 평가·후보 기록에 사용됐습니다.",
        );
      if (snapshots.length >= qualityExecutionLimits.runs)
        fail("QUALITY_EXECUTION_LIMIT", "모의 실행 기록은 최대 20개까지 보관할 수 있습니다.");
      if (input.preparation.expectedRunCount !== snapshots.length)
        fail(
          "QUALITY_EXECUTION_VERSION_CONFLICT",
          "다른 실행이 먼저 시작됐습니다. 준비안을 다시 확인해 주세요.",
        );
      if (
        snapshots.some(
          (item) =>
            item.run.preparation.candidateId === input.preparation.candidateId &&
            qualityExecutionIsUnsettled(item),
        )
      )
        fail(
          "QUALITY_EXECUTION_UNSETTLED",
          "이 후보의 이전 실행 결과가 미확정입니다. 저장 기록만 조회할 수 있으며 다시 실행하지 않습니다.",
        );
      const registry = this.candidateSnapshots().find(
        (item) => item.version === input.preparation.version,
      );
      if (!registry)
        fail("QUALITY_EXECUTION_CANDIDATE_NOT_FOUND", "등록 후보를 찾을 수 없습니다.", 404);
      let prepared;
      try {
        prepared = createQualityExecutionPreparation(
          registry,
          input.preparation.candidateId,
          contract,
          snapshots.length,
        );
      } catch {
        fail("QUALITY_EXECUTION_SCOPE_CHANGED", "실행 후보 또는 엔진 범위를 확인하지 못했습니다.");
      }
      if (digest(input.preparation) !== digest(prepared))
        fail(
          "QUALITY_EXECUTION_SCOPE_CHANGED",
          "후보 원문·엔진·모델·한도가 준비안과 다릅니다. 새 준비안을 확인해 주세요.",
        );
      const run = qualityExecutionCreateRun({
        id: randomUUID(),
        clientRequestId: input.clientRequestId,
        preparation: prepared,
        authorizedAt: new Date().toISOString(),
      });
      const receipt = qualityExecutionReceiptSchema.parse({
        kind: "start-candidate-execution",
        executionId: run.id,
        clientRequestId: run.clientRequestId,
        inputDigest,
        runDigest: run.runDigest,
        planDigest: prepared.planDigest,
      });
      const body = JSON.stringify(run),
        receiptBody = JSON.stringify(receipt);
      if (Buffer.byteLength(body) > qualityExecutionLimits.runBytes)
        fail("QUALITY_EXECUTION_PIN_LIMIT", "실행 준비안 보관 한도를 초과했습니다.", 413);
      this.budget(Buffer.byteLength(body) + Buffer.byteLength(receiptBody));
      this.db
        .prepare("INSERT INTO quality_execution_runs(id,body,body_hash) VALUES(?,?,?)")
        .run(run.id, body, digest(run));
      this.db
        .prepare("INSERT INTO quality_execution_requests(nonce,body,body_hash) VALUES(?,?,?)")
        .run(input.clientRequestId, receiptBody, digest(receipt));
      return { snapshot: validateQualityExecutionLedger(run, [], registry), replayed: false };
    }, true);
  }
  executionAppend(id: string, expectedRevision: number, value: QualityExecutionEventPayload) {
    uuid.parse(id);
    z.number().int().min(0).max(qualityExecutionLimits.events).parse(expectedRevision);
    const payload = qualityExecutionEventPayloadSchema.parse(value);
    return this.transaction(() => {
      const current = this.executionSnapshots().find((item) => item.run.id === id);
      if (!current) fail("QUALITY_EXECUTION_NOT_FOUND", "모의 실행 기록을 찾을 수 없습니다.", 404);
      if (current.revision !== expectedRevision)
        fail(
          "QUALITY_EXECUTION_EVENT_CONFLICT",
          "실행 기록이 변경되었습니다. 같은 단계를 다시 전송하지 않습니다.",
        );
      if (current.revision >= qualityExecutionLimits.events)
        fail("QUALITY_EXECUTION_EVENT_LIMIT", "실행 기록 단계 한도를 초과했습니다.");
      const event = qualityExecutionCreateEvent({
        executionId: id,
        revision: current.revision + 1,
        previousEventDigest: current.events.at(-1)?.eventDigest ?? null,
        recordedAt: new Date().toISOString(),
        payload,
      });
      const registry = this.candidateSnapshots().find(
        (item) => item.version === current.run.preparation.version,
      )!;
      let snapshot;
      try {
        snapshot = validateQualityExecutionLedger(
          current.run,
          [...current.events, event],
          registry,
        );
      } catch {
        fail(
          "QUALITY_EXECUTION_EVENT_INVALID",
          "실행 범위 또는 전송·응답·검증 순서가 일치하지 않습니다.",
        );
      }
      const body = JSON.stringify(event);
      if (Buffer.byteLength(body) > qualityExecutionLimits.eventBytes)
        fail("QUALITY_EXECUTION_EVENT_LIMIT", "실행 단계 보관 용량을 초과했습니다.", 413);
      this.budget(Buffer.byteLength(body));
      this.db
        .prepare(
          "INSERT INTO quality_execution_events(run_id,revision,body,body_hash) VALUES(?,?,?,?)",
        )
        .run(id, event.revision, body, digest(event));
      return snapshot;
    }, true);
  }
  executionList() {
    return this.transaction(() => ({ executions: this.executionSnapshots() }));
  }
  executionGet(id: string, revision?: number) {
    uuid.parse(id);
    return this.transaction(() => {
      const current = this.executionSnapshots().find((item) => item.run.id === id);
      if (!current) fail("QUALITY_EXECUTION_NOT_FOUND", "모의 실행 기록을 찾을 수 없습니다.", 404);
      if (revision === undefined) return current;
      if (!Number.isInteger(revision) || revision < 0 || revision > current.revision)
        fail("QUALITY_EXECUTION_REVISION_NOT_FOUND", "실행 기록 버전을 찾을 수 없습니다.", 404);
      const registry = this.candidateSnapshots().find(
        (item) => item.version === current.run.preparation.version,
      )!;
      return validateQualityExecutionLedger(
        current.run,
        current.events.slice(0, revision),
        registry,
      );
    });
  }
  executionLookup(nonce: string) {
    uuid.parse(nonce);
    return this.transaction(() => {
      const snapshots = this.executionSnapshots(),
        receipt = this.executionReceipt(nonce);
      if (!receipt) return { state: "not-observed" as const };
      if (
        !snapshots.some(
          (item) => item.run.id === receipt.executionId && item.run.clientRequestId === nonce,
        )
      )
        return corrupt();
      return { state: "committed" as const, receipt };
    });
  }
  executionDownload(id: string, revision: number) {
    const snapshot = this.executionGet(id, revision);
    return { snapshot, body: JSON.stringify(snapshot, null, 2) + "\n" };
  }
  providerBudgetGet(environment: ProviderEnvironment = "synthetic-test") {
    return this.provider.budgetGet(environment);
  }
  providerReviewContext(version: number) {
    return this.provider.reviewContext(version);
  }
  providerBudgetConfigure(value: ProviderBudgetConfigure) {
    return this.provider.budgetConfigure(value);
  }
  providerStart(value: ProviderStart) {
    return this.provider.start(value);
  }
  providerCancel(id: string, value: ProviderCancel) {
    return this.provider.cancel(id, value);
  }
  providerRecordApprove(id: string, value: ProviderExecutionCommand<"transmission-approved">) {
    return this.provider.recordApprove(id, value);
  }
  providerRecordPrepared(id: string, value: ProviderExecutionCommand<"request-prepared">) {
    return this.provider.recordPrepared(id, value);
  }
  providerRecordDispatch(id: string, value: ProviderExecutionCommand<"dispatch-intent">) {
    return this.provider.recordDispatch(id, value);
  }
  providerRecordResponse(id: string, value: ProviderExecutionCommand<"response-received">) {
    return this.provider.recordResponse(id, value);
  }
  providerRecordValidated(id: string, value: ProviderExecutionCommand<"domain-validated">) {
    return this.provider.recordValidated(id, value);
  }
  providerRecordFinish(id: string, value: ProviderExecutionCommand<"execution-stopped">) {
    return this.provider.recordFinish(id, value);
  }
  /** Read-only stored-version view, with no execution compatibility grant. */
  providerArchiveGet(id: string, revision?: number) {
    return this.provider.getArchive(id, revision);
  }
  providerGet(id: string, revision?: number) {
    return this.provider.get(id, revision);
  }
  providerList() {
    return this.provider.list();
  }
  providerLookup(nonce: string) {
    return this.provider.lookup(nonce);
  }
  providerPolicyHead() {
    return this.providerPolicy.head();
  }
  providerPolicyReviewContext(version: number) {
    return this.providerPolicy.reviewContext(version);
  }
  providerPolicyReview(version: number, candidateId: string) {
    return this.providerPolicy.review(version, candidateId);
  }
  providerPolicyLookup(nonce: string) {
    return this.providerPolicy.lookup(nonce);
  }
  providerPolicyAdopt(command: unknown, approvedReview: unknown) {
    return this.providerPolicy.adopt(command, approvedReview);
  }
  providerReservationReview(selection: unknown) {
    return this.providerReservation.review(selection);
  }
  providerReservationLookup(nonce: string) {
    return this.providerReservationCommands.lookup(nonce);
  }
  providerReserve(command: unknown, approvedReview: unknown) {
    return this.providerReservationCommands.reserve(command, approvedReview);
  }
  providerTransmissionReview(selection: unknown) {
    return this.providerTransmission.review(selection);
  }
  providerTransmissionApprovalLookup(nonce: string) {
    return this.providerTransmissionCommands.lookup(nonce);
  }
  providerApproveTransmission(command: unknown, approvedReview: unknown) {
    return this.providerTransmissionCommands.approve(command, approvedReview);
  }
  providerGenerationDispatchLookup(identity: unknown) {
    return this.providerGenerationDispatch.lookup(identity);
  }
  providerProductionGenerationReadiness(identity: unknown) {
    return this.providerGenerationDispatch.productionReadiness(identity);
  }
  providerResolveProductionIdentity(selection: unknown) {
    return this.providerGenerationDispatch.resolveProductionIdentity(selection);
  }
  providerProductionStatus(selection: unknown) {
    return this.providerGenerationDispatch.productionStatus(selection);
  }
  /** Explicit trusted server entry only; commands contain the original approved identity. */
  providerRunApprovedProduction(identity: unknown) {
    return this.providerGenerationDispatch.executeProduction(identity);
  }
  /** Sensitive retained capture recovery, never HTTP/client input or an automatic resend. */
  providerRecoverProductionGenerationCapture(capture: unknown) {
    return this.providerGenerationDispatch.recoverProductionGeneration(capture);
  }
  providerRecoverProductionReviewCapture(capture: unknown) {
    return this.providerGenerationDispatch.recoverProductionReview(capture);
  }
  providerGenerationResponseLookup(input: unknown) {
    return this.providerGenerationDispatch.responseLookup(input);
  }
  providerRecordGenerationResponse(input: unknown) {
    return this.providerGenerationDispatch.recordResponse(input);
  }
  providerPrepareReviewResponse(capture: unknown) {
    return this.providerGenerationDispatch.prepareReviewResponse(capture);
  }
  providerPrepareFinalization(identity: unknown) {
    return this.providerGenerationDispatch.prepareFinalization(identity);
  }
  providerRecordFinalization(identity: unknown) {
    return this.providerGenerationDispatch.recordFinalization(identity);
  }
  providerFinalizationLookup(identity: unknown) {
    return this.providerGenerationDispatch.finalizationLookup(identity);
  }
  providerPrepareReviewValidation(identity: unknown) {
    return this.providerGenerationDispatch.prepareReviewValidation(identity);
  }
  providerRecordReviewValidation(identity: unknown) {
    return this.providerGenerationDispatch.recordReviewValidation(identity);
  }
  providerReviewValidationLookup(identity: unknown) {
    return this.providerGenerationDispatch.reviewValidationLookup(identity);
  }
  providerReviewResponseLookup(capture: unknown) {
    return this.providerGenerationDispatch.reviewResponseLookup(capture);
  }
  providerRecordReviewResponse(capture: unknown) {
    return this.providerGenerationDispatch.recordReviewResponse(capture);
  }
  providerPrepareReviewDispatch(identity: unknown) {
    return this.providerGenerationDispatch.prepareReviewDispatch(identity);
  }
  providerReviewDispatchLookup(identity: unknown) {
    return this.providerGenerationDispatch.reviewDispatchLookup(identity);
  }
  providerSimulateReviewDispatch(identity: unknown, transport: ProviderReviewMockTransport) {
    return this.providerGenerationDispatch.simulateReview(identity, transport);
  }
  providerSimulateReviewSdkDispatch(identity: unknown) {
    return this.providerGenerationDispatch.simulateReviewSdk(identity);
  }
  providerSimulateGenerationSdkDispatch(identity: unknown) {
    return this.providerGenerationDispatch.simulateSdk(identity);
  }
  providerPrepareGenerationValidation(identity: unknown) {
    return this.providerGenerationDispatch.prepareGenerationValidation(identity);
  }
  providerPrepareReviewStop(identity: unknown) {
    return this.providerGenerationDispatch.prepareReviewStop(identity);
  }
  providerRecordReviewStop(identity: unknown) {
    return this.providerGenerationDispatch.recordReviewStop(identity);
  }
  providerReviewStopLookup(identity: unknown) {
    return this.providerGenerationDispatch.reviewStopLookup(identity);
  }
  providerPrepareGenerationStop(identity: unknown) {
    return this.providerGenerationDispatch.prepareGenerationStop(identity);
  }
  providerRecordGenerationStop(identity: unknown) {
    return this.providerGenerationDispatch.recordGenerationStop(identity);
  }
  providerGenerationStopLookup(identity: unknown) {
    return this.providerGenerationDispatch.generationStopLookup(identity);
  }
  providerRecordGenerationValidation(identity: unknown) {
    return this.providerGenerationDispatch.recordGenerationValidation(identity);
  }
  providerGenerationValidationLookup(identity: unknown) {
    return this.providerGenerationDispatch.generationValidationLookup(identity);
  }
  providerSimulateGenerationDispatch(
    identity: unknown,
    transport: ProviderGenerationMockTransport,
  ) {
    return this.providerGenerationDispatch.simulate(identity, transport);
  }
  providerArtifact(id: string, key = "generation-request") {
    return this.provider.artifact(id, key);
  }
  providerDownload(id: string, revision: number) {
    return this.provider.download(id, revision);
  }
  actualBudgetGet() {
    return this.actual.budgetGet();
  }
  actualBudgetConfigure(value: ActualBudgetConfigure) {
    return this.actual.budgetConfigure(value);
  }
  actualStart(value: ActualLedgerStart) {
    return this.actual.start(value);
  }
  actualRecordPrepared(id: string, value: ActualPreparedInput) {
    return this.actual.recordPrepared(id, value);
  }
  actualRecordDispatch(id: string, value: ActualDispatchInput) {
    return this.actual.recordDispatch(id, value);
  }
  actualRecordResponse(id: string, value: ActualResponseInput) {
    return this.actual.recordResponse(id, value);
  }
  actualRecordValidated(id: string, value: ActualValidatedInput) {
    return this.actual.recordValidated(id, value);
  }
  actualRecordFinish(id: string, value: ActualFinishInput) {
    return this.actual.recordFinish(id, value);
  }
  actualStop(id: string, value: ActualFinishInput) {
    return this.actual.recordFinish(id, value);
  }
  actualGet(id: string, revision?: number) {
    return this.actual.get(id, revision);
  }
  actualList() {
    return this.actual.list();
  }
  actualLookup(nonce: string) {
    return this.actual.lookup(nonce);
  }
  actualDownload(id: string, revision: number) {
    return this.actual.download(id, revision);
  }
  actualArtifact(id: string, key: string) {
    return this.actual.artifact(id, key);
  }
  /** Stable archival payload excludes live metadata and code-dependent aggregation. */
  download(id: string, revision?: number) {
    const run = this.get(id, revision);
    const {
      currentRevision: _currentRevision,
      manifestCurrent: _manifestCurrent,
      summary: _summary,
      ...archive
    } = run;
    void _currentRevision;
    void _manifestCurrent;
    void _summary;
    return {
      run,
      body:
        JSON.stringify(
          {
            schemaVersion: 1,
            notice:
              "사용자가 입력한 평가 기록입니다. 실제 실행·비용·독립 평가 완료를 자동으로 증명하지 않습니다.",
            ...archive,
          },
          null,
          2,
        ) + "\n",
    };
  }
}
let cached: { directory: string; store: PlanQualityStore } | undefined;
export function getPlanQualityStore() {
  const directory = resolve(
    process.env.VENTURE_DATA_DIR || resolve(process.cwd(), ".venture-pass"),
  );
  if (!cached || cached.directory !== directory) {
    cached?.store.close();
    cached = { directory, store: new PlanQualityStore(directory) };
  }
  return cached.store;
}
