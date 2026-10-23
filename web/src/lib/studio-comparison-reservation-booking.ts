import "server-only";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { samePath } from "../../scripts/local-data-files.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import { comparisonFinancialEvidenceSchema } from "./studio-public-claim-comparison-financial";
import { publicClaimComparisonRequestCommandSchema } from "./studio-public-claim-comparison-request";
import {
  comparisonReserveCommandSchema,
  type ComparisonReservationReview,
} from "./studio-public-claim-comparison-reservation";
import { checkComparisonDatabasePath } from "./studio-public-comparison-file-identity";
import {
  recordComparisonCompanyConnection,
  issueComparisonCompanyGuard,
  revokeComparisonCompanyGuards,
} from "./studio-comparison-company-capability";
import {
  openComparisonStorageSession,
  closeComparisonStorageSession,
  type ComparisonStorageSession,
} from "./studio-public-comparison-storage-witness";
import { createPublicComparisonReservationStore } from "./studio-public-claim-comparison-database-v11";
import { comparisonReservationConsentSchema } from "./studio-comparison-booking-wire";
export { comparisonReservationConsentSchema } from "./studio-comparison-booking-wire";

const inputSchema = z
  .object({
    dataRoot: z.string().min(1),
    controlDirectory: z.string().min(1),
    databaseInstanceId: z.string().uuid(),
    request: publicClaimComparisonRequestCommandSchema,
    evidence: comparisonFinancialEvidenceSchema,
  })
  .strict();
type Store = ReturnType<typeof createPublicComparisonReservationStore>;
type Binding = Extract<ReturnType<Store["lookup"]>, { status: "recorded" }>["binding"];
type Phase =
  "unused" | "review" | "attempted" | "recorded" | "not-observed" | "blocked" | "failed" | "closed";

/** Explicit trusted server composition. Passive until review; no env/key/provider access,
 * schema/budget/policy creation or external transmission. Retain one owner per attempt. */
export function createComparisonReservationBooking(raw: unknown) {
  assertPublicComparisonDataOnly(raw, 128 * 1024);
  const input = structuredClone(inputSchema.parse(raw));
  if (
    !isAbsolute(input.dataRoot) ||
    !isAbsolute(input.controlDirectory) ||
    samePath(input.dataRoot, input.controlDirectory) ||
    !samePath(dirname(resolve(input.dataRoot)), dirname(resolve(input.controlDirectory)))
  )
    throw Error("COMPARISON_BOOKING_INPUT_INVALID");
  if (input.evidence.provenance !== "official-reviewed")
    throw Error("COMPARISON_BOOKING_POLICY_UNREVIEWED");
  const paths = {
    dataRoot: resolve(input.dataRoot),
    controlDirectory: resolve(input.controlDirectory),
    studioFile: join(resolve(input.dataRoot), "studio.sqlite"),
    qualityFile: join(resolve(input.dataRoot), "quality.sqlite"),
  };
  const selection = {
    databaseInstanceId: input.databaseInstanceId,
    environment: "production" as const,
    scopeId: "candidate-quality-provider-v2-live" as const,
  };
  let phase: Phase = "unused",
    acquired = false,
    closing = false,
    revoked = false;
  let db: DatabaseSync | undefined,
    session: ComparisonStorageSession | undefined,
    store: Store | undefined;
  let review: ComparisonReservationReview | undefined;
  // Allocate only a reference during review; approval and command remain absent until consent.
  let reference: { clientRequestId: string; runId: string } | undefined;
  let original:
    { command: z.infer<typeof comparisonReserveCommandSchema>; runId: string } | undefined;
  let receipt: ReturnType<typeof confirmed> | undefined;
  function active() {
    if (closing || phase === "closed" || revoked) throw Error("COMPARISON_BOOKING_CLOSED");
  }
  function acquire() {
    if (store) return store;
    if (acquired) throw Error("COMPARISON_BOOKING_CLEANUP_REQUIRED");
    acquired = true;
    try {
      checkComparisonDatabasePath(paths.dataRoot, paths.studioFile);
      db = new DatabaseSync(paths.studioFile, { readOnly: false });
      recordComparisonCompanyConnection(db, paths.dataRoot);
      const guard = issueComparisonCompanyGuard(db, paths.dataRoot);
      session = openComparisonStorageSession(paths, selection);
      store = createPublicComparisonReservationStore(session, guard);
      return store;
    } catch {
      phase = "failed";
      throw Error("COMPARISON_BOOKING_ACQUISITION_FAILED");
    }
  }
  function confirmed(binding: Binding) {
    if (
      !original ||
      binding.runId !== original.runId ||
      binding.commandDigest !== digest(original.command) ||
      digest(binding.command) !== binding.commandDigest ||
      binding.reviewDigest !== original.command.approvedReviewDigest ||
      binding.clientRequestId !== original.command.clientRequestId
    )
      throw Error("COMPARISON_BOOKING_RECEIPT_MISMATCH");
    const { recordDigest, ...body } = binding;
    if (recordDigest !== digest(body)) throw Error("COMPARISON_BOOKING_RECEIPT_MISMATCH");
    return Object.freeze({
      kind: "comparison-reservation-receipt" as const,
      companyId: original.command.companyId,
      companyRevision: original.command.companyRevision,
      clientRequestId: binding.clientRequestId,
      runId: binding.runId,
      reviewDigest: binding.reviewDigest,
      commandDigest: binding.commandDigest,
      recordDigest,
      recordedAt: binding.recordedAt,
      acknowledgedReservationOnly: true as const,
      transmissionAllowed: false as const,
      transmissionConsentRecorded: false as const,
      runtimeObserved: false as const,
    });
  }
  const inspect = () =>
    Object.freeze({
      source: "comparison-reservation-booking" as const,
      status: phase === "closed" ? ("closed" as const) : closing ? ("draining" as const) : phase,
      revoked,
      retained: !!store || !!session || !!db,
      clientRequestId: reference?.clientRequestId ?? null,
      runId: reference?.runId ?? null,
      receipt: receipt ? structuredClone(receipt) : null,
      transmissionAllowed: false as const,
      runtimeObserved: false as const,
    });
  function recover() {
    if (!original || !store || phase === "closed")
      throw Error("COMPARISON_BOOKING_OWNER_UNAVAILABLE");
    receipt = undefined;
    phase = "attempted";
    // Only an audited SELECT. Missing original evidence never triggers another write/nonce.
    const result = store.lookup(original.command);
    if (result.status === "recorded") {
      receipt = confirmed(result.binding);
      phase = "recorded";
    } else phase = "not-observed";
    return inspect();
  }
  return Object.freeze({
    inspect,
    review() {
      active();
      if (original) throw Error("COMPARISON_BOOKING_ATTEMPT_EXISTS");
      review = undefined;
      phase = "unused";
      const value = acquire().review(input.request, input.evidence, new Date().toISOString());
      if (
        value.databaseInstanceId !== input.databaseInstanceId ||
        value.environment !== selection.environment ||
        value.scopeId !== selection.scopeId ||
        digest(value.request) !== digest(input.request) ||
        digest(value.financialBasis.evidence) !== digest(input.evidence)
      )
        throw Error("COMPARISON_BOOKING_REVIEW_MISMATCH");
      const { reviewDigest, ...body } = value;
      if (reviewDigest !== digest(body)) throw Error("COMPARISON_BOOKING_REVIEW_MISMATCH");
      review = structuredClone(value);
      reference ??= { clientRequestId: randomUUID(), runId: randomUUID() };
      phase = "review";
      return structuredClone(review);
    },
    reserve(rawConsent: unknown) {
      active();
      assertPublicComparisonDataOnly(rawConsent, 8192);
      const { reviewDigest, ...consent } = comparisonReservationConsentSchema.parse(rawConsent);
      if (original) {
        if (reviewDigest !== original.command.approvedReviewDigest)
          throw Error("COMPARISON_BOOKING_REVIEW_MISMATCH");
        return recover();
      }
      const at = new Date().toISOString();
      if (
        !review ||
        !reference ||
        reviewDigest !== review.reviewDigest ||
        Date.parse(at) < Date.parse(review.inspectedAt) ||
        Date.parse(at) >= Date.parse(review.expiresAt)
      )
        throw Error("COMPARISON_BOOKING_REVIEW_EXPIRED");
      const command = comparisonReserveCommandSchema.parse({
        commandVersion: 1,
        kind: "reserve-public-claim-comparison",
        purpose: "compare-public-claim",
        clientRequestId: reference.clientRequestId,
        companyId: review.companyId,
        companyRevision: review.companyRevision,
        request: review.request,
        identity: review.identity,
        approvedReviewDigest: review.reviewDigest,
        expectedArchiveDigest: review.archiveDigest,
        expectedBudgetHead: {
          revision: review.budget.revision,
          headDigest: review.budget.headDigest,
        },
        expectedGlobalRunCount: review.globalRunCount,
        approval: {
          noticeVersion: 1,
          noticeDigest: review.notice.noticeDigest,
          retentionNoticeDigest: review.retentionNoticeDigest,
          approvedAt: at,
          expiresAt: review.expiresAt,
          ...consent,
          transmission: "separate-approval-required",
        },
      });
      const runId = reference.runId;
      original = { command: structuredClone(command), runId };
      phase = "attempted";
      const result = acquire().reserve(command, {
        approvedReview: review,
        evidence: input.evidence,
        at,
        runId,
        eventId: randomUUID(),
        budgetEventId: randomUUID(),
      });
      if (result.status === "blocked") {
        phase = "blocked";
        return inspect();
      }
      if (
        !result.witnessMatched ||
        result.result.status !== "replay" ||
        !("binding" in result.result) ||
        !result.result.binding
      )
        throw Error("COMPARISON_BOOKING_CONFIRMATION_REQUIRED");
      receipt = confirmed(result.result.binding);
      phase = "recorded";
      return inspect();
    },
    recover,
    revoke() {
      revoked = true;
      review = undefined;
      return inspect();
    },
    close() {
      if (phase === "closed") return inspect();
      closing = true;
      review = undefined;
      try {
        if (store && !store.close().closed) return inspect();
        store = undefined;
        if (session) {
          closeComparisonStorageSession(session);
          session = undefined;
        }
        if (db) {
          if (db.isTransaction) throw Error("COMPARISON_BOOKING_CLEANUP_REQUIRED");
          db.close();
          revokeComparisonCompanyGuards(db);
          db = undefined;
        }
        phase = "closed";
      } catch {
        /* Keep the original resources for an explicit close retry. */
      }
      return inspect();
    },
  });
}
