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

import {
  createVersionedProviderTransmissionReview,
  isVersionedProviderTransmissionReviewCurrent,
  type ProviderTransmissionReviewInput,
} from "./studio-plan-quality-provider-transmission-review";
import {
  prepareVersionedProviderTransmissionApproval,
  type ProviderTransmissionPlannerInput,
} from "./studio-plan-quality-provider-transmission-plan";
import {
  prepareVersionedProviderGenerationDispatch,
  type ProviderGenerationDispatchInput,
} from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderGenerationValidationInput } from "./studio-plan-quality-provider-generation-validation";
import type { ProviderReviewDispatchInput } from "./studio-plan-quality-provider-review-dispatch-plan";
type ReviewDispatch = Omit<ProviderReviewDispatchInput, "configuration">;
import type { ProviderReviewValidationInput } from "./studio-plan-quality-provider-review-validation";
import type { ProviderFinalizationInput } from "./studio-plan-quality-provider-finalization";

import type { ProviderGenerationStopInput } from "./studio-plan-quality-provider-generation-stop";
import type { ProviderReviewStopInput } from "./studio-plan-quality-provider-review-stop";

type GenerationDispatch = Omit<ProviderGenerationDispatchInput, "configuration">;
type TransmissionApproval = Omit<ProviderTransmissionPlannerInput, "current"> & {
  current: TransmissionInspection;
};
type TransmissionInspection = Omit<ProviderTransmissionReviewInput, "configuration">;

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
  function bind<
    T extends
      | Inspection
      | ReservationInspection
      | TransmissionInspection
      | GenerationDispatch
      | ReviewDispatch,
  >(input: T): T & { configuration: typeof configuration } {
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
  function bindTransmission(input: TransmissionInspection) {
    // Only fully audited server archive evidence is accepted here. Token estimates or a
    // client-supplied contract cannot promote a financial hold into transmission authority.
    if (Object.keys(input).some((key) => !["selection", "inspectedAt", "archive"].includes(key)))
      throw new Error("Unsupported transmission inspection evidence");
    return bind(input);
  }
  return Object.freeze({
    /** Load before entering a synchronous DB transaction; returned planners never await.
     * This keeps policy-only consumers free of the domain/response execution module graph. */
    loadValidationPlanning: async () => {
      const [
        { prepareVersionedProviderGenerationValidation },
        { prepareVersionedProviderReviewDispatch },
        { prepareVersionedProviderReviewValidation },
        { prepareVersionedProviderFinalization },
        { prepareVersionedProviderGenerationStop },
        { prepareVersionedProviderReviewStop },
      ] = await Promise.all([
        import("./studio-plan-quality-provider-generation-validation"),
        import("./studio-plan-quality-provider-review-dispatch-plan"),
        import("./studio-plan-quality-provider-review-validation"),
        import("./studio-plan-quality-provider-finalization"),
        import("./studio-plan-quality-provider-generation-stop"),
        import("./studio-plan-quality-provider-review-stop"),
      ]);
      return Object.freeze({
        prepareGenerationStop: (input: ProviderGenerationStopInput) => {
          if (
            Object.keys(input).some(
              (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
            )
          )
            throw new Error("Unsupported generation stop evidence");
          return prepareVersionedProviderGenerationStop(version, structuredClone(input));
        },
        prepareReviewStop: (input: ProviderReviewStopInput) => {
          if (
            Object.keys(input).some(
              (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
            )
          )
            throw new Error("Unsupported review stop evidence");
          return prepareVersionedProviderReviewStop(version, structuredClone(input));
        },

        prepareReviewValidation: (input: ProviderReviewValidationInput) => {
          if (
            Object.keys(input).some(
              (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
            )
          )
            throw new Error("Unsupported review validation evidence");
          return prepareVersionedProviderReviewValidation(version, structuredClone(input));
        },
        prepareFinalization: (input: ProviderFinalizationInput) => {
          if (
            Object.keys(input).some(
              (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
            )
          )
            throw new Error("Unsupported finalization evidence");
          return prepareVersionedProviderFinalization(version, structuredClone(input));
        },
        prepareGenerationValidation: (input: ProviderGenerationValidationInput) => {
          if (
            Object.keys(input).some(
              (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
            )
          )
            throw new Error("Unsupported generation validation evidence");
          return prepareVersionedProviderGenerationValidation(version, structuredClone(input));
        },
        prepareReviewDispatch: (input: ReviewDispatch) => {
          if (
            Object.keys(input).some(
              (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
            )
          )
            throw new Error("Unsupported review dispatch evidence");
          return prepareVersionedProviderReviewDispatch(version, bind(input));
        },
      });
    },
    prepareGenerationDispatch: (input: GenerationDispatch) => {
      if (
        Object.keys(input).some(
          (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
        )
      )
        throw new Error("Unsupported generation dispatch evidence");
      return prepareVersionedProviderGenerationDispatch(version, bind(input));
    },
    prepareTransmissionApproval: (input: TransmissionApproval) => {
      if (
        Object.keys(input).some(
          (key) => !["command", "review", "current", "additionalUsedBytes"].includes(key),
        )
      )
        throw new Error("Unsupported transmission approval evidence");
      return prepareVersionedProviderTransmissionApproval(version, {
        ...structuredClone(input),
        current: bindTransmission(input.current),
      });
    },
    transmissionReview: (input: TransmissionInspection) =>
      createVersionedProviderTransmissionReview(version, bindTransmission(input)),
    isTransmissionReviewCurrent: (review: unknown, input: TransmissionInspection) =>
      isVersionedProviderTransmissionReviewCurrent(
        version,
        structuredClone(review),
        bindTransmission(input),
      ),
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
