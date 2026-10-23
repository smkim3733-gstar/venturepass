import "server-only";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { samePath } from "../../scripts/local-data-files.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import { comparisonCancelCommandSchema } from "./studio-public-claim-comparison-reservation";
import {
  cancellationSelectionSchema,
  cancellationConsentSchema,
  cancellationReceiptSchema,
  type CancellationState,
} from "./studio-comparison-cancellation-wire";
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
import { createPublicComparisonCancellationStore } from "./studio-public-claim-comparison-database-v11";
const inputSchema = z
  .object({
    dataRoot: z.string().min(1),
    controlDirectory: z.string().min(1),
    databaseInstanceId: z.string().uuid(),
    selection: cancellationSelectionSchema,
  })
  .strict();
type Store = ReturnType<typeof createPublicComparisonCancellationStore>;
/** One original cancellation, never a provider send or automatic compensation. */
export function createComparisonCancellation(raw: unknown) {
  assertPublicComparisonDataOnly(raw, 8192);
  const input = structuredClone(inputSchema.parse(raw));
  if (
    !isAbsolute(input.dataRoot) ||
    !isAbsolute(input.controlDirectory) ||
    samePath(input.dataRoot, input.controlDirectory) ||
    !samePath(dirname(resolve(input.dataRoot)), dirname(resolve(input.controlDirectory)))
  )
    throw Error("CANCELLATION_INPUT_INVALID");
  const paths = {
    dataRoot: resolve(input.dataRoot),
    controlDirectory: resolve(input.controlDirectory),
    studioFile: join(resolve(input.dataRoot), "studio.sqlite"),
    qualityFile: join(resolve(input.dataRoot), "quality.sqlite"),
  };
  let db: DatabaseSync | undefined,
    session: ComparisonStorageSession | undefined,
    store: Store | undefined;
  let acquired = false,
    closing = false,
    revoked = false,
    phase: CancellationState["status"] = "unused";
  let review: ReturnType<Store["review"]> | undefined,
    original: z.infer<typeof comparisonCancelCommandSchema> | undefined;
  let receipt: CancellationState["receipt"] = null;
  let requestId: string | undefined;
  function active() {
    if (closing || phase === "closed" || revoked) throw Error("CANCELLATION_CLOSED");
  }
  function acquire() {
    if (store) return store;
    if (acquired) throw Error("CANCELLATION_CLEANUP_REQUIRED");
    acquired = true;
    try {
      checkComparisonDatabasePath(paths.dataRoot, paths.studioFile);
      db = new DatabaseSync(paths.studioFile, { readOnly: false });
      recordComparisonCompanyConnection(db, paths.dataRoot);
      const guard = issueComparisonCompanyGuard(db, paths.dataRoot);
      session = openComparisonStorageSession(paths, {
        databaseInstanceId: input.databaseInstanceId,
        environment: "production",
        scopeId: "candidate-quality-provider-v2-live",
      });
      store = createPublicComparisonCancellationStore(session, guard);
      return store;
    } catch {
      phase = "failed";
      throw Error("CANCELLATION_ACQUISITION_FAILED");
    }
  }
  const inspect = () =>
    Object.freeze({
      status: phase === "closed" ? phase : closing ? ("draining" as const) : phase,
      revoked,
      retained: !!db || !!session || !!store,
      clientRequestId: requestId ?? null,
      receipt: receipt ? structuredClone(receipt) : null,
      transmissionAllowed: false as const,
      runtimeObserved: false as const,
    });
  function recover() {
    if (!store || !original || !review || phase === "closed")
      throw Error("CANCELLATION_OWNER_UNAVAILABLE");
    receipt = null;
    phase = "attempted";
    const result = store.lookup(original);
    if (result.status === "not-observed") {
      phase = "not-observed";
      return inspect();
    }
    if (
      digest(result.command) !== digest(original) ||
      result.currency !== review.currency ||
      result.unitScale !== review.unitScale ||
      result.releasedUnits !== review.releasedUnits
    )
      throw Error("CANCELLATION_RECEIPT_MISMATCH");
    const body = {
      ...input.selection,
      clientRequestId: original.clientRequestId,
      reviewDigest: review.reviewDigest,
      commandDigest: digest(original),
      recordedAt: result.recordedAt,
      currency: result.currency,
      unitScale: result.unitScale,
      releasedUnits: result.releasedUnits,
      cancelled: true as const,
      finalized: true as const,
      transmissionAllowed: false as const,
      refundVerified: false as const,
    };
    receipt = cancellationReceiptSchema.parse({ ...body, recordDigest: digest(body) });
    phase = "recorded";
    return inspect();
  }
  return Object.freeze({
    inspect,
    review() {
      active();
      if (original) throw Error("CANCELLATION_ATTEMPT_EXISTS");
      review = undefined;
      phase = "unused";
      const next = acquire().review(input.selection, new Date().toISOString());
      const { reviewDigest, ...body } = next;
      if (
        reviewDigest !== digest(body) ||
        next.databaseInstanceId !== input.databaseInstanceId ||
        next.companyId !== input.selection.companyId ||
        next.companyRevision !== input.selection.companyRevision ||
        next.runId !== input.selection.runId
      )
        throw Error("CANCELLATION_REVIEW_MISMATCH");
      review = structuredClone(next);
      requestId ??= randomUUID();
      phase = "review";
      return structuredClone(next);
    },
    cancel(rawConsent: unknown) {
      active();
      assertPublicComparisonDataOnly(rawConsent, 8192);
      const consent = cancellationConsentSchema.parse(rawConsent);
      if (original) {
        if (!review || consent.reviewDigest !== review.reviewDigest)
          throw Error("CANCELLATION_REVIEW_MISMATCH");
        return recover();
      }
      const at = new Date().toISOString();
      if (
        !review ||
        !requestId ||
        consent.reviewDigest !== review.reviewDigest ||
        Date.parse(at) < Date.parse(review.inspectedAt) ||
        Date.parse(at) >= Date.parse(review.expiresAt)
      )
        throw Error("CANCELLATION_REVIEW_EXPIRED");
      original = comparisonCancelCommandSchema.parse({
        commandVersion: 1,
        kind: "cancel-public-claim-comparison",
        purpose: "compare-public-claim",
        clientRequestId: requestId,
        runId: input.selection.runId,
        expectedBindingDigest: review.expectedBindingDigest,
        reservationDigest: review.reservationDigest,
        expectedRunHead: review.expectedRunHead,
        expectedBudgetHead: review.expectedBudgetHead,
      });
      phase = "attempted";
      const result = acquire().cancel(original, {
        selection: input.selection,
        at,
        eventId: randomUUID(),
        budgetEventId: randomUUID(),
        finalEventId: randomUUID(),
        finalizationNonce: randomUUID(),
      });
      if (
        result.status === "blocked" ||
        !result.witnessMatched ||
        result.result.status !== "replay" ||
        !("command" in result.result) ||
        digest(result.result.command) !== digest(original)
      )
        throw Error("CANCELLATION_CONFIRMATION_REQUIRED");
      return recover();
    },
    recover,
    revoke() {
      revoked = true;
      return inspect();
    },
    close() {
      if (phase === "closed") return inspect();
      closing = true;
      try {
        if (store && !store.close().closed) return inspect();
        store = undefined;
        if (session) {
          closeComparisonStorageSession(session);
          session = undefined;
        }
        if (db) {
          if (db.isTransaction) throw Error("CLEANUP_REQUIRED");
          db.close();
          revokeComparisonCompanyGuards(db);
          db = undefined;
        }
        phase = "closed";
      } catch {
        /* Retain exact failed resources. */
      }
      return inspect();
    },
  });
}
