import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("SDK/network forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
import { publicClaimComparisonFixture } from "./studio-public-claim-comparison-test-helpers";
import { buildPublicClaimComparisonRequest } from "./studio-public-claim-comparison-request";
import { preparePublicClaimComparison } from "./studio-public-claim-comparison";
import {
  preparePublicComparisonTransportBoundary,
  createSyntheticComparisonDriver,
  requireSyntheticComparisonDriver,
} from "./studio-public-claim-comparison-transport";
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  environment = process.env;
  process.env = new Proxy(environment, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(OPENAI|VENTURE_|KOSIS)/.test(key))
        throw Error("config forbidden");
      return Reflect.get(target, key, receiver);
    },
  });
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  process.env = environment;
  vi.unstubAllGlobals();
  expect(forbidden).not.toHaveBeenCalled();
});
function input() {
  const f = publicClaimComparisonFixture(2);
  const command = {
    requestVersion: "public-claim-comparison-request-v1",
    model: "synthetic-model",
    selection: f.select(),
  };
  const r = buildPublicClaimComparisonRequest(f.company, command);
  return {
    command,
    context: JSON.stringify(preparePublicClaimComparison(f.company, command.selection)),
    identity: r.identity,
  };
}
it("4I22 passive comparison boundary reconstructs exact request bytes and keeps omissions", () => {
  const i = input(),
    b = preparePublicComparisonTransportBoundary(i);
  expect(Object.isFrozen(b)).toBe(true);
  expect(b).toMatchObject({
    source: "supplied-comparison-transport-boundary",
    requestedTier: null,
    dispatchAllowed: false,
    maxCalls: 1,
    automaticRetryLimit: 0,
    timeoutMs: 120000,
  });
  const body = JSON.parse(b.rawBody);
  expect(body).toMatchObject({ model: "synthetic-model", store: false, max_output_tokens: 16000 });
  for (const key of ["service_tier", "background", "stream", "truncation"])
    expect(body).not.toHaveProperty(key);
  expect(preparePublicComparisonTransportBoundary(structuredClone(i))).toEqual(b);
});
for (const fault of [
  "extra",
  "getter",
  "toJSON",
  "cycle",
  "oversize",
  "identity",
  "context",
  "model",
] as const)
  it("4I22 passive boundary rejects " + fault + " without external I/O", () => {
    const i = input();
    let value: unknown = i;
    if (fault === "extra") value = { ...i, apiKey: "not accepted" };
    if (fault === "getter")
      value = Object.defineProperty({ ...i }, "context", {
        get() {
          throw Error("getter executed");
        },
      });
    if (fault === "toJSON") value = { ...i, toJSON: () => i };
    if (fault === "cycle") {
      const cyclic: Record<string, unknown> = { ...i };
      cyclic.loop = cyclic;
      value = cyclic;
    }
    if (fault === "oversize") i.context = "x".repeat(8 * 1024 * 1024);
    if (fault === "identity") i.identity.rawBodySha256 = "0".repeat(64);
    if (fault === "context") i.context = "{}";
    if (fault === "model") i.command.model = "changed";
    expect(() => preparePublicComparisonTransportBoundary(value)).toThrow();
  });
it("4I22 fixture token cannot be forged, spread or restored from JSON", () => {
  const callback = async () => {};
  const token = createSyntheticComparisonDriver(callback);
  expect(requireSyntheticComparisonDriver(token)).toBe(callback);
  for (const forged of [{ ...token }, JSON.parse(JSON.stringify(token)), Object.create(token)])
    expect(() => requireSyntheticComparisonDriver(forged)).toThrow(/SYNTHETIC_DRIVER/);
});
