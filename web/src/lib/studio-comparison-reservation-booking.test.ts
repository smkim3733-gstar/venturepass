import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({
  open: vi.fn(),
  dbClose: vi.fn(),
  session: vi.fn(() => ({})),
  sessionClose: vi.fn(),
  factory: vi.fn(),
  check: vi.fn(),
  revoke: vi.fn(),
  forbidden: vi.fn(() => {
    throw Error("network forbidden");
  }),
}));
vi.mock("openai", calls.forbidden);
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    isTransaction = false;
    constructor(...args: unknown[]) {
      calls.open(...args);
    }
    close() {
      calls.dbClose();
    }
  },
}));
vi.mock("./studio-public-comparison-file-identity", () => ({
  checkComparisonDatabasePath: calls.check,
}));
vi.mock("./studio-comparison-company-capability", () => ({
  recordComparisonCompanyConnection: vi.fn(),
  issueComparisonCompanyGuard: vi.fn(() => ({})),
  revokeComparisonCompanyGuards: calls.revoke,
}));
vi.mock("./studio-public-comparison-storage-witness", () => ({
  openComparisonStorageSession: calls.session,
  closeComparisonStorageSession: calls.sessionClose,
}));
vi.mock("./studio-public-claim-comparison-database-v11", () => ({
  createPublicComparisonReservationStore: calls.factory,
}));
// Policy authenticity/full audit belong to the native SQL integration; isolate owner lifetime here.
vi.mock("./studio-public-claim-comparison-financial", async (original) => ({
  ...(await original<typeof import("./studio-public-claim-comparison-financial")>()),
  comparisonFinancialEvidenceSchema: z.object({ provenance: z.string(), tag: z.string() }).strict(),
}));
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { publicClaimComparisonFixture } from "./studio-public-claim-comparison-test-helpers";
import { buildPublicClaimComparisonRequest } from "./studio-public-claim-comparison-request";
import { createComparisonReservationBooking } from "./studio-comparison-reservation-booking";
const at = "2026-10-05T10:00:00.000Z",
  hash = "a".repeat(64);
const flags = {
  comparisonPurposeAcknowledged: true,
  selectedContentRetentionAcknowledged: true,
  currentBudgetReservationAcknowledged: true,
  financialBasisNotTokenFitAcknowledged: true,
  noAutomaticRetryAcknowledged: true,
};
function setup() {
  const f = publicClaimComparisonFixture();
  const request = buildPublicClaimComparisonRequest(f.company, {
    requestVersion: "public-claim-comparison-request-v1",
    model: "synthetic-model",
    selection: f.select(),
  });
  const input = {
    dataRoot: join(tmpdir(), "booking-unit", "data"),
    controlDirectory: join(tmpdir(), "booking-unit", "control"),
    databaseInstanceId: f.company.id,
    request: request.command,
    evidence: { provenance: "official-reviewed", tag: "synthetic-only" },
  };
  const body = {
    databaseInstanceId: input.databaseInstanceId,
    environment: "production",
    scopeId: "candidate-quality-provider-v2-live",
    request: request.command,
    identity: request.identity,
    financialBasis: { evidence: structuredClone(input.evidence) },
    companyId: f.company.id,
    companyRevision: f.company.revision,
    inspectedAt: at,
    expiresAt: "2026-10-05T10:10:00.000Z",
    archiveDigest: hash,
    budget: { revision: 1, headDigest: hash },
    globalRunCount: 0,
    notice: { noticeDigest: hash },
    retentionNoticeDigest: hash,
  };
  const review = { ...body, reviewDigest: digest(body) };
  let saved: Record<string, unknown> | null = null;
  const store = {
    review: vi.fn((request: unknown, evidence: unknown, at: string) => {
      void request;
      void evidence;
      void at;
      return structuredClone(review);
    }),
    reserve: vi.fn((command: Record<string, unknown>, current: { runId: string }) => {
      const bindingBody = {
        clientRequestId: command.clientRequestId,
        command,
        commandDigest: digest(command),
        runId: current.runId,
        reviewDigest: command.approvedReviewDigest,
        recordedAt: at,
      };
      saved = { ...bindingBody, recordDigest: digest(bindingBody) };
      return {
        status: "committed",
        witnessMatched: true,
        result: { status: "replay", binding: saved },
      };
    }),
    lookup: vi.fn((command: unknown) => {
      void command;
      return saved ? { status: "recorded", binding: saved } : { status: "not-observed" };
    }),
    close: vi.fn(() => ({ closed: true })),
  };
  calls.factory.mockReturnValue(store);
  return {
    input,
    store,
    review,
    consent: { ...flags, reviewDigest: review.reviewDigest },
    owner: createComparisonReservationBooking(input),
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  vi.stubGlobal("fetch", calls.forbidden);
});
afterEach(() => {
  expect(calls.forbidden).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it("pins a server reference before consent without preparing approval or writing", () => {
  const t = setup();
  expect(t.owner.inspect().clientRequestId).toBeNull();
  t.owner.review();
  const reference = t.owner.inspect();
  expect(reference.clientRequestId).toEqual(expect.any(String));
  expect(reference.runId).toEqual(expect.any(String));
  expect(t.store.reserve).not.toHaveBeenCalled();
  expect(() => t.owner.recover()).toThrow(/OWNER_UNAVAILABLE/);
  t.owner.review();
  expect(t.owner.inspect()).toEqual(reference);
  vi.setSystemTime("2026-10-05T10:01:00.000Z");
  const receipt = t.owner.reserve(t.consent).receipt;
  expect(receipt).toMatchObject({
    clientRequestId: reference.clientRequestId,
    runId: reference.runId,
  });
  expect(t.store.reserve.mock.calls[0][0].approval).toMatchObject({
    approvedAt: "2026-10-05T10:01:00.000Z",
  });
});
it("is passive, pins server inputs and exposes no execution or cancellation", () => {
  const t = setup();
  expect(calls.open).not.toHaveBeenCalled();
  expect(Object.keys(t.owner)).toEqual([
    "inspect",
    "review",
    "reserve",
    "recover",
    "revoke",
    "close",
  ]);
  t.input.evidence.tag = "edited";
  t.owner.review().companyRevision++;
  const result = t.owner.reserve(t.consent);
  expect(result).toMatchObject({
    status: "recorded",
    receipt: { acknowledgedReservationOnly: true, transmissionAllowed: false },
  });
  expect(t.store.reserve.mock.calls[0][0]).toMatchObject({
    companyRevision: 7,
    approvedReviewDigest: t.review.reviewDigest,
  });
  expect(t.store.review.mock.calls[0][1]).toMatchObject({ tag: "synthetic-only" });
  expect(t.owner.close()).toMatchObject({ status: "closed", retained: false });
});
it.each(Object.keys(flags))("requires explicit %s before any write", (flag) => {
  const t = setup();
  t.owner.review();
  expect(() => t.owner.reserve({ ...t.consent, [flag]: false })).toThrow();
  expect(t.store.reserve).not.toHaveBeenCalled();
});
it("refuses absent, changed, extra or expired consent before recording an attempt", () => {
  const t = setup();
  expect(() => t.owner.reserve(t.consent)).toThrow();
  t.owner.review();
  expect(() => t.owner.reserve({ ...t.consent, runId: t.input.databaseInstanceId })).toThrow();
  expect(() => t.owner.reserve({ ...t.consent, reviewDigest: "b".repeat(64) })).toThrow();
  vi.setSystemTime("2026-10-05T10:10:00.000Z");
  expect(() => t.owner.reserve(t.consent)).toThrow(/EXPIRED/);
  expect(t.owner.inspect()).toMatchObject({ status: "review", receipt: null });
  expect(() => t.owner.recover()).toThrow(/OWNER_UNAVAILABLE/);
  expect(t.store.reserve).not.toHaveBeenCalled();
});
it("duplicate reserve and revoked recovery only look up the original command", () => {
  const t = setup();
  t.owner.review();
  const first = t.owner.reserve(t.consent);
  expect(t.owner.reserve(t.consent).receipt).toEqual(first.receipt);
  t.owner.revoke();
  vi.setSystemTime("2027-01-01T00:00:00.000Z");
  expect(() => t.owner.review()).toThrow();
  expect(() => t.owner.reserve(t.consent)).toThrow();
  expect(t.owner.recover().receipt).toEqual(first.receipt);
  expect(t.store.reserve).toHaveBeenCalledTimes(1);
  expect(t.store.lookup).toHaveBeenCalledTimes(2);
  expect(t.store.lookup.mock.calls[0]).toEqual(t.store.lookup.mock.calls[1]);
});
it("lost write delivery retains the original command and recovers without another write", () => {
  const t = setup();
  t.owner.review();
  const write = t.store.reserve.getMockImplementation()!;
  t.store.reserve.mockImplementationOnce((...args) => {
    write(...args);
    throw Error("lost reply");
  });
  expect(() => t.owner.reserve(t.consent)).toThrow();
  const original = t.owner.inspect();
  expect(t.owner.recover()).toMatchObject({
    status: "recorded",
    runId: original.runId,
    clientRequestId: original.clientRequestId,
  });
  expect(t.store.reserve).toHaveBeenCalledTimes(1);
});
it("an unobserved attempt cannot mint a new nonce or retry the write", () => {
  const t = setup();
  t.owner.review();
  t.store.reserve.mockImplementationOnce(() => {
    throw Error("no write");
  });
  expect(() => t.owner.reserve(t.consent)).toThrow();
  const original = t.owner.inspect();
  expect(t.owner.reserve(t.consent)).toMatchObject({
    status: "not-observed",
    runId: original.runId,
  });
  expect(() => t.owner.review()).toThrow(/ATTEMPT_EXISTS/);
  expect(t.store.reserve).toHaveBeenCalledTimes(1);
});
it("missing witness confirmation and changed binding never produce a confirmed receipt", () => {
  const t = setup();
  t.owner.review();
  const write = t.store.reserve.getMockImplementation()!;
  t.store.reserve.mockImplementationOnce((...args) => ({
    ...write(...args),
    witnessMatched: false,
  }));
  expect(() => t.owner.reserve(t.consent)).toThrow(/CONFIRMATION/);
  expect(t.owner.inspect().receipt).toBeNull();
  t.store.lookup.mockReturnValueOnce({ status: "recorded", binding: {} });
  expect(() => t.owner.recover()).toThrow(/MISMATCH/);
  expect(t.owner.inspect().receipt).toBeNull();
});
it.each(["databaseInstanceId", "environment", "scopeId", "reviewDigest"] as const)(
  "rejects changed native review %s",
  (key) => {
    const t = setup();
    t.review[key] = "changed";
    expect(() => t.owner.review()).toThrow(/MISMATCH/);
    expect(() => t.owner.reserve(t.consent)).toThrow();
    expect(t.store.reserve).not.toHaveBeenCalled();
  },
);
it("failed re-review clears the prior review", () => {
  const t = setup();
  t.owner.review();
  t.store.review.mockImplementationOnce(() => {
    throw Error("changed archive");
  });
  expect(() => t.owner.review()).toThrow();
  expect(() => t.owner.reserve(t.consent)).toThrow();
  expect(t.store.reserve).not.toHaveBeenCalled();
});
it("partial acquisition is never repeated and preserves its original close", () => {
  const t = setup();
  calls.factory.mockImplementationOnce(() => {
    throw Error("factory failed");
  });
  expect(() => t.owner.review()).toThrow(/ACQUISITION/);
  expect(() => t.owner.review()).toThrow(/CLEANUP/);
  expect(calls.open).toHaveBeenCalledTimes(1);
  calls.sessionClose.mockImplementationOnce(() => {
    throw Error("hold");
  });
  expect(t.owner.close().status).toBe("draining");
  expect(calls.dbClose).not.toHaveBeenCalled();
  expect(t.owner.close()).toMatchObject({ status: "closed", retained: false });
  expect(calls.dbClose).toHaveBeenCalledTimes(1);
});
it("failed store cleanup retains that exact owner and blocks new work", () => {
  const t = setup();
  t.owner.review();
  t.store.close.mockImplementationOnce(() => {
    throw Error("rollback pending");
  });
  expect(t.owner.close().status).toBe("draining");
  expect(calls.sessionClose).not.toHaveBeenCalled();
  expect(() => t.owner.review()).toThrow(/CLOSED/);
  expect(t.owner.close().status).toBe("closed");
  expect(calls.factory).toHaveBeenCalledTimes(1);
});
it("rejects relative/mismatched paths, synthetic evidence and caller company overrides", () => {
  const t = setup();
  for (const extra of [
    { dataRoot: "relative" },
    { controlDirectory: t.input.dataRoot },
    { controlDirectory: join(t.input.dataRoot, "nested") },
    { company: {} },
    { evidence: { ...t.input.evidence, provenance: "synthetic-test" } },
  ])
    expect(() => createComparisonReservationBooking({ ...t.input, ...extra })).toThrow();
  expect(calls.open).not.toHaveBeenCalled();
});
