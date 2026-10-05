import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { readPublicComparisonPrefix } from "./studio-public-claim-comparison-prefix-test-helpers";
import { comparisonReservationTestFixture } from "./studio-public-claim-comparison-reservation-test-helpers";
import { createPublicComparisonCoverage } from "./studio-public-claim-comparison-budget";
import {
  planComparisonReservation,
  planComparisonCancellation,
  type ComparisonReservationState,
} from "./studio-public-claim-comparison-reservation";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { captureProviderResponse } from "../../scripts/local-data-quality-provider-usage.mjs";
import { comparisonSha as sha } from "./studio-public-claim-comparison-financial";
import * as configuration from "./studio-plan-quality-provider-configuration";
import {
  comparisonTransmissionBasisSchema,
  comparisonTransmissionNotice,
  comparisonDispatchCommandSchema,
  comparisonUnknownCommandSchema,
  comparisonCaptureCommandSchema,
  createComparisonTransmissionReview,
  inspectComparisonTransmissionState,
  planComparisonDispatch,
  planComparisonUnknown,
  planComparisonCapture,
  type ComparisonTransmissionState,
  type ComparisonTransmissionReview,
} from "./studio-public-claim-comparison-transmission";
import { providerProposalSourceDigestInput } from "./studio-plan-quality-provider-review-types";
import { preparePublicClaimComparison } from "./studio-public-claim-comparison";
import { publicClaimComparisonRequestPins } from "./studio-public-claim-comparison-request-types";

vi.mock("server-only", () => ({}));
vi.mock(
  "./studio-plan-quality-provider-configuration-current",
  () => import("./studio-plan-quality-provider-configuration-20260927-test-fixture"),
);
const guard = vi.hoisted(() => ({ enabled: false }));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("I/O forbidden");
  }),
);
vi.mock("node:sqlite", async (original) => {
  const actual = await original<typeof import("node:sqlite")>();
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
        if (guard.enabled) forbidden();
        super(...args);
      }
    },
  };
});
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
const at = "2026-10-05T10:00:00.000Z",
  later = "2026-10-06T10:00:00.000Z";
const badHash = "f".repeat(64);
let directory: string, reserved: ComparisonTransmissionState;
let fixture: ReturnType<typeof comparisonReservationTestFixture>;
let basis: ReturnType<typeof comparisonTransmissionBasisSchema.parse>;
let review: ComparisonTransmissionReview,
  command: ReturnType<typeof comparisonDispatchCommandSchema.parse>;
type PreparedDispatch = Extract<
  ReturnType<typeof planComparisonDispatch>,
  { status: "prepared-not-committed" }
>;
let dispatched: PreparedDispatch;
let unknown: Extract<
  ReturnType<typeof planComparisonUnknown>,
  { status: "prepared-not-committed" }
>;
let captured: Extract<
  ReturnType<typeof planComparisonCapture>,
  { status: "prepared-not-committed" }
>;
let unknownCommand: ReturnType<typeof comparisonUnknownCommandSchema.parse>;
let captureCommand: ReturnType<typeof comparisonCaptureCommandSchema.parse>;
const capture = captureProviderResponse({
  id: "synthetic-response",
  model: "synthetic-model",
  status: "completed",
  output: [],
});
function current() {
  return {
    company: structuredClone(fixture.company),
    approvedReview: structuredClone(review),
    basis: structuredClone(basis),
    at,
    eventId: randomUUID(),
  };
}
function head(s: ComparisonTransmissionState) {
  const e = s.reservation.archive.records.events.at(-1)!;
  return { revision: e.revision, headDigest: e.eventDigest };
}
function unknownFor(s = dispatched.next) {
  const b = s.transmissionBindings[0];
  return comparisonUnknownCommandSchema.parse({
    commandVersion: 1,
    kind: "mark-public-comparison-unknown",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    expectedRunHead: head(s),
    reason: "transport-unknown",
  });
}
function captureFor(s = unknown.next, value = capture) {
  const b = s.transmissionBindings[0],
    body = JSON.stringify(value);
  return comparisonCaptureCommandSchema.parse({
    commandVersion: 1,
    kind: "persist-public-comparison-capture",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    expectedRunHead: head(s),
    responseArtifactSha256: sha(body),
    sizeBytes: Buffer.byteLength(body),
  });
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-transmission-plan-"));
  const store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  let state: ComparisonReservationState;
  try {
    store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const f = await finalizationStoreFixture(store);
    store.providerRecordFinalization(f.identity);
    const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    try {
      const prefix = readPublicComparisonPrefix(db);
      state = {
        prefix,
        coverage: createPublicComparisonCoverage(prefix),
        archive: {
          records: { runs: [], events: [], receipts: [], artifacts: [] },
          financial: { events: [], receipts: [] },
        },
        bindings: [],
        additionalUsedBytes: 0,
      };
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
  guard.enabled = true;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(forbidden);
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
  fixture = comparisonReservationTestFixture(state!, at);
  const r = planComparisonReservation(state!, fixture.command, {
    company: fixture.company,
    approvedReview: fixture.review,
    evidence: fixture.evidence,
    at,
    runId: randomUUID(),
    eventId: randomUUID(),
    budgetEventId: randomUUID(),
  });
  if (r.status !== "prepared-not-committed") throw Error("reservation fixture");
  reserved = { reservation: r.next, transmissionBindings: [] };
  const e = fixture.evidence;
  basis = comparisonTransmissionBasisSchema.parse({
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
  review = createComparisonTransmissionReview(reserved, fixture.company, r.rows.run.id, basis, at);
  command = comparisonDispatchCommandSchema.parse({
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
  const d = planComparisonDispatch(reserved, command, current());
  if (d.status !== "prepared-not-committed") throw Error("dispatch fixture");
  dispatched = d;
  unknownCommand = unknownFor();
  const u = planComparisonUnknown(d.next, unknownCommand, { at, eventId: randomUUID() });
  if (u.status !== "prepared-not-committed") throw Error("unknown fixture");
  unknown = u;
  captureCommand = captureFor();
  const c = planComparisonCapture(u.next, captureCommand, {
    at: later,
    eventId: randomUUID(),
    capture,
  });
  if (c.status !== "prepared-not-committed") throw Error("capture fixture");
  captured = c;
}, 30000);
afterAll(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (directory) {
    const p = relative(resolve(tmpdir()), resolve(directory));
    if (!p.startsWith("venture-transmission-plan-") || p.includes(".."))
      throw Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
it("keeps original request, legacy cost, reservation and budgets through dispatch/unknown/late capture", () => {
  const s = captured.next.reservation;
  expect(s.prefix).toEqual(reserved.reservation.prefix);
  expect(s.bindings).toEqual(reserved.reservation.bindings);
  expect(s.archive.financial).toEqual(reserved.reservation.archive.financial);
  expect(s.archive.records.runs).toEqual(reserved.reservation.archive.records.runs);
  expect(s.archive.records.artifacts.slice(0, 2)).toEqual(
    reserved.reservation.archive.records.artifacts,
  );
  expect(dispatched.rows.binding?.recordVersion).toBe(3);
  expect(dispatched.rows.artifact).toBeNull();
  expect(unknown.rows.binding).toBeNull();
  expect(captured.rows.artifact?.body).toBe(JSON.stringify(capture));
  expect(captured.capacity.totalExposureBytes).toBeGreaterThan(32 * 1024 * 1024);
  expect(Object.values(captured.authority).every((v) => v === false)).toBe(true);
  expect(captured.owner).toBeNull();
});
it("reconstructs all three exact original commands from stored rows after JSON reopen", () => {
  const reopened = JSON.parse(JSON.stringify(captured.next));
  reopened.reservation.prefix = structuredClone(captured.next.reservation.prefix);
  const audit = inspectComparisonTransmissionState(reopened);
  expect(audit.commands).toEqual([command, unknownCommand, captureCommand]);
  expect(audit.reservation.view.native.heldUnits).toBe(review.budget.heldUnits);
  expect(audit.reservation.view.native.recognizedUnits).toBe(review.budget.recognizedUnits);
  expect(BigInt(audit.reservation.view.native.recognizedUnits)).toBeGreaterThan(BigInt(0));
});
it.each(["dispatch", "unknown", "capture"] as const)(
  "replays %s before touching current getters or fresh IDs",
  (kind) => {
    const current = Object.defineProperty({}, "at", {
      get() {
        throw Error("current touched");
      },
      enumerable: true,
    });
    const r =
      kind === "dispatch"
        ? planComparisonDispatch(captured.next, command, current)
        : kind === "unknown"
          ? planComparisonUnknown(captured.next, unknownCommand, current)
          : planComparisonCapture(captured.next, captureCommand, current);
    expect(r.status).toBe("replay");
    expect(r.rows).toBeNull();
    expect(r.owner).toBeNull();
  },
);
it.each(["dispatch", "unknown", "capture"] as const)(
  "rejects same %s nonce with a changed full command",
  (kind) => {
    if (kind === "dispatch")
      expect(() =>
        planComparisonDispatch(captured.next, { ...command, expectedCoverageDigest: badHash }),
      ).toThrow();
    if (kind === "unknown")
      expect(() =>
        planComparisonUnknown(captured.next, { ...unknownCommand, reason: "restart-unknown" }),
      ).toThrow();
    if (kind === "capture")
      expect(() =>
        planComparisonCapture(captured.next, {
          ...captureCommand,
          sizeBytes: captureCommand.sizeBytes + 1,
        }),
      ).toThrow();
  },
);
it("rejects occupied reservation nonce for a different purpose", () => {
  expect(() =>
    planComparisonDispatch(reserved, {
      ...command,
      clientRequestId: fixture.command.clientRequestId,
    }),
  ).toThrow();
});
it("rejects a legacy receipt nonce", () => {
  const nonce = reserved.reservation.prefix.rows.actualRows.receipts[0].nonce;
  expect(() => planComparisonDispatch(reserved, { ...command, clientRequestId: nonce })).toThrow();
});
it.each([
  "expectedCoverageDigest",
  "approvedReviewDigest",
  "expectedTransmissionArchiveDigest",
  "runDigest",
  "expectedReservationBindingDigest",
] as const)("rejects changed %s", (field) => {
  expect(() =>
    planComparisonDispatch(reserved, { ...command, [field]: badHash }, current()),
  ).toThrow();
});
it.each(["noticeDigest", "retentionNoticeDigest", "exactRequestIdentityDigest"] as const)(
  "rejects changed consent %s",
  (field) => {
    expect(() =>
      planComparisonDispatch(
        reserved,
        { ...command, approval: { ...command.approval, [field]: badHash } },
        current(),
      ),
    ).toThrow();
  },
);
it.each(["before-review", "expired", "extended"] as const)("rejects %s approval timing", (kind) => {
  const c = structuredClone(command),
    cur = current();
  if (kind === "before-review") c.approval.approvedAt = "2026-10-05T09:59:59.999Z";
  if (kind === "expired") cur.at = review.expiresAt;
  if (kind === "extended") c.approval.expiresAt = later;
  expect(() => planComparisonDispatch(reserved, c, cur)).toThrow();
});
it("rejects a stale current company and retains original input", () => {
  const cur = current(),
    original = digest(reserved);
  cur.company.revision++;
  expect(() => planComparisonDispatch(reserved, command, cur)).toThrow();
  expect(digest(reserved)).toBe(original);
});
it("rejects changed same-revision selected content", () => {
  const cur = current();
  cur.company.sources[0].text += " changed";
  expect(() => planComparisonDispatch(reserved, command, cur)).toThrow();
});
it.each([
  "schema",
  "price",
  "retention",
  "notice",
  "source",
  "expired-source",
  "foreign-source",
] as const)("rejects changed transmission basis %s", (kind) => {
  const cur = current();
  if (kind === "schema") cur.basis.schemaDigest = badHash;
  if (kind === "price") cur.basis.financialBasisDigest = badHash;
  if (kind === "retention") cur.basis.retentionNoticeDigest = badHash;
  if (kind === "notice") cur.basis.notice.text += " changed";
  if (kind === "source") cur.basis.sources[0].excerpt += " changed";
  if (kind === "expired-source") cur.basis.sources[0].validUntil = at;
  if (kind === "foreign-source") cur.basis.omissions.stream.sourceIds = ["foreign"];
  expect(() =>
    createComparisonTransmissionReview(reserved, cur.company, command.runId, cur.basis, at),
  ).toThrow();
});
it.each(["service_tier", "truncation", "background", "stream"] as const)(
  "does not infer omitted %s support",
  (name) => {
    const b = JSON.parse(JSON.stringify(basis));
    delete b.omissions[name];
    expect(() =>
      createComparisonTransmissionReview(reserved, fixture.company, command.runId, b, at),
    ).toThrow();
  },
);
it("does not fill a default tier or borrow generation/review consent", () => {
  expect(() =>
    comparisonTransmissionBasisSchema.parse({ ...basis, requestedTier: "default" }),
  ).toThrow();
  expect(() =>
    comparisonDispatchCommandSchema.parse({ ...command, purpose: "generation-and-derived-review" }),
  ).toThrow();
  expect(() =>
    comparisonDispatchCommandSchema.parse({
      ...command,
      approval: { ...command.approval, externalTransmissionAcknowledged: false },
    }),
  ).toThrow();
});
it("allows first direct capture without unknown after company deletion and expiry", () => {
  const c = captureFor(dispatched.next);
  const r = planComparisonCapture(dispatched.next, c, {
    at: later,
    eventId: randomUUID(),
    capture,
  });
  expect(r.status).toBe("prepared-not-committed");
});
it.each(["alias", "incomplete", "refusal", "missing-usage", "explicit-zero"] as const)(
  "retains %s response without implying price or semantic success",
  (kind) => {
    const raw = {
      id: "synthetic-response",
      model: kind === "alias" ? "alias" : "synthetic-model",
      status: kind === "incomplete" ? "incomplete" : "completed",
      output:
        kind === "refusal"
          ? [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }]
          : [],
      ...(kind === "explicit-zero"
        ? { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
        : {}),
    };
    const value = captureProviderResponse(raw),
      c = captureFor(unknown.next, value);
    const r = planComparisonCapture(unknown.next, c, {
      at: later,
      eventId: randomUUID(),
      capture: value,
    });
    expect(r.status).toBe("prepared-not-committed");
    if (r.status === "prepared-not-committed") {
      expect(r.next.reservation.archive.financial).toEqual(
        unknown.next.reservation.archive.financial,
      );
      expect(r.rows.artifact?.body).toBe(JSON.stringify(value));
    }
  },
);
it("rejects different capture bytes and size under the approved capture command", () => {
  expect(() =>
    planComparisonCapture(
      unknown.next,
      { ...captureCommand, sizeBytes: captureCommand.sizeBytes + 1 },
      { at: later, eventId: randomUUID(), capture },
    ),
  ).toThrow();
});
it("rejects extra captured credential properties instead of silently dropping them", () => {
  expect(() =>
    planComparisonCapture(unknown.next, captureCommand, {
      at: later,
      eventId: randomUUID(),
      capture: { ...capture, authorization: "synthetic-secret" },
    }),
  ).toThrow();
});
it.each(["dispatch", "unknown", "capture"] as const)(
  "rejects second %s with fresh nonce",
  (kind) => {
    if (kind === "dispatch")
      expect(() =>
        planComparisonDispatch(
          captured.next,
          { ...command, clientRequestId: randomUUID() },
          current(),
        ),
      ).toThrow();
    if (kind === "unknown")
      expect(() =>
        planComparisonUnknown(unknown.next, unknownFor(unknown.next), {
          at,
          eventId: randomUUID(),
        }),
      ).toThrow();
    if (kind === "capture")
      expect(() =>
        planComparisonCapture(captured.next, captureFor(captured.next), {
          at: later,
          eventId: randomUUID(),
          capture,
        }),
      ).toThrow();
  },
);
it("rejects unknown after capture", () => {
  expect(() =>
    planComparisonUnknown(captured.next, unknownFor(captured.next), {
      at: later,
      eventId: randomUUID(),
    }),
  ).toThrow();
});
it("does not release a dispatched hold through old cancellation", () => {
  const b = dispatched.next.reservation.bindings[0],
    budget = dispatched.next.reservation.archive.financial.events.at(-1)!;
  expect(() =>
    planComparisonCancellation(
      dispatched.next.reservation,
      {
        commandVersion: 1,
        kind: "cancel-public-claim-comparison",
        purpose: "compare-public-claim",
        clientRequestId: randomUUID(),
        runId: b.runId,
        expectedBindingDigest: b.recordDigest,
        reservationDigest: b.budgetEventDigest,
        expectedRunHead: head(dispatched.next),
        expectedBudgetHead: { revision: budget.revision, headDigest: budget.eventDigest },
      },
      {
        at,
        eventId: randomUUID(),
        budgetEventId: randomUUID(),
        finalEventId: randomUUID(),
        finalizationNonce: randomUUID(),
      },
    ),
  ).toThrow();
});
it.each(["binding", "receipt", "event", "artifact"] as const)(
  "rejects missing %s in partial plans",
  (part) => {
    const s = structuredClone(captured.next);
    if (part === "binding") s.transmissionBindings = [];
    if (part === "receipt") s.reservation.archive.records.receipts.pop();
    if (part === "event") s.reservation.archive.records.events.pop();
    if (part === "artifact") s.reservation.archive.records.artifacts.pop();
    expect(() => inspectComparisonTransmissionState(s)).toThrow();
  },
);
it.each(["command", "review", "nonce", "native-digest", "authority"] as const)(
  "rejects rehashed binding %s tampering",
  (part) => {
    const s = structuredClone(dispatched.next),
      b = s.transmissionBindings[0];
    if (part === "command") b.command.expectedCoverageDigest = badHash;
    if (part === "review")
      (b.approvedReview as ComparisonTransmissionReview).capacity.totalExposureBytes++;
    if (part === "nonce") b.clientRequestId = randomUUID();
    if (part === "native-digest") b.nativeInputDigest = badHash;
    if (part === "authority") Object.assign(b, { dispatchAllowed: true });
    b.commandDigest = digest(b.command);
    const { recordDigest: _ignored, ...body } = b;
    void _ignored;
    b.recordDigest = digest(body);
    expect(() => inspectComparisonTransmissionState(s)).toThrow();
  },
);
it("rejects duplicate binding and absent explicit wrapper field", () => {
  const s = structuredClone(dispatched.next);
  s.transmissionBindings.push(s.transmissionBindings[0]);
  expect(() => inspectComparisonTransmissionState(s)).toThrow();
  expect(() => inspectComparisonTransmissionState({ reservation: reserved.reservation })).toThrow();
});
it("counts raw overhead and transmission binding bytes toward the capacity ceiling", () => {
  const s = structuredClone(dispatched.next);
  s.reservation.additionalUsedBytes = 256 * 1024 * 1024 - review.capacity.totalExposureBytes;
  expect(() => inspectComparisonTransmissionState(s)).toThrow();
});
it("rejects foreign native and budget heads", () => {
  const cur = current();
  expect(() =>
    planComparisonDispatch(
      reserved,
      { ...command, expectedBudgetHead: { ...command.expectedBudgetHead, headDigest: badHash } },
      cur,
    ),
  ).toThrow();
  expect(() =>
    planComparisonUnknown(
      dispatched.next,
      { ...unknownCommand, expectedRunHead: { revision: 2, headDigest: badHash } },
      { at, eventId: randomUUID() },
    ),
  ).toThrow();
});
it("does not mutate supplied rows or share replay/inspection results", () => {
  const before = digest(captured.next);
  const r = planComparisonDispatch(captured.next, command);
  r.authority.dispatchAllowed satisfies false;
  if (r.status === "replay") r.receipt.recordedAt = later;
  expect(digest(captured.next)).toBe(before);
});
it("rejects getters and toJSON before evaluating them", () => {
  let calls = 0;
  const raw = Object.defineProperty({}, "reservation", {
    get() {
      calls++;
      return reserved.reservation;
    },
    enumerable: true,
  });
  expect(() => inspectComparisonTransmissionState(raw)).toThrow();
  expect(() =>
    planComparisonDispatch(reserved, {
      ...command,
      toJSON() {
        calls++;
        return command;
      },
    }),
  ).toThrow();
  expect(calls).toBe(0);
});
it("rejects cyclic data and oversized command before serialization", () => {
  const raw: Record<string, unknown> = { ...command };
  raw.self = raw;
  expect(() => planComparisonDispatch(reserved, raw)).toThrow();
  expect(() => planComparisonDispatch(reserved, { ...command, extra: "x".repeat(8193) })).toThrow();
});
it("rejects reused event ID and nonce IDs", () => {
  const cur = { ...current(), eventId: command.clientRequestId };
  expect(() => planComparisonDispatch(reserved, command, cur)).toThrow();
});

it("does not renew original reservation expiry with a later transmission review", () => {
  const r = createComparisonTransmissionReview(
    reserved,
    fixture.company,
    command.runId,
    basis,
    "2026-10-05T10:05:00.000Z",
  );
  expect(r.expiresAt).toBe(review.expiresAt);
});
it("uses the earliest rehashed support-source expiry", () => {
  const b = structuredClone(basis);
  b.sources[0].validUntil = "2026-10-05T10:03:00.000Z";
  b.sources[0].recordDigest = digest(providerProposalSourceDigestInput(b.sources[0]));
  const r = createComparisonTransmissionReview(reserved, fixture.company, command.runId, b, at);
  expect(r.expiresAt).toBe(b.sources[0].validUntil);
});
it("rejects oversized supplied capture without truncating it or releasing the hold", () => {
  const original = digest(unknown.next);
  expect(() =>
    planComparisonCapture(unknown.next, captureCommand, {
      at: later,
      eventId: randomUUID(),
      capture: { ...capture, output: ["x".repeat(4 * 1024 * 1024 + 1)] },
    }),
  ).toThrow();
  expect(digest(unknown.next)).toBe(original);
});
it("rejects oversized review and binding even with rehashed bodies", () => {
  const s = structuredClone(dispatched.next);
  (s.transmissionBindings[0].approvedReview as ComparisonTransmissionReview).basis.notice.text =
    "x".repeat(65537);
  expect(() => inspectComparisonTransmissionState(s)).toThrow();
});
it("keeps a valid quoted comparison capture separate from cost assessment", () => {
  const prepared = preparePublicClaimComparison(fixture.company, fixture.request.command.selection);
  const response = {
    preparationDigest: prepared.preparationDigest,
    claimQuote: prepared.input.claimQuote,
    overall: { relation: "undetermined", reason: "Synthetic comparison only" },
    evidence: prepared.input.selectedEvidence.map((e) => ({
      sourceId: e.sourceId,
      relation: "undetermined",
      quotes: [],
      reason: "Needs review",
      nextCheck: "",
    })),
    checks: [],
  };
  const value = captureProviderResponse({
    id: "synthetic-valid",
    model: fixture.request.command.model,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(response) }],
      },
    ],
  });
  const c = captureFor(unknown.next, value);
  const r = planComparisonCapture(unknown.next, c, {
    at: later,
    eventId: randomUUID(),
    capture: value,
  });
  if (r.status !== "prepared-not-committed") throw Error("unexpected replay");
  expect(r.next.reservation.archive.financial).toEqual(reserved.reservation.archive.financial);
  // The pre/post inspector exercised the original exact-quote decoder as part of the plan.
  expect(r.rows.artifact?.body).toContain("Synthetic comparison only");
});
it("rejects a foreign capture dispatch binding and time reversal", () => {
  expect(() =>
    planComparisonCapture(
      unknown.next,
      { ...captureCommand, transmissionBindingDigest: badHash },
      { at: later, eventId: randomUUID(), capture },
    ),
  ).toThrow();
  expect(() =>
    planComparisonUnknown(dispatched.next, unknownFor(), {
      at: "2026-10-05T09:59:00.000Z",
      eventId: randomUUID(),
    }),
  ).toThrow();
});
