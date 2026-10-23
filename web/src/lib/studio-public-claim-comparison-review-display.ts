import type { IsolatedPublicComparisonService } from "./studio-public-claim-comparison-database-v11";

// Same-process, already audited DTOs only. This is display ordering, not a wire decoder.
export type StoredComparisonReview = Omit<ReturnType<IsolatedPublicComparisonService["readStoredReviewByRun"]>, "source"> & {
  source: "synthetic-comparison-stored-review" | "comparison-stored-review";
};
export type ComparisonReviewDisplaySelection = {
  runId: string;
  dispatchCommandDigest: string;
  mode: "historical" | "inspect-current";
  selection: StoredComparisonReview["resultIdentity"]["selection"];
  binding: StoredComparisonReview["resultIdentity"]["binding"];
  sectionKey: string;
};
type Snapshot = { id: string; revision: number };
export type ComparisonReviewDisplayFrame = {
  latest: ComparisonReviewDisplayTicket;
  snapshot: Snapshot;
  expected: ComparisonReviewDisplaySelection;
  mounted: boolean;
  open: boolean;
  blocked: boolean;
  dirty: boolean;
  aborted: boolean;
};
export type ComparisonReviewDisplayTicket = Readonly<{
  sequence: number;
  isCurrent(frame: ComparisonReviewDisplayFrame): boolean;
  accept(result: StoredComparisonReview, frame: ComparisonReviewDisplayFrame): StoredComparisonReview | null;
}>;
function identity(value: ComparisonReviewDisplaySelection) {
  const { selection: s, binding: b } = value;
  return JSON.stringify([value.runId, value.dispatchCommandDigest, value.mode,
    s.companyId, s.companyRevision, s.claimRecordId, s.claimVersion, s.claimInputDigest, s.sourceIds,
    b.claimId, b.claimRecordSha256, b.planId, b.planVersion, b.planContentSha256, value.sectionKey]);
}

/** Capture before awaiting. Caller advances sequence and replaces latest on every screen change.
 * Keep using isCurrent for errors and accept for results; neither cancels server work or recovery.
 */
export function createComparisonReviewDisplayTicket(
  sequence: number, snapshot: Snapshot, expected: ComparisonReviewDisplaySelection,
): ComparisonReviewDisplayTicket {
  if (!Number.isSafeInteger(sequence) || sequence < 1 ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
      snapshot.id !== expected.selection.companyId)
    throw Error("PUBLIC_COMPARISON_DISPLAY_TICKET_INVALID");
  const original = structuredClone(expected);
  const key = identity(original), companyId = snapshot.id, revision = snapshot.revision;
  const isCurrent = (frame: ComparisonReviewDisplayFrame) =>
    frame.latest === ticket && frame.latest.sequence === sequence &&
    frame.snapshot === snapshot && frame.snapshot.id === companyId && frame.snapshot.revision === revision &&
    frame.mounted && frame.open && !frame.blocked && !frame.dirty && !frame.aborted &&
    identity(frame.expected) === key;
  const ticket: ComparisonReviewDisplayTicket = Object.freeze({
    sequence,
    isCurrent,
    accept(result, frame) {
      if (!isCurrent(frame) || identity({ ...original, ...result.resultIdentity,
        sectionKey: result.historical.prepared.input.section.key }) !== key ||
        result.current.originalRevision !== original.selection.companyRevision) return null;
      const current = result.current;
      if (original.mode === "historical") {
        if (current.status !== "not-checked" || current.observedRevision !== null) return null;
      } else {
        if (current.status === "not-checked" ||
            (current.observedRevision !== null && current.observedRevision !== revision)) return null;
        if (current.status === "exact-original-request" &&
            (current.observedRevision !== current.originalRevision || current.originalRevision !== revision)) return null;
        if (current.status === "changed" && current.observedRevision === null) return null;
      }
      // Copy only; preserve historical/current/hold and every false authority boundary.
      return structuredClone(result);
    },
  });
  return ticket;
}
