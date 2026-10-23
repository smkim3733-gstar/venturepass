import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Forbidden IO");
  }),
);
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor() {
      forbidden();
    }
  },
  backup: forbidden,
}));
vi.mock("openai", forbidden);
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { createComparisonExecutionPostcapture } from "./studio-comparison-execution-postcapture";
const id = "4900300f-313a-4114-bbf5-5b0d33b7c824",
  hash = "a".repeat(64);
function setup() {
  const selection = { runId: id, dispatchCommandDigest: hash };
  const p = {
    ...selection,
    transmissionBindingDigest: hash,
    dispatchEventDigest: hash,
    responseArtifactSha256: hash,
    responseArtifactByteLength: 100,
    expectedValidatedArtifactSha256: hash,
    comparisonState: "completed",
    expectedRunHead: { revision: 3, headDigest: hash },
    expectedBudgetHead: { revision: 2, headDigest: hash },
    comparisonEventDigest: hash,
    expectedAssessmentDigest: hash,
    usage: {
      status: "known",
      usagePolicyDigest: hash,
      assessment: { units: "123", violations: [] as string[] },
    },
    database: { comparisonRecorded: false, costSettled: false, finalized: false },
  };
  const receipt = (command: unknown) => ({
    runId: id,
    commandDigest: digest(command),
    status: "committed",
    witnessMatched: true,
  });
  const runtime = {
    previewPostcapture: vi.fn(() => structuredClone(p)),
    writePostcapture: vi.fn((operation: unknown, command: unknown, current: unknown) => {
      void operation;
      void current;
      return receipt(command);
    }),
    recoverPostcapture: vi.fn((operation: unknown, command: unknown) => {
      void operation;
      return { ...receipt(command), status: "replay" };
    }),
  };
  const original = vi.fn(() => selection);
  const owner = createComparisonExecutionPostcapture(runtime as never, original, () => ({
    currency: "USD",
    unitScale: 6,
  }));
  return { owner, runtime, p, original };
}
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
it("is passive, requires review, binds original selection and never returns commands or raw artifacts", () => {
  const f = setup();
  expect(f.runtime.previewPostcapture).not.toHaveBeenCalled();
  expect(() => f.owner.write("record-result", hash)).toThrow(/REVIEW_REQUIRED/);
  const visible = f.owner.preview();
  expect(f.runtime.previewPostcapture).toHaveBeenCalledWith({
    runId: id,
    dispatchCommandDigest: hash,
  });
  expect(visible.review).toMatchObject({
    units: "123",
    comparisonRecorded: false,
    currency: "USD",
  });
  expect(JSON.stringify(visible)).not.toMatch(/responseArtifact|expectedRunHead|command/);
  visible.review!.reviewDigest = "b".repeat(64);
  expect(() => f.owner.write("record-result", visible.review!.reviewDigest)).toThrow();
  f.owner.write("record-result", f.owner.inspect().review!.reviewDigest);
  const [operation, command, current] = f.runtime.writePostcapture.mock.calls[0];
  expect(operation).toBe("record-result");
  expect(command).toMatchObject({
    runId: id,
    expectedRunHead: f.p.expectedRunHead,
    responseArtifactSha256: hash,
  });
  expect(current).toMatchObject({ at: expect.any(String), eventId: expect.any(String) });
  expect(f.owner.inspect()).toMatchObject({ record: "stored", review: null });
});
it("retains exact command on lost write and recovery failure; repeat never calls writer again", () => {
  const f = setup(),
    r = f.owner.preview().review!.reviewDigest;
  f.runtime.writePostcapture.mockImplementation(() => {
    throw Error("commit outcome unknown");
  });
  expect(() => f.owner.write("record-result", r)).toThrow();
  const command = structuredClone(f.runtime.writePostcapture.mock.calls[0][1]);
  expect(f.owner.inspect()).toMatchObject({ record: "recovery-required", review: null });
  expect(() => f.owner.preview()).toThrow(/RECOVERY_REQUIRED/);
  f.runtime.recoverPostcapture.mockImplementationOnce(() => {
    throw Error("read unavailable");
  });
  expect(() => f.owner.recover("record-result")).toThrow();
  expect(() => f.owner.write("record-result", "b".repeat(64))).toThrow(/ORIGINAL_REVIEW_REQUIRED/);
  f.owner.write("record-result", r);
  expect(f.runtime.writePostcapture).toHaveBeenCalledTimes(1);
  expect(
    f.runtime.recoverPostcapture.mock.calls.every((c) => digest(c[1]) === digest(command)),
  ).toBe(true);
  expect(f.owner.inspect().record).toBe("stored");
});
it("refresh failure or changed original selection invalidates the former review", () => {
  const f = setup(),
    r = f.owner.preview().review!.reviewDigest;
  f.p.dispatchCommandDigest = "b".repeat(64);
  expect(() => f.owner.preview()).toThrow(/SELECTION_CHANGED/);
  expect(() => f.owner.write("record-result", r)).toThrow(/REVIEW_REQUIRED/);
  expect(f.runtime.writePostcapture).not.toHaveBeenCalled();
});
it.each([
  "unknown",
  "missing-assessment",
  "missing-policy",
  "not-recorded",
  "settled",
  "finalized",
])("refuses settlement when %s and never releases cost by guessing", (kind) => {
  const f = setup();
  f.p.database.comparisonRecorded = true;
  if (kind === "unknown") f.p.usage.status = "unknown";
  if (kind === "missing-assessment") f.p.expectedAssessmentDigest = "";
  if (kind === "missing-policy") f.p.usage.usagePolicyDigest = "";
  if (kind === "not-recorded") f.p.database.comparisonRecorded = false;
  if (kind === "settled") f.p.database.costSettled = true;
  if (kind === "finalized") f.p.database.finalized = true;
  const r = f.owner.preview().review!.reviewDigest;
  expect(() => f.owner.write("settle-finalize", r)).toThrow(/NOT_READY/);
  expect(f.runtime.writePostcapture).not.toHaveBeenCalled();
});
it("settles only from the refreshed capture assessment and preserves exact replay after finalization", () => {
  const f = setup();
  f.p.database.comparisonRecorded = true;
  f.p.usage.assessment.violations = ["over-limit"];
  const r = f.owner.preview().review!;
  expect(r.hasPolicyViolations).toBe(true);
  f.owner.write("settle-finalize", r.reviewDigest);
  expect(f.runtime.writePostcapture.mock.calls[0][1]).toMatchObject({
    comparisonEventDigest: hash,
    usagePolicyDigest: hash,
    expectedAssessmentDigest: hash,
  });
  expect(Object.keys(f.runtime.writePostcapture.mock.calls[0][2] as object)).toHaveLength(7);
  f.p.database.costSettled = true;
  f.p.database.finalized = true;
  f.owner.preview();
  f.owner.recover("settle-finalize");
  expect(f.runtime.writePostcapture).toHaveBeenCalledTimes(1);
  expect(f.owner.inspect().settlement).toBe("stored");
});
it("does not declare storage on a mismatched receipt or missing witness and requires original owner", () => {
  const f = setup(),
    r = f.owner.preview().review!.reviewDigest;
  f.runtime.writePostcapture.mockReturnValueOnce({
    runId: id,
    commandDigest: "b".repeat(64),
    status: "committed",
    witnessMatched: true,
  });
  expect(() => f.owner.write("record-result", r)).toThrow(/RECEIPT_MISMATCH/);
  f.runtime.recoverPostcapture.mockImplementationOnce((_, command) => ({
    runId: id,
    commandDigest: digest(command),
    status: "replay",
    witnessMatched: false,
  }));
  expect(f.owner.recover("record-result").record).toBe("recovery-required");
  f.original.mockImplementation(() => {
    throw Error("owner closed");
  });
  expect(() => f.owner.recover("record-result")).toThrow(/closed/);
  expect(() => f.owner.write("record-result", r)).toThrow(/closed/);
});
