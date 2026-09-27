import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const actual = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Actual provider forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      actual();
    }
  },
}));
import { generateObservedPlan, getPlanExecutionContract } from "./studio-engine";
import { createPlanQualityFixtures } from "./studio-plan-quality-fixtures";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  engineExecutionRequestSchema,
  engineExecutionResponseSchema,
  engineExecutionValidatedSchema,
  type EngineExecutionOptions,
  type EngineExecutionHooks,
  type EngineExecutionTransportRequest,
  type EngineExecutionValidated,
} from "./studio-engine-execution-types";

const fixture = () => createPlanQualityFixtures()[0];
function response(output: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "mock-response",
    _request_id: "mock-request",
    model: "mock-returned-model",
    status: "completed",
    usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    ...overrides,
  };
}
function setup() {
  const value = fixture();
  const calls: string[] = [];
  const transport = vi.fn(async (request: EngineExecutionTransportRequest) => {
    calls.push(`${request.request.phase}:transport`);
    return response(request.request.phase === "generation" ? value.plan : { findings: [] });
  });
  const hooks = {
    onDispatch: vi.fn<EngineExecutionHooks["onDispatch"]>((event) => {
      calls.push(`${event.phase}:dispatch`);
    }),
    onResponse: vi.fn<EngineExecutionHooks["onResponse"]>((event) => {
      calls.push(`${event.request.phase}:response`);
    }),
    onValidated: vi.fn<EngineExecutionHooks["onValidated"]>((event) => {
      calls.push(`${event.request.phase}:validated`);
    }),
  };
  const options: EngineExecutionOptions = {
    mode: "mock",
    model: "venturepass-synthetic-plan-v1",
    contractDigest: getPlanExecutionContract().contractDigest,
    transport,
    hooks,
  };
  return {
    value,
    calls,
    transport,
    hooks,
    options,
    run: () => generateObservedPlan(value.company, value.candidate, options),
  };
}
let savedEnvironment: NodeJS.ProcessEnv;
beforeEach(() => {
  actual.mockClear();
  savedEnvironment = process.env;
  process.env = new Proxy(savedEnvironment, {
    get(target, name, receiver) {
      if (typeof name === "string" && name.startsWith("OPENAI"))
        throw new Error("Credential/config access forbidden");
      return Reflect.get(target, name, receiver);
    },
  });
});
afterEach(() => {
  process.env = savedEnvironment;
  expect(actual).not.toHaveBeenCalled();
});

describe("bounded engine execution observation", () => {
  it("pins stable instruction/schema contract without credentials or provider access", () => {
    const contract = getPlanExecutionContract(),
      { contractDigest, ...payload } = contract;
    expect(contractDigest).toBe(digest(payload));
    expect(contract).toMatchObject({
      maxCalls: 2,
      maxInputChars: 240000,
      maxOutputTokens: 16000,
      maxRetries: 0,
      repair: false,
      store: false,
      endpoint: "https://api.openai.com/v1",
    });
    expect(contract.phases.map((phase) => phase.phase)).toEqual(["generation", "review"]);
    expect(getPlanExecutionContract()).toEqual(contract);
  });
  it("observes dispatch then response then domain-validated output for exactly two calls", async () => {
    const state = setup(),
      result = await state.run();
    expect(state.calls).toEqual([
      "generation:dispatch",
      "generation:transport",
      "generation:response",
      "generation:validated",
      "review:dispatch",
      "review:transport",
      "review:response",
      "review:validated",
    ]);
    expect(result.content.sections).toHaveLength(10);
    expect(result.semanticReview).toEqual([]);
    for (const [wire] of state.transport.mock.calls) {
      expect(wire.request.requestDigest).toBe(digest(wire.body));
      expect(wire.request.inputChars).toBe(
        wire.body.input.reduce((count, entry) => count + entry.content.length, 0),
      );
      expect(wire.request).toMatchObject({ mode: "mock", provider: "mock" });
      expect(wire.body).toMatchObject({
        model: state.options.model,
        store: false,
        max_output_tokens: 16000,
      });
      expect(engineExecutionRequestSchema.parse(wire.request)).toEqual(wire.request);
    }
    for (const [event] of state.hooks.onResponse.mock.calls)
      expect(engineExecutionResponseSchema.parse(event)).toEqual(event);
    for (const [event] of state.hooks.onValidated.mock.calls) {
      expect(engineExecutionValidatedSchema.parse(event)).toEqual(event);
      expect(event.outputDigest).toBe(digest(event.output));
    }
  });
  it("keeps mocked provenance despite real-looking model and response IDs", async () => {
    const state = setup();
    state.transport.mockImplementation(async (request) =>
      response(request.request.phase === "generation" ? state.value.plan : { findings: [] }, {
        id: "resp_claimed-real",
        model: "claimed-real-model",
        mode: "actual-ai",
        provider: "OpenAI",
      }),
    );
    await state.run();
    expect(state.hooks.onResponse.mock.calls[0][0]).toMatchObject({
      responseId: "resp_claimed-real",
      responseModel: "claimed-real-model",
      request: { mode: "mock", provider: "mock" },
    });
    expect(
      engineExecutionRequestSchema.safeParse({
        ...state.transport.mock.calls[0][0].request,
        mode: "actual-ai",
      }).success,
    ).toBe(false);
  });
  it.each(["contract", "mode", "transport"])(
    "rejects changed %s scope before provider dispatch",
    async (kind) => {
      const state = setup();
      if (kind === "contract") state.options.contractDigest = "0".repeat(64);
      if (kind === "mode") Object.assign(state.options, { mode: "assisted" });
      if (kind === "transport") Object.assign(state.options, { mode: "actual-ai" });
      await expect(state.run()).rejects.toMatchObject({ code: "AI_EXECUTION_SCOPE_CHANGED" });
      expect(state.hooks.onDispatch).not.toHaveBeenCalled();
      expect(state.transport).not.toHaveBeenCalled();
    },
  );
  it.each(["onDispatch", "onResponse", "onValidated"] as const)(
    "awaits and propagates %s persistence failure unchanged",
    async (hook) => {
      const state = setup(),
        failure = new Error("synthetic durable store unavailable");
      state.hooks[hook].mockImplementationOnce(async () => {
        await Promise.resolve();
        throw failure;
      });
      await expect(state.run()).rejects.toBe(failure);
      expect(state.transport).toHaveBeenCalledTimes(hook === "onDispatch" ? 0 : 1);
      expect(state.hooks.onDispatch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["malformed-json", "schema", "sections", "evidence", "guarantee"])(
    "records receipt before rejecting %s generation output",
    async (kind) => {
      const state = setup(),
        plan = structuredClone(state.value.plan);
      if (kind === "sections") plan.sections.pop();
      if (kind === "evidence") plan.sections[0].evidence[0].quote = "source does not contain this";
      if (kind === "guarantee") plan.summary = "벤처확인 100% 승인 보장";
      const raw = response(kind === "schema" ? { unexpected: true } : plan);
      if (kind === "malformed-json") raw.output[0].content[0].text = "{invalid";
      state.transport.mockResolvedValueOnce(raw);
      await expect(state.run()).rejects.toMatchObject({ name: "StudioEngineError" });
      expect(state.calls).toEqual(["generation:dispatch", "generation:response"]);
      expect(state.transport).toHaveBeenCalledTimes(1);
      expect(state.hooks.onValidated).not.toHaveBeenCalled();
    },
  );
  it("refuses invalid independent-review source after preserving its response metadata", async () => {
    const state = setup();
    state.transport.mockResolvedValueOnce(response(state.value.plan)).mockResolvedValueOnce(
      response({
        findings: [
          {
            id: "review-1",
            severity: "warning",
            category: "semantic-evidence",
            sectionKey: "problem",
            message: "합성 검토",
            action: "합성 확인",
            sourceIds: ["nonexistent-source"],
          },
        ],
      }),
    );
    await expect(state.run()).rejects.toMatchObject({ code: "AI_INVALID_REVIEW" });
    expect(state.hooks.onResponse).toHaveBeenCalledTimes(2);
    expect(state.hooks.onValidated).toHaveBeenCalledTimes(1);
  });
  it("redacts transport errors, leaves dispatch without receipt, and never retries", async () => {
    const state = setup();
    state.transport.mockRejectedValue(new Error("RAW PRIVATE UPSTREAM PAYLOAD"));
    await expect(state.run()).rejects.toMatchObject({ code: "AI_REQUEST_FAILED" });
    await expect(Promise.resolve(state.hooks.onResponse.mock.calls)).resolves.toEqual([]);
    expect(state.transport).toHaveBeenCalledTimes(1);
    expect(state.hooks.onValidated).not.toHaveBeenCalled();
  });
  it("freezes detached dispatch, transport and validated payloads against mutation", async () => {
    const state = setup();
    state.hooks.onDispatch.mockImplementation((event) => {
      expect(() => {
        event.configuredModel = "forged";
      }).toThrow();
    });
    state.transport.mockImplementation(async (wire) => {
      expect(() => {
        wire.body.model = "forged";
      }).toThrow();
      expect(() => {
        wire.body.input[1].content = "forged";
      }).toThrow();
      expect(() => {
        wire.request.mode = "actual-ai";
      }).toThrow();
      return response(wire.request.phase === "generation" ? state.value.plan : { findings: [] });
    });
    state.hooks.onValidated.mockImplementation((event) => {
      if (event.output.kind === "plan") {
        const content = event.output.content;
        expect(() => {
          content.title = "forged";
        }).toThrow();
      }
    });
    const result = await state.run();
    expect(result.content.title).toBe(state.value.plan.title);
    expect(state.transport.mock.calls[1][0].body.model).toBe(state.options.model);
  });
  it("pins caller input/options and raw response while asynchronous hooks wait", async () => {
    const state = setup(),
      originalModel = state.options.model;
    state.hooks.onDispatch.mockImplementationOnce(async () => {
      state.value.company.profile.companyName = "CALLER MUTATED";
      state.value.candidate.title = "MUTATED";
      state.options.model = "changed";
      state.options.hooks.onResponse = () => {
        throw new Error("changed callback");
      };
    });
    await state.run();
    expect(state.transport.mock.calls[1][0].body.model).toBe(originalModel);
    expect(state.transport.mock.calls[0][0].body.input[1].content).not.toContain("CALLER MUTATED");
  });
  it("records unknown metadata as null and does not infer zero usage", async () => {
    const state = setup();
    state.transport.mockImplementation(async (wire) =>
      response(wire.request.phase === "generation" ? state.value.plan : { findings: [] }, {
        id: undefined,
        _request_id: undefined,
        model: undefined,
        usage: undefined,
      }),
    );
    await state.run();
    expect(state.hooks.onResponse.mock.calls[0][0]).toMatchObject({
      responseId: null,
      requestId: null,
      responseModel: null,
      usage: null,
    });
  });
  it("captures response before a receipt hook can mutate the transport's retained object", async () => {
    const state = setup(),
      raw = response(state.value.plan);
    state.transport.mockResolvedValueOnce(raw);
    state.hooks.onResponse.mockImplementationOnce(async () => {
      raw.output[0].content[0].text = "invalid after receipt";
      raw.id = "changed";
      await Promise.resolve();
    });
    const result = await state.run();
    expect(result.content.title).toBe(state.value.plan.title);
    expect(state.hooks.onResponse.mock.calls[0][0].responseId).toBe("mock-response");
  });
  it("does not accept inconsistent provider token totals as known usage", async () => {
    const state = setup();
    state.transport.mockResolvedValueOnce(
      response(state.value.plan, {
        usage: { input_tokens: 12, output_tokens: 20, total_tokens: 0 },
      }),
    );
    await state.run();
    expect(state.hooks.onResponse.mock.calls[0][0].usage).toBeNull();
  });
  it("stops before oversized request and never treats guard calls as dispatch receipts", async () => {
    const state = setup(),
      guard = vi.fn();
    state.options.beforeRequest = guard;
    state.value.company.sources[0].text = "가".repeat(240001);
    await expect(state.run()).rejects.toMatchObject({ code: "AI_INPUT_TOO_LARGE" });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(state.hooks.onDispatch).not.toHaveBeenCalled();
    expect(state.transport).not.toHaveBeenCalled();
  });
  it("uses review findings to preserve confirmation flags without performing repair", async () => {
    const state = setup();
    state.transport.mockResolvedValueOnce(response(state.value.plan)).mockResolvedValueOnce(
      response({
        findings: [
          {
            id: "review-1",
            severity: "warning",
            category: "fact-vs-plan",
            sectionKey: "problem",
            message: "합성 검토 의견",
            action: "자료와 대조해 주세요",
            sourceIds: [state.value.company.sources[0].id],
          },
        ],
      }),
    );
    const validated: EngineExecutionValidated[] = [];
    state.hooks.onValidated.mockImplementation((event) => {
      validated.push(event);
    });
    const result = await state.run();
    expect(result.content.sections[0].needsConfirmation).toBe(true);
    expect(result.semanticReview).toHaveLength(1);
    expect(validated.map((event) => event.output.kind)).toEqual(["plan", "review"]);
    expect(state.transport).toHaveBeenCalledTimes(2);
  });
});
