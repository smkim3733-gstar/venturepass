import { z } from "zod";
import {
  planContentSchema,
  reviewSchema,
  type PlanContent,
  type ReviewFinding,
} from "./studio-schema";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const engineExecutionPhaseSchema = z.enum(["generation", "review"]);
export const engineExecutionContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    engineVersion: z.literal("plan-observation-v1"),
    provider: z.literal("OpenAI"),
    endpoint: z.literal("https://api.openai.com/v1"),
    maxCalls: z.literal(2),
    maxInputChars: z.literal(240000),
    maxOutputTokens: z.literal(16000),
    timeoutMs: z.literal(120000),
    maxRetries: z.literal(0),
    store: z.literal(false),
    repair: z.literal(false),
    phases: z
      .array(
        z
          .object({
            phase: engineExecutionPhaseSchema,
            name: z.string().min(1),
            systemDigest: hash,
            instructionDigest: hash,
            schemaDigest: hash,
          })
          .strict(),
      )
      .length(2),
    contractDigest: hash,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.phases[0].phase !== "generation" ||
      value.phases[0].name !== "business_plan" ||
      value.phases[1].phase !== "review" ||
      value.phases[1].name !== "business_plan_review" ||
      value.phases[0].systemDigest !== value.phases[1].systemDigest
    )
      context.addIssue({ code: "custom", message: "생성·검토 계약 단계가 일치하지 않습니다." });
  });
export const engineExecutionRequestSchema = z
  .object({
    phase: engineExecutionPhaseSchema,
    sequence: z.union([z.literal(1), z.literal(2)]),
    mode: z.enum(["mock", "actual-ai"]),
    provider: z.enum(["mock", "OpenAI"]),
    configuredModel: z.string().min(1).max(200),
    contractDigest: hash,
    requestDigest: hash,
    inputChars: z.number().int().nonnegative().max(240000),
    maxOutputTokens: z.literal(16000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.mode === "mock") !== (value.provider === "mock") ||
      value.sequence !== (value.phase === "generation" ? 1 : 2)
    )
      context.addIssue({ code: "custom", message: "실행 출처 또는 단계가 일치하지 않습니다." });
  });
const tokens = z.number().int().nonnegative().safe();
export const engineExecutionUsageSchema = z
  .object({
    inputTokens: tokens,
    outputTokens: tokens,
    totalTokens: tokens,
    cachedInputTokens: tokens.nullable(),
    reasoningOutputTokens: tokens.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.totalTokens !== value.inputTokens + value.outputTokens ||
      (value.cachedInputTokens !== null && value.cachedInputTokens > value.inputTokens) ||
      (value.reasoningOutputTokens !== null && value.reasoningOutputTokens > value.outputTokens)
    )
      context.addIssue({ code: "custom", message: "보고된 토큰 사용량이 일치하지 않습니다." });
  });
export const engineExecutionResponseSchema = z
  .object({
    request: engineExecutionRequestSchema,
    responseId: z.string().max(500).nullable(),
    requestId: z.string().max(500).nullable(),
    responseModel: z.string().max(200).nullable(),
    status: z.string().max(100).nullable(),
    usage: engineExecutionUsageSchema.nullable(),
  })
  .strict();
export const engineExecutionOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), content: planContentSchema }).strict(),
  z.object({ kind: z.literal("review"), findings: z.array(reviewSchema).max(12) }).strict(),
]);
export const engineExecutionValidatedSchema = z
  .object({
    request: engineExecutionRequestSchema,
    outputDigest: hash,
    output: engineExecutionOutputSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.request.phase === "generation") !== (value.output.kind === "plan"))
      context.addIssue({ code: "custom", message: "검증 출력과 실행 단계가 다릅니다." });
  });
export type EngineExecutionPhase = z.infer<typeof engineExecutionPhaseSchema>;
export type EngineExecutionContract = z.infer<typeof engineExecutionContractSchema>;
export type EngineExecutionRequest = z.infer<typeof engineExecutionRequestSchema>;
export type EngineExecutionResponse = z.infer<typeof engineExecutionResponseSchema>;
export type EngineExecutionValidated = z.infer<typeof engineExecutionValidatedSchema>;
export type EngineExecutionOutput = z.infer<typeof engineExecutionOutputSchema>;
/** JSON request only. No key, client object, or reviewer-only candidate metadata. */
export type EngineExecutionTransportRequest = {
  request: EngineExecutionRequest;
  body: {
    model: string;
    store: false;
    max_output_tokens: 16000;
    input: { role: "system" | "user"; content: string }[];
    text: {
      format: { type: "json_schema"; name: string; strict: true; schema: Record<string, unknown> };
    };
  };
};
export type EngineExecutionJson =
  null | boolean | number | string | EngineExecutionJson[] | { [key: string]: EngineExecutionJson };
/** Allowlisted SDK JSON fields, not HTTP bytes, headers, client, or upstream errors. */
export type EngineExecutionCapturedResponse = {
  id?: EngineExecutionJson;
  _request_id?: EngineExecutionJson;
  model?: EngineExecutionJson;
  status?: EngineExecutionJson;
  usage?: EngineExecutionJson;
  output: EngineExecutionJson[];
};
export type EngineExecutionResponseCaptured = {
  metadata: EngineExecutionResponse;
  capturedResponse: EngineExecutionCapturedResponse;
};
export type EngineExecutionHooks = {
  /** Awaited before dispatch; failure grants no transport permission. */
  onRequestPrepared?: (value: EngineExecutionTransportRequest) => void | Promise<void>;
  onDispatch: (value: EngineExecutionRequest) => void | Promise<void>;
  /** Awaited before legacy onResponse and output validation; failure is propagated unchanged. */
  onResponseCaptured?: (value: EngineExecutionResponseCaptured) => void | Promise<void>;
  /** Metadata-only legacy hook; may still run when capturing raw JSON fails. */
  onResponse: (value: EngineExecutionResponse) => void | Promise<void>;
  onValidated: (value: EngineExecutionValidated) => void | Promise<void>;
};
type EngineExecutionBase = {
  model: string;
  contractDigest: string;
  hooks: EngineExecutionHooks;
  beforeRequest?: () => void;
};
export type EngineExecutionOptions = EngineExecutionBase &
  (
    | { mode: "mock"; transport: (value: EngineExecutionTransportRequest) => Promise<unknown> }
    | { mode: "actual-ai"; transport?: never }
  );
export type EngineExecutionResult = {
  content: PlanContent;
  review: ReviewFinding[];
  semanticReview: ReviewFinding[];
  contractDigest: string;
};
