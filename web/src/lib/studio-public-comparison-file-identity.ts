// Node file primitives shared with the standalone StudioStore capability registry.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safePath, nativePaths, samePath } from "../../scripts/local-data-files.mjs";
import { journalIdentity } from "../../scripts/local-journal-io.mjs";

export function comparisonStorageFail(code: string): never {
  throw Error("PUBLIC_COMPARISON_" + code);
}
export function comparisonFileIdentity(file: string) {
  return journalIdentity(file);
}
export function comparisonRootIdentity(root: string) {
  return journalIdentity(root, "directory");
}
export function checkComparisonDatabasePath(root: string, file: string) {
  safePath(root, "directory");
  if (existsSync(join(root, ".restore-pending"))) comparisonStorageFail("RESTORE_PENDING");
  const s = safePath(file);
  if (s.size > BigInt(256 * 1024 * 1024)) comparisonStorageFail("DATABASE_LIMIT");
  const present = [root, file];
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const p = file + suffix;
    if (existsSync(p)) {
      if (safePath(p).size > BigInt(256 * 1024 * 1024)) comparisonStorageFail("DATABASE_LIMIT");
      present.push(p);
    }
  }
  nativePaths(present);
}
export function requireComparisonDatabaseHandle(db: DatabaseSync, file: string) {
  const all = db.prepare("PRAGMA database_list").all();
  if (all.some((r) => r.name !== "main" && !(r.name === "temp" && r.file === "")))
    comparisonStorageFail("DATABASE_HANDLE_MISMATCH");
  const list = all.filter((r) => r.name === "main");
  if (
    list.length !== 1 ||
    list[0].name !== "main" ||
    typeof list[0].file !== "string" ||
    !samePath(resolve(list[0].file), resolve(file))
  )
    comparisonStorageFail("DATABASE_HANDLE_MISMATCH");
}
