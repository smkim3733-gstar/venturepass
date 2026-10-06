import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      throw Error("SDK construction forbidden");
    }
  },
}));
vi.mock("openai/error", () => {
  class APIError extends Error {}
  return {
    APIError,
    APIConnectionError: class extends APIError {},
    APIConnectionTimeoutError: class extends APIError {},
    APIUserAbortError: class extends APIError {},
  };
});
import { publicClaimComparisonFixture } from "./studio-public-claim-comparison-test-helpers";
import { buildPublicClaimComparisonRequest } from "./studio-public-claim-comparison-request";
import { preparePublicClaimComparison } from "./studio-public-claim-comparison";
import {
  preparePublicComparisonTransportBoundary,
  requireSyntheticComparisonDriver,
  comparisonSyntheticWireKey,
  type SyntheticComparisonHooks,
} from "./studio-public-claim-comparison-transport";
import {
  createSyntheticComparisonSdkDriver,
  type SyntheticComparisonSdkOptions,
} from "./studio-public-claim-comparison-sdk-adapter";
import { providerTransportSdkOptions } from "./studio-plan-quality-provider-sdk-options";
let environment: NodeJS.ProcessEnv;
const forbidden = vi.fn(() => {
  throw Error("external/config forbidden");
});
beforeEach(() => {
  environment = process.env;
  process.env = new Proxy(environment, {
    get(t, k, r) {
      if (typeof k === "string" && /^(OPENAI|VENTURE_|KOSIS)/.test(k)) return forbidden();
      return Reflect.get(t, k, r);
    },
  });
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  process.env = environment;
  vi.unstubAllGlobals();
  expect(forbidden).not.toHaveBeenCalled();
});
function boundary() {
  const f = publicClaimComparisonFixture(2);
  const command = {
    requestVersion: "public-claim-comparison-request-v1",
    model: "synthetic-model",
    selection: f.select(),
  };
  const request = buildPublicClaimComparisonRequest(f.company, command);
  return preparePublicComparisonTransportBoundary({
    command,
    context: JSON.stringify(preparePublicClaimComparison(f.company, command.selection)),
    identity: request.identity,
  });
}
it("4I24 SDK-shaped adapter stays lazy and passes exact frozen body and fixed passive options", async () => {
  const b = boundary(),
    network = vi.fn(async () => new Response("{}"));
  let options!: SyntheticComparisonSdkOptions;
  const create = vi.fn(async (body) => body);
  const factory = vi.fn((o: SyntheticComparisonSdkOptions) => {
    options = o;
    return { responses: { create } };
  });
  const token = createSyntheticComparisonSdkDriver(factory, network);
  expect(factory).not.toHaveBeenCalled();
  const fetch = vi.fn(async () => new Response("{}"));
  const sdk = vi.fn(async (invoke, suppliedNetwork) => {
    expect(suppliedNetwork).toBe(network);
    expect(await invoke(fetch)).toBe(b.body);
  });
  await requireSyntheticComparisonDriver(token)(b, {
    sdk,
    start: forbidden,
    markUnknown: forbidden,
  });
  expect(sdk).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(b.body);
  expect(JSON.stringify(b.body)).toBe(b.rawBody);
  expect(options).toEqual({
    ...providerTransportSdkOptions,
    apiKey: comparisonSyntheticWireKey,
    fetch,
  });
  expect(options).toMatchObject({
    maxRetries: 0,
    timeout: 120000,
    logLevel: "off",
    fetchOptions: { redirect: "error" },
  });
  expect(Object.isFrozen(options)).toBe(true);
  expect(Object.isFrozen(options.fetchOptions)).toBe(true);
  expect(Object.isFrozen(b.body.input)).toBe(true);
  for (const k of ["service_tier", "background", "stream", "truncation"])
    expect(b.body).not.toHaveProperty(k);
  expect(b.requestedTier).toBeNull();
  expect(network).not.toHaveBeenCalled();
});
it("4I24 adapter sends Response back to SDK-shaped parsing without substituting decoded JSON", async () => {
  const b = boundary(),
    raw = new Response(JSON.stringify({ id: "shape-only" }));
  const fetch = vi.fn(async () => raw),
    decoded = vi.fn();
  const token = createSyntheticComparisonSdkDriver(
    (o) => ({
      responses: {
        create: async (body) => {
          const received = await o.fetch(b.destination, { body: JSON.stringify(body) });
          expect(received).toBe(raw);
          const value = await received.json();
          decoded(value);
          return value;
        },
      },
    }),
    async () => raw,
  );
  let seen: unknown;
  const hooks: SyntheticComparisonHooks = {
    start: forbidden,
    markUnknown: forbidden,
    sdk: async (invoke) => {
      seen = await invoke(fetch);
    },
  };
  await requireSyntheticComparisonDriver(token)(b, hooks);
  expect(seen).toEqual({ id: "shape-only" });
  expect(decoded).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
for (const bad of ["factory", "network", "extra"] as const)
  it("4I24 rejects invalid synthetic adapter constructor " + bad, () => {
    const factory = () => ({ responses: { create: async () => ({}) } }),
      network = async () => new Response("{}");
    expect(() =>
      Reflect.apply(
        createSyntheticComparisonSdkDriver,
        undefined,
        bad === "extra"
          ? [factory, network, {}]
          : bad === "factory"
            ? [{}, network]
            : [factory, {}],
      ),
    ).toThrow(/SYNTHETIC_SDK/);
  });
it("4I24 SDK-shaped token cannot be restored or copied into a driver capability", () => {
  const token = createSyntheticComparisonSdkDriver(
    () => ({ responses: { create: async () => ({}) } }),
    async () => new Response("{}"),
  );
  for (const fake of [{ ...token }, JSON.parse(JSON.stringify(token)), Object.create(token)])
    expect(() => requireSyntheticComparisonDriver(fake)).toThrow(/SYNTHETIC_DRIVER/);
});
