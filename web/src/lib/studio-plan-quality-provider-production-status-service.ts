import "server-only";
import { ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import {
  providerProductionInspectionInputSchema,
  providerProductionViewSchema,
} from "./studio-plan-quality-provider-production-service-types";

/** Persisted-ledger read only. Do not substitute an execution service/continuation here. */
export async function qualityProviderProductionStatusRoute(request: Request) {
  let readingInput = true;
  try {
    assertLocalRequest(request);
    if (request.method !== "POST") {
      const response = jsonResponse(
        { error: "이 경로는 실행 기록 조회만 지원합니다.", code: "METHOD_NOT_ALLOWED" },
        405,
      );
      response.headers.set("Allow", "POST");
      return response;
    }
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수는 지원하지 않습니다.", 400, "INVALID_QUERY");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const selection = providerProductionInspectionInputSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, 4096)),
      ),
    );
    readingInput = false;
    const view = providerProductionViewSchema.parse(
      getPlanQualityStore().providerProductionStatus(selection),
    );
    if (
      view.selection?.runId !== selection.runId ||
      view.selection.runDigest !== selection.runDigest
    )
      throw Error("PROVIDER_PRODUCTION_STATUS_OUTPUT_MISMATCH");
    return jsonResponse(view);
  } catch (error) {
    if (readingInput && error instanceof StudioError)
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    if (readingInput && error instanceof ZodError)
      return jsonResponse(
        { error: "조회할 실행 기록을 확인해 주세요.", code: "INVALID_INPUT" },
        400,
      );
    if (readingInput && (error instanceof SyntaxError || error instanceof TypeError))
      return jsonResponse({ error: "JSON 요청 형식을 확인해 주세요.", code: "INVALID_JSON" }, 400);
    // Even a typed store/SDK error may contain private material. Never echo it after input parsing.
    return jsonResponse(
      {
        error: "저장된 실행 기록을 확인하지 못했습니다. 원래 실행의 이력을 다시 확인해 주세요.",
        code: "PROVIDER_PRODUCTION_STATUS_UNAVAILABLE",
      },
      500,
    );
  }
}
