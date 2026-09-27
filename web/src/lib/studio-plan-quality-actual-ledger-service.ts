import { z, ZodError } from "zod";
import { assertLocalRequest, attachmentHeaders, jsonResponse, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import {
  actualLedgerArtifactKeySchema,
  actualLedgerLimits,
  actualLedgerNotice,
} from "./studio-plan-quality-actual-ledger-types";

type Operation = "overview" | "get" | "lookup" | "artifact" | "download";
type Params = { runId?: string; revision?: string; clientRequestId?: string; artifactKey?: string };

/** Read-only local evidence. No approval, reservation, dispatch or provider entry point. */
export async function qualityActualLedgerRoute(
  request: Request,
  operation: Operation,
  params: Params = {},
) {
  try {
    assertLocalRequest(request);
    if (request.method !== "GET") {
      const response = jsonResponse(
        { error: "이 경로는 보관 기록 조회만 지원합니다.", code: "METHOD_NOT_ALLOWED" },
        405,
      );
      response.headers.set("Allow", "GET");
      return response;
    }
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수는 지원하지 않습니다.", 400, "INVALID_QUERY");
    const id = ["get", "artifact", "download"].includes(operation)
      ? z.string().uuid().parse(params.runId)
      : undefined;
    const nonce =
      operation === "lookup" ? z.string().uuid().parse(params.clientRequestId) : undefined;
    const key =
      operation === "artifact"
        ? actualLedgerArtifactKeySchema.parse(params.artifactKey)
        : undefined;
    const revision =
      params.revision === undefined && operation !== "download"
        ? undefined
        : z
            .string()
            .regex(/^(0|[1-9]\d?)$/)
            .transform(Number)
            .pipe(z.number().max(actualLedgerLimits.events))
            .parse(params.revision);
    const store = getPlanQualityStore();
    switch (operation) {
      case "overview":
        return jsonResponse({
          notice: actualLedgerNotice,
          actualExecutionEnabled: false,
          budget: store.actualBudgetGet(),
          ...store.actualList(),
        });
      case "get":
        return jsonResponse(store.actualGet(id!, revision));
      case "lookup":
        return jsonResponse(store.actualLookup(nonce!));
      case "artifact": {
        const artifact = store.actualArtifact(id!, key!);
        return new Response(new Uint8Array(artifact.body), {
          headers: {
            ...attachmentHeaders(
              `venturepass-ledger-${id}-${key}.json`,
              "application/json; charset=utf-8",
            ),
            "X-Content-SHA256": artifact.sha256,
          },
        });
      }
      case "download": {
        const { snapshot, body } = store.actualDownload(id!, revision!);
        return new Response(body, {
          headers: attachmentHeaders(
            `venturepass-ledger-${snapshot.run.id}-r${snapshot.revision}.json`,
            "application/json; charset=utf-8",
          ),
        });
      }
    }
  } catch (error) {
    if (error instanceof StudioError)
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    if (error instanceof ZodError)
      return jsonResponse(
        { error: "조회할 원장 기록의 주소를 확인해 주세요.", code: "INVALID_INPUT" },
        400,
      );
    return jsonResponse(
      {
        error: "비용 원장 기록을 확인하지 못했습니다. 기록 상태를 추정하지 않습니다.",
        code: "ACTUAL_LEDGER_UNAVAILABLE",
      },
      500,
    );
  }
}
