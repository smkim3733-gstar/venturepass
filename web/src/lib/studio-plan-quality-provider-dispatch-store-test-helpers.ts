import { randomUUID } from "node:crypto";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import {
  reserveTransmissionTestRun,
  transmissionStoreFixture,
} from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";

/** Explicit synthetic approvals in the caller's isolated test DB. */
export function generationDispatchStoreFixture(
  store: PlanQualityStore,
): ProviderGenerationDispatchIdentity {
  const approval = transmissionStoreFixture(store, reserveTransmissionTestRun(store));
  const saved = store.providerApproveTransmission(approval.command, approval.review).record;
  return {
    runId: saved.runId,
    runDigest: saved.runDigest,
    approvalBindingDigest: saved.recordDigest,
    preparedRequestId: randomUUID(),
    dispatchRequestId: randomUUID(),
  };
}
