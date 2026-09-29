import { randomUUID } from "node:crypto";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import type { ProviderFinalizationIdentity } from "./studio-plan-quality-provider-finalization";
import { reviewValidationStoreFixture } from "./studio-plan-quality-provider-review-validation-store-test-helpers";

/** Synthetic validated r9 only. No final body/row or real transport is created. */
export async function finalizationStoreFixture(store: PlanQualityStore) {
  const f = await reviewValidationStoreFixture(store),
    validation = store.providerRecordReviewValidation(f.identity).record;
  const identity: ProviderFinalizationIdentity = {
    validation: f.identity,
    validationEventDigest: validation.validationEventDigest,
    finalizationRequestId: randomUUID(),
  };
  return { identity, capture: f.capture, validation };
}
