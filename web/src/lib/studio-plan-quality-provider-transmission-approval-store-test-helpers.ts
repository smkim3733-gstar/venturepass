/** Synthetic temporary storage fixtures only; never imported by application routes. */
import type { PlanQualityStore } from "./studio-plan-quality-store";
import {
  adoptReservationTestPolicy,
  reservationStoreFixture,
} from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { transmissionCommandFor } from "./studio-plan-quality-provider-transmission-test-helpers";

export function reserveTransmissionTestRun(store: PlanQualityStore, index = 0) {
  adoptReservationTestPolicy(store, index);
  const input = reservationStoreFixture(store, index);
  return store.providerReserve(input.command, input.review).record;
}
export function transmissionStoreFixture(
  store: PlanQualityStore,
  selection: { runId: string; runDigest: string },
) {
  const result = store.providerTransmissionReview({
    runId: selection.runId,
    runDigest: selection.runDigest,
  });
  if (result.status !== "review") throw new Error(result.reason);
  const command = transmissionCommandFor(result.review);
  command.approval.approvedAt = new Date().toISOString();
  return { command, review: result.review };
}
