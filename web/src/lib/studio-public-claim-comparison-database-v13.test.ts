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
import { copyFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
vi.mock("server-only", () => ({}));
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
