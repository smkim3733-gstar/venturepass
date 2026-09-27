import { ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  getProviderConfigurationProposal,
  createProviderConfigurationProposalView,
} from "./studio-plan-quality-provider-configuration";
import {
  providerReviewInputSchema,
  providerReviewViewSchema,
  providerReviewDigestInput,
  providerReviewLimits,
  providerReviewNotice,
  providerReviewBlockerCodes,
  providerReviewBlockerMessages,
  type ProviderReviewMissingView,
} from "./studio-plan-quality-provider-review-types";

/** Read-only v2 inspection. No credential lookup, provider call, reservation or approval mutation. */
export async function qualityProviderReviewRoute(request: Request) {
  let readingInput = true;
  try {
    assertLocalRequest(request);
    if (request.method !== "POST") {
      const response = jsonResponse(
        { error: "이 경로는 준비 조회만 지원합니다.", code: "METHOD_NOT_ALLOWED" },
        405,
      );
      response.headers.set("Allow", "POST");
      return response;
    }
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수는 지원하지 않습니다.", 400, "INVALID_QUERY");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = providerReviewInputSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBody(request, providerReviewLimits.bodyBytes),
        ),
      ),
    );
    readingInput = false;
    const registry = getPlanQualityStore().candidateRegistryGet(input.version);
    if (registry.versionDigest !== input.versionDigest)
      throw new StudioError(
        "선택한 후보 등록본이 달라졌습니다. 등록본을 다시 확인해 주세요.",
        409,
        "PROVIDER_REVIEW_SCOPE_CHANGED",
      );
    const manifest = registry.manifest.find((entry) => entry.candidateId === input.candidateId);
    if (!manifest || !registry.entries.some((entry) => entry.candidateId === input.candidateId))
      throw new StudioError(
        "등록본에서 선택한 후보를 찾을 수 없습니다.",
        404,
        "PROVIDER_REVIEW_CANDIDATE_NOT_FOUND",
      );
    const inspectedAt = new Date().toISOString();
    const proposal = createProviderConfigurationProposalView({
      registry,
      candidateId: input.candidateId,
      inspectedAt,
      configuration: getProviderConfigurationProposal(),
    });
    if (proposal) return jsonResponse(proposal);
    const view: Omit<ProviderReviewMissingView, "viewDigest"> = {
      viewVersion: 1,
      providerContractVersion: 2,
      state: "configuration-missing",
      environment: "production",
      inputProvenance: "registered-synthetic-candidate",
      scope: {
        ...input,
        setId: registry.setId,
        registrySourceDigest: registry.sourceDigest,
        manifestDigest: registry.manifestDigest,
        label: manifest.label,
        sourceDigest: manifest.sourceDigest,
        candidateDigest: manifest.candidateDigest,
        modelInputDigest: manifest.modelInputDigest,
      },
      inspectedAt,
      model: null,
      financialBasis: null,
      budget: null,
      retention: null,
      preparation: null,
      transmissionManifest: null,
      accountAccess: "not-checked",
      actualExecutionEnabled: false,
      maxCalls: 2,
      maxRetries: 0,
      automaticRepair: false,
      blockers: providerReviewBlockerCodes.map((code) => ({
        code,
        message: providerReviewBlockerMessages[code],
      })),
      notice: providerReviewNotice,
    };
    return jsonResponse(
      providerReviewViewSchema.parse({
        ...view,
        viewDigest: digest(providerReviewDigestInput(view)),
      }),
    );
  } catch (error) {
    if (error instanceof StudioError)
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    if (readingInput && error instanceof ZodError)
      return jsonResponse(
        { error: "조회할 후보 등록 버전과 후보를 확인해 주세요.", code: "INVALID_INPUT" },
        400,
      );
    if (readingInput && (error instanceof SyntaxError || error instanceof TypeError))
      return jsonResponse({ error: "JSON 요청 형식을 확인해 주세요.", code: "INVALID_JSON" }, 400);
    return jsonResponse(
      {
        error: "검토안을 확인하지 못했습니다. 승인·실행·비용 예약은 이루어지지 않았습니다.",
        code: "PROVIDER_REVIEW_UNAVAILABLE",
      },
      500,
    );
  }
}
