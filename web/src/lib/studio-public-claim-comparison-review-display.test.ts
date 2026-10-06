import { expect, it } from "vitest";
import { createComparisonReviewDisplayTicket, type ComparisonReviewDisplayFrame,
  type ComparisonReviewDisplaySelection, type StoredComparisonReview } from "./studio-public-claim-comparison-review-display";

function fixture() {
  const expected: ComparisonReviewDisplaySelection = {
    runId: "run-original", dispatchCommandDigest: "dispatch-original", mode: "inspect-current",
    selection: { companyId: "company-original", companyRevision: 7, claimRecordId: "record-original",
      claimVersion: 2, claimInputDigest: "claim-digest", sourceIds: ["source-a", "source-b"] },
    binding: { claimId: "claim-original", claimRecordSha256: "record-hash", planId: "plan-original",
      planVersion: 3, planContentSha256: "plan-hash" }, sectionKey: "market",
  };
  const snapshot = { id: expected.selection.companyId, revision: 7 };
  const ticket = createComparisonReviewDisplayTicket(1, snapshot, expected);
  const frame: ComparisonReviewDisplayFrame = { latest: ticket, snapshot, expected,
    mounted: true, open: true, blocked: false, dirty: false, aborted: false };
  // An intentionally opaque, same-process DTO fixture: no server/wire decoder is imported.
  const result = {
    source: "synthetic-comparison-stored-review", owner: null, runtimeObserved: false,
    authority: { transmissionAllowed: false, factVerified: false, humanAccepted: false },
    resultIdentity: { runId: expected.runId, dispatchCommandDigest: expected.dispatchCommandDigest,
      selection: structuredClone(expected.selection), binding: structuredClone(expected.binding),
      comparisonEventDigest: "event-original", responseArtifactSha256: "response-original", validatedArtifactSha256: "validated-original" },
    historical: { currentContextVerified: false, prepared: { input: { section: { key: "market", content: "original text" } } },
      result: { source: "supplied-response", evidenceOrigin: "manual-unverified", comparison: null, currentContextVerified: false } },
    database: { comparisonRecorded: true, finalized: false, scopeHeldUnits: "123", currentContextVerified: false },
    current: { status: "exact-original-request", originalRevision: 7, observedRevision: 7, reason: null },
  } as unknown as StoredComparisonReview;
  return { ticket, frame, expected, snapshot, result };
}
it("4I34 display accepts only the captured request and returns an independent unchanged DTO", () => {
  const { ticket, frame, result } = fixture();
  const copy = ticket.accept(result, frame)!;
  expect(copy).toEqual(result); expect(copy).not.toBe(result);
  copy.historical.prepared.input.section.content = "edited copy";
  copy.resultIdentity.selection.sourceIds.reverse();
  expect(result.historical.prepared.input.section.content).toBe("original text");
  expect(result.resultIdentity.selection.sourceIds).toEqual(["source-a", "source-b"]);
  expect(copy.historical.result.comparison).toBeNull();
  expect(Object.values(copy.authority).every((v) => v === false)).toBe(true);
});
for (const flag of ["mounted", "open", "blocked", "dirty", "aborted"] as const)
  it("4I34 display discards result and error after " + flag, () => {
    const { ticket, frame, result } = fixture();
    frame[flag] = !frame[flag];
    expect(ticket.isCurrent(frame)).toBe(false); expect(ticket.accept(result, frame)).toBeNull();
  });
for (const change of ["snapshot", "revision", "company", "sources", "claim", "plan", "run", "dispatch", "mode", "section"] as const)
  it("4I34 display detects captured scalar and selection change: " + change, () => {
    const { ticket, frame, result } = fixture();
    if (change === "snapshot") frame.snapshot = { ...frame.snapshot };
    if (change === "revision") frame.snapshot.revision++;
    if (change === "company") frame.snapshot.id = "other";
    if (change === "sources") frame.expected.selection.sourceIds.reverse();
    if (change === "claim") frame.expected.selection.claimVersion++;
    if (change === "plan") frame.expected.binding.planVersion++;
    if (change === "run") frame.expected.runId = "other";
    if (change === "dispatch") frame.expected.dispatchCommandDigest = "other";
    if (change === "mode") frame.expected.mode = "historical";
    if (change === "section") frame.expected.sectionKey = "other";
    expect(ticket.isCurrent(frame)).toBe(false); expect(ticket.accept(result, frame)).toBeNull();
  });
it("4I34 display checks every returned original identity without replacing it with latest values", () => {
  const { ticket, frame, result } = fixture();
  const variants = [
    (r: StoredComparisonReview) => { r.resultIdentity.runId = "other"; },
    (r: StoredComparisonReview) => { r.resultIdentity.dispatchCommandDigest = "other"; },
    (r: StoredComparisonReview) => { r.resultIdentity.selection.companyId = "other"; },
    (r: StoredComparisonReview) => { r.resultIdentity.selection.companyRevision++; },
    (r: StoredComparisonReview) => { r.resultIdentity.selection.claimRecordId = "other"; },
    (r: StoredComparisonReview) => { r.resultIdentity.selection.claimVersion++; },
    (r: StoredComparisonReview) => { r.resultIdentity.selection.claimInputDigest = "other"; },
    (r: StoredComparisonReview) => { r.resultIdentity.selection.sourceIds.reverse(); },
    (r: StoredComparisonReview) => { r.resultIdentity.binding.planId = "other"; },
    (r: StoredComparisonReview) => { r.resultIdentity.binding.planVersion++; },
    (r: StoredComparisonReview) => { r.resultIdentity.binding.planContentSha256 = "other"; },
    (r: StoredComparisonReview) => { r.resultIdentity.binding.claimId = "other"; },
    (r: StoredComparisonReview) => { r.resultIdentity.binding.claimRecordSha256 = "other"; },
    (r: StoredComparisonReview) => { r.historical.prepared.input.section.key = "other"; },
  ];
  for (const mutate of variants) { const copy = structuredClone(result); mutate(copy); expect(ticket.accept(copy, frame)).toBeNull(); }
});
it("4I34 display historical mode never inherits an earlier current observation", () => {
  const { frame, result } = fixture();
  frame.expected.mode = "historical";
  const ticket = createComparisonReviewDisplayTicket(2, frame.snapshot, frame.expected); frame.latest = ticket;
  expect(ticket.accept(result, frame)).toBeNull();
  result.current = { ...result.current, status: "not-checked", observedRevision: null };
  expect(ticket.accept(result, frame)).toEqual(result);
  result.current.observedRevision = 7;
  expect(ticket.accept(result, frame)).toBeNull();
});
it("4I34 display separates exact changed unavailable and mismatched observed revisions", () => {
  const { ticket, frame, result } = fixture();
  for (const status of ["exact-original-request", "changed", "unavailable"] as const) {
    result.current.status = status; result.current.observedRevision = 7;
    expect(ticket.accept(result, frame)).toEqual(result);
    result.current.observedRevision = 8; expect(ticket.accept(result, frame)).toBeNull();
    result.current.observedRevision = null;
    expect(ticket.accept(result, frame) !== null).toBe(status === "unavailable");
  }
  result.current.status = "not-checked"; expect(ticket.accept(result, frame)).toBeNull();
  result.current.originalRevision = 8; result.current.status = "unavailable";
  expect(ticket.accept(result, frame)).toBeNull();
});
it("4I34 display can show a changed historical request on a newer explicitly captured snapshot", () => {
  const { frame, result } = fixture(); frame.snapshot.revision = 8;
  const ticket = createComparisonReviewDisplayTicket(2, frame.snapshot, frame.expected); frame.latest = ticket;
  result.current = { status: "changed", originalRevision: 7, observedRevision: 8, reason: "PUBLIC_CLAIM_STALE" };
  expect(ticket.accept(result, frame)).toEqual(result);
  result.current.status = "exact-original-request"; expect(ticket.accept(result, frame)).toBeNull();
});
it("4I34 display reverse completions discard old success and error without cancelling server responsibility", async () => {
  const { ticket, frame, result } = fixture();
  let finishOld!: (r: StoredComparisonReview) => void, failOld!: (e: Error) => void;
  const late = new Promise<StoredComparisonReview>((resolve) => { finishOld = resolve; });
  const error = new Promise<StoredComparisonReview>((_, reject) => { failOld = reject; });
  const oldSuccess = late.then((value) => ticket.accept(value, frame));
  const oldError = error.catch(() => ticket.isCurrent(frame));
  const next = createComparisonReviewDisplayTicket(2, frame.snapshot, frame.expected); frame.latest = next;
  expect(next.accept(result, frame)).toEqual(result);
  finishOld(result); failOld(Error("late error"));
  expect(await oldSuccess).toBeNull(); expect(await oldError).toBe(false);
  const duplicate = createComparisonReviewDisplayTicket(2, frame.snapshot, frame.expected);
  expect(duplicate.isCurrent(frame)).toBe(false);
  expect(Object.keys(ticket)).toEqual(["sequence", "isCurrent", "accept"]);
});
it("4I34 display rejects invalid ticket number and unrelated initial company", () => {
  const { frame } = fixture();
  for (const n of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => createComparisonReviewDisplayTicket(n, frame.snapshot, frame.expected)).toThrow(/TICKET_INVALID/);
  expect(() => createComparisonReviewDisplayTicket(1, { id: "other", revision: 7 }, frame.expected)).toThrow();
});
