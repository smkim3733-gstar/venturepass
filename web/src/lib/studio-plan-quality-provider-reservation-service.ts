import "server-only";
import { ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import {
  providerReviewInputSchema,
  providerReviewLimits,
} from "./studio-plan-quality-provider-review-types";
import { providerReservationInspectionResponseSchema } from "./studio-plan-quality-provider-reservation-http-types";

/** Read-only HTTP boundary. The store owns all evidence and its single audited transaction. */
export async function qualityProviderReservationReviewRoute(request: Request) {
  let readingInput = true;
  try {
    assertLocalRequest(request);
    if (request.method !== "POST") {
      const response = jsonResponse(
        { error: "이 경로는 예약 검토 조회만 지원합니다.", code: "METHOD_NOT_ALLOWED" },
        405,
      );
      response.headers.set("Allow", "POST");
      return response;
    }
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수는 지원하지 않습니다.", 400, "INVALID_QUERY");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const selection = providerReviewInputSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBody(request, providerReviewLimits.bodyBytes),
        ),
      ),
    );
    readingInput = false;
    const result = getPlanQualityStore().providerReservationReview(selection);
    let status = 200;
    if (result.status === "unavailable") {
      switch (result.reason) {
        case "configuration-missing-or-invalid":
        case "configuration-expired":
          break;
        case "selection-invalid":
        case "ledger-after-inspection":
          status = 409;
          break;
        default:
          // Invalid server evidence is not a completed review or a malformed client request.
          throw new Error("Reservation review unavailable");
      }
    }
    return jsonResponse(
      providerReservationInspectionResponseSchema.parse({
        responseVersion: 1,
        selection,
        ...result,
      }),
      status,
    );
  } catch (error) {
    if (error instanceof StudioError)
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    if (readingInput && error instanceof ZodError)
      return jsonResponse(
        { error: "조회할 후보 등록 버전과 후보를 확인해 주세요.", code: "INVALID_INPUT" },
        400,
      );
    if (readingInput && (error instanceof SyntaxError || error instanceof TypeError))
      return jsonResponse({ error: "JSON 요청 형식을 확인해 주세요.", code: "INVALID_JSON" }, 400);
    return jsonResponse(
      {
        error: "예약 검토를 확인하지 못했습니다. 다시 조회해 주세요.",
        code: "PROVIDER_RESERVATION_REVIEW_UNAVAILABLE",
      },
      500,
    );
  }
}
