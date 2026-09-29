import { randomUUID } from "node:crypto";
import { reviewResponseFixture } from "./studio-plan-quality-provider-review-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import {
  prepareProviderReviewResponse,
  type ProviderReviewResponseInput,
} from "./studio-plan-quality-provider-review-response";
import type {
  ProviderReviewStopIdentity,
  ProviderReviewStopInput,
  ProviderReviewStopPlan,
} from "./studio-plan-quality-provider-review-stop";

export function appendReviewStopTestResponse(input: ProviderReviewResponseInput) {
  const result = prepareProviderReviewResponse(input);
  if (result.status !== "prepared") throw Error(result.reason);
  const ledger = input.archive.archive.ledger,
    rows = result.plan.rows;
  ledger.artifacts.push(rows.artifact);
  ledger.events.push(rows.event);
  ledger.receipts.push(rows.receipt);
  if (rows.usageEvent) ledger.budgetEvents.push(rows.usageEvent);
  return rows.event;
}
export function reviewStopFixture(
  kind: "unobserved" | "unknown" | "bound" | "invalid" | "valid" = "invalid",
  change?: (response: ReturnType<typeof reviewResponseFixture>["capture"]["response"]) => void,
) {
  const f = reviewResponseFixture();
  setReviewValidationOutput(f.capture.response);
  if (kind === "unknown") delete f.capture.response.usage;
  if (kind === "bound")
    f.capture.response.usage = {
      input_tokens: 20,
      output_tokens: 600000,
      total_tokens: 600020,
      input_tokens_details: { cached_tokens: 5 },
    };
  if (kind === "invalid") f.capture.response.output = [];
  change?.(f.capture.response);
  const event = kind === "unobserved" ? null : appendReviewStopTestResponse(f.input);
  const identity: ProviderReviewStopIdentity = {
    dispatch: f.capture.dispatch,
    stopRequestId: randomUUID(),
    observation: event
      ? {
          kind: "response",
          responseRequestId: f.capture.responseRequestId,
          responseEventDigest: event.eventDigest,
        }
      : { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
  };
  const input: ProviderReviewStopInput = {
    identity,
    archive: f.input.archive,
    inspectedAt: "2026-09-27T03:40:00.000Z",
    additionalUsedBytes: 0,
  };
  return { input, capture: f.capture };
}
export function applyReviewStopPlan(input: ProviderReviewStopInput, plan: ProviderReviewStopPlan) {
  const archive = structuredClone(input.archive),
    ledger = archive.archive.ledger;
  ledger.events.push(plan.rows.event);
  ledger.receipts.push(plan.rows.receipt);
  return archive;
}
