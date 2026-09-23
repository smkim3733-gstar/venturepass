import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type AnalysisContent, type StudioCase } from "./studio-schema";

const state = vi.hoisted(() => ({ store: null as StudioStore | null, analyze: vi.fn() }));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/studio-engine", () => ({
  analyzeCompany: state.analyze,
  generatePlan: vi.fn(),
  reviewPlan: () => [],
  StudioEngineError: class extends Error {
    code = "AI_NOT_CONFIGURED";
    status = 503;
  },
}));
vi.mock("@/lib/studio-extract", () => ({
  MAX_UPLOAD_BYTES: 12 * 1024 * 1024,
  SourceExtractionError: class extends Error {
    status = 422;
    code = "SOURCE_EXTRACTION";
  },
  extractSource: async (file: File) => ({
    text: await file.text(),
    extraction: "local",
    warnings: [],
  }),
}));
import { POST as createCase } from "@/app/api/studio/cases/route";
import { POST as generate } from "@/app/api/studio/cases/[caseId]/generate/route";
import { POST as upload } from "@/app/api/studio/cases/[caseId]/sources/route";
import { GET as download } from "@/app/api/studio/cases/[caseId]/sources/[sourceId]/route";

const analysis: AnalysisContent = {
  summary: "분석",
  facts: [],
  candidates: [],
  questions: [],
  warnings: [],
};
const profile = {
  ...emptyProfile(),
  companyName: "라우트 시험기업",
  technologySummary: "센서 개발",
};
function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/studio", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
describe("Studio API 저장 연동", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-routes-test-"));
    state.store = new StudioStore(directory);
    state.analyze.mockReset();
  });
  afterEach(() => {
    state.store!.close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-routes-test-") || boundary.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  it("기업 생성의 입력 검증과 외부 요청 차단이 저장 전에 적용된다", async () => {
    expect((await createCase(jsonRequest({ profile: emptyProfile() }))).status).toBe(400);
    expect(
      (await createCase(jsonRequest({ profile }, { origin: "https://evil.example" }))).status,
    ).toBe(403);
    expect(state.store!.list()).toHaveLength(0);
    const response = await createCase(jsonRequest({ profile }));
    expect(response.status).toBe(201);
    expect((await response.json()).profile.companyName).toBe(profile.companyName);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("아이템 미선택 상태에서 사업계획서 생성을 거절한다", async () => {
    const record = state.store!.create(profile);
    const response = await generate(
      jsonRequest({ revision: record.revision, operation: "plan", mode: "assisted" }),
      { params: Promise.resolve({ caseId: record.id }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CANDIDATE_REQUIRED" });
    expect(state.store!.get(record.id).plans).toHaveLength(0);
  });
  it("진행 중 중복 생성 및 오래된 비동기 결과를 거절한다", async () => {
    const record = state.store!.create(profile);
    let release: (value: AnalysisContent) => void = () => {};
    state.analyze.mockImplementation(
      () =>
        new Promise<AnalysisContent>((done) => {
          release = done;
        }),
    );
    const context = { params: Promise.resolve({ caseId: record.id }) };
    const requestBody = { revision: record.revision, operation: "analyze", mode: "assisted" };
    const first = generate(jsonRequest(requestBody), context);
    await vi.waitFor(() => expect(state.analyze).toHaveBeenCalledTimes(1));
    const duplicate = await generate(jsonRequest(requestBody), context);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "GENERATION_RUNNING" });
    state.store!.mutate(
      record.id,
      { action: "stage", revision: record.revision, stage: "drafting" },
      () => [],
    );
    release(analysis);
    const stale = await first;
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_REVISION" });
    expect(state.store!.get(record.id).analysis).toBeNull();
  });
  it("파일 본문과 원본을 함께 저장하고 다운로드에 캐시·인라인 실행을 금지한다", async () => {
    const record = state.store!.create(profile);
    const form = new FormData();
    form.set("file", new File(["기술 원문"], "기술.txt", { type: "text/plain" }));
    form.set("kind", "technology");
    form.set("revision", "0");
    form.set("allowAi", "false");
    const response = await upload(
      new Request("http://localhost:3000/api", { method: "POST", body: form }),
      { params: Promise.resolve({ caseId: record.id }) },
    );
    expect(response.status).toBe(201);
    const saved: StudioCase = await response.json();
    expect(saved.sources[0].text).toBe("기술 원문");
    const original = await download(new Request("http://localhost:3000/api"), {
      params: Promise.resolve({ caseId: record.id, sourceId: saved.sources[0].id }),
    });
    expect(await original.text()).toBe("기술 원문");
    expect(original.headers.get("cache-control")).toContain("no-store");
    expect(original.headers.get("content-type")).toBe("application/octet-stream");
    expect(original.headers.get("content-disposition")).toContain("attachment;");
  });
  it("파일 업로드에서 revision 누락을 최초 버전 0으로 해석하지 않는다", async () => {
    const record = state.store!.create(profile);
    const form = new FormData();
    form.set("file", new File(["원문"], "file.txt"));
    form.set("kind", "technology");
    const response = await upload(
      new Request("http://localhost:3000/api", { method: "POST", body: form }),
      { params: Promise.resolve({ caseId: record.id }) },
    );
    expect(response.status).toBe(400);
    expect(state.store!.get(record.id).sources).toHaveLength(0);
  });
});
