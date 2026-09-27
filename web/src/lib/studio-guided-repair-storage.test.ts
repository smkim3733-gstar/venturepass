import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { guidedPreparationApproval } from "./studio-guided-preparation-state";
import {
  emptyProfile,
  sectionDefinitions,
  type Candidate,
  type PlanContent,
  type ReviewFinding,
  type StudioCase,
} from "./studio-schema";

vi.mock("server-only", () => ({}));

const candidate: Candidate = {
  id: "synthetic-storage-topic",
  classification: "current",
  title: "합성 시험 기술",
  problem: "실험 결과의 정리가 필요합니다.",
  solution: "합성 센서 데이터를 정리하는 기술을 개발 중입니다.",
  targetCustomer: "가상 시험 고객",
  differentiation: "성능 검증이 필요합니다.",
  stage: "개발 중",
  businessModel: "검토 계획",
  recommendation: "입력한 설명을 근거로 검토할 주제입니다.",
  evidence: [
    {
      sourceId: "profile",
      quote: "합성 센서 데이터를 정리하는 기술을 개발 중입니다.",
      locator: "technologySummary",
    },
  ],
  gaps: ["실험 자료 확인 필요"],
};
const content = (): PlanContent => ({
  title: "합성 시험 계획서",
  summary: "원자료를 추가 확인할 초안입니다.",
  sections: sectionDefinitions.map((definition) => ({
    ...definition,
    content: "합성 센서 데이터를 정리하는 기술을 개발 중입니다. [확인 필요] 실험 자료",
    evidence: candidate.evidence,
    needsConfirmation: true,
  })),
  actionItems: ["실험 자료 확인"],
  interviewQuestions: ["검증 결과가 있나요?"],
});
const finding = (id: string, severity: ReviewFinding["severity"] = "warning"): ReviewFinding => ({
  id,
  severity,
  category: "fact-vs-plan",
  sectionKey: "problem",
  message: "개발 중인 사실과 향후 검증 계획을 구분해야 합니다.",
  action: "개발 상태에 맞게 표현을 확인해 주세요.",
  sourceIds: ["profile"],
});
let directory: string, store: StudioStore, company: StudioCase, runId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-guided-repair-storage-"));
  store = new StudioStore(directory);
  company = store.create({
    ...emptyProfile(),
    companyName: "합성 저장소 시험기업",
    technologySummary: candidate.solution,
  });
  company = store.saveAnalysis(
    company.id,
    company.revision,
    { summary: "합성 분석", facts: [], candidates: [candidate], questions: [], warnings: [] },
    "ai",
  );
  company = store.mutate(
    company.id,
    {
      action: "select-candidate",
      revision: company.revision,
      clientRequestId: randomUUID(),
      candidateId: candidate.id,
      analysisGeneratedAt: company.analysis!.generatedAt,
      analysisSourceRevision: company.analysis!.sourceRevision,
      expectedSelectedCandidateId: company.selectedCandidateId,
      reason: "표시된 근거와 추가 확인할 자료를 검토하여 선택했습니다.",
    },
    () => [],
  );
  const started = store.beginGuidedPreparation(
    company.id,
    {
      action: "start",
      revision: company.revision,
      clientRequestId: randomUUID(),
      approved: true,
      approval: guidedPreparationApproval(company, "synthetic-model"),
    },
    "synthetic-model",
  );
  company = started.company;
  runId = started.run.id;
  company = store.checkpointGuidedPlan(company.id, company.revision, runId, content(), [
    finding("initial"),
  ]);
});
afterEach(() => {
  store.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-guided-repair-storage-") || boundary.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
function attempt() {
  company = store.beginGuidedRepair(company.id, company.revision, runId);
}
function commit(
  status: "applied" | "not-needed" | "failed" | "rejected",
  nextContent = company.plans[0].content,
  review = company.plans[0].review,
) {
  return store.commitGuidedPreparation(company.id, company.revision, runId, {
    phase: "plan",
    content: nextContent,
    review,
    repair: { status, attempted: status !== "not-needed", reason: "합성 회귀 검증" },
  });
}

describe("자동 수정 저장소의 원본·검토 결과 보존", () => {
  it("본문이 같아도 검토만 달라지면 새 버전에 기록하고 초기 검토를 보존한다", () => {
    const initial = structuredClone(company.plans[0]);
    attempt();
    const finalReview = [finding("final-info", "info")];
    const saved = commit("applied", initial.content, finalReview);
    expect(saved.company.plans).toHaveLength(2);
    expect(saved.company.plans.find((plan) => plan.id === initial.id)).toEqual(initial);
    const final = saved.company.plans.find((plan) => plan.id === saved.run.planId)!;
    expect(final.id).not.toBe(initial.id);
    expect(final.version).toBe(initial.version + 1);
    expect(final.content).toEqual(initial.content);
    expect(final.review).toEqual(finalReview);
    expect(saved.run.repair).toMatchObject({
      initialPlanId: initial.id,
      finalPlanId: final.id,
      initialReviewCount: 1,
      finalReviewCount: final.review.filter((item) => item.severity !== "info").length,
      status: "applied",
    });
  });

  it.each(["failed", "rejected", "not-needed"] as const)(
    "%s 결과는 본문 또는 초기 검토를 바꿀 수 없다",
    (status) => {
      if (status !== "not-needed") attempt();
      const before = structuredClone(company);
      const changedContent = structuredClone(company.plans[0].content);
      changedContent.sections[0].content += " 변경된 문장";
      expect(() => commit(status, changedContent)).toThrowError(
        expect.objectContaining({ code: "GUIDED_REPAIR_RESULT" }),
      );
      expect(store.get(company.id)).toEqual(before);
      expect(() => commit(status, company.plans[0].content, [])).toThrowError(
        expect.objectContaining({ code: "GUIDED_REPAIR_RESULT" }),
      );
      expect(store.get(company.id)).toEqual(before);
    },
  );

  it("초기 계획서 연결이 달라지면 수정 시작과 최종 기록을 모두 거부한다", () => {
    attempt();
    const corrupted = structuredClone(company);
    corrupted.guidedPreparationRuns![0].planId = randomUUID();
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(
        JSON.stringify(corrupted),
        company.id,
      );
    } finally {
      db.close();
    }
    expect(() => commit("applied")).toThrowError(
      expect.objectContaining({ code: "GUIDED_REPAIR_RESULT" }),
    );
    expect(store.get(company.id)).toEqual(corrupted);
    // The same corrupted link before an attempt must not authorize repair either.
    corrupted.guidedPreparationRuns![0].repair!.attempted = false;
    corrupted.guidedPreparationRuns![0].repair!.attemptedAt = null;
    const beforeAttemptDb = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      beforeAttemptDb
        .prepare("UPDATE studio_cases SET body=? WHERE id=?")
        .run(JSON.stringify(corrupted), company.id);
    } finally {
      beforeAttemptDb.close();
    }
    expect(() => store.beginGuidedRepair(company.id, company.revision, runId)).toThrowError(
      expect.objectContaining({ code: "GUIDED_REPAIR_CHANGED" }),
    );
    expect(store.get(company.id)).toEqual(corrupted);
  });

  it("수정이 필요 없으면 초기 버전을 그대로 유지하며 검토 개수도 일치한다", () => {
    const initial = structuredClone(company.plans[0]);
    const saved = commit("not-needed");
    expect(saved.company.plans).toEqual([initial]);
    expect(saved.run).toMatchObject({
      status: "awaiting_review",
      planId: initial.id,
      repair: {
        initialPlanId: initial.id,
        finalPlanId: initial.id,
        attempted: false,
        initialReviewCount: 1,
        finalReviewCount: 1,
        status: "not-needed",
      },
    });
  });
});
