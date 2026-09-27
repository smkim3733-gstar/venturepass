import { z, ZodError } from "zod";
import {
  assertLocalRequest,
  attachmentHeaders,
  jsonResponse,
  readBoundedBody,
  StudioError,
} from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import {
  planQualityCreateRunSchema,
  planQualitySaveRecordSchema,
  planQualityDownloadName,
  planQualityStoreLimits,
} from "./studio-plan-quality-store-types";

type Operation = "list" | "create" | "get" | "save" | "fixture" | "lookup" | "download";
type RouteParams = {
  runId?: string;
  revision?: string;
  fixtureId?: string;
  clientRequestId?: string;
};
const nonTerminal = new Set(["QUALITY_STORAGE_UNSAFE", "QUALITY_STORAGE_CORRUPT"]);
/** Local-only record input. This service has no model or company-storage dependency. */
export async function planQualityRoute(
  request: Request,
  operation: Operation,
  params: RouteParams = {},
) {
  try {
    assertLocalRequest(request);
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    const runId = params.runId === undefined ? undefined : z.string().uuid().parse(params.runId);
    const revision =
      params.revision === undefined
        ? undefined
        : z
            .string()
            .regex(/^(0|[1-9]\d{0,2})$/)
            .transform(Number)
            .pipe(z.number().max(planQualityStoreLimits.revisions))
            .parse(params.revision);
    const nonce =
      params.clientRequestId === undefined
        ? undefined
        : z.string().uuid().parse(params.clientRequestId);
    const fixtureId =
      params.fixtureId === undefined
        ? undefined
        : z
            .string()
            .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
            .parse(params.fixtureId);
    let input: unknown;
    if (operation === "create" || operation === "save") {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
        throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
      input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBody(
            request,
            operation === "create"
              ? planQualityStoreLimits.createBodyBytes
              : planQualityStoreLimits.recordBodyBytes,
          ),
        ),
      );
      input =
        operation === "create"
          ? planQualityCreateRunSchema.parse(input)
          : planQualitySaveRecordSchema.parse(input);
    }
    const store = getPlanQualityStore();
    switch (operation) {
      case "list":
        return jsonResponse(store.list());
      case "create":
        return jsonResponse(store.create(planQualityCreateRunSchema.parse(input)));
      case "save":
        return jsonResponse(store.save(runId!, planQualitySaveRecordSchema.parse(input)));
      case "get":
        return jsonResponse(store.get(runId!, revision));
      case "fixture":
        return jsonResponse(store.fixture(runId!, fixtureId!));
      case "lookup":
        return jsonResponse(store.lookup(nonce!));
      case "download": {
        const { run, body } = store.download(runId!, revision);
        return new Response(body, {
          headers: attachmentHeaders(
            planQualityDownloadName(run.id, run.revision),
            "application/json; charset=utf-8",
          ),
        });
      }
    }
  } catch (error) {
    if (error instanceof StudioError)
      return jsonResponse(
        {
          error: error.message,
          code: error.code,
          ...(error.status < 500 && !nonTerminal.has(error.code) ? { accepted: false } : {}),
        },
        error.status,
      );
    if (error instanceof ZodError)
      return jsonResponse(
        { error: "평가 기록 형식을 확인해 주세요.", code: "INVALID_INPUT", accepted: false },
        400,
      );
    if (
      error instanceof SyntaxError ||
      (error instanceof TypeError && error.message.includes("encoded data"))
    )
      return jsonResponse(
        { error: "JSON 요청 형식을 확인해 주세요.", code: "INVALID_JSON", accepted: false },
        400,
      );
    return jsonResponse(
      {
        error: "저장 결과를 확인하지 못했습니다. 같은 요청 번호로 저장 여부를 조회해 주세요.",
        code: "INTERNAL_ERROR",
      },
      500,
    );
  }
}
