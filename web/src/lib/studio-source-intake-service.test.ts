import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioStore } from "./studio-storage";
import type { SourceIntakeItem, SourceIntakeCommand } from "./studio-source-intake-types";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ extract: vi.fn(), lock: vi.fn() }));
vi.mock("./studio-source-intake-extract", async (original) => ({
  ...(await original<typeof import("./studio-source-intake-extract")>()),
  extractLocalIntake: mock.extract,
}));
vi.mock("./venturein-input-lock", () => ({ assertVentureCompanyWritable: mock.lock }));
import { LocalIntakeExtractionError } from "./studio-source-intake-extract";
import {
  runSourceIntakeCommand,
  sourceIntakeStatus,
  uploadSourceIntakeOriginal,
} from "./studio-source-intake-service";
import { StudioError } from "./studio-http";

const caseId = randomUUID(),
  itemId = randomUUID(),
  sourceId = randomUUID(),
  attemptId = randomUUID();
let item: SourceIntakeItem;
let revision: number;
let acknowledged: boolean;
let terminal: boolean;
let currentNonce: string;
const original = {
  name: "synthetic.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("synthetic"),
};
const calls = {
  create: vi.fn(),
  upload: vi.fn(),
  resumeOriginal: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
  adopt: vi.fn(),
  discard: vi.fn(),
  original: vi.fn(),
};
function company() {
  return {
    id: caseId,
    revision,
    sourceIntakes: [
      {
        ...item,
        requests: acknowledged
          ? [{ clientRequestId: currentNonce, action: "run-next", inputDigest: "b".repeat(64) }]
          : [],
      },
    ],
  };
}
function response() {
  return { company: company(), batchId: item.batchId, item: { ...item } };
}
const store = {
  get: () => company(),
  createSourceIntakeBatch: calls.create,
  storeSourceIntakeOriginal: calls.upload,
  resumeSourceIntakeOriginal: calls.resumeOriginal,
  beginSourceIntakeAttempt: calls.begin,
  finishSourceIntakeAttempt: calls.finish,
  adoptSourceIntakeResult: calls.adopt,
  discardSourceIntakeResult: calls.discard,
  originalForVentureInput: calls.original,
} as unknown as StudioStore;
function command(action: "run-next" | "resume" = "run-next"): SourceIntakeCommand {
  currentNonce = randomUUID();
  const common = {
    action,
    revision,
    clientRequestId: currentNonce,
    itemId,
    expectedItemVersion: item.version,
  };
  return action === "run-next"
    ? { ...common, action, engine: "local-document" }
    : { ...common, action };
}
beforeEach(() => {
  vi.resetAllMocks();
  revision = 5;
  acknowledged = false;
  terminal = false;
  const now = new Date().toISOString();
  item = {
    id: itemId,
    batchId: randomUUID(),
    clientFileId: randomUUID(),
    sourceId,
    version: 3,
    declared: { originalName: original.name, sizeBytes: original.buffer.length, kind: "other" },
    original: {
      originalName: original.name,
      mimeType: original.mimeType,
      sizeBytes: original.buffer.length,
      sha256: "a".repeat(64),
      sourceUpdatedAt: now,
    },
    phase: "original_stored",
    attempts: [],
    result: null,
    previousResults: [],
    adoption: null,
    requests: [],
    createdAt: now,
    updatedAt: now,
    code: null,
  };
  calls.begin.mockImplementation(() => {
    acknowledged = true;
    if (!terminal) {
      revision++;
      item.version++;
      item.phase = "extracting_local";
    }
    return { response: response(), started: !terminal, attemptId: terminal ? null : attemptId };
  });
  calls.finish.mockImplementation(() => {
    item.phase = "awaiting_review";
    revision++;
    return response();
  });
  calls.original.mockImplementation(() => ({
    buffer: original.buffer,
    sha256: "a".repeat(64),
    source: {
      originalName: original.name,
      mimeType: original.mimeType,
      updatedAt: item.original!.sourceUpdatedAt,
    },
  }));
  calls.create.mockImplementation(response);
  calls.upload.mockImplementation(response);
  calls.resumeOriginal.mockImplementation(response);
  calls.adopt.mockImplementation(response);
  calls.discard.mockImplementation(response);
  mock.extract.mockResolvedValue({ content: { kind: "plain", text: "synthetic" }, warnings: [] });
});
describe("로컬 접수 작업 서비스", () => {
  it("durable 시작 이후 판독하며 정확한 시도·버전으로 결과를 저장한다", async () => {
    const input = command();
    const output = await runSourceIntakeCommand(store, caseId, input);
    expect(calls.begin).toHaveBeenCalledBefore(mock.extract);
    expect(calls.finish).toHaveBeenCalledWith(
      caseId,
      { revision: 6, itemId, itemVersion: 4, attemptId },
      { status: "completed", content: { kind: "plain", text: "synthetic" }, warnings: [] },
    );
    expect(output.item?.phase).toBe("awaiting_review");
    expect(sourceIntakeStatus(store, caseId).activeItemIds).toEqual([]);
  });
  it("같은 nonce의 완료 응답은 원본/파서를 다시 읽지 않는다", async () => {
    terminal = true;
    item.phase = "awaiting_review";
    await runSourceIntakeCommand(store, caseId, command());
    expect(mock.extract).not.toHaveBeenCalled();
    expect(calls.original).not.toHaveBeenCalled();
  });
  it.each(["awaiting_original", "storing_original"] as const)(
    "%s 재개는 파일 저장 조정만 수행한다",
    async (phase) => {
      item.phase = phase;
      await runSourceIntakeCommand(store, caseId, command("resume"));
      expect(calls.resumeOriginal).toHaveBeenCalledOnce();
      expect(calls.begin).not.toHaveBeenCalled();
      expect(mock.extract).not.toHaveBeenCalled();
    },
  );
  it("활성 worker가 있을 때 GET에 표시하고 같은 파일·다른 파일·원본 전송 재시작을 차단한다", async () => {
    let release!: (result: unknown) => void;
    mock.extract.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = runSourceIntakeCommand(store, caseId, command());
    expect(sourceIntakeStatus(store, caseId).activeItemIds).toEqual([itemId]);
    await expect(runSourceIntakeCommand(store, caseId, command("resume"))).rejects.toMatchObject({
      code: "INTAKE_BUSY",
    });
    await expect(
      uploadSourceIntakeOriginal(
        store,
        caseId,
        itemId,
        { revision, clientRequestId: randomUUID(), expectedItemVersion: item.version },
        original,
      ),
    ).rejects.toMatchObject({ code: "INTAKE_BUSY" });
    release({ content: { kind: "plain", text: "done" }, warnings: [] });
    await first;
    expect(calls.begin).toHaveBeenCalledOnce();
    expect(calls.upload).not.toHaveBeenCalled();
  });
  it("worker 없는 interrupted 상태만 명시 resume가 새 시도를 요청한다", async () => {
    item.phase = "extracting_local";
    item.attempts.push({
      id: randomUUID(),
      engine: "windows-ko",
      startedAt: item.createdAt,
      finishedAt: null,
      originalSha256: "a".repeat(64),
      sourceUpdatedAt: item.createdAt,
      externalRequestStarted: false,
      status: "running",
      code: null,
      resultId: null,
    });
    const input = command("resume");
    await runSourceIntakeCommand(store, caseId, input);
    expect(calls.begin).toHaveBeenCalledWith(caseId, input, "windows-ko");
    expect(mock.extract).toHaveBeenCalledWith(original, "windows-ko");
  });
  it("빈 PDF 결과를 고정 awaiting_method checkpoint로 보존한다", async () => {
    mock.extract.mockRejectedValue(
      new LocalIntakeExtractionError("INTAKE_NO_TEXT", "awaiting_method"),
    );
    await runSourceIntakeCommand(store, caseId, command());
    expect(calls.finish.mock.calls[0][2]).toEqual({
      status: "failed",
      code: "INTAKE_NO_TEXT",
      phase: "awaiting_method",
    });
  });
  it("파서의 원문 오류 대신 고정 실패코드만 저장한다", async () => {
    mock.extract.mockRejectedValue(new Error("PRIVATE INPUT PATH"));
    await runSourceIntakeCommand(store, caseId, command());
    expect(calls.finish.mock.calls[0][2]).toEqual({
      status: "failed",
      code: "INTAKE_EXTRACTION_FAILED",
      phase: "retryable_failure",
    });
  });
  it("늦은 완료 CAS 오류는 추가 저장 시도 없이 accepted:true로 종료한다", async () => {
    calls.finish.mockImplementation(() => {
      throw new StudioError("private", 409, "STALE_REVISION");
    });
    await expect(runSourceIntakeCommand(store, caseId, command())).rejects.toMatchObject({
      code: "STALE_REVISION",
      accepted: true,
    });
    expect(calls.finish).toHaveBeenCalledOnce();
    expect(sourceIntakeStatus(store, caseId).activeItemIds).toEqual([]);
  });
  it("시작 전 거절은 accepted:false이며 회사 잠금을 존중한다", async () => {
    mock.lock.mockImplementation(() => {
      throw new StudioError("locked", 409, "COMPANY_LOCKED");
    });
    await expect(runSourceIntakeCommand(store, caseId, command())).rejects.toMatchObject({
      accepted: false,
      code: "COMPANY_LOCKED",
    });
    expect(calls.begin).not.toHaveBeenCalled();
    expect(mock.extract).not.toHaveBeenCalled();
  });
  it("원본 SHA/메타가 시작 기록과 다르면 파서를 실행하지 않는다", async () => {
    calls.original.mockImplementation(() => ({
      buffer: original.buffer,
      sha256: "c".repeat(64),
      source: {},
    }));
    await expect(runSourceIntakeCommand(store, caseId, command())).rejects.toMatchObject({
      accepted: true,
      code: "INTAKE_ORIGINAL_CHANGED",
    });
    expect(mock.extract).not.toHaveBeenCalled();
  });
  it("외부 엔진 입력과 서버 필드를 strict 거부한다", async () => {
    await expect(
      runSourceIntakeCommand(store, caseId, {
        ...command(),
        engine: "ai-document",
      } as unknown as SourceIntakeCommand),
    ).rejects.toThrow();
    await expect(
      runSourceIntakeCommand(store, caseId, {
        ...command(),
        accepted: true,
      } as unknown as SourceIntakeCommand),
    ).rejects.toThrow();
    expect(calls.begin).not.toHaveBeenCalled();
  });
});
