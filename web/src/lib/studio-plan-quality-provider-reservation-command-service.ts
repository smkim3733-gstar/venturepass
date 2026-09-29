import "server-only";
import { z, ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import {
  providerReservationHttpLimits,
  providerReservationInputSchema,
  providerReservationResponseSchema,
  type ProviderReservationResponse,
} from "./studio-plan-quality-provider-reservation-http-types";
import { providerReservationBindingSchema } from "./studio-plan-quality-provider-reservation-archive-types";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";

// These audited planner/retry refusals occur before any write. Audit, storage, COMMIT and
// response failures remain unknown. A refusal never resolves an earlier attempt with this nonce.
const commandRefusals = new Set(
  [
    "INVALID_INPUT",
    "SCOPE_CHANGED",
    "NONCE_CONFLICT",
    "REVIEW_NOT_CURRENT",
    "RESERVATION_BLOCKED",
    "BINDINGS_CHANGED",
    "APPROVAL_TIME_INVALID",
    "PREPARATION_INVALID",
    "CAPACITY_EXCEEDED",
  ].map((reason) => `QUALITY_PROVIDER_RESERVATION_${reason}`),
);
function reply(value: ProviderReservationResponse, status = 200) {
  return jsonResponse(providerReservationResponseSchema.parse(value), status);
}
function committed(
  raw: unknown,
  delivery: "new" | "replay" | "lookup",
  clientRequestId: string,
  expectedCommandDigest?: string,
) {
  // The store performs full archive audit; this boundary also binds the reply to this request.
  const record = providerReservationBindingSchema.parse(raw);
  const { recordDigest, ...body } = record;
  if (
    record.clientRequestId !== clientRequestId ||
    record.command.clientRequestId !== clientRequestId ||
    record.commandDigest !== digest(record.command) ||
    recordDigest !== digest(body) ||
    record.command.approvedReviewDigest !== record.approvedReview.reviewDigest ||
    (expectedCommandDigest !== undefined && record.commandDigest !== expectedCommandDigest)
  )
    throw new Error("Reservation response identity mismatch");
  return reply({
    responseVersion: 1,
    state: "committed",
    delivery,
    receipt: {
      clientRequestId,
      commandDigest: record.commandDigest,
      recordDigest,
      approvedReviewDigest: record.command.approvedReviewDigest,
      runId: record.runId,
      runDigest: record.runDigest,
      startInputDigest: record.startInputDigest,
      recordedAt: record.recordedAt,
      dispatchAllowed: false,
    },
  });
}

/** Explicit local reservation only. No budget initialization, credential access or transport. */
export async function qualityProviderReservationCommandRoute(
  request: Request,
  operation: "reserve" | "lookup",
  params: { clientRequestId?: string } = {},
) {
  let readingInput = true;
  let clientRequestId: string | null = null;
  let stored = false;
  try {
    assertLocalRequest(request);
    const method = operation === "reserve" ? "POST" : "GET";
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
      const result = getPlanQualityStore().providerReservationLookup(clientRequestId);
      if (result.state === "committed") return committed(result.record, "lookup", clientRequestId);
      if (result.state !== "not-observed") throw new Error("Invalid reservation lookup result");
      return reply({
        responseVersion: 1,
        state: "not-observed",
        clientRequestId,
        recovery: "replay-original-request",
      });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = providerReservationInputSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBody(request, providerReservationHttpLimits.bodyBytes),
        ),
      ),
    );
    clientRequestId = input.command.clientRequestId;
    const commandDigest = digest(input.command);
    readingInput = false;
    const result = getPlanQualityStore().providerReserve(input.command, input.approvedReview);
    stored = true;
    if (
      result.state !== "committed" ||
      !(
        (result.newlyCommitted === true && result.replayed === false) ||
        (result.newlyCommitted === false && result.replayed === true)
      )
    )
      throw new Error("Invalid reservation commit result");
    return committed(
      result.record,
      result.replayed ? "replay" : "new",
      clientRequestId,
      commandDigest,
    );
  } catch (error) {
    if (
      error instanceof StudioError &&
      (readingInput || (operation === "reserve" && !stored && commandRefusals.has(error.code)))
    )
      return reply(
        {
          responseVersion: 1,
          state: "refused",
          clientRequestId,
          error: readingInput
            ? error.message
            : "예약 조건이 변경됐습니다. 검토안을 다시 확인해 주세요.",
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
          error: "예약 명령과 명시적 확인 내용을 확인해 주세요.",
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
        code: "PROVIDER_RESERVATION_OUTCOME_UNKNOWN",
        recovery: "lookup-or-replay-original-request",
      },
      500,
    );
  }
}
