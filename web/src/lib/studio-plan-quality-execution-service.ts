import { z, ZodError } from "zod";
import {
  assertLocalRequest,
  attachmentHeaders,
  jsonResponse,
  readBoundedBody,
  StudioError,
} from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import { getPlanExecutionContract } from "./studio-engine";
import {
  qualityExecutionDownloadName,
  qualityExecutionLimits,
  qualityExecutionStartSchema,
} from "./studio-plan-quality-execution-types";
import { runQualityMockExecution } from "./studio-plan-quality-execution-runner";

type Operation = "list" | "prepare" | "start" | "get" | "lookup" | "download";
type Params = { executionId?: string; revision?: string; clientRequestId?: string };
export const qualityExecutionPrepareInput = z
  .object({
    version: z.number().int().min(1).max(20),
    candidateId: z
      .string()
      .regex(/^validation-candidate-[a-z0-9-]+$/)
      .max(120),
  })
  .strict();
const nonTerminal = new Set(["QUALITY_STORAGE_UNSAFE", "QUALITY_STORAGE_CORRUPT"]);
/** Local, zero-charge mock transport only. Actual provider execution is not exposed. */
export async function qualityExecutionRoute(
  request: Request,
  operation: Operation,
  params: Params = {},
) {
  let started = false;
  try {
    assertLocalRequest(request);
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수는 지원하지 않습니다.", 400, "INVALID_QUERY");
    const id =
      operation === "get" || operation === "download"
        ? z.string().uuid().parse(params.executionId)
        : undefined;
    const nonce =
      operation === "lookup" ? z.string().uuid().parse(params.clientRequestId) : undefined;
    const revision =
      params.revision === undefined && operation !== "download"
        ? undefined
        : z
            .string()
            .regex(/^(0|[1-9]\d?)$/)
            .transform(Number)
            .pipe(z.number().max(qualityExecutionLimits.events))
            .parse(params.revision);
    let input: unknown;
    if (operation === "prepare" || operation === "start") {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
        throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
      input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBody(request, qualityExecutionLimits.bodyBytes),
        ),
      );
      input =
        operation === "prepare"
          ? qualityExecutionPrepareInput.parse(input)
          : qualityExecutionStartSchema.parse(input);
    }
    const store = getPlanQualityStore();
    switch (operation) {
      case "list":
        return jsonResponse(store.executionList());
      case "prepare":
        return jsonResponse(
          store.executionPrepare(
            qualityExecutionPrepareInput.parse(input),
            getPlanExecutionContract(),
          ),
        );
      case "start": {
        const result = store.executionStart(
          qualityExecutionStartSchema.parse(input),
          getPlanExecutionContract(),
        );
        started = true;
        if (result.replayed) return jsonResponse(result);
        const snapshot = await runQualityMockExecution(store, result.snapshot);
        return jsonResponse({ snapshot, replayed: false });
      }
      case "get":
        return jsonResponse(store.executionGet(id!, revision));
      case "lookup":
        return jsonResponse(store.executionLookup(nonce!));
      case "download": {
        const { snapshot, body } = store.executionDownload(id!, revision!);
        return new Response(body, {
          headers: attachmentHeaders(
            qualityExecutionDownloadName(snapshot.run.id, snapshot.revision),
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
          ...(!started && error.status < 500 && !nonTerminal.has(error.code)
            ? { accepted: false }
            : {}),
        },
        error.status,
      );
    if (!started && error instanceof ZodError)
      return jsonResponse(
        { error: "모의 실행 요청 형식을 확인해 주세요.", code: "INVALID_INPUT", accepted: false },
        400,
      );
    if (
      !started &&
      (error instanceof SyntaxError ||
        (error instanceof TypeError && error.message.includes("encoded data")))
    )
      return jsonResponse(
        { error: "JSON 요청 형식을 확인해 주세요.", code: "INVALID_JSON", accepted: false },
        400,
      );
    return jsonResponse(
      {
        error: "실행 기록 확인이 필요합니다. 같은 요청 번호로 저장 상태를 조회해 주세요.",
        code: "INTERNAL_ERROR",
      },
      500,
    );
  }
}
