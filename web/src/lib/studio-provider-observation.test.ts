import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Provider access forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
import {
  generateObservedProviderPlan,
  type ProviderObservationOptions,
} from "./studio-provider-observation";
import {
  actualTestRegistry,
  actualTestNow,
  actualTestPlan,
} from "./studio-plan-quality-actual-test-helpers";
import {
  providerTestFinancialInput,
  providerTestExpires,
} from "./studio-plan-quality-provider-test-helpers";
import {
  createProviderPreparation,
  providerBudgetScope,
  providerDigest,
} from "./studio-plan-quality-provider-core";
import { caseSchema } from "./studio-schema";
import type { ProviderUsagePolicy } from "../../scripts/local-data-quality-provider-usage.mjs";

function fixture() {
  const registry = actualTestRegistry(),
    entry = registry.entries[0],
    calls: string[] = [],
    plan = actualTestPlan(registry);
  const company = caseSchema.parse({
    id: "00000000-0000-4000-8000-000000000002",
    profile: entry.input.profile,
    sources: entry.input.sources,
    analysis: null,
    selectedCandidateId: entry.input.candidate.id,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: actualTestNow,
    updatedAt: actualTestNow,
  });
  const preparation = createProviderPreparation({
    registry,
    candidateId: entry.candidateId,
    environment: "synthetic-test",
    preparedAt: actualTestNow,
    expiresAt: providerTestExpires,
    financialInput: providerTestFinancialInput(),
    budget: {
      scopeId: providerBudgetScope("synthetic-test"),
      revision: 1,
      headDigest: "1".repeat(64),
      currency: "TST",
      unitScale: 6,
      capUnits: "100",
      heldUnits: "0",
      recognizedUnits: "0",
    },
    retention: {
      policyVersion: "synthetic-v2",
      notice: "합성 보관 조건",
      sourceUrl: "https://example.invalid/retention",
      documentDigest: "2".repeat(64),
      reviewedAt: actualTestNow,
      validUntil: providerTestExpires,
    },
  });
  const policy: ProviderUsagePolicy = {
    schemaVersion: 1,
    kind: "provider-usage-rate-policy",
    provenance: "synthetic-test",
    financialBasisDigest: providerDigest(preparation.financialBasis),
    configuredModel: preparation.model,
    responseModels: [preparation.model],
    requestedTier: "default",
    responseTier: "default",
    inputPartition: { kind: "equal-rates", basis: "합성 동일 요율" },
    bandSelection: { kind: "short-only", basis: "합성 단일 구간" },
    authority: {
      sourceUrl: "https://example.invalid/usage",
      documentDigest: "3".repeat(64),
      reviewedAt: actualTestNow,
      validUntil: providerTestExpires,
      excerpt: "합성 테스트만",
    },
  };
  const response = (output: unknown) => ({
    id: "synthetic-response",
    _request_id: "synthetic-request",
    model: preparation.model,
    service_tier: "default",
    status: "completed",
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  });
  const hooks = {
    onRequestPrepared: vi.fn<ProviderObservationOptions["hooks"]["onRequestPrepared"]>((v) => {
      calls.push(v.request.phase + ":prepared");
    }),
    onDispatch: vi.fn<ProviderObservationOptions["hooks"]["onDispatch"]>((v) => {
      calls.push(v.phase + ":dispatch");
    }),
    onResponseCaptured: vi.fn<ProviderObservationOptions["hooks"]["onResponseCaptured"]>((v) => {
      calls.push(v.request.phase + ":captured");
    }),
    onValidated: vi.fn<ProviderObservationOptions["hooks"]["onValidated"]>((v) => {
      calls.push(v.request.phase + ":validated");
    }),
  };
  const send = vi.fn<ProviderObservationOptions["transport"]["send"]>(async (v) => {
    calls.push(v.request.phase + ":transport");
    return response(v.request.phase === "generation" ? plan : { findings: [] });
  });
  const options: ProviderObservationOptions = {
    preparation,
    generationRequestBody: JSON.stringify(preparation.generation.body),
    executionContractDigest: "4".repeat(64),
    usagePolicy: policy,
    transport: { provenance: "synthetic-test", send },
    hooks,
  };
  return {
    registry,
    company,
    candidate: entry.input.candidate,
    plan,
    options,
    hooks,
    send,
    calls,
    response,
    run: () => generateObservedProviderPlan(company, entry.input.candidate, options),
  };
}
let savedEnvironment: NodeJS.ProcessEnv;
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  savedEnvironment = process.env;
  process.env = new Proxy(savedEnvironment, {
    get(target, key, receiver) {
      if (typeof key === "string" && key.startsWith("OPENAI"))
        throw new Error("Config access forbidden");
      return Reflect.get(target, key, receiver);
    },
  });
});
afterEach(() => {
  process.env = savedEnvironment;
  vi.unstubAllGlobals();
  expect(forbidden).not.toHaveBeenCalled();
});

describe("separate synthetic provider observation", () => {
  it("awaits original v2 prepared/dispatch/capture/validated order with exactly two calls", async () => {
    const s = fixture(),
      result = await s.run();
    expect(s.calls).toEqual(
      ["generation", "review"].flatMap((p) =>
        ["prepared", "dispatch", "transport", "captured", "validated"].map((k) => p + ":" + k),
      ),
    );
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(result.contractDigest).toBe(s.options.executionContractDigest);
    expect(s.send.mock.calls[0][0].rawBody).toBe(s.options.generationRequestBody);
    expect(s.send.mock.calls[0][0].body).toMatchObject({
      service_tier: "default",
      truncation: "disabled",
      background: false,
      stream: false,
    });
    const validated = s.hooks.onValidated.mock.calls[0][0];
    expect(JSON.parse(s.send.mock.calls[1][0].body.input[1].content).draft).toEqual(
      validated.output.kind === "plan" ? validated.output.content : null,
    );
  });
  it.each(["onRequestPrepared", "onDispatch", "onResponseCaptured", "onValidated"] as const)(
    "never continues after failed %s persistence",
    async (key) => {
      const s = fixture(),
        failure = new Error("synthetic write failed");
      s.hooks[key].mockImplementation(async () => {
        await Promise.resolve();
        throw failure;
      });
      await expect(s.run()).rejects.toBe(failure);
      expect(s.send).toHaveBeenCalledTimes(
        ["onResponseCaptured", "onValidated"].includes(key) ? 1 : 0,
      );
    },
  );
  it("waits for capture before inspecting malformed domain output", async () => {
    const s = fixture();
    s.send.mockResolvedValue(s.response({ invalid: true }));
    await expect(s.run()).rejects.toThrow();
    expect(s.hooks.onResponseCaptured).toHaveBeenCalledOnce();
    expect(s.hooks.onValidated).not.toHaveBeenCalled();
    expect(s.send).toHaveBeenCalledOnce();
    expect(s.hooks.onResponseCaptured.mock.calls[0][0].usage.status).toBe("known");
  });
  it("missing tier/usage preserves raw evidence and stops review", async () => {
    const s = fixture(),
      r = s.response(s.plan);
    delete (r as Partial<typeof r>).service_tier;
    s.send.mockResolvedValue(r);
    await expect(s.run()).rejects.toMatchObject({ code: "PROVIDER_USAGE_UNKNOWN" });
    expect(s.hooks.onResponseCaptured).toHaveBeenCalledOnce();
    expect(s.send).toHaveBeenCalledOnce();
    expect(s.hooks.onValidated).not.toHaveBeenCalled();
  });
  it("domain failure never discards known usage", async () => {
    const s = fixture(),
      r = s.response(s.plan);
    r.status = "incomplete";
    s.send.mockResolvedValue(r);
    await expect(s.run()).rejects.toMatchObject({ code: "AI_INCOMPLETE" });
    expect(s.hooks.onResponseCaptured.mock.calls[0][0].usage.units).toBe("2");
    expect(s.send).toHaveBeenCalledOnce();
  });
  it("capture survives a scope change during transport, then no domain or second call", async () => {
    const s = fixture();
    let changed = false;
    s.options.beforeRequest = () => {
      if (changed) throw new Error("scope changed");
    };
    s.send.mockImplementation(async () => {
      changed = true;
      return s.response(s.plan);
    });
    await expect(s.run()).rejects.toThrow("scope changed");
    expect(s.hooks.onResponseCaptured).toHaveBeenCalledOnce();
    expect(s.hooks.onValidated).not.toHaveBeenCalled();
    expect(s.send).toHaveBeenCalledOnce();
  });
  it("a scope change while dispatch commits does not trigger transport", async () => {
    const s = fixture();
    let changed = false;
    s.options.beforeRequest = () => {
      if (changed) throw new Error("scope changed");
    };
    s.hooks.onDispatch.mockImplementation(async () => {
      await Promise.resolve();
      changed = true;
    });
    await expect(s.run()).rejects.toThrow("scope changed");
    expect(s.send).not.toHaveBeenCalled();
  });
  it("a foreign review source is rejected after its response cost was captured", async () => {
    const s = fixture();
    s.send.mockImplementation(async (wire) =>
      s.response(
        wire.request.phase === "generation"
          ? s.plan
          : {
              findings: [
                  {
                    id: "synthetic-foreign-review",
                    severity: "warning",
                  category: "semantic-evidence",
                  sectionKey: null,
                  message: "합성 원고 대조 의견",
                  action: "원문을 대조해 주세요.",
                  sourceIds: ["foreign-source"],
                },
              ],
            },
      ),
    );
    await expect(s.run()).rejects.toMatchObject({ code: "AI_INVALID_REVIEW" });
    expect(s.hooks.onResponseCaptured).toHaveBeenCalledTimes(2);
    expect(s.hooks.onValidated).toHaveBeenCalledTimes(1);
  });
  it("derives review from the first validated draft, before semantic findings change final content", async () => {
    const s = fixture();
    const finding = {
      id: "synthetic-review",
      severity: "warning",
      category: "semantic-evidence",
      sectionKey: null,
      message: "합성 자료의 사실 확인 의견",
      action: "합성 원문과 계획을 대조하세요.",
      sourceIds: ["profile"],
    };
    s.send.mockImplementation(async (wire) =>
      s.response(wire.request.phase === "generation" ? s.plan : { findings: [finding] }),
    );
    const result = await s.run();
    const sentDraft = JSON.parse(s.send.mock.calls[1][0].body.input[1].content).draft;
    expect(sentDraft.actionItems).toEqual([]);
    expect(result.content.actionItems.join(" ")).toContain(finding.action);
    expect(s.plan.actionItems).toEqual([]);
  });
  it("immutable hook copies cannot change original request, captured response or derived draft", async () => {
    const s = fixture();
    s.hooks.onRequestPrepared.mockImplementation((v) => {
      expect(Object.isFrozen(v.body.input)).toBe(true);
      expect(() => {
        v.rawBody = "other";
      }).toThrow();
    });
    s.hooks.onValidated.mockImplementation((v) => {
      const output = v.output;
      if (output.kind === "plan")
        expect(() => {
          output.content.title = "changed";
        }).toThrow();
    });
    await s.run();
    expect(s.plan.title).toBe(actualTestPlan(s.registry).title);
  });
  it.each(["bytes", "company", "candidate", "policy", "mode"] as const)(
    "rejects changed %s before transport",
    async (kind) => {
      const s = fixture();
      if (kind === "bytes") s.options.generationRequestBody += "\n";
      if (kind === "company") s.company.profile.companyName = "다른 합성기업";
      if (kind === "candidate") s.candidate.title = "다른 합성후보";
      if (kind === "policy") s.options.usagePolicy.financialBasisDigest = "0".repeat(64);
      if (kind === "mode") Object.assign(s.options.transport, { provenance: "production" });
      await expect(s.run()).rejects.toThrow();
      expect(s.send).not.toHaveBeenCalled();
    },
  );
  it("oversized capture does not permit validation or review", async () => {
    const s = fixture();
    s.send.mockResolvedValue({
      ...s.response(s.plan),
      usage: { blob: "x".repeat(4 * 1024 * 1024) },
    });
    await expect(s.run()).rejects.toThrow();
    expect(s.hooks.onResponseCaptured).not.toHaveBeenCalled();
    expect(s.hooks.onValidated).not.toHaveBeenCalled();
    expect(s.send).toHaveBeenCalledOnce();
  });
});
