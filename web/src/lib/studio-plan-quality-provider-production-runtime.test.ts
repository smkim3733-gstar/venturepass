import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External access forbidden");
  }),
);
vi.mock("openai", () => ({ default: forbidden }));
import {
  createProviderProductionRuntime,
  inspectProviderProductionRuntime,
  inspectProviderProductionWire,
  requireProviderProductionRuntime,
  revokeProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import { snapshotProviderSdkWire } from "./studio-plan-quality-provider-sdk-wire";
import { generationDispatchFixture } from "./studio-plan-quality-provider-dispatch-test-helpers";
import { prepareProviderGenerationDispatch } from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderObservationPrepared } from "./studio-provider-observation";

const key = "sk-synthetic-production-runtime-test-only";
const url = "https://api.openai.com/v1/responses";
let prepared: ProviderObservationPrepared, encoded: string;
beforeAll(() => {
  const plan = prepareProviderGenerationDispatch(generationDispatchFixture().input);
  if (plan.status !== "prepared") throw Error(plan.reason);
  prepared = plan.plan.request;
  encoded = JSON.stringify(prepared);
});
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", key);
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function wire() {
  return {
    method: "POST",
    body: prepared.rawBody,
    redirect: "error",
    signal: new AbortController().signal,
    headers: new Headers({
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-stainless-retry-count": "0",
    }),
  };
}
it("keeps credentials private and does not grant write/send authority or authenticate billing", () => {
  const runtime = createProviderProductionRuntime();
  expect(Object.getPrototypeOf(runtime)).toBeNull();
  expect(Object.isFrozen(runtime)).toBe(true);
  expect(Reflect.ownKeys(runtime)).toEqual(["kind", "version"]);
  const description = inspectProviderProductionRuntime(runtime);
  expect(description).toMatchObject({
    status: "configured",
    credentialAuthenticated: false,
    dispatchAllowed: false,
    recordingAllowed: false,
  });
  expect(requireProviderProductionRuntime(runtime)).toBe(runtime);
  for (const fake of [
    JSON.parse(JSON.stringify(runtime)),
    { ...runtime },
    new Proxy(runtime, {}),
  ]) {
    expect(inspectProviderProductionRuntime(fake)).toMatchObject({ status: "unavailable" });
    expect(() => requireProviderProductionRuntime(fake)).toThrow(
      "PROVIDER_PRODUCTION_RUNTIME_UNAVAILABLE",
    );
  }
  expect(JSON.stringify([runtime, description])).not.toContain(key);
});
it("does not evaluate properties on a forged runtime", () => {
  const read = vi.fn(() => {
    throw Error(key);
  });
  const fake = new Proxy({}, { get: read, ownKeys: read });
  expect(inspectProviderProductionRuntime(fake)).toMatchObject({ reason: "unrecognized-runtime" });
  expect(revokeProviderProductionRuntime(fake)).toBe(false);
  expect(read).not.toHaveBeenCalled();
});
it("revokes an unreadable directory without leaking the lookup error", () => {
  vi.stubEnv("VENTURE_DATA_DIR", undefined);
  const runtime = createProviderProductionRuntime();
  const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
    throw Error(key);
  });
  try {
    expect(inspectProviderProductionRuntime(runtime)).toMatchObject({
      status: "unavailable",
      reason: "revoked",
    });
  } finally {
    cwd.mockRestore();
  }
  expect(inspectProviderProductionRuntime(runtime)).toMatchObject({
    status: "unavailable",
    reason: "revoked",
  });
});
it.each([
  undefined,
  "",
  "not-a-key",
  "sk-short",
  "sk-synthetic\r\nAuthorization-secret",
  `sk-${"a".repeat(1025)}`,
])("rejects unavailable/malformed server credentials (%#) with fixed errors", (invalid) => {
  vi.stubEnv("OPENAI_API_KEY", invalid);
  expect(() => createProviderProductionRuntime()).toThrow(
    /^PROVIDER_PRODUCTION_CREDENTIAL_UNAVAILABLE$/,
  );
});
it("forbids caller credential/options and ignores ambient URL/project/model overrides", () => {
  const factory = createProviderProductionRuntime as (...args: unknown[]) => unknown;
  expect(() => factory({ apiKey: key, fetch: forbidden })).toThrow(
    /^PROVIDER_PRODUCTION_RUNTIME_OPTIONS_FORBIDDEN$/,
  );
  vi.stubEnv("OPENAI_BASE_URL", "https://attacker.invalid/v1");
  vi.stubEnv("OPENAI_ORG_ID", "injected-org");
  vi.stubEnv("OPENAI_PROJECT_ID", "injected-project");
  vi.stubEnv("OPENAI_MODEL", "injected-model");
  expect(inspectProviderProductionRuntime(createProviderProductionRuntime())).toMatchObject({
    sdkOptions: {
      baseURL: "https://api.openai.com/v1",
      maxRetries: 0,
      timeout: 120000,
      logLevel: "off",
      organization: null,
      project: null,
      fetchOptions: { redirect: "error" },
    },
  });
});
it("keeps the captured credential private until revocation without exposing a transport", () => {
  const runtime = createProviderProductionRuntime();
  const accepted = inspectProviderProductionWire(runtime, encoded, url, wire());
  expect(accepted).toMatchObject({
    status: "wire-compatible-not-authorized",
    dispatchAllowed: false,
    recordingAllowed: false,
    approvalVerified: false,
    newCommitOwnershipVerified: false,
    request: prepared.request,
  });
  expect(JSON.stringify(accepted)).not.toContain(key);
  expect(accepted).not.toHaveProperty("rawBody");
  expect(accepted).not.toHaveProperty("headers");
  const changed = wire();
  changed.headers.set("authorization", "Bearer sk-synthetic-rotated-key-not-used");
  expect(inspectProviderProductionWire(runtime, encoded, url, changed)).toMatchObject({
    reason: "wire-incompatible",
  });
  expect(revokeProviderProductionRuntime(runtime)).toBe(true);
  expect(revokeProviderProductionRuntime(runtime)).toBe(false);
  expect(inspectProviderProductionRuntime(runtime)).toMatchObject({
    status: "unavailable",
    reason: "revoked",
  });
  expect(inspectProviderProductionWire(runtime, encoded, url, wire())).toMatchObject({
    reason: "runtime-unavailable",
  });
});
it.each(["credential", "directory"])(
  "monotonically revokes on observed %s drift instead of adopting ambient changes",
  (kind) => {
    vi.stubEnv("VENTURE_DATA_DIR", "synthetic-original-directory");
    const runtime = createProviderProductionRuntime();
    if (kind === "credential") vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-rotated-key-not-used");
    else vi.stubEnv("VENTURE_DATA_DIR", "synthetic-changed-directory");
    expect(inspectProviderProductionRuntime(runtime)).toMatchObject({
      status: "unavailable",
      reason: "revoked",
    });
    vi.stubEnv("OPENAI_API_KEY", key);
    vi.stubEnv("VENTURE_DATA_DIR", "synthetic-original-directory");
    expect(inspectProviderProductionWire(runtime, encoded, url, wire())).toMatchObject({
      reason: "runtime-unavailable",
    });
    expect(() => requireProviderProductionRuntime(runtime)).toThrow(
      "PROVIDER_PRODUCTION_RUNTIME_UNAVAILABLE",
    );
  },
);
it.each([
  "url",
  "method",
  "body",
  "redirect",
  "signal",
  "auth",
  "retry",
  "unknown-header",
  "extra",
  "symbol",
  "hidden",
  "accessor",
])("rejects %s wire changes with no raw SDK/secret error content", (change) => {
  const runtime = createProviderProductionRuntime();
  const input: Record<string, unknown> = wire();
  const headers = input.headers as Headers;
  const getter = vi.fn(() => {
    throw Error(key);
  });
  if (change === "method") input.method = "GET";
  if (change === "body") input.body = `${prepared.rawBody} `;
  if (change === "redirect") input.redirect = "follow";
  if (change === "signal") input.signal = {};
  if (change === "auth") headers.set("authorization", "Bearer wrong-key");
  if (change === "retry") headers.set("x-stainless-retry-count", "1");
  if (change === "unknown-header") headers.set("openai-project", "override");
  if (change === "extra") input.agent = {};
  if (change === "symbol") Object.defineProperty(input, Symbol("extra"), { value: true });
  if (change === "hidden") Object.defineProperty(input, "hidden", { value: true });
  if (change === "accessor") Object.defineProperty(input, "body", { get: getter });
  const target = change === "url" ? "https://attacker.invalid/v1/responses" : url;
  expect(inspectProviderProductionWire(runtime, encoded, target, input)).toEqual({
    status: "refused",
    reason: "wire-incompatible",
    dispatchAllowed: false,
  });
  expect(() => snapshotProviderSdkWire(prepared.rawBody, key, target, input)).toThrow(
    /^PROVIDER_SDK_WIRE_REJECTED$/,
  );
  expect(getter).not.toHaveBeenCalled();
});
it("rejects changed encoded body and catches hostile header exceptions without disclosure", () => {
  const runtime = createProviderProductionRuntime();
  expect(
    inspectProviderProductionWire(
      runtime,
      JSON.stringify({ ...prepared, rawBody: "{}" }),
      url,
      wire(),
    ),
  ).toMatchObject({ reason: "request-invalid" });
  const headers = {
    [Symbol.iterator]() {
      throw Error(key);
    },
  };
  const result = inspectProviderProductionWire(runtime, encoded, url, { ...wire(), headers });
  expect(result).toMatchObject({ reason: "wire-incompatible" });
  expect(JSON.stringify(result)).not.toContain(key);
});
it("rechecks revocation after header iteration and snapshots mutable input headers", () => {
  const runtime = createProviderProductionRuntime();
  const input = wire();
  const snapshot = snapshotProviderSdkWire(prepared.rawBody, key, url, input);
  input.headers.set("authorization", "changed-after-validation");
  expect(new Headers(snapshot.headers).get("authorization")).toBe(`Bearer ${key}`);
  const headers = {
    *[Symbol.iterator]() {
      revokeProviderProductionRuntime(runtime);
      yield* wire().headers.entries();
    },
  };
  expect(
    inspectProviderProductionWire(runtime, encoded, url, { ...wire(), headers }),
  ).toMatchObject({ reason: "runtime-unavailable" });
});
