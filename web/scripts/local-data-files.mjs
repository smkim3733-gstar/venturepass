import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export const limits = {
  companies: 500,
  originals: 20000,
  fileBytes: 12 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  dbBytes: 64 * 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024,
  caseBytes: 32 * 1024 * 1024,
};
export class DataToolError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const fail = (code) => {
  throw new DataToolError(code);
};
export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const samePath = (one, two) =>
  process.platform === "win32"
    ? path.resolve(one).toLowerCase() === path.resolve(two).toLowerCase()
    : path.resolve(one) === path.resolve(two);
export const within = (child, parent) => {
  const relative = path.relative(parent, child);
  return (
    !relative ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};
export function ancestors(target) {
  const absolute = path.resolve(target);
  const result = [];
  let current = path.parse(absolute).root;
  result.push(current);
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    result.push(current);
  }
  return result;
}
export function safePath(target, kind = "file") {
  const chain = ancestors(target);
  for (let index = 0; index < chain.length; index++) {
    const name = chain[index];
    const stat = lstatSync(name, { bigint: true });
    const leaf = index === chain.length - 1;
    if (
      stat.isSymbolicLink() ||
      !samePath(realpathSync(name), name) ||
      (leaf && kind === "file" ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())
    )
      fail("UNSAFE_PATH");
  }
  return lstatSync(target, { bigint: true });
}
export function nativePaths(paths) {
  if (process.platform !== "win32") return;
  const unique = [...new Set(paths.flatMap(ancestors))];
  const command =
    "$ErrorActionPreference='Stop'; $p=ConvertFrom-Json ([Console]::In.ReadToEnd()); foreach($v in $p){if(([IO.File]::GetAttributes($v) -band [IO.FileAttributes]::ReparsePoint)-ne 0){exit 31}}";
  const system = process.env.SystemRoot || "C:\\Windows";
  if (!path.win32.isAbsolute(system)) fail("UNSAFE_PATH");
  try {
    execFileSync(
      path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      {
        input: JSON.stringify(unique),
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024,
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
  } catch {
    fail("UNSAFE_PATH");
  }
}
const sameStat = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  b.nlink === 1n &&
  b.isFile();
export function readPrefixSafe(file, count, maximum = limits.dbBytes) {
  const before = safePath(file);
  if (before.size < BigInt(count) || before.size > BigInt(maximum)) fail("DATABASE_INVALID");
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(count);
    if (
      !sameStat(before, fstatSync(descriptor, { bigint: true })) ||
      readSync(descriptor, bytes, 0, count, 0) !== count ||
      !sameStat(before, fstatSync(descriptor, { bigint: true })) ||
      !sameStat(before, safePath(file))
    )
      fail("FILE_CHANGED");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
/**
 * @param {string} file
 * @param {number} maximum
 * @param {string | null} [destination]
 * @param {boolean} [collect]
 * @param {((identity: import('node:fs').BigIntStats) => void) | null} [onDestinationOpened]
 */
export function readSafe(
  file,
  maximum,
  destination = null,
  collect = false,
  onDestinationOpened = null,
) {
  const before = safePath(file);
  if (before.size > BigInt(maximum)) fail("FILE_LIMIT");
  let reader;
  let writer;
  const chunks = [];
  const digest = createHash("sha256");
  let total = 0;
  try {
    reader = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!sameStat(before, fstatSync(reader, { bigint: true }))) fail("FILE_CHANGED");
    if (destination) {
      safePath(path.dirname(destination), "directory");
      writer = openSync(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      onDestinationOpened?.(fstatSync(writer, { bigint: true }));
    }
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = readSync(reader, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > maximum || total > Number(before.size)) fail("FILE_CHANGED");
      const bytes = buffer.subarray(0, count);
      digest.update(bytes);
      if (collect) chunks.push(Buffer.from(bytes));
      if (writer !== undefined) {
        let sent = 0;
        while (sent < count) sent += writeSync(writer, bytes, sent, count - sent);
      }
    }
    if (
      total !== Number(before.size) ||
      !sameStat(before, fstatSync(reader, { bigint: true })) ||
      !sameStat(before, safePath(file))
    )
      fail("FILE_CHANGED");
    if (writer !== undefined) {
      const stat = fstatSync(writer, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(total)) fail("UNSAFE_PATH");
    }
    return {
      sizeBytes: total,
      sha256: digest.digest("hex"),
      ...(collect ? { bytes: Buffer.concat(chunks) } : {}),
    };
  } finally {
    if (reader !== undefined) closeSync(reader);
    if (writer !== undefined) closeSync(writer);
  }
}
export function createDestination(source, destination) {
  const target = path.resolve(destination);
  const parent = path.dirname(target);
  if (within(target, source) || within(source, target)) fail("DESTINATION_OVERLAP");
  safePath(parent, "directory");
  nativePaths([source, parent]);
  for (const name of ancestors(parent)) {
    try {
      lstatSync(path.join(name, ".git"));
      fail("DESTINATION_REPOSITORY");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const [key, value] of Object.entries(process.env))
    if (
      /^OneDrive(?:Consumer|Commercial)?$/i.test(key) &&
      value &&
      within(target, path.resolve(value))
    )
      fail("DESTINATION_SYNCED");
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") fail("DESTINATION_EXISTS");
    throw error;
  }
  safePath(target, "directory");
  nativePaths([target]);
  return target;
}
export function writeNew(file, bytes) {
  safePath(path.dirname(file), "directory");
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let sent = 0;
    while (sent < bytes.length) sent += writeSync(fd, bytes, sent, bytes.length - sent);
  } finally {
    closeSync(fd);
  }
  safePath(file);
}
