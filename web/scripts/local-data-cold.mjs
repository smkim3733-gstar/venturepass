import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createDestination,
  fail,
  limits,
  nativePaths,
  readPrefixSafe,
  readSafe,
  safePath,
} from "./local-data-files.mjs";
import { inspectDatabase, openReadOnly } from "./local-data-store.mjs";

const suffixes = ["-wal", "-shm", "-journal"];
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) =>
  sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function present(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function noSidecars(file) {
  if (suffixes.some((suffix) => present(file + suffix))) fail("SOURCE_WAL_CHANGED");
}

/** Clean only fixed SQLite files inside this invocation's unchanged private directory. */
function cleanScratch(root, rootIdentity, dbIdentity) {
  const checkRoot = () => {
    if (!sameIdentity(rootIdentity, safePath(root, "directory"))) fail("SCRATCH_CHANGED");
  };
  checkRoot();
  const allowed = new Set(["studio.sqlite", ...suffixes.map((suffix) => `studio.sqlite${suffix}`)]);
  const names = readdirSync(root);
  if (names.some((name) => !allowed.has(name))) fail("SCRATCH_CHANGED");
  const files = names.map((name) => {
    const file = path.join(root, name);
    const identity = safePath(file);
    if (name === "studio.sqlite" && dbIdentity && !sameIdentity(dbIdentity, identity))
      fail("SCRATCH_CHANGED");
    return { file, identity };
  });
  nativePaths([root, ...files.map((item) => item.file)]);
  for (const { file, identity } of files) {
    checkRoot();
    if (!sameIdentity(identity, safePath(file))) fail("SCRATCH_CHANGED");
    unlinkSync(file);
  }
  checkRoot();
  // No recursive removal: a newly appearing entry makes rmdir fail and is preserved.
  rmdirSync(root);
}

/**
 * Return null for the existing online/DELETE path. A cold WAL source is never opened
 * by SQLite: only its bounded, stable byte copy may create journals in private scratch.
 * This verifies the current bytes, not whether a WAL was historically lost.
 */
export function prepareColdSource(source) {
  const root = path.resolve(source);
  const file = path.join(root, "studio.sqlite");
  safePath(root, "directory");
  safePath(file);
  nativePaths([root, file]);
  const header = readPrefixSafe(file, 100);
  if (header.subarray(0, 16).toString("binary") !== "SQLite format 3\u0000")
    fail("DATABASE_INVALID");
  if (header[18] === 1 && header[19] === 1) return null;
  if (header[18] !== 2 || header[19] !== 2) fail("DATABASE_INVALID");
  const wal = present(file + "-wal");
  const shm = present(file + "-shm");
  if (present(file + "-journal") || wal !== shm) fail("SOURCE_WAL_NOT_READY");
  if (wal) return null;

  const sourceRoot = safePath(root, "directory");
  const sourceDb = safePath(file);
  const rawPageSize = header.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  // SQLite may tolerate a zero-filled tail of a short final page. A standalone
  // cold copy must contain every complete page declared by a valid header.
  if (
    pageSize < 512 ||
    pageSize > 65536 ||
    (pageSize & (pageSize - 1)) !== 0 ||
    sourceDb.size % BigInt(pageSize) !== 0n ||
    sourceDb.size / BigInt(pageSize) !== BigInt(header.readUInt32BE(28)) ||
    header.readUInt32BE(24) !== header.readUInt32BE(92)
  )
    fail("DATABASE_INVALID");
  const assertStat = () => {
    noSidecars(file);
    if (!unchanged(sourceRoot, safePath(root, "directory")) || !unchanged(sourceDb, safePath(file)))
      fail("SOURCE_WAL_CHANGED");
  };
  assertStat();
  const scratch = createDestination(
    root,
    path.join(tmpdir(), `venture-cold-backup-${randomUUID()}`),
  );
  const scratchIdentity = safePath(scratch, "directory");
  const scratchFile = path.join(scratch, "studio.sqlite");
  let scratchDbIdentity;
  let writable;
  let database;
  let closed = false;
  const close = () => {
    if (closed) return;
    database?.close();
    database = undefined;
    writable?.close();
    writable = undefined;
    cleanScratch(scratch, scratchIdentity, scratchDbIdentity);
    closed = true;
  };
  try {
    assertStat();
    const copied = readSafe(file, limits.dbBytes, scratchFile);
    scratchDbIdentity = safePath(scratchFile);
    const assertCurrent = () => {
      nativePaths([root, file]);
      assertStat();
      const current = readSafe(file, limits.dbBytes);
      assertStat();
      if (current.sizeBytes !== copied.sizeBytes || current.sha256 !== copied.sha256)
        fail("SOURCE_WAL_CHANGED");
    };
    assertCurrent();
    const copiedAgain = readSafe(scratchFile, limits.dbBytes);
    if (copiedAgain.sha256 !== copied.sha256 || copiedAgain.sizeBytes !== copied.sizeBytes)
      fail("SCRATCH_CHANGED");
    nativePaths([scratch, scratchFile]);
    if (
      !sameIdentity(scratchIdentity, safePath(scratch, "directory")) ||
      !sameIdentity(scratchDbIdentity, safePath(scratchFile)) ||
      readdirSync(scratch).some((name) => name !== "studio.sqlite")
    )
      fail("SCRATCH_CHANGED");
    writable = new DatabaseSync(scratchFile, { allowExtension: false });
    writable.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000; PRAGMA query_only=ON");
    const snapshot = inspectDatabase(writable);
    // Only the validated private copy is normalized. Original DB/header remain untouched.
    writable.exec("PRAGMA query_only=OFF");
    if (writable.prepare("PRAGMA journal_mode=DELETE").get().journal_mode !== "delete")
      fail("DATABASE_INVALID");
    writable.close();
    writable = undefined;
    database = openReadOnly(scratch);
    if (JSON.stringify(inspectDatabase(database)) !== JSON.stringify(snapshot))
      fail("DATABASE_CHANGED");
    assertCurrent();
    return { database, assertCurrent, close };
  } catch (error) {
    close();
    throw error;
  }
}
