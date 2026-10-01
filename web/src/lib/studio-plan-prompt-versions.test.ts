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
import { generateObservedPlan } from "./studio-engine";
import { engineExecutionContractSchema } from "./studio-engine-execution-types";
import {
  buildPlanGenerationRequest,
  buildPlanGenerationRequestForVersion,
  buildPlanReviewRequest,
  buildPlanReviewRequestForVersion,
  buildPlanReviewTemplate,
  buildPlanReviewTemplateForVersion,
  executionDigest,
  getPlanExecutionContract,
  getPlanExecutionContractForVersion,
  planSemanticReviewSchema,
  requestFormat,
} from "./studio-engine-request-preparation";
import { getPlanPromptDefinition, type PlanPromptVersion } from "./studio-plan-prompt-versions";
import { createPlanQualityFixtures } from "./studio-plan-quality-fixtures";
import { planContentSchema, type PlanContent } from "./studio-schema";

const v1 = "plan-observation-v1";
const v2 = "plan-observation-v2";
const model = "venturepass-synthetic-plan-v1";
const fixture = () => createPlanQualityFixtures()[0];
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  provider.mockClear();
  environment = process.env;
  process.env = new Proxy(environment, {
    get(target, name, receiver) {
      if (typeof name === "string" && /^(OPENAI|VENTURE_)/.test(name))
        throw new Error("Configuration access forbidden");
      return Reflect.get(target, name, receiver);
    },
  });
});
afterEach(() => {
  process.env = environment;
  expect(provider).not.toHaveBeenCalled();
});

describe("versioned plan preparation without execution activation", () => {
  it("keeps every legacy entrypoint pinned to the explicit v1 snapshot", () => {
    const { company, candidate, plan } = fixture();
    expect(getPlanExecutionContract()).toEqual(getPlanExecutionContractForVersion(v1));
    expect(buildPlanGenerationRequest(company, candidate, model)).toEqual(
      buildPlanGenerationRequestForVersion(v1, company, candidate, model),
    );
    expect(buildPlanReviewRequest(company, candidate, plan, model)).toEqual(
      buildPlanReviewRequestForVersion(v1, company, candidate, plan, model),
    );
    expect(buildPlanReviewTemplate(company, candidate, model)).toEqual(
      buildPlanReviewTemplateForVersion(v1, company, candidate, model),
    );
    expect(getPlanPromptDefinition(v1).generationFormat).toEqual(
      requestFormat(planContentSchema, "business_plan"),
    );
    expect(getPlanPromptDefinition(v1).reviewFormat).toEqual(
      requestFormat(planSemanticReviewSchema, "business_plan_review"),
    );
  });

  it("binds both revised instructions to a distinct contract while preserving wire schema and limits", () => {
    const oldContract = getPlanExecutionContractForVersion(v1);
    const revised = getPlanExecutionContractForVersion(v2);
    const { contractDigest, ...payload } = revised;
    expect(contractDigest).toBe("bb7dcb203e8ef0c41450df04778f3dec22b4dd18835fdf592974752b32322f22");
    expect(contractDigest).toBe(executionDigest(payload));
    expect(revised).toMatchObject({
      engineVersion: v2,
      maxCalls: 2,
      maxInputChars: 240000,
      maxOutputTokens: 16000,
      timeoutMs: 120000,
      maxRetries: 0,
      store: false,
      repair: false,
    });
    for (const [index, phase] of revised.phases.entries()) {
      expect(phase.schemaDigest).toBe(oldContract.phases[index].schemaDigest);
      expect(phase.systemDigest).not.toBe(oldContract.phases[index].systemDigest);
      expect(phase.instructionDigest).not.toBe(oldContract.phases[index].instructionDigest);
    }
    const { company, candidate, plan } = fixture();
    for (const [oldRequest, newRequest] of [
      [
        buildPlanGenerationRequest(company, candidate, model),
        buildPlanGenerationRequestForVersion(v2, company, candidate, model),
      ],
      [
        buildPlanReviewRequest(company, candidate, plan, model),
        buildPlanReviewRequestForVersion(v2, company, candidate, plan, model),
      ],
    ]) {
      expect(newRequest.contractDigest).toBe(contractDigest);
      expect(newRequest.requestDigest).toBe(executionDigest(newRequest.body));
      expect(newRequest.requestDigest).not.toBe(oldRequest.requestDigest);
      expect(newRequest.body.text).toEqual(oldRequest.body.text);
      expect(newRequest.body.input[1]).toEqual(oldRequest.body.input[1]);
      expect(newRequest.inputChars).toBe(
        newRequest.body.input.reduce((sum, message) => sum + message.content.length, 0),
      );
      const changed = structuredClone(newRequest.body);
      changed.input[0].content += "가";
      expect(executionDigest(changed)).not.toBe(newRequest.requestDigest);
    }
  });

  it.each([undefined, null, "", "__proto__", "plan-observation-v3", {}, 2])(
    "rejects unsupported version %j instead of falling back",
    (unknownVersion) => {
      const version = unknownVersion as PlanPromptVersion;
      const { company, candidate, plan } = fixture();
      for (const call of [
        () => getPlanPromptDefinition(version),
        () => getPlanExecutionContractForVersion(version),
        () => buildPlanGenerationRequestForVersion(version, company, candidate, model),
        () => buildPlanReviewRequestForVersion(version, company, candidate, plan, model),
        () => buildPlanReviewTemplateForVersion(version, company, candidate, model),
      ])
        expect(call).toThrowError("Unsupported plan prompt version");
    },
  );

  it.each([v1, v2] as const)(
    "isolates returned definitions, contracts and request objects for %s",
    (version) => {
      const value = fixture();
      const original = structuredClone(value);
      const definition = getPlanPromptDefinition(version);
      const expected = structuredClone(definition);
      definition.systemPrompt += "changed";
      definition.generationFormat.schema.changed = true;
      definition.reviewFormat.schema.changed = true;
      const contract = getPlanExecutionContractForVersion(version);
      const originalContract = structuredClone(contract);
      contract.phases[0].instructionDigest = "changed";
      const request = buildPlanGenerationRequestForVersion(
        version,
        value.company,
        value.candidate,
        model,
      );
      request.body.text.format.schema.changed = true;
      const template = buildPlanReviewTemplateForVersion(
        version,
        value.company,
        value.candidate,
        model,
      );
      template.fixedUserContext.profile = { companyName: "changed" };
      template.format.schema.changed = true;
      expect(getPlanPromptDefinition(version)).toEqual(expected);
      expect(getPlanExecutionContractForVersion(version)).toEqual(originalContract);
      expect(
        buildPlanGenerationRequestForVersion(version, value.company, value.candidate, model).body
          .text.format,
      ).toEqual(expected.generationFormat);
      expect(
        buildPlanReviewTemplateForVersion(version, value.company, value.candidate, model).format,
      ).toEqual(expected.reviewFormat);
      expect(value).toEqual(original);
    },
  );

  it("keeps the revised review incomplete until the original validated draft is supplied", () => {
    const { company, candidate, plan } = fixture();
    const reordered = Object.fromEntries(Object.entries(plan).reverse()) as PlanContent;
    const template = buildPlanReviewTemplateForVersion(v2, company, candidate, model);
    const request = buildPlanReviewRequestForVersion(v2, company, candidate, reordered, model);
    const { templateDigest, ...payload } = template;
    expect(templateDigest).toBe(executionDigest(payload));
    expect(template).toMatchObject({
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
    expect(template.contractDigest).toBe(request.contractDigest);
    expect(JSON.stringify({ ...template.fixedUserContext, draft: reordered })).toBe(
      request.body.input[1].content,
    );
    expect(template.contractDigest).not.toBe(
      buildPlanReviewTemplate(company, candidate, model).contractDigest,
    );
    expect(
      buildPlanReviewTemplateForVersion(v2, company, candidate, model + "x").templateDigest,
    ).not.toBe(templateDigest);
    expect(
      buildPlanReviewRequestForVersion(v2, company, candidate, reordered, model + "x")
        .requestDigest,
    ).not.toBe(request.requestDigest);
  });

  it("rejects v2 at the unchanged v1 execution gate before hooks or transport", async () => {
    const revised = getPlanExecutionContractForVersion(v2);
    expect(engineExecutionContractSchema.safeParse(revised).success).toBe(false);
    const { company, candidate } = fixture();
    const transport = vi.fn();
    const event = vi.fn();
    await expect(
      generateObservedPlan(company, candidate, {
        mode: "mock",
        model,
        contractDigest: revised.contractDigest,
        transport,
        hooks: { onDispatch: event, onResponse: event, onValidated: event },
      }),
    ).rejects.toMatchObject({ code: "AI_EXECUTION_SCOPE_CHANGED" });
    expect(transport).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
  });

  it("retains privacy and legacy classification behavior in revised requests", () => {
    const { company, candidate, plan } = fixture();
    delete candidate.classification;
    company.profile.businessNumber = "PRIVATE_BUSINESS";
    Object.assign(company.sources[0], { originalPath: "PRIVATE_PATH" });
    company.sources.push({
      ...company.sources[0],
      id: "pending",
      name: "PRIVATE_NAME",
      text: "PRIVATE_TEXT",
      extraction: "pending",
    });
    const generation = buildPlanGenerationRequestForVersion(v2, company, candidate, model);
    const template = buildPlanReviewTemplateForVersion(v2, company, candidate, model);
    const review = buildPlanReviewRequestForVersion(v2, company, candidate, plan, model);
    for (const prepared of [generation, template, review])
      expect(JSON.stringify(prepared)).not.toContain("PRIVATE_");
    expect(JSON.parse(generation.body.input[1].content)).toMatchObject({
      unextractedSourceCount: 1,
    });
    expect(JSON.parse(generation.body.input[1].content).selectedCandidate).toHaveProperty(
      "classification",
    );
    expect(template.fixedUserContext.selectedCandidate).not.toHaveProperty("classification");
  });

  it.each(["generation", "review"] as const)(
    "counts the revised full %s input and never truncates it",
    (phase) => {
      const { company, candidate, plan } = fixture();
      const prepare = () =>
        phase === "generation"
          ? buildPlanGenerationRequestForVersion(v2, company, candidate, model)
          : buildPlanReviewRequestForVersion(v2, company, candidate, plan, model);
      const initial = prepare();
      company.sources[0].text += "가".repeat(240000 - initial.inputChars);
      const exact = prepare();
      expect(exact.inputChars).toBe(240000);
      expect(exact.requestDigest).not.toBe(initial.requestDigest);
      expect(JSON.parse(exact.body.input[1].content).sources[0].text).toBe(company.sources[0].text);
      company.sources[0].text += "나";
      expect(prepare).toThrowError(expect.objectContaining({ code: "AI_INPUT_TOO_LARGE" }));
    },
  );

  it("does not invent a draft or default model for v2", () => {
    const { company, candidate } = fixture();
    expect(() =>
      buildPlanReviewRequestForVersion(v2, company, candidate, {} as PlanContent, model),
    ).toThrowError(expect.objectContaining({ code: "AI_INVALID_PLAN" }));
    expect(() => buildPlanGenerationRequestForVersion(v2, company, candidate, "")).toThrowError(
      expect.objectContaining({ code: "AI_EXECUTION_SCOPE_CHANGED" }),
    );
    expect(() => buildPlanReviewTemplateForVersion(v2, company, candidate, " ")).toThrowError(
      expect.objectContaining({ code: "AI_EXECUTION_SCOPE_CHANGED" }),
    );
  });
});
