import { randomUUID } from "node:crypto";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import type { ProviderReviewStopIdentity } from "./studio-plan-quality-provider-review-stop";
import { reviewDispatchStoreFixture } from "./studio-plan-quality-provider-review-dispatch-store-test-helpers";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";

/** Synthetic r7 with an explicitly selected unobserved stop. No real network or response stored. */
export async function reviewStopStoreFixture(store: PlanQualityStore) {
  const dispatch = await reviewDispatchStoreFixture(store);
  await store.providerSimulateReviewDispatch(dispatch, {
    provenance: "synthetic-test",
    send: async () => undefined,
  });
  const capture = reviewResponseCapture(dispatch);
  setReviewValidationOutput(capture.response);
  const identity: ProviderReviewStopIdentity = {
    dispatch,
    stopRequestId: randomUUID(),
    observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
  };
  return { identity, capture };
}
