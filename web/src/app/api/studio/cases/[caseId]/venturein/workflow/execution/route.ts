import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
import { withVentureLock } from "@/lib/venturein-service";
import { ventureExecutionRequestSchema } from "@/lib/venturein-execution-schema";
import {
  prepareVentureExecution,
  executeVentureInput,
  compareVentureInput,
  prepareVentureRecovery,
  executeVentureRecovery,
  compareVenturePreparedPackage,
} from "@/lib/venturein-execution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ caseId: string }> };

export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = ventureExecutionRequestSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))),
    );
    const { caseId } = await context.params;
    return withVentureLock(caseId, async () =>
      jsonResponse(
        input.action === "compare-prepared-package"
          ? { preparedComparison: compareVenturePreparedPackage(caseId, input) }
          : input.action === "prepare"
            ? { review: prepareVentureExecution(caseId, input) }
            : input.action === "prepare-recovery"
              ? { review: await prepareVentureRecovery(caseId, input) }
              : input.action === "execute-recovery"
                ? await executeVentureRecovery(caseId, input)
                : input.action === "compare"
                  ? { comparison: await compareVentureInput(caseId, input) }
                  : await executeVentureInput(caseId, input),
      ),
    );
  });
}
