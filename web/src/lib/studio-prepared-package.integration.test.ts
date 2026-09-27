import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  sectionDefinitions,
  type StudioCase,
  type SourceDocument,
  type Candidate,
} from "./studio-schema";
import { MAX_PREPARED_PACKAGES, type PreparedPackageRecord } from "./studio-prepared-package-types";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  external: vi.fn(() => {
    throw new Error("External calls are forbidden");
  }),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
}));
import { GET, POST } from "@/app/api/studio/cases/[caseId]/prepared-packages/route";
import { GET as detail } from "@/app/api/studio/cases/[caseId]/prepared-packages/[packageId]/route";
import { GET as download } from "@/app/api/studio/cases/[caseId]/prepared-packages/[packageId]/download/route";

let directory: string, company: StudioCase, source: SourceDocument;
const original = Buffer.from("SYNTHETIC ORIGINAL ONLY");
// Each preserved ZIP checks the original before/after ZIP creation and again before commit.
// Windows runs real file-protection subprocesses; parallel builds can exceed five seconds.
const originalIoTimeout = process.platform === "win32" ? 15000 : 5000;
const quote = "합성 장치의 설계를 진행 중입니다.";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const candidate: Candidate = {
  id: "synthetic-package",
  title: "가상 장치",
  problem: "가상 문제",
  solution: quote,
  targetCustomer: "가상 고객",
  differentiation: "확인 필요",
  stage: "설계 중",
  businessModel: "계획",
  recommendation: "입력 내용 기반",
  evidence: [],
  gaps: [],
};
function url(caseId = company.id, path = "") {
  return `http://127.0.0.1:3000/api/studio/cases/${caseId}/prepared-packages${path}`;
}
const input = (sourceIds = [source.id]) => ({
  revision: company.revision,
  planId: company.plans[0].id,
  sourceIds,
  clientRequestId: randomUUID(),
});
const context = (caseId = company.id) => ({ params: Promise.resolve({ caseId }) });
function post(body: unknown = input(), headers: Record<string, string> = {}, caseId = company.id) {
  return POST(
    new Request(url(caseId), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    context(caseId),
  );
}
async function save(body = input()) {
  const response = await post(body);
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value as { package: PreparedPackageRecord; replayed: boolean };
}
function getDownload(packageId: string, caseId = company.id) {
  return download(new Request(url(caseId, `/${packageId}/download`)), {
    params: Promise.resolve({ caseId, packageId }),
  });
}
function dbAction(action: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    action(db);
  } finally {
    db.close();
  }
}
function count() {
  return state.store!.listPreparedPackages(company.id).packages.length;
}
beforeEach(() => {
  vi.restoreAllMocks();
  state.external.mockClear();
  directory = mkdtempSync(join(tmpdir(), "venture-prepared-package-"));
  state.store = new StudioStore(directory);
  company = state.store.create({
    ...emptyProfile(),
    companyName: "합성 준비본 기업",
    technologySummary: quote,
  });
  const now = new Date().toISOString();
  source = {
    id: randomUUID(),
    name: "선택된 시험자료",
    kind: "technology",
    text: quote,
    originalName: "synthetic.txt",
    mimeType: "text/plain",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  company = state.store.addUpload(company.id, company.revision, source, original);
  company = state.store.saveAnalysis(
    company.id,
    company.revision,
    { summary: "가상 분석", facts: [], candidates: [candidate], questions: [], warnings: [] },
    "ai",
  );
  company = state.store.mutate(
    company.id,
    {
      action: "select-candidate",
      revision: company.revision,
      clientRequestId: randomUUID(),
      candidateId: candidate.id,
      analysisGeneratedAt: company.analysis!.generatedAt,
      analysisSourceRevision: company.analysis!.sourceRevision,
      expectedSelectedCandidateId: null,
      reason: "합성 자료와 사업 내용을 확인했습니다.",
    },
    () => [],
  );
  company = state.store.saveGeneratedPlan(
    company.id,
    company.revision,
    candidate.id,
    {
      title: "보관할 합성 원고",
      summary: "검토 초안",
      sections: sectionDefinitions.map((item) => ({
        ...item,
        content: quote,
        evidence: [{ sourceId: source.id, quote, locator: "본문" }],
        needsConfirmation: true,
      })),
      actionItems: ["설계 근거 확인"],
      interviewQuestions: ["설계를 확인할 자료가 있나요?"],
    },
    [
      {
        id: "semantic-saved",
        severity: "warning",
        category: "fact-vs-plan",
        message: "설계 중인 사실을 확인해 주세요.",
        action: "원자료 확인",
        sectionKey: "solution",
        sourceIds: [source.id],
      },
    ],
    "ai",
  );
});
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-prepared-package-") || boundary.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("불변 로컬 준비본의 보관·재현·권한 경계", () => {
  it(
    "원고·AI 의견·규칙 의견·확인표시·선택 원본 SHA와 실제 ZIP을 함께 보관한다",
    async () => {
      const before = structuredClone(company),
        request = input();
      const result = await save(request),
        record = result.package;
      expect(result.replayed).toBe(false);
      expect(record).toMatchObject({
        version: 1,
        caseId: company.id,
        caseRevision: company.revision,
        input: request,
        scope: "local-preparation-only",
        plan: {
          id: company.plans[0].id,
          content: company.plans[0].content,
          review: company.plans[0].review,
        },
        review: { storedFindings: company.plans[0].review, confirmedAt: null, draft: true },
      });
      expect(
        record.review.currentRuleFindings.some((item) => item.category === "confirmation"),
      ).toBe(true);
      expect(record.review.draftReasons).toContain("STORED_SEMANTIC_FINDINGS");
      expect(record.review.unconfirmedSectionKeys).toHaveLength(10);
      expect(record.plan.contentSha256).toBe(sha(JSON.stringify(company.plans[0].content)));
      expect(record.sources[0]).toMatchObject({
        textSha256: sha(quote),
        originalSha256: sha(original),
        originalSizeBytes: original.length,
      });
      expect(record.sources[0].source).not.toHaveProperty("text");
      const response = await getDownload(record.id);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Archive-SHA256")).toBe(sha(bytes));
      expect(sha(bytes)).toBe(record.zip.sha256);
      expect(bytes.length).toBe(record.zip.sizeBytes);
      const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
      const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
      expect(manifest.plan.draftReasons).toEqual(record.review.draftReasons);
      expect(manifest.plan.draft).toBe(record.review.draft);
      expect(await zip.file("review.md")!.async("string")).toContain(record.plan.review[0].message);
      expect(await zip.file(`originals/${source.id}.txt`)!.async("nodebuffer")).toEqual(original);
      expect(await zip.file("plan.md")!.async("string")).toContain(
        "기관 접수·수신·심사·제출 완료를 증명하지 않는",
      );
      expect(state.store!.get(company.id)).toEqual(before);
      expect(company.applicationEvents).toEqual([]);
    },
    originalIoTimeout,
  );
  it(
    "같은 nonce는 회사 변경·원본 삭제 뒤에도 과거 준비본과 같은 ZIP을 재현한다",
    async () => {
      const request = input(),
        first = await save(request);
      const bytes = Buffer.from(await (await getDownload(first.package.id)).arrayBuffer());
      company = state.store!.mutate(
        company.id,
        { action: "delete-source", revision: company.revision, sourceId: source.id },
        () => [],
      );
      const reader = vi.spyOn(state.store!, "originalForVentureInput");
      expect(await save(request)).toEqual({ ...first, replayed: true });
      expect(reader).not.toHaveBeenCalled();
      expect(Buffer.from(await (await getDownload(first.package.id)).arrayBuffer())).toEqual(bytes);
      expect(count()).toBe(1);
    },
    originalIoTimeout,
  );
  it(
    "재접속 목록과 상세 기록으로 응답 유실의 nonce를 확인할 수 있다",
    async () => {
      const saved = await save();
      state.store!.close();
      state.store = new StudioStore(directory);
      const response = await GET(new Request(url()), context());
      const listing = await response.json();
      expect(listing).toMatchObject({
        caseId: company.id,
        caseRevision: company.revision,
        packages: [
          {
            id: saved.package.id,
            clientRequestId: saved.package.clientRequestId,
            sourceIds: [source.id],
            storedReviewCount: 1,
          },
        ],
      });
      expect(JSON.stringify(listing)).not.toContain(quote);
      const details = await detail(new Request(url(company.id, `/${saved.package.id}`)), {
        params: Promise.resolve({ caseId: company.id, packageId: saved.package.id }),
      });
      expect(await details.json()).toEqual({ package: saved.package });
    },
    originalIoTimeout,
  );
  it(
    "같은 nonce로 다른 범위를 보관하거나 오래된 revision을 새 요청으로 보관하지 않는다",
    async () => {
      const request = input();
      await save(request);
      expect((await post({ ...request, sourceIds: [] })).status).toBe(409);
      expect((await post({ ...input(), revision: company.revision - 1 })).status).toBe(409);
      expect(count()).toBe(1);
    },
    originalIoTimeout,
  );
  it(
    "다른 회사의 준비본·원고·원본을 읽거나 보관할 수 없다",
    async () => {
      const saved = await save();
      const other = state.store!.create({ ...emptyProfile(), companyName: "다른 합성 기업" });
      expect((await getDownload(saved.package.id, other.id)).status).toBe(404);
      const details = await detail(new Request(url(other.id)), {
        params: Promise.resolve({ caseId: other.id, packageId: saved.package.id }),
      });
      expect(details.status).toBe(404);
      expect((await post({ ...input(), revision: other.revision }, {}, other.id)).status).toBe(404);
      expect(state.store!.listPreparedPackages(other.id).packages).toHaveLength(0);
    },
    originalIoTimeout,
  );
  it(
    "ZIP 생성 도중 회사 revision이 바뀌면 준비본을 추가하지 않는다",
    async () => {
      const build = JSZip.prototype.generateAsync;
      vi.spyOn(JSZip.prototype, "generateAsync").mockImplementationOnce(async function (
        this: JSZip,
        ...args
      ) {
        company = state.store!.mutate(
          company.id,
          {
            action: "profile",
            revision: company.revision,
            profile: { ...company.profile, customers: "바뀐 고객 설명" },
          },
          () => [],
        );
        return build.apply(this, args);
      });
      expect((await post()).status).toBe(409);
      expect(count()).toBe(0);
    },
    originalIoTimeout,
  );
  it(
    "최종 보관 직전 원본 바이트가 달라지면 새 기록을 만들지 않는다",
    async () => {
      const commit = state.store!.commitPreparedPackage.bind(state.store!);
      vi.spyOn(state.store!, "commitPreparedPackage").mockImplementationOnce((...args) => {
        writeFileSync(
          join(directory, "originals", company.id, `${source.id}.bin`),
          Buffer.from("TAMPERED SYNTHETIC ORIGINAL"),
        );
        return commit(...args);
      });
      expect((await post()).status).toBe(409);
      expect(count()).toBe(0);
    },
    originalIoTimeout,
  );
  it(
    "SQLite 삽입 실패면 기록과 ZIP 모두 남기지 않는다",
    async () => {
      dbAction((db) =>
        db.exec(
          "CREATE TRIGGER deny_prepared_insert BEFORE INSERT ON studio_prepared_packages BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END",
        ),
      );
      expect((await post()).status).toBe(500);
      expect(count()).toBe(0);
      dbAction((db) => db.exec("DROP TRIGGER deny_prepared_insert"));
      expect((await save()).package.version).toBe(1);
      // Two ZIP builds perform the real Windows protected-file checks three times each.
    },
    originalIoTimeout,
  );
  it(
    "중복 동시 요청은 중복 기록 없이 하나의 보관 결과로 수렴한다",
    async () => {
      const request = input();
      const responses = await Promise.all([post(request), post(request)]);
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
      expect(count()).toBe(1);
      expect((await save(request)).replayed).toBe(true);
    },
    originalIoTimeout,
  );
  it("회사별 20개 한도는 원자적으로 검사하고 기존 보관본은 그대로 둔다", async () => {
    for (let index = 0; index < MAX_PREPARED_PACKAGES - 1; index++) await save(input([]));
    const responses = await Promise.all([post(input([])), post(input([]))]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(count()).toBe(MAX_PREPARED_PACKAGES);
    const response = await post(input([]));
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("PREPARED_PACKAGE_LIMIT");
    expect(count()).toBe(MAX_PREPARED_PACKAGES);
  });
  it(
    "보관 ZIP 변조는 SHA 재검사로 내려받기와 재현을 차단한다",
    async () => {
      const request = input(),
        saved = await save(request);
      dbAction((db) => {
        db.prepare("UPDATE studio_prepared_packages SET archive=? WHERE id=?").run(
          Buffer.from("BROKEN ARCHIVE"),
          saved.package.id,
        );
      });
      expect((await getDownload(saved.package.id)).status).toBe(409);
      expect((await post(request)).status).toBe(409);
    },
    originalIoTimeout,
  );
  it("보관 메타데이터 변조는 목록·상세·다운로드에서 검출한다", async () => {
    const saved = await save(input([]));
    dbAction((db) => {
      const altered = structuredClone(saved.package);
      altered.review.draft = false;
      db.prepare("UPDATE studio_prepared_packages SET body=? WHERE id=?").run(
        JSON.stringify(altered),
        saved.package.id,
      );
    });
    expect((await GET(new Request(url()), context())).status).toBe(409);
    expect(
      (
        await detail(new Request(url()), {
          params: Promise.resolve({ caseId: company.id, packageId: saved.package.id }),
        })
      ).status,
    ).toBe(409);
    expect((await getDownload(saved.package.id)).status).toBe(409);
  });
  it(
    "명시적인 회사 삭제는 준비본도 함께 삭제하지만 원본 삭제와는 구분된다",
    async () => {
      const saved = await save();
      state.store!.delete(company.id, company.revision);
      dbAction((db) => {
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM studio_prepared_packages").get(),
        ).toMatchObject({ count: 0 });
      });
      expect((await getDownload(saved.package.id)).status).toBe(404);
    },
    originalIoTimeout,
  );
  it("외부 origin·추가 필드·과다 파일·공식입력 중 보관 요청을 차단한다", async () => {
    expect((await post(input(), { origin: "https://example.com" })).status).toBe(403);
    expect((await post({ ...input(), submitted: true })).status).toBe(400);
    expect((await post(input(Array.from({ length: 11 }, () => randomUUID())))).status).toBe(400);
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await post()).status).toBe(409);
    });
    expect(count()).toBe(0);
  });
});
