import { EventEmitter } from "node:events";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { runWindowsOcr } from "./studio-windows-ocr";
import { localOcrLimits } from "./studio-local-ocr-types";
import { windowsOcrScript } from "./studio-windows-ocr-script";

const originalPlatform = process.platform;
const bytes = Buffer.from("%PDF-1.7\nSYNTHETIC ONLY");
let directories: string[] = [];
type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  shell: boolean;
  windowsHide: boolean;
  stdio: string;
};
function respond(
  result: unknown = { pages: [{ pageNumber: 1, text: "가상 판독 2026" }] },
  code = 0,
) {
  spawn.mockImplementation((_executable: string, _args: string[], options: SpawnOptions) => {
    directories.push(options.cwd);
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => child.emit("close", null)),
    });
    queueMicrotask(() => {
      writeFileSync(
        path.join(options.cwd, "output.json"),
        typeof result === "string" ? result : JSON.stringify(result),
      );
      child.emit("close", code);
    });
    return child;
  });
}
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
  directories = [];
  spawn.mockReset();
  respond();
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of directories) expect(existsSync(directory)).toBe(false);
});

describe("Windows 로컬 판독 runtime — 고정 프로그램·가상 child", () => {
  it("고정 실행 파일·숨김 창·비밀 없는 환경만 사용하고 성공 뒤 원본·결과를 정리한다", async () => {
    vi.stubEnv("OPENAI_API_KEY", "NEVER_IN_CHILD");
    const delegate = spawn.getMockImplementation()!;
    spawn.mockImplementation((executable, args, options) => {
      expect(executable).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
      expect(args).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsOcrScript, "utf16le").toString("base64"),
      ]);
      expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: "ignore" });
      expect(JSON.stringify(options.env)).not.toContain("NEVER_IN_CHILD");
      expect(readFileSync(path.join(options.cwd, "input.img"))).toEqual(bytes);
      expect(windowsOcrScript).not.toMatch(
        /active-run|source-metadata|\.venture-pass|Invoke-WebRequest|Invoke-RestMethod/,
      );
      return delegate(executable, args, options);
    });
    const result = await runWindowsOcr(bytes, "image/png");
    expect(result.pages).toEqual([{ pageNumber: 1, text: "가상 판독 2026" }]);
    expect(result.warnings.join(" ")).toContain("미검토");
  });

  it("PDF는 고정 CPU renderer 다음 OCR을 실행하며 동일 작업 한도와 폴더를 공유한다", async () => {
    spawn.mockImplementation((executable, args, options) => {
      directories.push(options.cwd);
      const child = new EventEmitter();
      const renderer = executable === process.execPath;
      if (renderer) {
        expect(args).toEqual(["--max-old-space-size=384", path.join(options.cwd, "render.cjs")]);
        expect(options.env.VENTURE_OCR_PDF_MODULE).toMatch(/pdf-parse.*index\.cjs$/);
        expect(readFileSync(path.join(options.cwd, "input.pdf"))).toEqual(bytes);
      } else expect(args).not.toContain("-ExecutionPolicy");
      queueMicrotask(() => {
        writeFileSync(
          path.join(options.cwd, renderer ? "rendered.json" : "output.json"),
          JSON.stringify(
            renderer ? { pages: 1 } : { pages: [{ pageNumber: 1, text: "PDF 2026" }] },
          ),
        );
        if (renderer) writeFileSync(path.join(options.cwd, "page-1.png"), "SYNTHETIC IMAGE");
        child.emit("close", 0);
      });
      return child;
    });
    expect((await runWindowsOcr(bytes, "application/pdf")).pages[0].text).toBe("PDF 2026");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(new Set(directories).size).toBe(1);
  });

  it("native 캐시 하위폴더를 정리하되 하위 링크 대상은 따라가지 않는다", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "venturepass-ocr-outside-"));
    const keep = path.join(outside, "keep.txt");
    writeFileSync(keep, "SYNTHETIC KEEP");
    try {
      const delegate = spawn.getMockImplementation()!;
      spawn.mockImplementation((executable, args, options) => {
        mkdirSync(path.join(options.cwd, "native-cache"));
        writeFileSync(path.join(options.cwd, "native-cache", "cache.bin"), "SYNTHETIC CACHE");
        symlinkSync(outside, path.join(options.cwd, "outside-link"), "junction");
        return delegate(executable, args, options);
      });
      await runWindowsOcr(bytes, "image/png");
      expect(readFileSync(keep, "utf8")).toBe("SYNTHETIC KEEP");
    } finally {
      unlinkSync(keep);
      rmdirSync(outside);
    }
  });

  it("출력 hardlink는 fd 읽기 전에 거부하고 링크 대상은 보존한다", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "venturepass-ocr-outside-"));
    const keep = path.join(outside, "keep.json");
    writeFileSync(keep, JSON.stringify({ pages: [{ pageNumber: 1, text: "SYNTHETIC KEEP" }] }));
    try {
      spawn.mockImplementation((_executable, _args, options) => {
        directories.push(options.cwd);
        const child = new EventEmitter();
        queueMicrotask(() => {
          linkSync(keep, path.join(options.cwd, "output.json"));
          child.emit("close", 0);
        });
        return child;
      });
      await expect(runWindowsOcr(bytes, "image/png")).rejects.toMatchObject({
        code: "OCR_OUTPUT_LIMIT",
      });
      expect(readFileSync(keep, "utf8")).toContain("SYNTHETIC KEEP");
    } finally {
      unlinkSync(keep);
      rmdirSync(outside);
    }
  });

  it("지원 이미지도 고정 input.img로 전달한다", async () => {
    const delegate = spawn.getMockImplementation()!;
    spawn.mockImplementation((executable, args, options) => {
      expect(readFileSync(path.join(options.cwd, "input.img"))).toEqual(bytes);
      return delegate(executable, args, options);
    });
    await runWindowsOcr(bytes, "image/png");
  });

  it("Windows 외 환경은 child 없이 명확히 거부한다", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(runWindowsOcr(bytes, "image/png")).rejects.toMatchObject({
      code: "OCR_PLATFORM_UNSUPPORTED",
      status: 501,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([Buffer.alloc(0), Buffer.alloc(localOcrLimits.bytes + 1)])(
    "빈 원본·용량 초과는 프로세스 전에 거부한다",
    async (input) => {
      await expect(runWindowsOcr(input, "image/png")).rejects.toMatchObject({
        code: "OCR_FAILED",
      });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    "OCR_LANGUAGE_UNAVAILABLE",
    "OCR_PAGE_LIMIT",
    "OCR_IMAGE_LIMIT",
    "OCR_OUTPUT_LIMIT",
    "OCR_MULTIFRAME_UNSUPPORTED",
    "OCR_TIMEOUT",
  ])("고정 %s 오류를 전달하고 busy를 해제한다", async (code) => {
    respond({ failureCode: code }, 1);
    await expect(runWindowsOcr(bytes, "image/png")).rejects.toMatchObject({ code });
    respond();
    await expect(runWindowsOcr(bytes, "image/png")).resolves.toHaveProperty("pages");
  });

  it.each([
    "not json PRIVATE",
    { failureCode: "PRIVATE C:/SECRET" },
    { pages: [], path: "PRIVATE" },
  ])("비정상 결과의 원문·경로를 오류로 내보내지 않는다", async (result) => {
    respond(result, 1);
    const error = await runWindowsOcr(bytes, "image/png").catch((error) => error);
    expect(error).toMatchObject({ code: "OCR_FAILED" });
    expect(error.message).not.toMatch(/PRIVATE|SECRET/);
  });

  it.each([
    { pages: [] },
    { pages: [{ pageNumber: 2, text: "내용" }] },
    { pages: Array.from({ length: 21 }, (_, index) => ({ pageNumber: index + 1, text: "내용" })) },
    { pages: [{ pageNumber: 1, text: "x".repeat(100001) }] },
    {
      pages: [
        { pageNumber: 1, text: "x".repeat(60000) },
        { pageNumber: 2, text: "x".repeat(60000) },
      ],
    },
    { pages: [{ pageNumber: 1, text: "내용", private: "ignored" }] },
  ])("결과 페이지·총문자·엄격 shape 한도를 재검사한다", async (result) => {
    respond(result);
    await expect(runWindowsOcr(bytes, "image/png")).rejects.toMatchObject({
      code: "OCR_OUTPUT_LIMIT",
    });
  });

  it("큰 JSON 출력은 읽기 전에 파일 크기로 차단한다", async () => {
    respond("x".repeat(localOcrLimits.text * 8 + 10001));
    await expect(runWindowsOcr(bytes, "image/png")).rejects.toMatchObject({
      code: "OCR_OUTPUT_LIMIT",
    });
  });

  it("동시에 하나만 실행하고 종료 후 다음 작업을 허용한다", async () => {
    let child!: EventEmitter;
    spawn.mockImplementation((_executable, _args, options) => {
      directories.push(options.cwd);
      child = new EventEmitter();
      return child;
    });
    const first = runWindowsOcr(bytes, "image/png");
    await expect(runWindowsOcr(bytes, "image/png")).rejects.toMatchObject({
      code: "OCR_BUSY",
    });
    writeFileSync(
      path.join(directories[0], "output.json"),
      JSON.stringify({ pages: [{ pageNumber: 1, text: "내용" }] }),
    );
    child.emit("close", 0);
    await first;
    respond();
    await runWindowsOcr(bytes, "image/png");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("120초 제한에서 child를 종료하고 임시파일·busy를 정리한다", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => child.emit("close", null)),
    });
    spawn.mockImplementation((_executable, _args, options) => {
      directories.push(options.cwd);
      return child;
    });
    const result = runWindowsOcr(bytes, "image/png").catch((error) => error);
    await vi.advanceTimersByTimeAsync(localOcrLimits.timeoutMs);
    expect(await result).toMatchObject({ code: "OCR_TIMEOUT" });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("프로세스 시작 실패도 원문 없이 정리한다", async () => {
    spawn.mockImplementation((_executable, _args, options) => {
      directories.push(options.cwd);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("PRIVATE executable path")));
      return child;
    });
    await expect(runWindowsOcr(bytes, "image/png")).rejects.toMatchObject({
      code: "OCR_PLATFORM_UNSUPPORTED",
    });
  });
});
