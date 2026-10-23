import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("IO forbidden");
  }),
);
vi.mock("openai", forbidden);
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor() {
      forbidden();
    }
  },
}));
// Policy auditing is exercised by the real SQL13 integration. These minimal policies
// isolate confirmation/lifetime behavior without manufacturing an operational policy.
vi.mock("./studio-public-claim-comparison-transmission-types", async (original) => ({
  ...(await original<typeof import("./studio-public-claim-comparison-transmission-types")>()),
  comparisonTransmissionBasisSchema: z
    .object({ tag: z.string(), notice: z.object({ noticeDigest: z.string() }) })
    .strict(),
}));
vi.mock("./studio-public-claim-comparison-usage", async (original) => ({
  ...(await original<typeof import("./studio-public-claim-comparison-usage")>()),
  comparisonUsagePolicySchema: z.object({ tag: z.string() }).strict(),
}));
import { createComparisonExecutionApproval } from "./studio-comparison-execution-approval";
const id = "4900300f-313a-4114-bbf5-5b0d33b7c824";
const otherId = "5900300f-313a-4114-bbf5-5b0d33b7c824";
const hash = "a".repeat(64),
  otherHash = "b".repeat(64);
const now = "2026-10-14T05:00:00.000Z";
const flags = {
  externalTransmissionAcknowledged: true,
  comparisonPurposeAcknowledged: true,
  singleCallAcknowledged: true,
  noAutomaticRetryAcknowledged: true,
  unknownCostHoldAcknowledged: true,
  noResendAcknowledged: true,
  localRetentionAcknowledged: true,
};
function setup() {
  const settings = {
    companyId: id,
    companyRevision: 2,
    runId: id,
    basis: { tag: "original-basis", notice: { noticeDigest: hash } },
    usagePolicy: { tag: "original-policy" },
  };
  const review = {
    runId: id,
    request: { selection: { companyId: id, companyRevision: 2 } },
    basis: structuredClone(settings.basis),
    usagePolicy: structuredClone(settings.usagePolicy),
    reviewDigest: hash,
    inspectedAt: now,
    expiresAt: "2026-10-14T05:10:00.000Z",
    runDigest: hash,
    reservationBindingDigest: hash,
    transmissionArchiveDigest: hash,
    coverageDigest: hash,
    runHead: { revision: 1, headDigest: hash },
    budget: { revision: 1, headDigest: hash },
    usagePolicyDigest: hash,
    retentionNoticeDigest: hash,
    identity: { requestDigest: hash },
  };
  const runtime = {
    prepareTransmission: vi.fn(() => structuredClone({ review, reservation: {} })),
    execute: vi.fn(async (command: unknown, context: unknown) => {
      void command;
      void context;
      return { phase: "replay" };
    }),
    recover: vi.fn((selection: unknown) => selection),
    inspect: vi.fn(() => ({ status: "ready" })),
    close: vi.fn(() => ({ status: "closed" })),
  };
  const approval = createComparisonExecutionApproval(runtime as never, settings);
  return {
    approval,
    runtime,
    settings,
    review,
    consent: { clientRequestId: otherId, reviewDigest: hash, ...flags },
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(forbidden).not.toHaveBeenCalled();
});

it("construction is passive and caller mutation cannot replace the original server policy or reviewed version", async () => {
  const t = setup();
  expect(t.runtime.prepareTransmission).not.toHaveBeenCalled();
  expect(t.runtime.execute).not.toHaveBeenCalled();
  t.settings.basis.tag = "changed";
  t.settings.usagePolicy.tag = "changed";
  const visible = t.approval.preview();
  visible.review.budget.revision = 999;
  expect(t.runtime.prepareTransmission).toHaveBeenCalledWith(
    { companyId: id, companyRevision: 2, runId: id },
    t.review.basis,
    t.review.usagePolicy,
    now,
  );
  await t.approval.execute(t.consent);
  const [command, context] = t.runtime.execute.mock.calls[0] as [
    Record<string, unknown>,
    { at: string; approvedReview: typeof t.review; basis: typeof t.settings.basis },
  ];
  expect(command.expectedBudgetHead).toEqual({ revision: 1, headDigest: hash });
  expect(context.approvedReview).toEqual(t.review);
  expect(context.at).toBe(now);
  expect(context.basis.tag).toBe("original-basis");
});
it("missing or different preview cannot authorize execution", () => {
  const t = setup();
  expect(() => t.approval.execute(t.consent)).toThrow("REVIEW_REQUIRED");
  t.approval.preview();
  expect(() => t.approval.execute({ ...t.consent, reviewDigest: otherHash })).toThrow(
    "REVIEW_REQUIRED",
  );
  expect(t.runtime.execute).not.toHaveBeenCalled();
});
it.each(Object.keys(flags))("requires explicit true for %s", (flag) => {
  const t = setup();
  t.approval.preview();
  for (const value of [false, undefined, "true"])
    expect(() => t.approval.execute({ ...t.consent, [flag]: value })).toThrow();
  expect(t.runtime.execute).not.toHaveBeenCalled();
});
it.each(["approvedAt", "approvedReview", "basis", "company", "apiKey", "expectedBudgetHead"])(
  "confirmation cannot supply %s",
  (key) => {
    const t = setup();
    t.approval.preview();
    expect(() => t.approval.execute({ ...t.consent, [key]: "substitution" })).toThrow();
    expect(t.runtime.execute).not.toHaveBeenCalled();
  },
);
it.each(["2026-10-14T04:59:59.999Z", "2026-10-14T05:10:00.000Z"])(
  "refuses a fresh execution outside its reviewed interval: %s",
  (at) => {
    const t = setup();
    t.approval.preview();
    vi.setSystemTime(at);
    expect(() => t.approval.execute(t.consent)).toThrow("EXPIRED");
    expect(t.runtime.execute).not.toHaveBeenCalled();
  },
);
it("failed refresh discards the former review", () => {
  const t = setup();
  t.approval.preview();
  t.runtime.prepareTransmission.mockImplementation(() => {
    throw Error("unavailable");
  });
  expect(() => t.approval.preview()).toThrow();
  expect(() => t.approval.execute(t.consent)).toThrow("REVIEW_REQUIRED");
});
it("in-flight duplicate clicks share one invocation and reject a different nonce", async () => {
  const t = setup();
  t.approval.preview();
  let resolve!: (value: { phase: string }) => void;
  t.runtime.execute.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = t.approval.execute(t.consent);
  expect(t.approval.execute({ ...t.consent })).toBe(first);
  expect(() => t.approval.execute({ ...t.consent, clientRequestId: id })).toThrow(
    "ORIGINAL_CONFIRMATION_REQUIRED",
  );
  expect(() => t.approval.preview()).toThrow("PREVIEW_CLOSED");
  expect(t.runtime.execute).toHaveBeenCalledTimes(1);
  resolve({ phase: "replay" });
  await first;
});
it("failed invocation retains exact original time event and command for an explicit replay", async () => {
  const t = setup();
  t.approval.preview();
  let original: unknown;
  t.runtime.execute.mockImplementationOnce((command, context) => {
    original = structuredClone([command, context]);
    (context as { at: string }).at = "mutated";
    throw Error("lost return");
  });
  await expect(t.approval.execute(t.consent)).rejects.toThrow("lost return");
  vi.setSystemTime("2026-10-15T00:00:00Z");
  await t.approval.execute(t.consent);
  expect(t.runtime.execute.mock.calls[1]).toEqual(original);
  t.approval.recover();
  expect(t.runtime.recover).toHaveBeenCalledWith(t.approval.inspect().selection);
});
it("a different reserved run or policy is never shown as the bound review", () => {
  const t = setup();
  t.review.runId = otherId;
  expect(() => t.approval.preview()).toThrow("REVIEW_MISMATCH");
  t.review.runId = id;
  t.review.basis.tag = "substituted";
  expect(() => t.approval.preview()).toThrow("REVIEW_MISMATCH");
  expect(t.approval.inspect().reviewDigest).toBeNull();
});
it("closing retains failed original cleanup and permits only recovery or explicit close retry", async () => {
  const t = setup();
  t.approval.preview();
  await t.approval.execute(t.consent);
  t.runtime.close.mockReturnValueOnce({ status: "draining" });
  expect(t.approval.close().status).toBe("draining");
  expect(() => t.approval.execute(t.consent)).toThrow("CLOSED");
  expect(() => t.approval.preview()).toThrow("CLOSED");
  t.approval.recover();
  expect(t.runtime.recover).toHaveBeenCalledTimes(1);
  expect(t.approval.close().status).toBe("closed");
  expect(() => t.approval.recover()).toThrow("OWNER_REQUIRED");
});
it("input accessors are never invoked", () => {
  const t = setup(),
    getter = vi.fn();
  t.approval.preview();
  const input = Object.defineProperty({}, "clientRequestId", { get: getter, enumerable: true });
  expect(() => t.approval.execute(input)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("draining blocks new postcapture writes but leaves original recovery available", async () => {
  const f = setup();
  f.approval.preview();
  await f.approval.execute(f.consent);
  f.runtime.close.mockReturnValueOnce({ status: "draining" });
  expect(f.approval.close().status).toBe("draining");
  expect(() => f.approval.previewPostcapture()).toThrow("OWNER_REQUIRED");
  expect(() => f.approval.writePostcapture("record-result", hash)).toThrow("OWNER_REQUIRED");
  expect(() => f.approval.recoverPostcapture("record-result")).toThrow("ORIGINAL_COMMAND_REQUIRED");
  f.approval.close();
  expect(() => f.approval.recoverPostcapture("record-result")).toThrow("OWNER_REQUIRED");
});
