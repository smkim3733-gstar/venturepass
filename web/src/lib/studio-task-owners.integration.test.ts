import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile, taskSchema, type StudioCase, type WorkflowTask } from "./studio-schema";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import { summarizeCase } from "./studio-case-summary";
import { analyzeCompany } from "./studio-engine";
import { buildPreparationPackage } from "./studio-package";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  browser: vi.fn(),
  parse: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: state.browser }));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: state.parse };
  },
}));
import { PATCH } from "@/app/api/studio/cases/[caseId]/route";

let directory: string;
let company: StudioCase;
const owners = {
  materials: "SYNTHETIC_MATERIAL_OWNER",
  writing: "SYNTHETIC_WRITING_OWNER",
  review: "SYNTHETIC_REVIEW_OWNER",
};
const emptyOwners = { materials: "", writing: "", review: "" };
function task(changes: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: randomUUID(),
    title: "합성 업무",
    category: "supplement",
    dueDate: "2026-10-03",
    status: "pending",
    notes: "기존 메모 보존",
    ...changes,
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-task-owner-test-"));
  state.store = new StudioStore(directory);
  company = state.store.create({ ...emptyProfile(), companyName: "합성 담당자 검증 회사" });
  state.browser.mockReset();
  state.parse.mockReset();
});
afterEach(() => {
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-task-owner-test-") || boundary.includes(".."))
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  expect(state.browser).not.toHaveBeenCalled();
});
async function patch(body: unknown, caseId = company.id, headers: Record<string, string> = {}) {
  return PATCH(
    new Request(`http://localhost:3000/api/studio/cases/${caseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ caseId }) },
  );
}
async function save(value: WorkflowTask) {
  const response = await patch({ action: "task", revision: company.revision, task: value });
  expect(response.status).toBe(200);
  company = await response.json();
  return company.tasks.find((entry) => entry.id === value.id)!;
}
function appendRequest(previousVersionId?: string) {
  company = state.store!.mutate(
    company.id,
    {
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        ...(previousVersionId
          ? {
              kind: "request-correction" as const,
              requestRecordId: company.agencyRecords[0].id,
              previousVersionId,
            }
          : { kind: "request" as const }),
        institution: "가상 기관",
        title: "가상 요청",
        body: "자료 보완 요청",
        occurredOn: "",
        dueOn: "2026-10-01",
        dueNote: "담당자 기입",
        note: "",
        sourceIds: [],
      },
    },
    () => [],
  );
  return company.agencyRecords.at(-1)!;
}
async function agencyTask(rootId: string, versionId: string) {
  const response = await patch({
    action: "create-agency-task",
    revision: company.revision,
    requestRecordId: rootId,
    requestVersionId: versionId,
  });
  expect(response.status).toBe(200);
  company = await response.json();
  return company.tasks.find((entry) => entry.agencyOrigin?.requestVersionId === versionId)!;
}

function seedTaskPlan() {
  const candidate = {
    id: "task-candidate",
    title: "합성 아이템",
    problem: "문제",
    solution: "해결",
    targetCustomer: "고객",
    differentiation: "검토",
    stage: "구상",
    businessModel: "미확인",
    recommendation: "검토",
    evidence: [],
    gaps: [],
  };
  company = state.store!.saveAnalysis(
    company.id,
    company.revision,
    { summary: "합성", facts: [], candidates: [candidate], questions: [], warnings: [] },
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
      title: "합성 연결 원고",
      summary: "미확인",
      sections: [
        {
          key: "solution",
          title: "해결 방법",
          content: "등록한 계획서의 정확한 설명입니다.",
          evidence: [],
          needsConfirmation: true,
        },
      ],
      actionItems: [],
      interviewQuestions: [],
    },
    [],
    "assisted",
  );
  return { planId: company.plans.at(-1)!.id, sectionKey: "solution", quote: "정확한 설명" };
}

describe("업무 내부 단계와 원고 부분 연결", () => {
  it("같은 회사의 정확한 원고 부분만 연결하고 업무·원고 검토 상태는 보존한다", async () => {
    const reference = seedTaskPlan();
    const beforePlans = structuredClone(company.plans);
    const beforeStage = company.stage;
    const saved = await save(
      task({ owners, processing: { stage: "ready", planRefs: [reference] } }),
    );
    expect(saved.status).toBe("pending");
    expect(saved.processing).toEqual({ stage: "ready", planRefs: [reference] });
    expect(company.plans).toEqual(beforePlans);
    expect(company.stage).toBe(beforeStage);
    const legacyTask = { ...saved };
    delete legacyTask.processing;
    const updated = await save({ ...legacyTask, status: "done" });
    expect(updated.processing).toEqual(saved.processing);
    await save({ ...updated, processing: { stage: "collecting", planRefs: [] } });
    expect(company.tasks[0].processing).toEqual({ stage: "collecting", planRefs: [] });
  });
  it.each(["foreign-plan", "missing-section", "wrong-quote"])(
    "%s 참조는 회사 전체를 변경 없이 거부한다",
    async (scenario) => {
      const reference = seedTaskPlan();
      if (scenario === "foreign-plan") reference.planId = randomUUID();
      if (scenario === "missing-section") reference.sectionKey = "missing";
      if (scenario === "wrong-quote") reference.quote = "등록하지 않은 주장";
      const before = structuredClone(company);
      const response = await patch({
        action: "task",
        revision: company.revision,
        task: task({ processing: { stage: "writing", planRefs: [reference] } }),
      });
      expect(response.status).toBe(409);
      expect(state.store!.get(company.id)).toEqual(before);
    },
  );
  it.each([
    { stage: "submitted", planRefs: [] },
    { stage: "ready", planRefs: [], approved: true },
    null,
  ])("비허용 내부 단계나 승인 필드는 거부한다 %#", async (processing) => {
    const response = await patch({
      action: "task",
      revision: company.revision,
      task: { ...task(), processing },
    });
    expect(response.status).toBe(400);
    expect(state.store!.get(company.id)).toEqual(company);
  });
  it("새 요청 버전 업무에 과거 내부 처리 상태를 복사하지 않는다", async () => {
    const first = appendRequest();
    const original = await agencyTask(first.id, first.id);
    const saved = await save({ ...original, processing: { stage: "ready", planRefs: [] } });
    const corrected = appendRequest(first.id);
    const next = await agencyTask(first.id, corrected.id);
    expect(next.processing).toBeUndefined();
    expect(company.tasks.find((item) => item.id === saved.id)?.processing?.stage).toBe("ready");
  });
});

describe("업무 담당자 구조화와 기존 기록 호환", () => {
  it("기존 업무는 담당자를 추정하지 않고 100자 이름은 공백만 정리한다", () => {
    expect(taskSchema.parse(task())).not.toHaveProperty("owners");
    expect(
      taskSchema.parse(
        task({ owners: { materials: ` ${"가".repeat(100)} `, writing: " ", review: " 확인자 " } }),
      ).owners,
    ).toEqual({ materials: "가".repeat(100), writing: "", review: "확인자" });
  });
  it.each([
    { ...owners, materials: "가".repeat(101) },
    { ...owners, writing: "가".repeat(101) },
    { ...owners, review: "가".repeat(101) },
    { ...owners, review: 5 },
    { ...owners, role: "admin" },
    { materials: "이름" },
    null,
    [],
  ])("API가 초과 길이·다른 타입·권한 키·불완전 구조를 거부한다 %#", async (invalid) => {
    const before = structuredClone(company);
    const response = await patch({
      action: "task",
      revision: company.revision,
      task: { ...task(), owners: invalid },
    });
    expect(response.status).toBe(400);
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("담당자 저장과 상태 수정은 메모·기한·단계를 보존하며 재시작 후에도 남는다", async () => {
    const original = task({ owners: { ...owners, materials: ` ${owners.materials} ` } });
    const saved = await save(original);
    expect(saved).toEqual({ ...original, owners });
    const completed = await save({ ...saved, status: "done" });
    expect(completed).toEqual({ ...saved, status: "done" });
    expect(company.stage).toBe("preparing");
    expect(company.stageHistory).toEqual([]);
    state.store!.close();
    state.store = new StudioStore(directory);
    expect(state.store.get(company.id).tasks).toEqual([completed]);
  });
  it("구형 요청의 담당자 생략은 보존하며 명시적인 빈 이름으로만 지운다", async () => {
    const saved = await save(task({ owners }));
    const legacy = { ...saved };
    delete legacy.owners;
    expect((await save({ ...legacy, status: "done" })).owners).toEqual(owners);
    expect((await save({ ...legacy, owners: emptyOwners })).owners).toEqual(emptyOwners);
  });
  it("오래된 revision·외부 Origin·공식 입력 잠금은 담당자 변경을 차단한다", async () => {
    const saved = await save(task({ owners }));
    const before = structuredClone(company);
    const payload = {
      action: "task",
      revision: company.revision,
      task: { ...saved, owners: emptyOwners },
    };
    expect((await patch({ ...payload, revision: company.revision - 1 })).status).toBe(409);
    expect((await patch(payload, company.id, { Origin: "https://untrusted.example" })).status).toBe(
      403,
    );
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await patch(payload)).status).toBe(409);
    });
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("다른 회사의 같은 업무 ID로 담당자나 출처를 조회·상속하지 않는다", async () => {
    const saved = await save(task({ owners }));
    const before = structuredClone(company);
    const other = state.store!.create({ ...emptyProfile(), companyName: "다른 합성 회사" });
    const response = await patch(
      {
        action: "task",
        revision: other.revision,
        task: task({
          id: saved.id,
          agencyOrigin: { requestRecordId: randomUUID(), requestVersionId: randomUUID() },
          diagnosisOrigin: { diagnosisId: randomUUID(), actionId: "foreign" },
        }),
      },
      other.id,
    );
    expect(response.status).toBe(200);
    const foreign = (await response.json()).tasks[0];
    expect(foreign).not.toHaveProperty("owners");
    expect(foreign).not.toHaveProperty("agencyOrigin");
    expect(foreign).not.toHaveProperty("diagnosisOrigin");
    expect(state.store!.get(company.id)).toEqual(before);
  });
  it("기관 요청 재사용은 지정 이름을 보존하고 정정 후 새 업무는 미지정이다", async () => {
    const root = appendRequest();
    const first = await agencyTask(root.id, root.id);
    expect(first).not.toHaveProperty("owners");
    const saved = await save({ ...first, owners });
    expect(saved.agencyOrigin).toEqual(first.agencyOrigin);
    expect((await agencyTask(root.id, root.id)).owners).toEqual(owners);
    const correction = appendRequest(root.id);
    expect(await agencyTask(root.id, correction.id)).not.toHaveProperty("owners");
    expect(company.tasks.find((entry) => entry.id === saved.id)?.owners).toEqual(owners);
  });
  it("진단과 기관 출처는 이름 수정으로 위조·제거되지 않는다", async () => {
    const root = appendRequest();
    const first = await agencyTask(root.id, root.id);
    const saved = await save({
      ...first,
      owners,
      agencyOrigin: { requestRecordId: randomUUID(), requestVersionId: randomUUID() },
    });
    expect(saved.agencyOrigin).toEqual(first.agencyOrigin);
    // This older persisted shape has a diagnosis origin; ordinary edits must retain it.
    const diagnosisId = randomUUID();
    const { DatabaseSync } = await import("node:sqlite");
    const persisted = {
      ...company,
      tasks: [{ ...saved, diagnosisOrigin: { diagnosisId, actionId: "known-action" } }],
    };
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(
        JSON.stringify(persisted),
        company.id,
      );
    } finally {
      db.close();
    }
    const edited = await save({
      ...saved,
      owners: { ...owners, review: "새 확인 담당자" },
      diagnosisOrigin: { diagnosisId: randomUUID(), actionId: "forged" },
    });
    expect(edited.diagnosisOrigin).toEqual({ diagnosisId, actionId: "known-action" });
    expect(edited.agencyOrigin).toEqual(first.agencyOrigin);
  });
  it("목록 요약·ZIP·외부 AI 요청에 구조화 담당자 이름을 추가하지 않는다", async () => {
    await save(task({ owners }));
    const candidate = {
      id: "candidate",
      title: "합성 아이템",
      problem: "문제",
      solution: "해결",
      targetCustomer: "고객",
      differentiation: "미확인",
      stage: "구상",
      businessModel: "미확인",
      recommendation: "검토",
      evidence: [],
      gaps: [],
    };
    company = state.store!.saveAnalysis(
      company.id,
      company.revision,
      { summary: "합성 분석", facts: [], candidates: [candidate], questions: [], warnings: [] },
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
        title: "합성 원고",
        summary: "미확인 초안",
        sections: [],
        actionItems: [],
        interviewQuestions: [],
      },
      [],
      "assisted",
    );
    const output = await buildPreparationPackage(state.store!, company.id, {
      revision: company.revision,
      planId: company.plans[0].id,
      sourceIds: [],
    });
    const zip = await JSZip.loadAsync(output.buffer);
    const contents = await Promise.all(
      Object.values(zip.files)
        .filter((file) => !file.dir)
        .map((file) => file.async("string")),
    );
    vi.stubEnv("OPENAI_API_KEY", "synthetic-no-network");
    state.parse.mockResolvedValue({
      status: "completed",
      output_parsed: {
        summary: "합성 분석",
        facts: [],
        candidates: [],
        questions: [],
        warnings: [],
      },
    });
    await analyzeCompany(company, "ai");
    expect(state.parse).toHaveBeenCalledTimes(1);
    const exposed = JSON.stringify([
      summarizeCase(company),
      state.store!.list(),
      contents,
      state.parse.mock.calls,
    ]);
    for (const owner of Object.values(owners)) expect(exposed).not.toContain(owner);
  });
});
