import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  originalOnlyWarnings,
  sectionDefinitions,
  sourceSchema,
  type PlanContent,
  type StudioCase,
} from "./studio-schema";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  extract: vi.fn(),
  aiConstructor: vi.fn(),
  aiParse: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/studio-extract", () => ({
  MAX_UPLOAD_BYTES: 12 * 1024 * 1024,
  SourceExtractionError: class extends Error {
    status = 422;
    code = "SOURCE_EXTRACTION";
  },
  extractSource: state.extract,
}));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: state.aiParse };
    constructor() {
      state.aiConstructor();
    }
  },
}));
import { POST as upload } from "@/app/api/studio/cases/[caseId]/sources/route";
import { analyzeCompany, generatePlan, reviewPlan } from "./studio-engine";

const pdf = Buffer.from("%PDF-1.7\noriginal scan bytes\n%%EOF");
const formats = [
  { name: "스캔.PDF", bytes: pdf, mimeType: "application/pdf" },
  {
    name: "원본.png",
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    mimeType: "image/png",
  },
  { name: "원본.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]), mimeType: "image/jpeg" },
  { name: "원본.jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0]), mimeType: "image/jpeg" },
  { name: "원본.webp", bytes: Buffer.from("RIFF1234WEBPdata"), mimeType: "image/webp" },
];
const profile = { ...emptyProfile(), companyName: "원본 보관 시험기업" };

let directory: string;
let company: StudioCase;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-original-upload-test-"));
  state.store = new StudioStore(directory);
  company = state.store.create(profile);
  state.extract
    .mockReset()
    .mockResolvedValue({ text: "추출 본문", extraction: "local", warnings: [] });
  state.aiConstructor.mockReset();
  state.aiParse.mockReset();
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => {
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-original-upload-test-") || boundary.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function request(
  options: {
    mode?: string | null;
    allowAi?: string;
    revision?: string | null;
    name?: string;
    bytes?: Uint8Array;
    origin?: string;
  } = {},
) {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(options.bytes ?? pdf)], options.name ?? "원본.pdf", {
      type: "application/octet-stream",
    }),
  );
  form.set("kind", "technology");
  if (options.revision !== null) form.set("revision", options.revision ?? String(company.revision));
  if (options.mode !== null) form.set("extractionMode", options.mode ?? "original-only");
  form.set("allowAi", options.allowAi ?? "false");
  return new Request("http://localhost:3000/api/studio", {
    method: "POST",
    body: form,
    headers: options.origin ? { origin: options.origin } : {},
  });
}
function context() {
  return { params: Promise.resolve({ caseId: company.id }) };
}
async function saveOriginal() {
  const response = await upload(request(), context());
  expect(response.status).toBe(201);
  company = await response.json();
  return company.sources[0];
}
function storedFiles() {
  return readdirSync(directory, { recursive: true }).filter(
    (path) => typeof path === "string" && !path.startsWith("studio.sqlite"),
  );
}

describe("원본 전용 업로드", () => {
  it.each(formats)(
    "$name 바이트를 추출·AI 호출 없이 보존한다",
    async ({ name, bytes, mimeType }) => {
      const response = await upload(request({ name, bytes }), context());
      expect(response.status).toBe(201);
      const saved: StudioCase = await response.json();
      expect(saved.sources[0]).toMatchObject({
        name,
        originalName: name,
        mimeType,
        text: "",
        extraction: "pending",
        warnings: [...originalOnlyWarnings],
      });
      expect(saved.revision).toBe(company.revision + 1);
      expect(state.store!.original(company.id, saved.sources[0].id).buffer).toEqual(bytes);
      expect(state.extract).not.toHaveBeenCalled();
      expect(state.aiConstructor).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toContain("no-store");
    },
  );

  it.each([null, "extract"])("기존 추출 모드 %j는 계속 본문 추출 후 저장한다", async (mode) => {
    const response = await upload(request({ mode, allowAi: "true" }), context());
    expect(response.status).toBe(201);
    expect(state.extract).toHaveBeenCalledWith(expect.any(File), { allowAi: true });
    expect((await response.json()).sources[0]).toMatchObject({
      text: "추출 본문",
      extraction: "local",
    });
  });

  it("기존 추출 모드의 빈 본문 거부를 유지한다", async () => {
    state.extract.mockResolvedValue({ text: " ", extraction: "local", warnings: [] });
    const response = await upload(request({ mode: "extract" }), context());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "NO_TEXT" });
    expect(state.store!.get(company.id).sources).toEqual([]);
  });

  it("원본 모드에서 AI 선택을 저장·추출 전에 거부한다", async () => {
    const before = storedFiles();
    const response = await upload(request({ allowAi: "true" }), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "ORIGINAL_ONLY_AI" });
    expect(state.extract).not.toHaveBeenCalled();
    expect(state.store!.get(company.id).sources).toEqual([]);
    expect(storedFiles()).toEqual(before);
  });

  it.each([
    { name: "원본.docx", bytes: pdf },
    { name: "원본.txt", bytes: pdf },
    { name: "원본.svg", bytes: Buffer.from("<svg></svg>") },
    { name: "원본.pdf", bytes: Buffer.from("plain text") },
    { name: "원본.png", bytes: pdf },
    { name: "원본.jpg", bytes: formats[1].bytes },
    { name: "원본.webp", bytes: Buffer.from("RIFF1234WAVE") },
  ])("형식과 확장자가 일치하지 않으면 원본을 저장하지 않는다: $name", async ({ name, bytes }) => {
    const response = await upload(request({ name, bytes }), context());
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: "ORIGINAL_FORMAT" });
    expect(state.extract).not.toHaveBeenCalled();
    expect(state.store!.get(company.id).sources).toEqual([]);
  });

  it.each([
    { options: { mode: "skip" }, code: "INVALID_INPUT", status: 400 },
    { options: { revision: null }, code: "INVALID_INPUT", status: 400 },
    { options: { revision: "99" }, code: "STALE_REVISION", status: 409 },
    { options: { bytes: new Uint8Array() }, code: "FILE_REQUIRED", status: 400 },
    { options: { origin: "https://external.example" }, code: "CROSS_ORIGIN", status: 403 },
  ])("요청 검증 유지: $code", async ({ options, code, status }) => {
    const response = await upload(request(options), context());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(state.store!.get(company.id).sources).toEqual([]);
    expect(state.extract).not.toHaveBeenCalled();
  });

  it("12MiB 초과 파일을 원본 모드에서도 거부한다", async () => {
    const response = await upload(
      request({ bytes: new Uint8Array(12 * 1024 * 1024 + 1) }),
      context(),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "TOO_LARGE" });
    expect(state.extract).not.toHaveBeenCalled();
    expect(state.store!.get(company.id).sources).toEqual([]);
  });

  it("입력 중인 기업 잠금이 원본 저장도 막는다", async () => {
    const before = storedFiles();
    const response = await withVentureInputCompanyLock(company.id, () =>
      upload(request(), context()),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "INPUT_IN_PROGRESS" });
    expect(state.store!.get(company.id).sources).toEqual([]);
    expect(storedFiles()).toEqual(before);
    expect(state.extract).not.toHaveBeenCalled();
  });

  it("서버 저장 직전 revision 변경도 CAS가 차단하고 원본을 남기지 않는다", async () => {
    const originalGet = state.store!.get.bind(state.store);
    let changed = false;
    vi.spyOn(state.store!, "get").mockImplementation((id) => {
      const current = originalGet(id);
      if (!changed) {
        changed = true;
        state.store!.mutate(
          id,
          { action: "stage", revision: current.revision, stage: "drafting" },
          () => [],
        );
      }
      return current;
    });
    const before = storedFiles();
    const response = await upload(request(), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_REVISION" });
    expect(originalGet(company.id).sources).toEqual([]);
    expect(storedFiles()).toEqual(before);
  });

  it("본문 입력 후 manual로 전환하며 원본·다른 경고를 보존한다", async () => {
    const source = await saveOriginal();
    // Include another source warning as an existing server-assigned condition.
    const standalone = {
      ...source,
      id: randomUUID(),
      warnings: [...originalOnlyWarnings, "원본 날짜를 확인해 주세요."],
    };
    company = state.store!.addUpload(company.id, company.revision, standalone, pdf);
    const updated = state.store!.mutate(
      company.id,
      {
        action: "source",
        revision: company.revision,
        source: { ...standalone, text: "직접 대조한 기술 설명입니다." },
      },
      () => [],
    );
    expect(updated.sources.find((item) => item.id === standalone.id)).toMatchObject({
      extraction: "manual",
      text: "직접 대조한 기술 설명입니다.",
      warnings: ["원본 날짜를 확인해 주세요."],
      originalName: standalone.originalName,
      mimeType: "application/pdf",
    });
    expect(state.store!.original(company.id, standalone.id).buffer).toEqual(pdf);
  });

  it("빈 본문으로 pending 상태를 검토된 자료로 전환하지 않는다", async () => {
    const source = await saveOriginal();
    expect(() =>
      state.store!.mutate(
        company.id,
        { action: "source", revision: company.revision, source: { ...source, text: " " } },
        () => [],
      ),
    ).toThrow("자료 내용을 입력");
    expect(state.store!.get(company.id).sources[0].extraction).toBe("pending");
    expect(sourceSchema.safeParse({ ...source, text: "본문", extraction: "pending" }).success).toBe(
      false,
    );
    for (const extraction of ["manual", "local", "ai"])
      expect(sourceSchema.safeParse({ ...source, extraction, text: "기존 본문" }).success).toBe(
        true,
      );
  });
});

describe("본문 미추출 자료의 분석·검토 경계", () => {
  it("AI 독립검토가 전달하지 않은 pending 자료를 근거로 삼으면 거부한다", async () => {
    const source = await saveOriginal();
    company.profile.technologySummary = "사용자가 입력한 센서 기술 설명입니다.";
    vi.stubEnv("OPENAI_API_KEY", "mock-only-key");
    const content: PlanContent = {
      title: "센서 기술 초안",
      summary: "검토 초안",
      sections: sectionDefinitions.map(({ key, title }) => ({
        key,
        title,
        content: company.profile.technologySummary,
        needsConfirmation: false,
        evidence: [
          {
            sourceId: "profile",
            quote: company.profile.technologySummary,
            locator: "기술·제품 설명",
          },
        ],
      })),
      actionItems: [],
      interviewQuestions: [],
    };
    state.aiParse
      .mockResolvedValueOnce({ status: "completed", output_parsed: content })
      .mockResolvedValueOnce({
        status: "completed",
        output_parsed: {
          findings: [
            {
              id: "review-1",
              severity: "info",
              category: "semantic-evidence",
              message: "원본 내용을 확인했다는 잘못된 의견",
              action: "원본 확인",
              sectionKey: "solution",
              sourceIds: [source.id],
            },
          ],
        },
      });
    await expect(
      generatePlan(
        company,
        {
          id: "chosen",
          title: "센서 기술",
          problem: "확인 필요",
          solution: company.profile.technologySummary,
          targetCustomer: "확인 필요",
          differentiation: "확인 필요",
          stage: "확인 필요",
          businessModel: "확인 필요",
          recommendation: "확인 필요",
          gaps: [],
          evidence: [],
        },
        "ai",
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_REVIEW" });
    expect(state.aiParse).toHaveBeenCalledTimes(2);
  });

  it("원본 이름·종류만으로 사실·아이템·근거를 만들지 않는다", async () => {
    const source = await saveOriginal();
    const result = await analyzeCompany(company, "assisted");
    expect(result.facts).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.summary).toContain("본문 미추출 상태로 분석 근거에서 제외");
    expect(result.warnings.join(" ")).toContain(originalOnlyWarnings[0]);
    expect(state.aiConstructor).not.toHaveBeenCalled();
    const content: PlanContent = {
      title: "초안",
      summary: "검토 중",
      sections: [
        {
          key: "solution",
          title: "기술",
          content: "원본에 내용이 있다는 주장",
          needsConfirmation: false,
          evidence: [
            { sourceId: source.id, quote: "원본에 내용이 있다는 주장", locator: source.name },
          ],
        },
      ],
      actionItems: [],
      interviewQuestions: [],
    };
    expect(reviewPlan(company, content)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "invalid-reference", severity: "error" }),
      ]),
    );
  });

  it("pending에 잘못된 본문이 메모리로 전달돼도 정리·원고 근거로 쓰지 않는다", async () => {
    const source = await saveOriginal();
    company.sources[0].text = "기술 개발 완료, 매출 10억원";
    const analysis = await analyzeCompany(company, "assisted");
    expect(analysis.facts).toEqual([]);
    expect(analysis.candidates).toEqual([]);
    const plan = await generatePlan(
      company,
      {
        id: "chosen",
        title: "사용자 선택 기술",
        problem: "확인 필요",
        solution: "확인 필요",
        targetCustomer: "확인 필요",
        differentiation: "확인 필요",
        stage: "확인 필요",
        businessModel: "확인 필요",
        recommendation: "확인 필요",
        gaps: [],
        evidence: [{ sourceId: source.id, quote: company.sources[0].text, locator: source.name }],
      },
      "assisted",
    );
    expect(plan.sections.every((section) => section.evidence.length === 0)).toBe(true);
    expect(plan.sections.map((section) => section.content).join(" ")).not.toContain("매출 10억원");
  });

  it("명시적 AI 분석에서도 원본 바이트·이름·빈 자료를 AI 본문으로 보내지 않는다", async () => {
    const source = await saveOriginal();
    vi.stubEnv("OPENAI_API_KEY", "mock-only-key");
    state.aiParse.mockResolvedValue({
      status: "completed",
      output_parsed: {
        summary: "자료 부족",
        facts: [],
        candidates: [],
        questions: [],
        warnings: [],
      },
    });
    await analyzeCompany(company, "ai");
    const request = state.aiParse.mock.calls[0][0];
    const aiBody = JSON.parse(request.input[1].content);
    expect(aiBody.sources).toEqual([]);
    expect(aiBody.unextractedSourceCount).toBe(1);
    expect(JSON.stringify(request)).not.toContain(source.id);
    expect(JSON.stringify(request)).not.toContain(source.originalName);
    expect(JSON.stringify(request)).not.toContain(pdf.toString("base64"));
  });
});
