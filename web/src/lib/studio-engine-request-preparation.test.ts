import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const provider = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Provider forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      provider();
    }
  },
}));
import {
  generateObservedPlan,
  getPlanExecutionContract as legacyContract,
  StudioEngineError as LegacyEngineError,
} from "./studio-engine";
import {
  buildPlanGenerationRequest,
  buildPlanReviewRequest,
  buildPlanReviewTemplate,
  executionDigest,
  getPlanExecutionContract,
  planGenerationInstruction,
  planReviewInstruction,
  StudioEngineError,
  systemPrompt,
} from "./studio-engine-request-preparation";
import { createPlanQualityFixtures } from "./studio-plan-quality-fixtures";
import type {
  EngineExecutionTransportRequest,
  EngineExecutionValidated,
} from "./studio-engine-execution-types";
import type { PlanContent } from "./studio-schema";

const model = "venturepass-synthetic-plan-v1";
const fixture = () => createPlanQualityFixtures()[0];
const byteDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
let savedEnvironment: NodeJS.ProcessEnv;
beforeEach(() => {
  provider.mockClear();
  savedEnvironment = process.env;
  process.env = new Proxy(savedEnvironment, {
    get(target, name, receiver) {
      if (typeof name === "string" && name.startsWith("OPENAI"))
        throw new Error("Configuration access forbidden");
      return Reflect.get(target, name, receiver);
    },
  });
});
afterEach(() => {
  process.env = savedEnvironment;
  expect(provider).not.toHaveBeenCalled();
});

async function observe(value = fixture(), findings: unknown[] = []) {
  const calls: EngineExecutionTransportRequest[] = [];
  const validated: EngineExecutionValidated[] = [];
  const result = await generateObservedPlan(value.company, value.candidate, {
    mode: "mock",
    model,
    contractDigest: getPlanExecutionContract().contractDigest,
    hooks: {
      onDispatch: () => {},
      onResponse: () => {},
      onValidated: (event) => {
        validated.push(event);
      },
    },
    transport: async (request) => {
      calls.push(request);
      return {
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(
                  request.request.phase === "generation" ? value.plan : { findings },
                ),
              },
            ],
          },
        ],
      };
    },
  });
  return { calls, validated, result };
}

describe("pure plan request preparation", () => {
  it("preserves pre-extraction observed contract and exact wire JSON bytes", async () => {
    const value = fixture();
    const { calls, validated } = await observe(value);
    // Captured from the original engine before extraction. Includes user JSON insertion order.
    expect({
      contract: getPlanExecutionContract().contractDigest,
      calls: calls.map(({ request, body }) => ({
        phase: request.phase,
        digest: request.requestDigest,
        bytesDigest: byteDigest(body),
        chars: request.inputChars,
      })),
    }).toEqual({
      contract: "2f4015241c339f873d513f92606c852b1f181c5e2f7babcac325d48e8d512bcc",
      calls: [
        {
          phase: "generation",
          digest: "26936e790fba2995aa7666d57d850eef7e9d51c1cc922f621ed4afb34cb96a9f",
          bytesDigest: "76db2cc138fa313b3768d8c3849de0934d988da958f2292fc8a772f5ef089d41",
          chars: 5885,
        },
        {
          phase: "review",
          digest: "918875ddc95b15c6598c4aa0ba0d1d0539c1bf10d5532dbe4d78f20911b6d2a0",
          bytesDigest: "1a3c7535554ee6dd84ccb437c5b22e3c6764d4bf631fc75638c31f99ba53e597",
          chars: 8545,
        },
      ],
    });
    expect(legacyContract()).toEqual(getPlanExecutionContract());
    expect(LegacyEngineError).toBe(StudioEngineError);
    const generation = validated[0].output;
    if (generation.kind !== "plan") throw new Error("Generation missing");
    const prepared = [
      buildPlanGenerationRequest(value.company, value.candidate, model),
      buildPlanReviewRequest(value.company, value.candidate, generation.content, model),
    ];
    for (const [index, entry] of prepared.entries()) {
      expect(JSON.stringify(entry.body)).toBe(JSON.stringify(calls[index].body));
      expect(entry.requestDigest).toBe(calls[index].request.requestDigest);
      expect(entry.inputChars).toBe(calls[index].request.inputChars);
    }
  });

  it("binds review to the domain-validated initial draft, before semantic follow-up changes", async () => {
    const value = fixture();
    value.plan.sections[0].title = "임시 원고 표제";
    const { calls, validated, result } = await observe(value, [
      {
        id: "synthetic-follow-up",
        severity: "warning",
        category: "semantic-evidence",
        sectionKey: "problem",
        message: "합성 검토에서 고객 문제와 제안 내용 연결을 확인해야 합니다.",
        action: "자료에 기재된 범위와 대조해 주세요.",
        sourceIds: [value.company.sources[0].id],
      },
    ]);
    const event = validated[0].output;
    if (event.kind !== "plan") throw new Error("Generation missing");
    expect(event.content.sections[0].title).not.toBe("임시 원고 표제");
    expect(JSON.parse(calls[1].body.input[1].content).draft).toEqual(event.content);
    expect(event.content.actionItems).not.toEqual(result.content.actionItems);
    expect(
      buildPlanReviewRequest(value.company, value.candidate, event.content, model).body,
    ).toEqual(calls[1].body);
  });

  it("exposes an incomplete review template and exact fixed context, never an invented request", () => {
    const value = fixture();
    const template = buildPlanReviewTemplate(value.company, value.candidate, model);
    const request = buildPlanReviewRequest(value.company, value.candidate, value.plan, model);
    const { templateDigest, ...payload } = template;
    expect(templateDigest).toBe(executionDigest(payload));
    expect(template).toMatchObject({
      phase: "review",
      complete: false,
      draftSlot: {
        jsonPath: "$.draft",
        rule: "this-run-validated-generation-only",
        requiresValidatedEventBinding: true,
      },
    });
    expect(template).not.toHaveProperty("body");
    expect(template).not.toHaveProperty("requestDigest");
    expect(template.fixedUserContext).not.toHaveProperty("draft");
    expect(template.systemMessage).toEqual(request.body.input[0]);
    expect(template.format).toEqual(request.body.text.format);
    expect(JSON.stringify({ ...template.fixedUserContext, draft: value.plan })).toBe(
      request.body.input[1].content,
    );
    expect(template.systemMessage.content).toBe(`${systemPrompt}\n\n${planReviewInstruction}`);
    expect(
      buildPlanGenerationRequest(value.company, value.candidate, model).body.input[0].content,
    ).toBe(`${systemPrompt}\n\n${planGenerationInstruction}`);
  });

  it("keeps legacy classification distinction between generation and review", () => {
    const value = fixture();
    delete value.candidate.classification;
    const generation = buildPlanGenerationRequest(value.company, value.candidate, model);
    const review = buildPlanReviewTemplate(value.company, value.candidate, model);
    expect(JSON.parse(generation.body.input[1].content).selectedCandidate).toHaveProperty(
      "classification",
    );
    expect(review.fixedUserContext.selectedCandidate).not.toHaveProperty("classification");
  });

  it("includes only extracted source text and permitted profile context", () => {
    const value = fixture();
    value.company.profile.businessNumber = "PRIVATE_BUSINESS_NUMBER";
    Object.assign(value.company, { reviewerMetadata: "PRIVATE_REVIEWER_METADATA" });
    Object.assign(value.company.sources[0], {
      originalPath: "PRIVATE_ORIGINAL_PATH",
      originalFileName: "PRIVATE_ORIGINAL_FILE",
    });
    value.company.sources.push({
      ...value.company.sources[0],
      id: "pending-source",
      text: "PENDING_PRIVATE_TEXT",
      name: "PENDING_PRIVATE_NAME",
      extraction: "pending",
    });
    const generation = buildPlanGenerationRequest(value.company, value.candidate, model);
    const template = buildPlanReviewTemplate(value.company, value.candidate, model);
    const review = buildPlanReviewRequest(value.company, value.candidate, value.plan, model);
    for (const prepared of [generation, template, review])
      expect(JSON.stringify(prepared)).not.toMatch(/PRIVATE_|PENDING_PRIVATE/);
    expect(JSON.parse(generation.body.input[1].content).unextractedSourceCount).toBe(1);
    expect(template.fixedUserContext.sources).toHaveLength(value.company.sources.length - 1);
  });

  it("hashes full model, content, schema and derivation rule while keeping returned objects isolated", () => {
    const value = fixture();
    const original = structuredClone(value);
    const generation = buildPlanGenerationRequest(value.company, value.candidate, model);
    const template = buildPlanReviewTemplate(value.company, value.candidate, model);
    expect(generation.requestDigest).toBe(executionDigest(generation.body));
    expect(
      buildPlanGenerationRequest(value.company, value.candidate, "explicit-other-model")
        .requestDigest,
    ).not.toBe(generation.requestDigest);
    expect(
      buildPlanReviewTemplate(value.company, value.candidate, "explicit-other-model")
        .templateDigest,
    ).not.toBe(template.templateDigest);
    generation.body.text.format.schema.changed = true;
    template.fixedUserContext.profile = { companyName: "changed" };
    const { templateDigest, ...templatePayload } = template;
    expect(executionDigest(templatePayload)).not.toBe(templateDigest);
    expect(
      buildPlanGenerationRequest(value.company, value.candidate, model).body.text.format.schema,
    ).not.toHaveProperty("changed");
    expect(value).toEqual(original);
    value.company.sources[0].text += "\n추가 합성 자료";
    expect(
      buildPlanGenerationRequest(value.company, value.candidate, model).requestDigest,
    ).not.toBe(generation.requestDigest);
  });

  it("enforces the complete input character boundary without truncation or pretending it is tokens", () => {
    const value = fixture();
    const original = buildPlanGenerationRequest(value.company, value.candidate, model);
    value.company.sources[0].text += "x".repeat(240000 - original.inputChars);
    const exact = buildPlanGenerationRequest(value.company, value.candidate, model);
    expect(exact.inputChars).toBe(240000);
    expect(exact).not.toHaveProperty("inputTokens");
    expect(exact.body.input.reduce((sum, item) => sum + item.content.length, 0)).toBe(240000);
    value.company.sources[0].text += "x";
    expect(() => buildPlanGenerationRequest(value.company, value.candidate, model)).toThrowError(
      expect.objectContaining({ code: "AI_INPUT_TOO_LARGE" }),
    );
    expect(() =>
      buildPlanReviewRequest(value.company, value.candidate, value.plan, model),
    ).toThrowError(expect.objectContaining({ code: "AI_INPUT_TOO_LARGE" }));
  });

  it.each(["", " leading", "trailing ", "x".repeat(201)])(
    "rejects an invalid explicit model without reading defaults: %s",
    (invalid) => {
      const value = fixture();
      for (const call of [
        () => buildPlanGenerationRequest(value.company, value.candidate, invalid),
        () => buildPlanReviewRequest(value.company, value.candidate, value.plan, invalid),
        () => buildPlanReviewTemplate(value.company, value.candidate, invalid),
      ])
        expect(call).toThrowError(expect.objectContaining({ code: "AI_EXECUTION_SCOPE_CHANGED" }));
    },
  );

  it("does not invent or normalize a missing/malformed review draft", () => {
    const value = fixture();
    expect(() =>
      buildPlanReviewRequest(value.company, value.candidate, null as unknown as PlanContent, model),
    ).toThrowError(expect.objectContaining({ code: "AI_INVALID_PLAN" }));
    expect(() =>
      buildPlanReviewRequest(value.company, value.candidate, {} as PlanContent, model),
    ).toThrowError(expect.objectContaining({ code: "AI_INVALID_PLAN" }));
  });
});
