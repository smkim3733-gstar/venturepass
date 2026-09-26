import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile } from "./studio-schema";
import { sourceIntakeStatus } from "./studio-source-intake-service";
import {
  sourceIntakeExternalConfiguration,
  type RunExternalSourceIntakeCommand,
} from "./studio-source-intake-external-types";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  provider: vi.fn(),
  file: vi.fn(),
  options: vi.fn(),
}));
vi.mock("./studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor(options: unknown) {
      state.options(options);
    }
    responses = { create: state.provider };
    audio = { transcriptions: { create: state.provider } };
  },
  toFile: state.file,
}));
import { GET, POST } from "@/app/api/studio/cases/[caseId]/source-intakes/route";
import { POST as PREVIEW } from "@/app/api/studio/cases/[caseId]/source-intakes/external-preview/route";

let directory: string, caseId: string;
const store = () => state.store!;
const context = () => ({ params: Promise.resolve({ caseId }) });
const base = () => `http://localhost:3000/api/studio/cases/${caseId}/source-intakes`;
const item = () => store().get(caseId).sourceIntakes[0];
const target = () => ({
  revision: store().get(caseId).revision,
  itemId: item().id,
  expectedItemVersion: item().version,
});
function request(body: unknown, suffix = "", headers: Record<string, string> = {}) {
  return new Request(base() + suffix, {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function wave() {
  const buffer = Buffer.alloc(48);
  buffer.write("RIFF");
  buffer.writeUInt32LE(40, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(4, 40);
  return buffer;
}
function seed(audio = false) {
  caseId = store().create({ ...emptyProfile(), companyName: "합성 외부 판독 API" }).id;
  const buffer = audio ? wave() : Buffer.from("%PDF-1.7\nSynthetic mock only\n%%EOF");
  const originalName = audio ? "synthetic.wav" : "synthetic.pdf";
  store().createSourceIntakeBatch(caseId, {
    action: "create",
    revision: store().get(caseId).revision,
    clientRequestId: randomUUID(),
    files: [{ clientFileId: randomUUID(), originalName, sizeBytes: buffer.length, kind: "other" }],
  });
  store().storeSourceIntakeOriginal(
    caseId,
    item().id,
    {
      revision: store().get(caseId).revision,
      clientRequestId: randomUUID(),
      expectedItemVersion: item().version,
    },
    { name: originalName, mimeType: audio ? "audio/wav" : "application/pdf", buffer },
  );
}
async function approved(audio = false): Promise<RunExternalSourceIntakeCommand> {
  const response = await PREVIEW(
    request(
      { ...target(), engine: audio ? "ai-transcription" : "ai-document" },
      "/external-preview",
    ),
    context(),
  );
  expect(response.status).toBe(200);
  const preview = await response.json();
  return {
    action: "run-external",
    ...target(),
    clientRequestId: randomUUID(),
    approval: preview.approval,
    approved: true,
    acknowledgePossibleDuplicate: false,
  };
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-external-api-test-"));
  state.store = new StudioStore(directory);
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "synthetic-mock-only");
  vi.stubEnv("OPENAI_MODEL", "synthetic-document");
  vi.stubEnv("OPENAI_TRANSCRIBE_MODEL", "synthetic-audio");
  state.file.mockResolvedValue({ name: "synthetic.wav" });
  state.provider.mockImplementation(async () => {
    expect(item().phase).toBe("requesting_external");
    expect(item().attempts.at(-1)?.externalRequestStarted).toBe(true);
    expect(sourceIntakeStatus(store(), caseId).activeItemIds).toEqual([item().id]);
    return { status: "completed", output_text: "합성 미검토 문서", text: "합성 미검토 전사" };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => {
  state.store?.close();
  const delta = relative(resolve(tmpdir()), resolve(directory));
  if (
    isAbsolute(delta) ||
    delta.startsWith("..") ||
    !delta.startsWith("venture-external-api-test-")
  )
    throw new Error("Unsafe synthetic cleanup target");
  rmSync(directory, { recursive: true, force: true });
});
describe("명시 승인 외부 판독·전사 실제 SQLite/API · SDK는 모의", { timeout: 60_000 }, () => {
  it("승인 미리보기는 원본·모델을 반환하며 DB 변경과 외부 요청은 없다", async () => {
    seed();
    const before = store().get(caseId);
    const input = await approved();
    expect(input.approval).toMatchObject({
      caseId,
      itemId: item().id,
      originalName: "synthetic.pdf",
      model: "synthetic-document",
      destination: "https://api.openai.com/v1/responses",
    });
    expect(store().get(caseId)).toEqual(before);
    expect(state.options).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "문서/음성 %s 성공은 미검토 결과만 저장하며 재전송 없이 조회한다",
    async (audio) => {
      seed(audio);
      const input = await approved(audio);
      const response = await POST(request(input), context());
      expect(response.status).toBe(200);
      expect(item().phase).toBe("awaiting_review");
      expect(item().result?.reviewStatus).toBe("unreviewed");
      expect(item().result).not.toHaveProperty("locations");
      expect(store().get(caseId).sources[0]).toMatchObject({ text: "", extraction: "pending" });
      const saved = store().get(caseId);
      state.store!.close();
      state.store = new StudioStore(directory);
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("OPENAI_MODEL", "different-model");
      expect((await POST(request(input), context())).status).toBe(200);
      expect(store().get(caseId)).toEqual(saved);
      expect(state.provider).toHaveBeenCalledTimes(1);
      expect(sourceIntakeStatus(store(), caseId).activeItemIds).toEqual([]);
    },
  );
  it.each(["approved", "model", "hash", "destination", "revision"])(
    "잘못된 %s 승인은 요청 전에 거절한다",
    async (field) => {
      seed();
      const input = await approved();
      const before = store().get(caseId);
      const body = structuredClone(input) as unknown as Record<string, unknown>;
      const approval = body.approval as Record<string, unknown>;
      if (field === "approved") body.approved = false;
      if (field === "model") approval.model = "changed-model";
      if (field === "hash") approval.originalSha256 = "0".repeat(64);
      if (field === "destination") approval.destination = "https://invalid.example";
      if (field === "revision") body.revision = input.revision - 1;
      expect((await POST(request(body), context())).status).toBeGreaterThanOrEqual(400);
      expect(store().get(caseId)).toEqual(before);
      expect(state.provider).not.toHaveBeenCalled();
    },
  );
  it("키 누락은 미리보기와 요청 모두 전송 전에 차단한다", async () => {
    seed();
    const input = await approved();
    const before = store().get(caseId);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await PREVIEW(request({ ...target(), engine: "ai-document" }), context())).status).toBe(
      503,
    );
    const response = await POST(request(input), context());
    expect(response.status).toBe(503);
    expect((await response.json()).accepted).toBe(false);
    expect(store().get(caseId)).toEqual(before);
    expect(state.provider).not.toHaveBeenCalled();
  });
  it("전송 후 실패는 미확인만 저장하고 명시 새 승인·중복동의로만 다시 보낸다", async () => {
    seed();
    const input = await approved();
    state.provider.mockRejectedValue(new Error("synthetic-private-upstream-error"));
    const response = await POST(request(input), context());
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private-upstream-error");
    expect(item().phase).toBe("external_result_unknown");
    expect(item().attempts).toHaveLength(1);
    expect((await POST(request(input), context())).status).toBe(200);
    expect(state.provider).toHaveBeenCalledTimes(1);
    const retry = await approved();
    expect((await POST(request(retry), context())).status).toBe(409);
    expect(state.provider).toHaveBeenCalledTimes(1);
    retry.acknowledgePossibleDuplicate = true;
    state.provider.mockResolvedValue({ status: "completed", output_text: "합성 재확인 판독문" });
    expect((await POST(request(retry), context())).status).toBe(200);
    expect(item().attempts.map((attempt) => attempt.status)).toEqual(["unknown", "completed"]);
  });
  it("서버 재시작 뒤 resume은 외부 요청 없이 running을 unknown으로 정리한다", async () => {
    seed();
    const input = await approved();
    store().beginSourceIntakeExternalAttempt(
      caseId,
      input,
      sourceIntakeExternalConfiguration("ai-document", "synthetic-document"),
    );
    store().close();
    state.store = new StudioStore(directory);
    const resume = { action: "resume", ...target(), clientRequestId: randomUUID() };
    expect((await POST(request(resume), context())).status).toBe(200);
    const saved = store().get(caseId);
    expect((await POST(request(resume), context())).status).toBe(200);
    expect(store().get(caseId)).toEqual(saved);
    expect(item().phase).toBe("external_result_unknown");
    expect(state.provider).not.toHaveBeenCalled();
    expect(state.options).not.toHaveBeenCalled();
  });
  it("마지막 저장의 CAS 실패를 재전송하거나 다시 저장하지 않는다", async () => {
    seed();
    const input = await approved();
    const finish = vi.spyOn(store(), "finishSourceIntakeExternalAttempt").mockImplementation(() => {
      throw new Error("synthetic-private-final-save-error");
    });
    const response = await POST(request(input), context());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.accepted).toBe(true);
    expect(JSON.stringify(body)).not.toContain("synthetic-private");
    expect(item().phase).toBe("requesting_external");
    expect(finish).toHaveBeenCalledTimes(1);
    expect(state.provider).toHaveBeenCalledTimes(1);
  });
  it("callback 시점의 원본 변경은 SDK가 파일을 준비했어도 전송을 차단한다", async () => {
    seed(true);
    const input = await approved(true);
    const before = store().get(caseId);
    vi.spyOn(store(), "beginSourceIntakeExternalAttempt").mockImplementation(() => {
      throw new Error("synthetic-private-late-change");
    });
    const response = await POST(request(input), context());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await response.json()).accepted).toBe(false);
    expect(store().get(caseId)).toEqual(before);
    expect(state.file).toHaveBeenCalledTimes(1);
    expect(state.provider).not.toHaveBeenCalled();
  });
  it("다른 내용으로 같은 요청 번호를 재사용하면 거절한다", async () => {
    seed();
    const input = await approved();
    expect((await POST(request(input), context())).status).toBe(200);
    const before = store().get(caseId);
    const response = await POST(
      request({ ...input, acknowledgePossibleDuplicate: true }),
      context(),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("INTAKE_NONCE_CONFLICT");
    expect(store().get(caseId)).toEqual(before);
    expect(state.provider).toHaveBeenCalledTimes(1);
  });
  it("미리보기 경로는 no-store·같은 출처·JSON·쿼리/용량을 검사한다", async () => {
    seed();
    const value = { ...target(), engine: "ai-document" };
    const before = store().get(caseId);
    const ok = await PREVIEW(request(value), context());
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect((await PREVIEW(request(value, "?extra=1"), context())).status).toBe(400);
    expect(
      (await PREVIEW(request(value, "", { origin: "https://invalid.example" }), context())).status,
    ).toBe(403);
    expect(
      (await PREVIEW(request(value, "", { "content-type": "text/plain" }), context())).status,
    ).toBe(415);
    expect((await PREVIEW(request({ ...value, extra: "a".repeat(9000) }), context())).status).toBe(
      413,
    );
    const get = await GET(new Request(base()), context());
    expect(get.status).toBe(200);
    expect(store().get(caseId)).toEqual(before);
    expect(state.provider).not.toHaveBeenCalled();
  });
});
