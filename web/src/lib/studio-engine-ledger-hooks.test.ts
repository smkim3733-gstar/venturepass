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
import { actualLedgerResponseArtifactSchema } from "./studio-plan-quality-actual-ledger-types";
import { executionDigest } from "./studio-engine-request-preparation";
import type {
  EngineExecutionHooks,
  EngineExecutionOptions,
  EngineExecutionTransportRequest,
} from "./studio-engine-execution-types";

function response(output: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "synthetic-response",
    _request_id: "synthetic-request",
    model: "synthetic-model",
    status: "completed",
    usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    ...overrides,
  };
}
function setup() {
  const value = createPlanQualityFixtures()[0],
    calls: string[] = [];
  const hooks = {
    onRequestPrepared: vi.fn<NonNullable<EngineExecutionHooks["onRequestPrepared"]>>((e) => {
      calls.push(`${e.request.phase}:prepared`);
    }),
    onDispatch: vi.fn<EngineExecutionHooks["onDispatch"]>((e) => {
      calls.push(`${e.phase}:dispatch`);
    }),
    onResponseCaptured: vi.fn<NonNullable<EngineExecutionHooks["onResponseCaptured"]>>((e) => {
      calls.push(`${e.metadata.request.phase}:captured`);
    }),
    onResponse: vi.fn<EngineExecutionHooks["onResponse"]>((e) => {
      calls.push(`${e.request.phase}:metadata`);
    }),
    onValidated: vi.fn<EngineExecutionHooks["onValidated"]>((e) => {
      calls.push(`${e.request.phase}:validated`);
    }),
  };
  const transport = vi.fn(async (wire: EngineExecutionTransportRequest): Promise<unknown> => {
    calls.push(`${wire.request.phase}:transport`);
    return response(wire.request.phase === "generation" ? value.plan : { findings: [] });
  });
  const options: EngineExecutionOptions = {
    mode: "mock",
    model: "synthetic-model",
    contractDigest: getPlanExecutionContract().contractDigest,
    transport,
    hooks,
  };
  return {
    value,
    calls,
    hooks,
    transport,
    options,
    run: () => generateObservedPlan(value.company, value.candidate, options),
  };
}
let savedEnvironment: NodeJS.ProcessEnv;
beforeEach(() => {
  actual.mockClear();
  savedEnvironment = process.env;
  process.env = new Proxy(savedEnvironment, {
    get(target, key, receiver) {
      if (typeof key === "string" && key.startsWith("OPENAI"))
        throw new Error("Credential/config access forbidden");
      return Reflect.get(target, key, receiver);
    },
  });
});
afterEach(() => {
  process.env = savedEnvironment;
  expect(actual).not.toHaveBeenCalled();
});

describe("durable engine request and response hooks", () => {
  it("captures the exact request before dispatch and SDK JSON before metadata/domain validation", async () => {
    const s = setup();
    await s.run();
    expect(s.calls).toEqual(
      ["generation", "review"].flatMap((phase) =>
        ["prepared", "dispatch", "transport", "captured", "metadata", "validated"].map(
          (kind) => `${phase}:${kind}`,
        ),
      ),
    );
    for (let i = 0; i < 2; i++) {
      const prepared = s.hooks.onRequestPrepared.mock.calls[i][0],
        wire = s.transport.mock.calls[i][0];
      expect(prepared).toEqual(wire);
      expect(prepared).not.toBe(wire);
      expect(executionDigest(prepared.body)).toBe(prepared.request.requestDigest);
      const captured = s.hooks.onResponseCaptured.mock.calls[i][0];
      expect(
        actualLedgerResponseArtifactSchema.parse({
          captureKind: "sdk-response-json",
          response: captured.capturedResponse,
        }).response,
      ).toEqual(captured.capturedResponse);
      expect(captured.metadata).toEqual(s.hooks.onResponse.mock.calls[i][0]);
    }
  });
  it.each(["generation", "review"] as const)(
    "does not dispatch %s before the preparation hook has committed",
    async (phase) => {
      const s = setup();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          entered = resolve;
        });
      s.hooks.onRequestPrepared.mockImplementation(async (event) => {
        if (event.request.phase === phase) {
          entered();
          await gate;
        }
      });
      const running = s.run();
      await started;
      expect(s.transport).toHaveBeenCalledTimes(phase === "generation" ? 0 : 1);
      expect(s.hooks.onDispatch).toHaveBeenCalledTimes(phase === "generation" ? 0 : 1);
      release();
      await running;
      expect(s.transport).toHaveBeenCalledTimes(2);
    },
  );
  it("does not validate generation or call review while the captured response is uncommitted", async () => {
    const s = setup();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    s.hooks.onResponseCaptured.mockImplementationOnce(async () => {
      entered();
      await gate;
    });
    const running = s.run();
    await started;
    expect(s.transport).toHaveBeenCalledTimes(1);
    expect(s.hooks.onResponse).not.toHaveBeenCalled();
    expect(s.hooks.onValidated).not.toHaveBeenCalled();
    release();
    await running;
    expect(s.transport).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["onRequestPrepared", "generation", 0],
    ["onRequestPrepared", "review", 1],
    ["onResponseCaptured", "generation", 1],
    ["onResponseCaptured", "review", 2],
  ] as const)(
    "propagates %s %s persistence failure without another transport",
    async (hook, phase, count) => {
      const s = setup(),
        error = new Error("Synthetic store failed");
      if (hook === "onRequestPrepared")
        s.hooks.onRequestPrepared.mockImplementation(async (e) => {
          await Promise.resolve();
          if (e.request.phase === phase) throw error;
        });
      else
        s.hooks.onResponseCaptured.mockImplementation(async (e) => {
          await Promise.resolve();
          if (e.metadata.request.phase === phase) throw error;
        });
      await expect(s.run()).rejects.toBe(error);
      expect(s.transport).toHaveBeenCalledTimes(count);
      expect(s.hooks.onValidated).toHaveBeenCalledTimes(phase === "generation" ? 0 : 1);
      if (hook === "onResponseCaptured")
        expect(s.hooks.onResponse).toHaveBeenCalledTimes(phase === "generation" ? 0 : 1);
    },
  );
  it("copies and deeply freezes request and response payloads before awaiting callbacks", async () => {
    const s = setup(),
      raw = response(s.value.plan);
    s.transport.mockResolvedValueOnce(raw);
    s.hooks.onRequestPrepared.mockImplementation((event) => {
      expect(() => {
        event.body.input[0].content = "changed";
      }).toThrow();
      expect(() => {
        event.request.requestDigest = "0".repeat(64);
      }).toThrow();
    });
    s.hooks.onResponseCaptured.mockImplementationOnce(async (event) => {
      expect(() => {
        event.metadata.request.mode = "actual-ai";
      }).toThrow();
      expect(() => {
        event.capturedResponse.output.push(null);
      }).toThrow();
      expect(() => {
        event.capturedResponse.usage = { input_tokens: 0 };
      }).toThrow();
      raw.output[0].content[0].text = "mutated after capture";
      raw.usage.input_tokens = 500;
      raw.id = "mutated";
      await Promise.resolve();
    });
    const result = await s.run();
    expect(result.content.title).toBe(s.value.plan.title);
    expect(s.hooks.onResponse.mock.calls[0][0]).toMatchObject({
      responseId: "synthetic-response",
      usage: { inputTokens: 12 },
    });
    expect(s.hooks.onResponseCaptured.mock.calls[0][0].capturedResponse).toMatchObject({
      id: "synthetic-response",
      usage: { input_tokens: 12 },
    });
  });
  it("selects allowed SDK fields without evaluating or serializing extraneous secrets/client/errors", async () => {
    const s = setup(),
      raw = response(s.value.plan, {
        headers: { authorization: "synthetic-secret" },
        client: () => {},
        error: new Error("private"),
        apiKey: "synthetic-key",
      });
    const getter = vi.fn(() => {
      throw new Error("Never inspect omitted field");
    });
    Object.defineProperty(raw, "toJSON", { enumerable: true, get: getter });
    s.transport.mockResolvedValueOnce(raw);
    await s.run();
    const captured = s.hooks.onResponseCaptured.mock.calls[0][0].capturedResponse;
    expect(Object.keys(captured)).toEqual([
      "id",
      "_request_id",
      "model",
      "status",
      "usage",
      "output",
    ]);
    expect(JSON.stringify(captured)).not.toContain("synthetic-secret");
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["malformed-json", "wrong-evidence", "incomplete"])(
    "records permitted raw output before rejecting %s",
    async (kind) => {
      const s = setup(),
        plan = structuredClone(s.value.plan);
      if (kind === "wrong-evidence")
        plan.sections[0].evidence[0].quote = "Invented synthetic quote";
      const raw = response(plan);
      if (kind === "malformed-json") raw.output[0].content[0].text = "{broken";
      if (kind === "incomplete") raw.status = "incomplete";
      s.transport.mockResolvedValueOnce(raw);
      await expect(s.run()).rejects.toMatchObject({ name: "StudioEngineError" });
      expect(s.calls).toEqual([
        "generation:prepared",
        "generation:dispatch",
        "generation:captured",
        "generation:metadata",
      ]);
      expect(s.hooks.onResponseCaptured.mock.calls[0][0].capturedResponse).toEqual(raw);
      expect(s.transport).toHaveBeenCalledTimes(1);
      expect(s.hooks.onValidated).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, null, { input_tokens: 12, output_tokens: 20, total_tokens: 1 }])(
    "preserves incomplete usage %j without inferring known or zero cost",
    async (usage) => {
      const s = setup(),
        raw = response(s.value.plan, { usage, model: undefined });
      s.transport.mockResolvedValueOnce(raw);
      await s.run();
      const e = s.hooks.onResponseCaptured.mock.calls[0][0];
      expect(e.metadata.usage).toBeNull();
      expect(e.metadata.responseModel).toBeNull();
      expect(e.capturedResponse.usage).toEqual(usage);
      expect(e.capturedResponse).not.toHaveProperty("model");
    },
  );
  it.each(["cycle", "bigint", "nan", "function", "class", "accessor", "deep", "oversized"])(
    "rejects unsafe %s capture, preserving only available metadata",
    async (kind) => {
      const s = setup(),
        raw = response(s.value.plan),
        record = raw as Record<string, unknown>;
      if (kind === "cycle") {
        const value: unknown[] = [];
        value.push(value);
        record.output = value;
      }
      if (kind === "bigint") record.output = [{ value: BigInt(1) }];
      if (kind === "nan") record.output = [{ value: NaN }];
      if (kind === "function") record.output = [{ value: () => 0 }];
      if (kind === "class") record.output = [new Date()];
      if (kind === "accessor") {
        const value = {};
        Object.defineProperty(value, "text", {
          enumerable: true,
          get() {
            throw new Error("PRIVATE ACCESSOR");
          },
        });
        record.output = [value];
      }
      if (kind === "deep") {
        let value: unknown = [];
        for (let i = 0; i < 110; i++) value = [value];
        record.output = value;
      }
      if (kind === "oversized") record.output = ["가".repeat(3 * 1024 * 1024)];
      s.transport.mockResolvedValueOnce(raw);
      await expect(s.run()).rejects.toMatchObject({
        code: "AI_INVALID_OUTPUT",
        message: "AI 응답 구조를 보관할 수 없습니다.",
      });
      expect(s.hooks.onResponseCaptured).not.toHaveBeenCalled();
      expect(s.hooks.onValidated).not.toHaveBeenCalled();
      expect(s.hooks.onResponse.mock.calls[0][0]).toMatchObject({
        responseId: "synthetic-response",
        usage: { inputTokens: 12 },
      });
      expect(s.transport).toHaveBeenCalledTimes(1);
    },
  );
  it("propagates metadata persistence failure during failed capture unchanged", async () => {
    const s = setup(),
      error = new Error("Metadata store failed");
    s.transport.mockResolvedValueOnce(response(s.value.plan, { output: [BigInt(1)] }));
    s.hooks.onResponse.mockRejectedValueOnce(error);
    await expect(s.run()).rejects.toBe(error);
    expect(s.hooks.onResponseCaptured).not.toHaveBeenCalled();
    expect(s.transport).toHaveBeenCalledTimes(1);
  });
});
