import { createHash } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { trackContext } from "./studio-preparation-context";
export { trackContext } from "./studio-preparation-context";
import { getPlanPromptDefinition, type PlanPromptVersion } from "./studio-plan-prompt-versions";
import { getCandidateClassification } from "./studio-candidate-classification";
import {
  engineExecutionContractSchema,
  type EngineExecutionContract,
  type EngineExecutionPhase,
  type EngineExecutionTransportRequest,
} from "./studio-engine-execution-types";
import {
  planContentSchema,
  reviewSchema,
  sectionDefinitions,
  sourceKindLabels,
  type Candidate,
  type PlanContent,
  type StudioCase,
} from "./studio-schema";

// Existing consumers remain pinned to v1; versioned preparation is explicitly selected.
const legacyPrompt = getPlanPromptDefinition("plan-observation-v1");
export const candidateClassificationInstructions = legacyPrompt.candidateClassificationInstructions;
export const systemPrompt = legacyPrompt.systemPrompt;
export const planGenerationInstruction = legacyPrompt.generationInstruction;
export const planReviewInstruction = legacyPrompt.reviewInstruction;

export class StudioEngineError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
    this.name = "StudioEngineError";
  }
}

export function aiInput(value: StudioCase, extra: object = {}) {
  const profile = { ...value.profile, businessNumber: undefined };
  const input = JSON.stringify({
    profile,
    preparationContext: trackContext(value),
    unextractedSourceCount: value.sources.filter((source) => source.extraction === "pending")
      .length,
    sources: value.sources
      .filter((source) => source.extraction !== "pending")
      .map(({ id, name, kind, text, warnings }) => ({
        sourceId: id,
        name,
        kind: sourceKindLabels[kind],
        text,
        warnings,
      })),
    ...extra,
  });
  if (input.length > 240000) {
    throw new StudioEngineError(
      "AI_INPUT_TOO_LARGE",
      "AI 분석 자료가 너무 큽니다. 중복 자료를 줄이거나 필요한 부분을 발췌해 총 24만 자 이내로 정리해 주세요.",
      413,
    );
  }
  return input;
}

export const planSemanticReviewSchema = z.object({ findings: z.array(reviewSchema).max(12) });

export function executionDigest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function requestFormat<T>(schema: z.ZodType<T>, name: string) {
  // Keep only the wire format; SDK parser functions are not request bytes.
  return JSON.parse(
    JSON.stringify(zodTextFormat(schema, name)),
  ) as EngineExecutionTransportRequest["body"]["text"]["format"];
}
/** No configuration, credentials, company storage or provider IO is read here. */
export function getPlanExecutionContract(): EngineExecutionContract {
  return engineExecutionContractSchema.parse(
    getPlanExecutionContractForVersion("plan-observation-v1"),
  );
}

export type VersionedPlanExecutionContract = Omit<EngineExecutionContract, "engineVersion"> & {
  engineVersion: PlanPromptVersion;
};

/** Pure preparation only. This does not enable a version in any execution/approval path. */
export function getPlanExecutionContractForVersion(
  version: PlanPromptVersion,
): VersionedPlanExecutionContract {
  const definition = getPlanPromptDefinition(version);
  const phases = [
    {
      phase: "generation" as const,
      name: "business_plan",
      instruction: definition.generationInstruction,
      format: definition.generationFormat,
    },
    {
      phase: "review" as const,
      name: "business_plan_review",
      instruction: definition.reviewInstruction,
      format: definition.reviewFormat,
    },
  ].map(({ phase, name, instruction, format }) => ({
    phase,
    name,
    systemDigest: executionDigest(definition.systemPrompt),
    instructionDigest: executionDigest(instruction),
    schemaDigest: executionDigest(format),
  }));
  const contract = {
    schemaVersion: 1 as const,
    engineVersion: definition.engineVersion,
    provider: "OpenAI" as const,
    endpoint: "https://api.openai.com/v1" as const,
    maxCalls: 2 as const,
    maxInputChars: 240000 as const,
    maxOutputTokens: 16000 as const,
    timeoutMs: 120000 as const,
    maxRetries: 0 as const,
    store: false as const,
    repair: false as const,
    phases,
  };
  return {
    ...contract,
    contractDigest: executionDigest(contract),
  };
}

export type EnginePlanPreparedRequest = {
  body: EngineExecutionTransportRequest["body"];
  requestDigest: string;
  /** System and user content only; excludes schema and provider overhead. Not a token estimate. */
  inputChars: number;
  phase: EngineExecutionPhase;
  contractDigest: string;
};
export type EnginePlanReviewTemplate = {
  schemaVersion: 1;
  phase: "review";
  complete: false;
  model: string;
  store: false;
  max_output_tokens: 16000;
  systemMessage: { role: "system"; content: string };
  format: EngineExecutionTransportRequest["body"]["text"]["format"];
  fixedUserContext: Record<string, unknown>;
  draftSlot: {
    jsonPath: "$.draft";
    rule: "this-run-validated-generation-only";
    requiresValidatedEventBinding: true;
  };
  contractDigest: string;
  templateDigest: string;
};

function requireModel(model: string) {
  if (typeof model !== "string" || !model || model.trim() !== model || model.length > 200)
    throw new StudioEngineError(
      "AI_EXECUTION_SCOPE_CHANGED",
      "AI 실행 출처와 승인 범위를 확인해 주세요.",
      502,
    );
}

function buildRequest(
  version: PlanPromptVersion,
  phase: EngineExecutionPhase,
  input: string,
  model: string,
): EnginePlanPreparedRequest {
  requireModel(model);
  const definition = getPlanPromptDefinition(version);
  const contract = getPlanExecutionContractForVersion(version);
  const generation = phase === "generation";
  const instruction = generation ? definition.generationInstruction : definition.reviewInstruction;
  const body: EngineExecutionTransportRequest["body"] = {
    model,
    store: false,
    max_output_tokens: 16000,
    input: [
      { role: "system", content: `${definition.systemPrompt}\n\n${instruction}` },
      { role: "user", content: input },
    ],
    text: {
      format: generation ? definition.generationFormat : definition.reviewFormat,
    },
  };
  const inputChars = body.input.reduce((sum, message) => sum + message.content.length, 0);
  if (inputChars > contract.maxInputChars)
    throw new StudioEngineError(
      "AI_INPUT_TOO_LARGE",
      "AI 요청 입력이 승인한 문자 한도를 초과했습니다.",
      502,
    );
  return {
    body,
    requestDigest: executionDigest(body),
    inputChars,
    phase,
    contractDigest: contract.contractDigest,
  };
}

/** Exact wire request. Does not read model configuration, keys, files, storage, or provider IO. */
export function buildPlanGenerationRequest(
  value: StudioCase,
  candidate: Candidate,
  model: string,
): EnginePlanPreparedRequest {
  return buildPlanGenerationRequestForVersion("plan-observation-v1", value, candidate, model);
}

export function buildPlanGenerationRequestForVersion(
  version: PlanPromptVersion,
  value: StudioCase,
  candidate: Candidate,
  model: string,
): EnginePlanPreparedRequest {
  return buildRequest(
    version,
    "generation",
    aiInput(value, {
      selectedCandidate: { ...candidate, classification: getCandidateClassification(candidate) },
      sectionDefinitions,
    }),
    model,
  );
}

/**
 * The caller must bind this value to its own generation domain-validation event.
 * A PlanContent object alone cannot establish same-run provenance. Never pass a final
 * semantic-review-modified plan, another run's plan, or a repaired plan here.
 */
export function buildPlanReviewRequest(
  value: StudioCase,
  candidate: Candidate,
  validatedGeneration: PlanContent,
  model: string,
): EnginePlanPreparedRequest {
  return buildPlanReviewRequestForVersion(
    "plan-observation-v1",
    value,
    candidate,
    validatedGeneration,
    model,
  );
}

/** The caller still owns same-run validation provenance; a draft has no version authority. */
export function buildPlanReviewRequestForVersion(
  version: PlanPromptVersion,
  value: StudioCase,
  candidate: Candidate,
  validatedGeneration: PlanContent,
  model: string,
): EnginePlanPreparedRequest {
  if (!planContentSchema.safeParse(validatedGeneration).success)
    throw new StudioEngineError(
      "AI_INVALID_PLAN",
      "검증된 최초 생성 원고가 없어 검토 요청을 준비할 수 없습니다.",
      502,
    );
  // Preserve the validated object's JSON insertion order; schema parsing here must not rewrite it.
  return buildRequest(
    version,
    "review",
    aiInput(value, { selectedCandidate: candidate, draft: validatedGeneration }),
    model,
  );
}

/** Incomplete review template. No finished request body, request digest, or invented draft. */
export function buildPlanReviewTemplate(
  value: StudioCase,
  candidate: Candidate,
  model: string,
): EnginePlanReviewTemplate {
  return buildPlanReviewTemplateForVersion("plan-observation-v1", value, candidate, model);
}

/** No completed review request, dispatch permission, or provider configuration is created. */
export function buildPlanReviewTemplateForVersion(
  version: PlanPromptVersion,
  value: StudioCase,
  candidate: Candidate,
  model: string,
): EnginePlanReviewTemplate {
  requireModel(model);
  const definition = getPlanPromptDefinition(version);
  const template: Omit<EnginePlanReviewTemplate, "templateDigest"> = {
    schemaVersion: 1,
    phase: "review",
    complete: false,
    model,
    store: false,
    max_output_tokens: 16000,
    systemMessage: {
      role: "system",
      content: `${definition.systemPrompt}\n\n${definition.reviewInstruction}`,
    },
    format: definition.reviewFormat,
    fixedUserContext: JSON.parse(aiInput(value, { selectedCandidate: candidate })),
    draftSlot: {
      jsonPath: "$.draft",
      rule: "this-run-validated-generation-only",
      requiresValidatedEventBinding: true,
    },
    contractDigest: getPlanExecutionContractForVersion(version).contractDigest,
  };
  return { ...template, templateDigest: executionDigest(template) };
}
