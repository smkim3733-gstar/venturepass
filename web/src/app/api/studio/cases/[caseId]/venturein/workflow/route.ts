import {
  jsonResponse,
  readBoundedBody,
  studioRoute,
  StudioError,
  attachmentHeaders,
} from "@/lib/studio-http";
import { withVentureLock } from "@/lib/venturein-service";
import {
  getVentureWorkflow,
  inspectVentureWorkflow,
  inspectWorkflowSchema,
  saveVentureWorkflow,
  saveWorkflowSchema,
} from "@/lib/venturein-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ caseId: string }> };

async function readWorkflowBody(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
  return JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 128 * 1024)));
}

export function GET(request: Request, context: Context) {
  return studioRoute(request, async () => {
    const { caseId } = await context.params;
    const workflow = getVentureWorkflow(caseId);
    if (new URL(request.url).searchParams.get("download") === "1")
      return new Response(
        JSON.stringify(
          {
            format: "venturepass-local-review-v2",
            exportedAt: new Date().toISOString(),
            latestExecutionExternalWritesPerformed: workflow.execution
              ? workflow.execution.completedFieldKeys.length > 0
                ? true
                : workflow.execution.status === "running" ||
                    (workflow.execution.touchedFieldKeys?.length ?? 0) > 0 ||
                    workflow.execution.attemptedFieldKey ||
                    workflow.execution.code === "INPUT_RESULT_UNKNOWN"
                  ? null
                  : false
              : false,
            automaticSubmissionAvailable: false,
            ...workflow,
          },
          null,
          2,
        ),
        {
          headers: attachmentHeaders(
            "벤처인_입력첨부_검토안.json",
            "application/json; charset=utf-8",
          ),
        },
      );
    return jsonResponse(workflow);
  });
}

export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    const { caseId } = await context.params;
    const input = inspectWorkflowSchema.parse(await readWorkflowBody(request));
    return withVentureLock(caseId, async () =>
      jsonResponse(await inspectVentureWorkflow(caseId, input)),
    );
  });
}

export function PUT(request: Request, context: Context) {
  return studioRoute(request, async () => {
    const { caseId } = await context.params;
    const input = saveWorkflowSchema.parse(await readWorkflowBody(request));
    return withVentureLock(caseId, () =>
      Promise.resolve(jsonResponse(saveVentureWorkflow(caseId, input))),
    );
  });
}
