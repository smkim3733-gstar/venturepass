import { z, ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import { createQualityActualPreparation } from "./studio-plan-quality-actual-preparation";

export const qualityActualPreparationInputSchema = z
  .object({
    version: z.number().int().min(1).max(20),
    versionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    candidateId: z
      .string()
      .regex(/^validation-candidate-[a-z0-9-]+$/)
      .max(120),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
      .nullable(),
  })
  .strict();

/** Read-only inspection. No prices, token attestations, approvals or execution are accepted. */
export async function qualityActualPreparationRoute(request: Request) {
  try {
    assertLocalRequest(request);
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수는 지원하지 않습니다.", 400, "INVALID_QUERY");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = qualityActualPreparationInputSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, 4096)),
      ),
    );
    const registry = getPlanQualityStore().candidateRegistryGet(input.version);
    if (registry.versionDigest !== input.versionDigest)
      throw new StudioError(
        "선택한 등록 버전과 서버의 원문이 다릅니다. 등록본을 다시 확인해 주세요.",
        409,
        "ACTUAL_PREPARATION_SCOPE_CHANGED",
      );
    if (!registry.entries.some((entry) => entry.candidateId === input.candidateId))
      throw new StudioError(
        "등록본에서 선택한 후보를 찾을 수 없습니다.",
        404,
        "ACTUAL_PREPARATION_CANDIDATE_NOT_FOUND",
      );
    const preparation = createQualityActualPreparation({
      registry,
      candidateId: input.candidateId,
      model: input.model,
      preparedAt: new Date().toISOString(),
      price: null,
      tokens: null,
      budget: null,
      environment: "production",
    });
    return jsonResponse(preparation);
  } catch (error) {
    if (error instanceof StudioError)
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    if (error instanceof ZodError)
      return jsonResponse(
        { error: "준비 조회의 후보·모델 형식을 확인해 주세요.", code: "INVALID_INPUT" },
        400,
      );
    if (
      error instanceof SyntaxError ||
      (error instanceof TypeError && error.message.includes("encoded data"))
    )
      return jsonResponse({ error: "JSON 요청 형식을 확인해 주세요.", code: "INVALID_JSON" }, 400);
    return jsonResponse(
      {
        error:
          "실행 전 준비 내용을 확인하지 못했습니다. 실행이나 비용 예약은 이루어지지 않았습니다.",
        code: "ACTUAL_PREPARATION_UNAVAILABLE",
      },
      500,
    );
  }
}
