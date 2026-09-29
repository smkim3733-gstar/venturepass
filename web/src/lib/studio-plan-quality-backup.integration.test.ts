import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
vi.mock("server-only", () => ({}));
import { backupQualityData, restoreQualityData } from "../../scripts/local-data-quality.mjs";

const fault = vi.hoisted(() => ({ partialCopy: false }));
vi.mock("../../scripts/local-data-files.mjs", async (original) => {
  const actual = await original<typeof import("../../scripts/local-data-files.mjs")>();
  return {
    ...actual,
    readSafe: (...args: Parameters<typeof actual.readSafe>) => {
      const destination = args[2];
      if (
        fault.partialCopy &&
        typeof destination === "string" &&
        destination.includes("quality-restore-")
      ) {
        return actual.readSafe(args[0], args[1], destination, args[3], (identity) => {
          args[4]?.(identity);
          writeFileSync(destination, "SYNTHETIC PARTIAL RESTORE");
          throw new actual.DataToolError("FILE_CHANGED");
        });
      }
      return actual.readSafe(...args);
    },
  };
});

const script = resolve("scripts/local-data.mjs"),
  secret = "SYNTHETIC_QUALITY_SECRET_NEVER_PRINT";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
let directory: string, source: string, store: PlanQualityStore;
const external = vi.fn(() => {
  throw new Error("No external AI or customer IO");
});
const timeout = process.platform === "win32" ? 120000 : 30000;
beforeEach(() => {
  fault.partialCopy = false;
  external.mockClear();
  vi.stubGlobal("fetch", external);
  directory = mkdtempSync(join(tmpdir(), "venture-quality-backup-test-"));
  source = join(directory, "source");
  mkdirSync(source);
  writeFileSync(join(source, "studio.sqlite"), secret);
  mkdirSync(join(source, "originals"));
  writeFileSync(join(source, "originals", "sentinel.bin"), secret);
  store = new PlanQualityStore(source);
}, 15000);
afterEach(() => {
  expect(external).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  store.close();
  expect(readFileSync(join(source, "studio.sqlite"), "utf8")).toBe(secret);
  expect(readFileSync(join(source, "originals", "sentinel.bin"), "utf8")).toBe(secret);
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-quality-backup-test-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
function seeded() {
  const run = store.create({
    title: "합성 이력 보존 시험",
    manifestDigest: store.list().manifestDigest,
    clientRequestId: randomUUID(),
  }).run;
  store.save(run.id, { revision: 0, clientRequestId: randomUUID(), record: run.records[0] });
  return store.get(run.id);
}
function cli(action: string, from: string, destination?: string, success = true) {
  const result = spawnSync(
    process.execPath,
    [script, action, "--source", from, ...(destination ? ["--destination", destination] : [])],
    {
      windowsHide: true,
      timeout: 110000,
      maxBuffer: 4096,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        VENTURE_DATA_DIR: join(directory, "must-not-read"),
        OPENAI_API_KEY: secret,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain(directory);
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(existsSync(join(directory, "must-not-read"))).toBe(false);
  expect(result.status, result.stdout + result.stderr).toBe(success ? 0 : 1);
  const value = JSON.parse((success ? result.stdout : result.stderr).trim());
  if (success)
    expect(value).toMatchObject({
      ok: true,
      scope: "quality-records-structure-and-bytes-only",
      companyDataChanged: false,
      switched: false,
    });
  else expect(value).toMatchObject({ ok: false, completed: false, overwritten: false });
  return value;
}
describe("separate quality backup/restore CLI", () => {
  it(
    "removes only its private partial copy after an interrupted restore",
    async () => {
      seeded();
      const backup = join(directory, "backup");
      await backupQualityData(source, backup);
      const destination = join(directory, "destination");
      mkdirSync(destination);
      writeFileSync(join(destination, "studio.sqlite"), "KEEP COMPANY");
      fault.partialCopy = true;
      expect(() => restoreQualityData(backup, destination)).toThrowError(
        expect.objectContaining({ code: "FILE_CHANGED" }),
      );
      expect(readFileSync(join(destination, "studio.sqlite"), "utf8")).toBe("KEEP COMPANY");
      expect(readdirSync(destination)).toEqual(["studio.sqlite"]);
    },
    timeout,
  );
  it(
    "preserves actual fixed inputs, every revision and nonce while leaving both company databases/originals untouched",
    () => {
      const run = seeded(),
        archive = store.download(run.id, 1).body,
        sourceFile = join(source, "quality-evaluation", "quality.sqlite"),
        before = hash(readFileSync(sourceFile));
      const backup = join(directory, "backup");
      expect(cli("quality-backup", source, backup)).toMatchObject({
        runs: 1,
        revisions: 1,
        requests: 2,
      });
      expect(hash(readFileSync(sourceFile))).toBe(before);
      expect(readdirSync(backup).sort()).toEqual(
        ["COMPLETE.json", "quality-backup-manifest.json", "quality.sqlite"].sort(),
      );
      const files = readdirSync(backup).map((name) => [
        name,
        hash(readFileSync(join(backup, name))),
      ]);
      cli("quality-verify", backup);
      expect(
        readdirSync(backup).map((name) => [name, hash(readFileSync(join(backup, name)))]),
      ).toEqual(files);
      const destination = join(directory, "destination");
      mkdirSync(destination);
      writeFileSync(join(destination, "studio.sqlite"), "DESTINATION COMPANY PRESERVED");
      mkdirSync(join(destination, "originals"));
      writeFileSync(join(destination, "originals", "kept.bin"), "KEEP");
      cli("quality-restore", backup, destination);
      expect(readFileSync(join(destination, "studio.sqlite"), "utf8")).toBe(
        "DESTINATION COMPANY PRESERVED",
      );
      expect(readFileSync(join(destination, "originals", "kept.bin"), "utf8")).toBe("KEEP");
      const restored = new PlanQualityStore(destination);
      try {
        expect(restored.get(run.id)).toEqual(run);
        expect(restored.download(run.id, 1).body).toBe(archive);
        expect(restored.fixture(run.id, run.manifest[0].fixtureId)).toEqual(
          store.fixture(run.id, run.manifest[0].fixtureId),
        );
        expect(restored.lookup(run.history.at(-1)!.clientRequestId)).toEqual(
          store.lookup(run.history.at(-1)!.clientRequestId),
        );
        const currentBytes = hash(
          readFileSync(join(destination, "quality-evaluation", "quality.sqlite")),
        );
        expect(cli("quality-restore", backup, destination, false).code).toBe(
          "QUALITY_DESTINATION_EXISTS",
        );
        expect(hash(readFileSync(join(destination, "quality-evaluation", "quality.sqlite")))).toBe(
          currentBytes,
        );
        expect(readdirSync(destination).some((name) => name.startsWith("quality-restore-"))).toBe(
          false,
        );
      } finally {
        restored.close();
      }
    },
    timeout,
  );
  it(
    "rejects altered backup bytes and pending or corrupted sources without a completion marker",
    () => {
      const run = seeded(),
        backup = join(directory, "backup");
      cli("quality-backup", source, backup);
      const output = join(backup, "quality.sqlite"),
        bytes = readFileSync(output);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(output, bytes);
      expect(cli("quality-verify", backup, undefined, false).code).toBe("QUALITY_FILE_CHANGED");
      const destination = join(directory, "destination");
      mkdirSync(destination);
      writeFileSync(join(destination, "studio.sqlite"), "KEEP COMPANY");
      cli("quality-restore", backup, destination, false);
      expect(existsSync(join(destination, "quality-evaluation"))).toBe(false);
      const db = new DatabaseSync(join(source, "quality-evaluation", "quality.sqlite"));
      try {
        db.exec("DROP TRIGGER quality_runs_no_update");
        db.prepare("UPDATE quality_runs SET body='{}' WHERE id=?").run(run.id);
      } finally {
        db.close();
      }
      const rejected = join(directory, "rejected");
      cli("quality-backup", source, rejected, false);
      expect(existsSync(join(rejected, "COMPLETE.json"))).toBe(false);
    },
    timeout,
  );
  it(
    "refuses reparse restore destinations and does not initialize a pending restoration",
    () => {
      seeded();
      const backup = join(directory, "backup");
      cli("quality-backup", source, backup);
      const elsewhere = join(directory, "elsewhere"),
        linked = join(directory, "linked");
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, "company.bin"), "DO NOT CHANGE");
      symlinkSync(elsewhere, linked, process.platform === "win32" ? "junction" : "dir");
      expect(cli("quality-restore", backup, linked, false).code).toBe("UNSAFE_PATH");
      expect(readFileSync(join(elsewhere, "company.bin"), "utf8")).toBe("DO NOT CHANGE");
      expect(existsSync(join(elsewhere, "quality-evaluation"))).toBe(false);
      const pending = join(source, "quality-evaluation", ".restore-pending"),
        before = hash(readFileSync(join(source, "quality-evaluation", "quality.sqlite")));
      writeFileSync(pending, "pending fixture");
      expect(() => new PlanQualityStore(source)).toThrowError(
        expect.objectContaining({ code: "QUALITY_STORAGE_UNSAFE" }),
      );
      expect(() => store.list()).toThrowError(
        expect.objectContaining({ code: "QUALITY_STORAGE_UNSAFE" }),
      );
      expect(hash(readFileSync(join(source, "quality-evaluation", "quality.sqlite")))).toBe(before);
      expect(cli("quality-backup", source, join(directory, "pending-backup"), false).code).toBe(
        "QUALITY_RESTORE_PENDING",
      );
    },
    timeout,
  );
});
