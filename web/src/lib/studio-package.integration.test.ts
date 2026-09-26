import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  type BusinessPlan,
  type Candidate,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import { packageLimits, type PackageManifest } from "./studio-package-types";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  forbiddenExternal: vi.fn(() => {
    throw new Error("No external work is allowed during packaging");
  }),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.forbiddenExternal();
    }
  },
}));
vi.mock("@/lib/venturein-runner", () => ({
  startVentureSession: state.forbiddenExternal,
  stopVentureSession: state.forbiddenExternal,
  inspectVentureApplication: state.forbiddenExternal,
  inputVentureApplication: state.forbiddenExternal,
}));
import { POST } from "@/app/api/studio/cases/[caseId]/package/route";

let directory: string;
let company: StudioCase;
let included: SourceDocument;
let unrelated: SourceDocument;
let selectedPlan: BusinessPlan;
const originalBytes = Buffer.from("%PDF-1.7\nSYNTHETIC SELECTED ORIGINAL");
const unselectedBytes = Buffer.from("UNSELECTED_ORIGINAL_SENTINEL");
const exactQuote = "이 문장은 합성 원문의 정확한 인용입니다.";
const hash = (buffer: Buffer | string) => createHash("sha256").update(buffer).digest("hex");
const candidate: Candidate = {
  id: "synthetic-candidate",
  title: "시험 아이템",
  problem: "시험 문제",
  solution: "시험 해결",
  targetCustomer: "시험 고객",
  differentiation: "확인 필요",
  stage: "구상",
  businessModel: "확인 필요",
  recommendation: "확인 필요",
  evidence: [],
  gaps: [],
};
function addOriginal(
  overrides: Partial<SourceDocument> = {},
  bytes = originalBytes,
  caseId = company.id,
) {
  const now = new Date().toISOString();
  const source: SourceDocument = {
    id: randomUUID(),
    name: "선택한 합성 근거",
    kind: "technology",
    text: exactQuote,
    originalName: "selected.pdf",
    mimeType: "application/pdf",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const record = state.store!.get(caseId);
  const next = state.store!.addUpload(caseId, record.revision, source, bytes);
  if (caseId === company.id) company = next;
  return next.sources.find((item) => item.id === source.id)!;
}
function seedPlan() {
  company = state.store!.saveAnalysis(
    company.id,
    company.revision,
    { summary: "분석", facts: [], candidates: [candidate], questions: [], warnings: [] },
    "assisted",
  );
  company = state.store!.mutate(
    company.id,
    {
      action: "select-candidate",
      revision: company.revision,
      clientRequestId: randomUUID(),
      candidateId: candidate.id,
      analysisGeneratedAt: company.analysis!.generatedAt,
      analysisSourceRevision: company.analysis!.sourceRevision,
      expectedSelectedCandidateId: company.selectedCandidateId,
      reason: "합성 후보 선택 근거",
    },
    () => [],
  );
  company = state.store!.saveGeneratedPlan(
    company.id,
    company.revision,
    candidate.id,
    {
      title: "선택한 계획 버전",
      summary: "선택한 원고 본문",
      sections: [
        {
          key: "solution",
          title: "기술 구상",
          content: "구체 실적 확인 전 합성 구상",
          evidence: [{ sourceId: included.id, quote: exactQuote, locator: "본문 1문단" }],
          needsConfirmation: true,
        },
      ],
      actionItems: ["원문과 초안 대조"],
      interviewQuestions: ["기술 개발 근거는 무엇입니까?"],
    },
    [
      {
        id: "synthetic-review",
        severity: "warning",
        category: "confirmation",
        message: "자료 확인 필요",
        action: "실적 대조",
        sectionKey: "solution",
        sourceIds: [included.id],
      },
    ],
    "assisted",
  );
  selectedPlan = company.plans[0];
}
function request(body: unknown, headers: Record<string, string> = {}, query = "") {
  return new Request(`http://127.0.0.1:3000/api/studio/cases/${company.id}/package${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
const body = (overrides: Record<string, unknown> = {}) => ({
  revision: company.revision,
  planId: selectedPlan.id,
  sourceIds: [included.id],
  ...overrides,
});
const context = (caseId = company.id) => ({ params: Promise.resolve({ caseId }) });
const post = (input: unknown = body(), caseId = company.id) =>
  POST(request(input), context(caseId));
function rows() {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return ["studio_cases", "venture_accounts", "venture_workflows"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    );
  } finally {
    db.close();
  }
}
function replaceBody(record: StudioCase) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(
      JSON.stringify(record),
      record.id,
    );
  } finally {
    db.close();
  }
  company = state.store!.get(company.id);
}
const filePath = (source = included) =>
  join(directory, "originals", company.id, `${source.id}.bin`);
async function unpack(response: Response) {
  expect(response.status).toBe(200);
  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.keys(zip.files).filter((key) => !zip.files[key].dir);
  const textEntries = await Promise.all(
    entries
      .filter((key) => !key.startsWith("originals/"))
      .map(async (path) => ({ path, text: await zip.file(path)!.async("string") })),
  );
  const manifestFile = textEntries.find((entry) => entry.path.endsWith("manifest.json"));
  expect(manifestFile).toBeDefined();
  const manifest = JSON.parse(manifestFile!.text) as PackageManifest;
  return {
    buffer,
    zip,
    entries,
    textEntries,
    manifest,
    combinedText: textEntries.map((entry) => entry.text).join("\n"),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "venture-package-test-"));
  state.store = new StudioStore(directory);
  company = state.store.create({
    ...emptyProfile(),
    companyName: "패키지 가상기업",
    financials: "PRIVATE_UNREQUESTED_PROFILE_SENTINEL",
  });
  included = addOriginal();
  unrelated = addOriginal(
    {
      name: "PRIVATE_UNSELECTED_SOURCE_NAME",
      originalName: "private-unselected.txt",
      mimeType: "text/plain",
      kind: "other",
      text: "PRIVATE_UNSELECTED_SOURCE_TEXT",
      warnings: ["PRIVATE_UNSELECTED_WARNING"],
    },
    unselectedBytes,
  );
  seedPlan();
  state.store.saveVentureAccountEnvelope(
    company.id,
    0,
    Buffer.from("PRIVATE_ACCOUNT_PAYLOAD"),
    "private-account-mask",
  );
  state.store.saveVentureWorkflowEnvelope(
    company.id,
    0,
    JSON.stringify({ private: "PRIVATE_OFFICIAL_WORKFLOW" }),
  );
  vi.stubEnv("OPENAI_API_KEY", "PRIVATE_ENV_API_KEY_SENTINEL");
});
afterEach(() => {
  expect(state.forbiddenExternal).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (
    isAbsolute(boundary) ||
    boundary.startsWith("..") ||
    !boundary.startsWith("venture-package-test-")
  )
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// Native Windows SQLite/filesystem scans share CPU with the parallel production build.
describe("제출 준비 ZIP — 실제 임시 SQLite/API", { timeout: 15_000 }, () => {
  it("선택한 회사 원본·계획 버전만 포함하고 기업·계정·공식 연결 DB를 변경하지 않는다", async () => {
    const before = rows();
    const response = await post();
    expect(response.headers.get("content-type")).toContain("application/zip");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const pack = await unpack(response);
    expect(pack.manifest).toMatchObject({
      formatVersion: 1,
      scope: "local-preparation-only",
      caseId: company.id,
      caseRevision: company.revision,
      plan: { id: selectedPlan.id, version: selectedPlan.version, draft: true },
      originals: [
        {
          sourceId: included.id,
          originalName: included.originalName,
          sizeBytes: originalBytes.length,
          sha256: hash(originalBytes),
        },
      ],
    });
    expect(await pack.zip.file(pack.manifest.originals[0].path)!.async("nodebuffer")).toEqual(
      originalBytes,
    );
    expect(pack.entries.filter((path) => path.startsWith("originals/"))).toHaveLength(1);
    expect(pack.combinedText).toContain("선택한 원고 본문");
    expect(pack.combinedText).toContain(exactQuote);
    for (const forbidden of [
      directory,
      "PRIVATE_ENV_API_KEY_SENTINEL",
      "PRIVATE_ACCOUNT_PAYLOAD",
      "private-account-mask",
      "PRIVATE_OFFICIAL_WORKFLOW",
      "PRIVATE_UNREQUESTED_PROFILE_SENTINEL",
      "PRIVATE_UNSELECTED_SOURCE_NAME",
      "PRIVATE_UNSELECTED_SOURCE_TEXT",
      "PRIVATE_UNSELECTED_WARNING",
      unrelated.id,
      unrelated.originalName!,
    ])
      expect(pack.combinedText).not.toContain(forbidden);
    expect(rows()).toEqual(before);
  });

  it("sourceIds 빈 배열이면 원본을 넣지 않고 인용의 원본 미포함 상태를 명시한다", async () => {
    const pack = await unpack(await post(body({ sourceIds: [] })));
    expect(pack.manifest.originals).toEqual([]);
    expect(pack.entries.filter((path) => path.startsWith("originals/"))).toEqual([]);
    expect(pack.combinedText).toContain('"originalIncluded": false');
  });

  it("선택하지 않은 새 원고 버전은 제외하고 과거 원고임을 DRAFT로 표시한다", async () => {
    company = state.store!.mutate(
      company.id,
      {
        action: "save-plan",
        revision: company.revision,
        planId: selectedPlan.id,
        content: { ...selectedPlan.content, summary: "PRIVATE_OTHER_PLAN_VERSION" },
      },
      () => [],
    );
    const pack = await unpack(await post());
    expect(pack.manifest.plan).toMatchObject({
      id: selectedPlan.id,
      latestVersion: false,
      draft: true,
    });
    expect(pack.combinedText).not.toContain("PRIVATE_OTHER_PLAN_VERSION");
    expect(pack.combinedText).toContain("DRAFT");
  });

  it("자료 변경으로 오래된 원고도 삭제하지 않고 DRAFT·현재 근거 불일치를 표시한다", async () => {
    company = state.store!.mutate(
      company.id,
      {
        action: "profile",
        revision: company.revision,
        profile: { ...company.profile, customers: "자료가 변경됨" },
      },
      () => [],
    );
    const before = rows();
    const pack = await unpack(await post());
    expect(pack.manifest.plan).toMatchObject({ currentEvidence: false, draft: true });
    expect(pack.manifest.plan.draftReasons.length).toBeGreaterThan(0);
    expect(pack.combinedText).toContain("DRAFT");
    expect(rows()).toEqual(before);
  });

  it("ZIP의 각 목록 SHA·크기가 실제 항목과 일치하며 파일명은 고정 경로와 UUID로만 구성한다", async () => {
    const pack = await unpack(await post());
    expect(pack.entries.sort()).toEqual(
      [
        "plan.md",
        "review.md",
        "evidence.json",
        "manifest.json",
        "manifest.md",
        `originals/${included.id}.pdf`,
      ].sort(),
    );
    for (const entry of pack.manifest.files) {
      const bytes = await pack.zip.file(entry.path)!.async("nodebuffer");
      expect(entry.sha256).toBe(hash(bytes));
      expect(entry.sizeBytes).toBe(bytes.length);
      expect(isAbsolute(entry.path)).toBe(false);
      expect(entry.path).not.toMatch(/\\|\.\.|:/);
    }
    expect(pack.manifest.files.some((entry) => entry.path.startsWith("manifest."))).toBe(false);
  });

  it("원본을 선택해도 pending 본문은 분석·검토 완료가 되지 않는다", async () => {
    const pending = addOriginal({
      name: "본문 미추출 시험 자료",
      text: "",
      extraction: "pending",
      originalName: "pending.pdf",
    });
    const before = rows();
    const pack = await unpack(await post(body({ sourceIds: [pending.id] })));
    expect(pack.manifest.originals).toEqual([
      expect.objectContaining({ sourceId: pending.id, extraction: "pending" }),
    ]);
    expect(pack.manifest.plan.draft).toBe(true);
    expect(pack.combinedText).toContain("pending");
    expect(rows()).toEqual(before);
  });

  it("과거 확인시각만 존재해도 미확인 절이 있으면 DRAFT를 유지한다", async () => {
    replaceBody({
      ...company,
      plans: company.plans.map((plan) => ({ ...plan, confirmedAt: new Date().toISOString() })),
    });
    const pack = await unpack(await post());
    expect(pack.manifest.plan).toMatchObject({ confirmedAt: expect.any(String), draft: true });
    expect(pack.manifest.plan.draftReasons).toContain("UNCONFIRMED_SECTION");
    expect(pack.combinedText).toContain("기관 접수·수신·심사·제출 완료를 증명하지");
  });

  it("동일 이름 원본 두 개를 선택해도 UUID 경로로 분리한다", async () => {
    const another = addOriginal(
      { originalName: included.originalName },
      Buffer.from("DIFFERENT SELECTED ORIGINAL"),
    );
    const pack = await unpack(await post(body({ sourceIds: [included.id, another.id] })));
    expect(new Set(pack.manifest.originals.map((item) => item.path)).size).toBe(2);
    expect(await pack.zip.file(pack.manifest.originals[0].path)!.async("nodebuffer")).toEqual(
      originalBytes,
    );
    expect(await pack.zip.file(pack.manifest.originals[1].path)!.async("string")).toBe(
      "DIFFERENT SELECTED ORIGINAL",
    );
  });

  it.each(["plan", "source"])("다른 회사의 %s를 포함하려는 요청은 거부한다", async (kind) => {
    const other = state.store!.create({ ...emptyProfile(), companyName: "다른 합성기업" });
    const foreignSource = addOriginal(
      { name: "FOREIGN_SOURCE_SENTINEL" },
      Buffer.from("FOREIGN_ORIGINAL_SENTINEL"),
      other.id,
    );
    const foreignPlanId = randomUUID();
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      const foreign = state.store!.get(other.id);
      db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(
        JSON.stringify({ ...foreign, plans: [{ ...selectedPlan, id: foreignPlanId }] }),
        other.id,
      );
    } finally {
      db.close();
    }
    const before = rows();
    const response = await post(
      body(kind === "plan" ? { planId: foreignPlanId } : { sourceIds: [foreignSource.id] }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("application/zip");
    expect(JSON.stringify(await response.json())).not.toMatch(/FOREIGN_|\.bin|originals/);
    expect(rows()).toEqual(before);
  });

  it.each(["plan", "source", "manual-source"])(
    "현재 회사의 %s가 없으면 묶음을 만들지 않는다",
    async (kind) => {
      let sourceId = randomUUID();
      if (kind === "manual-source") {
        sourceId = randomUUID();
        company = state.store!.mutate(
          company.id,
          {
            action: "source",
            revision: company.revision,
            source: {
              ...included,
              id: sourceId,
              originalName: null,
              mimeType: null,
              extraction: "manual",
            },
          },
          () => [],
        );
      }
      const before = rows();
      const response = await post(
        body(kind === "plan" ? { planId: randomUUID() } : { sourceIds: [sourceId] }),
      );
      expect(response.status).toBe(404);
      expect(rows()).toEqual(before);
    },
  );

  it("오래된 회사 revision은 원본을 읽기 전에 거부한다", async () => {
    const reader = vi.spyOn(state.store!, "originalForVentureInput");
    const before = rows();
    const response = await post(body({ revision: company.revision - 1 }));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("STALE_REVISION");
    expect(reader).not.toHaveBeenCalled();
    expect(rows()).toEqual(before);
  });

  it("원본 1차 읽기 뒤 같은 크기의 파일 변조를 최종 SHA로 거부한다", async () => {
    const before = rows();
    const actual = state.store!.originalForVentureInput.bind(state.store!);
    vi.spyOn(state.store!, "originalForVentureInput").mockImplementationOnce((...args) => {
      const original = actual(...args);
      writeFileSync(filePath(), Buffer.alloc(originalBytes.length, 0x42));
      return original;
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PACKAGE_ORIGINAL_CHANGED");
    expect(rows()).toEqual(before);
  });

  it("원본 읽기 중 기업 revision 변경은 결과 전체를 폐기한다", async () => {
    const actual = state.store!.originalForVentureInput.bind(state.store!);
    vi.spyOn(state.store!, "originalForVentureInput").mockImplementationOnce((...args) => {
      const original = actual(...args);
      company = state.store!.mutate(
        company.id,
        {
          action: "profile",
          revision: company.revision,
          profile: { ...company.profile, customers: "동시 입력 수정" },
        },
        () => [],
      );
      return original;
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PACKAGE_SNAPSHOT_CHANGED");
    expect(state.store!.get(company.id)).toEqual(company);
  });

  it("revision이 같아도 원본 메타나 계획 내용이 변경되면 결과를 폐기한다", async () => {
    const actual = state.store!.originalForVentureInput.bind(state.store!);
    vi.spyOn(state.store!, "originalForVentureInput").mockImplementationOnce((...args) => {
      const original = actual(...args);
      replaceBody({
        ...company,
        sources: company.sources.map((source) =>
          source.id === included.id
            ? { ...source, updatedAt: "2099-01-01T00:00:00Z", name: "동시 원본 메타 변경" }
            : source,
        ),
      });
      return original;
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PACKAGE_SNAPSHOT_CHANGED");
  });

  it.each(["removed", "hardlink"])(
    "원본이 %s 상태이면 안전 reader가 다운로드를 거부한다",
    async (kind) => {
      const before = rows();
      if (kind === "hardlink") linkSync(filePath(), join(directory, "synthetic-original-link.bin"));
      else unlinkSync(filePath());
      const response = await post();
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("PACKAGE_ORIGINAL_UNAVAILABLE");
      expect(rows()).toEqual(before);
    },
  );

  it.each(["../outside.pdf", "C:\\private.pdf", "file.pdf\u0000", ".."])(
    "위험한 원본명 %s를 ZIP 메타에 직렬화하지 않는다",
    async (originalName) => {
      replaceBody({
        ...company,
        sources: company.sources.map((source) =>
          source.id === included.id ? { ...source, originalName } : source,
        ),
      });
      const before = rows();
      const response = await post();
      expect(response.status).toBe(409);
      const payload = await response.json();
      expect(payload.code).toBe("PACKAGE_ORIGINAL_UNAVAILABLE");
      expect(payload.error).not.toContain(originalName);
      expect(rows()).toEqual(before);
    },
  );

  it("12 MiB 초과 실제 원본을 읽지 않고 결과를 거부한다", async () => {
    writeFileSync(filePath(), Buffer.alloc(packageLimits.originalBytes + 1));
    const before = rows();
    const response = await post();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PACKAGE_ORIGINAL_UNAVAILABLE");
    expect(rows()).toEqual(before);
  });

  it("실제 원본 합계가 24 MiB를 넘으면 선택본 일부도 반환하지 않는다", async () => {
    const large = Buffer.alloc(12 * 1024 * 1024, 0x41);
    const one = addOriginal(
      { originalName: "one.bin", mimeType: "application/octet-stream" },
      large,
    );
    const two = addOriginal(
      { originalName: "two.bin", mimeType: "application/octet-stream" },
      large,
    );
    const before = rows();
    const response = await post(body({ sourceIds: [one.id, two.id, included.id] }));
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("PACKAGE_TOTAL_LIMIT");
    expect(rows()).toEqual(before);
  });

  it("오류 뒤 작업 제한이 해제되어 수정된 요청의 다운로드가 가능하다", async () => {
    expect((await post(body({ planId: randomUUID() }))).status).toBe(404);
    const pack = await unpack(await post());
    expect(pack.manifest.plan.id).toBe(selectedPlan.id);
  });

  it.each(["company", "original"])(
    "ZIP 비동기 생성 중 실제 %s 변경은 최종검사에서 다운로드를 취소한다",
    async (kind) => {
      const original = JSZip.prototype.generateAsync;
      vi.spyOn(JSZip.prototype, "generateAsync").mockImplementationOnce(async function (
        this: JSZip,
        ...args
      ) {
        const zipped = await original.apply(this, args);
        if (kind === "company") {
          company = state.store!.mutate(
            company.id,
            {
              action: "profile",
              revision: company.revision,
              profile: { ...company.profile, customers: "ZIP 생성 중 변경한 합성 입력" },
            },
            () => [],
          );
        } else {
          writeFileSync(filePath(), Buffer.alloc(originalBytes.length, 0x43));
        }
        return zipped;
      });
      const before = rows();
      const response = await post();
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(
        kind === "company" ? "PACKAGE_SNAPSHOT_CHANGED" : "PACKAGE_ORIGINAL_CHANGED",
      );
      if (kind === "original") expect(rows()).toEqual(before);
      else expect(state.store!.get(company.id)).toEqual(company);
    },
  );
});

describe("제출 준비 ZIP API의 경계", () => {
  it.each([
    ["missing revision", { revision: undefined }],
    ["negative revision", { revision: -1 }],
    ["fraction revision", { revision: 1.5 }],
    ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing plan", { planId: undefined }],
    ["invalid plan", { planId: "invalid" }],
    ["invalid source", { sourceIds: ["invalid"] }],
    ["missing sources", { sourceIds: undefined }],
    ["too many originals", { sourceIds: Array.from({ length: 11 }, () => randomUUID()) }],
    ["user path", { path: "C:\\private" }],
    ["user text", { text: "forged package body" }],
    ["user scope", { scope: "submitted" }],
    ["external mode", { mode: "ai" }],
  ])("%s 요청을 엄격히 거부하고 DB를 바꾸지 않는다", async (_label, invalid) => {
    const before = rows();
    const response = await post(body(invalid));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_INPUT");
    expect(rows()).toEqual(before);
  });

  it("동일 원본 중복 선택을 거부한다", async () => {
    const response = await post(body({ sourceIds: [included.id, included.id] }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_INPUT");
  });

  it.each([
    ["origin", { origin: "https://example.com" }],
    ["fetch-site", { "sec-fetch-site": "cross-site" }],
    ["host", { host: "example.com" }],
    ["forwarded-host", { "x-forwarded-host": "example.com" }],
  ])("외부 %s 요청은 원본을 읽기 전에 차단한다", async (_label, headers) => {
    const reader = vi.spyOn(state.store!, "originalForVentureInput");
    const before = rows();
    const response = await POST(request(body(), headers as Record<string, string>), context());
    expect(response.status).toBe(403);
    expect(reader).not.toHaveBeenCalled();
    expect(rows()).toEqual(before);
  });

  it("query를 허용하지 않는다", async () => {
    const response = await POST(request(body(), {}, "?include=all"), context());
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_QUERY");
  });

  it.each(["missing", "invalid"])("%s 회사는 조회하지 않는다", async (kind) => {
    const response = await post(body(), kind === "missing" ? randomUUID() : "invalid");
    expect(response.status).toBe(kind === "missing" ? 404 : 400);
  });

  it.each(["content-type", "json", "body", "declared-body"])(
    "%s 제한 위반을 차단한다",
    async (kind) => {
      const before = rows();
      const req = new Request(`http://127.0.0.1:3000/api/studio/cases/${company.id}/package`, {
        method: "POST",
        headers: {
          "content-type": kind === "content-type" ? "text/plain" : "application/json",
          ...(kind === "declared-body" ? { "content-length": "5000" } : {}),
        },
        body:
          kind === "json"
            ? "{"
            : JSON.stringify(kind === "body" ? { ...body(), extra: "x".repeat(5000) } : body()),
      });
      const response = await POST(req, context());
      expect(response.status).toBe(kind === "content-type" ? 415 : kind === "json" ? 400 : 413);
      expect(rows()).toEqual(before);
    },
  );
});
