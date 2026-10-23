import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({
  log: [] as string[],
  fail: "",
  transaction: false,
  companyOptions: undefined as unknown,
  deps: undefined as unknown,
  input: null as null | { file: string; sha256: string; settings: { companyId: string } },
  step(name: string) {
    this.log.push(name);
    if (this.fail === name) throw Error("private failure");
  },
}));
vi.mock("./studio-comparison-execution-input-file", () => ({
  readComparisonExecutionInputFile: () => structuredClone(s.input),
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor(
      public file: string,
      public options: unknown,
    ) {
      s.step("company-open");
      s.companyOptions = options;
    }
    get isTransaction() {
      return s.transaction;
    }
    close() {
      s.step("company-close");
    }
  },
}));
vi.mock("./studio-public-comparison-file-identity", () => ({
  checkComparisonDatabasePath: () => s.step("path-check"),
}));
vi.mock("./studio-comparison-company-capability", () => ({
  recordComparisonCompanyConnection: () => s.step("register"),
  issueComparisonCompanyGuard: () => {
    s.step("guard");
    return { kind: "test-guard" };
  },
  revokeComparisonCompanyGuards: () => s.step("revoke-guard"),
}));
vi.mock("./studio-public-comparison-storage-witness", () => ({
  openComparisonStorageSession: (paths: unknown, selection: unknown) => {
    s.step("session-open");
    return { paths, selection };
  },
  closeComparisonStorageSession: () => s.step("session-close"),
}));
vi.mock("./studio-public-claim-comparison-provider", () => ({
  createPublicComparisonProviderService: (session: unknown, guard: unknown, deps: unknown) => {
    s.step("service-create");
    s.deps = { session, guard, ...(deps as object) };
    return {
      inspect: () => ({ source: "mock-service" }),
      prepareTransmission: (...args: unknown[]) => {
        s.step("prepare-transmission");
        return args;
      },
      execute: async (command: unknown) => {
        (deps as { assertCurrent(): void }).assertCurrent();
        return command;
      },
      previewPostcapture: (selection: unknown) => selection,
      writePostcapture: (...args: unknown[]) => args,
      recover: (selection: unknown) => {
        s.step("recover");
        return selection;
      },
      recoverPostcapture: (...args: unknown[]) => {
        s.step("recover-post");
        return args;
      },
      close: () => s.step("service-close"),
    };
  },
}));
import { createComparisonProviderRuntime } from "./studio-comparison-provider-runtime";
const root = resolve("runtime-test-only", "data");
const control = resolve("runtime-test-only", "control");
const key = "sk-synthetic-runtime-not-a-real-key";
const id = "4900300f-313a-4114-bbf5-5b0d33b7c824";
const network = vi.fn(async () => new Response("offline"));
type Dependencies = {
  apiKey: string;
  network: typeof fetch;
  assertCurrent(): void;
  selection: { databaseInstanceId: string };
  session: {
    paths: { dataRoot: string; studioFile: string; qualityFile: string; controlDirectory: string };
  };
};
beforeEach(() => {
  s.log = [];
  s.fail = "";
  s.transaction = false;
  s.deps = undefined;
  s.input = null;
  s.companyOptions = undefined;
  vi.stubEnv("OPENAI_API_KEY", key);
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", "");
  vi.stubEnv("VENTURE_DATA_DIR", root);
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR", control);
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID", id);
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("configuration construction is passive, private and accepts no injected options", () => {
  const runtime = createComparisonProviderRuntime();
  expect(runtime.inspect()).toMatchObject({
    status: "unused",
    retained: false,
    configuration: "pinned",
    dispatchAllowed: false,
  });
  expect(s.log).toEqual([]);
  expect(network).not.toHaveBeenCalled();
  const view = JSON.stringify(runtime.inspect());
  for (const secret of [key, root, control, id]) expect(view).not.toContain(secret);
  expect(() => (createComparisonProviderRuntime as (...args: unknown[]) => unknown)({})).toThrow(
    "OPTIONS_FORBIDDEN",
  );
  expect(runtime.close()).toMatchObject({ status: "closed", retained: false });
  expect(() => runtime.open()).toThrow("CLOSED");
});
it("one pinned acquisition closes service then session then company and is never reused", () => {
  const runtime = createComparisonProviderRuntime();
  runtime.open();
  runtime.open();
  expect(s.log).toEqual([
    "path-check",
    "company-open",
    "register",
    "guard",
    "session-open",
    "service-create",
  ]);
  const deps = s.deps as Dependencies;
  expect(deps.session.paths).toEqual({
    dataRoot: root,
    studioFile: join(root, "studio.sqlite"),
    qualityFile: join(root, "quality.sqlite"),
    controlDirectory: control,
  });
  expect(deps.selection.databaseInstanceId).toBe(id);
  expect(s.companyOptions).toEqual({ readOnly: false });
  expect(runtime.close()).toMatchObject({ status: "closed", retained: false });
  expect(s.log.slice(-4)).toEqual([
    "service-close",
    "session-close",
    "company-close",
    "revoke-guard",
  ]);
  const log = [...s.log];
  runtime.close();
  expect(s.log).toEqual(log);
  expect(() => runtime.execute({}, {})).toThrow("CLOSED");
});
it.each([
  ["OPENAI_API_KEY", ""],
  ["VENTURE_DATA_DIR", "relative"],
  ["VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR", root],
  ["VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID", "invalid"],
  ["OPENAI_CUSTOM_HEADERS", "x-extra: refused"],
])("invalid %s cannot acquire any storage", (name, value) => {
  vi.stubEnv(name, value);
  expect(() => createComparisonProviderRuntime()).toThrow("CONFIGURATION_UNAVAILABLE");
  expect(s.log).toEqual([]);
});
it.each([
  ["OPENAI_API_KEY", "sk-changed-synthetic-credential"],
  ["VENTURE_DATA_DIR", resolve("runtime-test-only", "other")],
  ["VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR", resolve("runtime-test-only", "other-control")],
  ["VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID", "5900300f-313a-4114-bbf5-5b0d33b7c824"],
])(
  "%s drift revokes new sends monotonically but retains original postcapture and cleanup",
  async (name, value) => {
    const previous = process.env[name];
    const runtime = createComparisonProviderRuntime();
    runtime.open();
    vi.stubEnv(name, value);
    await expect(runtime.execute({}, {})).rejects.toThrow("REVOKED");
    vi.stubEnv(name, previous);
    await expect(runtime.execute({}, {})).rejects.toThrow("REVOKED");
    expect(runtime.inspect().configuration).toBe("revoked");
    expect(runtime.previewPostcapture("original")).toBe("original");
    expect(runtime.writePostcapture("record-result", "command", "current")).toEqual([
      "record-result",
      "command",
      "current",
    ]);
    expect(runtime.recover("original")).toBe("original");
    expect(runtime.close().status).toBe("closed");
    expect(network).not.toHaveBeenCalled();
  },
);
it("drift before first acquisition blocks SQL and the captured network cannot be substituted", async () => {
  const runtime = createComparisonProviderRuntime();
  const replacement = vi.fn(() => {
    throw Error("replacement forbidden");
  });
  vi.stubGlobal("fetch", replacement);
  runtime.open();
  await (s.deps as Dependencies).network("https://offline.invalid");
  expect(network).toHaveBeenCalledOnce();
  expect(replacement).not.toHaveBeenCalled();
  runtime.close();
  s.log = [];
  const unused = createComparisonProviderRuntime();
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(() => unused.open()).toThrow("REVOKED");
  expect(s.log).toEqual([]);
  expect(unused.close().status).toBe("closed");
});
it.each(["company-open", "guard", "session-open", "service-create"])(
  "partial acquisition failure at %s retains exact resources without retry",
  (point) => {
    const runtime = createComparisonProviderRuntime();
    s.fail = point;
    expect(() => runtime.open()).toThrow("ACQUISITION_FAILED");
    const log = [...s.log];
    s.fail = "";
    expect(() => runtime.open()).toThrow("CLEANUP_REQUIRED");
    expect(s.log).toEqual(log);
    expect(runtime.close()).toMatchObject({ status: "closed", retained: false });
    expect(s.log.filter((x) => x === "company-open")).toHaveLength(1);
  },
);
it.each(["service-close", "session-close", "company-close"])(
  "failed %s preserves the remaining owner for explicit close retry",
  (point) => {
    const runtime = createComparisonProviderRuntime();
    runtime.open();
    s.fail = point;
    expect(runtime.close()).toMatchObject({ status: "draining", retained: true });
    expect(() => runtime.open()).toThrow("CLOSED");
    if (point === "service-close") {
      expect(runtime.recover("same")).toBe("same");
      runtime.recoverPostcapture("record-result", "original");
      expect(s.log).not.toContain("session-close");
    }
    s.fail = "";
    expect(runtime.close()).toMatchObject({ status: "closed", retained: false });
    expect(s.log.filter((x) => x === "company-open")).toHaveLength(1);
  },
);
it("unowned company transaction is never rolled back or closed", () => {
  const runtime = createComparisonProviderRuntime();
  runtime.open();
  s.transaction = true;
  expect(runtime.close().status).toBe("draining");
  expect(s.log).not.toContain("company-close");
  s.transaction = false;
  expect(runtime.close().status).toBe("closed");
});

it("approval preparation requires current configuration even after storage was acquired", () => {
  const runtime = createComparisonProviderRuntime();
  expect(runtime.prepareTransmission("query", "basis", "policy", "time")).toEqual([
    "query",
    "basis",
    "policy",
    "time",
  ]);
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(() => runtime.prepareTransmission("query", "basis", "policy", "time")).toThrow("REVOKED");
  expect(s.log.filter((x) => x === "prepare-transmission")).toHaveLength(1);
  expect(runtime.close().status).toBe("closed");
});

it("configured input is copied, absence is unavailable and any file drift revokes final send guards", () => {
  const empty = createComparisonProviderRuntime();
  expect(() => empty.approvalSettings()).toThrow("INPUT_UNAVAILABLE");
  expect(empty.close().status).toBe("closed");
  s.input = { file: "synthetic-input", sha256: "original", settings: { companyId: id } };
  const runtime = createComparisonProviderRuntime();
  const copied = runtime.approvalSettings();
  copied.companyId = "changed";
  expect(runtime.approvalSettings().companyId).toBe(id);
  expect(s.log).toEqual([]);
  runtime.open();
  const deps = s.deps as Dependencies;
  s.input.sha256 = "changed";
  expect(() => deps.assertCurrent()).toThrow("REVOKED");
  expect(() => runtime.approvalSettings()).toThrow("REVOKED");
  s.input.sha256 = "original";
  expect(() => deps.assertCurrent()).toThrow("REVOKED");
  expect(runtime.close().status).toBe("closed");
});
