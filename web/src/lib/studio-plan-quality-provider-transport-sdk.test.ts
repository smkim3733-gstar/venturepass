import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import OpenAI from "openai";
import { prepareProviderGenerationDispatch } from "./studio-plan-quality-provider-dispatch-plan";
import { generationDispatchFixture } from "./studio-plan-quality-provider-dispatch-test-helpers";
import { prepareProviderReviewDispatch } from "./studio-plan-quality-provider-review-dispatch-plan";
import { reviewDispatchFixture } from "./studio-plan-quality-provider-review-dispatch-test-helpers";
import {
  prepareProviderTransportBoundary,
  providerTransportSdkOptions,
  type ProviderTransportBoundary,
} from "./studio-plan-quality-provider-transport-boundary";

// Characterize the INSTALLED SDK with synthetic input and an explicit fake fetch.
// No production transport factory or database gate is introduced by these tests.
const forbidden = vi.fn(() => {
  throw Error("Real network forbidden");
});
let generation: ProviderTransportBoundary, review: ProviderTransportBoundary;
beforeAll(() => {
  const g = prepareProviderGenerationDispatch(generationDispatchFixture().input);
  const r = prepareProviderReviewDispatch(reviewDispatchFixture().input);
  if (g.status !== "prepared" || r.status !== "prepared") throw Error("Fixture refused");
  const gb = prepareProviderTransportBoundary(JSON.stringify(g.plan.request));
  const rb = prepareProviderTransportBoundary(JSON.stringify(r.plan.request));
  if (gb.status !== "prepared" || rb.status !== "prepared") throw Error("Boundary refused");
  generation = gb.boundary;
  review = rb.boundary;
});
beforeEach(() => {
  vi.stubGlobal("fetch", forbidden);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-env-key-never-used");
  vi.stubEnv("OPENAI_ADMIN_KEY", "synthetic-env-admin-never-used");
  vi.stubEnv("OPENAI_WEBHOOK_SECRET", "synthetic-env-webhook-never-used");
  vi.stubEnv("OPENAI_BASE_URL", "https://unapproved.invalid/v9");
  vi.stubEnv("OPENAI_ORG_ID", "unapproved-org");
  vi.stubEnv("OPENAI_PROJECT_ID", "unapproved-project");
  vi.stubEnv("OPENAI_LOG", "debug");
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function client(fakeFetch: typeof fetch) {
  return new OpenAI({
    ...providerTransportSdkOptions,
    apiKey: "synthetic-test-key",
    fetch: fakeFetch,
  });
}
function response() {
  return Response.json(
    {
      id: "synthetic-response",
      object: "response",
      model: generation.prepared.request.model,
      status: "completed",
      service_tier: "default",
      usage: { input_tokens: 40, output_tokens: 9 },
      output: [
        { type: "message", content: [{ type: "output_text", text: "{malformed-domain-output" }] },
      ],
    },
    { headers: { "x-request-id": "synthetic-request-id" } },
  );
}

describe("installed SDK fixed transport characterization (no real network)", () => {
  it.each(["generation", "review"] as const)(
    "sends the exact %s body to the fixed destination with no ambient routing",
    async (phase) => {
      const b = phase === "generation" ? generation : review;
      const fakeFetch = vi.fn<typeof fetch>(async (url, init) => {
        expect(url).toBe("https://api.openai.com/v1/responses");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(b.prepared.rawBody);
        expect(init?.redirect).toBe("error");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer synthetic-test-key");
        expect(headers.get("openai-organization")).toBeNull();
        expect(headers.get("openai-project")).toBeNull();
        expect(headers.get("x-stainless-retry-count")).toBe("0");
        // This SDK only emits that header for a per-request timeout override.
        // The client deadline itself is verified with virtual-time tests below.
        expect(headers.get("x-stainless-timeout")).toBeNull();
        return response();
      });
      const sdk = client(fakeFetch);
      expect(sdk.maxRetries).toBe(0);
      expect(sdk.timeout).toBe(120000);
      expect(sdk.logLevel).toBe("off");
      const observed = b.captureResponse(await sdk.responses.create(b.prepared.body));
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(observed).toMatchObject({
        kind: "response-captured",
        outputValidated: false,
        responsePersisted: false,
        response: {
          _request_id: "synthetic-request-id",
          usage: { input_tokens: 40, output_tokens: 9 },
        },
      });
      expect(b.dispatchAllowed).toBe(false);
    },
  );
  it("proves that calling the SDK inside a synchronous lock does NOT start fetch inside that lock", async () => {
    let lockHeld = true;
    const atFetch: boolean[] = [];
    const fakeFetch = vi.fn<typeof fetch>(async () => {
      atFetch.push(lockHeld);
      return response();
    });
    const pending = client(fakeFetch).responses.create(generation.prepared.body);
    expect(fakeFetch).not.toHaveBeenCalled();
    lockHeld = false;
    await pending;
    expect(atFetch).toEqual([false]);
  });
  it.each([408, 409, 429, 500, 503])(
    "does not retry HTTP %s even when the server requests retry",
    async (status) => {
      const fakeFetch = vi.fn<typeof fetch>(async () =>
        Response.json(
          { error: { message: "synthetic failure" } },
          { status, headers: { "x-should-retry": "true", "retry-after-ms": "1" } },
        ),
      );
      const result = await client(fakeFetch)
        .responses.create(generation.prepared.body)
        .then(generation.captureResponse, generation.captureFailure);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        kind: "result-unobserved",
        reason: "http-error",
        httpStatus: status,
        costReconciled: false,
        automaticRetryAllowed: false,
      });
    },
  );
  it.each([
    [new TypeError("synthetic network failure"), "connection"],
    [new DOMException("synthetic timeout", "AbortError"), "timeout"],
  ])(
    "does not retry a fetch failure or confuse it with invalid model output",
    async (failure, reason) => {
      const fakeFetch = vi.fn<typeof fetch>(async () => {
        throw failure;
      });
      const result = await client(fakeFetch)
        .responses.create(generation.prepared.body)
        .then(generation.captureResponse, generation.captureFailure);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ kind: "result-unobserved", reason, outputValidated: false });
    },
  );
  it("treats invalid HTTP response JSON as an unobserved result without retry", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () => new Response("{broken", { headers: { "content-type": "application/json" } }),
    );
    const result = await client(fakeFetch)
      .responses.create(generation.prepared.body)
      .then(generation.captureResponse, generation.captureFailure);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "result-unobserved", reason: "response-decode" });
  });
  it("enforces the fixed deadline while reading a stalled response body without retry", async () => {
    vi.useFakeTimers();
    const fakeFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              /* intentionally never finishes */
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const result = client(fakeFetch)
      .responses.create(generation.prepared.body)
      .then(generation.captureResponse, generation.captureFailure);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120000);
    expect(await result).toMatchObject({
      kind: "result-unobserved",
      reason: "timeout",
      automaticRetryAllowed: false,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
  it("enforces the fixed deadline before response headers without retry", async () => {
    vi.useFakeTimers();
    const fakeFetch = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("synthetic abort", "AbortError")),
            { once: true },
          );
        }),
    );
    const result = client(fakeFetch)
      .responses.create(generation.prepared.body)
      .then(generation.captureResponse, generation.captureFailure);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119999);
    const signal = fakeFetch.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({
      kind: "result-unobserved",
      reason: "timeout",
      automaticRetryAllowed: false,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
  it("retains structured provider refusals as response evidence for later validation", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: "completed",
        usage: { input_tokens: 30, output_tokens: 1 },
        output: [{ type: "message", content: [{ type: "refusal", refusal: "synthetic refusal" }] }],
      }),
    );
    const result = await client(fakeFetch)
      .responses.create(generation.prepared.body)
      .then(generation.captureResponse, generation.captureFailure);
    expect(result).toMatchObject({
      kind: "response-captured",
      outputValidated: false,
      costReconciled: false,
      response: { usage: { input_tokens: 30, output_tokens: 1 } },
    });
  });
});
