import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  type AnalysisContent,
  type PlanContent,
  type StudioCase,
} from "./studio-schema";
import { runLocalPreparation, localPreparationIsRunning } from "./studio-preparation";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

const engine = vi.hoisted(() => ({ analyze: vi.fn(), plan: vi.fn(), review: vi.fn() }));
vi.mock("./studio-engine", () => ({
  analyzeCompany: engine.analyze,
  generatePlan: engine.plan,
  reviewPlan: engine.review,
}));
const analysis: AnalysisContent = {
  summary: "합성 시험 분석",
  facts: [],
  questions: [],
  warnings: [],
  candidates: [
    {
      id: "candidate-1",
      title: "합성 기술",
      problem: "문제",
      solution: "해결",
      targetCustomer: "고객",
      differentiation: "미확인",
      stage: "계획",
      businessModel: "미확인",
      recommendation: "직접 검토",
      evidence: [],
      gaps: [],
    },
  ],
};
const content: PlanContent = {
  title: "합성 원고",
  summary: "검토 전",
  sections: [
    { key: "problem", title: "문제", content: "미확인", evidence: [], needsConfirmation: true },
  ],
  actionItems: [],
  interviewQuestions: [],
};
let directory: string;
let store: StudioStore;
let company: StudioCase;
const start = () => ({
  action: "start" as const,
  revision: company.revision,
  clientRequestId: randomUUID(),
});
function pending<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolvePromise = done;
  });
  return { promise, resolve: resolvePromise };
}
function selectCandidate(current: StudioCase, candidateId: string) {
  return store.mutate(
    current.id,
    {
      action: "select-candidate",
      revision: current.revision,
      clientRequestId: randomUUID(),
      candidateId,
      analysisGeneratedAt: current.analysis!.generatedAt,
      analysisSourceRevision: current.analysis!.sourceRevision,
      expectedSelectedCandidateId: current.selectedCandidateId,
      reason: "합성 시험의 후보를 검토한 뒤 명시적으로 선택합니다.",
    },
    () => [],
  );
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-preparation-unit-"));
  store = new StudioStore(directory);
  company = store.create({
    ...emptyProfile(),
    companyName: "가상 준비기업",
    technologySummary: "PRIVATE_FIXTURE_TECHNOLOGY",
  });
  engine.analyze.mockReset().mockResolvedValue(structuredClone(analysis));
  engine.plan.mockReset().mockResolvedValue(structuredClone(content));
  engine.review.mockReset().mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  const target = resolve(directory);
  if (
    !target.startsWith(resolve(tmpdir()) + "\\venture-preparation-unit-") &&
    !target.startsWith(resolve(tmpdir()) + "/venture-preparation-unit-")
  )
    throw new Error("Unsafe test cleanup");
  rmSync(target, { recursive: true, force: true });
});

describe("local preparation async and transaction boundaries", () => {
  it("keeps a completed diagnosis but discards async analysis after a company CAS change", async () => {
    const work = pending<AnalysisContent>();
    engine.analyze.mockReturnValueOnce(work.promise);
    const execution = runLocalPreparation(store, company.id, start());
    const current = store.get(company.id);
    expect(current.diagnoses).toHaveLength(1);
    store.mutate(
      company.id,
      {
        action: "profile",
        revision: current.revision,
        profile: { ...current.profile, customers: "수정된 합성 고객" },
      },
      () => [],
    );
    work.resolve(analysis);
    await expect(execution).rejects.toMatchObject({ code: "STALE_REVISION", accepted: true });
    const saved = store.get(company.id);
    expect(saved.analysis).toBeNull();
    expect(saved.preparationRuns[0]).toMatchObject({ phase: "analysis", stale: true });
    expect(localPreparationIsRunning(company.id)).toBe(false);
  });

  it("respects an official input lock acquired during local generation and can resume its checkpoint later", async () => {
    const work = pending<AnalysisContent>();
    engine.analyze.mockReturnValueOnce(work.promise);
    const execution = runLocalPreparation(store, company.id, start());
    await withVentureInputCompanyLock(company.id, async () => {
      work.resolve(analysis);
      await expect(execution).rejects.toMatchObject({ code: "INPUT_IN_PROGRESS", accepted: true });
      expect(store.get(company.id).analysis).toBeNull();
    });
    company = store.get(company.id);
    const result = await runLocalPreparation(store, company.id, {
      action: "resume",
      revision: company.revision,
      clientRequestId: randomUUID(),
      runId: company.preparationRuns[0].id,
    });
    expect(result.run.status).toBe("awaiting_choice");
    expect(result.company.diagnoses).toHaveLength(1);
  });

  it("shares the per-company job across a module reload and releases it after completion", async () => {
    const work = pending<AnalysisContent>();
    engine.analyze.mockReturnValueOnce(work.promise);
    const input = start();
    const execution = runLocalPreparation(store, company.id, input);
    vi.resetModules();
    const fresh = await import("./studio-preparation");
    await expect(fresh.runLocalPreparation(store, company.id, input)).rejects.toMatchObject({
      code: "PREPARATION_BUSY",
      accepted: false,
    });
    work.resolve(analysis);
    await execution;
    expect(fresh.localPreparationIsRunning(company.id)).toBe(false);
  });

  it("records fixed failure metadata and resumes only the incomplete phase", async () => {
    engine.analyze.mockRejectedValueOnce(new Error("PRIVATE_ERROR_BODY"));
    const first = await runLocalPreparation(store, company.id, start());
    expect(first.run).toMatchObject({
      status: "failed",
      phase: "analysis",
      code: "PREPARATION_FAILED",
    });
    expect(JSON.stringify(first.run)).not.toContain("PRIVATE_ERROR_BODY");
    const second = await runLocalPreparation(store, company.id, {
      action: "resume",
      revision: first.company.revision,
      clientRequestId: randomUUID(),
      runId: first.run.id,
    });
    expect(second.run.status).toBe("awaiting_choice");
    expect(second.company.diagnoses).toHaveLength(1);
    expect(second.run.steps.map((step) => step.phase)).toEqual(["diagnosis", "analysis"]);
  });

  it("does not repeat a plan committed before its response was lost, including after reopening SQLite", async () => {
    const first = await runLocalPreparation(store, company.id, start());
    const candidate = first.run.candidates[0];
    const selected = selectCandidate(first.company, candidate.id);
    const input = {
      action: "continue" as const,
      revision: selected.revision,
      clientRequestId: randomUUID(),
      runId: first.run.id,
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
    };
    const commit = store.commitPreparation.bind(store);
    const spy = vi.spyOn(store, "commitPreparation").mockImplementation((...args) => {
      const result = commit(...args);
      if (args[3].phase === "plan") throw new Error("response lost");
      return result;
    });
    await expect(runLocalPreparation(store, company.id, input)).rejects.toMatchObject({
      accepted: true,
    });
    spy.mockRestore();
    store.close();
    store = new StudioStore(directory);
    const replay = await runLocalPreparation(store, company.id, input);
    expect(replay.run.status).toBe("awaiting_review");
    expect(replay.company.plans).toHaveLength(1);
    expect(engine.plan).toHaveBeenCalledTimes(1);
    expect(replay.company.plans[0].confirmedAt).toBeNull();
  });

  it("never sends AI mode and persists only hashes and IDs in preparation metadata", async () => {
    const first = await runLocalPreparation(store, company.id, start());
    const candidate = first.run.candidates[0];
    const selected = selectCandidate(first.company, candidate.id);
    const result = await runLocalPreparation(store, company.id, {
      action: "continue",
      revision: selected.revision,
      clientRequestId: randomUUID(),
      runId: first.run.id,
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
    });
    expect(engine.analyze).toHaveBeenCalledWith(expect.anything(), "assisted");
    expect(engine.plan).toHaveBeenCalledWith(expect.anything(), expect.anything(), "assisted");
    expect(JSON.stringify(result.run)).not.toContain("PRIVATE_FIXTURE_TECHNOLOGY");
    expect(
      result.company.plans[0].content.sections.every((section) => section.needsConfirmation),
    ).toBe(true);
  });
});
