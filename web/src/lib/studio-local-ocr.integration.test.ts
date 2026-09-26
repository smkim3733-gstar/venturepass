import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  originalOnlyWarnings,
  type CaseMutation,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import { StudioError } from "./studio-http";
import { localOcrReviewedWarning } from "./studio-ocr-review";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  runOcr: vi.fn(),
  aiConstructor: vi.fn(),
  aiParse: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("./studio-windows-ocr", async (original) => ({
  ...(await original<typeof import("./studio-windows-ocr")>()),
  runWindowsOcr: state.runOcr,
}));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: state.aiParse };
    constructor() {
      state.aiConstructor();
    }
  },
}));
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: vi.fn() }));
import { POST as preview } from "@/app/api/studio/cases/[caseId]/sources/[sourceId]/ocr-preview/route";
import { PATCH, GET } from "@/app/api/studio/cases/[caseId]/route";
import { analyzeCompany } from "./studio-engine";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const ocrResult = () => ({
  pages: [{ pageNumber: 1, text: "가상 스캔 자료의 OCR 초안입니다." }],
  warnings: ["가상 런타임 검토 안내"],
});
let directory: string;
let company: StudioCase;
let source: SourceDocument;
let bytes: Buffer;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-local-ocr-test-"));
  state.store = new StudioStore(directory);
  company = state.store.create({ ...emptyProfile(), companyName: "로컬 OCR 시험기업" });
  ({ source, bytes } = addOriginal());
  state.runOcr.mockReset().mockResolvedValue(ocrResult());
  state.aiConstructor.mockReset();
  state.aiParse.mockReset();
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-local-ocr-test-") || boundary.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function addOriginal(id = company.id, overrides: Partial<SourceDocument> = {}, original = png) {
  const now = new Date().toISOString();
  const source: SourceDocument = {
    id: randomUUID(),
    name: "시험 스캔",
    kind: "other",
    text: "",
    originalName: "fixture.png",
    mimeType: "image/png",
    extraction: "pending",
    warnings: [...originalOnlyWarnings, "보존할 별도 주의사항"],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const current = state.store!.get(id);
  const saved = state.store!.addUpload(id, current.revision, source, original);
  if (id === company.id) company = saved;
  return { source, bytes: original };
}
const sourcePath = (sourceId = source.id, caseId = company.id) =>
  join(directory, "originals", caseId, `${sourceId}.bin`);
function request(body: unknown, method = "POST", headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/studio/cases/fixture", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
const sourceContext = (caseId = company.id, sourceId = source.id) => ({
  params: Promise.resolve({ caseId, sourceId }),
});
const caseContext = (caseId = company.id) => ({ params: Promise.resolve({ caseId }) });
const previewRequest = (body: unknown = { revision: company.revision }) =>
  preview(request(body), sourceContext());
function reviewBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "review-local-ocr",
    revision: company.revision,
    clientRequestId: randomUUID(),
    sourceId: source.id,
    sourceUpdatedAt: source.updatedAt,
    originalSha256: sha(bytes),
    text: "원본과 대조하고 수정한 가상 검토 본문입니다.",
    reviewed: true,
    ...overrides,
  };
}
const patch = (body: unknown, caseId = company.id) =>
  PATCH(request(body, "PATCH"), caseContext(caseId));
function replaceStored(next: StudioCase | Record<string, unknown>, id = company.id) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(JSON.stringify(next), id);
  } finally {
    db.close();
  }
}
function assertUnchanged(before = company) {
  expect(state.store!.get(company.id)).toEqual(before);
  expect(readFileSync(sourcePath())).toEqual(bytes);
  expect(state.aiConstructor).not.toHaveBeenCalled();
  expect(state.aiParse).not.toHaveBeenCalled();
}

describe("로컬 OCR 미리보기 API·임시 저장소", () => {
  it("pending 원본을 서버 내부 bytes로만 읽어 미검토 초안을 반환하며 저장 상태는 바꾸지 않는다", async () => {
    const before = state.store!.get(company.id);
    const response = await previewRequest();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      caseRevision: company.revision,
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt,
      original: {
        originalName: source.originalName,
        mimeType: "image/png",
        sizeBytes: bytes.length,
        sha256: sha(bytes),
      },
      engine: "windows-ko",
      pages: ocrResult().pages,
      reviewStatus: "unreviewed",
      sourceChanged: false,
      externalTransmission: false,
    });
    expect(result.text).toContain(ocrResult().pages[0].text);
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
    expect(state.runOcr).toHaveBeenCalledWith(bytes, "image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
    assertUnchanged(before);
  });

  it("미리보기를 다시 요청해도 저장 본문·버전·완료 근거가 생기지 않는다", async () => {
    expect((await previewRequest()).status).toBe(200);
    expect((await previewRequest()).status).toBe(200);
    expect(state.runOcr).toHaveBeenCalledTimes(2);
    assertUnchanged();
    expect(state.store!.get(company.id).sources[0]).toMatchObject({
      extraction: "pending",
      text: "",
    });
  });

  it.each([
    {},
    { revision: -1 },
    { revision: 0.5 },
    { revision: "2" },
    { revision: 2, path: "private-source-path" },
    { revision: 2, allowAi: true },
    { revision: 2, text: "CLIENT_SUPPLIED_OCR" },
  ])("미리보기는 revision만 받으며 누락·타입·추가 필드를 거부한다: %#", async (payload) => {
    const response = await previewRequest(payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(state.runOcr).not.toHaveBeenCalled();
    assertUnchanged();
  });

  it("이전 revision은 원본 처리 전에 거부한다", async () => {
    const response = await previewRequest({ revision: company.revision - 1 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_REVISION" });
    expect(state.runOcr).not.toHaveBeenCalled();
    assertUnchanged();
  });

  it.each(["query", "content-type", "invalid-json", "body-limit", "invalid-id"])(
    "미리보기 요청 경계 %s는 child 호출 전에 거부한다",
    async (kind) => {
      let req = request({ revision: company.revision });
      let context = sourceContext();
      if (kind === "query")
        req = new Request("http://localhost:3000/api/studio/fixture?source=untrusted", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: company.revision }),
        });
      if (kind === "content-type")
        req = request({ revision: company.revision }, "POST", { "content-type": "text/plain" });
      if (kind === "invalid-json")
        req = new Request("http://localhost:3000/api/studio/fixture", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        });
      if (kind === "body-limit")
        req = request({ revision: company.revision, extra: "x".repeat(1024) });
      if (kind === "invalid-id") context = sourceContext(company.id, "../outside");
      const response = await preview(req, context);
      expect(response.status).toBe(
        kind === "content-type" ? 415 : kind === "body-limit" ? 413 : 400,
      );
      expect(state.runOcr).not.toHaveBeenCalled();
      assertUnchanged();
    },
  );

  it.each(["extension", "mime", "magic"])(
    "원본 형식의 %s 불일치는 OCR child 전에 차단한다",
    async (kind) => {
      const current = structuredClone(company);
      if (kind === "extension") current.sources[0].originalName = "fixture.txt";
      if (kind === "mime") current.sources[0].mimeType = "application/pdf";
      if (kind === "magic") writeFileSync(sourcePath(), Buffer.alloc(bytes.length, 65));
      replaceStored(current);
      const response = await previewRequest();
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ code: "OCR_UNSUPPORTED_FORMAT" });
      expect(state.runOcr).not.toHaveBeenCalled();
      expect(state.store!.get(company.id)).toEqual(current);
    },
  );

  it("다른 회사의 sourceId를 자사 자료로 읽을 수 없다", async () => {
    const other = state.store!.create({ ...emptyProfile(), companyName: "분리된 시험기업" });
    const foreign = addOriginal(other.id);
    const response = await preview(
      request({ revision: company.revision }),
      sourceContext(company.id, foreign.source.id),
    );
    expect(response.status).toBe(404);
    expect(state.runOcr).not.toHaveBeenCalled();
    assertUnchanged();
  });

  it.each(["manual", "local", "ai"] as const)(
    "이미 본문이 있는 %s 자료는 재추출하지 않는다",
    async (extraction) => {
      const next = structuredClone(company);
      next.sources[0] = { ...next.sources[0], extraction, text: "기존 검토 본문" };
      replaceStored(next);
      const response = await previewRequest();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "OCR_PENDING_REQUIRED" });
      expect(state.runOcr).not.toHaveBeenCalled();
      assertUnchanged(next);
    },
  );

  it("회사 입력 잠금 중에는 OCR child를 호출하지 않는다", async () => {
    const response = await withVentureInputCompanyLock(company.id, previewRequest);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "INPUT_IN_PROGRESS" });
    expect(state.runOcr).not.toHaveBeenCalled();
    assertUnchanged();
  });

  it("OCR 시작 후 회사 입력 잠금이 생겨도 결과 반환을 거부한다", async () => {
    let release: (() => void) | undefined;
    let held: Promise<void> | undefined;
    state.runOcr.mockImplementationOnce(async () => {
      held = withVentureInputCompanyLock(
        company.id,
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      );
      return ocrResult();
    });
    try {
      const response = await previewRequest();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "INPUT_IN_PROGRESS" });
      assertUnchanged();
    } finally {
      release?.();
      await held;
    }
    expect((await previewRequest()).status).toBe(200);
  });

  it("OCR 중 동일 크기의 원본 변경도 SHA 대조로 결과를 폐기한다", async () => {
    const replacement = Buffer.from(bytes);
    replacement[replacement.length - 1] ^= 1;
    state.runOcr.mockImplementation(async () => {
      writeFileSync(sourcePath(), replacement);
      return ocrResult();
    });
    const response = await previewRequest();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OCR_SOURCE_CHANGED" });
    expect(state.store!.get(company.id)).toEqual(company);
  });

  it("OCR 중 기업 revision이 바뀌면 오래된 결과를 반환하지 않는다", async () => {
    state.runOcr.mockImplementation(async () => {
      state.store!.mutate(
        company.id,
        {
          action: "profile",
          revision: company.revision,
          profile: { ...company.profile, industry: "가상 변경" },
        },
        () => [],
      );
      return ocrResult();
    });
    const response = await previewRequest();
    expect(response.status).toBe(409);
    expect(state.store!.get(company.id).revision).toBe(company.revision + 1);
    expect(state.store!.get(company.id).sources[0].extraction).toBe("pending");
  });

  it("회사 revision이 같아도 sourceUpdatedAt 변경은 결과를 폐기한다", async () => {
    const next = structuredClone(company);
    next.sources[0].updatedAt = "2026-09-26T00:00:00.000Z";
    state.runOcr.mockImplementation(async () => {
      replaceStored(next);
      return ocrResult();
    });
    const response = await previewRequest();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OCR_SOURCE_CHANGED" });
    expect(state.store!.get(company.id)).toEqual(next);
  });

  it.each([
    { headers: { origin: "https://external.example" }, code: "CROSS_ORIGIN" },
    { headers: { "sec-fetch-site": "cross-site" }, code: "CROSS_ORIGIN" },
    { headers: { host: "remote.example:3000" }, code: "LOCAL_ONLY" },
  ])("로컬 요청 방어 유지: $code", async ({ headers, code }) => {
    const presentHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers))
      if (typeof value === "string") presentHeaders[key] = value;
    const response = await preview(
      request({ revision: company.revision }, "POST", presentHeaders),
      sourceContext(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
    expect(state.runOcr).not.toHaveBeenCalled();
    assertUnchanged();
  });

  it("런타임 오류가 원문·경로를 노출하지 않고 저장 상태를 보존한다", async () => {
    state.runOcr.mockRejectedValue(new Error(`PRIVATE_RUNTIME_TEXT ${directory}`));
    const response = await previewRequest();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toMatch(/PRIVATE_RUNTIME_TEXT|venture-local-ocr-test-/);
    assertUnchanged();
  });

  it("빈 OCR 결과는 자료 본문으로 승격하지 않는다", async () => {
    state.runOcr.mockResolvedValue({ pages: [{ pageNumber: 1, text: " \n " }], warnings: [] });
    const response = await previewRequest();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "OCR_NO_TEXT" });
    assertUnchanged();
  });

  it.each(["page-count", "page-order", "page-schema", "body-limit"])(
    "child 결과 %s 위반은 본문을 자동 저장하지 않는다",
    async (kind) => {
      const pages =
        kind === "page-count"
          ? Array.from({ length: 21 }, (_, index) => ({ pageNumber: index + 1, text: "초안" }))
          : kind === "page-order"
            ? [{ pageNumber: 2, text: "초안" }]
            : kind === "page-schema"
              ? [{ pageNumber: 1, text: "초안", originalPath: "SHOULD_NOT_LEAK" }]
              : [{ pageNumber: 1, text: "x".repeat(100_000) }];
      state.runOcr.mockResolvedValue({ pages, warnings: [] });
      const response = await previewRequest();
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "OCR_OUTPUT_LIMIT" });
      assertUnchanged();
    },
  );

  it("명시적 런타임 제한 오류는 원본을 보존하고 다음 미리보기는 다시 읽을 수 있다", async () => {
    state.runOcr.mockRejectedValueOnce(
      new StudioError("제한에 도달했습니다.", 413, "OCR_PAGE_LIMIT"),
    );
    expect((await previewRequest()).status).toBe(413);
    assertUnchanged();
    expect((await previewRequest()).status).toBe(200);
    assertUnchanged();
  });
});

describe("로컬 OCR 사용자 검토 저장 API·임시 저장소", () => {
  it("단조 자료버전: OCR 검토 저장의 시계 역행도 자료버전과 실제 검토시각을 분리한다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const prior = Date.parse(source.updatedAt);
      const observed = new Date(prior - 60_000);
      vi.setSystemTime(observed);
      const payload = reviewBody();
      const response = await patch(payload);
      expect(response.status).toBe(200);
      const saved: StudioCase = await response.json();
      const sourceUpdatedAt = new Date(prior + 1).toISOString();
      expect(saved.sources[0].updatedAt).toBe(sourceUpdatedAt);
      expect(saved.sources[0].text).toBe(payload.text);
      expect(saved.sourceOcrReviews[0]).toMatchObject({
        sourceUpdatedAt,
        reviewedAt: observed.toISOString(),
      });
      expect(saved.sourceOcrReviews[0].reviewedAt).not.toBe(saved.sources[0].updatedAt);
      expect(readFileSync(sourcePath())).toEqual(bytes);
      state.store!.close();
      state.store = new StudioStore(directory);
      expect(state.store!.get(company.id)).toEqual(saved);
      const replay = await patch(payload);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(saved);
    } finally {
      vi.useRealTimers();
    }
  });

  it("명시 확인한 본문만 manual로 저장하며 원본·단계·기관 기록은 보존한다", async () => {
    const before = company;
    const payload = reviewBody();
    const response = await patch(payload);
    expect(response.status).toBe(200);
    company = await response.json();
    expect(company.revision).toBe(before.revision + 1);
    expect(company.sources[0]).toMatchObject({
      id: source.id,
      text: payload.text,
      extraction: "manual",
      originalName: source.originalName,
      mimeType: source.mimeType,
      createdAt: source.createdAt,
    });
    expect(company.sources[0].warnings).toContain("보존할 별도 주의사항");
    for (const warning of originalOnlyWarnings)
      expect(company.sources[0].warnings).not.toContain(warning);
    expect(company.stage).toBe(before.stage);
    expect(company.stageHistory).toEqual(before.stageHistory);
    expect(company.agencyRecords).toEqual(before.agencyRecords);
    expect(company.analysis).toBeNull();
    expect(company.selectedCandidateId).toBeNull();
    expect(company.sourceOcrReviews).toHaveLength(1);
    expect(company.sourceOcrReviews[0]).toMatchObject({
      clientRequestId: payload.clientRequestId,
      sourceId: source.id,
      originalSha256: sha(bytes),
      textSha256: sha(payload.text),
      sourceUpdatedAt: company.sources[0].updatedAt,
      reviewedAt: expect.any(String),
    });
    expect(Number.isFinite(Date.parse(company.sourceOcrReviews[0].reviewedAt))).toBe(true);
    expect(company.sourceOcrReviews[0].inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(company.sources[0].warnings).toContain(localOcrReviewedWarning);
    expect(JSON.stringify(company.sourceOcrReviews)).not.toContain(payload.text);
    expect(JSON.stringify(company.sourceOcrReviews)).not.toContain(directory);
    expect(state.runOcr).not.toHaveBeenCalled();
    expect(state.aiConstructor).not.toHaveBeenCalled();
    expect(readFileSync(sourcePath())).toEqual(bytes);
  });

  it.each([
    { reviewed: false },
    { reviewed: undefined },
    { text: " \n\t " },
    { text: "x".repeat(100_001) },
    { originalSha256: "a".repeat(63) },
    { originalSha256: "A".repeat(64) },
    { sourceUpdatedAt: "x".repeat(101) },
    { clientRequestId: "not-a-uuid" },
    { extraction: "local" },
    { reviewedAt: "2026-09-25T00:00:00.000Z" },
    { warnings: [] },
    { originalPath: "private-source-path" },
  ])("확인 필수·한도·서버 메타 주입 방어 유지: %#", async (overrides) => {
    const response = await patch(reviewBody(overrides));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    assertUnchanged();
  });

  it("stale 저장은 본문과 receipt를 남기지 않는다", async () => {
    const response = await patch(reviewBody({ revision: company.revision - 1 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_REVISION" });
    assertUnchanged();
  });

  it("같은 nonce·같은 검토 본문 재시도는 revision과 receipt를 추가하지 않는다", async () => {
    const payload = reviewBody();
    const first = await patch(payload);
    expect(first.status).toBe(200);
    const saved = await first.json();
    const repeated = await patch(payload);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(saved);
    expect(state.store!.get(company.id)).toEqual(saved);
  });

  it("같은 nonce의 다른 검토 본문은 충돌로 거부한다", async () => {
    const payload = reviewBody();
    expect((await patch(payload)).status).toBe(200);
    const saved = state.store!.get(company.id);
    const response = await patch({ ...payload, text: "다른 수정 본문" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OCR_REVIEW_CONFLICT" });
    expect(state.store!.get(company.id)).toEqual(saved);
  });

  it("동일 nonce의 공백 정규화 본문은 같은 요청으로 처리한다", async () => {
    const payload = reviewBody({ text: "  검토 본문\n " });
    expect((await patch(payload)).status).toBe(200);
    const saved = state.store!.get(company.id);
    expect(saved.sources[0].text).toBe("검토 본문");
    const response = await patch({ ...payload, text: "검토 본문" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(saved);
  });

  it.each(["edited", "deleted", "timestamp"])(
    "저장 후 source %s 상태에서 과거 nonce를 재생하지 않는다",
    async (kind) => {
      const payload = reviewBody();
      expect((await patch(payload)).status).toBe(200);
      const saved = state.store!.get(company.id);
      let current: StudioCase;
      if (kind === "deleted")
        current = state.store!.mutate(
          company.id,
          { action: "delete-source", revision: saved.revision, sourceId: source.id },
          () => [],
        );
      else if (kind === "edited")
        current = state.store!.mutate(
          company.id,
          {
            action: "source",
            revision: saved.revision,
            source: { ...saved.sources[0], text: "후속 수동 수정" },
          },
          () => [],
        );
      else {
        current = structuredClone(saved);
        current.sources[0].updatedAt = "2026-09-26T00:00:00.000Z";
        replaceStored(current);
      }
      const response = await patch(payload);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "OCR_REVIEW_CHANGED" });
      expect(state.store!.get(company.id)).toEqual(current);
      expect(current.sourceOcrReviews).toEqual(saved.sourceOcrReviews);
    },
  );

  it("저장 후 원본 변조도 과거 nonce 재시도로 숨길 수 없다", async () => {
    const payload = reviewBody();
    expect((await patch(payload)).status).toBe(200);
    const saved = state.store!.get(company.id);
    const replacement = Buffer.from(bytes);
    replacement[replacement.length - 1] ^= 1;
    writeFileSync(sourcePath(), replacement);
    const response = await patch(payload);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OCR_ORIGINAL_CHANGED" });
    expect(state.store!.get(company.id)).toEqual(saved);
  });

  it("이미 저장한 본문을 다른 nonce로 덮어쓰지 않는다", async () => {
    expect((await patch(reviewBody())).status).toBe(200);
    const saved = state.store!.get(company.id);
    const response = await patch(
      reviewBody({
        revision: saved.revision,
        sourceUpdatedAt: saved.sources[0].updatedAt,
        text: "덮어쓸 본문",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OCR_SOURCE_NOT_PENDING" });
    expect(state.store!.get(company.id)).toEqual(saved);
  });

  it("같은 nonce 문자열은 서로 다른 회사의 저장을 혼동하지 않는다", async () => {
    const payload = reviewBody();
    expect((await patch(payload)).status).toBe(200);
    const saved = state.store!.get(company.id);
    const other = state.store!.create({ ...emptyProfile(), companyName: "분리된 검토기업" });
    const foreign = addOriginal(other.id);
    const foreignPayload = {
      ...payload,
      revision: state.store!.get(other.id).revision,
      sourceId: foreign.source.id,
      sourceUpdatedAt: foreign.source.updatedAt,
      originalSha256: sha(foreign.bytes),
      text: "다른 회사의 별도 본문",
    };
    const response = await patch(foreignPayload, other.id);
    expect(response.status).toBe(200);
    expect(state.store!.get(other.id).sourceOcrReviews[0].clientRequestId).toBe(
      payload.clientRequestId,
    );
    expect(state.store!.get(company.id)).toEqual(saved);
  });

  it("회사 입력 잠금 중 검토 저장도 거부한다", async () => {
    const response = await withVentureInputCompanyLock(company.id, () => patch(reviewBody()));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "INPUT_IN_PROGRESS" });
    assertUnchanged();
  });

  it("다른 회사의 sourceId는 검토 본문과 receipt로 연결하지 않는다", async () => {
    const other = state.store!.create({ ...emptyProfile(), companyName: "다른 OCR 시험기업" });
    const foreign = addOriginal(other.id);
    const response = await patch(
      reviewBody({
        sourceId: foreign.source.id,
        sourceUpdatedAt: foreign.source.updatedAt,
        originalSha256: sha(foreign.bytes),
      }),
    );
    expect(response.status).toBe(404);
    assertUnchanged();
  });

  it.each(["hash", "timestamp"])(
    "검토 저장 시 %s 바인딩 불일치는 본문을 보존한다",
    async (kind) => {
      const response = await patch(
        reviewBody(
          kind === "hash"
            ? { originalSha256: "0".repeat(64) }
            : { sourceUpdatedAt: "stale-source-time" },
        ),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: kind === "hash" ? "OCR_ORIGINAL_CHANGED" : "OCR_SOURCE_CHANGED",
      });
      assertUnchanged();
    },
  );

  it("검토 전 같은 크기 원본 변조를 실제 SHA로 거부한다", async () => {
    const payload = reviewBody();
    const replacement = Buffer.from(bytes);
    replacement[replacement.length - 1] ^= 1;
    writeFileSync(sourcePath(), replacement);
    const response = await patch(payload);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OCR_ORIGINAL_CHANGED" });
    expect(state.store!.get(company.id)).toEqual(company);
  });

  it("저장 receipt와 수동 본문은 앱 재시작 후에도 보존된다", async () => {
    expect((await patch(reviewBody())).status).toBe(200);
    const saved = state.store!.get(company.id);
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(state.store.get(company.id)).toEqual(saved);
    const response = await GET(
      new Request("http://localhost:3000/api/studio/cases/fixture"),
      caseContext(),
    );
    expect(await response.json()).toEqual(saved);
  });

  it("legacy 회사의 OCR receipt 누락은 빈 목록으로 읽힌다", async () => {
    const legacy = { ...company } as Record<string, unknown>;
    delete legacy.sourceOcrReviews;
    replaceStored(legacy);
    expect(state.store!.get(company.id).sourceOcrReviews).toEqual([]);
    expect((await patch(reviewBody())).status).toBe(200);
    expect(state.store!.get(company.id).sourceOcrReviews).toHaveLength(1);
  });

  it("Store 직접 호출도 확인·서버 필드 주입을 다시 검증한다", () => {
    for (const overrides of [{ reviewed: false }, { recordedAt: "injected" }]) {
      expect(() =>
        state.store!.mutate(company.id, reviewBody(overrides) as CaseMutation, () => []),
      ).toThrow();
      assertUnchanged();
    }
  });

  it("receipt 한도 초과는 본문과 회사 revision까지 롤백한다", async () => {
    const full = structuredClone(company);
    const at = "2026-09-25T00:00:00.000Z";
    full.sourceOcrReviews = Array.from({ length: 200 }, () => ({
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: sha("old input"),
      sourceId: source.id,
      originalSha256: sha(bytes),
      textSha256: sha("old text"),
      reviewedAt: at,
      sourceUpdatedAt: at,
    }));
    replaceStored(full);
    const response = await patch(reviewBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OCR_REVIEW_LIMIT" });
    assertUnchanged(full);
  });

  it("기존 주의사항 30개를 삭제하지 않고 검토 저장 전체를 롤백한다", async () => {
    const full = structuredClone(company);
    full.sources[0].warnings = Array.from(
      { length: 30 },
      (_, index) => `보존할 기존 경고 ${index + 1}`,
    );
    replaceStored(full);
    const response = await patch(reviewBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OCR_REVIEW_WARNING_LIMIT" });
    assertUnchanged(full);
  });

  it("기업 전체 본문 한도 실패도 검토 receipt를 남기지 않는다", async () => {
    const otherSource = addOriginal(company.id, {
      text: "A".repeat(100_000),
      extraction: "manual",
      name: "이미 등록한 본문",
    });
    const before = state.store!.get(company.id);
    expect(otherSource.source.id).not.toBe(source.id);
    const response = await patch(reviewBody({ text: "B".repeat(61_000) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "SOURCE_TEXT_LIMIT" });
    assertUnchanged(before);
  });

  it("새 검토본문은 기존 분석·원고 확인만 해제하고 기존 원고 내용은 보존한다", async () => {
    const now = "2026-09-25T00:00:00.000Z";
    const before = structuredClone(company);
    before.analysis = {
      summary: "예전 분석",
      facts: [],
      candidates: [],
      questions: [],
      warnings: [],
      generatedAt: now,
      sourceRevision: company.revision,
      mode: "assisted",
    };
    before.selectedCandidateId = "old-candidate";
    before.plans = [
      {
        id: randomUUID(),
        candidateId: "old-candidate",
        version: 1,
        generatedAt: now,
        sourceRevision: company.revision,
        mode: "assisted",
        confirmedAt: now,
        review: [],
        content: {
          title: "예전 원고",
          summary: "보존할 초안",
          sections: [
            {
              key: "problem",
              title: "문제",
              content: "기존 내용",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: [],
        },
      },
    ];
    replaceStored(before);
    const response = await patch(reviewBody());
    expect(response.status).toBe(200);
    const saved: StudioCase = await response.json();
    expect(saved.analysis).toBeNull();
    expect(saved.selectedCandidateId).toBeNull();
    expect(saved.plans).toEqual(before.plans.map((plan) => ({ ...plan, confirmedAt: null })));
    expect(saved.stage).toBe(before.stage);
    expect(saved.stageHistory).toEqual(before.stageHistory);
    expect(saved.agencyRecords).toEqual(before.agencyRecords);
  });

  it("미검토 OCR 초안은 분석의 등록 본문으로 사용되지 않는다", async () => {
    expect((await previewRequest()).status).toBe(200);
    const current = state.store!.get(company.id);
    const analysis = await analyzeCompany(current, "assisted");
    expect(JSON.stringify(analysis)).not.toContain(ocrResult().pages[0].text);
    expect(current.sources[0]).toMatchObject({ extraction: "pending", text: "" });
    expect(state.aiConstructor).not.toHaveBeenCalled();
  });
});
