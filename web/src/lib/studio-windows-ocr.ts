import "server-only";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StudioError } from "./studio-http";
import {
  localOcrLimits,
  localOcrMimeTypes,
  localOcrPagesSchema,
  type LocalOcrMimeType,
  type LocalOcrPage,
} from "./studio-local-ocr-types";
import { pdfRenderScript, windowsOcrScript } from "./studio-windows-ocr-script";

const globalState = globalThis as typeof globalThis & {
  __venturepassLocalOcr?: { active: boolean };
};
const state = (globalState.__venturepassLocalOcr ??= { active: false });
const errors: Record<string, [number, string]> = {
  OCR_PLATFORM_UNSUPPORTED: [
    501,
    "로컬 판독은 한국어 OCR이 설치된 Windows에서 사용할 수 있습니다.",
  ],
  OCR_LANGUAGE_UNAVAILABLE: [503, "Windows 한국어 OCR 언어 기능을 설치한 뒤 다시 시도해 주세요."],
  OCR_BUSY: [409, "다른 로컬 판독이 진행 중입니다. 완료 후 다시 시도해 주세요."],
  OCR_PAGE_LIMIT: [
    413,
    "로컬 판독은 PDF 20페이지까지 지원합니다. 필요한 페이지를 나누어 등록해 주세요.",
  ],
  OCR_IMAGE_LIMIT: [
    413,
    "이미지 크기가 로컬 판독 한도를 초과했습니다. 해상도를 줄여 등록해 주세요.",
  ],
  OCR_OUTPUT_LIMIT: [413, "판독 본문은 10만 자까지 지원합니다. 자료를 나누어 등록해 주세요."],
  OCR_TIMEOUT: [504, "로컬 판독이 제한 시간 2분을 초과했습니다. 자료를 나누어 다시 시도해 주세요."],
  OCR_MULTIFRAME_UNSUPPORTED: [
    415,
    "여러 프레임의 이미지는 지원하지 않습니다. 페이지별 이미지나 PDF로 등록해 주세요.",
  ],
  OCR_FAILED: [
    422,
    "로컬 판독에 실패했습니다. 암호·손상 여부와 Windows 판독 기능을 확인해 주세요.",
  ],
  OCR_CLEANUP_FAILED: [
    500,
    "판독 임시자료 정리를 완료하지 못했습니다. 앱을 종료하고 Windows 임시폴더의 VenturePass OCR 자료를 확인해 주세요.",
  ],
};
function fail(code: string): never {
  const [status, message] = errors[code] ?? errors.OCR_FAILED;
  throw new StudioError(message, status, code in errors ? code : "OCR_FAILED");
}

/** Only this fixed program is launched. Input bytes never enter argv, environment or stdout. */
async function runProcess(
  executable: string,
  args: string[],
  directory: string,
  systemRoot: string,
  remainingMs: number,
  extraEnv: Record<string, string> = {},
) {
  if (remainingMs <= 0) fail("OCR_TIMEOUT");
  return new Promise<number>((resolve, reject) => {
    let timedOut = false;
    const child = spawn(executable, args, {
      cwd: directory,
      windowsHide: true,
      shell: false,
      stdio: "ignore",
      env: {
        NODE_ENV: "production",
        SystemRoot: systemRoot,
        windir: systemRoot,
        PATH: path.join(systemRoot, "System32"),
        TEMP: directory,
        TMP: directory,
        ...extraEnv,
      },
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, remainingMs);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new StudioError(errors.OCR_PLATFORM_UNSUPPORTED[1], 501, "OCR_PLATFORM_UNSUPPORTED"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new StudioError(errors.OCR_TIMEOUT[1], 504, "OCR_TIMEOUT"));
      else resolve(code ?? -1);
    });
  });
}

/** Check our exact real directory and identity before removing native renderer cache children. */
function cleanup(directory: string, root: string, identity: { dev: number; ino: number }) {
  const stat = lstatSync(directory);
  if (
    path.dirname(directory) !== root ||
    !/^venturepass-ocr-[A-Za-z0-9]+$/.test(path.basename(directory)) ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino ||
    realpathSync(directory) !== directory
  )
    fail("OCR_CLEANUP_FAILED");
  let count = 0;
  const removeChildren = (current: string) => {
    for (const name of readdirSync(current)) {
      if (++count > 512) fail("OCR_CLEANUP_FAILED");
      const target = path.join(current, name);
      const child = lstatSync(target);
      if (child.isSymbolicLink()) {
        unlinkSync(target);
        continue;
      }
      const resolved = realpathSync(target);
      if (resolved !== target || !resolved.startsWith(directory + path.sep))
        fail("OCR_CLEANUP_FAILED");
      if (child.isDirectory()) {
        removeChildren(target);
        rmdirSync(target);
      } else unlinkSync(target);
    }
  };
  try {
    removeChildren(directory);
    rmdirSync(directory);
  } catch {
    fail("OCR_CLEANUP_FAILED");
  }
}

/** Do not follow output links or accept a changed file between stat, read and parse. */
function readOutput(file: string, maximum: number): unknown {
  const before = lstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== BigInt(1) ||
    before.size > BigInt(maximum) ||
    realpathSync(file) !== file
  )
    fail("OCR_OUTPUT_LIMIT");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const matches = (stat: typeof before) =>
      stat.isFile() &&
      stat.dev === before.dev &&
      stat.ino === before.ino &&
      stat.size === before.size &&
      stat.mtimeNs === before.mtimeNs &&
      stat.ctimeNs === before.ctimeNs &&
      stat.nlink === BigInt(1);
    if (!matches(fstatSync(fd, { bigint: true }))) fail("OCR_FAILED");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) fail("OCR_FAILED");
      offset += read;
    }
    if (
      !matches(fstatSync(fd, { bigint: true })) ||
      !matches(lstatSync(file, { bigint: true })) ||
      realpathSync(file) !== file
    )
      fail("OCR_FAILED");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

export async function runWindowsOcr(
  buffer: Buffer,
  mimeType: LocalOcrMimeType,
): Promise<{ pages: LocalOcrPage[]; warnings: string[] }> {
  if (process.platform !== "win32") fail("OCR_PLATFORM_UNSUPPORTED");
  if (
    !Buffer.isBuffer(buffer) ||
    !buffer.length ||
    buffer.length > localOcrLimits.bytes ||
    !localOcrMimeTypes.includes(mimeType)
  )
    fail("OCR_FAILED");
  if (state.active) fail("OCR_BUSY");
  state.active = true;
  let directory: string | null = null;
  let root = "";
  let identity: { dev: number; ino: number } | null = null;
  const deadline = Date.now() + localOcrLimits.timeoutMs;
  try {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    if (!path.win32.isAbsolute(systemRoot)) fail("OCR_PLATFORM_UNSUPPORTED");
    const executable = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    root = realpathSync(tmpdir());
    directory = realpathSync(mkdtempSync(path.join(root, "venturepass-ocr-")));
    const stat = lstatSync(directory);
    identity = { dev: stat.dev, ino: stat.ino };
    if (path.dirname(directory) !== root || stat.isSymbolicLink()) fail("OCR_FAILED");
    writeFileSync(
      path.join(directory, mimeType === "application/pdf" ? "input.pdf" : "input.img"),
      buffer,
      { flag: "wx", mode: 0o600 },
    );
    let exitCode = 0;
    if (mimeType === "application/pdf") {
      // Resolve through Node at runtime. Webpack rewrites createRequire(...).resolve
      // into a numeric bundle ID, which cannot be required by the isolated child.
      const modulePath = process
        .getBuiltinModule("module")
        .createRequire(path.join(process.cwd(), "package.json"))
        .resolve("pdf-parse");
      writeFileSync(path.join(directory, "render.cjs"), pdfRenderScript, {
        flag: "wx",
        mode: 0o600,
      });
      exitCode = await runProcess(
        process.execPath,
        ["--max-old-space-size=384", path.join(directory, "render.cjs")],
        directory,
        systemRoot,
        deadline - Date.now(),
        { VENTURE_OCR_PDF_MODULE: modulePath },
      );
      if (exitCode === 0) {
        const rendered = readOutput(path.join(directory, "rendered.json"), 1024);
        if (
          typeof rendered !== "object" ||
          rendered === null ||
          !("pages" in rendered) ||
          !Number.isInteger(rendered.pages) ||
          Number(rendered.pages) < 1 ||
          Number(rendered.pages) > localOcrLimits.pages ||
          Object.keys(rendered).length !== 1
        )
          fail("OCR_PAGE_LIMIT");
      }
    }
    if (exitCode === 0)
      exitCode = await runProcess(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(windowsOcrScript, "utf16le").toString("base64"),
        ],
        directory,
        systemRoot,
        deadline - Date.now(),
      );
    const outputPath = path.join(directory, "output.json");
    const result = readOutput(outputPath, localOcrLimits.text * 8 + 10_000);
    if (exitCode !== 0) {
      const code =
        typeof result === "object" && result !== null && "failureCode" in result
          ? result.failureCode
          : null;
      fail(typeof code === "string" ? code : "OCR_FAILED");
    }
    if (
      typeof result !== "object" ||
      result === null ||
      !("pages" in result) ||
      Object.keys(result).some((key) => key !== "pages")
    )
      fail("OCR_FAILED");
    const parsed = localOcrPagesSchema.safeParse(result.pages);
    if (!parsed.success) fail("OCR_OUTPUT_LIMIT");
    return {
      pages: parsed.data,
      warnings: [
        "Windows 한국어 OCR의 미검토 판독 초안입니다. 누락·오인식 가능성이 있으므로 원본의 모든 페이지와 숫자·날짜·이름을 대조해 주세요.",
        "로컬 판독만 수행했습니다. 원본·자료 본문·분석 상태는 변경하지 않았습니다.",
      ],
    };
  } catch (error) {
    if (error instanceof StudioError) throw error;
    return fail("OCR_FAILED");
  } finally {
    try {
      if (directory && identity) cleanup(directory, root, identity);
    } finally {
      state.active = false;
    }
  }
}
