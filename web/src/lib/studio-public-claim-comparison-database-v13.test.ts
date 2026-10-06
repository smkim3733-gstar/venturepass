import * as storedRead32 from "./studio-public-claim-comparison-stored-read";
import { ownedComparisonCompanyGuard } from "./studio-comparison-company-capability";
import { preparePublicClaimComparison } from "./studio-public-claim-comparison";
import {
  comparisonDispatchV2CommandSchema,
  createComparisonTransmissionV2Review,
  createComparisonPostcapturePreview,
  inspectComparisonTransmissionV4State,
  comparisonResultCommandSchema,
  comparisonCloseCommandSchema,
} from "./studio-public-claim-comparison-transmission-v4";
import { comparisonUsagePolicySchema } from "./studio-public-claim-comparison-usage";
import {
  comparisonTransmissionBasisSchema,
  comparisonTransmissionNotice,
  comparisonDispatchCommandSchema,
  comparisonUnknownCommandSchema,
  comparisonCaptureCommandSchema,
  createComparisonTransmissionReview,
} from "./studio-public-claim-comparison-transmission";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { captureProviderResponse } from "../../scripts/local-data-quality-provider-usage.mjs";
import { comparisonSha as sha } from "./studio-public-claim-comparison-financial";
import { publicClaimComparisonRequestPins } from "./studio-public-claim-comparison-request-types";
import * as transmissionRows from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import * as journalIO from "../../scripts/local-journal-io.mjs";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { StudioStore } from "./studio-storage";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { readPublicComparisonPrefix } from "./studio-public-claim-comparison-prefix-test-helpers";
import { createPublicComparisonCoverage } from "./studio-public-claim-comparison-budget";
import { migratePublicComparisonDatabaseV10 } from "./studio-public-claim-comparison-database";
import {
  migratePublicComparisonDatabaseV11,
  reserveGuardedPublicComparison,
  initializePublicComparisonStorageWitness,
  inspectPublicComparisonDatabaseV12,
  migrateGuardedPublicComparisonDatabaseV12,
  writeGuardedPublicComparisonV12,
  migrateGuardedPublicComparisonDatabaseV13,
  inspectPublicComparisonDatabaseV13,
  writeGuardedPublicComparisonV13,
  reconcilePublicComparisonStorageWitnessV3,
} from "./studio-public-claim-comparison-database-v11";
import {
  openComparisonStorageSession,
  closeComparisonStorageSession,
  beginComparisonStorageSession,
  endComparisonStorageSession,
  requireComparisonWitnessCapacity,
} from "./studio-public-comparison-storage-witness";
import {
  comparisonCancelCommandSchema,
  type ComparisonReservationState,
} from "./studio-public-claim-comparison-reservation";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { comparisonReservationTestFixture } from "./studio-public-claim-comparison-reservation-test-helpers";
import { createIsolatedPublicComparisonExecution, createIsolatedPublicComparisonService } from "./studio-public-claim-comparison-database-v11";
import { endComparisonCompanyRead } from "./studio-public-comparison-company-guard";
import {
  createSyntheticComparisonDriver,
  requireSyntheticComparisonDriver,
  comparisonSyntheticWireKey,
  type PublicComparisonTransportBoundary,
  type SyntheticComparisonHooks,
} from "./studio-public-claim-comparison-transport";
import {
  createSyntheticComparisonSdkDriver,
  type SyntheticComparisonSdkOptions,
} from "./studio-public-claim-comparison-sdk-adapter";
import * as storageWitness22 from "./studio-public-comparison-storage-witness";
import * as companyGuard22 from "./studio-public-comparison-company-guard";
import * as databaseRows22 from "./studio-public-claim-comparison-database-rows";
vi.mock("server-only", () => ({}));
vi.mock("openai/error", () => {
  class APIError extends Error {}
  return {
    APIError,
    APIConnectionError: class extends APIError {},
    APIConnectionTimeoutError: class extends APIError {},
    APIUserAbortError: class extends APIError {},
  };
});
vi.mock(
  "./studio-plan-quality-provider-configuration-current",
  () => import("./studio-plan-quality-provider-configuration-20260927-test-fixture"),
);
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("external/customer I/O forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
const selection = {
  databaseInstanceId: "4900300f-313a-4114-bbf5-5b0d33b7c824",
  environment: "production" as const,
  scopeId: "candidate-quality-provider-v2-live" as const,
};
let directory: string, base11: string;
let fixture: ReturnType<typeof comparisonReservationTestFixture>;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-comparison-v13-"));
  const store = new PlanQualityStore(join(directory, "base"), {
    providerEnvironment: "synthetic-test",
  });
  try {
    store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const f = await finalizationStoreFixture(store);
    store.providerRecordFinalization(f.identity);
  } finally {
    store.close();
  }
  base11 = join(directory, "base11.sqlite");
  copyFileSync(join(directory, "base", "quality-evaluation", "quality.sqlite"), base11);
  const db = new DatabaseSync(base11);
  try {
    const prefix = readPublicComparisonPrefix(db),
      coverage = createPublicComparisonCoverage(prefix);
    migratePublicComparisonDatabaseV10(db, selection, coverage);
    const migrated = migratePublicComparisonDatabaseV11(db, selection, coverage);
    fixture = comparisonReservationTestFixture(migrated.inspection.inspection.state);
  } finally {
    db.close();
  }
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
}, 30000);
afterAll(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (directory) {
    const r = relative(resolve(tmpdir()), resolve(directory));
    if (!r.startsWith("venture-comparison-v13-") || r.includes("..")) throw Error("unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
function current() {
  return {
    company: structuredClone(fixture.company),
    evidence: structuredClone(fixture.evidence),
    approvedReview: structuredClone(fixture.review),
    at: fixture.at,
    runId: randomUUID(),
    eventId: randomUUID(),
    budgetEventId: randomUUID(),
  };
}
function cancelCommand(s: ComparisonReservationState) {
  const b = s.bindings.at(-1)!,
    e = s.archive.records.events.filter((x) => x.runId === b.runId).at(-1)!,
    budget = s.archive.financial.events.at(-1)!;
  return comparisonCancelCommandSchema.parse({
    commandVersion: 1,
    kind: "cancel-public-claim-comparison",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    expectedBindingDigest: b.recordDigest,
    reservationDigest: b.budgetEventDigest,
    expectedRunHead: { revision: e.revision, headDigest: e.eventDigest },
    expectedBudgetHead: { revision: budget.revision, headDigest: budget.eventDigest },
  });
}
function cancelCurrent() {
  return {
    at: "2026-10-05T13:00:00.000Z",
    eventId: randomUUID(),
    budgetEventId: randomUUID(),
    finalEventId: randomUUID(),
    finalizationNonce: randomUUID(),
  };
}
function snapshot(db: DatabaseSync) {
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  const rows = Object.fromEntries(
    schema
      .filter((r) => r.type === "table")
      .map((r) => [
        String(r.name),
        db.prepare("SELECT rowid AS original_order,* FROM " + r.name + " ORDER BY rowid").all(),
      ]),
  );
  return { schema, rows };
}
function injectInsert(db: DatabaseSync, n: number) {
  const original = db.prepare.bind(db);
  let count = 0;
  return vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("INSERT INTO ") && ++count === n) throw Error("injected insert failure");
    return original(sql);
  });
}

function guarded(enroll = true) {
  const root = join(directory, randomUUID()),
    data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const qualityFile = join(data, "quality.sqlite");
  copyFileSync(base11, qualityFile);
  const studio = new StudioStore(data);
  const companyDb = new DatabaseSync(join(data, "studio.sqlite"));
  companyDb
    .prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)")
    .run(fixture.company.id, fixture.company.revision, 0, JSON.stringify(fixture.company));
  companyDb.exec("PRAGMA busy_timeout=30");
  const cap = studio.comparisonCompanyGuard();
  const paths = {
    dataRoot: data,
    qualityFile,
    studioFile: join(data, "studio.sqlite"),
    controlDirectory: join(root, "control"),
  };
  const session = openComparisonStorageSession(paths, selection);
  const internal = beginComparisonStorageSession(session);
  const db = internal.db;
  endComparisonStorageSession(session);
  const cleanup = () => {
    closeComparisonStorageSession(session);
    companyDb.close();
    studio.close();
  };
  cleanups.push(cleanup);
  if (enroll) initializePublicComparisonStorageWitness(session, cap);
  const supplied = current();
  const { company: _company, ...input } = supplied;
  void _company;
  return { session, cap, paths, studio, companyDb, db, current: { ...input, companyGuard: cap } };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
function reserveGuard(g: ReturnType<typeof guarded>) {
  return reserveGuardedPublicComparison(g.session, fixture.command, g.current);
}
function witnessFiles(g: ReturnType<typeof guarded>) {
  const dirs = [g.paths.controlDirectory, join(g.paths.dataRoot, "comparison-storage-witness")];
  return dirs.map((dir) =>
    readdirSync(dir)
      .sort()
      .map((n) => readFileSync(join(dir, n), "utf8")),
  );
}
function allCompany(db: DatabaseSync) {
  return ["studio_cases", "venture_accounts", "venture_workflows", "studio_prepared_packages"].map(
    (t) => db.prepare("SELECT * FROM " + t).all(),
  );
}

// New multi-transaction SQL + two-copy fsync journeys include several full audits/replays.
// Existing suite timeouts and every production deadline/cap remain unchanged.
const limit = 120000;
const capture = captureProviderResponse({
  id: "synthetic-capture",
  model: "synthetic-model",
  status: "completed",
  output: [],
});
const later = "2026-10-07T10:00:00.000Z";
function state12(g: ReturnType<typeof guarded>) {
  return inspectPublicComparisonDatabaseV12(g.db, selection).transmission!.state;
}
function setup12(reserve = true) {
  const g = guarded();
  if (reserve) reserveGuard(g);
  migrateGuardedPublicComparisonDatabaseV12(g.session);
  return g;
}
function dispatchInput(g: ReturnType<typeof guarded>) {
  const reserved = state12(g),
    at = fixture.at;
  const e = fixture.evidence;
  const basis = comparisonTransmissionBasisSchema.parse({
    kind: "public-comparison-transmission-basis",
    basisVersion: 1,
    purpose: e.purpose,
    provenance: e.provenance,
    model: e.model,
    requestVersion: e.requestVersion,
    contractDigest: e.contractDigest,
    destination: e.destination,
    store: false,
    requestedTier: null,
    maxCalls: 1,
    automaticRetryLimit: 0,
    maxOutputTokens: 16000,
    omissions: e.omissions,
    sources: e.sources,
    method: "POST",
    strict: true,
    schemaDigest: publicClaimComparisonRequestPins.schemaDigest,
    financialBasisDigest: fixture.review.financialBasis.basisDigest,
    retentionNoticeDigest: fixture.review.retentionNoticeDigest,
    notice: { ...comparisonTransmissionNotice, noticeDigest: digest(comparisonTransmissionNotice) },
  });
  const review = createComparisonTransmissionReview(
    reserved,
    fixture.company,
    reserved.reservation.archive.records.runs.at(-1)!.id,
    basis,
    at,
  );
  const command = comparisonDispatchCommandSchema.parse({
    commandVersion: 1,
    kind: "approve-dispatch-public-claim-comparison",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: review.runId,
    runDigest: review.runDigest,
    expectedReservationBindingDigest: review.reservationBindingDigest,
    approvedReviewDigest: review.reviewDigest,
    expectedTransmissionArchiveDigest: review.transmissionArchiveDigest,
    expectedCoverageDigest: review.coverageDigest,
    expectedRunHead: review.runHead,
    expectedBudgetHead: { revision: review.budget.revision, headDigest: review.budget.headDigest },
    approval: {
      noticeVersion: 1,
      noticeDigest: basis.notice.noticeDigest,
      retentionNoticeDigest: review.retentionNoticeDigest,
      exactRequestIdentityDigest: digest(review.identity),
      approvedAt: at,
      expiresAt: review.expiresAt,
      externalTransmissionAcknowledged: true,
      comparisonPurposeAcknowledged: true,
      singleCallAcknowledged: true,
      noAutomaticRetryAcknowledged: true,
      unknownCostHoldAcknowledged: true,
      noResendAcknowledged: true,
      localRetentionAcknowledged: true,
    },
  });

  return {
    command,
    current: { companyGuard: g.cap, approvedReview: review, basis, at, eventId: randomUUID() },
  };
}
function dispatch(g: ReturnType<typeof guarded>) {
  const input = dispatchInput(g);
  return {
    input,
    result: writeGuardedPublicComparisonV12(
      g.session,
      "approve-dispatch",
      input.command,
      input.current,
    ),
  };
}
function continuation(g: ReturnType<typeof guarded>, kind: "unknown" | "capture") {
  const s = state12(g),
    b = s.transmissionBindings[0],
    e = s.reservation.archive.records.events.at(-1)!;
  const base = {
    commandVersion: 1,
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    expectedRunHead: { revision: e.revision, headDigest: e.eventDigest },
  };
  return kind === "unknown"
    ? comparisonUnknownCommandSchema.parse({
        ...base,
        kind: "mark-public-comparison-unknown",
        reason: "transport-unknown",
      })
    : comparisonCaptureCommandSchema.parse({
        ...base,
        kind: "persist-public-comparison-capture",
        responseArtifactSha256: sha(JSON.stringify(capture)),
        sizeBytes: Buffer.byteLength(JSON.stringify(capture)),
      });
}
function mark(g: ReturnType<typeof guarded>) {
  const c = continuation(g, "unknown");
  return {
    command: c,
    result: writeGuardedPublicComparisonV12(g.session, "mark-unknown", c, {
      at: later,
      eventId: randomUUID(),
    }),
  };
}
function save(g: ReturnType<typeof guarded>) {
  const c = continuation(g, "capture");
  return {
    command: c,
    result: writeGuardedPublicComparisonV12(g.session, "persist-capture", c, {
      at: later,
      eventId: randomUUID(),
      capture,
    }),
  };
}
function explode() {
  return Object.defineProperty({}, "at", {
    enumerable: true,
    get() {
      throw Error("current read");
    },
  });
}
const bad = "f".repeat(64);
const response = captureProviderResponse({
  id: "v13-synthetic",
  model: "synthetic-model",
  status: "completed",
  service_tier: "default",
  usage: {
    input_tokens: 20,
    output_tokens: 10,
    total_tokens: 30,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 2 },
  },
  output: [],
});
function state13(g: ReturnType<typeof guarded>) {
  return inspectPublicComparisonDatabaseV13(g.db, selection).transmission!.state;
}
function setup13(reserve = true) {
  const g = setup12(reserve);
  migrateGuardedPublicComparisonDatabaseV13(g.session);
  return g;
}
function input13(g: ReturnType<typeof guarded>) {
  const s = state13(g),
    e = fixture.evidence,
    at = fixture.at;
  const basis = comparisonTransmissionBasisSchema.parse({
    kind: "public-comparison-transmission-basis",
    basisVersion: 1,
    purpose: e.purpose,
    provenance: e.provenance,
    model: e.model,
    requestVersion: e.requestVersion,
    contractDigest: e.contractDigest,
    destination: e.destination,
    store: false,
    requestedTier: null,
    maxCalls: 1,
    automaticRetryLimit: 0,
    maxOutputTokens: 16000,
    omissions: e.omissions,
    sources: e.sources,
    method: "POST",
    strict: true,
    schemaDigest: publicClaimComparisonRequestPins.schemaDigest,
    financialBasisDigest: fixture.review.financialBasis.basisDigest,
    retentionNoticeDigest: fixture.review.retentionNoticeDigest,
    notice: { ...comparisonTransmissionNotice, noticeDigest: digest(comparisonTransmissionNotice) },
  });
  const policy = comparisonUsagePolicySchema.parse({
    policyVersion: 1,
    kind: "public-comparison-usage-policy",
    purpose: e.purpose,
    provenance: e.provenance,
    financialBasisDigest: basis.financialBasisDigest,
    requestIdentityDigest: digest(fixture.request.identity),
    contractDigest: e.contractDigest,
    configuredModel: e.model,
    requestedTier: null,
    maxCalls: 1,
    automaticRetryLimit: 0,
    maxOutputTokens: 16000,
    currency: e.pricing.currency,
    unitScale: e.pricing.unitScale,
    omissionsDigest: digest(e.omissions),
    responseModels: [e.model],
    responseTiers: ["default"],
    modelMappingBasis: "Synthetic explicit model only.",
    tierCoverageBasis: "Synthetic omitted tier mapping only.",
    inputPartition: {
      kind: "disjoint-cache",
      aggregate: "input-includes-cache-read-and-write",
      cacheRead: { kind: "field", path: ["input_tokens_details", "cached_tokens"] },
      cacheWrite: { kind: "not-applicable", basis: "Synthetic no write cache." },
      basis: "Synthetic partition.",
    },
    bandSelection: { kind: "short-only", basis: "Synthetic short context only." },
    outputMeaning: "aggregate-output-includes-reasoning-no-addition",
    authority: {
      sources: e.sources.map((s) => ({ id: s.id, recordDigest: s.recordDigest })),
      reviewedAt: at,
      validUntil: e.sources[0].validUntil,
      explanation: "Synthetic fixture only.",
    },
  });

  const review = createComparisonTransmissionV2Review(
    s,
    fixture.company,
    s.reservation.archive.records.runs.at(-1)!.id,
    basis,
    policy,
    at,
  );
  const command = comparisonDispatchV2CommandSchema.parse({
    commandVersion: 2,
    kind: "approve-dispatch-public-claim-comparison",
    purpose: e.purpose,
    clientRequestId: randomUUID(),
    runId: review.runId,
    runDigest: review.runDigest,
    expectedReservationBindingDigest: review.reservationBindingDigest,
    approvedReviewDigest: review.reviewDigest,
    expectedTransmissionArchiveDigest: review.transmissionArchiveDigest,
    expectedCoverageDigest: review.coverageDigest,
    expectedRunHead: review.runHead,
    expectedBudgetHead: { revision: review.budget.revision, headDigest: review.budget.headDigest },
    usagePolicyDigest: digest(policy),
    approval: {
      noticeVersion: 1,
      noticeDigest: basis.notice.noticeDigest,
      retentionNoticeDigest: review.retentionNoticeDigest,
      exactRequestIdentityDigest: digest(review.identity),
      approvedAt: at,
      expiresAt: review.expiresAt,
      externalTransmissionAcknowledged: true,
      comparisonPurposeAcknowledged: true,
      singleCallAcknowledged: true,
      noAutomaticRetryAcknowledged: true,
      unknownCostHoldAcknowledged: true,
      noResendAcknowledged: true,
      localRetentionAcknowledged: true,
    },
  });
  return {
    command,
    current: {
      companyGuard: g.cap,
      approvedReview: review,
      basis,
      usagePolicy: policy,
      at,
      eventId: randomUUID(),
    },
  };
}
function dispatch13(g: ReturnType<typeof guarded>) {
  const i = input13(g);
  return {
    input: i,
    result: writeGuardedPublicComparisonV13(g.session, "approve-dispatch", i.command, i.current),
  };
}
function baseCommand(g: ReturnType<typeof guarded>) {
  const s = state13(g),
    b = s.transmissionBindings[0],
    e = s.reservation.archive.records.events.at(-1)!;
  return {
    commandVersion: 1,
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    expectedRunHead: { revision: e.revision, headDigest: e.eventDigest },
  };
}
function save13(g: ReturnType<typeof guarded>, value: unknown = response) {
  const capture = captureProviderResponse(value),
    body = JSON.stringify(capture);
  const c = comparisonCaptureCommandSchema.parse({
    ...baseCommand(g),
    kind: "persist-public-comparison-capture",
    responseArtifactSha256: sha(body),
    sizeBytes: Buffer.byteLength(body),
  });
  return {
    command: c,
    result: writeGuardedPublicComparisonV13(g.session, "persist-capture", c, {
      at: later,
      eventId: randomUUID(),
      capture,
    }),
  };
}
function resultInput(g: ReturnType<typeof guarded>) {
  const s = state13(g),
    p = createComparisonPostcapturePreview(s, s.transmissionBindings[0].runId);
  return {
    command: comparisonResultCommandSchema.parse({
      ...baseCommand(g),
      kind: "record-public-comparison-result",
      responseArtifactSha256: p.responseArtifactSha256,
      responseArtifactByteLength: p.responseArtifactByteLength,
      expectedValidatedArtifactSha256: p.expectedValidatedArtifactSha256,
    }),
    current: { at: later, eventId: randomUUID() },
  };
}
function result13(g: ReturnType<typeof guarded>) {
  const i = resultInput(g);
  return {
    input: i,
    result: writeGuardedPublicComparisonV13(g.session, "record-result", i.command, i.current),
  };
}
function closeInput(g: ReturnType<typeof guarded>) {
  const s = state13(g),
    a = inspectComparisonTransmissionV4State(s),
    p = createComparisonPostcapturePreview(s, s.transmissionBindings[0].runId);
  return {
    command: comparisonCloseCommandSchema.parse({
      ...baseCommand(g),
      kind: "settle-finalize-public-comparison",
      responseArtifactSha256: p.responseArtifactSha256,
      comparisonEventDigest: s.reservation.archive.records.events.find(
        (e) => e.payload.kind === "comparison-recorded",
      )!.eventDigest,
      usagePolicyDigest: p.usage.usagePolicyDigest ?? bad,
      expectedAssessmentDigest: p.expectedAssessmentDigest ?? bad,
      expectedBudgetHead: {
        revision: a.reservation.view.native.revision,
        headDigest: a.reservation.view.native.headDigest,
      },
    }),
    current: {
      at: later,
      usageEventId: randomUUID(),
      usageNonce: randomUUID(),
      costEventId: randomUUID(),
      budgetEventId: randomUUID(),
      finalEventId: randomUUID(),
      finalizationNonce: randomUUID(),
    },
  };
}
function throughCapture(value: unknown = response) {
  const g = setup13();
  dispatch13(g);
  save13(g, value);
  return g;
}
function throughResult(value: unknown = response) {
  const g = throughCapture(value);
  result13(g);
  return g;
}
const originalWrite = journalIO.writeJournalJson;

it(
  "explicit empty SQL13 transition preserves raw rows and witness2 prefix; old APIs stay closed",
  () => {
    const g = setup12(false),
      before = snapshot(g.db),
      files = witnessFiles(g);
    expect(() => inspectPublicComparisonDatabaseV13(g.db, selection)).toThrow();
    expect(migrateGuardedPublicComparisonDatabaseV13(g.session).status).toBe("migrated-v13");
    expect(snapshot(g.db).rows).toEqual(before.rows);
    expect(witnessFiles(g).map((x) => x.slice(0, files[0].length))).toEqual(files);
    expect(() => inspectPublicComparisonDatabaseV12(g.db, selection)).toThrow();
    expect(() =>
      writeGuardedPublicComparisonV12(g.session, "reserve", fixture.command, g.current),
    ).toThrow();
    expect(migrateGuardedPublicComparisonDatabaseV13(g.session).status).toBe("already-v13");
    expect(state13(g).transmissionBindings).toEqual([]);
  },
  limit,
);
it(
  "binding4 dispatch unknown late capture result and close store exact 3/8 rows, preserve prefix and replay before current",
  () => {
    const g = setup13(),
      before = state13(g).reservation,
      companies = allCompany(g.companyDb),
      d = dispatch13(g);
    expect(d.result.insertedRows).toBe(3);
    expect(d.result.companyLockObserved).toBe(true);
    const u = comparisonUnknownCommandSchema.parse({
      ...baseCommand(g),
      kind: "mark-public-comparison-unknown",
      reason: "transport-unknown",
    });
    expect(
      writeGuardedPublicComparisonV13(g.session, "mark-unknown", u, {
        at: later,
        eventId: randomUUID(),
      }).insertedRows,
    ).toBe(2);
    expect(allCompany(g.companyDb)).toEqual(companies);
    g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
    const capture = save13(g),
      result = result13(g),
      i = closeInput(g),
      files = witnessFiles(g);
    const closed = writeGuardedPublicComparisonV13(
      g.session,
      "settle-finalize",
      i.command,
      i.current,
    );
    expect(result.result.insertedRows).toBe(3);
    expect(closed.insertedRows).toBe(8);
    expect(closed.commitObserved).toBe(true);
    expect(closed.owner).toBeNull();
    expect(Object.values(closed.authority).every((v) => v === false)).toBe(true);
    expect(witnessFiles(g)[0].length - files[0].length).toBe(2);
    const after = state13(g).reservation;
    expect(after.prefix).toEqual(before.prefix);
    expect(after.coverage).toEqual(before.coverage);
    expect(after.bindings).toEqual(before.bindings);
    expect(after.archive.records.events.slice(-3).map((e) => e.payload.kind)).toEqual([
      "usage-assessed",
      "cost-settled",
      "finalized",
    ]);
    const rows = snapshot(g.db);
    for (const [op, c] of [
      ["approve-dispatch", d.input.command],
      ["persist-capture", capture.command],
      ["record-result", result.input.command],
      ["settle-finalize", i.command],
    ] as const) {
      const r = writeGuardedPublicComparisonV13(g.session, op, c, explode());
      expect(r.status).toBe("replay");
      expect(r.insertedRows).toBe(0);
      expect(r.witnessMatched).toBe(true);
      expect(r.owner).toBeNull();
    }
    expect(snapshot(g.db)).toEqual(rows);
    const reopened = openComparisonStorageSession(g.paths, selection);
    try {
      expect(
        writeGuardedPublicComparisonV13(reopened, "settle-finalize", i.command, explode()).status,
      ).toBe("replay");
    } finally {
      closeComparisonStorageSession(reopened);
    }
  },
  limit,
);

it(
  "SQL13 reserve and cancel retain existing exact7/6 rows without transmission",
  () => {
    const g = setup13(false);
    expect(
      writeGuardedPublicComparisonV13(g.session, "reserve", fixture.command, g.current)
        .insertedRows,
    ).toBe(7);
    const s = state13(g).reservation,
      c = cancelCommand(s);
    expect(
      writeGuardedPublicComparisonV13(g.session, "cancel", c, cancelCurrent()).insertedRows,
    ).toBe(6);
    expect(writeGuardedPublicComparisonV13(g.session, "cancel", c, explode()).status).toBe(
      "replay",
    );
  },
  limit,
);
it(
  "existing binding3 dispatch and capture migrate unchanged; result allowed, policy close blocked",
  () => {
    const g = setup12();
    const d = dispatch(g);
    mark(g);
    save(g);
    const before = state12(g),
      rows = snapshot(g.db).rows,
      files = witnessFiles(g);
    migrateGuardedPublicComparisonDatabaseV13(g.session);
    expect(snapshot(g.db).rows).toEqual(rows);
    expect(state13(g)).toEqual(before);
    expect(witnessFiles(g).map((x) => x.slice(0, files[0].length))).toEqual(files);
    expect(
      writeGuardedPublicComparisonV13(g.session, "approve-dispatch", d.input.command, explode())
        .status,
    ).toBe("replay");
    expect(result13(g).result.insertedRows).toBe(3);
    const i = closeInput(g),
      stable = snapshot(g.db),
      journal = witnessFiles(g);
    expect(
      writeGuardedPublicComparisonV13(g.session, "settle-finalize", i.command, explode()).status,
    ).toBe("blocked");
    expect(snapshot(g.db)).toEqual(stable);
    expect(witnessFiles(g)).toEqual(journal);
  },
  limit,
);
for (const mode of ["missing", "zero", "excess"] as const)
  it(
    "usage " + mode + " retains full amount/hold with no automatic free run",
    () => {
      const value =
        mode === "missing"
          ? capture
          : mode === "zero"
            ? {
                ...response,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  total_tokens: 0,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                },
              }
            : {
                ...response,
                usage: {
                  input_tokens: 999999,
                  output_tokens: 999999,
                  total_tokens: 1999998,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                },
              };
      const g = throughResult(value),
        s = state13(g).reservation,
        i = closeInput(g),
        rows = snapshot(g.db),
        files = witnessFiles(g);
      const r = writeGuardedPublicComparisonV13(
        g.session,
        "settle-finalize",
        i.command,
        mode === "missing" ? explode() : i.current,
      );
      if (mode === "missing") {
        expect(r.status).toBe("blocked");
        expect(r.insertedRows).toBe(0);
        expect(snapshot(g.db)).toEqual(rows);
        expect(witnessFiles(g)).toEqual(files);
      } else {
        expect(r.insertedRows).toBe(8);
        const money = state13(g).reservation.archive.financial.events.at(-1)!;
        expect(money.payload.kind).toBe("recognize-comparison-usage");
        if (money.payload.kind !== "recognize-comparison-usage") throw Error("money");
        if (mode === "zero") expect(money.payload.recognizedUnits).toBe("0");
        else {
          expect(BigInt(money.payload.recognizedUnits)).toBeGreaterThan(
            BigInt(s.archive.records.runs[0].manifest.reservedUnits),
          );
          expect(BigInt(money.payload.boundExcessUnits)).toBeGreaterThan(BigInt(0));
        }
      }
    },
    limit,
  );
for (const op of ["record-result", "settle-finalize"] as const) {
  for (let n = 1; n <= (op === "record-result" ? 3 : 8); n++)
    it(
      op + " insert " + n + " rolls back all rows and leaves intent blocked",
      () => {
        const g = op === "record-result" ? throughCapture() : throughResult(),
          i = op === "record-result" ? resultInput(g) : closeInput(g),
          before = snapshot(g.db);
        const spy = injectInsert(g.db, n);
        expect(() => writeGuardedPublicComparisonV13(g.session, op, i.command, i.current)).toThrow(
          "injected insert failure",
        );
        spy.mockRestore();
        expect(snapshot(g.db)).toEqual(before);
        expect(() => reconcilePublicComparisonStorageWitnessV3(g.session)).toThrow();
        expect(() =>
          writeGuardedPublicComparisonV13(g.session, op, i.command, i.current),
        ).toThrow();
      },
      limit,
    );
  for (const fault of ["commit-loss", "ack-loss"] as const)
    it(
      op + " " + fault + " recovers original command and ack files only",
      () => {
        const g = op === "record-result" ? throughCapture() : throughResult(),
          i = op === "record-result" ? resultInput(g) : closeInput(g);
        const exec = g.db.exec.bind(g.db);
        let hit = false;
        const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
          exec(sql);
          if (sql === "COMMIT" && !hit && fault === "commit-loss") {
            hit = true;
            throw Error("lost");
          }
        });
        const io = vi
          .spyOn(journalIO, "writeJournalJson")
          .mockImplementation((file, value, ...args) => {
            if (
              fault === "ack-loss" &&
              (value as { payload: { type: string } }).payload.type === "ack"
            )
              throw Error("ack lost");
            return originalWrite(file, value, ...args);
          });
        expect(() => writeGuardedPublicComparisonV13(g.session, op, i.command, i.current)).toThrow(
          /COMMIT_OBSERVATION_UNKNOWN|WITNESS_ACK_REQUIRED/,
        );
        spy.mockRestore();
        io.mockRestore();
        const stable = snapshot(g.db),
          reopened = openComparisonStorageSession(g.paths, selection);
        try {
          expect(
            writeGuardedPublicComparisonV13(reopened, op, i.command, explode()).witnessMatched,
          ).toBe(false);
          expect(reconcilePublicComparisonStorageWitnessV3(reopened).repairedFilesOnly).toBe(true);
          expect(
            writeGuardedPublicComparisonV13(reopened, op, i.command, explode()).witnessMatched,
          ).toBe(true);
          expect(snapshot(g.db)).toEqual(stable);
        } finally {
          closeComparisonStorageSession(reopened);
        }
      },
      limit,
    );
}
for (const fault of [
  "ddl-before",
  "ddl-after",
  "commit-loss",
  "ack-loss",
  "partial-intent",
] as const)
  it(
    "SQL13 transition " + fault + " preserves v2 bytes and recovery boundaries",
    () => {
      const g = setup12(false),
        before = snapshot(g.db),
        files = witnessFiles(g),
        exec = g.db.exec.bind(g.db);
      let hit = false;
      const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
        if (!hit && fault === "ddl-before" && sql.startsWith("DROP TRIGGER")) {
          hit = true;
          throw Error("ddl");
        }
        exec(sql);
        if (
          !hit &&
          ((fault === "ddl-after" && sql.startsWith("CREATE TRIGGER")) ||
            (fault === "commit-loss" && sql === "COMMIT"))
        ) {
          hit = true;
          throw Error("lost");
        }
      });
      const io = vi
        .spyOn(journalIO, "writeJournalJson")
        .mockImplementation((file, value, ...args) => {
          const v = value as { recordVersion: number; payload: { type: string } };
          if (
            v.recordVersion === 3 &&
            ((fault === "ack-loss" && v.payload.type === "transition-ack") ||
              (fault === "partial-intent" &&
                v.payload.type === "transition-intent" &&
                String(file).includes("comparison-storage-witness")))
          )
            throw Error("file");
          return originalWrite(file, value, ...args);
        });
      expect(() => migrateGuardedPublicComparisonDatabaseV13(g.session)).toThrow();
      spy.mockRestore();
      io.mockRestore();
      expect(witnessFiles(g).map((x) => x.slice(0, files[0].length))).toEqual(files);
      if (fault === "commit-loss" || fault === "ack-loss") {
        expect(snapshot(g.db).rows).toEqual(before.rows);
        const stable = snapshot(g.db);
        const reopened = openComparisonStorageSession(g.paths, selection);
        try {
          expect(reconcilePublicComparisonStorageWitnessV3(reopened).repairedFilesOnly).toBe(true);
        } finally {
          closeComparisonStorageSession(reopened);
        }
        expect(snapshot(g.db)).toEqual(stable);
      } else {
        expect(snapshot(g.db)).toEqual(before);
        expect(() => migrateGuardedPublicComparisonDatabaseV13(g.session)).toThrow();
        expect(() => reconcilePublicComparisonStorageWitnessV3(g.session)).toThrow();
      }
    },
    limit,
  );
it(
  "no-op close COMMIT never persists a partial financial settlement",
  () => {
    const g = throughResult(),
      i = closeInput(g),
      before = snapshot(g.db),
      exec = g.db.exec.bind(g.db);
    const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      if (sql !== "COMMIT") exec(sql);
    });
    expect(() =>
      writeGuardedPublicComparisonV13(g.session, "settle-finalize", i.command, i.current),
    ).toThrow(/COMMIT_OBSERVATION_UNKNOWN/);
    spy.mockRestore();
    expect(snapshot(g.db)).toEqual(before);
    expect(() => reconcilePublicComparisonStorageWitnessV3(g.session)).toThrow();
  },
  limit,
);
it(
  "original close nonce compares all fields and rejects internal receipt nonce ownership",
  () => {
    const g = throughResult(),
      i = closeInput(g);
    writeGuardedPublicComparisonV13(g.session, "settle-finalize", i.command, i.current);
    const stable = snapshot(g.db),
      files = witnessFiles(g);
    expect(() =>
      writeGuardedPublicComparisonV13(
        g.session,
        "settle-finalize",
        { ...i.command, expectedAssessmentDigest: bad },
        explode(),
      ),
    ).toThrow();
    expect(() =>
      writeGuardedPublicComparisonV13(
        g.session,
        "settle-finalize",
        { ...i.command, clientRequestId: i.current.usageNonce },
        explode(),
      ),
    ).toThrow();
    expect(snapshot(g.db)).toEqual(stable);
    expect(witnessFiles(g)).toEqual(files);
  },
  limit,
);
for (const field of ["company", "policy-expiry", "policy", "head"] as const)
  it(
    "new binding4 dispatch rejects changed " + field + " before intent",
    () => {
      const g = setup13(),
        i = input13(g),
        before = snapshot(g.db),
        files = witnessFiles(g);
      if (field === "company")
        g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
      if (field === "policy-expiry") i.current.at = later;
      if (field === "policy") i.current.usagePolicy.responseModels = ["other"];
      if (field === "head") i.command.expectedRunHead.headDigest = bad;
      expect(() =>
        writeGuardedPublicComparisonV13(g.session, "approve-dispatch", i.command, i.current),
      ).toThrow();
      expect(snapshot(g.db)).toEqual(before);
      expect(witnessFiles(g)).toEqual(files);
    },
    limit,
  );
it(
  "result hash and close internal nonce collision leave SQL and witness unchanged",
  () => {
    const g = throughCapture(),
      i = resultInput(g),
      before = snapshot(g.db),
      files = witnessFiles(g);
    expect(() =>
      writeGuardedPublicComparisonV13(
        g.session,
        "record-result",
        { ...i.command, expectedValidatedArtifactSha256: bad },
        i.current,
      ),
    ).toThrow();
    expect(snapshot(g.db)).toEqual(before);
    expect(witnessFiles(g)).toEqual(files);
    result13(g);
    const c = closeInput(g),
      after = snapshot(g.db),
      journal = witnessFiles(g);
    expect(() =>
      writeGuardedPublicComparisonV13(g.session, "settle-finalize", c.command, {
        ...c.current,
        usageNonce: c.command.clientRequestId,
      }),
    ).toThrow();
    expect(snapshot(g.db)).toEqual(after);
    expect(witnessFiles(g)).toEqual(journal);
  },
  limit,
);
it(
  "SQL13 gates remain connection-local, ordered and reject mutated close BLOB",
  () => {
    const g = throughResult(),
      i = closeInput(g),
      before = snapshot(g.db),
      prepare = g.db.prepare.bind(g.db);
    const other = new DatabaseSync(g.paths.qualityFile);
    try {
      expect(() =>
        other
          .prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)")
          .run(randomUUID(), "{}", "x"),
      ).toThrow();
    } finally {
      other.close();
    }
    const spy = vi.spyOn(g.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("INSERT INTO quality_actual_artifacts")) {
        const run = statement.run.bind(statement);
        vi.spyOn(statement, "run").mockImplementation((...args) => {
          args[2] = Buffer.from("changed");
          return run(...args);
        });
      }
      return statement;
    });
    expect(() =>
      writeGuardedPublicComparisonV13(g.session, "settle-finalize", i.command, i.current),
    ).toThrow();
    spy.mockRestore();
    expect(snapshot(g.db)).toEqual(before);
  },
  limit,
);
it(
  "competing session lease cannot enter a close transaction",
  () => {
    const g = throughResult(),
      i = closeInput(g),
      other = openComparisonStorageSession(g.paths, selection),
      before = snapshot(g.db);
    beginComparisonStorageSession(other);
    try {
      expect(() =>
        writeGuardedPublicComparisonV13(g.session, "settle-finalize", i.command, i.current),
      ).toThrow();
    } finally {
      endComparisonStorageSession(other);
      closeComparisonStorageSession(other);
    }
    expect(snapshot(g.db)).toEqual(before);
    expect(
      writeGuardedPublicComparisonV13(g.session, "settle-finalize", i.command, i.current)
        .insertedRows,
    ).toBe(8);
  },
  limit,
);
it(
  "witness3 reserves worst remaining transaction pairs and releases only full finalized storage",
  () => {
    const g = setup13(),
      s = state13(g).reservation;
    expect(() => requireComparisonWitnessCapacity(116, 2, s, 3)).not.toThrow();
    expect(() => requireComparisonWitnessCapacity(118, 2, s, 3)).toThrow(/WITNESS_LIMIT/);
    dispatch13(g);
    save13(g);
    result13(g);
    const c = closeInput(g);
    writeGuardedPublicComparisonV13(g.session, "settle-finalize", c.command, c.current);
    expect(() => requireComparisonWitnessCapacity(126, 2, state13(g).reservation, 3)).not.toThrow();
  },
  limit,
);

it(
  "close preserves observed COMMIT when ack and rollback fail; only same owner ends lease",
  () => {
    const g = throughResult(),
      i = closeInput(g),
      exec = g.db.exec.bind(g.db);
    const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw Error("rollback lost");
      exec(sql);
    });
    const io = vi
      .spyOn(journalIO, "writeJournalJson")
      .mockImplementation((file, value, ...args) => {
        if ((value as { payload: { type: string } }).payload.type === "ack")
          throw Error("ack lost");
        return originalWrite(file, value, ...args);
      });
    let caught: unknown;
    try {
      writeGuardedPublicComparisonV13(g.session, "settle-finalize", i.command, i.current);
    } catch (e) {
      caught = e;
    }
    try {
      expect(caught).toMatchObject({
        message: "PUBLIC_COMPARISON_LEASE_CLEANUP_REQUIRED",
        commitObserved: true,
        recoveryRequired: true,
      });
      expect(g.db.isTransaction).toBe(true);
    } finally {
      spy.mockRestore();
      io.mockRestore();
      if (g.db.isTransaction) g.db.exec("ROLLBACK");
      endComparisonStorageSession(g.session);
    }
    const stable = snapshot(g.db);
    expect(reconcilePublicComparisonStorageWitnessV3(g.session).repairedFilesOnly).toBe(true);
    expect(snapshot(g.db)).toEqual(stable);
  },
  limit,
);
for (const mode of ["partial-close", "past-database"] as const)
  it(
    mode + " never replays or releases an incomplete eight-row group",
    () => {
      const g = throughResult(),
        i = closeInput(g);
      writeGuardedPublicComparisonV13(g.session, "settle-finalize", i.command, i.current);
      const s = state13(g),
        events = s.reservation.archive.records.events.slice(-3),
        receipts = s.reservation.archive.records.receipts;
      const triggers = g.db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE '%_no_delete'",
        )
        .all();
      g.db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
      try {
        for (const t of triggers) g.db.exec("DROP TRIGGER " + t.name);
        const removed = mode === "partial-close" ? events.slice(-1) : events;
        for (const e of removed) {
          const r = receipts.find((r) => r.operationDigest === e.eventDigest)!;
          g.db.prepare("DELETE FROM quality_actual_requests WHERE nonce=?").run(r.clientRequestId);
          g.db
            .prepare("DELETE FROM quality_actual_events WHERE run_id=? AND revision=?")
            .run(e.runId, e.revision);
        }
        g.db
          .prepare(
            "DELETE FROM quality_actual_artifacts WHERE run_id=? AND artifact_key='final-result'",
          )
          .run(i.command.runId);
        if (mode === "past-database") {
          const b = s.reservation.archive.financial.events.at(-1)!;
          g.db
            .prepare("DELETE FROM quality_actual_budget_events WHERE scope_id=? AND revision=?")
            .run(b.scopeId, b.revision);
        }
        for (const t of triggers) g.db.exec(String(t.sql));
        g.db.exec("COMMIT; PRAGMA foreign_keys=ON");
      } catch (e) {
        if (g.db.isTransaction) g.db.exec("ROLLBACK");
        throw e;
      }
      const stable = snapshot(g.db);
      if (mode === "partial-close") expect(() => state13(g)).toThrow();
      else
        expect(state13(g).reservation.archive.records.events.at(-1)!.payload.kind).toBe(
          "comparison-recorded",
        );
      expect(() =>
        writeGuardedPublicComparisonV13(g.session, "settle-finalize", i.command, i.current),
      ).toThrow();
      expect(() => reconcilePublicComparisonStorageWitnessV3(g.session)).toThrow();
      const service = createIsolatedPublicComparisonService(g.session, g.cap, createSyntheticComparisonDriver(forbidden));
      expect(() => service.recoverPostcapture("settle-finalize", i.command)).toThrow();
      expect(service.retire()).toMatchObject({ status: "draining", postcapture: { status: "recovery-required", commandDigest: digest(i.command) } });
      expect(snapshot(g.db)).toEqual(stable);
    },
    limit,
  );
for (const mutation of ["missing-binding", "sql-identity", "raw-overhead"] as const)
  it(
    "binding4 reader " + mutation + " keeps full audit and byte accounting",
    () => {
      const g = setup13();
      dispatch13(g);
      const before = state13(g),
        raw = transmissionRows.readProviderTransmissionApprovalRawDatabaseRows;
      const spy = vi
        .spyOn(transmissionRows, "readProviderTransmissionApprovalRawDatabaseRows")
        .mockImplementation((db) => {
          const rows = structuredClone(raw(db));
          const b = rows.bindingRows.find(
            (r: { body: string }) => JSON.parse(r.body).recordVersion === 4,
          )!;
          if (mutation === "missing-binding")
            rows.bindingRows = rows.bindingRows.filter(
              (r: { body: string }) => JSON.parse(r.body).recordVersion !== 4,
            );
          if (mutation === "sql-identity") b.nonce = randomUUID();
          if (mutation === "raw-overhead") b.body += " ".repeat(200);
          return rows;
        });
      if (mutation === "raw-overhead") {
        const after = state13(g);
        expect(after.reservation.additionalUsedBytes).toBe(
          before.reservation.additionalUsedBytes + 200,
        );
        expect(after.transmissionBindings).toEqual(before.transmissionBindings);
      } else expect(() => state13(g)).toThrow();
      spy.mockRestore();
      expect(state13(g)).toEqual(before);
    },
    limit,
  );
it(
  "binding4 dispatch holds studio writer lock through quality COMMIT and frees it afterward",
  () => {
    const g = setup13(),
      i = input13(g),
      exec = g.db.exec.bind(g.db);
    let observed = false;
    const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" && !observed) {
        observed = true;
        expect(() => g.companyDb.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/);
      }
      exec(sql);
    });
    expect(
      writeGuardedPublicComparisonV13(g.session, "approve-dispatch", i.command, i.current)
        .companyLockObserved,
    ).toBe(true);
    spy.mockRestore();
    expect(observed).toBe(true);
    g.companyDb.exec("BEGIN IMMEDIATE; ROLLBACK");
  },
  limit,
);

// 4I22 reuses the SQL13 fixtures above; this is synthetic lifetime observation only.
function deferred22<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function ownerFixture22() {
  const g = setup13(),
    input = input13(g);
  vi.setSystemTime(fixture.at);
  const { companyGuard: _guard, ...current } = input.current;
  void _guard;
  // Test-owned fixture teardown, never a product recovery operation or proof of settlement.
  cleanups.push(() => {
    if (g.db.isTransaction) g.db.exec("ROLLBACK");
    endComparisonCompanyRead(g.cap);
    try {
      endComparisonStorageSession(g.session);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("STORAGE_SESSION_INVALID"))
        throw error;
    }
  });
  return { g, command: input.command, current };
}
function wire22(
  boundary: PublicComparisonTransportBoundary,
  signal = new AbortController().signal,
) {
  return {
    method: "POST",
    body: boundary.rawBody,
    redirect: "error",
    signal,
    headers: {
      authorization: "Bearer " + comparisonSyntheticWireKey,
      "content-type": "application/json",
      "x-stainless-retry-count": "0",
    },
  };
}
it(
  "4I22 same lease start is synchronous under both locks; capture precedes retirement and keeps unknown usage hold",
  async () => {
    const { g, command, current } = ownerFixture22();
    const ready = deferred22<void>(),
      net = deferred22<unknown>(),
      drain = deferred22<void>();
    let hooks!: SyntheticComparisonHooks;
    const startFake = vi.fn(() => {
      expect(g.db.isTransaction).toBe(true);
      expect(() => g.companyDb.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      return net.promise;
    });
    const driver = createSyntheticComparisonDriver(async (b, h) => {
      hooks = h;
      expect(b).toMatchObject({ requestedTier: null, dispatchAllowed: false });
      const body = JSON.parse(b.rawBody);
      for (const key of ["service_tier", "truncation", "background", "stream"])
        expect(body).not.toHaveProperty(key);
      const wait = h.start(b.destination, wire22(b), startFake);
      ready.resolve();
      await wait;
      await drain.promise;
    });
    const execution = createIsolatedPublicComparisonExecution(g.session, g.cap, driver);
    const running = execution.execute(command, current);
    await Promise.race([
      ready.promise,
      running.then((v) => {
        throw Error("start not reached: " + JSON.stringify(v));
      }),
    ]);
    expect(g.db.isTransaction).toBe(false);
    g.companyDb.exec("BEGIN IMMEDIATE");
    g.companyDb.exec("ROLLBACK");
    expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    expect(() => hooks.start("", {}, startFake)).toThrow(/START_REFUSED/);
    const trap = Object.defineProperty({}, "approvedReview", {
      get() {
        throw Error("must not read current");
      },
    });
    expect((await execution.execute(command, trap)).phase).toBe("in-flight");
    g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
    vi.setSystemTime(later);
    net.resolve({ ...response, usage: undefined });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(execution.inspect()).toMatchObject({
      capturePersisted: true,
      promiseSettled: false,
      retainedCaptureCount: 1,
    });
    expect(execution.retire().phase).toBe("draining");
    drain.resolve();
    expect(await running).toMatchObject({
      phase: "closed",
      owner: null,
      runtimeObserved: false,
      syntheticStartObserved: true,
      capturePersisted: true,
      promiseSettled: true,
      retainedCaptureCount: 0,
    });
    expect(startFake).toHaveBeenCalledTimes(1);
    const s = state13(g);
    expect(s.reservation.archive.records.events.at(-1)!.payload.kind).toBe("response-captured");
    result13(g);
    const close = closeInput(g);
    expect(
      writeGuardedPublicComparisonV13(g.session, "settle-finalize", close.command, close.current)
        .status,
    ).toBe("blocked");
  },
  limit,
);
it(
  "4I22 stored dispatch replay precedes driver and current and never creates a new owner",
  async () => {
    const { g, command, current } = ownerFixture22();
    writeGuardedPublicComparisonV13(g.session, "approve-dispatch", command, {
      ...current,
      companyGuard: g.cap,
    });
    const trap = Object.defineProperty({}, "approvedReview", {
      get() {
        throw Error("read current");
      },
    });
    const execution = createIsolatedPublicComparisonExecution(g.session, g.cap, {
      kind: "synthetic-comparison-fixture",
    }); // Forged driver must never be consulted on replay.
    const before = snapshot(g.db);
    expect(await execution.execute(command, trap)).toMatchObject({
      phase: "replay",
      owner: null,
      dispatchCommitObserved: false,
      startAttempted: false,
    });
    expect(snapshot(g.db)).toEqual(before);
  },
  limit,
);

for (const fault of [
  "company-delete",
  "same-revision-body",
  "expired",
  "clock-backward",
  "wire-body",
  "wire-option",
  "wire-header",
  "aborted",
  "retired",
  "monotonic-expired",
  "company-revision",
  "restore-marker",
  "lease-revoked",
  "policy-changed",
  "request-changed",
  "native-head-changed",
  "budget-head-changed",
] as const)
  it(
    "4I22 delayed boundary rejects " + fault + " without a start or hold release",
    async () => {
      const { g, command, current } = ownerFixture22();
      const startFake = vi.fn(async () => response);
      let revoked = false,
        driverVerified = false;
      if (fault === "lease-revoked") {
        const acquire = journalIO.acquireJournalLease;
        vi.spyOn(journalIO, "acquireJournalLease").mockImplementation((...args) => {
          const real = acquire(...args);
          return {
            guard() {
              if (revoked) throw Error("synthetic lease revoked");
              real.guard();
            },
            close: real.close,
          };
        });
      }
      const driver = createSyntheticComparisonDriver(async (b, h) => {
        await Promise.resolve(); // Guard belongs to the actual delayed hook.
        const controller = new AbortController(),
          wire: Record<string, unknown> = wire22(b, controller.signal);
        if (fault === "company-delete")
          g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
        if (fault === "restore-marker")
          writeFileSync(join(g.paths.dataRoot, ".restore-pending"), "synthetic pending");
        if (fault === "lease-revoked") revoked = true;
        let restoreRows: (() => void) | undefined;
        if (
          [
            "policy-changed",
            "request-changed",
            "native-head-changed",
            "budget-head-changed",
          ].includes(fault)
        ) {
          const read = databaseRows22.readPublicComparisonRows;
          const spy = vi
            .spyOn(databaseRows22, "readPublicComparisonRows")
            .mockImplementation((...args) => {
              const rows = read(...args);
              if (fault === "policy-changed") {
                const row = rows.transmissionRows.bindingRows.find(
                  (r) => JSON.parse(r.body).recordVersion === 4,
                )!;
                const body = JSON.parse(row.body);
                body.approvedReview.usagePolicy.requestedTier = "default";
                row.body = JSON.stringify(body);
                row.body_hash = digest(body);
              }
              if (fault === "request-changed") {
                const row = rows.actualRows.runs.find((r) => r.id === command.runId)!;
                const body = JSON.parse(row.body);
                body.command.selection.companyRevision++;
                row.body = JSON.stringify(body);
                row.body_hash = digest(body);
              }
              if (fault === "native-head-changed")
                rows.actualRows.events.find((r) => r.run_id === command.runId)!.revision++;
              if (fault === "budget-head-changed") rows.actualRows.budget.at(-1)!.revision++;
              return rows;
            });
          restoreRows = () => spy.mockRestore();
        }
        if (fault === "company-revision") {
          const company = structuredClone(fixture.company);
          company.revision++;
          g.companyDb
            .prepare("UPDATE studio_cases SET revision=?,body=? WHERE id=?")
            .run(company.revision, JSON.stringify(company), company.id);
        }
        if (fault === "same-revision-body") {
          const company = structuredClone(fixture.company);
          company.sources[0].text += " changed";
          g.companyDb
            .prepare("UPDATE studio_cases SET body=? WHERE id=?")
            .run(JSON.stringify(company), company.id);
        }
        if (fault === "expired") vi.setSystemTime(command.approval.expiresAt);
        if (fault === "monotonic-expired")
          vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
        if (fault === "clock-backward") vi.setSystemTime(Date.parse(fixture.at) - 1);
        if (fault === "wire-body") wire.body = b.rawBody + " ";
        if (fault === "wire-option") wire.credentials = "include";
        if (fault === "wire-header") wire.headers = { authorization: "Bearer wrong" };
        if (fault === "aborted") controller.abort();
        if (fault === "retired") execution.retire();
        try {
          await expect(
            Promise.resolve().then(() => h.start(b.destination, wire, startFake)),
          ).rejects.toThrow(/START_REFUSED/);
        } finally {
          restoreRows?.();
        }
        driverVerified = true;
      });
      const execution = createIsolatedPublicComparisonExecution(g.session, g.cap, driver);
      const view = await execution.execute(command, current);
      expect(driverVerified).toBe(true);
      expect(view.phase).toBe("recovery-required");
      expect(view.startAttempted).toBe(false);
      expect(startFake).not.toHaveBeenCalled();
      expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
      expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    },
    limit,
  );

it(
  "4I22 unknown then late capture keeps the original promise and immutable bytes after company deletion",
  async () => {
    const { g, command, current } = ownerFixture22();
    const net = deferred22<unknown>();
    let original: unknown;
    const execution = createIsolatedPublicComparisonExecution(
      g.session,
      g.cap,
      createSyntheticComparisonDriver(async (b, h) => {
        const pending = h.start(b.destination, wire22(b), () => net.promise);
        h.markUnknown();
        const unknownRows = state13(g).reservation.archive.records.events;
        expect(unknownRows.at(-1)!.payload.kind).toBe("dispatch-unknown");
        h.markUnknown();
        expect(state13(g).reservation.archive.records.events).toEqual(unknownRows);
        g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
        vi.setSystemTime(later);
        original = structuredClone(response);
        net.resolve(original);
        await pending;
        h.markUnknown();
      }),
    );
    expect(await execution.execute(command, current)).toMatchObject({
      phase: "closed",
      capturePersisted: true,
    });
    const events = state13(g).reservation.archive.records.events;
    expect(events.slice(-2).map((e) => e.payload.kind)).toEqual([
      "dispatch-unknown",
      "response-captured",
    ]);
    expect(
      state13(g).reservation.archive.records.artifacts.find((a) => a.key === "comparison-response")!
        .body,
    ).toBe(JSON.stringify(original));
  },
  limit,
);

for (const fault of [
  "dispatch-commit-loss",
  "dispatch-ack-loss",
  "capture-commit-loss",
  "capture-ack-loss",
  "capture-insert",
] as const)
  it(
    "4I22 " + fault + " retains lease; recovery never redispatches or reinserts uncertain rows",
    async () => {
      const { g, command, current } = ownerFixture22();
      const exec = g.db.exec.bind(g.db);
      let capturePhase = false,
        hit = false;
      const sql = vi.spyOn(g.db, "exec").mockImplementation((statement) => {
        exec(statement);
        if (
          !hit &&
          statement === "COMMIT" &&
          ((fault === "dispatch-commit-loss" && !capturePhase) ||
            (fault === "capture-commit-loss" && capturePhase))
        ) {
          hit = true;
          throw Error("lost COMMIT response");
        }
      });
      const io = vi
        .spyOn(journalIO, "writeJournalJson")
        .mockImplementation((file, value, ...args) => {
          if (
            (value as { payload: { type: string } }).payload.type === "ack" &&
            ((fault === "dispatch-ack-loss" && !capturePhase) ||
              (fault === "capture-ack-loss" && capturePhase))
          ) {
            hit = true;
            throw Error("ack failure");
          }
          return originalWrite(file, value, ...args);
        });
      let insert: ReturnType<typeof injectInsert> | undefined;
      const started = vi.fn(async () => {
        capturePhase = true;
        if (fault === "capture-insert") insert = injectInsert(g.db, 2);
        return response;
      });
      const execution = createIsolatedPublicComparisonExecution(
        g.session,
        g.cap,
        createSyntheticComparisonDriver(async (b, h) => {
          await h.start(b.destination, wire22(b), started);
        }),
      );
      const view = await execution.execute(command, current);
      expect(view.phase).toBe("recovery-required");
      expect(view.capturePersisted).toBe(false);
      expect(view.retainedCaptureCount).toBe(capturePhase ? 1 : 0);
      sql.mockRestore();
      io.mockRestore();
      insert?.mockRestore();
      const before = snapshot(g.db);
      const recovered = execution.recover({
        runId: command.runId,
        dispatchCommandDigest: digest(command),
      });
      expect(snapshot(g.db)).toEqual(before);
      if (fault.startsWith("dispatch")) {
        expect(started).not.toHaveBeenCalled();
        expect(recovered).toMatchObject({
          syntheticStartObserved: false,
          phase: "recovery-required",
        });
      } else if (fault === "capture-insert") {
        expect(recovered.phase).toBe("recovery-required");
        expect(recovered.retainedCaptureCount).toBe(1);
      } else
        expect(recovered).toMatchObject({
          phase: "closed",
          capturePersisted: true,
          retainedCaptureCount: 0,
        });
      expect(() =>
        execution.recover({
          runId: command.runId,
          dispatchCommandDigest: digest(command),
          response,
        }),
      ).toThrow();
      expect(started.mock.calls.length).toBeLessThanOrEqual(1);
    },
    limit,
  );

for (const mode of ["reject", "malformed", "refusal", "incomplete"] as const)
  it(
    "4I22 " + mode + " distinguishes no capture from retained provider JSON",
    async () => {
      const { g, command, current } = ownerFixture22();
      const execution = createIsolatedPublicComparisonExecution(
        g.session,
        g.cap,
        createSyntheticComparisonDriver(async (b, h) => {
          await h.start(b.destination, wire22(b), async () => {
            if (mode === "reject") throw Error("secret SDK detail must never escape");
            if (mode === "malformed")
              return {
                output: [
                  {
                    get text() {
                      throw Error("not plain");
                    },
                  },
                ],
              };
            return {
              ...response,
              status: mode === "incomplete" ? "incomplete" : "completed",
              output:
                mode === "refusal"
                  ? [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }]
                  : [],
            };
          });
        }),
      );
      const result = await execution.execute(command, current);
      expect(result.phase).toBe(
        mode === "reject" || mode === "malformed" ? "recovery-required" : "closed",
      );
      expect(result.capturePersisted).toBe(mode === "refusal" || mode === "incomplete");
      expect(JSON.stringify(result)).not.toMatch(
        /secret SDK|authorization|rawBody|synthetic-capture/,
      );
      expect(execution.retire().capturePersisted).toBe(result.capturePersisted);
    },
    limit,
  );

for (const fault of ["read-rollback", "lease-close", "capture-ack-and-rollback"] as const)
  it(
    "4I22 " + fault + " preserves first capture and only the same owner completes cleanup",
    async () => {
      const { g, command, current } = ownerFixture22();
      let capturePhase = false;
      const exec = g.db.exec.bind(g.db);
      const sql = vi.spyOn(g.db, "exec").mockImplementation((statement) => {
        if (capturePhase && statement === "ROLLBACK" && fault !== "lease-close")
          throw Error("cleanup failure");
        exec(statement);
      });
      const io = vi
        .spyOn(journalIO, "writeJournalJson")
        .mockImplementation((file, value, ...args) => {
          if (
            capturePhase &&
            fault === "capture-ack-and-rollback" &&
            (value as { payload: { type: string } }).payload.type === "ack"
          )
            throw Error("ack failure");
          return originalWrite(file, value, ...args);
        });
      let restoreEnd: (() => void) | undefined;
      const execution = createIsolatedPublicComparisonExecution(
        g.session,
        g.cap,
        createSyntheticComparisonDriver(async (b, h) => {
          await h.start(b.destination, wire22(b), () => {
            if (fault === "read-rollback") capturePhase = true;
            if (fault === "lease-close") {
              const end = vi
                .spyOn(storageWitness22, "endComparisonStorageSession")
                .mockImplementation(() => {
                  throw Error("lease cleanup");
                });
              restoreEnd = () => end.mockRestore();
            }
            // Inject the ack failure only after the final read transactions have closed.
            return Promise.resolve().then(() => {
              capturePhase = true;
              return response;
            });
          });
        }),
      );
      const observed = await execution.execute(command, current);
      expect(observed).toMatchObject({
        phase: "recovery-required",
        promiseSettled: true,
        retainedCaptureCount: 1,
        syntheticStartObserved: true,
      });
      expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
      sql.mockRestore();
      io.mockRestore();
      restoreEnd?.();
      expect(
        execution.recover({ runId: command.runId, dispatchCommandDigest: digest(command) }),
      ).toMatchObject({ phase: "closed", retainedCaptureCount: 0, capturePersisted: true });
      expect(execution.retire().phase).toBe("closed");
    },
    limit,
  );

it(
  "4I22 an unresolved original promise keeps lease even after capture and retire",
  async () => {
    const { g, command, current } = ownerFixture22();
    const net = deferred22<unknown>(),
      driverDrain = deferred22<void>(),
      seen = deferred22<void>();
    const execution = createIsolatedPublicComparisonExecution(
      g.session,
      g.cap,
      createSyntheticComparisonDriver(async (b, h) => {
        const waiting = h.start(b.destination, wire22(b), () => net.promise);
        h.markUnknown();
        seen.resolve();
        await waiting;
        await driverDrain.promise;
      }),
    );
    const running = execution.execute(command, current);
    await seen.promise;
    expect(execution.retire()).toMatchObject({
      phase: "draining",
      promiseSettled: false,
      capturePersisted: false,
    });
    expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    net.resolve(response);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(execution.inspect()).toMatchObject({
      capturePersisted: true,
      promiseSettled: false,
      retainedCaptureCount: 1,
    });
    driverDrain.resolve();
    expect((await running).phase).toBe("closed");
  },
  limit,
);

it(
  "4I22 driver completion cannot be used as a delayed new start capability",
  async () => {
    const { g, command, current } = ownerFixture22();
    let boundary!: PublicComparisonTransportBoundary, hooks!: SyntheticComparisonHooks;
    const execution = createIsolatedPublicComparisonExecution(
      g.session,
      g.cap,
      createSyntheticComparisonDriver(async (b, h) => {
        boundary = b;
        hooks = h;
      }),
    );
    expect(await execution.execute(command, current)).toMatchObject({
      phase: "recovery-required",
      promiseSettled: true,
      startAttempted: false,
    });
    const startFake = vi.fn(async () => response);
    expect(() => hooks.start(boundary.destination, wire22(boundary), startFake)).toThrow(
      /START_REFUSED/,
    );
    expect(startFake).not.toHaveBeenCalled();
    expect(
      execution.recover({ runId: command.runId, dispatchCommandDigest: digest(command) }).phase,
    ).toBe("recovery-required");
  },
  limit,
);
it(
  "4I22 observed dispatch COMMIT followed by failed company release has no send owner",
  async () => {
    const { g, command, current } = ownerFixture22();
    const originalEnd = companyGuard22.endComparisonCompanyRead;
    const release = vi
      .spyOn(companyGuard22, "endComparisonCompanyRead")
      .mockImplementationOnce((cap) => {
        originalEnd(cap);
        throw Error("release observation lost");
      });
    const callback = vi.fn(async () => {});
    const execution = createIsolatedPublicComparisonExecution(
      g.session,
      g.cap,
      createSyntheticComparisonDriver(callback),
    );
    expect(await execution.execute(command, current)).toMatchObject({
      phase: "recovery-required",
      dispatchCommitObserved: true,
      startAttempted: false,
    });
    release.mockRestore();
    const before = snapshot(g.db);
    execution.recover({ runId: command.runId, dispatchCommandDigest: digest(command) });
    expect(callback).not.toHaveBeenCalled();
    expect(snapshot(g.db)).toEqual(before);
  },
  limit,
);

for (const fault of ["input", "company", "driver"] as const)
  it(
    "4I22 unchanged predispatch " + fault + " rejection releases only its unused lease",
    async () => {
      const { g, command, current } = ownerFixture22();
      const before = snapshot(g.db);
      const callback = vi.fn(async () => {});
      if (fault === "company")
        g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
      const driver =
        fault === "driver"
          ? { kind: "synthetic-comparison-fixture" as const }
          : createSyntheticComparisonDriver(callback);
      const execution = createIsolatedPublicComparisonExecution(g.session, g.cap, driver);
      expect(
        await execution.execute(
          command,
          fault === "input" ? { ...current, unexpected: true } : current,
        ),
      ).toMatchObject({
        phase: "start-refused",
        dispatchCommitObserved: false,
        startAttempted: false,
        cleanupRequired: false,
      });
      expect(snapshot(g.db)).toEqual(before);
      expect(callback).not.toHaveBeenCalled();
      beginComparisonStorageSession(g.session);
      endComparisonStorageSession(g.session);
    },
    limit,
  );

for (const mode of ["sync-start-throw", "driver-throw-after-start"] as const)
  it(
    "4I22 " + mode + " preserves the attempt and original pending response without another start",
    async () => {
      const { g, command, current } = ownerFixture22();
      const ready = deferred22<void>(),
        net = deferred22<unknown>();
      const started = vi.fn(() => {
        if (mode === "sync-start-throw") throw Error("private synthetic transport detail");
        return net.promise;
      });
      const execution = createIsolatedPublicComparisonExecution(
        g.session,
        g.cap,
        createSyntheticComparisonDriver(async (b, h) => {
          const waiting = h.start(b.destination, wire22(b), started);
          ready.resolve();
          if (mode === "driver-throw-after-start") throw Error("private driver detail");
          await waiting;
        }),
      );
      const running = execution.execute(command, current);
      await ready.promise;
      if (mode === "driver-throw-after-start") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(execution.inspect()).toMatchObject({
          startAttempted: true,
          promiseSettled: false,
          capturePersisted: false,
        });
        expect(state13(g).reservation.archive.records.events.at(-1)!.payload.kind).toBe(
          "dispatch-unknown",
        );
        net.resolve(response);
      }
      const result = await running;
      expect(result).toMatchObject({
        phase: mode === "sync-start-throw" ? "recovery-required" : "closed",
        startAttempted: true,
      });
      expect(started).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toMatch(/private synthetic|private driver/);
    },
    limit,
  );

// 4I24: SDK shape only; no openai runtime import or network fallback.
const tick24 = () => new Promise<void>((done) => setImmediate(done));
function sdkWire24(body: unknown) {
  return {
    method: "POST",
    body: JSON.stringify(body),
    redirect: "error",
    signal: new AbortController().signal,
    headers: {
      authorization: "Bearer " + comparisonSyntheticWireKey,
      "content-type": "application/json",
      "x-stainless-retry-count": "0",
    },
  };
}
it(
  "4I24 Response completion precedes SDK capture under the same lease and all promises drain",
  async () => {
    const { g, command, current } = ownerFixture22();
    const ready = deferred22<void>(),
      net = deferred22<Response>(),
      decode = deferred22<void>(),
      drain = deferred22<void>();
    let options!: SyntheticComparisonSdkOptions, hooks!: SyntheticComparisonHooks;
    let received: Response | undefined;
    let underBothLocks = false;
    const network = vi.fn(() => {
      underBothLocks = g.db.isTransaction;
      expect(() => g.companyDb.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      ready.resolve();
      return net.promise;
    });
    const driver = createSyntheticComparisonSdkDriver((o) => {
      options = o;
      return {
        responses: {
          create: async (body) => {
            received = await o.fetch("https://api.openai.com/v1/responses", sdkWire24(body));
            await decode.promise;
            const value = { ...response, usage: undefined, output_text: "ignore-derived-text" };
            Object.defineProperty(value, "_request_id", { value: "non-enumerable-request-24" });
            return value;
          },
        },
      };
    }, network);
    const execution = createIsolatedPublicComparisonExecution(
      g.session,
      g.cap,
      createSyntheticComparisonDriver(async (b, h) => {
        hooks = h;
        await requireSyntheticComparisonDriver(driver)(b, h);
        await drain.promise;
      }),
    );
    const running = execution.execute(command, current);
    await Promise.race([
      ready.promise,
      running.then((v) => {
        throw Error("not started: " + JSON.stringify(v));
      }),
    ]);
    expect(underBothLocks).toBe(true);
    expect(g.db.isTransaction).toBe(false);
    g.companyDb.exec("BEGIN IMMEDIATE");
    g.companyDb.exec("ROLLBACK");
    const raw = new Response("{}");
    net.resolve(raw);
    await tick24();
    expect(received).not.toBe(raw);
    expect(await received!.text()).toBe("{}");
    expect(raw.bodyUsed).toBe(true);
    expect(execution.inspect()).toMatchObject({
      networkSettled: true,
      sdkSettled: false,
      capturePersisted: false,
      retainedCaptureCount: 0,
      promiseSettled: false,
    });
    expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    expect(() => options.fetch("https://api.openai.com/v1/responses", sdkWire24({}))).toThrow(
      /START_REFUSED/,
    );
    hooks.markUnknown();
    g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
    vi.setSystemTime(later);
    decode.resolve();
    await tick24();
    expect(execution.inspect()).toMatchObject({
      capturePersisted: true,
      sdkSettled: true,
      promiseSettled: false,
      retainedCaptureCount: 1,
    });
    expect(execution.retire().phase).toBe("draining");
    drain.resolve();
    expect(await running).toMatchObject({
      phase: "closed",
      promiseSettled: true,
      owner: null,
      runtimeObserved: false,
    });
    expect(network).toHaveBeenCalledTimes(1);
    const s = state13(g);
    expect(JSON.stringify(s)).toContain("non-enumerable-request-24");
    expect(JSON.stringify(s)).not.toContain("ignore-derived-text");
    expect(
      s.reservation.archive.records.events.some((e) => e.payload.kind === "dispatch-unknown"),
    ).toBe(true);
    result13(g);
    const close = closeInput(g);
    expect(
      writeGuardedPublicComparisonV13(g.session, "settle-finalize", close.command, close.current)
        .status,
    ).toBe("blocked");
  },
  limit,
);
it(
  "4I24 stored nonce replay never prepares an SDK-shaped driver or reads current",
  async () => {
    const { g, command, current } = ownerFixture22();
    writeGuardedPublicComparisonV13(g.session, "approve-dispatch", command, {
      ...current,
      companyGuard: g.cap,
    });
    const factory = vi.fn(() => {
        throw Error("SDK prepared during replay");
      }),
      network = vi.fn(async () => new Response("{}"));
    const execution = createIsolatedPublicComparisonExecution(
      g.session,
      g.cap,
      createSyntheticComparisonSdkDriver(factory, network),
    );
    const before = snapshot(g.db);
    expect(await execution.execute(command, explode())).toMatchObject({
      phase: "replay",
      owner: null,
      startAttempted: false,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(snapshot(g.db)).toEqual(before);
  },
  limit,
);

for (const fault of ["company-delete", "expired", "option", "retired", "aborted"] as const)
  it(
    "4I24 delayed SDK preparation rechecks " + fault + " at the actual start",
    async () => {
      const { g, command, current } = ownerFixture22();
      let checked = false;
      const network = vi.fn(async () => new Response("{}"));
      const driver = createSyntheticComparisonSdkDriver(
        (o) => ({
          responses: {
            create: async (body) => {
              await Promise.resolve();
              const wire: Record<string, unknown> = sdkWire24(body);
              if (fault === "company-delete")
                g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
              if (fault === "expired") vi.setSystemTime(command.approval.expiresAt);
              if (fault === "option")
                wire.body = JSON.stringify({ ...body, service_tier: "default" });
              if (fault === "retired") execution.retire();
              if (fault === "aborted") {
                const c = new AbortController();
                c.abort();
                wire.signal = c.signal;
              }
              await expect(
                Promise.resolve().then(() => o.fetch("https://api.openai.com/v1/responses", wire)),
              ).rejects.toThrow(/START_REFUSED/);
              checked = true;
              throw Error("no decoded response");
            },
          },
        }),
        network,
      );
      const execution = createIsolatedPublicComparisonExecution(g.session, g.cap, driver);
      const view = await execution.execute(command, current);
      expect(checked).toBe(true);
      expect(view).toMatchObject({
        phase: "recovery-required",
        startAttempted: false,
        capturePersisted: false,
        sdkSettled: true,
        promiseSettled: true,
      });
      expect(network).not.toHaveBeenCalled();
      expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
      expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    },
    limit,
  );

for (const mode of [
  "factory",
  "sync-network",
  "network-reject",
  "parse",
  "sdk-error",
  "getter",
  "oversize",
  "no-response",
] as const)
  it(
    "4I24 SDK-shaped " + mode + " failure keeps an unknown hold and no replacement start",
    async () => {
      const { g, command, current } = ownerFixture22();
      const network = vi.fn(() => {
        if (mode === "sync-network") throw Error("secret sync failure");
        if (mode === "network-reject") return Promise.reject(Error("secret connection failure"));
        return Promise.resolve(
          new Response(mode === "parse" ? "{broken" : "{}", {
            status: mode === "sdk-error" ? 429 : 200,
          }),
        );
      });
      let capturedOptions: SyntheticComparisonSdkOptions | undefined;
      const execution = createIsolatedPublicComparisonExecution(
        g.session,
        g.cap,
        createSyntheticComparisonSdkDriver((o) => {
          capturedOptions = o;
          if (mode === "factory") throw Error("secret factory failure");
          return {
            responses: {
              create: async (body) => {
                if (mode === "no-response") return response; // No guarded Response: not a provider observation.
                const raw = await o.fetch("https://api.openai.com/v1/responses", sdkWire24(body));
                if (!raw.ok) throw Error("secret SDK body");
                await raw.json();
                if (mode === "getter")
                  return Object.defineProperty({ ...response }, "output", {
                    get() {
                      throw Error("getter must not run");
                    },
                  });
                if (mode === "oversize")
                  return {
                    ...response,
                    output: [
                      {
                        type: "message",
                        content: [{ type: "output_text", text: "x".repeat(4 * 1024 * 1024) }],
                      },
                    ],
                  };
                return response;
              },
            },
          };
        }, network),
      );
      const view = await execution.execute(command, current);
      expect(view).toMatchObject({
        phase: "recovery-required",
        capturePersisted: false,
        retainedCaptureCount: 0,
        sdkSettled: true,
        promiseSettled: true,
        owner: null,
      });
      expect(network).toHaveBeenCalledTimes(mode === "factory" || mode === "no-response" ? 0 : 1);
      expect(JSON.stringify(view)).not.toMatch(/secret|authorization|rawBody|output_text/);
      expect(() =>
        capturedOptions!.fetch("https://api.openai.com/v1/responses", sdkWire24({})),
      ).toThrow(/START_REFUSED/);
      const s = state13(g);
      expect(s.reservation.archive.financial.events).toHaveLength(1);
      expect(s.reservation.archive.records.events.at(-1)!.payload.kind).toBe("dispatch-unknown");
      const before = snapshot(g.db);
      expect(
        execution.recover({ runId: command.runId, dispatchCommandDigest: digest(command) }).phase,
      ).toBe("recovery-required");
      expect(snapshot(g.db)).toEqual(before);
      expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    },
    limit,
  );

for (const mode of ["refusal", "incomplete", "zero"] as const)
  it(
    "4I24 decoded " + mode + " capture is independent of SDK-shaped network completion",
    async () => {
      const { g, command, current } = ownerFixture22();
      const value = {
        ...response,
        status: mode === "incomplete" ? "incomplete" : "completed",
        usage:
          mode === "zero"
            ? {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              }
            : response.usage,
        output:
          mode === "refusal"
            ? [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }]
            : [],
      };
      const execution = createIsolatedPublicComparisonExecution(
        g.session,
        g.cap,
        createSyntheticComparisonSdkDriver(
          (o) => ({
            responses: {
              create: async (body) => {
                const raw = await o.fetch("https://api.openai.com/v1/responses", sdkWire24(body));
                return raw.json();
              },
            },
          }),
          async () => new Response(JSON.stringify(value)),
        ),
      );
      expect(await execution.execute(command, current)).toMatchObject({
        phase: "closed",
        capturePersisted: true,
        networkSettled: true,
        sdkSettled: true,
        owner: null,
      });
      expect(state13(g).reservation.archive.financial.events).toHaveLength(1); // Capture is not settlement.
      if (mode === "zero") {
        result13(g);
        const close = closeInput(g);
        expect(
          writeGuardedPublicComparisonV13(
            g.session,
            "settle-finalize",
            close.command,
            close.current,
          ).status,
        ).toBe("committed");
        expect(state13(g).reservation.archive.records.events.at(-1)!.payload.kind).toBe(
          "finalized",
        );
      }
    },
    limit,
  );

for (const mode of ["timeout-before-response", "decode-after-driver-error"] as const)
  it(
    "4I24 " + mode + " retains every acquired promise and the original late capture",
    async () => {
      const { g, command, current } = ownerFixture22();
      const ready = deferred22<void>(),
        net = deferred22<Response>(),
        decoding = deferred22<unknown>();
      let options!: SyntheticComparisonSdkOptions, hooks!: SyntheticComparisonHooks;
      const adapter = createSyntheticComparisonSdkDriver(
        (o) => {
          options = o;
          return {
            responses: {
              create: (body) => {
                const received = o.fetch("https://api.openai.com/v1/responses", sdkWire24(body));
                void received.catch(() => undefined); // synthetic timeout may finish before the underlying request.
                return mode === "timeout-before-response"
                  ? decoding.promise
                  : received.then(() => decoding.promise);
              },
            },
          };
        },
        () => {
          ready.resolve();
          return net.promise;
        },
      );
      const driver =
        mode === "decode-after-driver-error"
          ? createSyntheticComparisonDriver((b, h) => {
              hooks = h;
              void requireSyntheticComparisonDriver(adapter)(b, h);
              throw Error("driver failed after acquiring both promises");
            })
          : adapter;
      const execution = createIsolatedPublicComparisonExecution(g.session, g.cap, driver);
      const running = execution.execute(command, current);
      await Promise.race([
        ready.promise,
        running.then(() => {
          throw Error("never started");
        }),
      ]);
      if (mode === "timeout-before-response") {
        decoding.reject(Error("synthetic SDK timeout"));
        await tick24();
        expect(execution.inspect()).toMatchObject({
          sdkSettled: true,
          networkSettled: true, // Fast rejection is separate from the original fetch below.
          ioSettled: false,
          promiseSettled: false,
          capturePersisted: false,
        });
        expect(execution.retire().phase).toBe("draining");
        expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
        net.resolve(new Response(JSON.stringify(response)));
      } else {
        net.resolve(new Response("{}"));
        await tick24();
        expect(execution.inspect()).toMatchObject({
          networkSettled: true,
          sdkSettled: false,
          promiseSettled: false,
          capturePersisted: false,
        });
        expect(() =>
          hooks.sdk(
            async () => response,
            async () => new Response("{}"),
          ),
        ).toThrow(/SDK_REFUSED/);
        expect(() => options.fetch("https://api.openai.com/v1/responses", sdkWire24({}))).toThrow(
          /START_REFUSED/,
        );
        execution.retire();
        g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
        vi.setSystemTime(later);
        decoding.resolve(response);
      }
      const view = await running;
      expect(view).toMatchObject({
        phase: mode === "timeout-before-response" ? "recovery-required" : "closed",
        promiseSettled: true,
        capturePersisted: mode === "decode-after-driver-error",
        networkSettled: true,
        sdkSettled: true,
      });
      expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
      if (mode === "timeout-before-response") {
        const before = snapshot(g.db);
        expect(
          execution.recover({ runId: command.runId, dispatchCommandDigest: digest(command) }).phase,
        ).toBe("recovery-required");
        expect(snapshot(g.db)).toEqual(before);
      }
    },
    limit,
  );

it(
  "4I24 first decoded callback snapshots synchronously and a repeated callback cannot replace it",
  async () => {
    const { g, command, current } = ownerFixture22();
    let callbackVerified = false;
    let lateCallback!: (value: unknown) => unknown;
    const initial = structuredClone(response);
    const execution = createIsolatedPublicComparisonExecution(
      g.session,
      g.cap,
      createSyntheticComparisonSdkDriver(
        (o) => ({
          responses: {
            create: (body) => {
              const responseReady = o.fetch("https://api.openai.com/v1/responses", sdkWire24(body));
              const hostileThenable = {
                then(onValue: (v: unknown) => unknown) {
                  lateCallback = onValue;
                  return responseReady.then(() => {
                    onValue(initial);
                    expect(execution.inspect()).toMatchObject({
                      capturePersisted: true,
                      retainedCaptureCount: 1,
                    });
                    initial.id = "mutated-after-callback";
                    onValue({ ...response, id: "replacement" });
                    expect(execution.inspect().retainedCaptureCount).toBe(1);
                    callbackVerified = true;
                  });
                },
              };
              // Synthetic protocol violation deliberately calls the registered callback twice.
              return hostileThenable as PromiseLike<unknown>;
            },
          },
        }),
        async () => new Response("{}"),
      ),
    );
    const view = await execution.execute(command, current);
    expect(callbackVerified).toBe(true);
    expect(view).toMatchObject({ phase: "closed", capturePersisted: true });
    lateCallback({ ...response, id: "late-after-closed" });
    expect(execution.inspect()).toEqual(view);
    const stored = state13(g).reservation.archive.records.artifacts.filter(
      (a) => a.runId === command.runId && a.key === "comparison-response",
    );
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].body)).toEqual(response);
  },
  limit,
);

for (const surface of ["execution", "service"] as const)
for (const fault of [
  "dispatch-commit",
  "dispatch-ack",
  "capture-commit",
  "capture-ack",
  "capture-insert",
  "read-rollback",
  "lease-close",
] as const)
  it(
    (surface === "service" ? "4I28 service fault " : "4I24 SDK-shaped ") +
      fault +
      " failure preserves nonce bytes and recovers only storage acknowledgements",
    async () => {
      const { g, command, current } = ownerFixture22();
      let capturePhase = false,
        hit = false,
        restoreEnd: (() => void) | undefined;
      let insert: ReturnType<typeof injectInsert> | undefined;
      const exec = g.db.exec.bind(g.db);
      const sql = vi.spyOn(g.db, "exec").mockImplementation((statement) => {
        if (capturePhase && fault === "read-rollback" && statement === "ROLLBACK") {
          hit = true;
          throw Error("read release failed");
        }
        exec(statement);
        if (
          !hit &&
          statement === "COMMIT" &&
          ((fault === "dispatch-commit" && !capturePhase) ||
            (fault === "capture-commit" && capturePhase))
        ) {
          hit = true;
          throw Error("COMMIT return lost");
        }
      });
      const io = vi
        .spyOn(journalIO, "writeJournalJson")
        .mockImplementation((file, value, ...args) => {
          if (
            (value as { payload: { type: string } }).payload.type === "ack" &&
            ((fault === "dispatch-ack" && !capturePhase) ||
              (fault === "capture-ack" && capturePhase))
          ) {
            hit = true;
            throw Error("ack return lost");
          }
          return originalWrite(file, value, ...args);
        });
      const network = vi.fn(() => {
        if (fault === "read-rollback") capturePhase = true;
        if (fault === "lease-close") {
          const spy = vi
            .spyOn(storageWitness22, "endComparisonStorageSession")
            .mockImplementation(() => {
              hit = true;
              throw Error("close failed");
            });
          restoreEnd = () => spy.mockRestore();
        }
        return Promise.resolve(new Response("{}"));
      });
      const factory = vi.fn((o: SyntheticComparisonSdkOptions) => ({
        responses: {
          create: async (body: PublicComparisonTransportBoundary["body"]) => {
            const raw = await o.fetch("https://api.openai.com/v1/responses", sdkWire24(body));
            await raw.json();
            capturePhase = true;
            if (fault === "capture-insert") {
              insert = injectInsert(g.db, 2);
              hit = true;
            }
            return response;
          },
        },
      }));
      const driver = createSyntheticComparisonSdkDriver(factory, network);
      const service = surface === "service"
        ? createIsolatedPublicComparisonService(g.session, g.cap, driver) : undefined;
      const execution = service ?? createIsolatedPublicComparisonExecution(g.session, g.cap, driver);
      const view = await execution.execute(command, current);
      expect(hit).toBe(true);
      expect(view).toMatchObject({
        phase: "recovery-required",
        retainedCaptureCount: fault.startsWith("dispatch") ? 0 : 1,
        owner: null,
      });
      expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
      if (service) {
        expect(service.retire()).toMatchObject({ status: "draining", activeCalls: 0 });
        expect(() => service.recover({ runId: randomUUID(), dispatchCommandDigest: digest(command) }))
          .toThrow(/OWNER_REQUIRED/);
        expect(() => service.recover({ runId: command.runId, dispatchCommandDigest: digest(command),
          capture: response })).toThrow();
      }
      sql.mockRestore();
      io.mockRestore();
      insert?.mockRestore();
      restoreEnd?.();
      const before = snapshot(g.db);
      const recovered = execution.recover({
        runId: command.runId,
        dispatchCommandDigest: digest(command),
      });
      if (fault !== "read-rollback") expect(snapshot(g.db)).toEqual(before);
      if (fault.startsWith("dispatch")) {
        expect(factory).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
        expect(recovered.phase).toBe(service ? "draining" : "recovery-required");
      } else if (fault === "capture-insert") {
        expect(recovered).toMatchObject({
          phase: "recovery-required",
          retainedCaptureCount: 1,
          capturePersisted: false,
        });
      } else {
        expect(recovered).toMatchObject({
          phase: "closed",
          capturePersisted: true,
          retainedCaptureCount: 0,
        });
        const after = snapshot(g.db);
        expect(() =>
          execution.recover({ runId: command.runId, dispatchCommandDigest: digest(command) }),
        ).toThrow(surface === "service" ? /SERVICE_CLOSED/ : /OWNER_REQUIRED/);
        expect(snapshot(g.db)).toEqual(after);
      }
      if (service) {
        const unresolved = fault.startsWith("dispatch") || fault === "capture-insert";
        expect(service.inspect().status).toBe(unresolved ? "draining" : "closed");
        if (!fault.startsWith("dispatch") && fault !== "capture-insert") {
          const artifacts = state13(g).reservation.archive.records.artifacts
            .filter((a) => a.runId === command.runId && a.key === "comparison-response");
          expect(artifacts).toHaveLength(1);
          expect(JSON.parse(artifacts[0].body)).toEqual(response);
        }
        if (unresolved) expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
      }
      expect(network.mock.calls.length).toBeLessThanOrEqual(1);
    },
    limit,
  );

for (const mode of ["toJSON", "cyclic"] as const)
  it(
    "4I24 decoded " + mode + " is rejected without executing unsafe response serialization",
    async () => {
      const { g, command, current } = ownerFixture22();
      let executed = false;
      const value: Record<string, unknown> = { ...response };
      if (mode === "toJSON")
        value.output = [
          {
            toJSON() {
              executed = true;
              return response;
            },
          },
        ];
      else value.output = [value];
      const network = vi.fn(async () => new Response("{}"));
      const execution = createIsolatedPublicComparisonExecution(
        g.session,
        g.cap,
        createSyntheticComparisonSdkDriver(
          (o) => ({
            responses: {
              create: async (body) => {
                await o.fetch("https://api.openai.com/v1/responses", sdkWire24(body));
                return value;
              },
            },
          }),
          network,
        ),
      );
      expect(await execution.execute(command, current)).toMatchObject({
        phase: "recovery-required",
        capturePersisted: false,
        retainedCaptureCount: 0,
        promiseSettled: true,
      });
      expect(executed).toBe(false);
      expect(network).toHaveBeenCalledTimes(1);
      expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
      expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    },
    limit,
  );

for (const wrongPort of ["network-json", "sdk-response"] as const)
  it(
    "4I24 mismatched " + wrongPort + " never substitutes one completion boundary for the other",
    async () => {
      const { g, command, current } = ownerFixture22();
      const network = vi.fn(async () =>
        wrongPort === "network-json" ? (response as unknown as Response) : new Response("{}"),
      );
      const execution = createIsolatedPublicComparisonExecution(
        g.session,
        g.cap,
        createSyntheticComparisonSdkDriver(
          (o) => ({
            responses: {
              create: async (body) => {
                const raw = await o.fetch("https://api.openai.com/v1/responses", sdkWire24(body));
                return wrongPort === "sdk-response" ? raw : response;
              },
            },
          }),
          network,
        ),
      );
      expect(await execution.execute(command, current)).toMatchObject({
        phase: "recovery-required",
        capturePersisted: false,
        retainedCaptureCount: 0,
        networkSettled: true,
        sdkSettled: true,
        promiseSettled: true,
        owner: null,
      });
      expect(network).toHaveBeenCalledTimes(1);
      expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
      expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    },
    limit,
  );

// 4I26: bounded Response and original I/O termination, same SQL13 lease and writer.
function bodyTimers26() {
  const at = Date.now();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(at);
  cleanups.push(() => {
    vi.clearAllTimers();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixture.at);
  });
}
it("4I26 bounded EOF precedes SDK decode and original hold survives missing usage", async () => {
  const { g, command, current } = ownerFixture22();
  const ready = deferred22<void>(), decoded = deferred22<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let options!: SyntheticComparisonSdkOptions, signal!: AbortSignal;
  const payload = JSON.stringify({ ...response, usage: undefined });
  const network = vi.fn((_url: unknown, wire: RequestInit) => {
    expect(wire.signal).toBe(signal);
    expect(g.db.isTransaction).toBe(true);
    ready.resolve();
    return Promise.resolve(new Response(new ReadableStream({
      start(c) { stream = c; },
    }), { headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": "1" } }));
  });
  const execution = createIsolatedPublicComparisonExecution(g.session, g.cap,
    createSyntheticComparisonSdkDriver((o) => {
      options = o;
      return { responses: { create: async (body, request) => {
        signal = request.signal;
        expect(Object.keys(request)).toEqual(["signal"]);
        const bounded = await o.fetch("https://api.openai.com/v1/responses",
          { ...sdkWire24(body), signal });
        expect(bounded.headers.has("content-encoding")).toBe(false);
        expect(bounded.headers.get("content-length")).toBe(String(Buffer.byteLength(payload)));
        decoded.resolve();
        return bounded.json();
      } } };
    }, network));
  const running = execution.execute(command, current);
  await Promise.race([ready.promise, running.then(() => { throw Error("start missing"); })]);
  await tick24();
  stream.enqueue(new TextEncoder().encode(payload.slice(0, 10)));
  await tick24();
  expect(execution.inspect()).toMatchObject({ networkSettled: false, ioSettled: false, capturePersisted: false });
  expect(g.db.isTransaction).toBe(false);
  expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  stream.enqueue(new TextEncoder().encode(payload.slice(10)));
  stream.close();
  await decoded.promise;
  expect(await running).toMatchObject({ phase: "closed", ioSettled: true, capturePersisted: true, owner: null });
  expect(network).toHaveBeenCalledTimes(1);
  expect(() => options.fetch("https://api.openai.com/v1/responses", sdkWire24({}))).toThrow(/START_REFUSED/);
  result13(g);
  const close = closeInput(g);
  expect(writeGuardedPublicComparisonV13(g.session, "settle-finalize", close.command, close.current).status).toBe("blocked");
}, limit);

for (const mode of ["success-overflow", "error-overflow", "error-json", "malformed-json"] as const)
  it("4I26 bounded " + mode + " cannot produce capture or release hold", async () => {
    const { g, command, current } = ownerFixture22();
    let parsed = false;
    const status = mode.startsWith("error") ? 503 : 200;
    const content = mode.endsWith("overflow")
      ? new Uint8Array((status === 200 ? 4 * 1024 * 1024 : 64 * 1024) + 1)
      : mode === "error-json" ? JSON.stringify(response) : "{";
    const network = vi.fn(async () => new Response(content, { status }));
    const execution = createIsolatedPublicComparisonExecution(g.session, g.cap,
      createSyntheticComparisonSdkDriver((o) => ({ responses: {
        create: async (body, request) => {
          const raw = await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal: request.signal });
          parsed = true;
          return raw.json(); // Even a bad synthetic SDK cannot turn HTTP error JSON into capture.
        },
      } }), network));
    expect(await execution.execute(command, current)).toMatchObject({
      phase: "recovery-required", capturePersisted: false, retainedCaptureCount: 0,
      ioSettled: true, sdkSettled: true, promiseSettled: true, owner: null,
    });
    expect(parsed).toBe(!mode.endsWith("overflow"));
    expect(network).toHaveBeenCalledTimes(1);
    expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
    expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  }, limit);

for (const outcome of ["resolved", "rejected"] as const)
  it("4I26 timeout waits for original cancel " + outcome + " without closing lease", async () => {
    const { g, command, current } = ownerFixture22();
    bodyTimers26();
    const ready = deferred22<void>(), cancelled = deferred22<void>();
    const cancel = vi.fn(() => cancelled.promise);
    const network = vi.fn(async () => {
      ready.resolve();
      return new Response(new ReadableStream({ cancel }));
    });
    const execution = createIsolatedPublicComparisonExecution(g.session, g.cap,
      createSyntheticComparisonSdkDriver((o) => ({ responses: {
        create: async (body, request) => (await o.fetch("https://api.openai.com/v1/responses",
          { ...sdkWire24(body), signal: request.signal })).json(),
      } }), network));
    const running = execution.execute(command, current), finished = vi.fn();
    void running.then(finished);
    await Promise.race([ready.promise, running.then(() => { throw Error("start missing"); })]);
    await tick24();
    await vi.advanceTimersByTimeAsync(120000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(execution.inspect()).toMatchObject({
      phase: "recovery-required", networkSettled: true, sdkSettled: true, ioSettled: false,
      promiseSettled: false, capturePersisted: false,
    });
    expect(finished).not.toHaveBeenCalled();
    expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    if (outcome === "resolved") cancelled.resolve();
    else cancelled.reject(Error("private cancellation failure"));
    const view = await running;
    expect(view).toMatchObject({ phase: "recovery-required", ioSettled: true, promiseSettled: true, capturePersisted: false });
    expect(JSON.stringify(view)).not.toContain("private");
    const before = snapshot(g.db);
    expect(execution.recover({ runId: command.runId, dispatchCommandDigest: digest(command) }).phase).toBe("recovery-required");
    expect(snapshot(g.db)).toEqual(before);
    expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
  }, limit);

it("4I26 timeout retains original pending fetch and cancels its late Response once", async () => {
  const { g, command, current } = ownerFixture22();
  bodyTimers26();
  const ready = deferred22<void>(), net = deferred22<Response>(), cancelled = deferred22<void>();
  const cancel = vi.fn(() => cancelled.promise), parse = vi.fn();
  const execution = createIsolatedPublicComparisonExecution(g.session, g.cap,
    createSyntheticComparisonSdkDriver((o) => ({ responses: {
      create: async (body, request) => {
        const raw = await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal: request.signal });
        parse(); return raw.json();
      },
    } }), () => { ready.resolve(); return net.promise; }));
  const running = execution.execute(command, current);
  await Promise.race([ready.promise, running.then(() => { throw Error("start missing"); })]);
  await vi.advanceTimersByTimeAsync(120000);
  expect(execution.inspect()).toMatchObject({ ioSettled: false, sdkSettled: true, promiseSettled: false });
  net.resolve(new Response(new ReadableStream({ cancel })));
  await tick24();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(parse).not.toHaveBeenCalled();
  expect(execution.inspect().ioSettled).toBe(false);
  cancelled.resolve();
  expect(await running).toMatchObject({ phase: "recovery-required", ioSettled: true, capturePersisted: false });
  expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
}, limit);

it("4I26 original SDK late JSON after bounded body deadline is captured before current checks", async () => {
  const { g, command, current } = ownerFixture22();
  bodyTimers26();
  const delivered = deferred22<void>(), decoded = deferred22<unknown>(), drain = deferred22<void>();
  let signal!: AbortSignal;
  const adapter = createSyntheticComparisonSdkDriver((o) => ({ responses: {
    create: async (body, request) => {
      signal = request.signal;
      await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal });
      delivered.resolve();
      return decoded.promise;
    },
  } }), async () => new Response("{}"));
  const execution = createIsolatedPublicComparisonExecution(g.session, g.cap,
    createSyntheticComparisonDriver(async (b, h) => {
      await requireSyntheticComparisonDriver(adapter)(b, h);
      await drain.promise;
    }));
  const running = execution.execute(command, current);
  await Promise.race([delivered.promise, running.then(() => { throw Error("delivery missing"); })]);
  await vi.advanceTimersByTimeAsync(120000);
  expect(signal.aborted).toBe(true);
  g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
  vi.setSystemTime(later);
  decoded.resolve(response);
  await tick24();
  expect(execution.inspect()).toMatchObject({ capturePersisted: true, retainedCaptureCount: 1, promiseSettled: false, ioSettled: true });
  expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  drain.resolve();
  expect(await running).toMatchObject({ phase: "closed", capturePersisted: true, promiseSettled: true });
}, limit);

it("4I26 preparation deadline cannot start a new underlying request", async () => {
  const { g, command, current } = ownerFixture22();
  bodyTimers26();
  const network = vi.fn(async () => new Response("{}"));
  let aborted = false;
  const execution = createIsolatedPublicComparisonExecution(g.session, g.cap,
    createSyntheticComparisonSdkDriver((o) => ({ responses: {
      create: async (body, request) => {
        await vi.advanceTimersByTimeAsync(120000);
        aborted = request.signal.aborted;
        return (await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal: request.signal })).json();
      },
    } }), network));
  expect(await execution.execute(command, current)).toMatchObject({
    phase: "recovery-required", capturePersisted: false, startAttempted: false, ioSettled: true,
  });
  expect(aborted).toBe(true);
  expect(network).not.toHaveBeenCalled();
}, limit);

it("4I26 additional SDK-composed signal keeps wire identity and propagates one timeout cancellation", async () => {
  const { g, command, current } = ownerFixture22();
  bodyTimers26();
  const ready = deferred22<void>(), cancelDone = deferred22<void>();
  const cancel = vi.fn(() => cancelDone.promise);
  let caller!: AbortSignal, sdkSignal!: AbortSignal;
  const network = vi.fn(async (_url: unknown, wire: RequestInit) => {
    expect(wire.signal).toBe(sdkSignal);
    expect(wire.signal).not.toBe(caller);
    ready.resolve();
    return new Response(new ReadableStream({ cancel }));
  });
  const execution = createIsolatedPublicComparisonExecution(g.session, g.cap,
    createSyntheticComparisonSdkDriver((o) => ({ responses: {
      create: async (body, request) => {
        caller = request.signal;
        const sdkController = new AbortController();
        sdkSignal = sdkController.signal;
        caller.addEventListener("abort", () => sdkController.abort(), { once: true });
        return (await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal: sdkSignal })).json();
      },
    } }), network));
  const running = execution.execute(command, current);
  await Promise.race([ready.promise, running.then(() => { throw Error("start missing"); })]);
  await tick24();
  await vi.advanceTimersByTimeAsync(120000);
  expect(caller.aborted).toBe(true);
  expect(sdkSignal.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(execution.inspect()).toMatchObject({ ioSettled: false, promiseSettled: false });
  cancelDone.resolve();
  expect(await running).toMatchObject({ phase: "recovery-required", ioSettled: true, capturePersisted: false });
  expect(network).toHaveBeenCalledTimes(1);
}, limit);

for (const mode of ["content-type", "transform"] as const)
  it("4I26 additional SDK-shaped " + mode + " failure after bounded EOF keeps unknown hold", async () => {
    const { g, command, current } = ownerFixture22();
    let boundedRead = false;
    let received: Response | undefined;
    const raw = new Response(JSON.stringify(response), {
      headers: { "content-type": mode === "content-type" ? "text/plain" : "application/json" },
    });
    const execution = createIsolatedPublicComparisonExecution(g.session, g.cap,
      createSyntheticComparisonSdkDriver((o) => ({ responses: {
        create: async (body, request) => {
          const bounded = await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal: request.signal });
          boundedRead = true;
          received = bounded;
          if (mode === "content-type") return bounded.text();
          await bounded.json();
          throw Error("private synthetic transform error");
        },
      } }), async () => raw));
    const view = await execution.execute(command, current);
    expect(view).toMatchObject({ phase: "recovery-required", ioSettled: true,
      capturePersisted: false, retainedCaptureCount: 0, promiseSettled: true });
    expect(boundedRead).toBe(true);
    expect(received).not.toBe(raw);
    expect(raw.bodyUsed).toBe(true);
    expect(received!.headers.get("content-type")).toBe(mode === "content-type" ? "text/plain" : "application/json");
    expect(JSON.stringify(view)).not.toContain("private synthetic");
    expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
    expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  }, limit);

it("4I28 service pins original execution through duplicate observation, retire and late capture", async () => {
  const { g, command, current } = ownerFixture22();
  const ready = deferred22<void>(), net = deferred22<Response>();
  const network = vi.fn(() => { ready.resolve(); return net.promise; });
  const factory = vi.fn((o: SyntheticComparisonSdkOptions) => ({ responses: {
    create: async (body: PublicComparisonTransportBoundary["body"], request: { signal: AbortSignal }) =>
      (await o.fetch("https://api.openai.com/v1/responses",
        { ...sdkWire24(body), signal: request.signal })).json(),
  } }));
  const driver = createSyntheticComparisonSdkDriver(factory, network);
  const service = createIsolatedPublicComparisonService(g.session, g.cap, driver);
  const running = service.execute(command, current);
  await Promise.race([ready.promise, running.then(() => { throw Error("start missing"); })]);
  expect(service.inspect()).toMatchObject({ status: "ready", activeCalls: 1,
    execution: { capturePersisted: false, ioSettled: false }, owner: null, runtimeObserved: false });
  const replacement = createIsolatedPublicComparisonService(g.session, g.cap,
    createSyntheticComparisonDriver(async () => { throw Error("replacement must not start"); }));
  expect(await replacement.execute(command, explode())).toMatchObject({
    phase: "start-refused", dispatchCommitObserved: false, startAttempted: false,
  });
  expect(replacement.retire().status).toBe("closed");
  expect((await service.execute(command, explode())).phase).toBe("in-flight");
  expect(service.inspect().activeCalls).toBe(1);
  await expect(service.execute({ ...command, clientRequestId: randomUUID() }, explode())).rejects.toThrow();
  expect(service.inspect().activeCalls).toBe(1);
  expect(service.retire()).toMatchObject({ status: "draining", activeCalls: 1 });
  expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
  vi.setSystemTime(later);
  net.resolve(new Response(JSON.stringify({ ...response, usage: undefined })));
  expect(await running).toMatchObject({ phase: "closed", capturePersisted: true, promiseSettled: true });
  expect(service.inspect()).toMatchObject({ status: "closed", activeCalls: 0,
    execution: { retainedCaptureCount: 0, ioSettled: true } });
  await expect(service.execute(command, current)).rejects.toThrow(/SERVICE_RETIRED/);
  expect(() => service.recover({ runId: command.runId, dispatchCommandDigest: digest(command) }))
    .toThrow(/SERVICE_CLOSED/);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledTimes(1);
  const before = snapshot(g.db);
  const reopened = openComparisonStorageSession(g.paths, selection);
  cleanups.push(() => closeComparisonStorageSession(reopened));
  const next = createIsolatedPublicComparisonService(reopened, g.cap, driver);
  expect(next).not.toBe(service);
  expect(await next.execute(command, explode())).toMatchObject({ phase: "replay", startAttempted: false });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(next.retire().status).toBe("closed");
  expect(snapshot(g.db)).toEqual(before);
  expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
}, limit);

it("4I28 service cannot release unknown with no capture and all visible promises settled", async () => {
  const { g, command, current } = ownerFixture22();
  const network = vi.fn(async () => new Response(JSON.stringify(response), { status: 503 }));
  const driver = createSyntheticComparisonSdkDriver((o) => ({ responses: {
    create: async (body, request) => (await o.fetch("https://api.openai.com/v1/responses",
      { ...sdkWire24(body), signal: request.signal })).json(),
  } }), network);
  const service = createIsolatedPublicComparisonService(g.session, g.cap, driver);
  expect(await service.execute(command, current)).toMatchObject({
    phase: "recovery-required", retainedCaptureCount: 0, promiseSettled: true,
    sdkSettled: true, ioSettled: true, capturePersisted: false,
  });
  expect(service.retire()).toMatchObject({ status: "draining", activeCalls: 0 });
  expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  const before = snapshot(g.db);
  service.recover({ runId: command.runId, dispatchCommandDigest: digest(command) });
  expect(service.inspect().status).toBe("draining");
  expect(snapshot(g.db)).toEqual(before);
  expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
  expect(network).toHaveBeenCalledTimes(1);
  const safe = JSON.stringify(service.inspect());
  for (const privateValue of [comparisonSyntheticWireKey, directory, JSON.stringify(response)])
    expect(safe).not.toContain(privateValue);
  expect(() => service.previewPostcapture({ runId: command.runId, dispatchCommandDigest: digest(command) })).toThrow(/EXECUTION_PENDING/);
  expect(() => service.readStoredComparison({})).toThrow(/EXECUTION_PENDING/);
  expect(() => service.inspectStoredComparisonContext({})).toThrow(/EXECUTION_PENDING/);
  expect(() => service.readStoredReviewByRun({})).toThrow(/EXECUTION_PENDING/);
  expect(Object.keys(service)).toEqual(["execute", "recover", "previewPostcapture", "readStoredReviewByRun", "readStoredComparison", "inspectStoredComparisonContext", "writePostcapture", "recoverPostcapture", "inspect", "retire"]);
}, limit);

for (const mode of ["unused", "invalid-command"] as const)
  it("4I28 service safely retires " + mode + " without deriving authority from public phase", async () => {
    const { g, current } = ownerFixture22();
    const start = vi.fn(async () => {});
    const service = createIsolatedPublicComparisonService(g.session, g.cap, createSyntheticComparisonDriver(start));
    if (mode === "invalid-command")
      expect(await service.execute({}, current)).toMatchObject({ phase: "start-refused", dispatchCommitObserved: false });
    expect(service.retire().status).toBe("closed");
    expect(start).not.toHaveBeenCalled();
    beginComparisonStorageSession(g.session);
    endComparisonStorageSession(g.session);
  }, limit);

for (const composition of ["any", "listener"] as const)
for (const abortSource of ["app", "sdk"] as const)
  it("4I28 service " + composition + " signal " + abortSource + " abort retains pending fetch and cancel", async () => {
    const { g, command, current } = ownerFixture22();
    bodyTimers26();
    const ready = deferred22<void>(), net = deferred22<Response>(), cancelled = deferred22<void>();
    const cancel = vi.fn(() => cancelled.promise), parser = vi.fn();
    let caller!: AbortSignal, wireSignal!: AbortSignal;
    const sdkController = new AbortController();
    let forwarded: (() => void) | undefined;
    let wireVerified = false;
    const network = vi.fn((_url: unknown, wire: RequestInit) => {
      wireVerified = wire.signal === wireSignal && wire.signal !== caller && g.db.isTransaction;
      ready.resolve(); return net.promise;
    });
    const service = createIsolatedPublicComparisonService(g.session, g.cap,
      createSyntheticComparisonSdkDriver((o) => ({ responses: {
        create: async (body, request) => {
          caller = request.signal;
          if (composition === "any") wireSignal = AbortSignal.any([caller, sdkController.signal]);
          else {
            forwarded = () => sdkController.abort();
            caller.addEventListener("abort", forwarded, { once: true });
            wireSignal = sdkController.signal;
          }
          try {
            const raw = await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal: wireSignal });
            parser(); return raw.json();
          } finally {
            if (forwarded) caller.removeEventListener("abort", forwarded);
          }
        },
      } }), network));
    const running = service.execute(command, current);
    await Promise.race([ready.promise, running.then(() => { throw Error("start missing"); })]);
    expect(wireVerified).toBe(true);
    if (abortSource === "app") await vi.advanceTimersByTimeAsync(120000);
    else { sdkController.abort(); await tick24(); }
    expect(caller.aborted).toBe(true);
    expect(wireSignal.aborted).toBe(true);
    expect(service.retire()).toMatchObject({ status: "draining", activeCalls: 1,
      execution: { ioSettled: false, capturePersisted: false } });
    net.resolve(new Response(new ReadableStream({ cancel })));
    await tick24();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(parser).not.toHaveBeenCalled();
    expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    cancelled.resolve();
    expect(await running).toMatchObject({ phase: "recovery-required", ioSettled: true, capturePersisted: false });
    expect(service.inspect()).toMatchObject({ status: "draining", activeCalls: 0 });
    expect(network).toHaveBeenCalledTimes(1);
    expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
  }, limit);

it("4I28 service retains late SDK capture and caller projection failure until original driver ends", async () => {
  const { g, command, current } = ownerFixture22();
  bodyTimers26();
  const delivered = deferred22<void>(), decoded = deferred22<unknown>(), drain = deferred22<void>();
  const network = vi.fn(async () => new Response("{}"));
  const adapter = createSyntheticComparisonSdkDriver((o) => ({ responses: {
    create: async (body, request) => {
      await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal: request.signal });
      delivered.resolve(); return decoded.promise;
    },
  } }), network);
  const service = createIsolatedPublicComparisonService(g.session, g.cap,
    createSyntheticComparisonDriver(async (b, h) => {
      await requireSyntheticComparisonDriver(adapter)(b, h); await drain.promise;
    }));
  const running = service.execute(command, current);
  const projection = running.then(() => { throw Error("synthetic caller projection failed"); }).catch(() => "failed");
  await Promise.race([delivered.promise, running.then(() => { throw Error("delivery missing"); })]);
  expect(service.retire().status).toBe("draining");
  await vi.advanceTimersByTimeAsync(120000);
  decoded.resolve({ ...response, usage: undefined });
  await tick24();
  expect(service.inspect()).toMatchObject({ status: "draining", activeCalls: 1,
    execution: { capturePersisted: true, retainedCaptureCount: 1, promiseSettled: false } });
  expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  expect(() => service.previewPostcapture({ runId: command.runId, dispatchCommandDigest: digest(command) })).toThrow(/EXECUTION_PENDING/);
  drain.resolve();
  expect(await running).toMatchObject({ phase: "closed", capturePersisted: true });
  expect(await projection).toBe("failed");
  expect(service.inspect().status).toBe("closed");
  expect(network).toHaveBeenCalledTimes(1);
  expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
}, limit);

for (const mode of ["parse", "sdk-race"] as const)
  it("4I28 service " + mode + " without delivered JSON retains unknown and never restores a hidden parser", async () => {
    const { g, command, current } = ownerFixture22();
    const hidden = deferred22<unknown>();
    const parsed = vi.fn(), network = vi.fn(async () => new Response(mode === "parse" ? "{" : "{}"));
    const service = createIsolatedPublicComparisonService(g.session, g.cap,
      createSyntheticComparisonSdkDriver((o) => ({ responses: {
        create: async (body, request) => {
          const raw = await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal: request.signal });
          if (mode === "parse") return raw.json();
          return Promise.race([hidden.promise.then((v) => { parsed(); return v; }),
            Promise.reject(Error("private SDK-shaped timeout"))]);
        },
      } }), network));
    expect(await service.execute(command, current)).toMatchObject({ phase: "recovery-required",
      capturePersisted: false, promiseSettled: true });
    const before = snapshot(g.db);
    expect(service.retire()).toMatchObject({ status: "draining", activeCalls: 0 });
    hidden.resolve(response);
    await tick24();
    expect(parsed).toHaveBeenCalledTimes(mode === "sdk-race" ? 1 : 0);
    expect(service.inspect().execution.capturePersisted).toBe(false);
    service.recover({ runId: command.runId, dispatchCommandDigest: digest(command) });
    expect(snapshot(g.db)).toEqual(before);
    expect(service.inspect().status).toBe("draining");
    expect(network).toHaveBeenCalledTimes(1);
    expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
  }, limit);

for (const fault of ["cancel", "release", "listener"] as const)
  it("4I28 service retains sticky " + fault + " cleanup failure after visible completion", async () => {
    const { g, command, current } = ownerFixture22();
    bodyTimers26();
    const ready = deferred22<void>(), cancelled = deferred22<void>();
    let cleanupHit = false;
    const network = vi.fn(async (_url: unknown, wire: RequestInit) => {
      if (fault === "listener")
        vi.spyOn(wire.signal!, "removeEventListener").mockImplementationOnce(() => {
          cleanupHit = true; throw Error("private listener cleanup");
        });
      const stream = new ReadableStream<Uint8Array>({
        start(c) { if (fault !== "cancel") { c.enqueue(new TextEncoder().encode(JSON.stringify(response))); c.close(); } },
        cancel() { cleanupHit = true; return cancelled.promise; },
      });
      if (fault === "release") {
        const originalReader = stream.getReader.bind(stream);
        vi.spyOn(stream, "getReader").mockImplementation(() => {
          const reader = originalReader();
          vi.spyOn(reader, "releaseLock").mockImplementation(() => {
            cleanupHit = true; throw Error("private release cleanup");
          });
          return reader;
        });
      }
      ready.resolve();
      return new Response(stream);
    });
    const service = createIsolatedPublicComparisonService(g.session, g.cap,
      createSyntheticComparisonSdkDriver((o) => ({ responses: {
        create: async (body, request) => (await o.fetch("https://api.openai.com/v1/responses",
          { ...sdkWire24(body), signal: request.signal })).json(),
      } }), network));
    const running = service.execute(command, current);
    await Promise.race([ready.promise, running.then(() => { throw Error("start missing"); })]);
    if (fault === "cancel") {
      await tick24();
      await vi.advanceTimersByTimeAsync(120000);
      expect(service.retire()).toMatchObject({ status: "draining", activeCalls: 1,
        execution: { ioSettled: false } });
      cancelled.reject(Error("private cancel cleanup"));
    } else cancelled.resolve();
    expect(await running).toMatchObject({ phase: "recovery-required", cleanupRequired: true, ioSettled: true });
    expect(cleanupHit).toBe(true);
    expect(service.retire()).toMatchObject({ status: "draining", activeCalls: 0 });
    const before = snapshot(g.db);
    service.recover({ runId: command.runId, dispatchCommandDigest: digest(command) });
    expect(service.inspect().status).toBe("draining");
    expect(snapshot(g.db)).toEqual(before);
    expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
    expect(JSON.stringify(service.inspect())).not.toContain("private");
    expect(network).toHaveBeenCalledTimes(1);
  }, limit);

it("4I28 service waits for original read after cancellation already settled", async () => {
  const { g, command, current } = ownerFixture22();
  bodyTimers26();
  const ready = deferred22<void>(), read = deferred22<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>();
  const released = vi.fn(), cancel = vi.fn(async () => {});
  const raw = new Response(new ReadableStream<Uint8Array>({ cancel }));
  const original = raw.body!.getReader.bind(raw.body!);
  vi.spyOn(raw.body!, "getReader").mockImplementation(() => {
    const reader = original();
    vi.spyOn(reader, "read").mockImplementation(() => { ready.resolve(); return read.promise; });
    const release = reader.releaseLock.bind(reader);
    vi.spyOn(reader, "releaseLock").mockImplementation(() => { released(); release(); });
    return reader;
  });
  const network = vi.fn(async () => raw);
  const service = createIsolatedPublicComparisonService(g.session, g.cap,
    createSyntheticComparisonSdkDriver((o) => ({ responses: {
      create: async (body, request) => (await o.fetch("https://api.openai.com/v1/responses",
        { ...sdkWire24(body), signal: request.signal })).json(),
    } }), network));
  const running = service.execute(command, current);
  await Promise.race([ready.promise, running.then(() => { throw Error("read missing"); })]);
  await vi.advanceTimersByTimeAsync(120000);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(service.retire()).toMatchObject({ status: "draining", activeCalls: 1,
    execution: { ioSettled: false } });
  expect(released).not.toHaveBeenCalled();
  read.resolve({ done: false, value: Uint8Array.of(65) });
  expect(await running).toMatchObject({ phase: "recovery-required", ioSettled: true, capturePersisted: false });
  expect(released).toHaveBeenCalledTimes(1);
  expect(service.inspect()).toMatchObject({ status: "draining", activeCalls: 0 });
  expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  expect(network).toHaveBeenCalledTimes(1);
}, limit);


// 4I30: retained service postcapture handoff; existing SQL13 fixture and writer stay authoritative.
function service30(g: ReturnType<typeof guarded>) {
  const start = vi.fn(async () => { throw Error("storage-only must not start"); });
  const service = createIsolatedPublicComparisonService(g.session, g.cap, createSyntheticComparisonDriver(start));
  const b = state13(g).transmissionBindings[0];
  const selected = { runId: b.runId, dispatchCommandDigest: digest(b.command) };
  return { service, start, selected };
}
function commands30(p: ReturnType<ReturnType<typeof service30>["service"]["previewPostcapture"]>) {
  const common = {
    commandVersion: 1, purpose: "compare-public-claim", runId: p.runId,
    transmissionBindingDigest: p.transmissionBindingDigest, dispatchEventDigest: p.dispatchEventDigest,
    responseArtifactSha256: p.responseArtifactSha256, expectedRunHead: p.expectedRunHead,
  };
  return {
    result: comparisonResultCommandSchema.parse({ ...common, clientRequestId: randomUUID(),
      kind: "record-public-comparison-result", responseArtifactByteLength: p.responseArtifactByteLength,
      expectedValidatedArtifactSha256: p.expectedValidatedArtifactSha256 }),
    close: () => comparisonCloseCommandSchema.parse({ ...common, clientRequestId: randomUUID(),
      kind: "settle-finalize-public-comparison", comparisonEventDigest: p.comparisonEventDigest,
      usagePolicyDigest: p.usage.usagePolicyDigest ?? bad, expectedAssessmentDigest: p.expectedAssessmentDigest ?? bad,
      expectedBudgetHead: p.expectedBudgetHead }),
  };
}
const postLimit30 = 300000; // Several full SQL13 audits/explicit phases in each end-to-end scenario.
it("4I30 storage-only preview is read-only; explicit three/eight rows and old nonce replay remain separate", () => {
  const g = throughCapture(), { service, start, selected } = service30(g);
  const before = snapshot(g.db), files = witnessFiles(g);
  const p = service.previewPostcapture(selected);
  expect(service.previewPostcapture(selected)).toEqual(p);
  expect(snapshot(g.db)).toEqual(before);
  expect(witnessFiles(g)).toEqual(files);
  const command = commands30(p).result, current = { at: later, eventId: randomUUID() };
  expect(service.writePostcapture("record-result", command, current)).toMatchObject({
    status: "committed", insertedRows: 3, commitObserved: true, witnessMatched: true, owner: null, runtimeObserved: false,
  });
  expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
  g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
  const next = service.previewPostcapture(selected), close = commands30(next).close(), closeCurrent = closeInput(g).current;
  expect(service.writePostcapture("settle-finalize", close, closeCurrent)).toMatchObject({ status: "committed", insertedRows: 8 });
  const stable = snapshot(g.db), journal = witnessFiles(g);
  expect(service.writePostcapture("record-result", command, explode())).toMatchObject({ status: "replay", insertedRows: 0, commitObserved: false });
  expect(service.recoverPostcapture("settle-finalize", close)).toMatchObject({ status: "replay", insertedRows: 0, witnessMatched: true });
  expect(snapshot(g.db)).toEqual(stable);
  expect(witnessFiles(g)).toEqual(journal);
  expect(() => service.writePostcapture("settle-finalize", { ...close, expectedAssessmentDigest: bad }, explode())).toThrow();
  expect(() => service.writePostcapture("settle-finalize", { ...close, clientRequestId: closeCurrent.usageNonce }, explode())).toThrow();
  expect(() => service.previewPostcapture({ ...selected, dispatchCommandDigest: bad })).toThrow(/RUN_CHANGED/);
  expect(() => service.previewPostcapture({ ...selected, runId: randomUUID() })).toThrow(/RUN_CHANGED/);
  expect(() => service.previewPostcapture({ ...selected, authority: true })).toThrow();
  const safe = JSON.stringify({ preview: next, view: service.inspect() });
  for (const value of [directory, comparisonSyntheticWireKey, JSON.stringify(response), "recordedRows", "records", "apiKey"])
    expect(safe).not.toContain(value);
  expect(start).not.toHaveBeenCalled();
  expect(service.retire().status).toBe("closed");
}, postLimit30);

it("4I30 original pending execution denies handoff; retire retains late capture then permits explicit storage", async () => {
  const { g, command, current } = ownerFixture22(), ready = deferred22<void>(), net = deferred22<Response>();
  const network = vi.fn(() => { ready.resolve(); return net.promise; });
  const service = createIsolatedPublicComparisonService(g.session, g.cap,
    createSyntheticComparisonSdkDriver((o) => ({ responses: { create: async (body, request) =>
      (await o.fetch("https://api.openai.com/v1/responses", { ...sdkWire24(body), signal: request.signal })).json(),
    } }), network));
  const selected = { runId: command.runId, dispatchCommandDigest: digest(command) };
  const running = service.execute(command, current);
  await Promise.race([ready.promise, running.then(() => { throw Error("start missing"); })]);
  expect(() => service.previewPostcapture(selected)).toThrow(/EXECUTION_PENDING/);
  expect(() => service.writePostcapture("record-result", {}, explode())).toThrow(/EXECUTION_PENDING/);
  expect(() => service.readStoredComparison({})).toThrow(/EXECUTION_PENDING/);
  expect(() => service.inspectStoredComparisonContext({})).toThrow(/EXECUTION_PENDING/);
  expect(() => service.readStoredReviewByRun({})).toThrow(/EXECUTION_PENDING/);
  expect(service.retire().status).toBe("draining");
  net.resolve(new Response(JSON.stringify(response)));
  expect((await running).capturePersisted).toBe(true);
  expect(service.inspect().status).toBe("closed");
  expect(() => service.previewPostcapture({ ...selected, dispatchCommandDigest: bad })).toThrow(/RUN_CHANGED/);
  const p = service.previewPostcapture(selected);
  expect(service.writePostcapture("record-result", commands30(p).result, { at: later, eventId: randomUUID() }).insertedRows).toBe(3);
  expect(service.readStoredComparison(selected32(g)).database.comparisonRecorded).toBe(true);
  expect(network).toHaveBeenCalledTimes(1);
  expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
}, postLimit30);

for (const mode of ["missing", "binding3", "zero", "excess", "refusal", "incomplete"] as const)
  it("4I30 explicit service close preserves original policy for " + mode, () => {
    const value = mode === "missing" ? { ...response, usage: undefined } :
      mode === "zero" || mode === "excess" ? { ...response, usage: {
        input_tokens: mode === "zero" ? 0 : 999999, output_tokens: mode === "zero" ? 0 : 999999,
        total_tokens: mode === "zero" ? 0 : 1999998,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      } } : { ...response, status: mode === "incomplete" ? "incomplete" : "completed",
        output: mode === "refusal" ? [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }] : [] };
    const g = mode === "binding3" ? setup12() : throughCapture(value);
    if (mode === "binding3") { dispatch(g); mark(g); save(g); migrateGuardedPublicComparisonDatabaseV13(g.session); }
    const { service, selected, start } = service30(g);
    const p = service.previewPostcapture(selected);
    if (mode === "refusal" || mode === "incomplete") expect(p.comparisonState).toBe(mode === "refusal" ? "response-unsupported" : "response-incomplete");
    expect(service.writePostcapture("record-result", commands30(p).result,
      { at: later, eventId: randomUUID() }).insertedRows).toBe(3);
    const next = service.previewPostcapture(selected), c = commands30(next).close(), cur = closeInput(g).current;
    expect(next.database).toMatchObject({ comparisonRecorded: true, costSettled: false, finalized: false, currentContextVerified: false });
    expect(next.database.runHeldBytes).toBeGreaterThan(0);
    expect(BigInt(next.database.scopeHeldUnits)).toBeGreaterThan(BigInt(0));
    const before = snapshot(g.db), files = witnessFiles(g);
    const result = service.writePostcapture("settle-finalize", c,
      mode === "missing" || mode === "binding3" ? explode() : cur);
    if (mode === "missing" || mode === "binding3") {
      expect(result).toMatchObject({ status: "blocked", insertedRows: 0 });
      expect(snapshot(g.db)).toEqual(before);
      expect(witnessFiles(g)).toEqual(files);
      expect(service.inspect().postcapture.status).toBe("blocked");
      expect(state13(g).reservation.archive.financial.events).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ status: "committed", insertedRows: 8 });
      const s = state13(g).reservation, money = s.archive.financial.events.at(-1)!;
      if (money.payload.kind !== "recognize-comparison-usage") throw Error("money");
      if (mode === "zero") expect(money.payload.recognizedUnits).toBe("0");
      if (mode === "excess") {
        expect(BigInt(money.payload.recognizedUnits)).toBeGreaterThan(BigInt(s.archive.records.runs[0].manifest.reservedUnits));
        expect(BigInt(money.payload.boundExcessUnits)).toBeGreaterThan(BigInt(0));
      }
      expect(s.archive.records.events.at(-1)!.payload.kind).toBe("finalized");
      expect(service.previewPostcapture(selected).database).toMatchObject({ costSettled: true, finalized: true, runHeldBytes: 0, scopeHeldUnits: "0", currentContextVerified: false });
    }
    expect(start).not.toHaveBeenCalled();
    expect(service.retire().status).toBe("closed");
  }, postLimit30);

for (const operation of ["record-result", "settle-finalize"] as const)
  for (const fault of ["commit", "ack", "lease", "ack-rollback"] as const)
    it("4I30 service " + operation + " " + fault + " retains original command and recovers exact rows only", () => {
      const g = operation === "record-result" ? throughCapture() : throughResult();
      const i = operation === "record-result" ? resultInput(g) : closeInput(g);
      const originalCommand = structuredClone(i.command), { service, start } = service30(g);
      const exec = g.db.exec.bind(g.db), end = storageWitness22.endComparisonStorageSession;
      let writing = false, lost = false;
      const io = vi.spyOn(journalIO, "writeJournalJson").mockImplementation((file, value, ...args) => {
        const kind = (value as { payload: { type: string } }).payload.type;
        if (kind === "intent") writing = true;
        if (writing && kind === "ack" && (fault === "ack" || fault === "ack-rollback")) throw Error("postcapture ack lost");
        return originalWrite(file, value, ...args);
      });
      const sql = vi.spyOn(g.db, "exec").mockImplementation((statement) => {
        if (fault === "ack-rollback" && writing && statement === "ROLLBACK") throw Error("postcapture rollback lost");
        exec(statement);
        if (fault === "commit" && writing && !lost && statement === "COMMIT") { lost = true; throw Error("postcapture commit return lost"); }
      });
      const lease = vi.spyOn(storageWitness22, "endComparisonStorageSession").mockImplementation((s) => {
        if (fault === "lease" && writing) throw Error("postcapture lease close lost");
        return end(s);
      });
      try {
        expect(() => service.writePostcapture(operation, i.command, i.current)).toThrow();
        expect(service.retire()).toMatchObject({ status: "draining", postcapture: {
          status: "recovery-required", commandDigest: digest(originalCommand),
        } });
        const stable = snapshot(g.db), files = witnessFiles(g);
        expect(() => service.writePostcapture(operation, originalCommand, explode())).toThrow(/RECOVERY_REQUIRED/);
        expect(() => service.recoverPostcapture(operation, { ...originalCommand, responseArtifactSha256: bad })).toThrow(/ORIGINAL_COMMAND_REQUIRED/);
        expect(snapshot(g.db)).toEqual(stable);
        expect(witnessFiles(g)).toEqual(files);
      } finally { sql.mockRestore(); io.mockRestore(); lease.mockRestore(); }
      // Mutating the caller's input cannot alter the retained command/current or internal close nonces.
      i.command.responseArtifactSha256 = bad;
      const stable = snapshot(g.db);
      expect(service.recoverPostcapture(operation, originalCommand)).toMatchObject({
        status: "replay", insertedRows: 0, commitObserved: false, witnessMatched: true,
      });
      expect(snapshot(g.db)).toEqual(stable);
      expect(service.inspect()).toMatchObject({ status: "closed", postcapture: { status: "stored", commandDigest: null, cleanupRequired: false } });
      expect(start).not.toHaveBeenCalled();
    }, postLimit30);

for (const operation of ["record-result", "settle-finalize"] as const)
  it("4I30 service " + operation + " absent rows cannot become a new write during recovery", () => {
    const g = operation === "record-result" ? throughCapture() : throughResult();
    const i = operation === "record-result" ? resultInput(g) : closeInput(g);
    const { service } = service30(g), before = snapshot(g.db), insert = injectInsert(g.db, 2);
    expect(() => service.writePostcapture(operation, i.command, i.current)).toThrow();
    insert.mockRestore();
    expect(snapshot(g.db)).toEqual(before);
    const files = witnessFiles(g);
    expect(() => service.recoverPostcapture(operation, i.command)).toThrow(/RECORD_NOT_FOUND/);
    expect(snapshot(g.db)).toEqual(before);
    expect(witnessFiles(g)).toEqual(files);
    expect(service.retire().status).toBe("draining");
    const reopened = openComparisonStorageSession(g.paths, selection);
    try {
      const next = createIsolatedPublicComparisonService(reopened, g.cap, createSyntheticComparisonDriver(forbidden));
      expect(() => next.recoverPostcapture(operation, i.command)).toThrow(/RECORD_NOT_FOUND/);
      expect(next.retire().status).toBe("draining");
      expect(snapshot(g.db)).toEqual(before);
      expect(witnessFiles(g)).toEqual(files);
    } finally { closeComparisonStorageSession(reopened); }
  }, postLimit30);

it("4I30 storage-only restart acknowledges an original command without owner driver or new rows", () => {
  const g = throughCapture(), i = resultInput(g), { service } = service30(g);
  const io = vi.spyOn(journalIO, "writeJournalJson").mockImplementation((file, value, ...args) => {
    if ((value as { payload: { type: string } }).payload.type === "ack") throw Error("ack lost");
    return originalWrite(file, value, ...args);
  });
  expect(() => service.writePostcapture("record-result", i.command, i.current)).toThrow();
  io.mockRestore();
  const before = snapshot(g.db), reopened = openComparisonStorageSession(g.paths, selection);
  try {
    const next = createIsolatedPublicComparisonService(reopened, g.cap, createSyntheticComparisonDriver(forbidden));
    expect(next.recoverPostcapture("record-result", i.command)).toMatchObject({
      status: "replay", commitObserved: false, insertedRows: 0, witnessMatched: true, owner: null,
    });
    expect(next.inspect().execution.startAttempted).toBe(false);
    expect(snapshot(g.db)).toEqual(before);
    expect(next.retire().status).toBe("closed");
    // The still-live original object must explicitly observe its own acknowledgement.
    expect(service.retire().status).toBe("draining");
    expect(service.recoverPostcapture("record-result", i.command).witnessMatched).toBe(true);
    expect(service.inspect().status).toBe("closed");
  } finally { closeComparisonStorageSession(reopened); }
}, postLimit30);

it("4I30 read cleanup and competing storage lease never close another invocation", () => {
  const g = throughCapture(), { service, selected } = service30(g), before = snapshot(g.db);
  beginComparisonStorageSession(g.session);
  expect(() => service.previewPostcapture(selected)).toThrow(/BUSY/);
  expect(service.inspect().postcapture.cleanupRequired).toBe(false);
  expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  endComparisonStorageSession(g.session);
  const end = storageWitness22.endComparisonStorageSession;
  const spy = vi.spyOn(storageWitness22, "endComparisonStorageSession").mockImplementation(() => { throw Error("read cleanup lost"); });
  expect(() => service.previewPostcapture(selected)).toThrow(/LEASE_CLEANUP_REQUIRED/);
  expect(service.retire()).toMatchObject({ status: "draining", postcapture: { cleanupRequired: true } });
  spy.mockRestore();
  expect(service.previewPostcapture(selected).runId).toBe(selected.runId);
  expect(service.inspect()).toMatchObject({ status: "closed", postcapture: { cleanupRequired: false } });
  beginComparisonStorageSession(g.session); end(g.session);
  expect(snapshot(g.db)).toEqual(before);
}, postLimit30);

it("4I30 unused private release does not replace capture or authorize stale result/close commands", () => {
  const g = setup13(), d = dispatch13(g), { service, selected, start } = service30(g);
  expect(() => service.previewPostcapture(selected)).toThrow();
  expect(service.retire().status).toBe("closed");
  save13(g);
  const p = service.previewPostcapture(selected), c = commands30(p).result, before = snapshot(g.db), files = witnessFiles(g);
  expect(() => service.writePostcapture("record-result", { ...c, expectedRunHead: { ...c.expectedRunHead, headDigest: bad } },
    { at: later, eventId: randomUUID() })).toThrow();
  expect(() => service.writePostcapture("record-result", { ...c, responseArtifactSha256: bad },
    { at: later, eventId: randomUUID() })).toThrow();
  expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files);
  expect(service.writePostcapture("record-result", c, { at: later, eventId: randomUUID() }).insertedRows).toBe(3);
  const close = closeInput(g), stable = snapshot(g.db);
  expect(() => service.writePostcapture("settle-finalize", { ...close.command, expectedBudgetHead: { ...close.command.expectedBudgetHead, headDigest: bad } }, close.current)).toThrow();
  expect(() => service.writePostcapture("settle-finalize", close.command, { ...close.current, usageNonce: d.input.command.clientRequestId })).toThrow();
  expect(snapshot(g.db)).toEqual(stable);
  expect(service.inspect().postcapture.commandDigest).toBeNull();
  expect(start).not.toHaveBeenCalled();
}, postLimit30);

it("4I30 lost public projection retains committed command until exact explicit recovery", () => {
  const g = throughCapture(), i = resultInput(g), { service } = service30(g), freeze = Object.freeze;
  const spy = vi.spyOn(Object, "freeze").mockImplementation((value) => {
    if (value && typeof value === "object" && "source" in value &&
        value.source === "synthetic-comparison-postcapture") throw Error("public projection lost");
    return freeze(value);
  });
  expect(() => service.writePostcapture("record-result", i.command, i.current)).toThrow(/projection lost/);
  spy.mockRestore();
  expect(service.retire()).toMatchObject({ status: "draining", postcapture: { commandDigest: digest(i.command) } });
  const stable = snapshot(g.db);
  expect(service.recoverPostcapture("record-result", i.command)).toMatchObject({ status: "replay", insertedRows: 0, witnessMatched: true });
  expect(snapshot(g.db)).toEqual(stable);
  expect(service.inspect().status).toBe("closed");
}, postLimit30);


it("4I30 recovery of an older result cannot acknowledge a different pending close command", () => {
  const g = throughCapture(), result = resultInput(g), { service } = service30(g);
  service.writePostcapture("record-result", result.command, result.current);
  const close = closeInput(g);
  const io = vi.spyOn(journalIO, "writeJournalJson").mockImplementation((file, value, ...args) => {
    if ((value as { payload: { type: string } }).payload.type === "ack") throw Error("close ack lost");
    return originalWrite(file, value, ...args);
  });
  expect(() => service.writePostcapture("settle-finalize", close.command, close.current)).toThrow();
  io.mockRestore();
  const old = createIsolatedPublicComparisonService(g.session, g.cap, createSyntheticComparisonDriver(forbidden));
  const stable = snapshot(g.db), files = witnessFiles(g);
  expect(() => old.recoverPostcapture("record-result", result.command)).toThrow();
  expect(snapshot(g.db)).toEqual(stable);
  expect(witnessFiles(g)).toEqual(files);
  expect(old.retire().status).toBe("draining");
  expect(service.recoverPostcapture("settle-finalize", close.command).witnessMatched).toBe(true);
  expect(old.recoverPostcapture("record-result", result.command).witnessMatched).toBe(true);
  expect(old.inspect().status).toBe("closed");
  expect(snapshot(g.db)).toEqual(stable);
}, postLimit30);

for (const mode of ["ready", "quote-rejected"] as const)
  it("4I30 service stores " + mode + " comparison with manual-unverified current-context authority", () => {
    const prepared = preparePublicClaimComparison(fixture.company, fixture.request.command.selection);
    const output = {
      preparationDigest: prepared.preparationDigest,
      claimQuote: mode === "ready" ? prepared.input.claimQuote : "synthetic quote not in original",
      overall: { relation: "undetermined", reason: "Synthetic comparison only" },
      evidence: prepared.input.selectedEvidence.map((e) => ({ sourceId: e.sourceId,
        relation: "undetermined", quotes: [], reason: "Needs review", nextCheck: "" })),
      checks: [],
    };
    const g = throughCapture({ ...response, output: [{ type: "message", role: "assistant",
      status: "completed", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
    const { service, selected, start } = service30(g);
    const p = service.previewPostcapture(selected), command = commands30(p).result;
    expect(p.comparisonState).toBe(mode === "ready" ? "comparison-ready" : "comparison-rejected");
    p.expectedRunHead.headDigest = bad;
    p.responseArtifactSha256 = bad;
    selected.dispatchCommandDigest = bad;
    expect(service.writePostcapture("record-result", command, { at: later, eventId: randomUUID() }).insertedRows).toBe(3);
    const state = state13(g);
    const raw = state.reservation.archive.records.artifacts.find((a) => a.key === "comparison-validated")!.body;
    expect(JSON.parse(raw)).toMatchObject({ source: "supplied-response", evidenceOrigin: "manual-unverified",
      currentContextVerified: false, state: mode === "ready" ? "comparison-ready" : "comparison-rejected" });
    const b = state.transmissionBindings[0];
    const reviewed = service.previewPostcapture({ runId: b.runId, dispatchCommandDigest: digest(b.command) });
    expect(reviewed.responseArtifactSha256).toBe(command.responseArtifactSha256);
    expect(reviewed.database).toMatchObject({ comparisonRecorded: true, costSettled: false, finalized: false, currentContextVerified: false });
    expect(start).not.toHaveBeenCalled();
    expect(service.retire().status).toBe("closed");
  }, postLimit30);

it("4I30 postcapture selection cannot cross the original session or company file", () => {
  const g = throughCapture(), other = setup13(false), { selected } = service30(g);
  const driver = createSyntheticComparisonDriver(forbidden);
  const wrongCompany = createIsolatedPublicComparisonService(g.session, other.cap, driver);
  const wrongSession = createIsolatedPublicComparisonService(other.session, g.cap, driver);
  const otherService = createIsolatedPublicComparisonService(other.session, other.cap, driver);
  const command = resultInput(g).command;
  const before = [snapshot(g.db), snapshot(other.db)], files = [witnessFiles(g), witnessFiles(other)];
  expect(() => wrongCompany.previewPostcapture(selected)).toThrow(/COMPANY_FILE_CHANGED/);
  expect(() => wrongCompany.writePostcapture("record-result", command, explode())).toThrow(/COMPANY_FILE_CHANGED/);
  expect(() => wrongSession.previewPostcapture(selected)).toThrow(/COMPANY_FILE_CHANGED/);
  expect(() => otherService.previewPostcapture(selected)).toThrow(/RUN_CHANGED/);
  expect([snapshot(g.db), snapshot(other.db)]).toEqual(before);
  expect([witnessFiles(g), witnessFiles(other)]).toEqual(files);
  for (const service of [wrongCompany, wrongSession, otherService])
    expect(service.retire().status).toBe("closed");
}, postLimit30);

// 4I32: exact saved results and separately observed original-request applicability.
function selected32(g: ReturnType<typeof guarded>) {
  const s = state13(g), b = s.transmissionBindings[0];
  const e = s.reservation.archive.records.events.find((e) => e.payload.kind === "comparison-recorded")!;
  if (e.payload.kind !== "comparison-recorded") throw Error("fixture result");
  return { runId: b.runId, dispatchCommandDigest: digest(b.command), comparisonEventDigest: e.eventDigest,
    responseArtifactSha256: e.payload.responseArtifactSha256, validatedArtifactSha256: e.payload.validatedArtifactSha256 };
}
function readyResponse32(rejected = false) {
  const p = preparePublicClaimComparison(fixture.company, fixture.request.command.selection);
  const output = { preparationDigest: p.preparationDigest, claimQuote: rejected ? "wrong quote" : p.input.claimQuote,
    overall: { relation: "undetermined", reason: "Synthetic only" },
    evidence: p.input.selectedEvidence.map((e) => ({ sourceId: e.sourceId, relation: "undetermined",
      quotes: [], reason: "Review required", nextCheck: "" })), checks: [] };
  return { ...response, output: [{ type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: JSON.stringify(output) }] }] };
}
it("4I32 saved ready result keeps historical bytes, current exact, no writes, and stable identity after close/restart", () => {
  const g = throughResult(readyResponse32()), pick = selected32(g), { service, start } = service30(g);
  const before = snapshot(g.db), witness = witnessFiles(g), company = allCompany(g.companyDb);
  const rowRead = vi.spyOn(companyGuard22, "createComparisonCompanyReadScope");
  const historical = service.readStoredComparison(pick);
  expect(rowRead).not.toHaveBeenCalled();
  expect(historical).toMatchObject({ source: "synthetic-comparison-stored-review", owner: null, runtimeObserved: false,
    current: { status: "not-checked", observedRevision: null }, database: { comparisonRecorded: true, finalized: false },
    historical: { currentContextVerified: false, result: { source: "supplied-response", evidenceOrigin: "manual-unverified",
      state: "comparison-ready", currentContextVerified: false } } });
  expect(Object.values(historical.authority).every((v) => v === false)).toBe(true);
  const stable = structuredClone(historical);
  historical.historical.prepared.input.section.content = "mutated";
  historical.resultIdentity.responseArtifactSha256 = bad;
  const checked = service.inspectStoredComparisonContext(pick);
  expect(checked.current).toEqual({ status: "exact-original-request", originalRevision: fixture.company.revision,
    observedRevision: fixture.company.revision, reason: null });
  expect(checked.historical).toEqual(stable.historical);
  expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(witness);
  expect(allCompany(g.companyDb)).toEqual(company);
  const safe = JSON.stringify(checked);
  for (const secret of [directory, g.paths.qualityFile, JSON.stringify(response), comparisonSyntheticWireKey])
    expect(safe).not.toContain(secret);
  const c = closeInput(g);
  writeGuardedPublicComparisonV13(g.session, "settle-finalize", c.command, c.current);
  const closed = service.readStoredComparison(pick);
  expect(closed.resultIdentity).toEqual(stable.resultIdentity);
  expect(closed.historical).toEqual(stable.historical);
  expect(closed.database).toMatchObject({ finalized: true, costSettled: true, runHeldBytes: 0, scopeHeldUnits: "0" });
  service.retire();
  const reopened = openComparisonStorageSession(g.paths, selection);
  try {
    const next = createIsolatedPublicComparisonService(reopened, g.cap, createSyntheticComparisonDriver(forbidden));
    expect(next.readStoredComparison(pick)).toEqual(closed);
    expect(next.retire().status).toBe("closed");
  } finally { closeComparisonStorageSession(reopened); }
  expect(start).not.toHaveBeenCalled();
}, postLimit30);
it("4I32 preview without stored event and every cross-selected identity are refused before current read", () => {
  const g = throughCapture(readyResponse32()), { service, selected } = service30(g);
  const preview = service.previewPostcapture(selected);
  expect(preview.comparisonState).toBe("comparison-ready");
  const raw = { ...selected, comparisonEventDigest: bad, responseArtifactSha256: preview.responseArtifactSha256,
    validatedArtifactSha256: preview.expectedValidatedArtifactSha256 };
  const before = snapshot(g.db);
  expect(() => service.readStoredComparison(raw)).toThrow(/STORED_RESULT_MISSING/);
  expect(snapshot(g.db)).toEqual(before);
  result13(g);
  const pick = selected32(g), saved = snapshot(g.db), files = witnessFiles(g);
  const scope = vi.spyOn(companyGuard22, "createComparisonCompanyReadScope");
  for (const key of Object.keys(pick) as (keyof typeof pick)[])
    expect(() => service.inspectStoredComparisonContext({ ...pick, [key]: key === "runId" ? randomUUID() : bad })).toThrow();
  for (const raw of [{ ...pick, authority: true }, { ...pick, body: "x".repeat(8192) },
    { ...pick, comparisonEventDigest: null }])
    expect(() => service.readStoredComparison(raw)).toThrow();
  expect(scope).not.toHaveBeenCalled();
  expect(snapshot(g.db)).toEqual(saved); expect(witnessFiles(g)).toEqual(files);
}, postLimit30);

it("4I32 current changes and unavailable histories never rewrite the original selection or stored opinion", () => {
  const g = throughResult(readyResponse32()), pick = selected32(g), { service } = service30(g);
  const before = snapshot(g.db), files = witnessFiles(g), original = service.readStoredComparison(pick);
  const put = (company: typeof fixture.company) => g.companyDb.prepare("UPDATE studio_cases SET revision=?,body=? WHERE id=?")
    .run(company.revision, JSON.stringify(company), company.id);
  const newer = structuredClone(fixture.company);
  newer.plans.push({ ...structuredClone(newer.plans[0]), id: randomUUID(), version: newer.plans[0].version + 1 });
  put(newer);
  expect(service.inspectStoredComparisonContext(pick).current.status).toBe("exact-original-request");
  const changes: [string, (c: typeof fixture.company) => void, string][] = [
    ["revision", (c) => { c.revision++; }, "changed"],
    ["new judgement revision", (c) => { c.revision++; c.claimReviews[0].judgement.reason = "Later human note"; }, "changed"],
    ["other section text", (c) => { c.plans[0].content.sections[0].content += "changed tail"; }, "changed"],
    ["source body", (c) => { c.sources[0].text += "changed tail"; }, "changed"],
    ["missing claim", (c) => { c.claimReviews = []; }, "changed"],
    ["missing source", (c) => { c.sources = []; }, "changed"],
    ["changed selected digest", (c) => { c.claimReviews[0].inputDigest = bad; }, "changed"],
    ["damaged ancestor", (c) => { c.claimReviews[0].contextNote += "altered original input"; }, "unavailable"],
    ["unsupported attachment", (c) => { c.sources[0].originalName = "unread.pdf"; c.sources[0].mimeType = "application/pdf"; }, "unavailable"],
  ];
  for (const [name, change, status] of changes) {
    const c = structuredClone(fixture.company); change(c); put(c);
    const actual = service.inspectStoredComparisonContext(pick);
    expect(actual.current.status, name).toBe(status);
    expect(actual.current.originalRevision).toBe(fixture.company.revision);
    expect(actual.historical, name).toEqual(original.historical);
    expect(actual.resultIdentity).toEqual(original.resultIdentity);
  }
  g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
  expect(service.inspectStoredComparisonContext(pick).current).toMatchObject({ status: "unavailable", reason: "COMPANY_ROW_INVALID" });
  expect(service.readStoredComparison(pick)).toEqual(original);
  expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files);
}, postLimit30);
for (const mode of ["missing", "binding3", "zero", "excess", "refusal", "incomplete", "rejected"] as const)
  it("4I32 stored " + mode + " remains readable without changing original state or holds", () => {
    const value = mode === "missing" ? { ...response, usage: undefined } :
      mode === "zero" || mode === "excess" ? { ...response, usage: {
        input_tokens: mode === "zero" ? 0 : 999999, output_tokens: mode === "zero" ? 0 : 999999,
        total_tokens: mode === "zero" ? 0 : 1999998, input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 } } } :
      mode === "rejected" ? readyResponse32(true) : { ...response, status: mode === "incomplete" ? "incomplete" : "completed",
        output: mode === "refusal" ? [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }] : [] };
    const g = mode === "binding3" ? setup12() : throughCapture(value);
    if (mode === "binding3") { dispatch(g); mark(g); save(g); migrateGuardedPublicComparisonDatabaseV13(g.session); }
    result13(g);
    const pick = selected32(g), { service, start, selected } = service30(g);
    const preview = service.previewPostcapture(selected), before = snapshot(g.db), files = witnessFiles(g);
    const out = service.readStoredReviewByRun({ ...selected, mode: "historical" });
    expect(out.resultIdentity).toMatchObject(pick);
    expect(out.historical.result.state).toBe(preview.comparisonState);
    expect(out.historical.result.comparison).toBeNull();
    expect(out.database).toEqual(preview.database);
    expect(out.database.finalized).toBe(false);
    expect(out.database.runHeldBytes).toBeGreaterThan(0);
    expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files);
    expect(start).not.toHaveBeenCalled();
  }, postLimit30);
for (const fault of ["busy", "begin-return", "select", "rollback", "ownership"] as const)
  it("4I32 company read scope owns only its acquired transaction: " + fault, () => {
    const g = guarded(false), db = ownedComparisonCompanyGuard(g.cap).db;
    const scope = companyGuard22.createComparisonCompanyReadScope(g.cap);
    cleanups.push(() => { if (db.isTransaction) endComparisonCompanyRead(g.cap); });
    const exec = db.exec.bind(db), prepare = db.prepare.bind(db);
    let other: ReturnType<typeof companyGuard22.createComparisonCompanyReadScope> | undefined;
    if (fault === "busy") {
      other = companyGuard22.createComparisonCompanyReadScope(g.cap); other.read(fixture.company.id);
      expect(() => scope.read(fixture.company.id)).toThrow(/TRANSACTION_ACTIVE/);
      scope.finish(); expect(db.isTransaction).toBe(true); other.finish(); return;
    }
    const sql = vi.spyOn(db, "exec").mockImplementation((q) => {
      if (q === "ROLLBACK" && fault !== "ownership") throw Error("cleanup unavailable");
      exec(q); if (q === "BEGIN IMMEDIATE" && fault === "begin-return") throw Error("BEGIN return lost");
    });
    const query = vi.spyOn(db, "prepare").mockImplementation((q) => {
      if (fault === "select" && q.includes("FROM studio_cases")) throw Error("SELECT failed");
      return prepare(q);
    });
    if (fault === "begin-return" || fault === "select") expect(() => scope.read(fixture.company.id)).toThrow(/CLEANUP_REQUIRED/);
    else scope.read(fixture.company.id);
    expect(scope.pending()).toBe(true);
    if (fault === "ownership") {
      companyGuard22.endComparisonCompanyRead(g.cap);
      other = companyGuard22.createComparisonCompanyReadScope(g.cap); other.read(fixture.company.id);
      expect(() => scope.finish()).toThrow(/CLEANUP_REQUIRED/);
      expect(db.isTransaction).toBe(true); other.finish();
    } else {
      expect(() => scope.finish()).toThrow(/CLEANUP_REQUIRED/);
      expect(db.isTransaction).toBe(true);
      sql.mockRestore(); query.mockRestore();
      scope.finish(); expect(scope.pending()).toBe(false);
      expect(db.isTransaction).toBe(false);
    }
    sql.mockRestore(); query.mockRestore();
  }, limit);

it("4I32 a busy company or quality reader is never cleaned by the unsuccessful reader", () => {
  const g = throughResult(), pick = selected32(g), { service } = service30(g);
  const scope = companyGuard22.createComparisonCompanyReadScope(g.cap);
  scope.read(fixture.company.id);
  try {
    const result = service.inspectStoredComparisonContext(pick);
    expect(result.current).toMatchObject({ status: "unavailable", reason: "COMPANY_BUSY" });
    expect(ownedComparisonCompanyGuard(g.cap).db.isTransaction).toBe(true);
    expect(service.readStoredComparison(pick).current.status).toBe("not-checked");
  } finally { scope.finish(); }
  beginComparisonStorageSession(g.session);
  expect(() => service.readStoredComparison(pick)).toThrow(/BUSY/);
  expect(service.inspect().postcapture.cleanupRequired).toBe(false);
  expect(() => beginComparisonStorageSession(g.session)).toThrow(/BUSY/);
  endComparisonStorageSession(g.session);
  expect(service.inspectStoredComparisonContext(pick).current.status).toBe("exact-original-request");
}, postLimit30);
for (const fault of ["company-begin", "company-select", "company-end", "quality-end", "lease-end"] as const)
  it("4I32 read retains own cleanup after " + fault + " and retries no writes", () => {
    const g = throughResult(), pick = selected32(g), { service, start } = service30(g);
    const companyDb = ownedComparisonCompanyGuard(g.cap).db, before = snapshot(g.db), files = witnessFiles(g);
    const oldCommand = resultInput(g).command;
    cleanups.push(() => {
      if (companyDb.isTransaction) endComparisonCompanyRead(g.cap);
      if (g.db.isTransaction) g.db.exec("ROLLBACK");
      try { endComparisonStorageSession(g.session); } catch {}
    });
    const ce = companyDb.exec.bind(companyDb), cp = companyDb.prepare.bind(companyDb), qe = g.db.exec.bind(g.db);
    const end = storageWitness22.endComparisonStorageSession;
    const companySql = vi.spyOn(companyDb, "exec").mockImplementation((q) => {
      if (q === "ROLLBACK" && fault.startsWith("company-")) throw Error("company cleanup");
      ce(q);
      if (q === "BEGIN IMMEDIATE" && fault === "company-begin") throw Error("begin return lost");
    });
    const companySelect = vi.spyOn(companyDb, "prepare").mockImplementation((q) => {
      if (fault === "company-select" && q.includes("FROM studio_cases")) throw Error("company select");
      return cp(q);
    });
    const qualitySql = vi.spyOn(g.db, "exec").mockImplementation((q) => {
      if (q === "ROLLBACK" && fault === "quality-end") throw Error("quality cleanup");
      qe(q);
    });
    const lease = vi.spyOn(storageWitness22, "endComparisonStorageSession").mockImplementation((s) => {
      if (fault === "lease-end") throw Error("lease cleanup");
      end(s);
    });
    expect(() => service.inspectStoredComparisonContext(pick)).toThrow();
    expect(service.retire()).toMatchObject({ status: "draining", postcapture: { cleanupRequired: true } });
    expect(() => service.writePostcapture("record-result", oldCommand, explode())).toThrow();
    companySql.mockRestore(); companySelect.mockRestore(); qualitySql.mockRestore(); lease.mockRestore();
    expect(service.readStoredComparison(pick).current.status).toBe("not-checked");
    expect(service.inspect()).toMatchObject({ status: "closed", postcapture: { cleanupRequired: false } });
    expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files);
    expect(start).not.toHaveBeenCalled();
  }, postLimit30);
it("4I32 pending result ack cannot be repaired by either read port or a restarted reader", () => {
  const g = throughCapture(), i = resultInput(g), { service } = service30(g);
  const io = vi.spyOn(journalIO, "writeJournalJson").mockImplementation((file, value, ...args) => {
    if ((value as { payload: { type: string } }).payload.type === "ack") throw Error("ack lost");
    return originalWrite(file, value, ...args);
  });
  expect(() => service.writePostcapture("record-result", i.command, i.current)).toThrow();
  io.mockRestore();
  const pick = selected32(g), before = snapshot(g.db), files = witnessFiles(g);
  const write = vi.spyOn(journalIO, "writeJournalJson");
  expect(() => service.readStoredComparison(pick)).toThrow(/RECOVERY_REQUIRED/);
  expect(() => service.inspectStoredComparisonContext(pick)).toThrow(/RECOVERY_REQUIRED/);
  expect(() => service.readStoredReviewByRun({ runId: pick.runId, dispatchCommandDigest: pick.dispatchCommandDigest, mode: "historical" })).toThrow(/RECOVERY_REQUIRED/);
  const reopened = openComparisonStorageSession(g.paths, selection);
  try {
    const next = createIsolatedPublicComparisonService(reopened, g.cap, createSyntheticComparisonDriver(forbidden));
    expect(() => next.readStoredComparison(pick)).toThrow();
    expect(() => next.inspectStoredComparisonContext(pick)).toThrow();
    expect(next.retire().status).toBe("closed");
  } finally { closeComparisonStorageSession(reopened); }
  expect(write).not.toHaveBeenCalled();
  expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files);
  expect(service.recoverPostcapture("record-result", i.command).witnessMatched).toBe(true);
  expect(service.readStoredComparison(pick).database.comparisonRecorded).toBe(true);
}, postLimit30);
it("4I32 stored read refuses a crossed company or session and SQL corruption without touching current", () => {
  const g = throughResult(), other = setup13(false), pick = selected32(g), { service } = service30(g);
  const driver = createSyntheticComparisonDriver(forbidden);
  const wrongCompany = createIsolatedPublicComparisonService(g.session, other.cap, driver);
  const wrongSession = createIsolatedPublicComparisonService(other.session, g.cap, driver);
  expect(() => wrongCompany.readStoredComparison(pick)).toThrow(/COMPANY_FILE_CHANGED/);
  expect(() => wrongSession.readStoredComparison(pick)).toThrow(/COMPANY_FILE_CHANGED/);
  const scope = vi.spyOn(companyGuard22, "createComparisonCompanyReadScope");
  // Intercept only this disposable fixture reader; no corruption is persisted.
  for (const sql of [
    "UPDATE quality_actual_artifacts SET payload='{}' WHERE artifact_key='comparison-validated'",
    "DELETE FROM quality_actual_artifacts WHERE artifact_key='comparison-validated'",
    "DUPLICATE comparison-validated",
  ]) {
    // Existing immutable table triggers may reject direct corruption, so intercept only the reader's supplied row.
    const read = g.db.prepare.bind(g.db);
    const spy = vi.spyOn(g.db, "prepare").mockImplementation((q) => {
      const statement = read(q);
      if (q.includes("quality_actual_artifacts") && q.startsWith("SELECT")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args) => all(...args).flatMap((r) =>
          r.artifact_key !== "comparison-validated" ? [r] :
            sql.startsWith("DELETE") ? [] : sql.startsWith("DUPLICATE") ? [r, { ...r }] : [{ ...r, payload: "{}" }]));
      }
      return statement;
    });
    expect(() => service.inspectStoredComparisonContext(pick)).toThrow();
    spy.mockRestore();
  }
  expect(scope).not.toHaveBeenCalled();
}, postLimit30);

it("4I32 projection loss and SELECT failure release only completed reads; malformed current stays unavailable", () => {
  const g = throughResult(), pick = selected32(g), { service, start } = service30(g);
  const before = snapshot(g.db), files = witnessFiles(g);
  const copy = storedRead32.copyComparisonStoredRead;
  const projection = vi.spyOn(storedRead32, "copyComparisonStoredRead").mockImplementation((value, kind) => {
    if (kind === "result") throw Error("public projection lost");
    return copy(value, kind);
  });
  expect(() => service.inspectStoredComparisonContext(pick)).toThrow(/projection lost/);
  expect(service.inspect().postcapture.cleanupRequired).toBe(false);
  projection.mockRestore();
  const prepare = g.db.prepare.bind(g.db);
  const sql = vi.spyOn(g.db, "prepare").mockImplementation((q) => {
    if (q.includes("quality_actual_artifacts")) throw Error("quality SELECT failed");
    return prepare(q);
  });
  expect(() => service.readStoredComparison(pick)).toThrow(/SELECT failed/);
  sql.mockRestore();
  expect(g.db.isTransaction).toBe(false);
  expect(service.inspect().postcapture.cleanupRequired).toBe(false);
  const historical = service.readStoredComparison(pick);
  g.companyDb.prepare("UPDATE studio_cases SET body=? WHERE id=?").run("{", fixture.company.id);
  expect(service.inspectStoredComparisonContext(pick).current.status).toBe("unavailable");
  expect(service.readStoredComparison(pick)).toEqual(historical);
  expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files);
  expect(start).not.toHaveBeenCalled();
  expect(service.retire().status).toBe("closed");
}, postLimit30);

// 4I34: compose existing audit and strict read in the same retained service.
it("4I34 original run obtains saved identity and delivers copied historical/current results through retirement and restart", () => {
  const g = throughResult(readyResponse32()), { service, start, selected } = service30(g);
  const before = snapshot(g.db), files = witnessFiles(g), company = allCompany(g.companyDb);
  const scope = vi.spyOn(companyGuard22, "createComparisonCompanyReadScope");
  const writer = vi.spyOn(journalIO, "writeJournalJson");
  const historical = service.readStoredReviewByRun({ ...selected, mode: "historical" });
  expect(scope).not.toHaveBeenCalled();
  expect(historical.resultIdentity).toMatchObject(selected32(g));
  expect(historical.current.status).toBe("not-checked");
  expect(historical.historical.result).toMatchObject({ state: "comparison-ready", source: "supplied-response",
    evidenceOrigin: "manual-unverified", currentContextVerified: false });
  const stable = structuredClone(historical);
  historical.resultIdentity.selection.sourceIds.reverse();
  historical.historical.prepared.input.section.content = "changed returned copy";
  const current = service.readStoredReviewByRun({ ...selected, mode: "inspect-current" });
  expect(current.current).toMatchObject({ status: "exact-original-request",
    observedRevision: fixture.company.revision, originalRevision: fixture.company.revision });
  expect(current.historical).toEqual(stable.historical);
  expect(Object.values(current.authority).every((v) => v === false)).toBe(true);
  expect(current).toMatchObject({ owner: null, runtimeObserved: false });
  expect(writer).not.toHaveBeenCalled();
  expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files); expect(allCompany(g.companyDb)).toEqual(company);
  expect(service.retire().status).toBe("closed");
  const reopened = openComparisonStorageSession(g.paths, selection);
  try {
    const next = createIsolatedPublicComparisonService(reopened, g.cap, createSyntheticComparisonDriver(forbidden));
    expect(next.readStoredReviewByRun({ ...selected, mode: "historical" })).toEqual(stable);
    expect(next.retire().status).toBe("closed");
  } finally { closeComparisonStorageSession(reopened); }
  expect(start).not.toHaveBeenCalled();
}, postLimit30);
it("4I34 computed ready preview and caller-supplied identities cannot become saved results", () => {
  const g = throughCapture(readyResponse32()), { service, selected, start } = service30(g);
  const p = service.previewPostcapture(selected), before = snapshot(g.db), files = witnessFiles(g);
  expect(p.comparisonState).toBe("comparison-ready");
  const query = { ...selected, mode: "historical" };
  expect(() => service.readStoredReviewByRun(query)).toThrow(/STORED_RESULT_MISSING/);
  const begin = vi.spyOn(storageWitness22, "beginComparisonStorageSession");
  for (const raw of [selected, { ...query, mode: "auto" }, { ...query, preview: p }, { ...query, authority: true },
    { ...query, comparisonEventDigest: bad }, { ...query, text: "가".repeat(3000) }])
    expect(() => service.readStoredReviewByRun(raw)).toThrow();
  const getter = vi.fn(() => selected.runId);
  expect(() => service.readStoredReviewByRun(Object.defineProperty({}, "runId", { enumerable: true, get: getter }))).toThrow();
  expect(getter).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled(); begin.mockRestore();
  for (const raw of [{ ...query, runId: randomUUID() }, { ...query, dispatchCommandDigest: bad }])
    expect(() => service.readStoredReviewByRun(raw)).toThrow(/RUN_CHANGED/);
  expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files); expect(start).not.toHaveBeenCalled();
}, postLimit30);
for (const action of ["close", "pending-ack", "rows", "first-cleanup", "second-cleanup", "projection"] as const)
  it("4I34 two audits preserve original selection and responsibilities after " + action, () => {
    const g = throughResult(readyResponse32()), { service, selected, start } = service30(g);
    const pick = selected32(g), close = closeInput(g), before = snapshot(g.db), files = witnessFiles(g);
    const originalEnd = storageWitness22.endComparisonStorageSession;
    let count = 0, changed = false;
    const prepare = g.db.prepare.bind(g.db);
    const sql = vi.spyOn(g.db, "prepare").mockImplementation((q) => {
      const st = prepare(q);
      if (changed && action === "rows" && q.startsWith("SELECT") && q.includes("quality_actual_artifacts")) {
        const all = st.all.bind(st);
        vi.spyOn(st, "all").mockImplementation((...args) => all(...args).map((row) =>
          row.artifact_key === "comparison-validated" ? { ...row, payload: "{}" } : row));
      }
      return st;
    });
    const copy = storedRead32.copyComparisonStoredRead;
    const projection = vi.spyOn(storedRead32, "copyComparisonStoredRead").mockImplementation((v, kind) => {
      if (action === "projection" && kind === "result") throw Error("projection lost");
      return copy(v, kind);
    });
    const lease = vi.spyOn(storageWitness22, "endComparisonStorageSession").mockImplementation((s) => {
      count++;
      if ((action === "first-cleanup" && count === 1) || (action === "second-cleanup" && count === 2))
        throw Error("owned lease cleanup failed");
      originalEnd(s);
      if (changed) return;
      changed = true;
      if (action === "close" || action === "pending-ack") {
        const ack = vi.spyOn(journalIO, "writeJournalJson").mockImplementation((file, value, ...args) => {
          if (action === "pending-ack" && (value as { payload: { type: string } }).payload.type === "ack")
            throw Error("ack lost between reads");
          return originalWrite(file, value, ...args);
        });
        if (action === "close") writeGuardedPublicComparisonV13(g.session, "settle-finalize", close.command, close.current);
        else expect(() => writeGuardedPublicComparisonV13(g.session, "settle-finalize", close.command, close.current)).toThrow();
        ack.mockRestore();
      }
    });
    cleanups.push(() => { if (g.db.isTransaction) g.db.exec("ROLLBACK"); try { endComparisonStorageSession(g.session); } catch {} });
    const query = { ...selected, mode: "historical" };
    if (action === "close") {
      const out = service.readStoredReviewByRun(query);
      expect(out.resultIdentity).toMatchObject(pick);
      expect(out.database).toMatchObject({ finalized: true, costSettled: true, runHeldBytes: 0, scopeHeldUnits: "0" });
      expect(out.historical.result.state).toBe("comparison-ready");
    } else expect(() => service.readStoredReviewByRun(query)).toThrow();
    lease.mockRestore(); sql.mockRestore(); projection.mockRestore();
    if (action.endsWith("cleanup")) {
      expect(service.retire()).toMatchObject({ status: "draining", postcapture: { cleanupRequired: true } });
      expect(service.readStoredReviewByRun(query).resultIdentity).toMatchObject(pick);
      expect(service.inspect().status).toBe("closed");
    }
    if (action === "pending-ack") {
      const pending = witnessFiles(g), now = snapshot(g.db);
      const write = vi.spyOn(journalIO, "writeJournalJson");
      expect(() => service.readStoredReviewByRun(query)).toThrow();
      expect(write).not.toHaveBeenCalled(); expect(witnessFiles(g)).toEqual(pending); expect(snapshot(g.db)).toEqual(now);
    } else if (action !== "close") {
      expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files);
    }
    expect(start).not.toHaveBeenCalled();
  }, postLimit30);
it("4I34 unavailable current and newer snapshot leave separately audited historical bytes intact", () => {
  const g = throughResult(), { service, selected } = service30(g);
  const before = snapshot(g.db), files = witnessFiles(g);
  const original = service.readStoredReviewByRun({ ...selected, mode: "historical" });
  const newer = structuredClone(fixture.company); newer.revision++;
  g.companyDb.prepare("UPDATE studio_cases SET revision=?,body=? WHERE id=?").run(newer.revision, JSON.stringify(newer), newer.id);
  const changed = service.readStoredReviewByRun({ ...selected, mode: "inspect-current" });
  expect(changed.current).toMatchObject({ status: "changed", originalRevision: fixture.company.revision, observedRevision: newer.revision });
  g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(newer.id);
  const unavailable = service.readStoredReviewByRun({ ...selected, mode: "inspect-current" });
  expect(unavailable.current).toMatchObject({ status: "unavailable", observedRevision: null });
  expect(unavailable.historical).toEqual(original.historical); expect(changed.historical).toEqual(original.historical);
  expect(service.readStoredReviewByRun({ ...selected, mode: "historical" })).toEqual(original);
  expect(snapshot(g.db)).toEqual(before); expect(witnessFiles(g)).toEqual(files);
}, postLimit30);
