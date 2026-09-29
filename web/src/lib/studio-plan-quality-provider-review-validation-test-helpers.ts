import { randomUUID } from "node:crypto";
import {
  reviewResponseFixture,
  appendReviewStopFixture,
} from "./studio-plan-quality-provider-review-response-test-helpers";
import { prepareProviderReviewResponse } from "./studio-plan-quality-provider-review-response";
import type {
  ProviderReviewValidationIdentity,
  ProviderReviewValidationInput,
} from "./studio-plan-quality-provider-review-validation";
import type { ProviderCapturedResponse } from "../../scripts/local-data-quality-provider-usage.mjs";
import type { ReviewFinding } from "./studio-schema";

export const reviewValidationFindings: ReviewFinding[] = [
  {
    id: "synthetic-review-1",
    severity: "warning",
    category: "evidence",
    message: "추가 근거를 확인하세요.",
    action: "근거를 보완하세요.",
    sectionKey: "problem",
    sourceIds: ["profile"],
  },
];
export function setReviewValidationOutput(
  response: ProviderCapturedResponse,
  value: unknown = { findings: reviewValidationFindings },
) {
  response.output = [
    { type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] },
  ];
}
/** Synthetic in-memory r8 (or late terminal r9), never storage or network. */
export function reviewValidationFixture(
  change?: (response: ProviderCapturedResponse) => void,
  late = false,
) {
  const f = reviewResponseFixture();
  setReviewValidationOutput(f.capture.response);
  change?.(f.capture.response);
  if (late) appendReviewStopFixture(f.input);
  const saved = prepareProviderReviewResponse(f.input);
  if (saved.status !== "prepared") throw Error(saved.reason);
  const ledger = f.input.archive.archive.ledger,
    rows = saved.plan.rows;
  ledger.artifacts.push(rows.artifact);
  ledger.events.push(rows.event);
  ledger.receipts.push(rows.receipt);
  if (rows.usageEvent) ledger.budgetEvents.push(rows.usageEvent);
  const identity: ProviderReviewValidationIdentity = {
    dispatch: f.capture.dispatch,
    responseRequestId: f.capture.responseRequestId,
    responseEventDigest: rows.event.eventDigest,
    validationRequestId: randomUUID(),
  };
  const input: ProviderReviewValidationInput = {
    identity,
    archive: f.input.archive,
    inspectedAt: "2026-09-27T03:40:00.000Z",
    additionalUsedBytes: 0,
  };
  return { input, identity, response: rows.event };
}
