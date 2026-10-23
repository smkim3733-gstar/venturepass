import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdtempSync, writeFileSync, readFileSync, linkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("IO forbidden");
  }),
);
vi.mock("node:sqlite", forbidden);
vi.mock("openai", forbidden);
// Real policy schemas/audits are exercised by the SQL integration, independently of
// path/encoding/size checks below. No operational policy is invented by this test.
vi.mock("./studio-comparison-execution-approval", () => ({
  comparisonExecutionSettingsSchema: z
    .object({
      companyId: z.string(),
      basis: z.object({ provenance: z.string() }),
      usagePolicy: z.object({ provenance: z.string() }),
    })
    .strict(),
}));
import { readComparisonExecutionInputFile } from "./studio-comparison-execution-input-file";
const id = "4900300f-313a-4114-bbf5-5b0d33b7c824",
  roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "venturepass-input-file-"));
  roots.push(root);
  const file = join(root, "reviewed-input.json"),
    value = {
      inputVersion: 1,
      databaseInstanceId: id,
      settings: {
        companyId: id,
        basis: { provenance: "official-reviewed" },
        usagePolicy: { provenance: "official-reviewed" },
      },
    };
  writeFileSync(file, JSON.stringify(value));
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_INPUT_FILE", file);
  vi.stubGlobal("fetch", forbidden);
  return { root, control: join(root, "control"), file, value };
}
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + "\\")) throw Error("unsafe test cleanup");
    rmSync(root, { recursive: true });
  }
});
it("reads an explicit existing file without writing and fingerprints exact bytes", () => {
  const f = fixture(),
    before = readFileSync(f.file);
  const value = readComparisonExecutionInputFile(f.control, id)!;
  expect(value.settings.companyId).toBe(id);
  expect(readFileSync(f.file)).toEqual(before);
  writeFileSync(f.file, JSON.stringify(f.value) + "\n");
  expect(readComparisonExecutionInputFile(f.control, id)!.sha256).not.toBe(value.sha256);
});
it("no setting creates or reads no implicit file", () => {
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_INPUT_FILE", "");
  expect(readComparisonExecutionInputFile("missing-control", id)).toBeNull();
});
it("rejects wrong directory, relative paths, other database and synthetic provenance", () => {
  const f = fixture();
  expect(() => readComparisonExecutionInputFile(join(f.root, "other", "control"), id)).toThrow();
  expect(() =>
    readComparisonExecutionInputFile(f.control, "5900300f-313a-4114-bbf5-5b0d33b7c824"),
  ).toThrow();
  f.value.settings.basis.provenance = "synthetic-test";
  writeFileSync(f.file, JSON.stringify(f.value));
  expect(() => readComparisonExecutionInputFile(f.control, id)).toThrow();
  vi.stubEnv("VENTUREPASS_COMPARISON_EXECUTION_INPUT_FILE", "relative.json");
  expect(() => readComparisonExecutionInputFile(f.control, id)).toThrow();
});
it("rejects extra fields, invalid UTF8, oversize and hardlinked files", () => {
  const f = fixture();
  for (const bytes of [
    JSON.stringify({ ...f.value, consent: true }),
    Buffer.from([255]),
    " ".repeat(128 * 1024 + 1),
  ]) {
    writeFileSync(f.file, bytes);
    expect(() => readComparisonExecutionInputFile(f.control, id)).toThrow();
  }
  writeFileSync(f.file, JSON.stringify(f.value));
  linkSync(f.file, join(f.root, "alias.json"));
  expect(() => readComparisonExecutionInputFile(f.control, id)).toThrow();
});
