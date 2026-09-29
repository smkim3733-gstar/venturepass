/** Synthetic local storage tests only. No route imports this module. */
import type { PlanQualityStore } from "./studio-plan-quality-store";
import { commandFor } from "./studio-plan-quality-provider-reservation-test-helpers";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";

export function adoptReservationTestPolicy(store: PlanQualityStore, index = 0) {
  const input = policyAdoptionFixture(store, index);
  return store.providerPolicyAdopt(input.command, input.review);
}
export function reservationStoreFixture(store: PlanQualityStore, index = 0) {
  const registry = store.candidateRegistryGet(1);
  const result = store.providerReservationReview({
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[index].candidateId,
  });
  if (result.status !== "review") throw new Error(result.reason);
  const command = commandFor(result.review);
  command.approval.approvedAt = new Date().toISOString();
  return { command, review: result.review };
}
