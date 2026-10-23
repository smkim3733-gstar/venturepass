import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ driver: undefined as unknown, construct: vi.fn() }));
vi.mock("./studio-public-claim-comparison-database-v11", () => ({
  createProviderPublicComparisonExecution(session: unknown, guard: unknown, driver: unknown) {
    state.construct(session, guard);
    state.driver = driver;
    return Object.freeze({ kind: "owned-execution-test" });
  },
}));
import { createPublicComparisonProviderExecution } from "./studio-public-claim-comparison-provider";
import {
  requireComparisonProviderDriver,
  type ComparisonProviderDriver,
} from "./studio-comparison-provider-driver";
import { preparePublicComparisonTransportBoundary } from "./studio-public-claim-comparison-transport";
import { comparisonReviewTestFixture } from "./studio-public-claim-comparison-review-test-helpers";
import type { ComparisonStorageSession } from "./studio-public-comparison-storage-witness";
import type { ComparisonCompanyGuard } from "./studio-public-comparison-company-guard";
const apiKey = "sk-synthetic-comparison-offline-credential";
const selection = {
  databaseInstanceId: "4900300f-313a-4114-bbf5-5b0d33b7c824",
  environment: "production" as const,
  scopeId: "candidate-quality-provider-v2-live" as const,
};
const session = Object.freeze({ kind: "comparison-storage-session" }) as ComparisonStorageSession;
const guard = Object.freeze({}) as ComparisonCompanyGuard;
const external = vi.fn(() => {
  throw Error("external fetch forbidden");
});
afterEach(() => {
  expect(external).not.toHaveBeenCalled();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function setup() {
  vi.stubGlobal("fetch", external);
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", "");
  const network = vi.fn(
    async () =>
      new Response(JSON.stringify({ id: "offline-response", object: "response", output: [] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  const assertCurrent = vi.fn();
  const dependencies = { apiKey, selection: { ...selection }, network, assertCurrent };
  const execution = createPublicComparisonProviderExecution(session, guard, dependencies);
  const driver = requireComparisonProviderDriver(state.driver as ComparisonProviderDriver);
  return { execution, driver, network, assertCurrent, dependencies };
}
function boundary() {
  const f = comparisonReviewTestFixture();
  return preparePublicComparisonTransportBoundary({
    command: f.request.command,
    identity: f.request.identity,
    context: JSON.stringify(f.prepared),
  });
}
it("construction is passive and only the SQL owner receives a nonserializable driver identity", () => {
  const t = setup();
  expect(t.network).not.toHaveBeenCalled();
  expect(t.assertCurrent).not.toHaveBeenCalled();
  expect(state.construct).toHaveBeenCalledExactlyOnceWith(session, guard);
  expect(JSON.stringify(t.execution)).not.toContain(apiKey);
  expect(Object.keys(state.driver as object)).toEqual(["kind"]);
  for (const fake of [{ ...(state.driver as object) }, new Proxy(state.driver as object, {})])
    expect(() => requireComparisonProviderDriver(fake as ComparisonProviderDriver)).toThrow(
      "COMPARISON_PROVIDER_DRIVER_INVALID",
    );
});
it("installed SDK serializes the pinned bytes once through the owned fetch with fixed options", async () => {
  const t = setup(),
    b = boundary();
  // Mutating the caller's dependency object cannot change captured credentials or selection.
  t.dependencies.apiKey = "sk-replaced-do-not-use-credential";
  t.dependencies.selection.databaseInstanceId = "5900300f-313a-4114-bbf5-5b0d33b7c824";
  t.driver.assertCurrent(selection);
  const controller = new AbortController();
  let decoded: unknown;
  await t.driver.run(b, {
    sdk: async (invoke, network) => {
      decoded = await invoke(
        (url, input) => network(url, t.driver.snapshotWire(b.rawBody, url, input)),
        { signal: controller.signal },
      );
    },
  });
  expect(t.network).toHaveBeenCalledTimes(1);
  const [url, wire] = t.network.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(b.destination);
  expect(wire.body).toBe(b.rawBody);
  expect(wire).toMatchObject({ method: "POST", redirect: "error" });
  expect(new Headers(wire.headers).get("authorization")).toBe("Bearer " + apiKey);
  expect(new Headers(wire.headers).get("x-stainless-retry-count")).toBe("0");
  expect(decoded).toMatchObject({ id: "offline-response" });
});
it("wrong database selection and revoked configuration cannot enter the provider SDK", async () => {
  const t = setup();
  expect(() =>
    t.driver.assertCurrent({
      ...selection,
      databaseInstanceId: "5900300f-313a-4114-bbf5-5b0d33b7c824",
    }),
  ).toThrow("STORAGE_MISMATCH");
  expect(t.assertCurrent).not.toHaveBeenCalled();
  t.assertCurrent.mockImplementation(() => {
    throw Error("configuration revoked");
  });
  await expect(
    t.driver.run(boundary(), {
      sdk: async (invoke) => {
        await invoke(external, { signal: new AbortController().signal });
      },
    }),
  ).rejects.toThrow("configuration revoked");
  expect(t.network).not.toHaveBeenCalled();
});
it("SDK transport errors never cause an automatic retry", async () => {
  const t = setup(),
    b = boundary();
  t.network.mockRejectedValue(Error("offline network failure"));
  await expect(
    t.driver.run(b, {
      sdk: async (invoke, network) => {
        await invoke((url, input) => network(url, t.driver.snapshotWire(b.rawBody, url, input)), {
          signal: new AbortController().signal,
        });
      },
    }),
  ).rejects.toThrow();
  expect(t.network).toHaveBeenCalledTimes(1);
});
it("wire rejection exposes no credential and prevents substituted destination/body", () => {
  const t = setup();
  for (const url of ["https://foreign.invalid", "https://api.openai.com/v1/responses"])
    expect(() => t.driver.snapshotWire("{}", url, {})).toThrow("PROVIDER_SDK_WIRE_REJECTED");
  expect(t.network).not.toHaveBeenCalled();
});
it("ambient SDK headers are rejected before reaching the supplied network", async () => {
  const t = setup(),
    b = boundary();
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", "x-unapproved: offline-only");
  await expect(
    t.driver.run(b, {
      sdk: async (invoke, network) => {
        await invoke((url, input) => network(url, t.driver.snapshotWire(b.rawBody, url, input)), {
          signal: new AbortController().signal,
        });
      },
    }),
  ).rejects.toThrow();
  expect(t.network).not.toHaveBeenCalled();
});
it("configuration accessors are rejected without invoking them", () => {
  const getter = vi.fn();
  const bad = Object.defineProperty({}, "apiKey", { get: getter });
  expect(() => createPublicComparisonProviderExecution(session, guard, bad as never)).toThrow(
    "CONFIGURATION_INVALID",
  );
  expect(getter).not.toHaveBeenCalled();
  expect(state.construct).not.toHaveBeenCalled();
});
it("asynchronous configuration checks cannot authorize a start", async () => {
  const t = setup();
  t.assertCurrent.mockImplementation(() => Promise.reject(Error("late rejection")));
  expect(() => t.driver.assertCurrent(selection)).toThrow("SYNCHRONOUS_CHECK_REQUIRED");
  await Promise.resolve();
  expect(t.network).not.toHaveBeenCalled();
});
