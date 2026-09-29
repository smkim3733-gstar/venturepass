import { backup, DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { prepareColdSource } from "./local-data-cold.mjs";
import {
  backupQualityData,
  restoreQualityData,
  verifyQualityBackup,
} from "./local-data-quality.mjs";
import {
  createDestination,
  DataToolError,
  fail,
  limits,
  nativePaths,
  readPrefixSafe,
  readSafe,
  safePath,
  sha,
  writeNew,
} from "./local-data-files.mjs";
import {
  inspectDatabase,
  inspectDatabasePaths,
  inspectDirectory,
  openReadOnly,
} from "./local-data-store.mjs";

const markerName = "COMPLETE.json";
const manifestName = "backup-manifest.json";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const originalPath = /^originals\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.bin$/i;
const manifestSchema = z
  .object({
    format: z.literal("venturepass-local-backup"),
    version: z.literal(1),
    createdAt: z.string().datetime(),
    logicalDigest: hash,
    companies: z.number().int().nonnegative().max(limits.companies),
    accounts: z.number().int().nonnegative().max(limits.companies),
    workflows: z.number().int().nonnegative().max(limits.companies),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .refine((value) => value === "studio.sqlite" || originalPath.test(value)),
            sizeBytes: z.number().int().nonnegative().max(limits.dbBytes),
            sha256: hash,
          })
          .strict(),
      )
      .min(1)
      .max(limits.originals + 1),
  })
  .strict();
const markerSchema = z
  .object({ format: z.literal("venturepass-local-backup-complete"), manifestSha256: hash })
  .strict();
const fileAt = (root, relative) => path.join(root, ...relative.split("/"));
function snapshotEqual(left, right) {
  if (JSON.stringify(left) !== JSON.stringify(right)) fail("DATABASE_CHANGED");
}
function ownGuard(root) {
  const identity = safePath(root, "directory");
  return () => {
    const current = safePath(root, "directory");
    if (identity.dev !== current.dev || identity.ino !== current.ino) fail("DESTINATION_CHANGED");
  };
}
function originalFiles(root) {
  const files = [];
  const base = path.join(root, "originals");
  try {
    safePath(base, "directory");
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  for (const company of readdirSync(base)) {
    if (!/^[a-f0-9-]{36}$/i.test(company)) fail("UNEXPECTED_FILE");
    const directory = path.join(base, company);
    safePath(directory, "directory");
    for (const name of readdirSync(directory)) {
      const relative = `originals/${company}/${name}`;
      if (!originalPath.test(relative)) fail("UNEXPECTED_FILE");
      safePath(fileAt(root, relative));
      files.push(relative);
      if (files.length > limits.originals) fail("ORIGINAL_LIMIT");
    }
  }
  return files.sort();
}
function assertOriginalList(root, expected) {
  if (JSON.stringify(originalFiles(root)) !== JSON.stringify(expected))
    fail("ORIGINAL_SET_CHANGED");
}
function compareFile(observed, expected) {
  if (observed.sizeBytes !== expected.sizeBytes || observed.sha256 !== expected.sha256)
    fail("FILE_CHANGED");
}
function copyOriginal(root, target, relative, guard) {
  guard();
  const directory = path.dirname(fileAt(target, relative));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  safePath(directory, "directory");
  return {
    path: relative,
    ...readSafe(fileAt(root, relative), limits.fileBytes, fileAt(target, relative)),
  };
}
function writeCompletion(target, snapshot, files, guard) {
  guard();
  const manifest = manifestSchema.parse({
    format: "venturepass-local-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    logicalDigest: snapshot.digest,
    companies: snapshot.companies,
    accounts: snapshot.accounts,
    workflows: snapshot.workflows,
    files,
  });
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  if (bytes.length > limits.manifestBytes) fail("MANIFEST_LIMIT");
  writeNew(path.join(target, manifestName), bytes);
  nativePaths([
    target,
    ...files.map((item) => fileAt(target, item.path)),
    path.join(target, manifestName),
  ]);
  guard();
  writeNew(
    path.join(target, markerName),
    Buffer.from(
      JSON.stringify({ format: "venturepass-local-backup-complete", manifestSha256: sha(bytes) }),
    ),
  );
  return { manifest, identity: safePath(path.join(target, markerName)) };
}
function removeOwnMarker(target, guard, identity) {
  if (!identity) return;
  guard();
  const file = path.join(target, markerName);
  const current = safePath(file);
  if (current.dev !== identity.dev || current.ino !== identity.ino) fail("DESTINATION_CHANGED");
  unlinkSync(file);
}
export function verifyLocalData(source) {
  const root = path.resolve(source);
  safePath(root, "directory");
  const guard = ownGuard(root);
  const manifestFile = path.join(root, manifestName);
  const markerFile = path.join(root, markerName);
  nativePaths([root, manifestFile, markerFile]);
  let manifest;
  let marker;
  const manifestBytes = readSafe(manifestFile, limits.manifestBytes, null, true).bytes;
  try {
    manifest = manifestSchema.parse(JSON.parse(manifestBytes));
    marker = markerSchema.parse(JSON.parse(readSafe(markerFile, 1024, null, true).bytes));
  } catch {
    fail("MANIFEST_INVALID");
  }
  if (
    marker.manifestSha256 !== sha(manifestBytes) ||
    new Set(manifest.files.map((item) => item.path.toLowerCase())).size !== manifest.files.length ||
    manifest.files.filter((item) => item.path === "studio.sqlite").length !== 1
  )
    fail("MANIFEST_INVALID");
  const expected = manifest.files
    .filter((item) => item.path !== "studio.sqlite")
    .map((item) => item.path)
    .sort();
  if (
    readdirSync(root).some(
      (name) => !["studio.sqlite", "originals", manifestName, markerName].includes(name),
    )
  )
    fail("UNEXPECTED_FILE");
  assertOriginalList(root, expected);
  const paths = manifest.files.map((file) => fileAt(root, file.path));
  nativePaths(paths);
  const header = readPrefixSafe(path.join(root, "studio.sqlite"), 100);
  if (header[18] !== 1 || header[19] !== 1) fail("BACKUP_JOURNAL_UNSUPPORTED");
  let total = 0;
  for (const file of manifest.files) {
    const original = file.path !== "studio.sqlite";
    if (original) {
      total += file.sizeBytes;
      if (total > limits.totalBytes) fail("TOTAL_LIMIT");
    }
    compareFile(
      readSafe(fileAt(root, file.path), original ? limits.fileBytes : limits.dbBytes),
      file,
    );
  }
  const snapshot = inspectDirectory(root);
  if (
    snapshot.digest !== manifest.logicalDigest ||
    snapshot.companies !== manifest.companies ||
    snapshot.accounts !== manifest.accounts ||
    snapshot.workflows !== manifest.workflows ||
    JSON.stringify(snapshot.originals) !== JSON.stringify(expected)
  )
    fail("DATABASE_CHANGED");
  nativePaths(paths);
  assertOriginalList(root, expected);
  for (const file of manifest.files)
    compareFile(
      readSafe(
        fileAt(root, file.path),
        file.path === "studio.sqlite" ? limits.dbBytes : limits.fileBytes,
      ),
      file,
    );
  if (
    sha(readSafe(manifestFile, limits.manifestBytes, null, true).bytes) !== marker.manifestSha256 ||
    JSON.stringify(markerSchema.parse(JSON.parse(readSafe(markerFile, 1024, null, true).bytes))) !==
      JSON.stringify(marker)
  )
    fail("BACKUP_CHANGED");
  guard();
  // A verification pass is read-only; the backup DB uses DELETE journaling and creates no sidecars.
  return { manifest, snapshot };
}
export async function backupLocalData(source, destination) {
  const root = path.resolve(source);
  safePath(root, "directory");
  const sourceIdentity = inspectDatabasePaths(root);
  const cold = prepareColdSource(root);
  const database = cold?.database ?? openReadOnly(root);
  let target;
  let guard;
  let completedIdentity;
  try {
    const snapshot = inspectDatabase(database);
    assertOriginalList(root, snapshot.originals);
    nativePaths([
      path.join(root, "studio.sqlite"),
      ...snapshot.originals.map((item) => fileAt(root, item)),
    ]);
    target = createDestination(root, destination);
    guard = ownGuard(target);
    const dbFile = path.join(target, "studio.sqlite");
    writeNew(dbFile, Buffer.alloc(0));
    const identity = safePath(dbFile);
    nativePaths([dbFile]);
    const deadline = Date.now() + 120000;
    await backup(database, dbFile, {
      rate: 100,
      progress: () => {
        if (Date.now() > deadline) fail("BACKUP_TIMEOUT");
      },
    });
    guard();
    const copied = safePath(dbFile);
    if (copied.dev !== identity.dev || copied.ino !== identity.ino) fail("DESTINATION_CHANGED");
    // Change only the new backup's journaling mode so it is a self-contained readonly-verifiable DB.
    const normalized = new DatabaseSync(dbFile, { allowExtension: false });
    try {
      normalized.exec("PRAGMA journal_mode=DELETE");
    } finally {
      normalized.close();
    }
    snapshotEqual(snapshot, inspectDirectory(target));
    const files = [{ path: "studio.sqlite", ...readSafe(dbFile, limits.dbBytes) }];
    let total = 0;
    for (const relative of snapshot.originals) {
      const file = copyOriginal(root, target, relative, guard);
      total += file.sizeBytes;
      if (total > limits.totalBytes) fail("TOTAL_LIMIT");
      files.push(file);
    }
    nativePaths([
      root,
      ...snapshot.originals.map((item) => fileAt(root, item)),
      target,
      ...files.map((item) => fileAt(target, item.path)),
    ]);
    for (const file of files) {
      if (file.path !== "studio.sqlite")
        compareFile(readSafe(fileAt(root, file.path), limits.fileBytes), file);
      compareFile(
        readSafe(
          fileAt(target, file.path),
          file.path === "studio.sqlite" ? limits.dbBytes : limits.fileBytes,
        ),
        file,
      );
    }
    snapshotEqual(snapshot, inspectDatabase(database));
    assertOriginalList(root, snapshot.originals);
    const finalSourceIdentity = inspectDatabasePaths(root);
    if (
      sourceIdentity.dev !== finalSourceIdentity.dev ||
      sourceIdentity.ino !== finalSourceIdentity.ino
    )
      fail("DATABASE_CHANGED");
    if (cold) cold.assertCurrent();
    else snapshotEqual(snapshot, inspectDirectory(root));
    const completion = writeCompletion(target, snapshot, files, guard);
    completedIdentity = completion.identity;
    verifyLocalData(target);
    // Verification can take time. A cold source must still be unchanged after
    // COMPLETE was written; the catch removes only our marker on any failure.
    cold?.assertCurrent();
    cold?.close();
    cold?.assertCurrent();
    return {
      companies: completion.manifest.companies,
      originals: snapshot.originals.length,
      accounts: completion.manifest.accounts,
    };
  } catch (error) {
    if (target && guard && completedIdentity) removeOwnMarker(target, guard, completedIdentity);
    throw error;
  } finally {
    if (cold) cold.close();
    else database.close();
  }
}
export function restoreLocalData(source, destination) {
  const root = path.resolve(source);
  const before = verifyLocalData(root);
  const target = createDestination(root, destination);
  const guard = ownGuard(target);
  let completedIdentity;
  try {
    for (const file of before.manifest.files) {
      guard();
      const destinationFile = fileAt(target, file.path);
      mkdirSync(path.dirname(destinationFile), { recursive: true, mode: 0o700 });
      compareFile(
        readSafe(
          fileAt(root, file.path),
          file.path === "studio.sqlite" ? limits.dbBytes : limits.fileBytes,
          destinationFile,
        ),
        file,
      );
    }
    const after = verifyLocalData(root);
    if (JSON.stringify(before.manifest) !== JSON.stringify(after.manifest)) fail("BACKUP_CHANGED");
    snapshotEqual(before.snapshot, inspectDirectory(target));
    completedIdentity = writeCompletion(
      target,
      before.snapshot,
      before.manifest.files,
      guard,
    ).identity;
    verifyLocalData(target);
    return {
      companies: before.manifest.companies,
      originals: before.snapshot.originals.length,
      accounts: before.manifest.accounts,
    };
  } catch (error) {
    if (completedIdentity) removeOwnMarker(target, guard, completedIdentity);
    throw error;
  }
}
async function main(args) {
  const [action, ...rest] = args;
  const options = {};
  if (
    ![
      "backup",
      "verify",
      "restore",
      "quality-backup",
      "quality-verify",
      "quality-restore",
    ].includes(action) ||
    rest.length % 2
  )
    fail("USAGE");
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (
      !["--source", "--destination"].includes(key) ||
      Object.hasOwn(options, key) ||
      !rest[index + 1]
    )
      fail("USAGE");
    options[key] = rest[index + 1];
  }
  if (
    !options["--source"] ||
    (action.endsWith("verify") ? options["--destination"] : !options["--destination"])
  )
    fail("USAGE");
  if (action.startsWith("quality-")) {
    const result =
      action === "quality-backup"
        ? await backupQualityData(options["--source"], options["--destination"])
        : action === "quality-restore"
          ? restoreQualityData(options["--source"], options["--destination"])
          : (() => {
              const { snapshot } = verifyQualityBackup(options["--source"]);
              return {
                runs: snapshot.runs,
                revisions: snapshot.revisions,
                requests: snapshot.requests,
                ...(snapshot.candidateVersions === undefined
                  ? {}
                  : {
                      candidateVersions: snapshot.candidateVersions,
                      candidateRequests: snapshot.candidateRequests,
                    }),
                ...(snapshot.executionRuns === undefined
                  ? {}
                  : {
                      executionRuns: snapshot.executionRuns,
                      executionEvents: snapshot.executionEvents,
                      executionRequests: snapshot.executionRequests,
                    }),
                ...(snapshot.actualBudgetEvents === undefined
                  ? {}
                  : {
                      actualBudgetEvents: snapshot.actualBudgetEvents,
                      actualRuns: snapshot.actualRuns,
                      actualEvents: snapshot.actualEvents,
                      actualArtifacts: snapshot.actualArtifacts,
                      actualRequests: snapshot.actualRequests,
                    }),
                ...(snapshot.providerPolicies === undefined
                  ? {}
                  : { providerPolicies: snapshot.providerPolicies }),
                ...(snapshot.providerReservationBindings === undefined
                  ? {}
                  : {
                      providerReservationBindings: snapshot.providerReservationBindings,
                      providerReservationCoverage: snapshot.providerReservationCoverage,
                    }),
                ...(snapshot.providerTransmissionBindings === undefined
                  ? {}
                  : {
                      providerTransmissionBindings: snapshot.providerTransmissionBindings,
                      providerTransmissionCoverage: snapshot.providerTransmissionCoverage,
                    }),
              };
            })();
    process.stdout.write(
      `${JSON.stringify({ ok: true, action, ...result, scope: "quality-records-structure-and-bytes-only", companyDataChanged: false, switched: false })}\n`,
    );
    return;
  }
  const result =
    action === "backup"
      ? await backupLocalData(options["--source"], options["--destination"])
      : action === "restore"
        ? restoreLocalData(options["--source"], options["--destination"])
        : (() => {
            const { snapshot } = verifyLocalData(options["--source"]);
            return {
              companies: snapshot.companies,
              originals: snapshot.originals.length,
              accounts: snapshot.accounts,
            };
          })();
  process.stdout.write(
    `${JSON.stringify({ ok: true, action, ...result, scope: "structure-and-bytes-only", credentials: "same-windows-user-may-be-required", switched: false })}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof DataToolError ? error.code : "LOCAL_DATA_FAILED";
    process.stderr.write(
      `${JSON.stringify({ ok: false, code, completed: false, overwritten: false })}\n`,
    );
    process.exitCode = 1;
  });
