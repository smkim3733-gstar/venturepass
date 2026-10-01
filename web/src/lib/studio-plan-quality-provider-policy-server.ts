import "server-only";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { createVersionedProviderPreparationBuilder } from "./studio-plan-quality-provider-core";
import { providerConfigurationProposalSchema } from "./studio-plan-quality-provider-review-types";
import {
  createVersionedProviderPolicyReview,
  isVersionedProviderPolicyReviewCurrent,
  type ProviderPolicyReviewInput,
} from "./studio-plan-quality-provider-policy-review";
import {
  prepareVersionedProviderPolicyAdoption,
  type ProviderPolicyAdoptionPlannerInput,
} from "./studio-plan-quality-provider-policy-adoption";

import {
  createVersionedProviderReservationReview,
  isVersionedProviderReservationReviewCurrent,
  type ProviderReservationReviewInput,
} from "./studio-plan-quality-provider-reservation-review";
import {
  prepareVersionedProviderReservation,
  type ProviderReservationPlannerInput,
} from "./studio-plan-quality-provider-reservation-plan";

type Inspection = Omit<ProviderPolicyReviewInput, "configuration">;
type ReservationInspection = Omit<ProviderReservationReviewInput, "configuration">;
type Reservation = Omit<ProviderReservationPlannerInput, "current"> & {
  current: ReservationInspection;
};
type Adoption = Omit<ProviderPolicyAdoptionPlannerInput, "current"> & { current: Inspection };

/**
 * Server construction selects the version and snapshots the fixed evidence.
 * Registry, budget and nonce evidence must come from the same fully audited store transaction.
 * These methods only inspect/plan. A configured store owns adoption; default writers stay v1.
 */
export function createServerProviderPolicyContext(
  version: PlanPromptVersion,
  fixedConfiguration: unknown,
) {
  createVersionedProviderPreparationBuilder(version); // Reject unsupported selection eagerly.
  const configuration = structuredClone(
    providerConfigurationProposalSchema.parse(fixedConfiguration),
  );
  function bind<T extends Inspection | ReservationInspection>(
    input: T,
  ): T & { configuration: typeof configuration } {
    // Do not treat payload fields as server configuration or version selection.
    if (
      "configuration" in input ||
      "version" in input ||
      "engineVersion" in input ||
      "contract" in input
    )
      throw new Error("Server policy selection cannot be supplied by the caller");
    return { ...structuredClone(input), configuration: structuredClone(configuration) };
  }
  return Object.freeze({
    reservationReview: (input: ReservationInspection) =>
      createVersionedProviderReservationReview(version, bind(input)),
    isReservationReviewCurrent: (review: unknown, input: ReservationInspection) =>
      isVersionedProviderReservationReviewCurrent(version, structuredClone(review), bind(input)),
    prepareReservation: (input: Reservation) => {
      const current = bind(input.current);
      return prepareVersionedProviderReservation(version, {
        ...structuredClone(input),
        current,
      });
    },
    review: (input: Inspection) => createVersionedProviderPolicyReview(version, bind(input)),
    isReviewCurrent: (review: unknown, input: Inspection) =>
      isVersionedProviderPolicyReviewCurrent(version, structuredClone(review), bind(input)),
    prepareAdoption: (input: Adoption) => {
      const current = bind(input.current);
      return prepareVersionedProviderPolicyAdoption(version, {
        ...structuredClone(input),
        current,
      });
    },
  });
}
