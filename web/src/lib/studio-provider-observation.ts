import "server-only";
import {
  buildPlanGenerationRequest,
  buildPlanReviewRequest,
  buildPlanReviewTemplate,
  getPlanExecutionContract,
  StudioEngineError,
} from "./studio-engine-request-preparation";
import {
  validateObservedPlanDraft,
  validateObservedPlanReview,
  finalizeObservedPlanReview,
} from "./studio-engine";
import type { Candidate, PlanContent, ReviewFinding, StudioCase } from "./studio-schema";
import type {
  ProviderPreparation,
  ProviderRequestBody,
} from "./studio-plan-quality-provider-types";
import {
  providerDigest,
  providerRawDigest,
  providerWireDigest,
} from "./studio-plan-quality-provider-core";
import {
  captureProviderResponse,
  providerResponseMetadata,
  assessProviderUsage,
  freezeProviderValue,
  providerObservationLimits,
  validateProviderUsagePolicy,
  type ProviderCapturedResponse,
  type ProviderResponseMetadata,
  type ProviderUsageAssessment,
  type ProviderUsagePolicy,
} from "../../scripts/local-data-quality-provider-usage.mjs";

export type ProviderObservationRequest = {
  phase: "generation" | "review";
  sequence: 1 | 2;
  model: string;
  contractDigest: string;
  requestDigest: string;
  artifactSha256: string;
  inputChars: number;
  maxOutputTokens: 16000;
};
export type ProviderObservationPrepared = {
  request: ProviderObservationRequest;
  body: ProviderRequestBody;
  rawBody: string;
};
export type ProviderObservationCaptured = {
  request: ProviderObservationRequest;
  capturedResponse: ProviderCapturedResponse;
  metadata: ProviderResponseMetadata;
  usage: ProviderUsageAssessment;
};
export type ProviderObservationValidated = {
  request: ProviderObservationRequest;
  output: { kind: "plan"; content: PlanContent } | { kind: "review"; findings: ReviewFinding[] };
  outputDigest: string;
};
export type ProviderObservationOptions = {
  preparation: ProviderPreparation;
  generationRequestBody: string;
  executionContractDigest: string;
  usagePolicy: ProviderUsagePolicy;
  transport: {
    provenance: "synthetic-test";
    send: (value: ProviderObservationPrepared) => Promise<unknown>;
  };
  hooks: {
    onRequestPrepared: (value: ProviderObservationPrepared) => void | Promise<void>;
    onDispatch: (value: ProviderObservationRequest) => void | Promise<void>;
    onResponseCaptured: (value: ProviderObservationCaptured) => void | Promise<void>;
    onValidated: (value: ProviderObservationValidated) => void | Promise<void>;
  };
  beforeRequest?: () => void;
};
const fail = (code: string): never => {
  throw new StudioEngineError(
    code,
    "전송·응답 범위를 확인하지 못해 후속 실행을 중단했습니다.",
    502,
  );
};
const immutable = <T>(value: T): T => freezeProviderValue(structuredClone(value));
const options = {
  service_tier: "default",
  truncation: "disabled",
  background: false,
  stream: false,
} as const;
function outputJson(response: ProviderCapturedResponse): unknown {
  if (response.status !== "completed" || !Array.isArray(response.output))
    return fail("AI_INCOMPLETE");
  const texts: string[] = [];
  for (const item of response.output) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      item.type !== "message" ||
      !Array.isArray(item.content)
    )
      continue;
    for (const part of item.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      if (part.type === "refusal") return fail("AI_INCOMPLETE");
      if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  if (texts.length !== 1 || Buffer.byteLength(texts[0]) > providerObservationLimits.validatedBytes)
    return fail("AI_INVALID_OUTPUT");
  try {
    return JSON.parse(texts[0]);
  } catch {
    return fail("AI_INVALID_OUTPUT");
  }
}

/** Synthetic injection only. No provider client, configuration, credentials or network lookup. */
export async function generateObservedProviderPlan(
  company: StudioCase,
  candidate: Candidate,
  input: ProviderObservationOptions,
) {
  if (
    input.transport.provenance !== "synthetic-test" ||
    input.preparation.environment !== "synthetic-test" ||
    !/^[a-f0-9]{64}$/.test(input.executionContractDigest)
  )
    fail("PROVIDER_TRANSPORT_DISABLED");
  const value = structuredClone(company),
    selected = structuredClone(candidate),
    prep = structuredClone(input.preparation),
    policy = validateProviderUsagePolicy(structuredClone(input.usagePolicy), prep.financialBasis),
    hooks = { ...input.hooks },
    send = input.transport.send,
    beforeRequest = input.beforeRequest,
    contractDigest = input.executionContractDigest,
    generationRaw = input.generationRequestBody;
  if (
    policy.financialBasisDigest !== providerDigest(prep.financialBasis) ||
    policy.configuredModel !== prep.model ||
    policy.provenance !== "synthetic-test"
  )
    fail("PROVIDER_POLICY_SCOPE_CHANGED");
  const assertCurrent = () => {
    beforeRequest?.();
    if (getPlanExecutionContract().contractDigest !== prep.contract.baseContract.contractDigest)
      fail("PROVIDER_CONTRACT_CHANGED");
  };
  assertCurrent();
  const generation = {
    ...buildPlanGenerationRequest(value, selected, prep.model).body,
    ...options,
  };
  const template = buildPlanReviewTemplate(value, selected, prep.model);
  const expectedTemplate = {
    ...template,
    schemaVersion: 2,
    contractDigest: prep.contract.contractDigest,
    requestOptions: options,
  };
  delete (expectedTemplate as { templateDigest?: string }).templateDigest;
  if (
    JSON.stringify(generation) !== generationRaw ||
    JSON.stringify(prep.generation.body) !== generationRaw ||
    providerRawDigest(generationRaw) !== prep.generation.sha256 ||
    providerWireDigest(generation) !== prep.generation.requestDigest ||
    providerWireDigest(expectedTemplate) !== prep.reviewTemplate.templateDigest
  )
    fail("PROVIDER_REQUEST_CHANGED");
  async function request(
    phase: "generation" | "review",
    body: ProviderRequestBody,
    rawBody: string,
  ) {
    assertCurrent();
    if (
      Buffer.byteLength(rawBody) > providerObservationLimits.requestBytes ||
      JSON.stringify(body) !== rawBody
    )
      fail("PROVIDER_REQUEST_TOO_LARGE");
    const metadata: ProviderObservationRequest = {
      phase,
      sequence: phase === "generation" ? 1 : 2,
      model: prep.model,
      contractDigest,
      requestDigest: providerWireDigest(body),
      artifactSha256: providerRawDigest(rawBody),
      inputChars: body.input.reduce((n, v) => n + v.content.length, 0),
      maxOutputTokens: 16000,
    };
    const prepared = { request: metadata, body, rawBody };
    await hooks.onRequestPrepared(immutable(prepared));
    assertCurrent();
    await hooks.onDispatch(immutable(metadata));
    assertCurrent();
    // A dispatch hook may itself stop/reject. Only its successful awaited return reaches transport.
    const raw = await send(immutable(prepared));
    // Never check current configuration before preserving an already received response.
    const capturedResponse = captureProviderResponse(raw);
    const responseMetadata = providerResponseMetadata(capturedResponse, {
      configuredModel: prep.model,
    });
    const usage = assessProviderUsage({
      response: capturedResponse,
      policy,
      financialBasis: prep.financialBasis,
      phase,
    });
    await hooks.onResponseCaptured(
      immutable({ request: metadata, capturedResponse, metadata: responseMetadata, usage }),
    );
    if (usage.status !== "known") fail("PROVIDER_USAGE_UNKNOWN");
    if (usage.violations.length) fail("PROVIDER_USAGE_BOUND_EXCEEDED");
    assertCurrent();
    return { request: metadata, raw: outputJson(capturedResponse) };
  }
  async function validated(
    request: ProviderObservationRequest,
    output: ProviderObservationValidated["output"],
  ) {
    if (Buffer.byteLength(JSON.stringify(output)) > providerObservationLimits.validatedBytes)
      fail("PROVIDER_OUTPUT_TOO_LARGE");
    const observed = { request, output, outputDigest: providerDigest(output) };
    await hooks.onValidated(immutable(observed));
  }
  const first = await request("generation", generation, generationRaw);
  const draft = validateObservedPlanDraft(value, first.raw);
  await validated(first.request, { kind: "plan", content: draft });
  // This isolated draft precedes semantic review and is the only permitted derivation input.
  const reviewBody = {
    ...buildPlanReviewRequest(value, selected, structuredClone(draft), prep.model).body,
    ...options,
  };
  const second = await request("review", reviewBody, JSON.stringify(reviewBody));
  const findings = validateObservedPlanReview(value, second.raw);
  await validated(second.request, { kind: "review", findings });
  const result = { ...finalizeObservedPlanReview(value, draft, findings), contractDigest };
  if (Buffer.byteLength(JSON.stringify(result)) > providerObservationLimits.finalBytes)
    fail("PROVIDER_OUTPUT_TOO_LARGE");
  return result;
}
