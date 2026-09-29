import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import OpenAI from "openai";
import { prepareProviderGenerationDispatch } from "./studio-plan-quality-provider-dispatch-plan";
import { generationDispatchFixture } from "./studio-plan-quality-provider-dispatch-test-helpers";
import {
  dispatchOwnedProviderSdkTest,
  snapshotProviderSdkTestNetwork,
} from "./studio-plan-quality-provider-sdk-dispatch";
import type { ProviderObservationPrepared } from "./studio-provider-observation";

let prepared: ProviderObservationPrepared;
const forbidden = vi.fn(() => {
  throw Error("Real network forbidden");
});
const response = () =>
  Response.json({
    id: "synthetic-response",
    status: "completed",
    usage: { input_tokens: 20, output_tokens: 10 },
    output: [],
  });
beforeAll(() => {
  const result = prepareProviderGenerationDispatch(generationDispatchFixture().input);
  if (result.status !== "prepared") throw Error(result.reason);
  prepared = result.plan.request;
});
beforeEach(() => {
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function run(network: typeof fetch, writer: (start: () => void) => void = (start) => start()) {
  return dispatchOwnedProviderSdkTest(
    prepared,
    { provenance: "synthetic-test", fetch: network },
    writer,
  );
}

it("starts the configured fetch under the synchronous writer and releases before response wait", async () => {
  let locked = false,
    complete!: (r: Response) => void,
    started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const network = vi.fn<typeof fetch>((url, init) => {
    expect(locked).toBe(true);
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init?.body).toBe(prepared.rawBody);
    started();
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const pending = run(network, (start) => {
    locked = true;
    try {
      start();
    } finally {
      locked = false;
    }
  });
  expect(network).not.toHaveBeenCalled();
  await began;
  expect(locked).toBe(false);
  complete(response());
  expect(await pending).toMatchObject({
    delivery: "response-captured",
    fetchStarted: true,
    finalCheckFailedAfterStart: false,
    observation: { kind: "response-captured" },
    responsePersisted: false,
  });
  expect(network).toHaveBeenCalledTimes(1);
});

it.each(["throw", "omit"])(
  "does not start fetch when the current writer check chooses %s",
  async (kind) => {
    const network = vi.fn<typeof fetch>(async () => response());
    const result = await run(network, () => {
      if (kind === "throw") throw Error("private-check-data");
    });
    expect(result).toMatchObject({
      delivery: "not-sent",
      fetchStarted: false,
      refusal: "current-check-rejected",
      observation: null,
    });
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-check-data");
  },
);

it("seals a writer callback after return so it cannot grant a later start", async () => {
  let saved!: () => void;
  const network = vi.fn<typeof fetch>(async () => response());
  expect(
    await run(network, (start) => {
      saved = start;
    }),
  ).toMatchObject({ delivery: "not-sent" });
  expect(() => saved()).toThrow("START_REJECTED");
  expect(network).not.toHaveBeenCalled();
});

it.each([false, true])(
  "retains an in-flight completion after the final read COMMIT fails (network rejection %s)",
  async (reject) => {
    const network = vi.fn<typeof fetch>(async () => {
      if (reject) throw new TypeError("private-network-data");
      return response();
    });
    const result = await run(network, (start) => {
      start();
      throw Error("private-commit-data");
    });
    expect(result).toMatchObject({
      delivery: reject ? "send-result-unobserved" : "response-captured",
      fetchStarted: true,
      finalCheckFailedAfterStart: true,
      refusal: null,
      observation: { kind: reject ? "result-unobserved" : "response-captured" },
    });
    expect(network).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private-");
  },
);

it("treats a synchronous network throw as an unobserved started request", async () => {
  const network = vi.fn<typeof fetch>(() => {
    throw Error("private-sync-error");
  });
  expect(await run(network)).toMatchObject({
    delivery: "send-result-unobserved",
    fetchStarted: true,
    finalCheckFailedAfterStart: false,
    observation: { reason: "connection" },
  });
  expect(network).toHaveBeenCalledTimes(1);
});

it("consumes the callback once even when a writer invokes it twice", async () => {
  const network = vi.fn<typeof fetch>(async () => response());
  expect(
    await run(network, (start) => {
      start();
      start();
    }),
  ).toMatchObject({ delivery: "response-captured", finalCheckFailedAfterStart: true });
  expect(network).toHaveBeenCalledTimes(1);
});

it("rejects SDK reentry without a second writer check or fetch", async () => {
  const original = OpenAI.prototype.fetchWithTimeout;
  vi.spyOn(OpenAI.prototype, "fetchWithTimeout").mockImplementation(async function (
    this: OpenAI,
    ...args
  ) {
    const first = await original.apply(this, args);
    await expect(original.apply(this, args)).rejects.toThrow("DUPLICATE_FETCH");
    return first;
  });
  const network = vi.fn<typeof fetch>(async () => response()),
    writer = vi.fn((start: () => void) => start());
  expect(await run(network, writer)).toMatchObject({ delivery: "response-captured" });
  expect(network).toHaveBeenCalledTimes(1);
  expect(writer).toHaveBeenCalledTimes(1);
});

it("checks the monotonic SDK deadline again immediately before starting fetch", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const network = vi.fn<typeof fetch>(async () => response());
  expect(
    await run(network, (start) => {
      now = 120000;
      start();
    }),
  ).toMatchObject({ delivery: "not-sent", refusal: "current-check-rejected" });
  expect(network).not.toHaveBeenCalled();
});

it.each([
  "url",
  "method",
  "body",
  "redirect",
  "extra-option",
  "authorization",
  "organization",
  "retry",
  "extra-header",
])("rejects changed SDK wire %s before entering the writer", async (change) => {
  const original = OpenAI.prototype.buildRequest;
  vi.spyOn(OpenAI.prototype, "buildRequest").mockImplementation(async function (
    this: OpenAI,
    ...args
  ) {
    const built = await original.apply(this, args);
    if (change === "url") built.url = "https://unapproved.invalid/v1/responses";
    if (change === "method") built.req.method = "GET";
    if (change === "body") built.req.body = prepared.rawBody + " ";
    if (change === "redirect") built.req.redirect = "follow";
    if (change === "extra-option") built.req.credentials = "include";
    const headers = new Headers(built.req.headers);
    if (change === "authorization") headers.set("authorization", "Bearer injected");
    if (change === "organization") headers.set("openai-organization", "injected");
    if (change === "retry") headers.set("x-stainless-retry-count", "1");
    if (change === "extra-header") headers.set("x-custom", "private-extra-data");
    built.req.headers = headers;
    return built;
  });
  const network = vi.fn<typeof fetch>(async () => response()),
    writer = vi.fn((start: () => void) => start());
  expect(await run(network, writer)).toMatchObject({
    delivery: "not-sent",
    refusal: "wire-rejected",
    observation: null,
  });
  expect(network).not.toHaveBeenCalled();
  expect(writer).not.toHaveBeenCalled();
});

it("uses a snapshotted test network and rejects credentials/configuration/accessors", () => {
  const network = vi.fn<typeof fetch>(async () => response());
  const source = { provenance: "synthetic-test" as const, fetch: network };
  const snapshot = snapshotProviderSdkTestNetwork(source);
  source.fetch = forbidden;
  expect(snapshot.fetch).toBe(network);
  expect(Object.isFrozen(snapshot)).toBe(true);
  const getter = vi.fn(() => network);
  for (const value of [
    null,
    { ...source, apiKey: "dummy" },
    { ...source, baseURL: "dummy" },
    { ...source, provenance: "production" },
    {
      provenance: "synthetic-test",
      get fetch() {
        return getter();
      },
    },
  ])
    expect(() => snapshotProviderSdkTestNetwork(value)).toThrow("TEST_NETWORK_INVALID");
  expect(getter).not.toHaveBeenCalled();
});
