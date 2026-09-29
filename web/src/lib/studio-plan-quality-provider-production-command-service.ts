import "server-only";
import { ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import {
  executeProviderProductionSelection,
  recoverProviderProductionSelection,
} from "./studio-plan-quality-provider-production-server";
import {
  providerProductionSelectionSchema,
  providerProductionViewSchema,
} from "./studio-plan-quality-provider-production-service-types";

const inputErrors = {
  LOCAL_ONLY: { status: 403, error: "로컬 앱에서만 사용할 수 있습니다." },
  CROSS_ORIGIN: { status: 403, error: "다른 사이트에서 보낸 요청은 허용하지 않습니다." },
  INVALID_QUERY: { status: 400, error: "URL 매개변수는 지원하지 않습니다." },
  CONTENT_TYPE: { status: 415, error: "JSON 형식으로 요청해 주세요." },
  TOO_LARGE: { status: 413, error: "요청 용량이 허용 범위를 초과했습니다." },
  REQUEST_ABORTED: {
    status: 409,
    error: "실행 전에 요청이 취소됐습니다. 원래 실행 이력을 확인해 주세요.",
  },
} as const;
function rejectInput(code: keyof typeof inputErrors): never {
  throw new StudioError(inputErrors[code].error, inputErrors[code].status, code);
}

/** The action is fixed by the route, never selected in client JSON/query. This boundary only
 * uses the retained server owner; it cannot install/reconfigure/retire a runtime or store. */
async function commandRoute(request: Request, action: "execute" | "recover") {
  let readingInput = true;
  try {
    assertLocalRequest(request);
    if (request.method !== "POST") {
      const response = jsonResponse(
        { error: "POST 요청만 지원합니다.", code: "METHOD_NOT_ALLOWED" },
        405,
      );
      response.headers.set("Allow", "POST");
      return response;
    }
    if (new URL(request.url).search) rejectInput("INVALID_QUERY");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      rejectInput("CONTENT_TYPE");
    if (request.signal.aborted) rejectInput("REQUEST_ABORTED");
    const selection = providerProductionSelectionSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, 4096)),
      ),
    );
    if (request.signal.aborted) rejectInput("REQUEST_ABORTED");
    readingInput = false;
    // From here a disconnect is NOT a provider cancellation or permission to retry. Do not
    // race with Request.signal, pass it to the owner, or discard a pending capture on abort.
    const view = providerProductionViewSchema.parse(
      await (action === "execute"
        ? executeProviderProductionSelection(selection)
        : recoverProviderProductionSelection(selection)),
    );
    if (
      view.selection?.runId !== selection.runId ||
      view.selection.runDigest !== selection.runDigest ||
      view.selection.approvalBindingDigest !== selection.approvalBindingDigest
    )
      throw Error("PROVIDER_PRODUCTION_COMMAND_OUTPUT_MISMATCH");
    const status =
      view.status !== "unavailable" ? 200 : view.reason === "execution-unavailable" ? 503 : 409;
    return jsonResponse(view, status);
  } catch (error) {
    if (readingInput) {
      // Stream failures can carry arbitrary messages/codes too. Reflect only our fixed map.
      if (error instanceof StudioError && Object.hasOwn(inputErrors, error.code)) {
        const known = inputErrors[error.code as keyof typeof inputErrors];
        return jsonResponse({ error: known.error, code: error.code }, known.status);
      }
      const invalid = error instanceof ZodError;
      return jsonResponse(
        {
          error: invalid
            ? "실행할 원래 승인 기록을 확인해 주세요."
            : "JSON 요청 형식을 확인해 주세요.",
          code: invalid ? "INVALID_INPUT" : "INVALID_JSON",
        },
        400,
      );
    }
    // Never echo a runner/SDK/DB error, even a StudioError, or serialize unvalidated output.
    return jsonResponse(
      {
        error: "실행 결과를 확정하지 못했습니다. 원래 실행 이력을 확인해 주세요.",
        code: "PROVIDER_PRODUCTION_COMMAND_UNAVAILABLE",
      },
      500,
    );
  }
}

export function qualityProviderProductionExecuteRoute(request: Request) {
  return commandRoute(request, "execute");
}
export function qualityProviderProductionRecoverRoute(request: Request) {
  return commandRoute(request, "recover");
}
