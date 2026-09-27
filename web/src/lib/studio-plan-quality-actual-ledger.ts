import {
  actualCanonicalDigest as digest,
  actualRawDigest,
  validateActualArtifact,
} from "../../scripts/local-data-quality-actual.mjs";
export {
  validateActualArtifact,
  validateActualBudgetLedger,
  validateActualRunLedger,
  inspectActualLedger,
  calculateActualUsage,
  deriveActualReviewRequest,
  actualLedgerOperationDigest,
  actualLedgerPolicyRequestDigest,
} from "../../scripts/local-data-quality-actual.mjs";
import {
  actualLedgerRunSchema,
  actualLedgerRunEventSchema,
  actualLedgerBudgetEventSchema,
  actualLedgerReceiptSchema,
  actualLedgerDigestInput,
  actualLedgerStartDigestInput,
  type ActualLedgerRun,
  type ActualLedgerRunEvent,
  type ActualLedgerBudgetEvent,
  type ActualLedgerReceipt,
  type ActualLedgerStart,
  type ActualLedgerArtifact,
} from "./studio-plan-quality-actual-ledger-types";
export function createActualBudgetEvent(
  input: Omit<ActualLedgerBudgetEvent, "eventDigest">,
): ActualLedgerBudgetEvent {
  return actualLedgerBudgetEventSchema.parse({
    ...input,
    eventDigest: digest(actualLedgerDigestInput(input, "eventDigest")),
  });
}
export function createActualRunEvent(
  input: Omit<ActualLedgerRunEvent, "eventDigest">,
): ActualLedgerRunEvent {
  return actualLedgerRunEventSchema.parse({
    ...input,
    eventDigest: digest(actualLedgerDigestInput(input, "eventDigest")),
  });
}
export function createActualReceipt(input: ActualLedgerReceipt): ActualLedgerReceipt {
  return actualLedgerReceiptSchema.parse(input);
}
export function createActualArtifact(input: {
  runId: string;
  key: ActualLedgerArtifact["key"];
  body: string;
}): ActualLedgerArtifact {
  return validateActualArtifact({
    ...input,
    sizeBytes: Buffer.byteLength(input.body, "utf8"),
    sha256: actualRawDigest(input.body),
  });
}
export function createActualRun({
  input,
  id,
  recordedAt,
  reservation,
}: {
  input: ActualLedgerStart;
  id: string;
  recordedAt: string;
  reservation: ActualLedgerBudgetEvent;
}): ActualLedgerRun {
  const payload: Omit<ActualLedgerRun, "runDigest"> = {
    schemaVersion: 1,
    archiveFormatVersion: 1,
    id,
    clientRequestId: input.clientRequestId,
    inputDigest: digest(actualLedgerStartDigestInput(input)),
    recordedAt,
    executionKind: "actual-ledger-simulation",
    environment: "synthetic-test",
    observedTransport: "synthetic-adapter",
    actualAiCalls: 0,
    preparation: input.preparation,
    approval: input.approval,
    expectedBudgetRevision: input.expectedBudgetRevision,
    expectedBudgetDigest: input.expectedBudgetDigest,
    expectedActualRunCount: input.expectedActualRunCount,
    reservedBudgetRevision: reservation.revision,
    reservationDigest: reservation.eventDigest,
    storageReservationBytes: 32 * 1024 * 1024,
    reservedSlots: { events: 32, budgetEvents: 16, receipts: 64 },
  };
  return actualLedgerRunSchema.parse({ ...payload, runDigest: digest(payload) });
}
