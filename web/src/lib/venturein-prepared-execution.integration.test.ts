import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, type StudioCase } from "./studio-schema";
import type { VentureSessionStatus } from "./venturein-schema";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  session: null as VentureSessionStatus | null,
  fill: vi.fn(),
  compare: vi.fn(),
  inspect: vi.fn(),
  external: vi.fn(() => {
    throw new Error("External calls are forbidden");
  }),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-vault", () => ({ getVentureAccountStatus: () => ({ revision: 1 }) }));
vi.mock("@/lib/venturein-runner", () => ({
  getVentureSession: () => state.session!,
  fillVentureApplication: state.fill,
  compareVentureApplication: state.compare,
  inspectVentureApplication: state.inspect,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.external();
    }
  },
}));

import { POST } from "@/app/api/studio/cases/[caseId]/venturein/workflow/execution/route";
import { preservePreparedPackage } from "./studio-prepared-package";
import { getVentureWorkflow } from "./venturein-workflow";
import { inspectDatabase } from "../../scripts/local-data-store.mjs";

let directory: string, company: StudioCase;
const post = (body: unknown) =>
  POST(
    new Request(
      `http://localhost:3000/api/studio/cases/${company.id}/venturein/workflow/execution`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ caseId: company.id }) },
  );
const versions = () => ({
  revision: state.store!.getVentureWorkflowEnvelope(company.id).revision,
  companyRevision: company.revision,
  accountRevision: 1,
});
const preserve = async () =>
  (
    await preservePreparedPackage(state.store!, company.id, {
      revision: company.revision,
      planId: company.plans[0].id,
      sourceIds: [],
      clientRequestId: randomUUID(),
    })
  ).package;
const prepare = async (preparedPackageId: string) => {
  const response = await post({ action: "prepare", ...versions(), preparedPackageId });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.review;
};
const execute = (token: string) => post({ action: "execute", token, approved: true });
function corruptArchive(packageId: string) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_prepared_packages SET archive=? WHERE case_id=? AND id=?").run(
      Buffer.from("SYNTHETIC CORRUPT ARCHIVE"),
      company.id,
      packageId,
    );
  } finally {
    db.close();
  }
}

beforeEach(() => {
  state.fill.mockReset();
  state.compare.mockReset();
  state.inspect.mockReset();
  state.external.mockClear();
  directory = mkdtempSync(join(tmpdir(), "venture-prepared-execution-"));
  state.store = new StudioStore(directory);
  company = state.store.create({
    ...emptyProfile(),
    companyName: "준비본 실행 합성기업",
    businessNumber: "1234567890",
    technologySummary: "합성 기술 설명",
  });
  company = state.store.saveAnalysis(
    company.id,
    company.revision,
    {
      summary: "합성 분석",
      facts: [],
      questions: [],
      warnings: [],
      candidates: [
        {
          id: "synthetic",
          title: "합성 아이디어",
          problem: "합성 문제",
          solution: "합성 해결",
          targetCustomer: "가상 고객",
          differentiation: "검토 필요",
          stage: "준비 중",
          businessModel: "계획",
          recommendation: "시험",
          evidence: [],
          gaps: [],
        },
      ],
    },
    "assisted",
  );
  company = state.store.mutate(
    company.id,
    {
      action: "select-candidate",
      revision: company.revision,
      clientRequestId: randomUUID(),
      candidateId: "synthetic",
      analysisGeneratedAt: company.analysis!.generatedAt,
      analysisSourceRevision: company.analysis!.sourceRevision,
      expectedSelectedCandidateId: null,
      reason: "합성 연결 시험",
    },
    () => [],
  );
  company = state.store.saveGeneratedPlan(
    company.id,
    company.revision,
    "synthetic",
    {
      title: "합성 원고",
      summary: "합성 요약",
      sections: [
        {
          key: "solution",
          title: "해결",
          content: "합성 본문",
          needsConfirmation: true,
          evidence: [],
        },
      ],
      actionItems: [],
      interviewQuestions: [],
    },
    [],
    "assisted",
  );
  const now = new Date().toISOString(),
    snapshotId = randomUUID();
  state.session = {
    state: "connected_unmapped",
    message: "합성 로그인",
    startedAt: now,
    updatedAt: now,
  };
  state.store.saveVentureWorkflowEnvelope(
    company.id,
    0,
    JSON.stringify({
      snapshot: {
        caseId: company.id,
        sessionStartedAt: now,
        accountRevision: 1,
        screen: {
          id: snapshotId,
          observedAt: now,
          url: "https://www.smes.go.kr/venturein/aply/v2",
          title: "합성 신청서",
          truncated: false,
          warnings: [],
          companyEvidence: [
            {
              kind: "businessNumber",
              label: "사업자등록번호",
              value: "1234567890",
              source: "table",
            },
          ],
          fields: ["company", "technology"].map((key) => ({
            key,
            id: key,
            name: key,
            kind: "input",
            type: "text",
            labels: [key],
            required: true,
            maxLength: 200,
            accept: null,
            multiple: false,
            disabled: false,
            readOnly: false,
            options: [],
          })),
        },
      },
      draft: {
        caseId: company.id,
        snapshotId,
        sessionStartedAt: now,
        accountRevision: 1,
        companyRevision: company.revision,
        planId: company.plans[0].id,
        planVersion: 1,
        textMappings: [
          {
            fieldKey: "company",
            source: { kind: "profile", property: "companyName" },
            confirmed: true,
          },
          {
            fieldKey: "technology",
            source: { kind: "profile", property: "technologySummary" },
            confirmed: true,
          },
        ],
        attachmentMappings: [],
      },
    }),
  );
  state.fill.mockImplementation(async (_caseId, input, assertCurrent) => {
    assertCurrent();
    const fields = input.fields.map((field: { fieldKey: string }) => field.fieldKey);
    return {
      status: "completed",
      completedFieldKeys: fields,
      touchedFieldKeys: fields,
      attemptedFieldKey: null,
      code: null,
    };
  });
});
afterEach(() => {
  expect(state.external).not.toHaveBeenCalled();
  expect(state.inspect).not.toHaveBeenCalled();
  expect(state.compare).not.toHaveBeenCalled();
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-prepared-execution-") || boundary.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("실제 로컬 준비본에서 승인·실행 기록까지 연결", () => {
  it("앱이 실제 생성한 준비본을 회사 백업 검증기가 읽고 ZIP 변조를 거부한다", async () => {
    const record = await preserve();
    const db = new DatabaseSync(join(directory, "studio.sqlite"), { readOnly: true });
    try {
      expect(() => inspectDatabase(db)).not.toThrow();
      corruptArchive(record.id);
      expect(() => inspectDatabase(db)).toThrow();
    } finally {
      db.close();
    }
    expect(state.fill).not.toHaveBeenCalled();
  });

  it("실제 ZIP을 읽는 대조는 승인과 workflow 기록을 만들지 않는다", async () => {
    const record = await preserve(),
      before = state.store!.getVentureWorkflowEnvelope(company.id);
    const response = await post({
      action: "compare-prepared-package",
      ...versions(),
      preparedPackageId: record.id,
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.preparedComparison).toMatchObject({
      caseId: company.id,
      preparedPackage: { id: record.id },
      result: {
        matched: true,
        packageDraft: true,
        binding: { package: { id: record.id, zipSha256: record.zip.sha256 } },
      },
    });
    expect(body).not.toHaveProperty("review");
    expect(state.store!.getVentureWorkflowEnvelope(company.id)).toEqual(before);
    expect(state.fill).not.toHaveBeenCalled();
  });

  it("첫 쓰기 전 v2와 전체 원래 범위를 영속 저장하고 스토어 재시작 후 유지한다", async () => {
    const record = await preserve(),
      review = await prepare(record.id);
    expect(review.preparedPackage.binding.package.id).toBe(record.id);
    expect(review.submissionReady).toBe(false);
    state.fill.mockImplementationOnce(async (_caseId, input, assertCurrent) => {
      assertCurrent();
      const running = getVentureWorkflow(company.id).execution!;
      expect(running).toMatchObject({
        status: "running",
        manifest: {
          version: 2,
          preparedPackage: review.preparedPackage,
          targets: [
            { fieldKey: "company", kind: "text" },
            { fieldKey: "technology", kind: "text" },
          ],
        },
      });
      const fields = input.fields.map((field: { fieldKey: string }) => field.fieldKey);
      return {
        status: "completed",
        completedFieldKeys: fields,
        touchedFieldKeys: fields,
        attemptedFieldKey: null,
        code: null,
      };
    });
    expect((await execute(review.token)).status).toBe(200);
    const completed = getVentureWorkflow(company.id).execution;
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(getVentureWorkflow(company.id).execution).toEqual(completed);
    expect(completed).toMatchObject({
      status: "completed",
      manifest: { version: 2, preparedPackage: review.preparedPackage },
    });
    expect((await execute(review.token)).status).toBe(410);
    expect(state.fill).toHaveBeenCalledTimes(1);
  });

  it.each(["compare-prepared-package", "prepare"])(
    "%s는 ZIP 바이트 변조 시 v1으로 돌아가지 않는다",
    async (action) => {
      const record = await preserve();
      corruptArchive(record.id);
      // Metadata-only retrieval still works; the execution service must verify the BLOB.
      expect(state.store!.getPreparedPackage(company.id, record.id).zip.sha256).toBe(
        record.zip.sha256,
      );
      const response = await post({ action, ...versions(), preparedPackageId: record.id });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "PREPARED_ARCHIVE_CHANGED" });
      expect(getVentureWorkflow(company.id).execution).toBeNull();
      expect(state.fill).not.toHaveBeenCalled();
    },
  );

  it("승인 이후 ZIP 변조는 쓰기 전에 차단하고 승인 token도 재사용하지 못한다", async () => {
    const record = await preserve(),
      review = await prepare(record.id);
    corruptArchive(record.id);
    expect((await execute(review.token)).status).toBe(409);
    expect((await execute(review.token)).status).toBe(410);
    expect(getVentureWorkflow(company.id).execution).toBeNull();
    expect(state.fill).not.toHaveBeenCalled();
  });

  it("서로 다른 준비본 선택은 이전 승인 token을 되살리거나 합치지 않는다", async () => {
    const first = await preserve(),
      oldReview = await prepare(first.id);
    const second = await preserve(),
      latestReview = await prepare(second.id);
    expect(first.id).not.toBe(second.id);
    expect(oldReview.preparedPackage.digest).not.toBe(latestReview.preparedPackage.digest);
    expect((await execute(oldReview.token)).status).toBe(410);
    expect((await execute(latestReview.token)).status).toBe(200);
    expect(getVentureWorkflow(company.id).execution?.manifest).toMatchObject({
      version: 2,
      preparedPackage: { binding: { package: { id: second.id } } },
    });
    expect(state.fill).toHaveBeenCalledTimes(1);
  });
});
