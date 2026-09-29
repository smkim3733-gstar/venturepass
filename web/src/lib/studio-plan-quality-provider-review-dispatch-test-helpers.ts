import { randomUUID } from "node:crypto";
import { generationValidationFixture } from "./studio-plan-quality-provider-generation-validation-test-helpers";
import {
  prepareProviderGenerationValidation,
  type ProviderGenerationValidationIdentity,
} from "./studio-plan-quality-provider-generation-validation";
import { config } from "./studio-plan-quality-provider-reservation-test-helpers";
import type {
  ProviderReviewDispatchInput,
  ProviderReviewDispatchIdentity,
} from "./studio-plan-quality-provider-review-dispatch-plan";

/** In-memory, synthetic r5. No actual approval, storage or provider request. */
export function reviewDispatchFixture() {
  const f = generationValidationFixture();
  const result = prepareProviderGenerationValidation(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  const validation = result.plan,
    ledger = f.input.archive.archive.ledger;
  ledger.artifacts.push(validation.rows.artifact);
  ledger.events.push(validation.rows.event);
  ledger.receipts.push(validation.rows.receipt);
  const identity: ProviderReviewDispatchIdentity = {
    generation: f.input.identity as ProviderGenerationValidationIdentity,
    validationEventDigest: validation.rows.event.eventDigest,
    preparedRequestId: randomUUID(),
    dispatchRequestId: randomUUID(),
  };
  const input: ProviderReviewDispatchInput = {
    identity,
    archive: f.input.archive,
    configuration: config(),
    inspectedAt: "2026-09-27T03:38:00.000Z",
    additionalUsedBytes: 0,
  };
  return { input, validation };
}
