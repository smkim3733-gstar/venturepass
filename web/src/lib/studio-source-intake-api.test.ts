import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile } from "./studio-schema";
import type {
  SourceIntakeItem,
  SourceIntakeResponse,
  RunSourceIntakeCommand,
} from "./studio-source-intake-types";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  extract: vi.fn(),
  external: vi.fn(() => {
    throw new Error("No external call in intake API tests");
  }),
}));
vi.mock("./studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("./studio-source-intake-extract", async (original) => ({
  ...(await original<typeof import("./studio-source-intake-extract")>()),
  extractLocalIntake: state.extract,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
  toFile: state.external,
}));
vi.mock("./studio-windows-ocr", () => ({ runWindowsOcr: state.external }));
import { LocalIntakeExtractionError } from "./studio-source-intake-extract";
import { GET, POST } from "@/app/api/studio/cases/[caseId]/source-intakes/route";
import { PUT } from "@/app/api/studio/cases/[caseId]/source-intakes/[itemId]/original/route";

let directory: string;
let caseId: string;
const store = () => state.store!;
const text = "합성 접수 자료 원문";
const context = () => ({ params: Promise.resolve({ caseId }) });
const url = () => `http://localhost:3000/api/studio/cases/${caseId}/source-intakes`;
function request(value: unknown, headers: Record<string, string> = {}, suffix = "") {
  return new Request(url() + suffix, {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}
function target(item: SourceIntakeItem) {
  return {
    revision: store().get(caseId).revision,
    clientRequestId: randomUUID(),
    itemId: item.id,
    expectedItemVersion: item.version,
  };
}
async function create(names = ["synthetic.txt"]): Promise<SourceIntakeResponse> {
  const response = await POST(
    request({
      action: "create",
      revision: store().get(caseId).revision,
      clientRequestId: randomUUID(),
      files: names.map((originalName) => ({
        clientFileId: randomUUID(),
        originalName,
        kind: "other",
        sizeBytes: Buffer.byteLength(text),
      })),
    }),
    context(),
  );
  expect(response.status).toBe(200);
  return response.json();
}
function formFor(item: SourceIntakeItem, nonce = randomUUID(), content = text) {
  const form = new FormData();
  form.append("revision", String(store().get(caseId).revision));
  form.append("clientRequestId", nonce);
  form.append("expectedItemVersion", String(item.version));
  form.append("file", new File([content], item.declared.originalName, { type: "text/plain" }));
  return form;
}
async function put(
  item: SourceIntakeItem,
  form = formFor(item),
  headers: Record<string, string> = {},
  suffix = "",
) {
  return PUT(
    new Request(`${url()}/${item.id}/original${suffix}`, {
      method: "PUT",
      headers: { origin: "http://localhost:3000", ...headers },
      body: form,
    }),
    { params: Promise.resolve({ caseId, itemId: item.id }) },
  );
}
async function stored() {
  const item = (await create()).company.sourceIntakes.at(-1)!;
  const response = await put(item);
  expect(response.status).toBe(200);
  return ((await response.json()) as SourceIntakeResponse).item!;
}
async function run(item: SourceIntakeItem, extra: Partial<RunSourceIntakeCommand> = {}) {
  return POST(
    request({ action: "run-next", ...target(item), engine: "local-document", ...extra }),
    context(),
  );
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-intake-api-test-"));
  state.store = new StudioStore(directory);
});
beforeEach(() => {
  vi.clearAllMocks();
  caseId = store().create({ ...emptyProfile(), companyName: "합성 접수 회사" }).id;
  state.extract.mockResolvedValue({
    content: { kind: "plain", text },
    warnings: ["미검토 합성 결과"],
  });
});
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
});
afterAll(() => {
  expect(state.external).not.toHaveBeenCalled();
  state.store?.close();
  const delta = relative(resolve(tmpdir()), resolve(directory));
  if (isAbsolute(delta) || delta.startsWith("..") || !delta.startsWith("venture-intake-api-test-"))
    throw new Error("Unsafe synthetic cleanup target");
  rmSync(directory, { recursive: true, force: true });
});
// Real Windows reparse/hardlink checks run for each durable before/after boundary.
describe("접수·판독 재개 실제 SQLite/API", { timeout: 60_000 }, () => {
  it("원본 없는 접수 예약은 명시 취소하며 같은 요청 재전송은 중복 변경하지 않는다", async () => {
    const item = (await create()).company.sourceIntakes[0];
    const input = { action: "cancel-awaiting-original", ...target(item), confirmed: true };
    const cancelled = await POST(request(input), context());
    expect(cancelled.status).toBe(200);
    const before = store().get(caseId);
    expect(before.sourceIntakes[0]).toMatchObject({
      phase: "cancelled",
      original: null,
      attempts: [],
    });
    expect((await POST(request(input), context())).status).toBe(200);
    expect(store().get(caseId)).toEqual(before);
    expect(state.extract).not.toHaveBeenCalled();
  });
  it("원본 없는 예약 취소도 사용자 확인을 요구한다", async () => {
    const item = (await create()).company.sourceIntakes[0];
    const response = await POST(
      request({ action: "cancel-awaiting-original", ...target(item), confirmed: false }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ accepted: false });
    expect(store().get(caseId).sourceIntakes[0].phase).toBe("awaiting_original");
  });
  it("파일별 원본 보관→미검토 결과→명시 채택이며 단계·기관 상태를 바꾸지 않는다", async () => {
    const item = await stored();
    let company = store().get(caseId);
    expect(company.sources[0]).toMatchObject({ text: "", extraction: "pending" });
    const beforeStage = company.stage,
      beforeHistory = company.stageHistory;
    const response = await run(item);
    expect(response.status).toBe(200);
    const output = (await response.json()) as SourceIntakeResponse;
    expect(output.item).toMatchObject({
      phase: "awaiting_review",
      result: { reviewStatus: "unreviewed" },
    });
    expect(output.company.sources[0].text).toBe("");
    const ready = output.item!;
    const adopt = await POST(
      request({
        action: "adopt",
        ...target(ready),
        resultId: ready.result!.id,
        originalSha256: ready.original!.sha256,
        sourceUpdatedAt: ready.original!.sourceUpdatedAt,
        text: `${text} 사용자 교정`,
        reviewed: true,
      }),
      context(),
    );
    expect(adopt.status).toBe(200);
    company = store().get(caseId);
    expect(company.sources[0]).toMatchObject({ extraction: "manual", text: `${text} 사용자 교정` });
    expect(company.sourceIntakes[0].result!.content).toEqual({ kind: "plain", text });
    expect(company.stage).toBe(beforeStage);
    expect(company.stageHistory).toEqual(beforeHistory);
    expect(company.agencyRecords).toEqual([]);
    expect(company.plans).toEqual([]);
  });
  it("복수파일 중 한 판독 실패가 나머지 원본·결과를 지우지 않는다", async () => {
    const output = await create(["first.txt", "second.txt", "third.txt"]);
    for (const initial of output.company.sourceIntakes)
      expect(
        (
          await put(
            store()
              .get(caseId)
              .sourceIntakes.find((item) => item.id === initial.id)!,
          )
        ).status,
      ).toBe(200);
    const items = store().get(caseId).sourceIntakes;
    expect((await run(items[0])).status).toBe(200);
    state.extract.mockRejectedValueOnce(new LocalIntakeExtractionError("INTAKE_EXTRACTION_FAILED"));
    expect((await run(store().get(caseId).sourceIntakes[1])).status).toBe(200);
    expect((await run(store().get(caseId).sourceIntakes[2])).status).toBe(200);
    const saved = store().get(caseId);
    expect(saved.sourceIntakes.map((item) => item.phase)).toEqual([
      "awaiting_review",
      "retryable_failure",
      "awaiting_review",
    ]);
    expect(saved.sources).toHaveLength(3);
    expect(saved.sources.every((source) => source.text === "")).toBe(true);
  });
  it("완료 응답 유실·동일 nonce 재전송은 추가 파서·결과를 만들지 않는다", async () => {
    const item = await stored();
    const input = { action: "run-next", ...target(item), engine: "local-document" };
    const first = await POST(request(input), context());
    expect(first.status).toBe(200);
    const before = store().get(caseId);
    const replay = await POST(request(input), context());
    expect(replay.status).toBe(200);
    expect(store().get(caseId)).toEqual(before);
    expect(state.extract).toHaveBeenCalledOnce();
  });
  it("원본 PUT 응답 유실 재전송도 같은 source 하나만 유지한다", async () => {
    const item = (await create()).company.sourceIntakes[0],
      nonce = randomUUID();
    const form = formFor(item, nonce),
      entries = [...form.entries()];
    expect((await put(item, form)).status).toBe(200);
    const before = store().get(caseId),
      replay = new FormData();
    for (const [key, value] of entries) replay.append(key, value);
    expect((await put(item, replay)).status).toBe(200);
    expect(store().get(caseId)).toEqual(before);
    expect(before.sources).toHaveLength(1);
  });
  it("재시작 뒤 끊긴 로컬 시도는 명시 resume에서만 이어간다", async () => {
    const item = await stored();
    const begun = store().beginSourceIntakeAttempt(
      caseId,
      { action: "run-next", ...target(item), engine: "local-document" },
      "local-document",
    );
    store().close();
    state.store = new StudioStore(directory);
    const status = await GET(new Request(url()), context());
    const saved = await status.json();
    expect(saved.activeItemIds).toEqual([]);
    expect(saved.company.sourceIntakes[0].phase).toBe("extracting_local");
    expect(state.extract).not.toHaveBeenCalled();
    const current = store().get(caseId).sourceIntakes[0];
    const response = await POST(request({ action: "resume", ...target(current) }), context());
    expect(response.status).toBe(200);
    const after = store().get(caseId).sourceIntakes[0];
    expect(after.attempts).toHaveLength(2);
    expect(after.attempts[0]).toMatchObject({
      id: begun.attemptId,
      status: "failed",
      code: "INTAKE_INTERRUPTED",
    });
    expect(after.phase).toBe("awaiting_review");
  });
  it("실행 중 GET은 active 항목을 표시하고 resume는 중복 worker를 만들지 않는다", async () => {
    const item = await stored();
    let release!: () => void;
    const entered = new Promise<void>((resolveEntered) =>
      state.extract.mockImplementationOnce(() => {
        resolveEntered();
        return new Promise((resolveResult) => {
          release = () => resolveResult({ content: { kind: "plain", text }, warnings: [] });
        });
      }),
    );
    const running = run(item);
    await entered;
    const status = await (await GET(new Request(url()), context())).json();
    expect(status.activeItemIds).toEqual([item.id]);
    const current = store().get(caseId).sourceIntakes[0];
    const duplicate = await POST(request({ action: "resume", ...target(current) }), context());
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "INTAKE_BUSY", accepted: false });
    release();
    expect((await running).status).toBe(200);
    expect(state.extract).toHaveBeenCalledOnce();
  });
  it("판독 중 회사 revision 변경이면 늦은 결과를 저장하지 않는다", async () => {
    const item = await stored();
    state.extract.mockImplementationOnce(async () => {
      const current = store().get(caseId);
      store().mutate(
        caseId,
        {
          action: "profile",
          revision: current.revision,
          profile: { ...current.profile, companyName: "합성 수정 회사" },
        },
        () => [],
      );
      return { content: { kind: "plain", text }, warnings: [] };
    });
    const response = await run(item);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(store().get(caseId).sourceIntakes[0].result).toBeNull();
  });
  it("판독 중 같은 크기 원본 변조도 결과를 저장하지 않는다", async () => {
    const item = await stored();
    const original = store().originalForVentureInput(caseId, item.sourceId);
    const path = join(directory, "originals", caseId, `${item.sourceId}.bin`);
    state.extract.mockImplementationOnce(async () => {
      writeFileSync(path, Buffer.alloc(original.buffer.length, 65));
      return { content: { kind: "plain", text }, warnings: [] };
    });
    const response = await run(item);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(store().get(caseId).sourceIntakes[0].result).toBeNull();
  });
  it("명시 검토 없는 채택은 거부한다", async () => {
    const item = await stored();
    const output = (await (await run(item)).json()) as SourceIntakeResponse;
    const ready = output.item!;
    const response = await POST(
      request({
        action: "adopt",
        ...target(ready),
        resultId: ready.result!.id,
        sourceUpdatedAt: ready.original!.sourceUpdatedAt,
        originalSha256: ready.original!.sha256,
        text,
        reviewed: false,
      }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ accepted: false });
    expect(store().get(caseId).sources[0].text).toBe("");
  });
  it.each([
    [{ origin: "https://outside.example" }, "", 403],
    [{ "sec-fetch-site": "cross-site" }, "", 403],
    [{ host: "outside.example" }, "", 403],
    [{ "content-type": "text/plain" }, "", 415],
    [{}, "?extra=1", 400],
    [{ "content-length": String(512 * 1024 + 1) }, "", 413],
  ] as const)("JSON 요청 경계를 지킨다 %j %s", async (headers, suffix, expected) => {
    const response = await POST(request({}, headers as Record<string, string>, suffix), context());
    expect(response.status).toBe(expected);
    expect(await response.json()).toMatchObject({ accepted: false });
    expect(store().get(caseId).sourceIntakes).toEqual([]);
  });
  it("외부 엔진·임의 metadata·중복 파일ID·잘못된 JSON을 거부한다", async () => {
    const item = await stored();
    for (const extra of [
      { engine: "ai-document" },
      { engine: "local-document", allowAi: true },
      { engine: "local-document", result: {} },
    ]) {
      const response = await POST(
        request({ action: "run-next", ...target(item), ...extra }),
        context(),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ accepted: false });
    }
    const invalid = await POST(
      new Request(url(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      context(),
    );
    expect(invalid.status).toBe(400);
    expect(state.extract).not.toHaveBeenCalled();
  });
  it("PUT 추가 키·중복 키·형식 위장·외부Origin은 접수하지 않는다", async () => {
    const item = (await create()).company.sourceIntakes[0];
    const extra = formFor(item);
    extra.append("allowAi", "true");
    expect((await put(item, extra)).status).toBe(400);
    const duplicate = formFor(item);
    duplicate.append("revision", "1");
    expect((await put(item, duplicate)).status).toBe(400);
    const binary = formFor(item, randomUUID(), "text\0binary");
    expect((await put(item, binary)).status).toBe(415);
    expect((await put(item, formFor(item), { origin: "https://outside.example" })).status).toBe(
      403,
    );
    expect((await put(item, formFor(item), {}, "?extra=1")).status).toBe(400);
    expect(store().get(caseId).sourceIntakes[0].phase).toBe("awaiting_original");
    expect(store().get(caseId).sources).toEqual([]);
  });
  it("다른 회사의 item은 같은 원본을 보내도 접수·판독하지 않는다", async () => {
    const item = await stored();
    caseId = store().create({ ...emptyProfile(), companyName: "다른 합성 회사" }).id;
    const response = await run(item);
    expect(response.status).toBe(404);
    expect((await put(item)).status).toBe(404);
    expect(store().get(caseId).sources).toEqual([]);
    expect(state.extract).not.toHaveBeenCalled();
  });
});
