import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmdirSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { safePath, readSafe } from "./local-data-files.mjs";

// Shared mechanics only. Purpose-specific callers own schema, limits, and error policy.
export function readJournalJson(file, maximum, fail) {
  const bytes = readSafe(file, maximum, null, true).bytes;
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("JOURNAL_INVALID");
  }
  if (!bytes.equals(Buffer.from(JSON.stringify(value) + "\n"))) fail("JOURNAL_INVALID");
  return value;
}
export function writeJournalJson(file, value, maximum, fail) {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > maximum) fail("JOURNAL_INVALID");
  safePath(path.dirname(file), "directory");
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const sent = writeSync(fd, bytes, offset, bytes.length - offset);
      if (sent <= 0) fail("IO_UNCONFIRMED");
      offset += sent;
    }
    fsyncSync(fd);
    const opened = fstatSync(fd, { bigint: true }),
      current = safePath(file);
    if (
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      current.size !== BigInt(bytes.length)
    )
      fail("IO_UNCONFIRMED");
  } finally {
    closeSync(fd);
  }
}
export function journalIdentity(file, kind = "file") {
  const s = safePath(file, kind);
  return { dev: s.dev.toString(), ino: s.ino.toString(), birthtimeNs: s.birthtimeNs.toString() };
}
export function acquireJournalLease(lock, fail) {
  safePath(path.dirname(lock), "directory");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") fail("BUSY");
    throw error;
  }
  const original = journalIdentity(lock, "directory");
  let closed = false;
  function guard() {
    if (closed) fail("CLOSED");
    if (JSON.stringify(journalIdentity(lock, "directory")) !== JSON.stringify(original))
      fail("BUSY");
  }
  return {
    guard,
    close() {
      if (closed) return;
      guard();
      rmdirSync(lock);
      closed = true;
    },
  };
}
