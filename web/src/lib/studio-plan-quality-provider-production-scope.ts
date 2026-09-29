import "server-only";
import { providerDigest } from "../../scripts/local-data-quality-provider.mjs";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  providerGenerationDispatchIdentitySchema,
  type ProviderGenerationDispatchIdentity,
} from "./studio-plan-quality-provider-dispatch-plan";
import {
  providerReviewDispatchIdentitySchema,
  type ProviderReviewDispatchIdentity,
} from "./studio-plan-quality-provider-review-dispatch-plan";
import { providerGenerationRunnerNonces } from "./studio-plan-quality-provider-generation-runner";
import { providerReviewRunnerScope } from "./studio-plan-quality-provider-approved-runner";
import { captureGenerationResponseInput } from "./studio-plan-quality-provider-generation-response";
import { captureReviewResponseInput } from "./studio-plan-quality-provider-review-response";
import { providerGenerationValidationIdentitySchema } from "./studio-plan-quality-provider-generation-validation";
import { providerGenerationStopIdentitySchema } from "./studio-plan-quality-provider-generation-stop";
import { providerReviewValidationIdentitySchema } from "./studio-plan-quality-provider-review-validation";
import { providerReviewStopIdentitySchema } from "./studio-plan-quality-provider-review-stop";
import { providerFinalizationIdentitySchema } from "./studio-plan-quality-provider-finalization";

export type ProviderProductionOperation =
  | "generation-send"
  | "review-send"
  | "generation-response"
  | "generation-validation"
  | "generation-stop"
  | "review-response"
  | "review-validation"
  | "review-stop"
  | "finalization";

/** Pure scope check, NOT a grant. Only a store's private invocation permit enables writes.
 * Existing writers must still validate all digests, artifacts and historical receipts under lock. */
export function scopeProviderProductionOperation(
  original: ProviderGenerationDispatchIdentity,
  operation: ProviderProductionOperation,
  raw: unknown,
): unknown {
  const reject = (): never => {
    throw Error("PROVIDER_PRODUCTION_SCOPE_REJECTED");
  };
  const equal = (a: unknown, b: unknown) => {
    if (providerDigest(a) !== providerDigest(b)) reject();
  };
  const gen = providerGenerationRunnerNonces(original);
  const review = (dispatch: ProviderReviewDispatchIdentity) => {
    equal(dispatch.generation.dispatch, original);
    const scoped = providerReviewRunnerScope({
      generation: dispatch.generation,
      validationEventDigest: dispatch.validationEventDigest,
    });
    equal(scoped.dispatch, dispatch);
    return scoped.nonces;
  };
  try {
    let value: unknown;
    switch (operation) {
      case "generation-send": {
        const input = providerGenerationDispatchIdentitySchema.parse(raw);
        equal(input, original);
        value = input;
        break;
      }
      case "review-send": {
        const input = providerReviewDispatchIdentitySchema.parse(raw);
        review(input);
        value = input;
        break;
      }
      case "generation-response": {
        const input = captureGenerationResponseInput(raw);
        equal(input.dispatch, original);
        equal(input.responseRequestId, gen.responseRequestId);
        value = input;
        break;
      }
      case "generation-validation": {
        const input = providerGenerationValidationIdentitySchema.parse(raw);
        equal(input.dispatch, original);
        equal(input.responseRequestId, gen.responseRequestId);
        equal(input.validationRequestId, gen.validationRequestId);
        value = input;
        break;
      }
      case "generation-stop": {
        const input = providerGenerationStopIdentitySchema.parse(raw);
        equal(input.dispatch, original);
        equal(
          input.stopRequestId,
          input.observation.kind === "unobserved"
            ? gen.unobservedStopRequestId
            : gen.responseStopRequestId,
        );
        if (input.observation.kind === "response")
          equal(input.observation.responseRequestId, gen.responseRequestId);
        value = input;
        break;
      }
      case "review-response": {
        const input = captureReviewResponseInput(raw),
          ids = review(input.dispatch);
        equal(input.responseRequestId, ids.responseRequestId);
        value = input;
        break;
      }
      case "review-validation": {
        const input = providerReviewValidationIdentitySchema.parse(raw),
          ids = review(input.dispatch);
        equal(input.responseRequestId, ids.responseRequestId);
        equal(input.validationRequestId, ids.validationRequestId);
        value = input;
        break;
      }
      case "review-stop": {
        const input = providerReviewStopIdentitySchema.parse(raw),
          ids = review(input.dispatch);
        equal(
          input.stopRequestId,
          input.observation.kind === "unobserved"
            ? ids.unobservedStopRequestId
            : ids.responseStopRequestId,
        );
        if (input.observation.kind === "response")
          equal(input.observation.responseRequestId, ids.responseRequestId);
        value = input;
        break;
      }
      case "finalization": {
        const input = providerFinalizationIdentitySchema.parse(raw),
          ids = review(input.validation.dispatch);
        equal(input.validation.responseRequestId, ids.responseRequestId);
        equal(input.validation.validationRequestId, ids.validationRequestId);
        equal(input.finalizationRequestId, ids.finalizationRequestId);
        value = input;
        break;
      }
      default:
        return reject();
    }
    return freezeProviderValue(value);
  } catch {
    return reject();
  }
}
