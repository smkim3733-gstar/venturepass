import { z } from "zod";
import { jsonResponse, readBoundedBody, StudioError, studioRoute } from "./studio-http";
import { preparationAutomationRequestSchema } from "./studio-preparation-automation-types";
import {
  getPreparationAutomationStatus,
  PreparationAutomationRequestError,
  runPreparationAutomation,
  type PreparationAutomationRuntime,
  type PreparationAutomationStore,
} from "./studio-preparation-automation-service";

type Context = { params: Promise<{ caseId: string }> };
const maximumRequestBytes = 8192;
function noQuery(request: Request) {
  if (new URL(request.url).search)
    throw new StudioError("이 요청에는 URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
}
/** Route factory permits isolated API testing before shared store integration is installed. */
export function createPreparationAutomationHandlers(
  getStore: () => PreparationAutomationStore,
  runtime: PreparationAutomationRuntime,
) {
  return {
    GET(request: Request, context: Context) {
      return studioRoute(request, async () => {
        noQuery(request);
        const id = z
          .string()
          .uuid()
          .parse((await context.params).caseId);
        return jsonResponse(getPreparationAutomationStatus(getStore(), runtime, id));
      });
    },
    POST(request: Request, context: Context) {
      return studioRoute(request, async () => {
        noQuery(request);
        const id = z
          .string()
          .uuid()
          .parse((await context.params).caseId);
        if (!request.headers.get("content-type")?.startsWith("application/json"))
          throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
        const input = preparationAutomationRequestSchema.parse(
          JSON.parse(new TextDecoder().decode(await readBoundedBody(request, maximumRequestBytes))),
        );
        try {
          return jsonResponse(await runPreparationAutomation(getStore(), runtime, id, input));
        } catch (error) {
          if (error instanceof PreparationAutomationRequestError)
            return jsonResponse(
              { error: error.message, code: error.code, accepted: error.accepted },
              error.status,
            );
          throw error;
        }
      });
    },
  };
}
