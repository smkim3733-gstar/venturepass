import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const sdk = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Real provider forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      sdk();
    }
  },
}));
import { createServerPlanMockRunner, generateObservedPlan } from "./studio-engine";
import * as preparation from "./studio-engine-request-preparation";
import { getPlanPromptDefinition, type PlanPromptVersion } from "./studio-plan-prompt-versions";
import { createPlanQualityFixtures } from "./studio-plan-quality-fixtures";
import type {
  EngineExecutionOptions,
  EngineExecutionTransportRequest,
  EngineExecutionValidated,
} from "./studio-engine-execution-types";
import type { ReviewFinding } from "./studio-schema";

type MockOptions = Extract<EngineExecutionOptions, { mode: "mock" }>;
const v1 = "plan-observation-v1",
  v2 = "plan-observation-v2";
function response(output: unknown) {
  return {
    id: "synthetic-response",
    model: "synthetic-model",
    status: "completed",
    usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  };
}
function setup(version: PlanPromptVersion = v2, findings: ReviewFinding[] = []) {
  const value = createPlanQualityFixtures()[0];
  const runner = createServerPlanMockRunner(version);
  const calls: EngineExecutionTransportRequest[] = [];
  const validated: EngineExecutionValidated[] = [];
  const hooks = {
    onRequestPrepared: vi.fn(),
    onDispatch: vi.fn(),
    onResponseCaptured: vi.fn(),
    onResponse: vi.fn(),
    onValidated: vi.fn((event: EngineExecutionValidated) => {
      validated.push(event);
    }),
  };
  const transport = vi.fn(async (wire: EngineExecutionTransportRequest) => {
    calls.push(wire);
    return response(wire.request.phase === "generation" ? value.plan : { findings });
  });
  const options: MockOptions = {
    mode: "mock",
    model: "synthetic-model",
    contractDigest: runner.getContract().contractDigest,
    hooks,
    transport,
  };
  return {
    value,
    runner,
    calls,
    validated,
    hooks,
    transport,
    options,
    run: () => runner.generate(value.company, value.candidate, options),
  };
}
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  sdk.mockClear();
  environment = process.env;
  process.env = new Proxy(environment, {
    get(target, name, receiver) {
      if (typeof name === "string" && /^(OPENAI|VENTURE_)/.test(name))
        throw new Error("Config forbidden");
      return Reflect.get(target, name, receiver);
    },
  });
});
afterEach(() => {
  process.env = environment;
  expect(sdk).not.toHaveBeenCalled();
});

describe("server-selected version stays bound to one observed mock execution", () => {
  it("keeps explicit v1 execution byte-identical to the legacy entrypoint", async () => {
    const selected = setup(v1),
      legacy = setup(v1);
    expect(await selected.run()).toEqual(
      await generateObservedPlan(legacy.value.company, legacy.value.candidate, legacy.options),
    );
    expect(selected.calls.map((call) => JSON.stringify(call))).toEqual(
      legacy.calls.map((call) => JSON.stringify(call)),
    );
    expect(selected.validated).toEqual(legacy.validated);
    expect(selected.runner.getContract()).toEqual(preparation.getPlanExecutionContract());
  });

  it("runs both v2 phases with original validated draft and finalizes only afterward", async () => {
    const state = setup(v2, [
      {
        id: "followup",
        severity: "warning",
        category: "semantic-evidence",
        sectionKey: "problem",
        sourceIds: [],
        message: "합성 검토 의견",
        action: "남은 확인",
      },
    ]);
    state.value.plan.sections[0].title = "정규화 이전 제목";
    const result = await state.run();
    const generation = state.validated[0];
    if (generation.output.kind !== "plan") throw new Error("Missing generation");
    expect(generation.output.content.sections[0].title).not.toBe("정규화 이전 제목");
    expect(JSON.parse(state.calls[1].body.input[1].content).draft).toEqual(
      generation.output.content,
    );
    expect(result.content.actionItems).not.toEqual(generation.output.content.actionItems);
    const prompt = getPlanPromptDefinition(v2);
    expect(state.calls.map((call) => call.body.input[0].content)).toEqual([
      `${prompt.systemPrompt}\n\n${prompt.generationInstruction}`,
      `${prompt.systemPrompt}\n\n${prompt.reviewInstruction}`,
    ]);
    expect(state.calls.map((call) => call.request.sequence)).toEqual([1, 2]);
    for (const wire of state.calls) {
      expect(wire.request.contractDigest).toBe(state.runner.getContract().contractDigest);
      expect(wire.request.requestDigest).toBe(preparation.executionDigest(wire.body));
      expect(wire.body.store).toBe(false);
    }
    expect(result.contractDigest).toBe(state.runner.getContract().contractDigest);
    expect(state.hooks.onResponseCaptured).toHaveBeenCalledTimes(2);
    expect(state.hooks.onValidated).toHaveBeenCalledTimes(2);
  });

  it.each([
    [v1, v2],
    [v2, v1],
  ] as const)(
    "rejects %s runner with %s request contract before any dispatch",
    async (selected, foreign) => {
      const state = setup(selected);
      state.options.contractDigest =
        preparation.getPlanExecutionContractForVersion(foreign).contractDigest;
      await expect(state.run()).rejects.toMatchObject({ code: "AI_EXECUTION_SCOPE_CHANGED" });
      expect(state.transport).not.toHaveBeenCalled();
      expect(state.hooks.onRequestPrepared).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, "__proto__", "plan-observation-v3"])(
    "rejects unsupported server version %j",
    (version) => {
      expect(() => createServerPlanMockRunner(version as PlanPromptVersion)).toThrow(
        "Unsupported plan prompt version",
      );
    },
  );

  it.each([v1, v2] as const)(
    "refuses actual-ai on the mock-only %s runner before config/SDK access",
    async (version) => {
      const state = setup(version);
      Object.assign(state.options, { mode: "actual-ai" });
      await expect(state.run()).rejects.toMatchObject({ code: "AI_EXECUTION_SCOPE_CHANGED" });
      expect(state.transport).not.toHaveBeenCalled();
      expect(state.hooks.onDispatch).not.toHaveBeenCalled();
    },
  );

  it("isolates caller changes and getter copies between phases", async () => {
    const state = setup();
    const contract = state.runner.getContract();
    contract.engineVersion = v1;
    contract.phases[0].systemDigest = "changed";
    const expectedCompany = structuredClone(state.value.company);
    const expectedCandidate = structuredClone(state.value.candidate);
    state.hooks.onValidated.mockImplementation((event) => {
      state.validated.push(event);
      if (event.output.kind !== "plan") return;
      expect(Object.isFrozen(event.output.content)).toBe(true);
      state.options.model = "different-model";
      state.options.contractDigest = preparation.getPlanExecutionContract().contractDigest;
      Object.assign(state.options, { engineVersion: v1 });
      state.value.company.sources[0].text = "different-source";
      state.value.candidate.title = "different-candidate";
      state.options.transport = vi.fn(() => {
        throw new Error("Changed transport used");
      });
    });
    await state.run();
    const event = state.validated[0];
    if (event.output.kind !== "plan") throw new Error("Missing plan");
    expect(state.calls[1].body).toEqual(
      preparation.buildPlanReviewRequestForVersion(
        v2,
        expectedCompany,
        expectedCandidate,
        event.output.content,
        "synthetic-model",
      ).body,
    );
    expect(state.runner.getContract().engineVersion).toBe(v2);
    expect(state.transport).toHaveBeenCalledTimes(2);
    expect(state.options.transport).not.toHaveBeenCalled();
  });

  it("keeps overlapping v1/v2 runs separate while generation is awaiting", async () => {
    const old = setup(v1),
      revised = setup(v2);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    revised.transport.mockImplementation(async (wire) => {
      revised.calls.push(wire);
      if (wire.request.phase === "generation") {
        ready();
        await held;
      }
      return response(wire.request.phase === "generation" ? revised.value.plan : { findings: [] });
    });
    const pending = revised.run();
    await started;
    try {
      await old.run();
    } finally {
      release();
    }
    await pending;
    expect(old.calls.map((wire) => wire.request.contractDigest)).toEqual([
      old.options.contractDigest,
      old.options.contractDigest,
    ]);
    expect(revised.calls.map((wire) => wire.request.contractDigest)).toEqual([
      revised.options.contractDigest,
      revised.options.contractDigest,
    ]);
    expect(revised.options.contractDigest).not.toBe(old.options.contractDigest);
  });

  it("blocks a v1 review body relabeled and rehashed as v2 before second transmission", async () => {
    const build = preparation.buildPlanReviewRequestForVersion;
    vi.spyOn(preparation, "buildPlanReviewRequestForVersion").mockImplementation(
      (version, company, candidate, plan, model) => ({
        ...build(v1, company, candidate, plan, model),
        contractDigest: preparation.getPlanExecutionContractForVersion(version).contractDigest,
      }),
    );
    const state = setup();
    await expect(state.run()).rejects.toMatchObject({ code: "AI_EXECUTION_SCOPE_CHANGED" });
    expect(state.transport).toHaveBeenCalledTimes(1);
    expect(state.hooks.onRequestPrepared).toHaveBeenCalledTimes(1);
  });

  it.each(["foreign-draft", "store", "output-limit", "extra-tools", "schema"] as const)(
    "blocks rehashed %s review tampering before transmission",
    async (kind) => {
      const build = preparation.buildPlanReviewRequestForVersion;
      vi.spyOn(preparation, "buildPlanReviewRequestForVersion").mockImplementation((...args) => {
        const prepared = build(...args);
        if (kind === "foreign-draft") {
          const context = JSON.parse(prepared.body.input[1].content);
          context.draft.summary = "다른 실행의 합성 원고";
          prepared.body.input[1].content = JSON.stringify(context);
        }
        if (kind === "store") Object.assign(prepared.body, { store: true });
        if (kind === "output-limit") Object.assign(prepared.body, { max_output_tokens: 20000 });
        if (kind === "extra-tools")
          Object.assign(prepared.body, { tools: [{ type: "web_search" }] });
        if (kind === "schema") prepared.body.text.format.schema.changed = true;
        prepared.requestDigest = preparation.executionDigest(prepared.body);
        prepared.inputChars = prepared.body.input.reduce(
          (sum, message) => sum + message.content.length,
          0,
        );
        return prepared;
      });
      const state = setup();
      await expect(state.run()).rejects.toMatchObject({ code: "AI_EXECUTION_SCOPE_CHANGED" });
      expect(state.transport).toHaveBeenCalledTimes(1);
      expect(state.hooks.onDispatch).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects altered generation context even if its digest was recomputed", async () => {
    const build = preparation.buildPlanGenerationRequestForVersion;
    vi.spyOn(preparation, "buildPlanGenerationRequestForVersion").mockImplementation((...args) => {
      const prepared = build(...args);
      prepared.body.input[1].content = JSON.stringify({ arbitrary: "다른 후보" });
      prepared.requestDigest = preparation.executionDigest(prepared.body);
      return prepared;
    });
    const state = setup();
    await expect(state.run()).rejects.toMatchObject({ code: "AI_EXECUTION_SCOPE_CHANGED" });
    expect(state.transport).not.toHaveBeenCalled();
  });

  it("rejects a different contract at the runner entry before any preparation hook", async () => {
    const state = setup();
    const changed = state.runner.getContract();
    changed.phases[0].instructionDigest = "c".repeat(64);
    const { contractDigest: oldDigest, ...payload } = changed;
    changed.contractDigest = preparation.executionDigest(payload);
    expect(changed.contractDigest).not.toBe(oldDigest);
    vi.spyOn(preparation, "getPlanExecutionContractForVersion").mockReturnValue(changed);
    state.options.contractDigest = changed.contractDigest;
    state.options.beforeRequest = vi.fn();
    await expect(state.run()).rejects.toMatchObject({ code: "AI_EXECUTION_SCOPE_CHANGED" });
    expect(state.options.beforeRequest).not.toHaveBeenCalled();
    expect(state.transport).not.toHaveBeenCalled();
  });
  it("stops if the selected contract changes between generation and review", async () => {
    const state = setup();
    state.hooks.onValidated.mockImplementation((event) => {
      if (event.output.kind === "plan")
        vi.spyOn(preparation, "getPlanExecutionContractForVersion").mockReturnValue(
          preparation.getPlanExecutionContract(),
        );
    });
    await expect(state.run()).rejects.toMatchObject({ code: "AI_EXECUTION_SCOPE_CHANGED" });
    expect(state.transport).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid-generation", "validation-storage-failure", "invalid-review"] as const)(
    "does not finalize or retry after %s",
    async (kind) => {
      const state = setup();
      const failure = new Error("Synthetic persistence failed");
      if (kind === "validation-storage-failure")
        state.hooks.onValidated.mockImplementation(() => {
          throw failure;
        });
      if (kind === "invalid-generation") state.transport.mockResolvedValue(response({}));
      if (kind === "invalid-review")
        state.transport.mockImplementation(async (wire) =>
          response(wire.request.phase === "generation" ? state.value.plan : { findings: [{}] }),
        );
      await expect(state.run()).rejects.toBeDefined();
      expect(state.transport).toHaveBeenCalledTimes(kind === "invalid-review" ? 2 : 1);
      expect(state.hooks.onValidated).toHaveBeenCalledTimes(kind === "invalid-generation" ? 0 : 1);
    },
  );
});
