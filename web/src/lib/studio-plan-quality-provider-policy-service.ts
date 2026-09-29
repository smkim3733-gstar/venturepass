import "server-only";
import { z, ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import {
  providerPolicyAdoptionInputSchema,
  providerPolicyAdoptionResponseSchema,
  providerPolicyHttpLimits,
  type ProviderPolicyAdoptionResponse,
} from "./studio-plan-quality-provider-policy-http-types";
import type { ProviderPolicyAdoptionRecord } from "./studio-plan-quality-provider-policy-adoption-types";

// Only planner/retry refusals reached after audit are known to have rejected this command.
// Storage/commit/serialization failures remain unknown and require lookup or exact replay.
const commandRefusals = new Set(
  [
    "INVALID_INPUT",
    "SCOPE_CHANGED",
    "REVIEW_NOT_CURRENT",
    "APPROVAL_TIME_INVALID",
    "POLICY_HEAD_CHANGED",
    "POLICY_LIMIT",
    "NONCE_CONFLICT",
    "BUDGET_ACTION_MISMATCH",
    "BUDGET_INCOMPATIBLE",
    "ARCHIVE_PROOF_INVALID",
    "RECORD_TOO_LARGE",
  ].map((reason) => `QUALITY_PROVIDER_POLICY_${reason}`),
);

function committed(record: ProviderPolicyAdoptionRecord, delivery: "new" | "replay" | "lookup") {
  return reply({
    responseVersion: 1,
    state: "committed",
    delivery,
    receipt: {
      clientRequestId: record.clientRequestId,
      requestDigest: record.requestDigest,
      recordDigest: record.recordDigest,
      revision: record.revision,
      recordedAt: record.recordedAt,
      approvedReviewDigest: record.command.approvedReviewDigest,
      budgetTransition: record.budgetTransition,
      reservationAllowed: false,
      dispatchAllowed: false,
    },
  });
}
function reply(value: ProviderPolicyAdoptionResponse, status = 200) {
  return jsonResponse(providerPolicyAdoptionResponseSchema.parse(value), status);
}

/** Explicit local policy writes only; no reservation, credential access or provider transport. */
export async function qualityProviderPolicyRoute(
  request: Request,
  operation: "adopt" | "lookup",
  params: { clientRequestId?: string } = {},
) {
  let readingInput = true;
  let clientRequestId: string | null = null;
  let stored = false;
  try {
    assertLocalRequest(request);
    const method = operation === "adopt" ? "POST" : "GET";
    if (request.method !== method) {
      const response = reply(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId,
          error: "지원하지 않는 요청 방식입니다.",
          code: "METHOD_NOT_ALLOWED",
        },
        405,
      );
      response.headers.set("Allow", method);
      return response;
    }
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수는 지원하지 않습니다.", 400, "INVALID_QUERY");
    if (operation === "lookup") {
      clientRequestId = z.string().uuid().parse(params.clientRequestId);
      readingInput = false;
      const result = getPlanQualityStore().providerPolicyLookup(clientRequestId);
      return result.state === "committed"
        ? committed(result.record, "lookup")
        : reply({
            responseVersion: 1,
            state: "not-observed",
            clientRequestId,
            recovery: "replay-original-request",
          });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = providerPolicyAdoptionInputSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBody(request, providerPolicyHttpLimits.bodyBytes),
        ),
      ),
    );
    clientRequestId = input.command.clientRequestId;
    readingInput = false;
    const result = getPlanQualityStore().providerPolicyAdopt(input.command, input.approvedReview);
    stored = true;
    return committed(result.record, result.replayed ? "replay" : "new");
  } catch (error) {
    if (
      error instanceof StudioError &&
      (readingInput || (operation === "adopt" && !stored && commandRefusals.has(error.code)))
    )
      return reply(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId,
          error: error.message,
          code: error.code,
        },
        error.status,
      );
    if (readingInput && error instanceof ZodError)
      return reply(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId,
          error: "채택 명령과 명시적 확인 내용을 확인해 주세요.",
          code: "INVALID_INPUT",
        },
        400,
      );
    if (readingInput && (error instanceof SyntaxError || error instanceof TypeError))
      return reply(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId,
          error: "JSON 요청 형식을 확인해 주세요.",
          code: "INVALID_JSON",
        },
        400,
      );
    return reply(
      {
        responseVersion: 1,
        state: "unknown",
        clientRequestId,
        error: "저장 결과를 확인하지 못했습니다. 원래 요청 번호와 명령으로 확인해 주세요.",
        code: "PROVIDER_POLICY_OUTCOME_UNKNOWN",
        recovery: "lookup-or-replay-original-request",
      },
      500,
    );
  }
}
