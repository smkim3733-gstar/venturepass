import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  type BusinessPlan,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import type { VisitAnswer, VisitAnswerInput } from "./studio-visit-answer-types";
import {
  VISIT_PACKAGE_DOWNLOAD_NAME,
  visitPackageLimits,
  type VisitPackageManifest,
} from "./studio-visit-package-types";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  external: vi.fn(() => {
    throw new Error("No external operation is allowed in synthetic package tests");
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
vi.mock("@/lib/venturein-runner", () => ({
  startVentureSession: state.external,
  stopVentureSession: state.external,
  inspectVentureApplication: state.external,
  fillVentureApplication: state.external,
}));
import { POST } from "@/app/api/studio/cases/[caseId]/visit-package/route";
import { POST as legacyPackage } from "@/app/api/studio/cases/[caseId]/package/route";

let directory: string;
let company: StudioCase;
let foreign: StudioCase;
let included: SourceDocument;
let unrelated: SourceDocument;
let selectedPlan: BusinessPlan;
let selectedAnswer: VisitAnswer;
let unselectedAnswer: VisitAnswer;
let linkedAnswer: VisitAnswer;
let foreignAnswer: VisitAnswer;
let submissionId: string;
let baseline: ReturnType<typeof databaseRows>;
const bytes = Buffer.from("%PDF-1.7\nSYNTHETIC VISIT ORIGINAL\n%%EOF");
const quote = "원문에 등록한 합성 근거입니다.";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const store = () => state.store!;
function databaseRows() {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    return ["studio_cases", "venture_accounts", "venture_workflows"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    );
  } finally {
    db.close();
  }
}
function fixtureBody(record: StudioCase) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(record), record.id);
  } finally {
    db.close();
  }
  return store().get(record.id);
}
function addOriginal(record: StudioCase, overrides: Partial<SourceDocument> = {}, content = bytes) {
  const now = new Date().toISOString();
  const source: SourceDocument = {
    id: randomUUID(),
    name: "합성 실사 근거",
    kind: "technology",
    text: quote,
    originalName: "synthetic.pdf",
    mimeType: "application/pdf",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const next = store().addUpload(record.id, record.revision, source, content);
  return { company: next, source: next.sources.find((item) => item.id === source.id)! };
}
function plan(record: StudioCase): BusinessPlan {
  return {
    id: randomUUID(),
    version: 1,
    generatedAt: "2026-09-25T00:00:00.000Z",
    mode: "manual",
    candidateId: "synthetic",
    sourceRevision: record.sources.length,
    confirmedAt: null,
    review: [],
    content: {
      title: "실사 합성 원고",
      summary: "저장한 설명",
      sections: [
        {
          key: "solution",
          title: "합성 기술",
          content: "현장 검증 전인 합성 설명",
          evidence: record.sources.length
            ? [{ sourceId: record.sources[0].id, quote, locator: "합성 1쪽" }]
            : [],
          needsConfirmation: true,
        },
      ],
      actionItems: ["담당자 대조"],
      interviewQuestions: ["어떤 근거를 준비했나요?", "현재 확인할 사항은 무엇인가요?"],
    },
  };
}
function answerInput(
  record: StudioCase,
  overrides: Partial<VisitAnswerInput> = {},
): VisitAnswerInput {
  const source = record.sources[0];
  return {
    answerId: null,
    previousVersionId: null,
    planId: record.plans[0].id,
    questionIndex: 0,
    questionText: record.plans[0].content.interviewQuestions[0],
    submissionRecordId: null,
    respondentRole: "technical",
    respondentName: "합성 기술 담당자",
    answerText: "담당자가 확인할 합성 답변",
    pairs: source
      ? [
          {
            id: randomUUID(),
            answerQuote: "합성 답변",
            planReference: null,
            sources: [
              {
                sourceId: source.id,
                sourceUpdatedAt: source.updatedAt,
                quote,
                locator: "합성 1쪽",
              },
            ],
            contextNote: "실제 확인 전",
          },
        ]
      : [],
    followUpNote: "후속 검토 필요",
    review: { reviewed: false, reviewer: "", note: "" },
    ...overrides,
  };
}
function saveAnswer(record: StudioCase, input = answerInput(record)) {
  return store().mutate(
    record.id,
    {
      action: "append-visit-answer",
      revision: record.revision,
      clientRequestId: randomUUID(),
      answer: input,
    },
    () => [],
  );
}
const payload = (overrides: Record<string, unknown> = {}) => ({
  revision: company.revision,
  mode: "draft",
  planId: selectedPlan.id,
  submissionRecordId: null,
  answerVersionIds: [selectedAnswer.id],
  sourceIds: [included.id],
  ...overrides,
});
function request(
  input: unknown = payload(),
  headers: Record<string, string> = {},
  suffix = "",
  caseId = company.id,
) {
  return new Request(`http://127.0.0.1:3000/api/studio/cases/${caseId}/visit-package${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
}
const post = (
  input: unknown = payload(),
  headers: Record<string, string> = {},
  suffix = "",
  caseId = company.id,
) => POST(request(input, headers, suffix, caseId), { params: Promise.resolve({ caseId }) });
const originalPath = () => join(directory, "originals", company.id, `${included.id}.bin`);
async function unpack(response: Response) {
  expect(response.status).toBe(200);
  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.keys(zip.files).filter((path) => !zip.files[path].dir);
  const combined = (
    await Promise.all(
      entries
        .filter((path) => !path.startsWith("originals/"))
        .map((path) => zip.file(path)!.async("string")),
    )
  ).join("\n");
  return {
    zip,
    entries,
    buffer,
    combined,
    manifest: JSON.parse(await zip.file("manifest.json")!.async("string")) as VisitPackageManifest,
  };
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-visit-package-test-"));
  state.store = new StudioStore(directory);
  company = store().create({
    ...emptyProfile(),
    companyName: "합성 실사 묶음 회사",
    financials: "PRIVATE_PROFILE_EXCLUDED",
  });
  const first = addOriginal(company);
  company = first.company;
  included = first.source;
  const other = addOriginal(
    company,
    {
      name: "PRIVATE_UNRELATED_SOURCE",
      text: "PRIVATE_UNRELATED_BODY",
      originalName: "private.txt",
      mimeType: "text/plain",
    },
    Buffer.from("PRIVATE_UNRELATED_ORIGINAL"),
  );
  company = other.company;
  unrelated = other.source;
  company.plans = [plan(company)];
  company = fixtureBody(company);
  selectedPlan = company.plans[0];
  company = saveAnswer(company);
  selectedAnswer = company.visitAnswers.at(-1)!;
  company = saveAnswer(
    company,
    answerInput(company, {
      answerId: selectedAnswer.answerId,
      previousVersionId: selectedAnswer.id,
      answerText: "PRIVATE_UNSELECTED_ANSWER 合成답변",
      pairs: [],
      followUpNote: "PRIVATE_UNSELECTED_FOLLOWUP",
    }),
  );
  unselectedAnswer = company.visitAnswers.at(-1)!;
  company = store().mutate(
    company.id,
    {
      action: "create-application",
      revision: company.revision,
      clientRequestId: randomUUID(),
      title: "합성 신청회차",
      kind: "new",
      plannedOn: "",
      criteriaNote: "",
      previousApplicationId: null,
    },
    () => [],
  );
  company = store().mutate(
    company.id,
    {
      action: "record-application-submission",
      revision: company.revision,
      clientRequestId: randomUUID(),
      applicationId: company.applications[0].id,
      planId: selectedPlan.id,
      sourceIds: [included.id],
      taskIds: [],
      receiptRecordId: null,
      occurredOn: "2026-09-25",
      recordedBy: "합성 기록자",
      note: "실제 제출 아님",
    },
    () => [],
  );
  submissionId = company.applicationEvents.at(-1)!.id;
  company = saveAnswer(
    company,
    answerInput(company, {
      submissionRecordId: submissionId,
      questionIndex: 1,
      questionText: company.plans[0].content.interviewQuestions[1],
    }),
  );
  linkedAnswer = company.visitAnswers.at(-1)!;
  foreign = store().create({ ...emptyProfile(), companyName: "FOREIGN_COMPANY" });
  const foreignUpload = addOriginal(foreign, { name: "FOREIGN_SOURCE" });
  foreign = foreignUpload.company;
  foreign.plans = [plan(foreign)];
  foreign = fixtureBody(foreign);
  foreign = saveAnswer(foreign);
  foreignAnswer = foreign.visitAnswers.at(-1)!;
  store().saveVentureAccountEnvelope(
    company.id,
    0,
    Buffer.from("PRIVATE_ACCOUNT_CIPHERTEXT"),
    "PRIVATE_ACCOUNT_MASK",
  );
  store().saveVentureWorkflowEnvelope(
    company.id,
    0,
    JSON.stringify({ private: "PRIVATE_OFFICIAL_WORKFLOW" }),
  );
  vi.stubEnv("OPENAI_API_KEY", "PRIVATE_API_KEY_EXCLUDED");
  baseline = databaseRows();
}, 30_000);
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
  expect(databaseRows()).toEqual(baseline);
  expect(readFileSync(originalPath())).toEqual(bytes);
  vi.restoreAllMocks();
});
afterAll(() => {
  store().close();
  vi.unstubAllEnvs();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (
    isAbsolute(boundary) ||
    boundary.startsWith("..") ||
    !boundary.startsWith("venture-visit-package-test-")
  )
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("실사 준비 ZIP 실제 SQLite/API", { timeout: 20_000 }, () => {
  it("exports exact historical answer and original, preserves all DB rows, and excludes unrelated/private material", async () => {
    const response = await post();
    expect(response.headers.get("content-type")).toContain("application/zip");
    expect(response.headers.get("content-disposition")).toContain(VISIT_PACKAGE_DOWNLOAD_NAME);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const pack = await unpack(response);
    expect(Number(response.headers.get("content-length"))).toBe(pack.buffer.length);
    expect(pack.manifest).toMatchObject({
      scope: "local-visit-preparation-only",
      draft: true,
      caseId: company.id,
      caseRevision: company.revision,
      selection: { answerVersionIds: [selectedAnswer.id] },
      answers: [{ id: selectedAnswer.id, version: 1, reviewedAt: null }],
      submission: null,
    });
    expect(pack.entries.sort()).toEqual(
      [
        "README.md",
        "plan.json",
        "plan.md",
        "answers.json",
        "answers.md",
        "pending.md",
        "manifest.json",
        "manifest.md",
        `originals/${included.id}.pdf`,
      ].sort(),
    );
    expect(await pack.zip.file(pack.manifest.originals[0].path)!.async("nodebuffer")).toEqual(
      bytes,
    );
    expect(pack.manifest.originals[0]).toMatchObject({
      sourceId: included.id,
      comparison: "saved-reference",
      sha256: sha(bytes),
      sizeBytes: bytes.length,
    });
    expect(pack.combined).toContain("담당자가 확인할 합성 답변");
    expect(pack.combined).toContain("DRAFT");
    expect(pack.combined).toContain("기관의 실제 질문");
    for (const forbidden of [
      directory,
      "PRIVATE_PROFILE_EXCLUDED",
      "PRIVATE_UNRELATED_SOURCE",
      "PRIVATE_UNRELATED_BODY",
      "PRIVATE_UNRELATED_ORIGINAL",
      "PRIVATE_UNSELECTED_ANSWER",
      "PRIVATE_UNSELECTED_FOLLOWUP",
      "PRIVATE_ACCOUNT_CIPHERTEXT",
      "PRIVATE_ACCOUNT_MASK",
      "PRIVATE_OFFICIAL_WORKFLOW",
      "PRIVATE_API_KEY_EXCLUDED",
      "FOREIGN_COMPANY",
      "FOREIGN_SOURCE",
    ])
      expect(pack.combined).not.toContain(forbidden);
  });
  it("allows question-only output with zero original reads and no automatic latest answer selection", async () => {
    const reader = vi.spyOn(store(), "originalForVentureInput");
    const pack = await unpack(await post(payload({ answerVersionIds: [], sourceIds: [] })));
    expect(pack.manifest.answers).toEqual([]);
    expect(pack.manifest.originals).toEqual([]);
    expect(pack.combined).toContain("선택한 저장 답변 없음");
    expect(pack.combined).not.toContain(selectedAnswer.answerText);
    expect(reader).not.toHaveBeenCalled();
  });
  it("reads only explicitly selected originals and lists linked but excluded original metadata", async () => {
    const reader = vi.spyOn(store(), "originalForVentureInput");
    const pack = await unpack(await post(payload({ sourceIds: [] })));
    expect(pack.combined).toContain('"included": false');
    expect(pack.entries.some((path) => path.startsWith("originals/"))).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });
  it("binds the exact manual submission record without claiming official verification", async () => {
    const pack = await unpack(
      await post(
        payload({
          mode: "recorded-submission",
          submissionRecordId: submissionId,
          answerVersionIds: [linkedAnswer.id],
        }),
      ),
    );
    expect(pack.manifest.submission).toMatchObject({
      id: submissionId,
      officialVerification: "unverified",
    });
    expect(pack.manifest.answers[0].submissionRecordId).toBe(submissionId);
    expect(pack.combined).toContain("실제 제출 아님");
    expect(pack.combined).toContain("DRAFT");
  });
  it.each(["plan", "answer", "source", "submission"])(
    "rejects foreign or absent %s before reading originals",
    async (kind) => {
      const overrides =
        kind === "plan"
          ? { planId: foreign.plans[0].id }
          : kind === "answer"
            ? { answerVersionIds: [foreignAnswer.id] }
            : kind === "source"
              ? { sourceIds: [foreign.sources[0].id] }
              : { mode: "recorded-submission", submissionRecordId: randomUUID() };
      const reader = vi.spyOn(store(), "originalForVentureInput");
      const response = await post(payload(overrides));
      expect([404, 422]).toContain(response.status);
      expect(response.headers.get("content-type")).not.toContain("application/zip");
      expect(JSON.stringify(await response.json())).not.toMatch(/FOREIGN_|\.bin|originals[\\/]/);
      expect(reader).not.toHaveBeenCalled();
    },
  );
  it("rejects an unrelated same-company original instead of silently including all documents", async () => {
    const reader = vi.spyOn(store(), "originalForVentureInput");
    const response = await post(payload({ sourceIds: [unrelated.id] }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VISIT_PACKAGE_SOURCE_NOT_SELECTED" });
    expect(reader).not.toHaveBeenCalled();
  });
  it("rejects stale CAS and leaves previously stored answers and submission snapshots unchanged", async () => {
    const response = await post(payload({ revision: company.revision - 1 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_REVISION" });
  });
  it("rejects draft mode with a submission-bound answer", async () => {
    const response = await post(payload({ answerVersionIds: [linkedAnswer.id] }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "VISIT_PACKAGE_SUBMISSION_MISMATCH" });
  });
  it("does not combine two versions of the same answer root", async () => {
    const response = await post(
      payload({ answerVersionIds: [selectedAnswer.id, unselectedAnswer.id] }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VISIT_PACKAGE_ANSWER_ROOT_DUPLICATE" });
  });
  it.each([
    ["extra-key", { extra: true }],
    ["duplicate-answer", () => ({ answerVersionIds: [selectedAnswer.id, selectedAnswer.id] })],
    ["duplicate-source", () => ({ sourceIds: [included.id, included.id] })],
    ["non-uuid", { planId: "not-a-uuid" }],
    ["mode", { mode: "official" }],
    ["draft-submission", () => ({ submissionRecordId: submissionId })],
    ["missing-submission", { mode: "recorded-submission" }],
    ["answer-limit", { answerVersionIds: Array.from({ length: 21 }, () => randomUUID()) }],
    ["source-limit", { sourceIds: Array.from({ length: 11 }, () => randomUUID()) }],
    ["negative-revision", { revision: -1 }],
  ] as const)("rejects strict request %s", async (_name, raw) => {
    const response = await post(payload(typeof raw === "function" ? raw() : raw));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
  });
  it.each([
    ["origin", { origin: "https://other.invalid" }, "", 403, "CROSS_ORIGIN"],
    ["fetch-site", { "sec-fetch-site": "cross-site" }, "", 403, "CROSS_ORIGIN"],
    ["host", { host: "other.invalid:3000" }, "", 403, "LOCAL_ONLY"],
    ["content-type", { "content-type": "text/plain" }, "", 415, "CONTENT_TYPE"],
    ["query", {}, "?all=true", 400, "INVALID_QUERY"],
    ["declared-length", { "content-length": "8193" }, "", 413, "TOO_LARGE"],
  ] as const)("rejects %s transport boundary", async (_name, headers, suffix, status, code) => {
    const response = await post(payload(), headers as Record<string, string>, suffix);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });
  it("enforces actual streamed body length without trusting a small Content-Length", async () => {
    const response = await post(payload({ padding: "x".repeat(visitPackageLimits.requestBytes) }), {
      "content-length": "1",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "TOO_LARGE" });
  });
  it("reports malformed JSON and invalid case IDs as bounded JSON errors", async () => {
    const response = await POST(
      new Request(`http://127.0.0.1:3000/api/studio/cases/${company.id}/visit-package`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      { params: Promise.resolve({ caseId: company.id }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_JSON" });
    expect((await post(payload(), {}, "", "invalid-case")).status).toBe(400);
  });
  it("rejects same-size changed original bytes against the saved answer/submission hashes", async () => {
    const altered = Buffer.from(bytes);
    altered[altered.length - 1] ^= 1;
    try {
      writeFileSync(originalPath(), altered);
      const response = await post();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "VISIT_PACKAGE_HISTORICAL_ORIGINAL_CHANGED",
      });
    } finally {
      writeFileSync(originalPath(), bytes);
    }
  });
  it("rejects a linked original with multiple hardlinks through the real safe reader", async () => {
    const alias = join(directory, "synthetic-hardlink.bin");
    try {
      linkSync(originalPath(), alias);
      const response = await post();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "PACKAGE_ORIGINAL_UNAVAILABLE" });
    } finally {
      unlinkSync(alias);
    }
  });
  it("preserves legacy /package behavior and does not add visit answers to it", async () => {
    const response = await legacyPackage(
      new Request(`http://127.0.0.1:3000/api/studio/cases/${company.id}/package`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: company.revision,
          planId: selectedPlan.id,
          sourceIds: [],
        }),
      }),
      { params: Promise.resolve({ caseId: company.id }) },
    );
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(zip.file("answers.json")).toBeNull();
    expect(zip.file("plan.md")).not.toBeNull();
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.scope).toBe("local-preparation-only");
    expect(manifest.plan.id).toBe(selectedPlan.id);
  });
});
