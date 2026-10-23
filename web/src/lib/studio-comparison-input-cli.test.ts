import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, linkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const core = vi.hoisted(() => vi.fn());
const catalog = vi.hoisted(() => vi.fn());
vi.mock("./studio-comparison-input-preparation", () => ({
  createComparisonInputPreparation: core,
  createComparisonReservationCatalog: catalog,
}));
import {
  parseComparisonInputArguments,
  prepareComparisonInputFile,
  listComparisonInputReservations,
  runComparisonInputCommand,
} from "../../scripts/comparison-input.mjs";
const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "venturepass-input-cli-한글-"));
  roots.push(root);
  const policy = join(root, "policy.json"),
    output = join(root, "prepared.json"),
    id = "4900300f-313a-4114-bbf5-5b0d33b7c824";
  writeFileSync(
    policy,
    JSON.stringify({ basis: { tag: "reviewed" }, usagePolicy: { tag: "reviewed" } }),
  );
  const args = [
    "prepare",
    "--data-root",
    join(root, "data"),
    "--control-dir",
    join(root, "control"),
    "--database-id",
    id,
    "--company-id",
    id,
    "--company-revision",
    "3",
    "--run-id",
    id,
    "--policy-file",
    policy,
    "--output",
    output,
  ];
  const result = {
    document: { inputVersion: 1, settings: { companyId: id } },
    summary: {
      expiresAt: "2099-01-01T00:00:00.000Z",
      transmissionAllowed: false,
      runtimeObserved: false,
    },
  };
  const owner = {
    prepare: vi.fn(() => structuredClone(result)),
    close: vi.fn(() => ({ closed: true })),
  };
  core.mockReturnValue(owner);
  return { root, policy, output, args, result, owner };
}
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + "\\")) throw Error("unsafe test cleanup");
    rmSync(root, { recursive: true });
  }
});
it("exports exact UTF8 input after confirmed cleanup and refuses any existing output", async () => {
  const f = setup(),
    policyBefore = readFileSync(f.policy);
  const result = await prepareComparisonInputFile(f.args);
  expect(result).toMatchObject({
    status: "prepared",
    transmissionAllowed: false,
    outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(f.owner.close).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(f.output, "utf8"))).toEqual(f.result.document);
  expect(readFileSync(f.policy)).toEqual(policyBefore);
  const before = readFileSync(f.output);
  await expect(prepareComparisonInputFile(f.args)).rejects.toThrow("OUTPUT_EXISTS");
  expect(core).toHaveBeenCalledTimes(1);
  expect(readFileSync(f.output)).toEqual(before);
});
it.each(["read", "cleanup", "policy-change", "expired"])(
  "never exports on %s failure",
  async (kind) => {
    const f = setup();
    if (kind === "read")
      f.owner.prepare.mockImplementationOnce(() => {
        throw Error("audit failed");
      });
    if (kind === "cleanup")
      f.owner.close.mockImplementationOnce(() => {
        throw Error("lease retained");
      });
    if (kind === "policy-change")
      f.owner.prepare.mockImplementationOnce(() => {
        writeFileSync(f.policy, "changed");
        return f.result;
      });
    if (kind === "expired") f.result.summary.expiresAt = "2000-01-01T00:00:00.000Z";
    await expect(prepareComparisonInputFile(f.args)).rejects.toThrow();
    expect(f.owner.close).toHaveBeenCalledTimes(1);
    expect(existsSync(f.output)).toBe(false);
  },
);
it.each(["extra", "duplicate", "relative", "revision", "directory", "extension"])(
  "rejects %s arguments before acquiring a reader",
  (kind) => {
    const f = setup(),
      args = [...f.args];
    if (kind === "extra") args.push("--api-key", "never-use");
    if (kind === "duplicate") args[3] = "--data-root";
    if (kind === "relative") args[2] = "relative";
    if (kind === "revision") args[10] = "03";
    if (kind === "directory") args[16] = join(f.root, "control", "input.json");
    if (kind === "extension") args[16] = join(f.root, ".env");
    expect(() => parseComparisonInputArguments(args)).toThrow();
    expect(core).not.toHaveBeenCalled();
  },
);
it("refuses extra policy fields, invalid UTF8, hardlinks and oversized source without a reader", async () => {
  const f = setup();
  for (const bytes of [
    JSON.stringify({ basis: {}, usagePolicy: {}, apiKey: "never-use" }),
    Buffer.from([255]),
    " ".repeat(128 * 1024 + 1),
  ]) {
    writeFileSync(f.policy, bytes);
    await expect(prepareComparisonInputFile(f.args)).rejects.toThrow();
  }
  writeFileSync(f.policy, JSON.stringify({ basis: {}, usagePolicy: {} }));
  linkSync(f.policy, join(f.root, "alias.json"));
  await expect(prepareComparisonInputFile(f.args)).rejects.toThrow();
  expect(core).not.toHaveBeenCalled();
  expect(existsSync(f.output)).toBe(false);
});
it("real CLI help and argument rejection cannot import SQL/SDK or fetch", () => {
  const f = setup(),
    guard = join(f.root, "guard.mjs");
  writeFileSync(
    guard,
    `import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){if(s==='node:sqlite'||s==='openai'||s.startsWith('openai/'))throw Error('FORBIDDEN_IMPORT');return n(s,c);}});
globalThis.fetch=()=>{throw Error('FORBIDDEN_FETCH');};`,
  );
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", pathToFileURL(guard).href, "scripts/comparison-input.mjs", ...args],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      },
    );
  const help = run(["--help"]);
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain("외부 전송 없음");
  const invalid = run(["prepare", "--api-key", "do-not-print-secret"]);
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain("INVALID_ARGUMENTS");
  expect(invalid.stderr).not.toContain("do-not-print-secret");
  expect(help.stderr + invalid.stderr).not.toContain("FORBIDDEN_");
  const badList = run(["list", "--api-key", "do-not-print-secret"]);
  expect(badList.status).toBe(1);
  expect(badList.stderr).toContain("INVALID_ARGUMENTS");
  expect(badList.stderr).not.toMatch(/FORBIDDEN_|do-not-print-secret/);
});

it("lists without a policy or output file and requires explicit run selection for preparation", async () => {
  const f = setup(),
    args = ["list", ...f.args.slice(1, 11)];
  writeFileSync(f.policy, "not a policy");
  const result = {
    kind: "comparison-reservation-catalog",
    reservations: [],
    transmissionAllowed: false,
  };
  const owner = { list: vi.fn(() => result), close: vi.fn(() => ({ closed: true })) };
  catalog.mockReturnValue(owner);
  expect(await runComparisonInputCommand(args)).toEqual(result);
  expect(owner.close).toHaveBeenCalledTimes(1);
  expect(catalog).toHaveBeenCalledWith({
    dataRoot: f.args[2],
    controlDirectory: f.args[4],
    databaseInstanceId: f.args[6],
    companyId: f.args[8],
    companyRevision: 3,
  });
  expect(core).not.toHaveBeenCalled();
  expect(existsSync(f.output)).toBe(false);
  await expect(prepareComparisonInputFile(args)).rejects.toThrow("INVALID_ARGUMENTS");
  await expect(listComparisonInputReservations(f.args)).rejects.toThrow("INVALID_ARGUMENTS");
});
it.each(["read", "cleanup", "unconfirmed-cleanup"])(
  "catalog %s failure never returns a successful list",
  async (kind) => {
    const f = setup(),
      owner = { list: vi.fn(() => ({ reservations: [] })), close: vi.fn(() => ({ closed: true })) };
    catalog.mockReturnValue(owner);
    if (kind === "read")
      owner.list.mockImplementationOnce(() => {
        throw Error("audit failure");
      });
    if (kind === "cleanup")
      owner.close.mockImplementationOnce(() => {
        throw Error("retained lease");
      });
    if (kind === "unconfirmed-cleanup") owner.close.mockReturnValueOnce({ closed: false });
    await expect(runComparisonInputCommand(["list", ...f.args.slice(1, 11)])).rejects.toThrow();
    expect(owner.close).toHaveBeenCalledTimes(1);
    expect(core).not.toHaveBeenCalled();
    expect(existsSync(f.output)).toBe(false);
  },
);
it("list refuses policy/output/run flags, duplicate fields and invalid paths/revisions", () => {
  const f = setup(),
    args = ["list", ...f.args.slice(1, 11)];
  for (const flag of ["run-id", "policy-file", "output"])
    expect(() => parseComparisonInputArguments([...args, "--" + flag, "never-use"])).toThrow(
      "INVALID_ARGUMENTS",
    );
  for (const [index, value] of [
    [3, "--data-root"],
    [2, "relative"],
    [10, "-1"],
    [10, "3.1"],
  ] as const) {
    const invalid = [...args];
    invalid[index] = value;
    expect(() => parseComparisonInputArguments(invalid)).toThrow();
  }
  expect(catalog).not.toHaveBeenCalled();
});
