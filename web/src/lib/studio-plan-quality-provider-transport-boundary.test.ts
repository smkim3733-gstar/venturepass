import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External access forbidden");
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
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai/error";
import { prepareProviderGenerationDispatch } from "./studio-plan-quality-provider-dispatch-plan";
import { generationDispatchFixture } from "./studio-plan-quality-provider-dispatch-test-helpers";
import { prepareProviderReviewDispatch } from "./studio-plan-quality-provider-review-dispatch-plan";
import { reviewDispatchFixture } from "./studio-plan-quality-provider-review-dispatch-test-helpers";
import {
  prepareProviderTransportBoundary,
  providerTransportSdkOptions,
} from "./studio-plan-quality-provider-transport-boundary";
import {
  providerRawDigest,
  providerWireDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import { providerObservationLimits } from "../../scripts/local-data-quality-provider-usage.mjs";
import type { ProviderObservationPrepared } from "./studio-provider-observation";

let generation: ProviderObservationPrepared, review: ProviderObservationPrepared;
beforeAll(() => {
  const g = prepareProviderGenerationDispatch(generationDispatchFixture().input);
  const r = prepareProviderReviewDispatch(reviewDispatchFixture().input);
  if (g.status !== "prepared" || r.status !== "prepared") throw Error("Fixture refused");
  generation = g.plan.request;
  review = r.plan.request;
});
beforeEach(() => {
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function boundary(prepared = generation) {
  const result = prepareProviderTransportBoundary(JSON.stringify(prepared));
  if (result.status !== "prepared") throw Error(result.reason);
  return result.boundary;
}
function rebind(prepared: ProviderObservationPrepared) {
  prepared.rawBody = JSON.stringify(prepared.body);
  prepared.request.artifactSha256 = providerRawDigest(prepared.rawBody);
  prepared.request.requestDigest = providerWireDigest(prepared.body);
}

describe("passive fixed provider transport boundary", () => {
  it.each(["generation", "review"] as const)(
    "preserves the exact %s request without authority",
    (phase) => {
      const prepared = structuredClone(phase === "generation" ? generation : review);
      const b = boundary(prepared);
      expect(b.prepared).toEqual(prepared);
      expect(JSON.stringify(b.prepared.body)).toBe(prepared.rawBody);
      expect(b).toMatchObject({
        dispatchAllowed: false,
        approvalVerified: false,
        newCommitOwnershipVerified: false,
      });
      expect(b.sdkOptions).toBe(providerTransportSdkOptions);
      expect(Object.isFrozen(b.prepared.body.input[0])).toBe(true);
      expect(Object.isFrozen(b.sdkOptions.fetchOptions)).toBe(true);
      expect(Object.isFrozen(b)).toBe(true);
      const original = b.prepared.body.input[0].content;
      prepared.body.input[0].content = "later caller mutation";
      expect(b.prepared.body.input[0].content).toBe(original);
      expect(boundary(b.prepared).boundaryDigest).toBe(b.boundaryDigest);
    },
  );
  it("accepts original non-schema property order without rewriting wire evidence", () => {
    const p = structuredClone(generation);
    p.body = Object.fromEntries(Object.entries(p.body).reverse()) as typeof p.body;
    rebind(p);
    expect(boundary(p).prepared.rawBody).toBe(p.rawBody);
  });
  it.each([
    [
      "model",
      (p: ProviderObservationPrepared) => {
        p.request.model = "other-model";
      },
    ],
    [
      "phase",
      (p: ProviderObservationPrepared) => {
        p.request.phase = "review";
      },
    ],
    [
      "sequence",
      (p: ProviderObservationPrepared) => {
        p.request.sequence = 2;
      },
    ],
    [
      "contract",
      (p: ProviderObservationPrepared) => {
        p.request.contractDigest = "invalid";
      },
    ],
    [
      "digest",
      (p: ProviderObservationPrepared) => {
        p.request.requestDigest = "0".repeat(64);
      },
    ],
    [
      "raw digest",
      (p: ProviderObservationPrepared) => {
        p.request.artifactSha256 = "0".repeat(64);
      },
    ],
    [
      "input count",
      (p: ProviderObservationPrepared) => {
        p.request.inputChars++;
      },
    ],
    [
      "token count",
      (p: ProviderObservationPrepared) => {
        Object.assign(p.request, { maxOutputTokens: 1 });
      },
    ],
    [
      "raw whitespace",
      (p: ProviderObservationPrepared) => {
        p.rawBody += " ";
        p.request.artifactSha256 = providerRawDigest(p.rawBody);
      },
    ],
    [
      "body content",
      (p: ProviderObservationPrepared) => {
        p.body.input[0].content += "changed";
      },
    ],
  ])("refuses inconsistent %s", (_, mutate) => {
    const p = structuredClone(generation);
    (mutate as (p: ProviderObservationPrepared) => void)(p);
    expect(prepareProviderTransportBoundary(JSON.stringify(p))).toEqual({
      status: "refused",
      reason: "invalid-request",
    });
  });
  it.each(["apiKey", "baseURL", "model", "transport", "maxRetries", "fetch", "dispatchAllowed"])(
    "refuses injected %s",
    (key) => {
      for (const position of ["envelope", "metadata"] as const) {
        const p = structuredClone(generation);
        Object.assign(position === "envelope" ? p : p.request, { [key]: "injected" });
        expect(prepareProviderTransportBoundary(JSON.stringify(p)).status).toBe("refused");
      }
    },
  );
  it.each([
    ["store", true],
    ["stream", true],
    ["background", true],
    ["truncation", "auto"],
    ["service_tier", "flex"],
    ["max_output_tokens", 32000],
    ["tools", []],
    ["previous_response_id", "resp_old"],
    ["conversation", "conversation_old"],
    ["context_management", []],
    ["instructions", "override"],
    ["apiKey", "dummy"],
  ])("refuses changed/added body option %s even with recomputed digests", (key, value) => {
    const p = structuredClone(generation);
    Object.assign(p.body, { [key]: value });
    rebind(p);
    expect(prepareProviderTransportBoundary(JSON.stringify(p)).status).toBe("refused");
  });
  it("refuses non-JSON input without executing caller accessors or toJSON", () => {
    const hook = vi.fn(() => {
      throw Error("must not execute");
    });
    const hostile = {
      get rawBody() {
        return hook();
      },
      toJSON: hook,
    };
    for (const value of [hostile, null, [], "null", "[]", "{broken"])
      expect(prepareProviderTransportBoundary(value).status).toBe("refused");
    expect(hook).not.toHaveBeenCalled();
  });
  it("rejects oversized encoded input before parsing", () => {
    expect(
      prepareProviderTransportBoundary(
        " ".repeat(providerObservationLimits.requestBytes * 3 + 8193),
      ),
    ).toEqual({ status: "refused", reason: "request-too-large" });
  });
  it("enforces the raw UTF-8 byte limit even when character count fits", () => {
    const p = structuredClone(generation);
    p.body.text.format.schema = { description: "가".repeat(710000) };
    rebind(p);
    expect(p.rawBody.length).toBeLessThan(providerObservationLimits.requestBytes);
    expect(prepareProviderTransportBoundary(JSON.stringify(p))).toEqual({
      status: "refused",
      reason: "request-too-large",
    });
  });
  it("copies raw selected response and usage synchronously before validation or persistence", () => {
    const raw = {
      id: "synthetic-response",
      model: "different-model",
      status: "incomplete",
      service_tier: "flex",
      usage: { input_tokens: 42, output_tokens: 7, unknown_channel: { future: 10 } },
      output: [{ type: "message", content: [{ type: "output_text", text: "not domain JSON" }] }],
      secret: "must-not-be-retained",
      output_parsed: { misleading: true },
    };
    Object.defineProperty(raw, "_request_id", { value: "synthetic-request-id" });
    const b = boundary(),
      captured = b.captureResponse(raw);
    expect(captured.kind).toBe("response-captured");
    if (captured.kind !== "response-captured") throw Error("Capture failed");
    raw.usage.input_tokens = 999;
    raw.output[0].content[0].text = "changed after capture";
    expect(captured.response).toMatchObject({
      _request_id: "synthetic-request-id",
      usage: { input_tokens: 42 },
    });
    expect(captured.response.output).toEqual([
      { type: "message", content: [{ type: "output_text", text: "not domain JSON" }] },
    ]);
    expect(Object.isFrozen(captured.response.usage)).toBe(true);
    expect(JSON.stringify(captured)).not.toContain("must-not-be-retained");
    expect(captured).toMatchObject({
      boundaryDigest: b.boundaryDigest,
      request: b.prepared.request,
      responsePersisted: false,
      costReconciled: false,
      outputValidated: false,
      automaticRetryAllowed: false,
    });
  });
  it.each([
    {},
    { usage: null },
    { status: "completed", output: null },
    { usage: { input_tokens: "unknown" } },
  ])("retains missing or malformed domain output/usage for later assessment", (raw) => {
    const observation = boundary().captureResponse(raw);
    expect(observation).toMatchObject({
      kind: "response-captured",
      response: raw,
      outputValidated: false,
    });
  });
  it("does not invoke response accessors or serialize an unsafe/oversized capture", () => {
    const hook = vi.fn(() => "secret");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const raw of [
      null,
      {
        get usage() {
          return hook();
        },
      },
      { output: cyclic },
      { output: "x".repeat(providerObservationLimits.responseBytes) },
    ]) {
      expect(boundary().captureResponse(raw)).toMatchObject({
        kind: "result-unobserved",
        reason: "capture-failed",
        automaticRetryAllowed: false,
      });
    }
    expect(hook).not.toHaveBeenCalled();
  });
  it.each([
    [new APIConnectionTimeoutError({ message: "private-timeout" }), "timeout", null],
    [new APIConnectionError({ message: "private-connection" }), "connection", null],
    [new APIUserAbortError({ message: "private-abort" }), "aborted", null],
    [
      new APIError(
        429,
        { message: "private-provider" },
        "private-error",
        new Headers({ authorization: "private-key" }),
      ),
      "http-error",
      429,
    ],
    [new SyntaxError("private-body"), "response-decode", null],
    [new Error("private-unexpected"), "unexpected-failure", null],
  ])(
    "keeps failure distinct from invalid output and strips error data",
    (error, reason, httpStatus) => {
      const observation = boundary().captureFailure(error);
      expect(observation).toMatchObject({
        kind: "result-unobserved",
        reason,
        httpStatus,
        costReconciled: false,
        outputValidated: false,
        automaticRetryAllowed: false,
      });
      expect(JSON.stringify(observation)).not.toContain("private-");
    },
  );
});
