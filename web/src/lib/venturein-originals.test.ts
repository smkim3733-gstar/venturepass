import { randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  unlinkSync,
  symlinkSync,
  linkSync,
  mkdirSync,
  renameSync,
  utimesSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type SourceDocument, type StudioCase } from "./studio-schema";
import { MAX_VENTURE_ORIGINAL_BYTES, readVentureOriginal } from "./venturein-originals";

vi.mock("server-only", () => ({}));
const hook = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: (...args: unknown[]) => {
      const count = (actual.readSync as (...values: unknown[]) => number)(...args);
      const callback = hook.afterRead;
      hook.afterRead = undefined;
      callback?.();
      return count;
    },
  };
});

describe("승인 첨부용 원본 읽기", () => {
  let directory: string;
  let store: StudioStore;
  let company: StudioCase;
  let document: SourceDocument;
  const bytes = Buffer.from("synthetic attachment\n");
  const file = () => join(directory, "originals", company.id, `${document.id}.bin`);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-original-test-"));
    store = new StudioStore(directory);
    company = store.create({ ...emptyProfile(), companyName: "첨부 시험기업" });
    const now = new Date().toISOString();
    document = {
      id: randomUUID(),
      name: "시험자료",
      kind: "technology",
      text: "",
      originalName: "자료 v1..final.pdf",
      mimeType: "application/pdf",
      extraction: "local",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    company = store.addUpload(company.id, company.revision, document, bytes);
  });
  afterEach(() => {
    hook.afterRead = undefined;
    store.close();
    const target = resolve(directory);
    const boundary = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(boundary) ||
      boundary.startsWith("..") ||
      !basename(target).startsWith("venture-original-test-")
    )
      throw new Error("Unsafe test cleanup");
    rmSync(target, { recursive: true, force: true });
  });
  function changeMetadata(values: Partial<SourceDocument>) {
    document = { ...document, ...values };
    // Legacy or externally changed metadata: public source edits intentionally preserve file metadata.
    company = { ...store.get(company.id), revision: company.revision + 1 };
    company.sources = company.sources.map((item) => (item.id === document.id ? document : item));
    const database = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      database
        .prepare("UPDATE studio_cases SET revision = ?, body = ? WHERE id = ?")
        .run(company.revision, JSON.stringify(company), company.id);
    } finally {
      database.close();
    }
  }
  it("실제 바이트와 SHA256, 저장 메타데이터만 반환하며 경로를 노출하지 않는다", () => {
    const result = readVentureOriginal(store, company.id, document.id);
    expect(result).toEqual({
      source: document,
      buffer: bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(Object.keys(result).sort()).toEqual(["buffer", "sha256", "source"]);
    expect(readFileSync(file())).toEqual(bytes);
  });
  it("동일 크기 원본 교체도 내용 해시가 달라져 승인 manifest와 비교할 수 있다", () => {
    const first = readVentureOriginal(store, company.id, document.id);
    writeFileSync(file(), Buffer.alloc(bytes.length, 65));
    const second = readVentureOriginal(store, company.id, document.id);
    expect(first.buffer.byteLength).toBe(second.buffer.byteLength);
    expect(first.sha256).not.toBe(second.sha256);
  });
  it("없는 자료와 다른 회사 자료 ID를 읽지 않는다", () => {
    const other = store.create({ ...emptyProfile(), companyName: "다른 시험기업" });
    expect(() => readVentureOriginal(store, company.id, randomUUID())).toThrowError(
      expect.objectContaining({ code: "SOURCE_NOT_FOUND" }),
    );
    expect(() => readVentureOriginal(store, other.id, document.id)).toThrowError(
      expect.objectContaining({ code: "SOURCE_NOT_FOUND" }),
    );
  });
  it.each([
    "../secret.pdf",
    "..\\secret.pdf",
    "C:secret.pdf",
    "bad\u0000.pdf",
    "bad\n.pdf",
    ".",
    "..",
    "bad.pdf.",
    "CON.pdf",
  ])("경로형 또는 모호한 원본명 %j를 거부한다", (name) => {
    changeMetadata({ originalName: name });
    expect(() => readVentureOriginal(store, company.id, document.id)).toThrowError(
      expect.objectContaining({ code: "INVALID_ORIGINAL_NAME" }),
    );
  });
  it.each([
    "text/plain\r\nX-Test: value",
    "application/pdf; charset=utf-8",
    "text/plain; charset=utf-7",
    "image/*",
    "",
    "application/pdf;boundary=value",
  ])("안전하지 않은 MIME %j를 거부한다", (mimeType) => {
    changeMetadata({ mimeType });
    expect(() => readVentureOriginal(store, company.id, document.id)).toThrowError(
      expect.objectContaining({ code: "INVALID_ORIGINAL_MIME" }),
    );
  });
  it.each([null, "text/plain; charset=utf-8", "text/plain;charset=us-ascii"])(
    "MIME %j는 변환 없이 보존한다",
    (mimeType) => {
      changeMetadata({ mimeType });
      expect(readVentureOriginal(store, company.id, document.id).source.mimeType).toBe(mimeType);
    },
  );
  it("12MiB를 초과하면 버퍼를 읽기 전에 거부한다", () => {
    writeFileSync(file(), Buffer.alloc(MAX_VENTURE_ORIGINAL_BYTES + 1));
    expect(() => readVentureOriginal(store, company.id, document.id)).toThrowError(
      expect.objectContaining({ code: "ORIGINAL_TOO_LARGE", status: 413 }),
    );
  });
  it("읽는 도중 같은 크기로 바꾸고 mtime을 복구해도 ctime 변경을 거부한다", () => {
    const before = statSync(file());
    hook.afterRead = () => {
      writeFileSync(file(), Buffer.alloc(bytes.length, 66));
      utimesSync(file(), before.atime, before.mtime);
    };
    expect(() => readVentureOriginal(store, company.id, document.id)).toThrowError(
      expect.objectContaining({ code: "ORIGINAL_CHANGED" }),
    );
  });
  it("읽는 도중 source 메타데이터가 바뀌면 승인용 읽기를 거부한다", () => {
    hook.afterRead = () => changeMetadata({ originalName: "changed.pdf" });
    expect(() => readVentureOriginal(store, company.id, document.id)).toThrowError(
      expect.objectContaining({ code: "ORIGINAL_METADATA_CHANGED" }),
    );
  });
  it("leaf hardlink를 원본으로 사용하지 않는다", () => {
    const target = join(directory, "hardlink-target.bin");
    renameSync(file(), target);
    linkSync(target, file());
    expect(() => readVentureOriginal(store, company.id, document.id)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_ORIGINAL_PATH" }),
    );
  });
  it("부모 junction 또는 symlink를 거부한다", () => {
    const parent = join(directory, "originals", company.id);
    const target = join(directory, "redirect-parent");
    renameSync(parent, target);
    symlinkSync(target, parent, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => readVentureOriginal(store, company.id, document.id)).toThrowError(
        expect.objectContaining({ code: "UNSAFE_ORIGINAL_PATH" }),
      );
    } finally {
      unlinkSync(parent);
    }
  });
  it("leaf symlink를 거부한다(Windows 생성 권한이 없으면 건너뜀)", (context) => {
    const target = join(directory, "link-target.bin");
    renameSync(file(), target);
    try {
      symlinkSync(target, file(), "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        context.skip();
        return;
      }
      throw error;
    }
    try {
      expect(() => readVentureOriginal(store, company.id, document.id)).toThrowError(
        expect.objectContaining({ code: "UNSAFE_ORIGINAL_PATH" }),
      );
    } finally {
      unlinkSync(file());
    }
  });
  it("원본을 directory로 바꾸면 거부하고 오류에 경로를 노출하지 않는다", () => {
    unlinkSync(file());
    mkdirSync(file());
    try {
      readVentureOriginal(store, company.id, document.id);
      throw new Error("Expected rejection");
    } catch (error) {
      expect((error as Error).message).not.toContain(directory);
      expect(error).toMatchObject({ code: "UNSAFE_ORIGINAL_PATH" });
    }
  });
});
