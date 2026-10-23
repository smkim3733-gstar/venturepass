import { describe, expect, it, vi } from "vitest";
import {
  comparisonBackupHelp,
  parseComparisonBackupArguments,
  runComparisonBackupCommand,
} from "../../scripts/comparison-backup.mjs";
import { resolve } from "node:path";

const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("SQL forbidden");
  }),
);
vi.mock("./studio-comparison-backup", () => ({
  backupComparisonData: forbidden,
  verifyComparisonBackup: forbidden,
  restoreComparisonCandidate: forbidden,
}));
const id = "4900300f-313a-4114-bbf5-5b0d33b7c824";
const common = ["--database-id", id, "--storage-version", "13"];
describe("comparison backup CLI arguments", () => {
  it("shows help without opening any database", async () => {
    expect(await runComparisonBackupCommand(["--help"])).toEqual({ help: comparisonBackupHelp });
    expect(forbidden).not.toHaveBeenCalled();
  });
  for (const command of ["verify", "restore-candidate", "backup"]) {
    it("accepts explicit " + command + " selection and absolute paths", () => {
      const paths =
        command === "backup"
          ? [
              "--data-root",
              resolve("synthetic/data"),
              "--control-dir",
              resolve("synthetic/control"),
            ]
          : ["--archive", resolve("synthetic/archive")];
      if (command !== "verify") paths.push("--destination", resolve("synthetic/new"));
      expect(parseComparisonBackupArguments([command, ...common, ...paths])).toMatchObject({
        command,
        "database-id": id,
        "storage-version": "13",
      });
    });
  }
  for (const args of [
    [],
    ["restore"],
    ["verify", ...common],
    ["verify", ...common, "--archive", "relative"],
    ["verify", ...common, "--archive", resolve("archive"), "--force", "true"],
    ["verify", ...common, "--database-id", id],
    ["verify", "--database-id", id, "--storage-version", "14", "--archive", resolve("archive")],
    [
      "verify",
      "--database-id",
      "invalid",
      "--storage-version",
      "13",
      "--archive",
      resolve("archive"),
    ],
  ]) {
    it("refuses invalid input before importing storage " + JSON.stringify(args), async () => {
      await expect(runComparisonBackupCommand(args)).rejects.toThrow();
      expect(forbidden).not.toHaveBeenCalled();
    });
  }
});
