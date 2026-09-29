import "server-only";
import { ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import { getPlanQualityStore } from "./studio-plan-quality-store";
import {
  providerDigest as digest,
  providerWireDigest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import { validateProviderUsagePolicy } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  providerTransmissionReviewInputSchema,
  providerTransmissionReviewDigestInput,
  type ProviderTransmissionReview,
} from "./studio-plan-quality-provider-transmission-review-types";
import {
  providerTransmissionHttpLimits,
  providerTransmissionInspectionResponseSchema,
  providerTransmissionInspectionStatus,
} from "./studio-plan-quality-provider-transmission-http-types";

const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
/** Output consistency only. The store's audited snapshot is the authority, not these checksums. */
function checkReviewDigests(v: ProviderTransmissionReview) {
  const manifest = v.manifest,
    c = manifest.executionContract,
    r = v.request;
  validateProviderUsagePolicy(c.usagePolicy, v.financialBasis);
  if (
    v.reviewDigest !== digest(providerTransmissionReviewDigestInput(v)) ||
    manifest.manifestDigest !== digest(without(manifest, "manifestDigest")) ||
    c.contractDigest !== digest(without(c, "contractDigest")) ||
    c.usagePolicyDigest !== digest(c.usagePolicy) ||
    c.usagePolicy.financialBasisDigest !== digest(v.financialBasis) ||
    r.contract.contractDigest !== providerWireDigest(without(r.contract, "contractDigest")) ||
    r.contract.baseContract.contractDigest !==
      providerWireDigest(without(r.contract.baseContract, "contractDigest")) ||
    r.generation.requestDigest !== providerWireDigest(r.generation.body) ||
    r.generation.sha256 !== providerRawDigest(JSON.stringify(r.generation.body)) ||
    r.reviewTemplate.templateDigest !==
      providerWireDigest(without(r.reviewTemplate, "templateDigest"))
  )
    throw new Error("Transmission review output mismatch");
}

/** Read-only HTTP boundary. Never invokes a write, runner, provider, or separate evidence read. */
export async function qualityProviderTransmissionReviewRoute(request: Request) {
  let readingInput = true;
  try {
    assertLocalRequest(request);
    if (request.method !== "POST") {
      const response = jsonResponse(
        { error: "이 경로는 전송 검토 조회만 지원합니다.", code: "METHOD_NOT_ALLOWED" },
        405,
      );
      response.headers.set("Allow", "POST");
      return response;
    }
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수는 지원하지 않습니다.", 400, "INVALID_QUERY");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const selection = providerTransmissionReviewInputSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBody(request, providerTransmissionHttpLimits.bodyBytes),
        ),
      ),
    );
    readingInput = false;
    const result = getPlanQualityStore().providerTransmissionReview(selection);
    // Internal archive/inspection failures are intentionally absent from the public envelope.
    const value = providerTransmissionInspectionResponseSchema.parse({
      ...result,
      responseVersion: 1,
      selection,
    });
    if (value.status === "review") checkReviewDigests(value.review);
    return jsonResponse(value, providerTransmissionInspectionStatus(value));
  } catch (error) {
    if (error instanceof StudioError)
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    if (readingInput && error instanceof ZodError)
      return jsonResponse(
        { error: "조회할 예약 실행과 digest를 확인해 주세요.", code: "INVALID_INPUT" },
        400,
      );
    if (readingInput && (error instanceof SyntaxError || error instanceof TypeError))
      return jsonResponse({ error: "JSON 요청 형식을 확인해 주세요.", code: "INVALID_JSON" }, 400);
    return jsonResponse(
      {
        error: "전송 검토를 확인하지 못했습니다. 다시 조회해 주세요.",
        code: "PROVIDER_TRANSMISSION_REVIEW_UNAVAILABLE",
      },
      500,
    );
  }
}
