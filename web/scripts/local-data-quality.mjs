import { backup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  inspectQualitySchema,
  assertQualityLegacyLedgerRows,
  migrateQualitySchemaV7,
  qualityReservationTableSql,
  qualityV7WriterTriggerSql,
  qualityV8WriterTriggerSql,
  qualityV8ImmutableTriggerSql,
  qualityTransmissionApprovalTableSql,
  qualityV9WriterTriggerSql,
  qualityV9ImmutableTriggerSql,
} from "./local-data-quality-schema.mjs";
import { inspectQualityLedgers } from "./local-data-quality-ledgers.mjs";
import { decodeProviderPolicyRows } from "./local-data-quality-provider-policy.mjs";
import {
  createProviderReservationMigrationCoverage,
  inspectProviderReservationArchive,
} from "./local-data-quality-provider-reservation-binding.mjs";
import { readProviderReservationDatabaseRows } from "./local-data-quality-provider-reservation-database.mjs";
import {
  createProviderTransmissionApprovalMigrationCoverage,
  inspectProviderTransmissionApprovalArchive,
} from "./local-data-quality-provider-transmission-binding.mjs";
import { readProviderTransmissionApprovalDatabaseRows } from "./local-data-quality-provider-transmission-database.mjs";
import {
  createDestination,
  fail,
  nativePaths,
  readPrefixSafe,
  readSafe,
  safePath,
  sha,
  writeNew,
  within,
} from "./local-data-files.mjs";

const fileName = "quality.sqlite",
  manifestName = "quality-backup-manifest.json",
  markerName = "COMPLETE.json",
  pendingName = ".restore-pending";
const maxBytes = 264 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid();
const legacyManifestSchema = z
  .object({
    format: z.literal("venturepass-quality-backup"),
    version: z.literal(1),
    createdAt: z.string().datetime(),
    logicalDigest: hash,
    runs: z.number().int().min(0).max(20),
    revisions: z.number().int().min(0).max(4000),
    requests: z.number().int().min(0).max(4020),
    file: z
      .object({
        name: z.literal(fileName),
        sizeBytes: z.number().int().min(100).max(maxBytes),
        sha256: hash,
      })
      .strict(),
  })
  .strict();
const candidateManifestSchema = legacyManifestSchema
  .extend({
    version: z.literal(2),
    candidateVersions: z.number().int().min(0).max(20),
    candidateRequests: z.number().int().min(0).max(20),
  })
  .strict();
const executionManifestSchema = candidateManifestSchema
  .extend({
    version: z.literal(3),
    executionRuns: z.number().int().min(0).max(20),
    executionEvents: z.number().int().min(0).max(140),
    executionRequests: z.number().int().min(0).max(20),
  })
  .strict();
const actualManifestSchema = executionManifestSchema
  .extend({
    version: z.literal(4),
    actualBudgetEvents: z.number().int().min(0).max(1000),
    actualRuns: z.number().int().min(0).max(20),
    actualEvents: z.number().int().min(0).max(640),
    actualArtifacts: z.number().int().min(0).max(140),
    actualRequests: z.number().int().min(0).max(1000),
  })
  .strict();
const manifestSchema = z.discriminatedUnion("version", [
  legacyManifestSchema,
  candidateManifestSchema,
  executionManifestSchema,
  actualManifestSchema,
  actualManifestSchema.extend({ version: z.literal(5) }).strict(),
  actualManifestSchema.extend({ version: z.literal(6) }).strict(),
  actualManifestSchema
    .extend({ version: z.literal(7), providerPolicies: z.number().int().min(0).max(100) })
    .strict(),
  actualManifestSchema
    .extend({
      version: z.literal(8),
      providerPolicies: z.number().int().min(0).max(100),
      providerReservationBindings: z.number().int().min(0).max(20),
      providerReservationCoverage: z.literal(1),
    })
    .strict(),
  actualManifestSchema
    .extend({
      version: z.literal(9),
      providerPolicies: z.number().int().min(0).max(100),
      providerReservationBindings: z.number().int().min(0).max(20),
      providerReservationCoverage: z.literal(1),
      providerTransmissionBindings: z.number().int().min(0).max(20),
      providerTransmissionCoverage: z.literal(1),
    })
    .strict(),
]);
const candidateSetId = "ai-validation-candidates";
const candidateId = z
  .string()
  .regex(/^validation-candidate-[a-z0-9-]+$/)
  .max(120);
const candidateVersion = z.number().int().min(1).max(20);
const candidateManifestEntry = z
  .object({
    candidateId,
    label: z.string().min(1).max(200),
    sourceDigest: hash,
    candidateDigest: hash,
    modelInputDigest: hash,
    reviewerMetadataDigest: hash,
  })
  .strict();
// Verify the pinned archival envelope and bindings without rerunning today's
// company validation or judging the quality of these AI-authored synthetic inputs.
const candidateEnvelope = z
  .object({
    schemaVersion: z.literal(1),
    setId: z.literal(candidateSetId),
    synthetic: z.literal(true),
    authoredBy: z.literal("ai"),
    humanAnswerKey: z.null(),
    independentHoldoutConfirmed: z.literal(false),
    performanceEvaluation: z.literal("not-performed"),
    sourceDigest: hash,
    manifestDigest: hash,
    manifest: z.array(candidateManifestEntry).length(12),
    entries: z
      .array(
        z
          .object({
            candidateId,
            label: z.string().min(1).max(200),
            input: z
              .object({
                profile: z.record(z.string(), z.unknown()),
                sources: z
                  .array(z.object({ id: uuid }).passthrough())
                  .min(4)
                  .max(100),
                candidate: z.record(z.string(), z.unknown()),
              })
              .strict(),
            reviewerMetadata: z
              .object({
                sector: z.enum(["manufacturing", "software", "service"]),
                applicationKind: z.enum(["new", "renewal"]),
                materialDesign: z.enum([
                  "connected-narrative",
                  "intentional-gap",
                  "intentional-conflict",
                ]),
                challengeTags: z.array(z.string().min(1).max(100)).max(100),
                authoringNotes: z.array(z.string().min(1).max(10000)).max(100),
              })
              .strict(),
          })
          .strict(),
      )
      .length(12),
    kind: z.literal("validation-candidate-set"),
    version: candidateVersion,
    previousVersion: candidateVersion.nullable(),
    previousDigest: hash.nullable(),
    versionDigest: hash,
    registeredAt: z.string().datetime(),
    clientRequestId: uuid,
    notice: z.literal(
      "AI가 작성한 합성 후보의 로컬 등록본입니다. 사람 정답표·독립 검증세트·실제 AI 성능평가 완료를 뜻하지 않습니다.",
    ),
  })
  .strict();
const candidateReceiptEnvelope = z
  .object({
    kind: z.literal("register-candidate-set"),
    setId: z.literal(candidateSetId),
    version: candidateVersion,
    clientRequestId: uuid,
    inputDigest: hash,
    versionDigest: hash,
  })
  .strict();
const executionModel = "venturepass-synthetic-plan-v1";
const executionCostEnvelope = z
  .object({
    kind: z.literal("mock-no-charge"),
    actualCharge: z.literal(0),
    currency: z.null(),
    priceEvidence: z.null(),
    actualAiAllowed: z.literal(false),
    actualAiBudget: z.null(),
    inputTokenEstimate: z.null(),
  })
  .strict();
const executionEngineEnvelope = z
  .object({
    schemaVersion: z.literal(1),
    engineVersion: z.literal("plan-observation-v1"),
    provider: z.literal("OpenAI"),
    endpoint: z.literal("https://api.openai.com/v1"),
    maxCalls: z.literal(2),
    maxInputChars: z.literal(240000),
    maxOutputTokens: z.literal(16000),
    timeoutMs: z.literal(120000),
    maxRetries: z.literal(0),
    store: z.literal(false),
    repair: z.literal(false),
    phases: z
      .array(
        z
          .object({
            phase: z.enum(["generation", "review"]),
            name: z.string().min(1),
            systemDigest: hash,
            instructionDigest: hash,
            schemaDigest: hash,
          })
          .strict(),
      )
      .length(2),
    contractDigest: hash,
  })
  .strict();
const executionPreparationEnvelope = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("mock-candidate-execution"),
    mode: z.literal("mock"),
    provider: z.literal("mock"),
    model: z.literal(executionModel),
    destination: z.literal("local-mock-transport"),
    setId: z.literal(candidateSetId),
    version: candidateVersion,
    versionDigest: hash,
    registrySourceDigest: hash,
    manifestDigest: hash,
    candidateId,
    label: z.string().min(1).max(200),
    sourceDigest: hash,
    candidateDigest: hash,
    modelInputDigest: hash,
    engine: executionEngineEnvelope,
    expectedRunCount: z.number().int().min(0).max(20),
    cost: executionCostEnvelope,
    purpose: z.literal("synthetic-candidate-generation-and-review"),
    humanAnswerKey: z.null(),
    independentHoldoutConfirmed: z.literal(false),
    performanceEvaluation: z.literal("not-performed"),
    actualExecutionBlockReason: z.literal(
      "실제 AI 실행의 가격 근거·금액 상한·전송 승인이 준비되지 않아 실행할 수 없습니다.",
    ),
    planDigest: hash,
  })
  .strict();
const executionRunEnvelope = z
  .object({
    id: uuid,
    clientRequestId: uuid,
    inputDigest: hash,
    authorizedAt: z.string().datetime(),
    preparation: executionPreparationEnvelope,
    runDigest: hash,
  })
  .strict();
const executionReceiptEnvelope = z
  .object({
    kind: z.literal("start-candidate-execution"),
    executionId: uuid,
    clientRequestId: uuid,
    inputDigest: hash,
    runDigest: hash,
    planDigest: hash,
  })
  .strict();
const executionRequestEnvelope = z
  .object({
    phase: z.enum(["generation", "review"]),
    sequence: z.union([z.literal(1), z.literal(2)]),
    mode: z.literal("mock"),
    provider: z.literal("mock"),
    configuredModel: z.literal(executionModel),
    contractDigest: hash,
    requestDigest: hash,
    inputChars: z.number().int().nonnegative().max(240000),
    maxOutputTokens: z.literal(16000),
  })
  .strict();
const executionTokens = z.number().int().nonnegative().safe();
const executionResponseEnvelope = z
  .object({
    request: executionRequestEnvelope,
    responseId: z.string().max(500).nullable(),
    requestId: z.string().max(500).nullable(),
    responseModel: z.string().max(200).nullable(),
    status: z.string().max(100).nullable(),
    usage: z
      .object({
        inputTokens: executionTokens,
        outputTokens: executionTokens,
        totalTokens: executionTokens,
        cachedInputTokens: executionTokens.nullable(),
        reasoningOutputTokens: executionTokens.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const executionOutputEnvelope = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("plan"),
      content: z
        .object({
          title: z.string().max(300),
          summary: z.string().max(6000),
          sections: z
            .array(
              z
                .object({
                  key: z.string(),
                  title: z.string().max(200),
                  content: z.string().max(18000),
                  evidence: z.array(
                    z
                      .object({
                        sourceId: z.string(),
                        quote: z.string().max(1500),
                        locator: z.string().max(150),
                      })
                      .passthrough(),
                  ),
                  needsConfirmation: z.boolean(),
                })
                .passthrough(),
            )
            .max(20),
          actionItems: z.array(z.string().max(3000)).max(40),
          interviewQuestions: z.array(z.string().max(3000)).max(30),
        })
        .passthrough(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      findings: z
        .array(
          z
            .object({
              id: z.string(),
              severity: z.enum(["error", "warning", "info"]),
              category: z.string(),
              message: z.string().max(3000),
              action: z.string().max(3000),
              sectionKey: z.string().nullable(),
              sourceIds: z.array(z.string()),
            })
            .passthrough(),
        )
        .max(12),
    })
    .strict(),
]);
const executionResultEnvelope = z
  .object({
    content: executionOutputEnvelope.options[0].shape.content,
    review: z.array(executionOutputEnvelope.options[1].shape.findings.element).max(250),
    semanticReview: executionOutputEnvelope.options[1].shape.findings,
    contractDigest: hash,
  })
  .strict();
const executionEventEnvelope = z
  .object({
    executionId: uuid,
    revision: z.number().int().min(1).max(7),
    previousEventDigest: hash.nullable(),
    recordedAt: z.string().datetime(),
    eventDigest: hash,
    payload: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("dispatch"), request: executionRequestEnvelope }).strict(),
      z.object({ kind: z.literal("response"), response: executionResponseEnvelope }).strict(),
      z
        .object({
          kind: z.literal("validated"),
          validated: z
            .object({
              request: executionRequestEnvelope,
              outputDigest: hash,
              output: executionOutputEnvelope,
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("finished"),
          outcome: z.enum(["completed", "failed", "unknown"]),
          failureCode: z
            .enum(["ENGINE_FAILED", "OUTPUT_INVALID", "RESPONSE_UNRECORDED", "INTERRUPTED"])
            .nullable(),
          result: executionResultEnvelope.nullable(),
        })
        .strict(),
    ]),
  })
  .strict();
const markerSchema = z
  .object({ format: z.literal("venturepass-quality-backup-complete"), manifestSha256: hash })
  .strict();
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
function unchangedRoot(root, identity) {
  if (!sameIdentity(identity, safePath(root, "directory"))) fail("QUALITY_PATH_CHANGED");
}
function sameSnapshot(first, second) {
  if (JSON.stringify(first) !== JSON.stringify(second)) fail("QUALITY_DATABASE_CHANGED");
}
function sameFile(first, second) {
  if (first.sizeBytes !== second.sizeBytes || first.sha256 !== second.sha256)
    fail("QUALITY_FILE_CHANGED");
}
function noJournals(file) {
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (existsSync(file + suffix)) fail("QUALITY_DATABASE_BUSY");
}
function secureFile(file) {
  const stat = safePath(file);
  if (stat.size > BigInt(maxBytes)) fail("QUALITY_DATABASE_LIMIT");
  nativePaths([file]);
  noJournals(file);
  const header = readPrefixSafe(file, 100, maxBytes);
  if (
    header.subarray(0, 16).toString("binary") !== "SQLite format 3\0" ||
    header[18] !== 1 ||
    header[19] !== 1
  )
    fail("QUALITY_DATABASE_INVALID");
  return stat;
}
function decode(row, maximum) {
  if (
    typeof row.body !== "string" ||
    Buffer.byteLength(row.body) > maximum ||
    typeof row.body_hash !== "string"
  )
    fail("QUALITY_DATABASE_INVALID");
  let value;
  try {
    value = JSON.parse(row.body);
  } catch {
    fail("QUALITY_DATABASE_INVALID");
  }
  if (digest(value) !== row.body_hash) fail("QUALITY_DATABASE_INVALID");
  return value;
}
function inspectCandidateRows(versionRows, receiptRows, evaluationNonces) {
  const receipts = new Map(),
    sourceDigests = new Set(),
    bindings = new Map();
  let previous = null,
    total = 0;
  for (const row of receiptRows) {
    total += Buffer.byteLength(row.body);
    const parsed = candidateReceiptEnvelope.safeParse(decode(row, 4096));
    if (
      !parsed.success ||
      parsed.data.clientRequestId !== row.nonce ||
      evaluationNonces.has(row.nonce)
    )
      fail("QUALITY_DATABASE_INVALID");
    receipts.set(row.nonce, parsed.data);
  }
  for (const row of versionRows) {
    total += Buffer.byteLength(row.body);
    const value = decode(row, 8 * 1024 * 1024);
    if (!candidateEnvelope.safeParse(value).success) fail("QUALITY_DATABASE_INVALID");
    const { versionDigest, ...payload } = value;
    const sourceIds = value.entries.flatMap((entry) =>
      entry.input.sources.map((source) => source.id),
    );
    const manifest = value.entries.map((entry) => ({
      candidateId: entry.candidateId,
      label: entry.label,
      sourceDigest: digest({ profile: entry.input.profile, sources: entry.input.sources }),
      candidateDigest: digest(entry.input.candidate),
      modelInputDigest: digest(entry.input),
      reviewerMetadataDigest: digest(entry.reviewerMetadata),
    }));
    if (
      row.set_id !== candidateSetId ||
      row.version !== (previous?.version ?? 0) + 1 ||
      value.version !== row.version ||
      value.previousVersion !== (previous?.version ?? null) ||
      value.previousDigest !== (previous?.versionDigest ?? null) ||
      sourceDigests.has(value.sourceDigest) ||
      new Set(value.entries.map((entry) => entry.candidateId)).size !== 12 ||
      new Set(sourceIds).size !== sourceIds.length ||
      value.sourceDigest !==
        digest({ schemaVersion: 1, setId: candidateSetId, entries: value.entries }) ||
      value.manifestDigest !== digest(value.manifest) ||
      value.manifestDigest !== digest(manifest) ||
      versionDigest !== digest(payload)
    )
      fail("QUALITY_DATABASE_INVALID");
    const receipt = receipts.get(value.clientRequestId);
    if (
      !receipt ||
      receipt.version !== value.version ||
      receipt.versionDigest !== versionDigest ||
      receipt.inputDigest !==
        digest({
          kind: "register-candidate-set",
          setId: candidateSetId,
          input: {
            expectedVersion: value.version - 1,
            clientRequestId: value.clientRequestId,
            sourceDigest: value.sourceDigest,
            acknowledgedCandidateStatus: true,
          },
        })
    )
      fail("QUALITY_DATABASE_INVALID");
    receipts.delete(value.clientRequestId);
    sourceDigests.add(value.sourceDigest);
    bindings.set(value.version, {
      versionDigest: value.versionDigest,
      sourceDigest: value.sourceDigest,
      manifestDigest: value.manifestDigest,
      candidates: new Map(
        value.entries.map((entry, index) => [
          entry.candidateId,
          {
            ...manifest[index],
            sourceIds: new Set([
              "profile",
              ...entry.input.sources
                .filter((source) => source.extraction !== "pending")
                .map((source) => source.id),
            ]),
          },
        ]),
      ),
    });
    previous = value;
  }
  if (receipts.size) fail("QUALITY_DATABASE_INVALID");
  return { total, bindings };
}
function inspectExecutionRows(runRows, eventRows, receiptRows, registryBindings, otherNonces) {
  const runs = new Map(),
    receipts = new Map(),
    startCounts = new Set();
  let total = 0;
  for (const row of receiptRows) {
    const value = decode(row, 4096);
    total += Buffer.byteLength(row.body);
    if (
      !executionReceiptEnvelope.safeParse(value).success ||
      value.clientRequestId !== row.nonce ||
      otherNonces.has(row.nonce)
    )
      fail("QUALITY_DATABASE_INVALID");
    receipts.set(row.nonce, value);
  }
  for (const row of runRows) {
    const value = decode(row, 32 * 1024);
    total += Buffer.byteLength(row.body);
    if (!executionRunEnvelope.safeParse(value).success || row.id !== value.id)
      fail("QUALITY_DATABASE_INVALID");
    const preparation = value.preparation,
      registry = registryBindings.get(preparation.version),
      candidate = registry?.candidates.get(preparation.candidateId);
    const { contractDigest, ...engine } = preparation.engine;
    const { planDigest, ...prepared } = preparation;
    const { runDigest, ...run } = value;
    if (
      !candidate ||
      preparation.versionDigest !== registry.versionDigest ||
      preparation.registrySourceDigest !== registry.sourceDigest ||
      preparation.manifestDigest !== registry.manifestDigest ||
      ["label", "sourceDigest", "candidateDigest", "modelInputDigest"].some(
        (key) => preparation[key] !== candidate[key],
      ) ||
      contractDigest !== digest(engine) ||
      engine.phases[0].phase !== "generation" ||
      engine.phases[1].phase !== "review" ||
      planDigest !== digest(prepared) ||
      runDigest !== digest(run) ||
      preparation.expectedRunCount >= runRows.length ||
      startCounts.has(preparation.expectedRunCount) ||
      value.inputDigest !==
        digest({
          kind: "start-candidate-execution",
          input: {
            clientRequestId: value.clientRequestId,
            preparation,
            acknowledgedMockOnly: true,
          },
        })
    )
      fail("QUALITY_DATABASE_INVALID");
    const receipt = receipts.get(value.clientRequestId);
    if (
      !receipt ||
      receipt.executionId !== value.id ||
      receipt.inputDigest !== value.inputDigest ||
      receipt.runDigest !== runDigest ||
      receipt.planDigest !== planDigest
    )
      fail("QUALITY_DATABASE_INVALID");
    receipts.delete(value.clientRequestId);
    startCounts.add(preparation.expectedRunCount);
    runs.set(value.id, {
      run: value,
      candidate,
      revision: 0,
      previousDigest: null,
      state: "authorized",
      request: null,
      responseStatus: null,
      dispatches: 0,
      validated: 0,
      plan: null,
      review: null,
    });
  }
  for (const row of eventRows) {
    const value = decode(row, 1024 * 1024);
    total += Buffer.byteLength(row.body);
    if (!executionEventEnvelope.safeParse(value).success) fail("QUALITY_DATABASE_INVALID");
    const parent = runs.get(row.run_id),
      { eventDigest, ...event } = value;
    if (
      !parent ||
      row.run_id !== value.executionId ||
      row.revision !== value.revision ||
      value.revision !== parent.revision + 1 ||
      value.previousEventDigest !== parent.previousDigest ||
      eventDigest !== digest(event) ||
      ["completed", "failed", "unknown"].includes(parent.state)
    )
      fail("QUALITY_DATABASE_INVALID");
    const payload = value.payload;
    if (payload.kind === "dispatch") {
      const next = payload.request,
        preparation = parent.run.preparation;
      if (
        !(
          (parent.dispatches === 0 && parent.state === "authorized") ||
          (parent.dispatches === 1 && parent.state === "output-validated" && parent.validated === 1)
        ) ||
        next.sequence !== parent.dispatches + 1 ||
        next.phase !== (next.sequence === 1 ? "generation" : "review") ||
        next.configuredModel !== preparation.model ||
        next.contractDigest !== preparation.engine.contractDigest ||
        next.maxOutputTokens !== preparation.engine.maxOutputTokens ||
        next.inputChars > preparation.engine.maxInputChars
      )
        fail("QUALITY_DATABASE_INVALID");
      parent.request = next;
      parent.dispatches++;
      parent.state = "dispatch-recorded";
    } else if (payload.kind === "response") {
      if (
        parent.state !== "dispatch-recorded" ||
        !parent.request ||
        digest(parent.request) !== digest(payload.response.request)
      )
        fail("QUALITY_DATABASE_INVALID");
      parent.responseStatus = payload.response.status;
      parent.state = "response-observed";
    } else if (payload.kind === "validated") {
      const output = payload.validated.output;
      if (
        parent.state !== "response-observed" ||
        !parent.request ||
        parent.responseStatus !== "completed" ||
        digest(parent.request) !== digest(payload.validated.request) ||
        digest(output) !== payload.validated.outputDigest ||
        (parent.request.phase === "generation") !== (output.kind === "plan")
      )
        fail("QUALITY_DATABASE_INVALID");
      if (output.kind === "plan") parent.plan = output.content;
      else {
        const sectionKeys = new Set(parent.plan?.sections.map((section) => section.key));
        if (
          !parent.plan ||
          output.findings.some(
            (finding) =>
              finding.sourceIds.some((id) => !parent.candidate.sourceIds.has(id)) ||
              (finding.sectionKey !== null && !sectionKeys.has(finding.sectionKey)),
          )
        )
          fail("QUALITY_DATABASE_INVALID");
        parent.review = output.findings;
      }
      parent.validated++;
      parent.state = "output-validated";
    } else {
      if (payload.outcome === "completed") {
        if (
          parent.state !== "output-validated" ||
          parent.validated !== 2 ||
          !parent.plan ||
          parent.review === null ||
          payload.failureCode !== null
        )
          fail("QUALITY_DATABASE_INVALID");
        const result = payload.result;
        if (
          !result ||
          result.contractDigest !== parent.run.preparation.engine.contractDigest ||
          digest(result.semanticReview) !== digest(parent.review) ||
          result.content.title !== parent.plan.title ||
          result.content.summary !== parent.plan.summary ||
          result.content.sections.length !== parent.plan.sections.length ||
          result.content.sections.some((section, index) => {
            const { needsConfirmation: beforeConfirmation, ...before } =
              parent.plan.sections[index];
            const { needsConfirmation: afterConfirmation, ...after } = section;
            return (beforeConfirmation && !afterConfirmation) || digest(before) !== digest(after);
          }) ||
          !result.semanticReview.every((finding) =>
            result.review.some((item) => digest(item) === digest(finding)),
          )
        )
          fail("QUALITY_DATABASE_INVALID");
        parent.plan = result.content;
        parent.review = result.review;
      } else if (
        payload.result !== null ||
        payload.failureCode === null ||
        (payload.outcome === "unknown") !== (parent.state === "dispatch-recorded")
      )
        fail("QUALITY_DATABASE_INVALID");
      parent.state = payload.outcome;
    }
    parent.revision = value.revision;
    parent.previousDigest = eventDigest;
  }
  if (receipts.size) fail("QUALITY_DATABASE_INVALID");
  const lastCandidateRun = new Map();
  for (const parent of runs.values()) {
    const preparation = parent.run.preparation;
    lastCandidateRun.set(
      preparation.candidateId,
      Math.max(lastCandidateRun.get(preparation.candidateId) ?? -1, preparation.expectedRunCount),
    );
  }
  for (const parent of runs.values()) {
    if (
      parent.run.preparation.expectedRunCount <
        lastCandidateRun.get(parent.run.preparation.candidateId) &&
      !["completed", "failed"].includes(parent.state)
    )
      fail("QUALITY_DATABASE_INVALID");
  }
  return total;
}
function snapshotCounts(snapshot) {
  return {
    ...(Object.hasOwn(snapshot, "providerTransmissionBindings")
      ? {
          providerTransmissionBindings: snapshot.providerTransmissionBindings,
          providerTransmissionCoverage: snapshot.providerTransmissionCoverage,
        }
      : {}),
    ...(Object.hasOwn(snapshot, "providerReservationBindings")
      ? {
          providerReservationBindings: snapshot.providerReservationBindings,
          providerReservationCoverage: snapshot.providerReservationCoverage,
        }
      : {}),
    ...(Object.hasOwn(snapshot, "providerPolicies")
      ? { providerPolicies: snapshot.providerPolicies }
      : {}),
    runs: snapshot.runs,
    revisions: snapshot.revisions,
    requests: snapshot.requests,
    ...(Object.hasOwn(snapshot, "candidateVersions")
      ? {
          candidateVersions: snapshot.candidateVersions,
          candidateRequests: snapshot.candidateRequests,
        }
      : {}),
    ...(Object.hasOwn(snapshot, "executionRuns")
      ? {
          executionRuns: snapshot.executionRuns,
          executionEvents: snapshot.executionEvents,
          executionRequests: snapshot.executionRequests,
        }
      : {}),
    ...(Object.hasOwn(snapshot, "actualRuns")
      ? {
          actualBudgetEvents: snapshot.actualBudgetEvents,
          actualRuns: snapshot.actualRuns,
          actualEvents: snapshot.actualEvents,
          actualArtifacts: snapshot.actualArtifacts,
          actualRequests: snapshot.actualRequests,
        }
      : {}),
  };
}
/** Decode bounded stored bytes; semantic rules are shared with the actual ledger store. */
function inspectActualRows(
  rows,
  registries,
  otherNonces,
  storageVersion,
  policyRows,
  reservationRows,
  transmissionRows,
) {
  let total = 0;
  const decodeRows = (items, maximum, match) =>
    items.map((row) => {
      const value = decode(row, maximum);
      if (!match(row, value)) fail("QUALITY_DATABASE_INVALID");
      total += Buffer.byteLength(row.body);
      return value;
    });
  const budgetEvents = decodeRows(
    rows.budget,
    32 * 1024,
    (row, value) => row.scope_id === value.scopeId && row.revision === value.revision,
  );
  const runs = decodeRows(rows.runs, 2 * 1024 * 1024, (row, value) => row.id === value.id);
  const events = decodeRows(
    rows.events,
    32 * 1024,
    (row, value) => row.run_id === value.runId && row.revision === value.revision,
  );
  const receipts = decodeRows(
    rows.receipts,
    4096,
    (row, value) => row.nonce === value.clientRequestId && !otherNonces.has(row.nonce),
  );
  // Row order is a storage fact, not part of the frozen v1 run JSON. Preserve the
  // original ORDER BY id vectors for v4 backup hashes while checking mixed CAS.
  const byId = new Map(runs.map((run) => [run.id, run]));
  const seenOrder = new Set();
  let previousOrder = 0;
  const orderedRuns = rows.runOrder.map(({ storage_order, id }) => {
    if (
      !Number.isSafeInteger(storage_order) ||
      storage_order <= previousOrder ||
      !byId.has(id) ||
      seenOrder.has(id)
    )
      fail("QUALITY_DATABASE_INVALID");
    previousOrder = storage_order;
    seenOrder.add(id);
    return byId.get(id);
  });
  if (orderedRuns.length !== runs.length) fail("QUALITY_DATABASE_INVALID");
  if (
    storageVersion < 5 &&
    (runs.some((run) => run.schemaVersion !== 1) ||
      [...events, ...budgetEvents, ...receipts].some((row) => Object.hasOwn(row, "schemaVersion")))
  )
    fail("QUALITY_DATABASE_INVALID");
  const artifactKeys = new Set([
    "generation-request",
    "generation-response",
    "generation-validated",
    "review-request",
    "review-response",
    "review-validated",
    "final-result",
  ]);
  const artifacts = rows.artifacts.map((row) => {
    // Decode under the shared absolute bound; the owning frozen v1 or v2
    // validator enforces its exact per-key limits (v2 final output allows 4 MiB).
    const maximum = 8 * 1024 * 1024;
    if (
      !uuid.safeParse(row.run_id).success ||
      !artifactKeys.has(row.artifact_key) ||
      !(row.payload instanceof Uint8Array) ||
      !Number.isInteger(row.size_bytes) ||
      row.size_bytes !== row.payload.byteLength ||
      row.size_bytes > maximum ||
      !hash.safeParse(row.sha256).success ||
      sha(row.payload) !== row.sha256
    )
      fail("QUALITY_DATABASE_INVALID");
    let body;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(row.payload);
      JSON.parse(body);
    } catch {
      fail("QUALITY_DATABASE_INVALID");
    }
    total += row.size_bytes;
    return {
      runId: row.run_id,
      key: row.artifact_key,
      body,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
    };
  });
  let ledger, ledgerInput;
  try {
    const policy = decodeProviderPolicyRows(policyRows);
    total += policy.usedBytes;
    ledgerInput = {
      runs: orderedRuns,
      events,
      budgetEvents,
      artifacts,
      receipts,
      registries,
      otherNonces: [...otherNonces],
      policies: policy.records,
    };
    if (reservationRows) {
      const archive = {
        ledger: ledgerInput,
        coverage: reservationRows.coverage,
        records: reservationRows.records,
      };
      ledger = transmissionRows
        ? inspectProviderTransmissionApprovalArchive({ archive, ...transmissionRows })
            .reservationArchive.ledger
        : inspectProviderReservationArchive(archive).ledger;
      total += reservationRows.usedBytes;
      if (transmissionRows) total += transmissionRows.usedBytes;
    } else ledger = inspectQualityLedgers(ledgerInput);
  } catch {
    fail("QUALITY_DATABASE_INVALID");
  }
  if (
    !Number.isSafeInteger(ledger.reservedBytes) ||
    ledger.reservedBytes < 0 ||
    budgetEvents.length + ledger.reservedBudgetEventSlots > 1000 ||
    receipts.length + ledger.reservedReceiptSlots > 1000
  )
    fail("QUALITY_DATABASE_LIMIT");
  return { total, reservedBytes: ledger.reservedBytes, ledgerInput };
}
/** Structural and immutable-byte verification. No execution or current model-quality claim. */
export function inspectQualityDatabase(db, { inTransaction = false } = {}) {
  return auditQualityDatabase(db, { inTransaction }).snapshot;
}
/** Audited raw bytes in the caller's locked snapshot; includes all tables and original encoding. */
export function inspectQualityDatabaseUsage(db) {
  return auditQualityDatabase(db, { inTransaction: true }).usage;
}
function auditQualityDatabase(db, { inTransaction = false } = {}) {
  // A policy write must audit the same locked snapshot without committing its caller's transaction.
  if (inTransaction && !db.isTransaction) fail("QUALITY_TRANSACTION_REQUIRED");
  if (!inTransaction) db.exec("BEGIN");
  try {
    const size =
      Number(db.prepare("PRAGMA page_count").get().page_count) *
      Number(db.prepare("PRAGMA page_size").get().page_size);
    if (size > maxBytes) fail("QUALITY_DATABASE_LIMIT");
    if (
      db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      fail("QUALITY_DATABASE_INVALID");
    const {
      version: storageVersion,
      schema,
      candidates,
      executions,
      actual,
      policies,
      reservations,
      transmissions,
    } = inspectQualitySchema(db);
    assertQualityLegacyLedgerRows(db, storageVersion);
    const counts = db
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM quality_runs) AS runs,
      (SELECT COUNT(*) FROM quality_revisions) AS revisions,
      (SELECT COUNT(*) FROM quality_requests) AS requests${
        candidates
          ? `,
      (SELECT COUNT(*) FROM quality_candidate_versions) AS candidateVersions,
      (SELECT COUNT(*) FROM quality_candidate_requests) AS candidateRequests`
          : ""
      }${
        executions
          ? `,
      (SELECT COUNT(*) FROM quality_execution_runs) AS executionRuns,
      (SELECT COUNT(*) FROM quality_execution_events) AS executionEvents,
      (SELECT COUNT(*) FROM quality_execution_requests) AS executionRequests`
          : ""
      }${
        actual
          ? `,
      (SELECT COUNT(*) FROM quality_actual_budget_events) AS actualBudgetEvents,
      (SELECT COUNT(*) FROM quality_actual_runs) AS actualRuns,
      (SELECT COUNT(*) FROM quality_actual_events) AS actualEvents,
      (SELECT COUNT(*) FROM quality_actual_artifacts) AS actualArtifacts,
      (SELECT COUNT(*) FROM quality_actual_requests) AS actualRequests`
          : ""
      }${
        policies
          ? `,
      (SELECT COUNT(*) FROM quality_provider_policies) AS providerPolicies`
          : ""
      }`,
      )
      .get();
    if (
      Number(counts.runs) > 20 ||
      Number(counts.revisions) > 4000 ||
      Number(counts.requests) > 4020 ||
      Number(counts.requests) !== Number(counts.runs) + Number(counts.revisions) ||
      (candidates &&
        (Number(counts.candidateVersions) > 20 ||
          Number(counts.candidateRequests) !== Number(counts.candidateVersions))) ||
      (executions &&
        (Number(counts.executionRuns) > 20 ||
          Number(counts.executionEvents) > 140 ||
          Number(counts.executionRequests) !== Number(counts.executionRuns))) ||
      (actual &&
        (Number(counts.actualBudgetEvents) > 1000 ||
          Number(counts.actualRuns) > 20 ||
          Number(counts.actualEvents) > 640 ||
          Number(counts.actualArtifacts) > 140 ||
          Number(counts.actualRequests) > 1000)) ||
      (policies && Number(counts.providerPolicies) > 100)
    )
      fail("QUALITY_DATABASE_LIMIT");
    const runRows = db.prepare("SELECT id,body,body_hash FROM quality_runs ORDER BY id").all();
    const revisionRows = db
      .prepare(
        "SELECT run_id,revision,body,body_hash FROM quality_revisions ORDER BY run_id,revision",
      )
      .all();
    const receiptRows = db
      .prepare("SELECT nonce,body,body_hash FROM quality_requests ORDER BY nonce")
      .all();
    const candidateRows = candidates
      ? db
          .prepare(
            "SELECT set_id,version,body,body_hash FROM quality_candidate_versions ORDER BY set_id,version",
          )
          .all()
      : [];
    const candidateReceipts = candidates
      ? db
          .prepare("SELECT nonce,body,body_hash FROM quality_candidate_requests ORDER BY nonce")
          .all()
      : [];
    const executionRows = executions
      ? db.prepare("SELECT id,body,body_hash FROM quality_execution_runs ORDER BY id").all()
      : [];
    const executionEvents = executions
      ? db
          .prepare(
            "SELECT run_id,revision,body,body_hash FROM quality_execution_events ORDER BY run_id,revision",
          )
          .all()
      : [];
    const executionReceipts = executions
      ? db
          .prepare("SELECT nonce,body,body_hash FROM quality_execution_requests ORDER BY nonce")
          .all()
      : [];
    const policyRows = policies
      ? db
          .prepare(
            "SELECT rowid AS storage_order,scope_id,revision,nonce,body,body_hash FROM quality_provider_policies ORDER BY rowid",
          )
          .all()
      : [];
    const reservationRows = reservations ? readProviderReservationDatabaseRows(db) : null;
    const transmissionRows = transmissions
      ? readProviderTransmissionApprovalDatabaseRows(db)
      : null;
    const actualRows = {
      budget: actual
        ? db
            .prepare(
              "SELECT scope_id,revision,body,body_hash FROM quality_actual_budget_events ORDER BY scope_id,revision",
            )
            .all()
        : [],
      runs: actual
        ? db.prepare("SELECT id,body,body_hash FROM quality_actual_runs ORDER BY id").all()
        : [],
      runOrder: actual
        ? db
            .prepare("SELECT rowid AS storage_order,id FROM quality_actual_runs ORDER BY rowid")
            .all()
        : [],
      events: actual
        ? db
            .prepare(
              "SELECT run_id,revision,body,body_hash FROM quality_actual_events ORDER BY run_id,revision",
            )
            .all()
        : [],
      artifacts: actual
        ? db
            .prepare(
              "SELECT run_id,artifact_key,payload,sha256,size_bytes FROM quality_actual_artifacts ORDER BY run_id,artifact_key",
            )
            .all()
        : [],
      receipts: actual
        ? db
            .prepare("SELECT nonce,body,body_hash FROM quality_actual_requests ORDER BY nonce")
            .all()
        : [],
    };
    if (
      runRows.length > 20 ||
      revisionRows.length > 4000 ||
      receiptRows.length !== runRows.length + revisionRows.length
    )
      fail("QUALITY_DATABASE_LIMIT");
    let total = 0;
    const runs = new Map(),
      receipts = new Map();
    for (const row of receiptRows) {
      total += Buffer.byteLength(row.body);
      const item = decode(row, 1024);
      if (
        !uuid.safeParse(item.clientRequestId).success ||
        row.nonce !== item.clientRequestId ||
        !uuid.safeParse(item.runId).success ||
        !["create", "record"].includes(item.kind) ||
        !Number.isInteger(item.revision) ||
        item.revision < 0 ||
        item.revision > 200 ||
        !hash.safeParse(item.inputDigest).success
      )
        fail("QUALITY_DATABASE_INVALID");
      receipts.set(row.nonce, item);
    }
    for (const row of runRows) {
      total += Buffer.byteLength(row.body);
      const run = decode(row, 8 * 1024 * 1024);
      if (
        !uuid.safeParse(run.id).success ||
        run.id !== row.id ||
        !uuid.safeParse(run.clientRequestId).success ||
        typeof run.title !== "string" ||
        run.title.length < 1 ||
        run.title.length > 120 ||
        !z.string().datetime().safeParse(run.createdAt).success ||
        !Array.isArray(run.manifest) ||
        run.manifest.length !== 50 ||
        !Array.isArray(run.fixtures) ||
        run.fixtures.length !== 50 ||
        digest(run.manifest) !== run.manifestDigest ||
        new Set(run.manifest.map((v) => v.fixtureId)).size !== 50 ||
        new Set(run.fixtures.map((v) => v.id)).size !== 50
      )
        fail("QUALITY_DATABASE_INVALID");
      for (const entry of run.manifest) {
        const fixture = run.fixtures.find((v) => v.id === entry.fixtureId);
        if (
          !fixture ||
          fixture.synthetic !== true ||
          entry.synthetic !== true ||
          fixture.label !== entry.label ||
          digest({ profile: fixture.profile, sources: fixture.sources }) !== entry.sourceDigest ||
          digest(fixture.candidate) !== entry.candidateDigest ||
          digest(fixture.plan) !== entry.inputPlanDigest ||
          digest({
            deterministic: fixture.deterministicExpectation,
            semantic: fixture.semanticRubric,
          }) !== entry.rubricDigest
        )
          fail("QUALITY_DATABASE_INVALID");
      }
      const receipt = receipts.get(run.clientRequestId);
      if (
        !receipt ||
        receipt.kind !== "create" ||
        receipt.runId !== run.id ||
        receipt.revision !== 0 ||
        receipt.inputDigest !==
          digest({
            kind: "create",
            input: {
              clientRequestId: run.clientRequestId,
              title: run.title,
              manifestDigest: run.manifestDigest,
            },
          })
      )
        fail("QUALITY_DATABASE_INVALID");
      receipts.delete(run.clientRequestId);
      runs.set(run.id, { run, revision: 0, fixtureVersions: new Map() });
    }
    for (const row of revisionRows) {
      total += Buffer.byteLength(row.body);
      const item = decode(row, 512 * 1024 + 4096),
        parent = runs.get(row.run_id);
      if (
        !parent ||
        !item.record ||
        item.runId !== row.run_id ||
        item.revision !== row.revision ||
        item.revision !== parent.revision + 1 ||
        item.revision > 200 ||
        item.record.schemaVersion !== 1 ||
        item.recordDigest !== digest(item.record) ||
        item.fixtureRevision !== (parent.fixtureVersions.get(item.record.fixtureId) ?? 0) + 1 ||
        !z.string().datetime().safeParse(item.recordedAt).success
      )
        fail("QUALITY_DATABASE_INVALID");
      const entry = parent.run.manifest.find((v) => v.fixtureId === item.record.fixtureId);
      if (
        !entry ||
        ["sourceDigest", "candidateDigest", "inputPlanDigest", "rubricDigest"].some(
          (key) => entry[key] !== item.record[key],
        )
      )
        fail("QUALITY_DATABASE_INVALID");
      const receipt = receipts.get(item.clientRequestId);
      if (
        !receipt ||
        receipt.kind !== "record" ||
        receipt.runId !== item.runId ||
        receipt.revision !== item.revision ||
        receipt.inputDigest !== item.inputDigest ||
        item.inputDigest !==
          digest({
            kind: "record",
            runId: item.runId,
            input: {
              revision: item.revision - 1,
              clientRequestId: item.clientRequestId,
              record: item.record,
            },
          })
      )
        fail("QUALITY_DATABASE_INVALID");
      receipts.delete(item.clientRequestId);
      parent.revision = item.revision;
      parent.fixtureVersions.set(item.record.fixtureId, item.fixtureRevision);
    }
    const candidateVerification = inspectCandidateRows(
      candidateRows,
      candidateReceipts,
      new Set(receiptRows.map((row) => row.nonce)),
    );
    total += candidateVerification.total;
    total += inspectExecutionRows(
      executionRows,
      executionEvents,
      executionReceipts,
      candidateVerification.bindings,
      new Set([...receiptRows, ...candidateReceipts].map((row) => row.nonce)),
    );
    const actualVerification = actual
      ? inspectActualRows(
          actualRows,
          candidateRows.map((row) => decode(row, 8 * 1024 * 1024)),
          new Set(
            [...receiptRows, ...candidateReceipts, ...executionReceipts].map((row) => row.nonce),
          ),
          storageVersion,
          policyRows,
          reservationRows,
          transmissionRows,
        )
      : { total: 0, reservedBytes: 0 };
    total += actualVerification.total;
    if (total + actualVerification.reservedBytes > 256 * 1024 * 1024)
      fail("QUALITY_DATABASE_LIMIT");
    if (receipts.size || total > 256 * 1024 * 1024) fail("QUALITY_DATABASE_INVALID");
    // Hash each bounded row separately instead of materializing a second full database JSON.
    const logicalHash = createHash("sha256").update(digest(schema));
    for (const [name, rows] of [
      ["runs", runRows],
      ["revisions", revisionRows],
      ["receipts", receiptRows],
      ...(candidates
        ? [
            ["candidateVersions", candidateRows],
            ["candidateReceipts", candidateReceipts],
          ]
        : []),
      ...(executions
        ? [
            ["executionRuns", executionRows],
            ["executionEvents", executionEvents],
            ["executionReceipts", executionReceipts],
          ]
        : []),
      ...(actual
        ? [
            ["actualBudgetEvents", actualRows.budget],
            ["actualRuns", actualRows.runs],
            ["actualEvents", actualRows.events],
            // Raw BLOB SHA has already been recomputed; avoid expanding each byte into JSON keys.
            [
              "actualArtifacts",
              actualRows.artifacts.map(({ run_id, artifact_key, sha256, size_bytes }) => ({
                run_id,
                artifact_key,
                sha256,
                size_bytes,
              })),
            ],
            ["actualReceipts", actualRows.receipts],
            ...(storageVersion >= 5 ? [["actualRunInsertionOrder", actualRows.runOrder]] : []),
          ]
        : []),
      ...(policies ? [["providerPolicies", policyRows]] : []),
      ...(reservations
        ? [
            ["providerReservationBindings", reservationRows.bindingRows],
            ["providerReservationCoverage", reservationRows.coverageRows],
          ]
        : []),
      ...(transmissions
        ? [
            ["providerTransmissionBindings", transmissionRows.bindingRows],
            ["providerTransmissionCoverage", transmissionRows.coverageRows],
          ]
        : []),
    ]) {
      logicalHash.update(String(name)).update("\0");
      for (const row of rows) logicalHash.update(digest(row));
    }
    const result = {
      storageVersion,
      ...(transmissions
        ? {
            providerTransmissionBindings: transmissionRows.bindingRows.length,
            providerTransmissionCoverage: transmissionRows.coverageRows.length,
          }
        : {}),
      ...(policies ? { providerPolicies: policyRows.length } : {}),
      ...(reservations
        ? {
            providerReservationBindings: reservationRows.bindingRows.length,
            providerReservationCoverage: reservationRows.coverageRows.length,
          }
        : {}),
      digest: logicalHash.digest("hex"),
      runs: runRows.length,
      revisions: revisionRows.length,
      requests: receiptRows.length,
      ...(candidates
        ? { candidateVersions: candidateRows.length, candidateRequests: candidateReceipts.length }
        : {}),
      ...(executions
        ? {
            executionRuns: executionRows.length,
            executionEvents: executionEvents.length,
            executionRequests: executionReceipts.length,
          }
        : {}),
      ...(actual
        ? {
            actualBudgetEvents: actualRows.budget.length,
            actualRuns: actualRows.runs.length,
            actualEvents: actualRows.events.length,
            actualArtifacts: actualRows.artifacts.length,
            actualRequests: actualRows.receipts.length,
          }
        : {}),
    };
    if (!inTransaction) db.exec("COMMIT");
    return {
      snapshot: result,
      ledger: actualVerification.ledgerInput,
      usage: { usedBytes: total, reservedBytes: actualVerification.reservedBytes },
    };
  } catch (error) {
    if (!inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
/** Caller owns BEGIN IMMEDIATE and rollback on failure. Never rewrites historical row bytes.
 * Full v1-v7 audit precedes cutover capture; a v8 store never synthesizes missing coverage.
 */
export function migrateQualitySchemaV8(db) {
  if (!db.isTransaction) fail("QUALITY_TRANSACTION_REQUIRED");
  const before = inspectQualitySchema(db, { allowEmpty: true });
  if (before.version > 8) fail("QUALITY_SCHEMA_UNSUPPORTED");
  if (before.version === 8) {
    db.function("quality_storage_contract", { deterministic: true }, () => "quality-v8");
    inspectQualityDatabase(db, { inTransaction: true });
    return before;
  }
  // Validate under the original contract before upgrading, including legacy envelope limits.
  if (before.version) inspectQualityDatabase(db, { inTransaction: true });
  migrateQualitySchemaV7(db);
  const verified = auditQualityDatabase(db, { inTransaction: true });
  const coverage = createProviderReservationMigrationCoverage(verified.ledger);
  for (const [table, sql] of Object.entries(qualityReservationTableSql)) {
    db.exec(sql);
    for (const action of ["update", "delete"])
      db.exec(qualityV8ImmutableTriggerSql[`${table}_no_${action}`]);
  }
  for (const name of Object.keys(qualityV7WriterTriggerSql)) db.exec(`DROP TRIGGER ${name}`);
  db.function("quality_storage_contract", { deterministic: true }, () => "quality-v8");
  for (const sql of Object.values(qualityV8WriterTriggerSql)) db.exec(sql);
  db.prepare(
    "INSERT INTO quality_provider_reservation_coverage(id,body,body_hash) VALUES(1,?,?)",
  ).run(JSON.stringify(coverage), digest(coverage));
  inspectQualityDatabase(db, { inTransaction: true });
  return inspectQualitySchema(db);
}
/** Full prior-version audit and one-time approval-event cutover in the caller's write transaction.
 * A current v9 database must already contain its original coverage, even when it is empty. */
export function migrateQualitySchemaV9(db) {
  if (!db.isTransaction) fail("QUALITY_TRANSACTION_REQUIRED");
  const before = inspectQualitySchema(db, { allowEmpty: true });
  if (before.version === 9) {
    db.function("quality_storage_contract", { deterministic: true }, () => "quality-v9");
    inspectQualityDatabase(db, { inTransaction: true });
    return before;
  }
  migrateQualitySchemaV8(db);
  const verified = auditQualityDatabase(db, { inTransaction: true });
  const reservation = readProviderReservationDatabaseRows(db);
  const coverage = createProviderTransmissionApprovalMigrationCoverage({
    ledger: verified.ledger,
    coverage: reservation.coverage,
    records: reservation.records,
  });
  for (const [table, sql] of Object.entries(qualityTransmissionApprovalTableSql)) {
    db.exec(sql);
    for (const action of ["update", "delete"])
      db.exec(qualityV9ImmutableTriggerSql[`${table}_no_${action}`]);
  }
  for (const name of Object.keys(qualityV8WriterTriggerSql)) db.exec(`DROP TRIGGER ${name}`);
  db.function("quality_storage_contract", { deterministic: true }, () => "quality-v9");
  for (const sql of Object.values(qualityV9WriterTriggerSql)) db.exec(sql);
  db.prepare(
    "INSERT INTO quality_provider_transmission_coverage(id,body,body_hash) VALUES(1,?,?)",
  ).run(JSON.stringify(coverage), digest(coverage));
  inspectQualityDatabase(db, { inTransaction: true });
  return inspectQualitySchema(db);
}
function open(file) {
  secureFile(file);
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000");
  return db;
}
export function inspectQualityFile(file) {
  const before = secureFile(file),
    db = open(file);
  try {
    const result = inspectQualityDatabase(db);
    if (!sameIdentity(before, secureFile(file))) fail("QUALITY_PATH_CHANGED");
    return result;
  } finally {
    db.close();
  }
}
export function verifyQualityBackup(source) {
  const root = path.resolve(source),
    identity = safePath(root, "directory");
  if (readdirSync(root).sort().join("|") !== [fileName, manifestName, markerName].sort().join("|"))
    fail("QUALITY_BACKUP_FILES_INVALID");
  nativePaths([root, ...[fileName, manifestName, markerName].map((v) => path.join(root, v))]);
  const bytes = readSafe(path.join(root, manifestName), 8192, null, true).bytes;
  let manifest, marker;
  try {
    manifest = manifestSchema.parse(JSON.parse(bytes));
    marker = markerSchema.parse(
      JSON.parse(readSafe(path.join(root, markerName), 1024, null, true).bytes),
    );
  } catch {
    fail("QUALITY_MANIFEST_INVALID");
  }
  if (marker.manifestSha256 !== sha(bytes)) fail("QUALITY_MANIFEST_INVALID");
  const file = path.join(root, fileName);
  sameFile(readSafe(file, maxBytes), manifest.file);
  const snapshot = inspectQualityFile(file);
  if (
    snapshot.storageVersion !== manifest.version ||
    snapshot.digest !== manifest.logicalDigest ||
    snapshot.runs !== manifest.runs ||
    snapshot.revisions !== manifest.revisions ||
    snapshot.requests !== manifest.requests ||
    manifest.version >= 2 !== Object.hasOwn(snapshot, "candidateVersions") ||
    manifest.version >= 3 !== Object.hasOwn(snapshot, "executionRuns") ||
    manifest.version >= 4 !== Object.hasOwn(snapshot, "actualRuns") ||
    manifest.version >= 7 !== Object.hasOwn(snapshot, "providerPolicies") ||
    (manifest.version >= 7 && snapshot.providerPolicies !== manifest.providerPolicies) ||
    manifest.version >= 8 !== Object.hasOwn(snapshot, "providerReservationBindings") ||
    manifest.version >= 8 !== Object.hasOwn(snapshot, "providerReservationCoverage") ||
    (manifest.version >= 8 &&
      (snapshot.providerReservationBindings !== manifest.providerReservationBindings ||
        snapshot.providerReservationCoverage !== manifest.providerReservationCoverage)) ||
    manifest.version >= 9 !== Object.hasOwn(snapshot, "providerTransmissionBindings") ||
    manifest.version >= 9 !== Object.hasOwn(snapshot, "providerTransmissionCoverage") ||
    (manifest.version >= 9 &&
      (snapshot.providerTransmissionBindings !== manifest.providerTransmissionBindings ||
        snapshot.providerTransmissionCoverage !== manifest.providerTransmissionCoverage)) ||
    (manifest.version >= 2 &&
      (snapshot.candidateVersions !== manifest.candidateVersions ||
        snapshot.candidateRequests !== manifest.candidateRequests)) ||
    (manifest.version >= 3 &&
      (snapshot.executionRuns !== manifest.executionRuns ||
        snapshot.executionEvents !== manifest.executionEvents ||
        snapshot.executionRequests !== manifest.executionRequests)) ||
    (manifest.version >= 4 &&
      (snapshot.actualBudgetEvents !== manifest.actualBudgetEvents ||
        snapshot.actualRuns !== manifest.actualRuns ||
        snapshot.actualEvents !== manifest.actualEvents ||
        snapshot.actualArtifacts !== manifest.actualArtifacts ||
        snapshot.actualRequests !== manifest.actualRequests))
  )
    fail("QUALITY_DATABASE_CHANGED");
  sameFile(readSafe(file, maxBytes), manifest.file);
  if (
    sha(readSafe(path.join(root, manifestName), 8192, null, true).bytes) !==
      marker.manifestSha256 ||
    JSON.stringify(
      markerSchema.parse(JSON.parse(readSafe(path.join(root, markerName), 1024, null, true).bytes)),
    ) !== JSON.stringify(marker)
  )
    fail("QUALITY_BACKUP_CHANGED");
  unchangedRoot(root, identity);
  return { manifest, snapshot };
}
export async function backupQualityData(source, destination) {
  const root = path.resolve(source),
    qualityRoot = path.join(root, "quality-evaluation"),
    file = path.join(qualityRoot, fileName);
  safePath(root, "directory");
  const sourceIdentity = safePath(qualityRoot, "directory"),
    fileIdentity = secureFile(file);
  if (existsSync(path.join(qualityRoot, pendingName))) fail("QUALITY_RESTORE_PENDING");
  const db = open(file);
  let target, markerIdentity;
  const assertSource = (snapshot) => {
    unchangedRoot(qualityRoot, sourceIdentity);
    if (!sameIdentity(fileIdentity, secureFile(file))) fail("QUALITY_PATH_CHANGED");
    sameSnapshot(snapshot, inspectQualityDatabase(db));
    sameSnapshot(snapshot, inspectQualityFile(file));
  };
  try {
    const snapshot = inspectQualityDatabase(db);
    target = createDestination(root, destination);
    const targetIdentity = safePath(target, "directory");
    const targetFile = path.join(target, fileName);
    writeNew(targetFile, Buffer.alloc(0));
    const outputIdentity = safePath(targetFile);
    nativePaths([targetFile]);
    const deadline = Date.now() + 120000;
    await backup(db, targetFile, {
      rate: 100,
      progress: () => {
        if (Date.now() > deadline) fail("BACKUP_TIMEOUT");
      },
    });
    unchangedRoot(target, targetIdentity);
    if (!sameIdentity(outputIdentity, safePath(targetFile))) fail("QUALITY_PATH_CHANGED");
    const normalized = new DatabaseSync(targetFile, { allowExtension: false });
    try {
      normalized.exec("PRAGMA journal_mode=DELETE");
    } finally {
      normalized.close();
    }
    sameSnapshot(snapshot, inspectQualityFile(targetFile));
    assertSource(snapshot);
    const manifest = manifestSchema.parse({
      format: "venturepass-quality-backup",
      version: snapshot.storageVersion,
      createdAt: new Date().toISOString(),
      logicalDigest: snapshot.digest,
      ...snapshotCounts(snapshot),
      file: { name: fileName, ...readSafe(targetFile, maxBytes) },
    });
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    writeNew(path.join(target, manifestName), bytes);
    nativePaths([target, targetFile, path.join(target, manifestName)]);
    unchangedRoot(target, targetIdentity);
    writeNew(
      path.join(target, markerName),
      Buffer.from(
        JSON.stringify({
          format: "venturepass-quality-backup-complete",
          manifestSha256: sha(bytes),
        }),
      ),
    );
    markerIdentity = safePath(path.join(target, markerName));
    verifyQualityBackup(target);
    assertSource(snapshot);
    return snapshotCounts(snapshot);
  } catch (error) {
    if (target && markerIdentity) {
      const marker = path.join(target, markerName);
      if (sameIdentity(markerIdentity, safePath(marker))) unlinkSync(marker);
    }
    throw error;
  } finally {
    db.close();
  }
}
export function restoreQualityData(source, destination) {
  const sourceRoot = path.resolve(source),
    targetRoot = path.resolve(destination),
    before = verifyQualityBackup(sourceRoot);
  const parentIdentity = safePath(targetRoot, "directory"),
    target = path.join(targetRoot, "quality-evaluation");
  if (within(targetRoot, sourceRoot) || within(sourceRoot, targetRoot)) fail("DESTINATION_OVERLAP");
  nativePaths([targetRoot]);
  if (existsSync(target)) fail("QUALITY_DESTINATION_EXISTS");
  const stage = createDestination(
    sourceRoot,
    path.join(targetRoot, `quality-restore-${randomUUID()}`),
  );
  const stageIdentity = safePath(stage, "directory");
  let published = false,
    pendingIdentity,
    fileIdentity;
  try {
    writeNew(
      path.join(stage, pendingName),
      Buffer.from("venturepass-quality-restore-in-progress\n"),
    );
    pendingIdentity = safePath(path.join(stage, pendingName));
    sameFile(
      readSafe(
        path.join(sourceRoot, fileName),
        maxBytes,
        path.join(stage, fileName),
        false,
        (identity) => {
          fileIdentity = identity;
        },
      ),
      before.manifest.file,
    );
    fileIdentity = safePath(path.join(stage, fileName));
    sameSnapshot(before.snapshot, inspectQualityFile(path.join(stage, fileName)));
    if (
      JSON.stringify(verifyQualityBackup(sourceRoot).manifest) !== JSON.stringify(before.manifest)
    )
      fail("QUALITY_BACKUP_CHANGED");
    unchangedRoot(targetRoot, parentIdentity);
    unchangedRoot(stage, stageIdentity);
    nativePaths([stage, path.join(stage, fileName), path.join(stage, pendingName), targetRoot]);
    if (existsSync(target)) fail("QUALITY_DESTINATION_EXISTS");
    // Same-volume directory rename publishes the already verified database in one step.
    renameSync(stage, target);
    published = true;
    unchangedRoot(target, stageIdentity);
    unchangedRoot(targetRoot, parentIdentity);
    sameSnapshot(before.snapshot, inspectQualityFile(path.join(target, fileName)));
    if (!sameIdentity(pendingIdentity, safePath(path.join(target, pendingName))))
      fail("QUALITY_PATH_CHANGED");
    nativePaths([target, path.join(target, pendingName)]);
    unlinkSync(path.join(target, pendingName));
    return snapshotCounts(before.snapshot);
  } catch (error) {
    // Before publication, delete only this invocation's fixed files in its unchanged private directory.
    // After publication, keep the pending marker: the app refuses an unverified restoration.
    if (!published) {
      unchangedRoot(stage, stageIdentity);
      nativePaths([stage]);
      for (const [name, identity] of [
        [fileName, fileIdentity],
        [pendingName, pendingIdentity],
      ]) {
        const file = path.join(stage, name);
        if (identity && existsSync(file)) {
          if (!sameIdentity(identity, safePath(file))) fail("QUALITY_PATH_CHANGED");
          unlinkSync(file);
        }
      }
      if (readdirSync(stage).length === 0) rmdirSync(stage);
    }
    throw error;
  }
}
