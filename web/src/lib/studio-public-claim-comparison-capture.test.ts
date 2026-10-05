import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() => ({
  sdk: vi.fn(() => {
    throw Error("SDK forbidden");
  }),
  database: vi.fn(() => {
    throw Error("DB forbidden");
  }),
  network: vi.fn(() => {
    throw Error("network forbidden");
  }),
  configuration: vi.fn(() => {
    throw Error("configuration forbidden");
  }),
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden.sdk();
    }
  },
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor() {
      forbidden.database();
    }
  },
}));
import { publicClaimComparisonFixture as fixture } from "./studio-public-claim-comparison-test-helpers";
import {
  buildPublicClaimComparisonRequest as build,
  publicClaimComparisonRequestVersion,
} from "./studio-public-claim-comparison-request";
import {
  preparePublicClaimComparison,
  publicClaimComparisonResponseSchema,
} from "./studio-public-claim-comparison";
import {
  captureProviderResponse,
  providerResponseMetadata,
  providerResponseMetadataSchema,
  reportedProviderResponseMetadata,
  providerObservationLimits,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import type { capturePublicClaimComparisonResponse } from "./studio-public-claim-comparison-capture";

let capture: typeof capturePublicClaimComparisonResponse;
let environment: NodeJS.ProcessEnv;
function protect() {
  environment = process.env;
  process.env = new Proxy(environment, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(OPENAI|VENTURE_|KOSIS)/.test(key))
        return forbidden.configuration();
      return Reflect.get(target, key, receiver);
    },
  });
  vi.stubGlobal("fetch", forbidden.network);
}
function checkNoIO() {
  process.env = environment;
  vi.unstubAllGlobals();
  for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled();
}
beforeAll(async () => {
  protect();
  try {
    ({ capturePublicClaimComparisonResponse: capture } =
      await import("./studio-public-claim-comparison-capture"));
  } finally {
    checkNoIO();
  }
});
beforeEach(protect);
afterEach(checkNoIO);

function setup(count = 1) {
  const f = fixture(count);
  const command = {
    requestVersion: publicClaimComparisonRequestVersion,
    model: "synthetic-public-comparison-v1",
    selection: f.select(),
  };
  const preview = build(f.company, command);
  const prepared = preparePublicClaimComparison(f.company, command.selection);
  const answer: z.infer<typeof publicClaimComparisonResponseSchema> = {
    preparationDigest: prepared.preparationDigest,
    claimQuote: prepared.input.claimQuote,
    overall: { relation: "undetermined", reason: "제공된 범위의 의견" },
    evidence: prepared.input.selectedEvidence.map((e) => ({
      sourceId: e.sourceId,
      relation: "undetermined",
      quotes: [e.excerpt.slice(0, 20)],
      reason: "수동 발췌만 확인",
      nextCheck: "사람 확인",
    })),
    checks: [],
  };
  const raw = {
    id: "synthetic-response",
    _request_id: "synthetic-request",
    model: command.model,
    status: "completed",
    service_tier: "reported-tier",
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(answer) }],
      },
    ],
  };
  return {
    ...f,
    command,
    preview,
    prepared,
    answer,
    raw,
    run: (response: unknown = raw) => capture(f.company, command, preview.identity, response),
  };
}

describe("passive supplied public comparison response capture", () => {
  it("binds exact quoted opinions to the current original request without implied authority", () => {
    const f = setup(),
      before = structuredClone(f.company),
      r = f.run();
    expect(r.state).toBe("comparison-ready");
    expect(r.comparison?.comparison).toEqual(f.answer);
    expect(r.request).toEqual({
      identity: f.preview.identity,
      model: f.command.model,
      requestedTier: null,
    });
    expect(r.metadata).toMatchObject({
      responseId: f.raw.id,
      requestId: f.raw._request_id,
      responseTier: "reported-tier",
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
      },
    });
    expect(r.source).toBe("supplied-response");
    expect(r.evidenceOrigin).toBe("manual-unverified");
    expect(r.comparison?.source).toBe("supplied-response");
    for (const [key, value] of Object.entries(r))
      if (typeof value === "boolean") expect(value, key).toBe(false);
    expect(f.preview.body).not.toHaveProperty("service_tier");
    expect(r).not.toHaveProperty("cost");
    expect(f.company).toEqual(before);
    expect(f.reader).not.toHaveBeenCalled();
  });
  it("copies the response before reading current company state", () => {
    const f = setup(),
      original = structuredClone(f.raw),
      id = f.company.id;
    Object.defineProperty(f.company, "id", {
      enumerable: true,
      get() {
        f.raw.output[0].content[0].text = "changed during context read";
        return id;
      },
    });
    const r = f.run();
    expect(r.state).toBe("comparison-ready");
    expect(r.capture).toEqual(original);
    expect(f.raw).not.toEqual(original);
  });
  it("does not read current input at all when synchronous capture fails", () => {
    const f = setup(),
      read = vi.fn(() => {
        throw Error("context read");
      });
    const company = new Proxy(f.company, { get: read });
    const unsafe = Object.defineProperty({}, "output", { get: read });
    const r = capture(company, {}, {}, unsafe);
    expect(r).toMatchObject({ state: "capture-unavailable", capture: null, comparison: null });
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps immutable independent response, metadata, identity and opinion copies", () => {
    const f = setup(),
      r = f.run(),
      before = JSON.stringify(r);
    f.raw.output[0].content[0].text = "changed";
    f.raw.usage.total_tokens = 999;
    f.command.selection.sourceIds.length = 0;
    f.preview.identity.rawBodySha256 = "0".repeat(64);
    expect(JSON.stringify(r)).toBe(before);
    expect(() => {
      r.capture!.status = "changed";
    }).toThrow();
    expect(() => {
      r.metadata!.usage.inputTokens = 100;
    }).toThrow();
    expect(() => {
      r.request!.identity.rawBodySha256 = "1".repeat(64);
    }).toThrow();
    expect(() => {
      r.comparison!.comparison.overall.reason = "changed";
    }).toThrow();
  });
  it.each(["company", "revision", "plan", "source", "claim"] as const)(
    "retains captured evidence but rejects changed %s context",
    (change) => {
      const f = setup(),
        raw = structuredClone(f.raw);
      if (change === "company") f.company.id = "10000000-0000-4000-8000-000000000001";
      if (change === "revision") f.company.revision++;
      if (change === "plan") f.company.plans[0].content.sections[0].content += "same time change";
      if (change === "source") f.company.sources[0].text += "same time change";
      if (change === "claim") f.company.claimReviews![0].claimQuote += "changed";
      const r = f.run();
      expect(r.state).toBe("context-changed");
      expect(r.capture).toEqual(raw);
      expect(r.metadata?.usage.totalTokens).toBe(30);
      expect(r.request).toBeNull();
      expect(r.comparison).toBeNull();
    },
  );
  it.each(["identity", "model", "selection"] as const)(
    "retains the response when original request %s changes",
    (change) => {
      const f = setup(2);
      if (change === "identity") f.preview.identity.rawBodySha256 = "0".repeat(64);
      if (change === "model") f.command.model = "different-model";
      if (change === "selection") f.command.selection.sourceIds.pop();
      const r = f.run();
      expect(r.state).toBe("context-changed");
      expect(r.capture).toEqual(f.raw);
      expect(r.comparison).toBeNull();
    },
  );
  it.each([
    { apiKey: "not-a-real-key" },
    { approval: true },
    { endpoint: "https://example.invalid" },
    { extra: undefined },
    { requestVersion: "plan-observation-v2" },
  ])("rejects command extras/foreign purpose %j but preserves response", (extra) => {
    const f = setup();
    const r = capture(f.company, { ...f.command, ...extra }, f.preview.identity, f.raw);
    expect(r.state).toBe("request-rejected");
    expect(r.capture).toEqual(f.raw);
    expect(r.comparison).toBeNull();
  });
  it("rejects authority in the expected identity", () => {
    const f = setup();
    const r = capture(
      f.company,
      f.command,
      { ...f.preview.identity, transmissionAllowed: true },
      f.raw,
    );
    expect(r.state).toBe("request-rejected");
    expect(r.capture).toEqual(f.raw);
  });
  it.each(["incomplete", "failed", "queued", "", null, undefined])(
    "preserves a non-completed status %j and usage",
    (status) => {
      const f = setup(),
        r = f.run({ ...f.raw, status });
      expect(r.state).toBe("response-incomplete");
      expect(r.capture?.status).toEqual(status);
      expect(r.metadata?.usage.totalTokens).toBe(30);
      expect(r.request?.identity).toEqual(f.preview.identity);
      expect(r.comparison).toBeNull();
    },
  );
  it.each([
    { id: "" },
    { id: " " },
    { id: null },
    { id: "x".repeat(501) },
    { model: null },
    { model: "" },
    { model: " " },
    { model: "x".repeat(201) },
    { output: null },
    { output: [] },
    { output: "text" },
  ])("keeps malformed envelope %j without an opinion", (change) => {
    const f = setup(),
      raw = { ...f.raw, ...change },
      r = f.run(raw);
    expect(r.state).toBe("response-unsupported");
    expect(r.capture).toEqual(raw);
    expect(r.comparison).toBeNull();
  });
  it("does not infer a provider snapshot or alias from a different model", () => {
    const f = setup(),
      r = f.run({ ...f.raw, model: f.command.model + "-snapshot" });
    expect(r.state).toBe("model-mismatch");
    expect(r.metadata?.responseModel).toBe(f.command.model + "-snapshot");
    expect(r.request?.model).toBe(f.command.model);
    expect(r.comparison).toBeNull();
  });
  it("accepts optional reasoning up to the output bound without interpreting it", () => {
    const f = setup();
    const output = [
      ...Array.from({ length: 49 }, () => ({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "not evidence" }],
      })),
      ...f.raw.output,
    ];
    expect(f.run({ ...f.raw, output }).state).toBe("comparison-ready");
    const r = f.run({ ...f.raw, output: [{ type: "reasoning" }, ...output] });
    expect(r.state).toBe("response-unsupported");
    expect(r.capture?.output).toHaveLength(51);
  });
  it.each([
    "tool",
    "unknown",
    "duplicate",
    "nonobject",
    "role",
    "message-status",
    "refusal",
    "content-duplicate",
  ] as const)("rejects unsupported output structure %s", (kind) => {
    const f = setup(),
      msg = structuredClone(f.raw.output[0]);
    let output: unknown[] = [msg];
    if (kind === "tool") output.push({ type: "function_call", name: "do_something" });
    if (kind === "unknown") output.push({ type: "future-kind" });
    if (kind === "duplicate") output.push(structuredClone(msg));
    if (kind === "nonobject") output.push("unknown");
    if (kind === "role") msg.role = "user";
    if (kind === "message-status") msg.status = "incomplete";
    if (kind === "refusal") output = [{ ...msg, content: [{ type: "refusal", refusal: "no" }] }];
    if (kind === "content-duplicate") msg.content.push(structuredClone(msg.content[0]));
    const r = f.run({ ...f.raw, output });
    expect(r.state).toBe("response-unsupported");
    expect(r.capture?.output).toEqual(output);
    expect(r.comparison).toBeNull();
  });
  it.each(["fenced", "malformed", "scalar"] as const)("does not repair %s domain JSON", (kind) => {
    const f = setup();
    if (kind === "fenced")
      f.raw.output[0].content[0].text = "```json\n" + JSON.stringify(f.answer) + "\n```";
    if (kind === "malformed") f.raw.output[0].content[0].text = "{bad";
    if (kind === "scalar") f.raw.output[0].content[0].text = "null";
    const r = f.run();
    expect(r.state).toBe(kind === "scalar" ? "comparison-rejected" : "response-unsupported");
    expect(r.capture).toEqual(f.raw);
    expect(r.comparison).toBeNull();
  });
  it("enforces raw domain UTF16 size before parsing, even for removable JSON whitespace", () => {
    const f = setup(),
      content = f.raw.output[0].content[0];
    content.text += " ".repeat(240000 - content.text.length);
    expect(content.text.length).toBe(240000);
    expect(f.run().state).toBe("comparison-ready");
    content.text += " ";
    const r = f.run();
    expect(r.state).toBe("response-unsupported");
    expect(r.capture).toEqual(f.raw);
  });
  it.each(["claim", "quote", "source", "missing-source", "authority"] as const)(
    "uses existing exact comparison validation for %s mismatch",
    (kind) => {
      const f = setup(2);
      if (kind === "claim") f.answer.claimQuote += "other";
      if (kind === "quote") f.answer.evidence[0].quotes = ["not in original excerpt"];
      if (kind === "source") f.answer.evidence[0].sourceId = "10000000-0000-4000-8000-000000000001";
      if (kind === "missing-source") f.answer.evidence.pop();
      const answer = kind === "authority" ? { ...f.answer, factVerified: true } : f.answer;
      f.raw.output[0].content[0].text = JSON.stringify(answer);
      const r = f.run();
      expect(r.state).toBe("comparison-rejected");
      expect(r.capture).toEqual(f.raw);
      expect(r.comparison).toBeNull();
    },
  );
  it("validates a selected subset without including or certifying excluded private source text", () => {
    const f = setup(2);
    f.company.sources[1].text = "PRIVATE_BODY";
    f.input.references[1].quote = "PRIVATE_BODY";
    f.capture();
    const command = {
      ...f.command,
      selection: { ...f.select(), sourceIds: [f.company.sources[0].id] },
    };
    const preview = build(f.company, command);
    const prepared = preparePublicClaimComparison(f.company, command.selection);
    const answer = {
      ...f.answer,
      preparationDigest: prepared.preparationDigest,
      evidence: f.answer.evidence.slice(0, 1),
    };
    f.raw.output[0].content[0].text = JSON.stringify(answer);
    const r = capture(f.company, command, preview.identity, f.raw);
    expect(r.state).toBe("comparison-ready");
    expect(JSON.stringify(r)).not.toContain("PRIVATE_BODY");
    expect(r.comparison?.comparison.evidence).toHaveLength(1);
  });
  it("does not certify semantic truth for a structurally valid unsupported date inference", () => {
    const f = setup();
    f.answer.overall.reason = "읽은 날짜가 발행일이므로 최신이라고 가정한 잘못된 의견";
    f.raw.output[0].content[0].text = JSON.stringify(f.answer);
    const r = f.run();
    expect(r.state).toBe("comparison-ready");
    expect(r.semanticTruthVerified).toBe(false);
    expect(r.factVerified).toBe(false);
  });
  it.each(["accessor", "toJSON", "cycle", "oversized"] as const)(
    "has no partial capture and invokes no user code on %s capture failure",
    (kind) => {
      const f = setup(),
        called = vi.fn();
      let usage: unknown = {};
      if (kind === "accessor")
        usage = Object.defineProperty({}, "x", { enumerable: true, get: called });
      if (kind === "toJSON") usage = { toJSON: called };
      if (kind === "cycle") {
        const value: Record<string, unknown> = {};
        value.self = value;
        usage = value;
      }
      if (kind === "oversized")
        usage = { padding: "x".repeat(providerObservationLimits.responseBytes) };
      const r = f.run({ ...f.raw, usage });
      expect(r.state).toBe("capture-unavailable");
      expect(r.capture).toBeNull();
      expect(r.metadata).toBeNull();
      expect(r.comparison).toBeNull();
      expect(called).not.toHaveBeenCalled();
    },
  );
  it("ignores top-level credentials and SDK extras without invoking their accessors", () => {
    const f = setup(),
      called = vi.fn(() => "should not be read");
    const raw = Object.defineProperty(
      { ...f.raw, headers: { authorization: "synthetic-secret" } },
      "client",
      { get: called },
    );
    const r = f.run(raw);
    expect(r.state).toBe("comparison-ready");
    expect(JSON.stringify(r)).not.toContain("synthetic-secret");
    expect(r.capture).not.toHaveProperty("headers");
    expect(r.capture).not.toHaveProperty("client");
    expect(called).not.toHaveBeenCalled();
  });
  it("returns only a safe capture state even when a hostile proxy throws arbitrary secrets", () => {
    const f = setup(),
      raw = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw Error("SYNTHETIC_EXCEPTION_SECRET");
          },
        },
      );
    const r = f.run(raw);
    expect(r.state).toBe("capture-unavailable");
    expect(JSON.stringify(r)).not.toContain("SYNTHETIC_EXCEPTION_SECRET");
  });
});

describe("shared reported metadata without inferred request tier", () => {
  it.each([undefined, null, {}, { input_tokens: -1, output_tokens: "0", total_tokens: 1.5 }])(
    "keeps missing/invalid usage nullable for %j without costing",
    (usage) => {
      const f = setup(),
        r = f.run({ ...f.raw, usage, service_tier: undefined });
      expect(r.state).toBe("comparison-ready");
      expect(r.request?.requestedTier).toBeNull();
      expect(r.metadata).not.toHaveProperty("requestedTier");
      expect(r.metadata?.responseTier).toBeNull();
      for (const value of Object.values(r.metadata!.usage)) expect(value).toBeNull();
      expect(r.usageVerified).toBe(false);
      expect(r.budgetVerified).toBe(false);
    },
  );
  it("preserves explicit zero and inconsistent supplied counts without inferring billing", () => {
    const f = setup(),
      r = f.run({
        ...f.raw,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 999,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      });
    expect(r.metadata?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 999,
      cachedInputTokens: 2,
      reasoningOutputTokens: 3,
    });
    expect(r.state).toBe("comparison-ready");
    expect(r.usageVerified).toBe(false);
  });
  it("preserves the legacy configured/default-tier metadata schema and serialized property order", () => {
    const f = setup(),
      captured = captureProviderResponse(f.raw);
    const legacy = providerResponseMetadata(captured, { configuredModel: f.command.model });
    const expected = {
      configuredModel: f.command.model,
      requestedTier: "default",
      responseId: f.raw.id,
      requestId: f.raw._request_id,
      responseModel: f.raw.model,
      responseTier: f.raw.service_tier,
      status: "completed",
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
      },
    };
    expect(JSON.stringify(legacy)).toBe(JSON.stringify(expected));
    expect(legacy).toEqual(providerResponseMetadataSchema.parse(expected));
    const { configuredModel: ignoredModel, requestedTier: ignoredTier, ...reported } = expected;
    expect(ignoredModel).toBe(f.command.model);
    expect(ignoredTier).toBe("default");
    expect(reportedProviderResponseMetadata(captured)).toEqual(reported);
    expect(
      providerResponseMetadataSchema.safeParse({ ...expected, requestedTier: null }).success,
    ).toBe(false);
  });
});
