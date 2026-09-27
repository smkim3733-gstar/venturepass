import { createHash } from "node:crypto";
import { z, ZodError } from "zod";
import { assertLocalRequest, attachmentHeaders, jsonResponse, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import {
  providerLedgerArtifactKeySchema,
  providerLedgerArtifactName,
  providerLedgerDownloadName,
  providerLedgerNotice,
  type ProviderLedgerOverview,
} from "./studio-plan-quality-provider-review-types";

type Operation = "overview" | "get" | "lookup" | "artifact" | "download";
type Params = { runId?: string; revision?: string; clientRequestId?: string; artifactKey?: string };
const revisionSchema = z
  .string()
  .regex(/^(0|[1-9]\d?)$/)
  .transform(Number)
  .pipe(z.number().max(32));

/** Read stored v2 evidence through the default store; no write mode or transport is enabled. */
export async function qualityProviderLedgerRoute(
  request: Request,
  operation: Operation,
  params: Params = {},
) {
  let readingInput = true;
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
        ? providerLedgerArtifactKeySchema.parse(params.artifactKey)
        : undefined;
    const revision =
      params.revision === undefined && operation !== "download" && operation !== "artifact"
        ? undefined
        : revisionSchema.parse(params.revision);
    readingInput = false;
    const store = getPlanQualityStore();
    switch (operation) {
      case "overview": {
        const production = store.providerBudgetGet("production"),
          synthetic = store.providerBudgetGet("synthetic-test");
        const result: ProviderLedgerOverview = {
          schemaVersion: 2,
          kind: "provider-ledger-overview",
          notice: providerLedgerNotice,
          actualExecutionEnabled: false,
          budgets: {
            production: production.revision === 0 ? null : production,
            synthetic: synthetic.revision === 0 ? null : synthetic,
          },
          ...store.providerList(),
        };
        return jsonResponse(result);
      }
      case "get":
        return jsonResponse(store.providerGet(id!, revision));
      case "lookup":
        return jsonResponse(store.providerLookup(nonce!));
      case "artifact": {
        const snapshot = store.providerGet(id!, revision!);
        const expected = snapshot.artifacts.find((artifact) => artifact.key === key);
        if (!expected)
          throw new StudioError(
            "선택한 기록 버전에 이 원문이 없습니다.",
            404,
            "PROVIDER_LEDGER_ARTIFACT_NOT_IN_REVISION",
          );
        const artifact = store.providerArtifact(id!, key!);
        if (
          artifact.runId !== id ||
          artifact.key !== key ||
          artifact.sha256 !== expected.sha256 ||
          artifact.sizeBytes !== expected.sizeBytes ||
          artifact.body.byteLength !== expected.sizeBytes ||
          createHash("sha256").update(artifact.body).digest("hex") !== expected.sha256
        )
          throw new StudioError(
            "선택한 기록 버전과 원문이 일치하지 않습니다.",
            409,
            "PROVIDER_LEDGER_ARTIFACT_MISMATCH",
          );
        return new Response(new Uint8Array(artifact.body), {
          headers: {
            ...attachmentHeaders(
              providerLedgerArtifactName(id!, revision!, key!),
              "application/json; charset=utf-8",
            ),
            "X-Content-SHA256": artifact.sha256,
          },
        });
      }
      case "download": {
        const { body } = store.providerDownload(id!, revision!);
        return new Response(body, {
          headers: {
            ...attachmentHeaders(
              providerLedgerDownloadName(id!, revision!),
              "application/json; charset=utf-8",
            ),
            "X-Content-SHA256": createHash("sha256").update(body).digest("hex"),
          },
        });
      }
    }
  } catch (error) {
    if (error instanceof StudioError)
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    if (readingInput && error instanceof ZodError)
      return jsonResponse(
        { error: "조회할 원장 기록의 주소를 확인해 주세요.", code: "INVALID_INPUT" },
        400,
      );
    return jsonResponse(
      {
        error: "원장 기록을 확인하지 못했습니다. 실행·비용 상태를 추정하지 않습니다.",
        code: "PROVIDER_LEDGER_UNAVAILABLE",
      },
      500,
    );
  }
}
