import "server-only";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  createDestination,
  fail,
  nativePaths,
  readPrefixSafe,
  readSafe,
  safePath,
  within,
} from "../../scripts/local-data-files.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  acquireJournalLease,
  journalIdentity,
  readJournalJson,
  writeJournalJson as writeBoundedJson,
} from "../../scripts/local-journal-io.mjs";
import {
  inspectPublicComparisonDatabaseTransaction,
  type PublicComparisonDatabaseSelection,
} from "./studio-public-claim-comparison-database";
import { inspectComparisonArchiveCheckpoint } from "./studio-public-claim-comparison-database-v11";
import {
  comparisonWitnessInventory,
  inspectComparisonArchivedWitness,
} from "./studio-public-comparison-storage-witness";

const writeJournalJson = (file: string, value: unknown) =>
  writeBoundedJson(file, value, 65536, fail);
const maximum = 256 * 1024 * 1024;
const suffixes = ["-wal", "-shm", "-journal"];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const versionSchema = z.union([z.literal(10), z.literal(11), z.literal(12), z.literal(13)]);
type Version = z.infer<typeof versionSchema>;
const selectionSchema = z
  .object({
    databaseInstanceId: z.uuid(),
    environment: z.enum(["production", "synthetic-test"]),
    scopeId: z.enum([
      "candidate-quality-provider-v2-live",
      "candidate-quality-provider-v2-synthetic",
    ]),
  })
  .strict();
const fileSchema = z
  .object({ sha256: hash, sizeBytes: z.number().int().positive().max(maximum) })
  .strict();
const manifestSchema = z
  .object({
    kind: z.literal("public-comparison-cold-archive"),
    formatVersion: z.literal(1),
    role: z.enum(["backup", "review-candidate"]),
    storageVersion: versionSchema,
    selection: selectionSchema,
    createdAt: z.iso.datetime(),
    database: fileSchema,
    witnesses: z
      .array(fileSchema.extend({ name: z.string().regex(/^\d{3}\.json$/) }).strict())
      .max(128),
    auditDigest: hash,
  })
  .strict();
const manifestName = "comparison-backup-manifest.json";
const marker = { kind: "public-comparison-review-only", operationalRestoreAllowed: false };
const sameIdentity = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) =>
  a.dev === b.dev && a.ino === b.ino;
function absolute(value: string) {
  if (!isAbsolute(value) || value !== resolve(value)) fail("ABSOLUTE_PATH_REQUIRED");
  return value;
}
function absent(path: string) {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fail("UNEXPECTED_PATH");
}
function cold(file: string) {
  suffixes.forEach((suffix) => absent(file + suffix));
  const header = readPrefixSafe(file, 100, maximum);
  const size = safePath(file).size;
  const raw = header.readUInt16BE(16),
    page = raw === 1 ? 65536 : raw;
  if (
    header.subarray(0, 16).toString("binary") !== "SQLite format 3\0" ||
    ![1, 2].includes(header[18]) ||
    header[18] !== header[19] ||
    page < 512 ||
    page > 65536 ||
    (page & (page - 1)) !== 0 ||
    size % BigInt(page) !== BigInt(0) ||
    size / BigInt(page) !== BigInt(header.readUInt32BE(28)) ||
    header.readUInt32BE(24) !== header.readUInt32BE(92)
  )
    fail("COLD_DATABASE_INVALID");
}
function readPair(control: string, journal: string, version: Version) {
  if (version === 10) {
    absent(control);
    absent(journal);
    return {
      records: [] as unknown[],
      files: [] as { name: string; sha256: string; sizeBytes: number }[],
    };
  }
  safePath(control, "directory");
  safePath(journal, "directory");
  const names = readdirSync(control).sort();
  if (
    names.length < 2 ||
    names.length > 128 ||
    digest(names) !== digest(readdirSync(journal).sort())
  )
    fail("WITNESS_PARTIAL");
  nativePaths([
    control,
    journal,
    ...names.flatMap((name) => [join(control, name), join(journal, name)]),
  ]);
  const records: unknown[] = [];
  const files = names.map((name, i) => {
    if (name !== String(i).padStart(3, "0") + ".json") fail("WITNESS_INVALID");
    const a = readSafe(join(control, name), 32768);
    const b = readSafe(join(journal, name), 32768);
    if (a.sha256 !== b.sha256 || a.sizeBytes !== b.sizeBytes) fail("WITNESS_PARTIAL");
    records.push(readJournalJson(join(control, name), 32768, fail));
    return { name, ...a };
  });
  return { records, files };
}
/** Opens only this invocation's exclusive scratch copy. Never opens the supplied DB path. */
function audit(
  file: string,
  records: unknown[],
  selection: PublicComparisonDatabaseSelection,
  version: Version,
) {
  cold(file);
  const scratch = createDestination(
    dirname(file),
    join(tmpdir(), "venture-comparison-audit-" + randomUUID()),
  );
  const rootIdentity = safePath(scratch, "directory");
  const copy = join(scratch, "quality.sqlite");
  let copyIdentity: ReturnType<typeof safePath> | undefined;
  let db: DatabaseSync | undefined;
  try {
    const before = readSafe(file, maximum, copy, false, (identity) => {
      copyIdentity = identity;
    });
    cold(file);
    if (digest(readSafe(file, maximum)) !== digest(before)) fail("SOURCE_CHANGED");
    nativePaths([scratch, copy]);
    if (
      !copyIdentity ||
      !sameIdentity(rootIdentity, safePath(scratch, "directory")) ||
      !sameIdentity(copyIdentity, safePath(copy))
    )
      fail("SCRATCH_CHANGED");
    db = new DatabaseSync(copy, { allowExtension: false });
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA query_only=ON; BEGIN");
    if (version === 10) {
      if (records.length) fail("WITNESS_INVALID");
      inspectPublicComparisonDatabaseTransaction(db, selection);
      const inventoryDigest = comparisonWitnessInventory(db);
      db.exec("COMMIT");
      return { inventoryDigest, checkpoint: null, witness: null };
    }
    const checkpoint = inspectComparisonArchiveCheckpoint(db, selection, version);
    const inventoryDigest = checkpoint.inventoryDigest;
    const witness = inspectComparisonArchivedWitness(
      db,
      records,
      selection,
      checkpoint,
      (version - 10) as 1 | 2 | 3,
    );
    db.exec("COMMIT");
    return { inventoryDigest, checkpoint, witness };
  } finally {
    // A failed close keeps the private directory for explicit recovery.
    db?.close();
    if (!sameIdentity(rootIdentity, safePath(scratch, "directory"))) fail("SCRATCH_CHANGED");
    const names = readdirSync(scratch);
    if (
      names.some(
        (name) => !["quality.sqlite", ...suffixes.map((s) => "quality.sqlite" + s)].includes(name),
      )
    )
      fail("SCRATCH_CHANGED");
    const files = names.map((name) => {
      const path = join(scratch, name),
        identity = safePath(path);
      if (name === "quality.sqlite" && (!copyIdentity || !sameIdentity(copyIdentity, identity)))
        fail("SCRATCH_CHANGED");
      return { path, identity };
    });
    nativePaths([scratch, ...files.map((f) => f.path)]);
    for (const entry of files) {
      if (
        !sameIdentity(rootIdentity, safePath(scratch, "directory")) ||
        !sameIdentity(entry.identity, safePath(entry.path))
      )
        fail("SCRATCH_CHANGED");
      unlinkSync(entry.path);
    }
    rmdirSync(scratch);
  }
}
function archivePaths(root: string) {
  return {
    file: join(root, "quality.sqlite"),
    control: join(root, "control-witness"),
    journal: join(root, "database-witness"),
  };
}
function inspectArchive(
  root: string,
  selection: PublicComparisonDatabaseSelection,
  version: Version,
  complete: boolean,
) {
  absolute(root);
  selectionSchema.parse(selection);
  versionSchema.parse(version);
  const rootIdentity = safePath(root, "directory");
  nativePaths([root]);
  const manifest = manifestSchema.parse(readJournalJson(join(root, manifestName), 65536, fail));
  if (digest(manifest.selection) !== digest(selection) || manifest.storageVersion !== version)
    fail("ARCHIVE_SELECTION_MISMATCH");
  const expected = [
    manifestName,
    ".restore-pending",
    "quality.sqlite",
    ...(version === 10 ? [] : ["control-witness", "database-witness"]),
    ...(complete ? ["COMPLETE"] : []),
  ].sort();
  if (digest(readdirSync(root).sort()) !== digest(expected)) fail("ARCHIVE_FILES_INVALID");
  nativePaths(expected.map((name) => join(root, name)));
  if (digest(readJournalJson(join(root, ".restore-pending"), 1024, fail)) !== digest(marker))
    fail("ARCHIVE_MARKER_INVALID");
  const manifestSha256 = readSafe(join(root, manifestName), 65536).sha256;
  if (complete) {
    if (readJournalJson(join(root, "COMPLETE"), 100, fail) !== manifestSha256)
      fail("ARCHIVE_INCOMPLETE");
  }
  const paths = archivePaths(root);
  cold(paths.file);
  const database = readSafe(paths.file, maximum),
    pair = readPair(paths.control, paths.journal, version);
  if (
    digest(database) !== digest(manifest.database) ||
    digest(pair.files) !== digest(manifest.witnesses)
  )
    fail("ARCHIVE_HASH_MISMATCH");
  const proof = audit(paths.file, pair.records, selection, version);
  if (digest(proof) !== manifest.auditDigest) fail("ARCHIVE_AUDIT_MISMATCH");
  cold(paths.file);
  if (
    !sameIdentity(rootIdentity, safePath(root, "directory")) ||
    digest(readSafe(paths.file, maximum)) !== digest(database) ||
    digest(readPair(paths.control, paths.journal, version)) !== digest(pair) ||
    readSafe(join(root, manifestName), 65536).sha256 !== manifestSha256 ||
    digest(readdirSync(root).sort()) !== digest(expected) ||
    digest(readJournalJson(join(root, ".restore-pending"), 1024, fail)) !== digest(marker) ||
    (complete && readJournalJson(join(root, "COMPLETE"), 100, fail) !== manifestSha256)
  )
    fail("ARCHIVE_CHANGED");
  return { manifest, proof, manifestSha256 };
}
function report(result: ReturnType<typeof inspectArchive>) {
  return {
    status: "verified" as const,
    role: result.manifest.role,
    storageVersion: result.manifest.storageVersion,
    databaseInstanceId: result.manifest.selection.databaseInstanceId,
    manifestSha256: result.manifestSha256,
    databaseSha256: result.manifest.database.sha256,
    witnessRecords: result.manifest.witnesses.length,
    auditDigest: result.manifest.auditDigest,
    fileIdentityVerified: false,
    currentCompanyVerified: false,
    dispatchAllowed: false,
    operationalRestoreAllowed: false,
  };
}
export function verifyComparisonBackup(
  root: string,
  selection: PublicComparisonDatabaseSelection,
  version: Version,
) {
  return report(inspectArchive(root, selection, version, true));
}
function copyArchiveData(
  file: string,
  control: string,
  journal: string,
  target: string,
  version: Version,
) {
  const destination = archivePaths(target);
  readSafe(file, maximum, destination.file);
  const pair = readPair(control, journal, version);
  if (version !== 10) {
    mkdirSync(destination.control, { mode: 0o700 });
    mkdirSync(destination.journal, { mode: 0o700 });
    for (const { name } of pair.files) {
      readSafe(join(control, name), 32768, join(destination.control, name));
      readSafe(join(journal, name), 32768, join(destination.journal, name));
    }
  }
}
function completeArchive(
  target: string,
  selection: PublicComparisonDatabaseSelection,
  version: Version,
) {
  const verified = inspectArchive(target, selection, version, false);
  // Exclusive fsynced write; failure never removes an unknown completion marker.
  writeJournalJson(join(target, "COMPLETE"), verified.manifestSha256);
  return verified;
}
export function backupComparisonData(options: {
  dataRoot: string;
  controlDirectory: string;
  destination: string;
  selection: PublicComparisonDatabaseSelection;
  storageVersion: Version;
}) {
  const {
    dataRoot: root,
    controlDirectory: control,
    destination: target,
    selection,
    storageVersion: version,
  } = options;
  [root, control, target].forEach(absolute);
  selectionSchema.parse(selection);
  versionSchema.parse(version);
  if (
    within(control, root) ||
    within(root, control) ||
    dirname(root) !== dirname(control) ||
    within(target, control) ||
    within(control, target)
  )
    fail("DESTINATION_OVERLAP");
  absent(join(root, ".restore-pending"));
  const file = join(root, "quality.sqlite"),
    studio = join(root, "studio.sqlite");
  const journal = join(root, "comparison-storage-witness");
  safePath(root, "directory");
  safePath(file);
  safePath(studio);
  nativePaths([root, file, studio, dirname(control)]);
  const identity = () => ({
    paths: { dataRoot: root, qualityFile: file, studioFile: studio, controlDirectory: control },
    rootIdentity: journalIdentity(root, "directory"),
    qualityIdentity: journalIdentity(file, "file"),
    studioIdentity: journalIdentity(studio, "file"),
    ...(version === 10
      ? {}
      : {
          controlIdentity: journalIdentity(control, "directory"),
          journalIdentity: journalIdentity(journal, "directory"),
        }),
  });
  const lease = acquireJournalLease(control + ".lock", fail);
  let releaseAttempted = false;
  const release = () => {
    releaseAttempted = true;
    lease.close();
  };
  try {
    cold(file);
    suffixes.forEach((s) => absent(studio + s));
    const originalIdentity = identity(),
      original = readSafe(file, maximum);
    const pair = readPair(control, journal, version);
    const proof = audit(file, pair.records, selection, version);
    if (proof.witness) {
      const { type: _type, selection: _selection, ...bound } = proof.witness.binding;
      void _type;
      void _selection;
      if (digest(bound) !== digest(originalIdentity)) fail("WITNESS_BINDING_CHANGED");
    }
    const assertSource = () => {
      lease.guard();
      absent(join(root, ".restore-pending"));
      cold(file);
      suffixes.forEach((s) => absent(studio + s));
      if (
        digest(identity()) !== digest(originalIdentity) ||
        digest(readSafe(file, maximum)) !== digest(original) ||
        digest(readPair(control, journal, version)) !== digest(pair)
      )
        fail("SOURCE_CHANGED");
    };
    assertSource();
    createDestination(root, target);
    writeJournalJson(join(target, ".restore-pending"), marker);
    copyArchiveData(file, control, journal, target, version);
    const manifest = {
      kind: "public-comparison-cold-archive",
      formatVersion: 1,
      role: "backup",
      storageVersion: version,
      selection,
      createdAt: new Date().toISOString(),
      database: original,
      witnesses: pair.files,
      auditDigest: digest(proof),
    };
    writeJournalJson(join(target, manifestName), manifestSchema.parse(manifest));
    assertSource();
    const verified = inspectArchive(target, selection, version, false);
    assertSource();
    release();
    writeJournalJson(join(target, "COMPLETE"), verified.manifestSha256);
    return report(verified);
  } finally {
    if (!releaseAttempted) release();
  }
}
/** A new review directory only. Original witness paths/identities/nonces remain unchanged. */
export function restoreComparisonCandidate(
  source: string,
  destination: string,
  selection: PublicComparisonDatabaseSelection,
  version: Version,
) {
  absolute(destination);
  const original = inspectArchive(source, selection, version, true),
    paths = archivePaths(source);
  createDestination(source, destination);
  writeJournalJson(join(destination, ".restore-pending"), marker);
  copyArchiveData(paths.file, paths.control, paths.journal, destination, version);
  writeJournalJson(join(destination, manifestName), {
    ...original.manifest,
    role: "review-candidate",
    createdAt: new Date().toISOString(),
  });
  const current = inspectArchive(source, selection, version, true);
  if (current.manifestSha256 !== original.manifestSha256) fail("ARCHIVE_CHANGED");
  return report(completeArchive(destination, selection, version));
}
