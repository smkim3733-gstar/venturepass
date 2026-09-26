import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  document: vi.fn(),
  audio: vi.fn(),
  file: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    responses = { create: mocks.document };
    audio = { transcriptions: { create: mocks.audio } };
  },
  toFile: mocks.file,
}));
import {
  extractExternalIntake,
  ExternalIntakeProviderError,
  type ExternalIntakeProviderInput,
} from "./studio-source-intake-external";

function syntheticWave() {
  const value = Buffer.alloc(48);
  value.write("RIFF", 0);
  value.writeUInt32LE(40, 4);
  value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(8000, 24);
  value.writeUInt32LE(16000, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36);
  value.writeUInt32LE(4, 40);
  return value;
}
const input = (
  overrides: Partial<ExternalIntakeProviderInput> = {},
): ExternalIntakeProviderInput => {
  const buffer =
    overrides.buffer ??
    (overrides.engine === "ai-transcription"
      ? syntheticWave()
      : overrides.originalName?.endsWith(".png")
        ? Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/V9sAAAAASUVORK5CYII=",
            "base64",
          )
        : Buffer.from(
            "%PDF-1.7\nSynthetic provider bytes, never an actual company original.\n%%EOF",
          ));
  return {
    engine: "ai-document",
    model: "synthetic-model",
    originalName: "synthetic.pdf",
    mimeType: "application/pdf",
    originalSha256: createHash("sha256").update(buffer).digest("hex"),
    buffer,
    ...overrides,
  };
};
describe("외부 판독 provider: 요청 전 durable 콜백·1회 전송", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENAI_API_KEY", "synthetic-key-for-mock-only");
    mocks.document.mockResolvedValue({
      status: "completed",
      output_text: "  합성 미검토 판독문\n",
    });
    mocks.audio.mockResolvedValue({ text: "합성 음성 전사. 확인 필요." });
    mocks.file.mockResolvedValue({ name: "synthetic.wav" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("승인 checkpoint 콜백 이후 정확 1회 호출하고 본문을 미검토 plain으로 보존한다", async () => {
    const order: string[] = [];
    mocks.document.mockImplementation(async () => {
      order.push("provider");
      return { status: "completed", output_text: "  합성 미검토 판독문\n" };
    });
    const result = await extractExternalIntake(input(), async () => {
      order.push("durable");
    });
    expect(order).toEqual(["durable", "provider"]);
    expect(result.content).toEqual({ kind: "plain", text: "  합성 미검토 판독문\n" });
    expect(result).not.toHaveProperty("locations");
    expect(result.warnings.join(" ")).toContain("미검토");
    expect(mocks.document).toHaveBeenCalledTimes(1);
  });
  it("환경 base URL과 무관하게 검토한 OpenAI 목적지·재시도0·store:false를 사용한다", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://invalid.example/synthetic");
    await extractExternalIntake(input(), () => {});
    expect(mocks.options).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.openai.com/v1",
        maxRetries: 0,
        timeout: 120000,
      }),
    );
    expect(mocks.document.mock.calls[0][0]).toMatchObject({
      model: "synthetic-model",
      store: false,
    });
    expect(mocks.document.mock.calls[0][0].instructions).toContain("untrusted data");
  });
  it("키 미설정은 checkpoint와 외부호출 전에 거절한다", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const begin = vi.fn();
    await expect(extractExternalIntake(input(), begin)).rejects.toMatchObject({
      code: "INTAKE_AI_NOT_CONFIGURED",
      requestStarted: false,
    });
    expect(begin).not.toHaveBeenCalled();
    expect(mocks.document).not.toHaveBeenCalled();
  });
  it.each([
    { model: "model\ninvalid" },
    { originalName: "../synthetic.pdf" },
    { originalSha256: "0".repeat(64) },
    { buffer: Buffer.alloc(0) },
    { mimeType: "text/html" },
    { buffer: Buffer.alloc(12 * 1024 * 1024 + 1) },
  ])("로컬 원본·설정 오류는 전송하지 않는다 %#", async (override) => {
    const begin = vi.fn();
    await expect(extractExternalIntake(input(override), begin)).rejects.toMatchObject({
      requestStarted: false,
    });
    expect(begin).not.toHaveBeenCalled();
    expect(mocks.document).not.toHaveBeenCalled();
  });
  it("checkpoint 저장 실패는 SDK 호출하지 않고 민감 오류 내용을 내보내지 않는다", async () => {
    let error: unknown;
    try {
      await extractExternalIntake(input(), () => {
        throw new Error("synthetic-private-error-body");
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExternalIntakeProviderError);
    expect(error).toMatchObject({ code: "INTAKE_EXTERNAL_NOT_STARTED", requestStarted: false });
    expect(String(error)).not.toContain("synthetic-private-error-body");
    expect(mocks.document).not.toHaveBeenCalled();
  });
  it.each(["network", "timeout", "401", "429"])(
    "요청 이후 %s 실패는 자동 재시도하지 않고 미확인으로 남긴다",
    async (kind) => {
      mocks.document.mockRejectedValue(new Error(`synthetic-sensitive-${kind}`));
      const result = await extractExternalIntake(input(), () => {}).catch((error) => error);
      expect(result).toMatchObject({
        code: "INTAKE_EXTERNAL_RESULT_UNKNOWN",
        requestStarted: true,
      });
      expect(String(result)).not.toContain("synthetic-sensitive");
      expect(mocks.document).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { status: "incomplete", output_text: "일부" },
    { status: "completed", output_text: " " },
    { status: "completed", output_text: "a".repeat(100001) },
  ])("불완전·공란·초과 응답을 잘라 성공으로 저장하지 않는다 %#", async (response) => {
    mocks.document.mockResolvedValue(response);
    await expect(extractExternalIntake(input(), () => {})).rejects.toMatchObject({
      requestStarted: true,
    });
    expect(mocks.document).toHaveBeenCalledTimes(1);
  });
  it("이미지는 검증 MIME으로 정확한 바이트를 보내고 구조 위치를 꾸미지 않는다", async () => {
    const value = input({ originalName: "synthetic.png", mimeType: "image/png" });
    const result = await extractExternalIntake(value, () => {});
    expect(mocks.document.mock.calls[0][0].input[0].content[1]).toMatchObject({
      type: "input_image",
      image_url: `data:image/png;base64,${value.buffer.toString("base64")}`,
    });
    expect(result).not.toHaveProperty("locations");
  });
  it("음성 파일 준비 후 checkpoint→전사를 실행하고 임의 시각을 생성하지 않는다", async () => {
    const order: string[] = [];
    mocks.file.mockImplementation(async () => {
      order.push("file");
      return { name: "synthetic.wav" };
    });
    mocks.audio.mockImplementation(async () => {
      order.push("provider");
      return { text: "합성 전사" };
    });
    const result = await extractExternalIntake(
      input({
        engine: "ai-transcription",
        model: "synthetic-transcription",
        originalName: "synthetic.wav",
        mimeType: "audio/wav",
      }),
      () => {
        order.push("durable");
      },
    );
    expect(order).toEqual(["file", "durable", "provider"]);
    expect(mocks.audio).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "synthetic-transcription",
        response_format: "json",
        language: "ko",
      }),
    );
    expect(mocks.document).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("locations");
    expect(result.warnings.join(" ")).toContain("시간 위치는 생성하지 않았습니다");
  });
  it("음성 파일 준비 실패는 durable 시작도 전송도 수행하지 않는다", async () => {
    mocks.file.mockRejectedValue(new Error("synthetic-file-error"));
    const begin = vi.fn();
    await expect(
      extractExternalIntake(
        input({ engine: "ai-transcription", originalName: "synthetic.wav", mimeType: "audio/wav" }),
        begin,
      ),
    ).rejects.toMatchObject({ requestStarted: false });
    expect(begin).not.toHaveBeenCalled();
    expect(mocks.audio).not.toHaveBeenCalled();
  });
  it.each([null, "application/octet-stream", "audio/wave", "audio/vnd.wave"])(
    "승인 MIME %s를 보존하면서 검증한 WAV 바이트를 표준 MIME으로 전송한다",
    async (mimeType) => {
      const value = input({
        engine: "ai-transcription",
        originalName: "synthetic.wav",
        mimeType,
      });
      await extractExternalIntake(value, () => {});
      expect(mocks.file).toHaveBeenCalledWith(value.buffer, value.originalName, {
        type: "audio/wav",
      });
      expect(value.mimeType).toBe(mimeType);
      expect(mocks.audio).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, "application/octet-stream"])(
    "이미지 MIME %s도 원본 서명 확인 후 표준 MIME으로 전송한다",
    async (mimeType) => {
      const value = input({ originalName: "synthetic.png", mimeType });
      await extractExternalIntake(value, () => {});
      expect(mocks.document.mock.calls[0][0].input[0].content[1].image_url).toBe(
        `data:image/png;base64,${value.buffer.toString("base64")}`,
      );
      expect(value.mimeType).toBe(mimeType);
    },
  );
});
