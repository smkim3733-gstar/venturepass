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
  candidateRegistryDownloadName,
  candidateRegistryLimits,
  candidateRegistryRegisterSchema,
} from "./studio-plan-quality-candidate-registry-types";

type Operation = "list" | "register" | "get" | "lookup" | "download";
type RouteParams = { version?: string; clientRequestId?: string };
const nonTerminal = new Set(["QUALITY_STORAGE_UNSAFE", "QUALITY_STORAGE_CORRUPT"]);

/** Registers only bundled synthetic candidates. No model or customer storage access. */
export async function candidateRegistryRoute(
  request: Request,
  operation: Operation,
  params: RouteParams = {},
) {
  try {
    assertLocalRequest(request);
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    const version =
      operation === "get" || operation === "download"
        ? z
            .string()
            .regex(/^[1-9]\d?$/)
            .transform(Number)
            .pipe(z.number().max(candidateRegistryLimits.versions))
            .parse(params.version)
        : undefined;
    const nonce =
      operation === "lookup" ? z.string().uuid().parse(params.clientRequestId) : undefined;
    let input: z.infer<typeof candidateRegistryRegisterSchema> | undefined;
    if (operation === "register") {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
        throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
      input = candidateRegistryRegisterSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readBoundedBody(request, candidateRegistryLimits.bodyBytes),
          ),
        ),
      );
    }
    const store = getPlanQualityStore();
    switch (operation) {
      case "list":
        return jsonResponse(store.candidateRegistryList());
      case "register":
        return jsonResponse(store.candidateRegistryRegister(input!));
      case "get":
        return jsonResponse(store.candidateRegistryGet(version!));
      case "lookup":
        return jsonResponse(store.candidateRegistryLookup(nonce!));
      case "download": {
        const { snapshot, body } = store.candidateRegistryDownload(version!);
        return new Response(body, {
          headers: attachmentHeaders(
            candidateRegistryDownloadName(snapshot.version),
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
        { error: "후보 등록 요청 형식을 확인해 주세요.", code: "INVALID_INPUT", accepted: false },
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
        error: "등록 결과를 확인하지 못했습니다. 같은 요청 번호로 등록 여부를 조회해 주세요.",
        code: "INTERNAL_ERROR",
      },
      500,
    );
  }
}
