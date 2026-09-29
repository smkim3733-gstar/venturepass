import { randomUUID } from "node:crypto";
import { reviewValidationFixture } from "./studio-plan-quality-provider-review-validation-test-helpers";
import { prepareProviderReviewValidation } from "./studio-plan-quality-provider-review-validation";
import type {
  ProviderFinalizationIdentity,
  ProviderFinalizationInput,
} from "./studio-plan-quality-provider-finalization";

/** Synthetic in-memory validated r9; no DB, provider or current configuration. */
export function finalizationFixture(change?: Parameters<typeof reviewValidationFixture>[0]) {
  const f = reviewValidationFixture(change),
    result = prepareProviderReviewValidation(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  const ledger = f.input.archive.archive.ledger,
    { rows } = result.plan;
  ledger.artifacts.push(rows.artifact);
  ledger.events.push(rows.event);
  ledger.receipts.push(rows.receipt);
  const identity: ProviderFinalizationIdentity = {
    validation: f.identity,
    validationEventDigest: rows.event.eventDigest,
    finalizationRequestId: randomUUID(),
  };
  const input: ProviderFinalizationInput = {
    identity,
    archive: f.input.archive,
    inspectedAt: "2026-09-27T03:41:00.000Z",
    additionalUsedBytes: 0,
  };
  return { input, identity };
}
