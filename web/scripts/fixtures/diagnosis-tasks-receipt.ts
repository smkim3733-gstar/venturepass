import { caseSchema, taskSchema, type StudioCase } from "../../src/lib/studio-schema";
import { diagnosisCriteriaVersion, type Diagnosis } from "../../src/lib/studio-diagnosis-types";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
import type { DiagnosisTasksCommand } from "../../src/components/studio/diagnosis-tasks-response";
export { agencyId };
export function diagnosisTasksFixture() {
  const company = workflowTaskFixture().company;
  company.profile.companyName = "합성 진단 보강 업무 기업";
  const diagnosis: Diagnosis = {
    id: agencyId(81),
    clientRequestId: agencyId(82),
    requestDigest: "a".repeat(64),
    version: 2,
    sourceRevision: company.revision,
    inputFingerprint: "b".repeat(64),
    criteriaVersion: diagnosisCriteriaVersion,
    generatedAt: "2026-10-10T00:00:00.000Z",
    stale: false,
    mode: "assisted",
    outcome: "reinforce_first",
    items: [
      {
        id: "synthetic-item",
        title: "합성 근거 확인",
        area: "reliability",
        status: "needs_work",
        reason: "추가 확인 필요",
        evidence: [],
        unknowns: ["확인 필요"],
        nextActions: ["원문 확인"],
      },
    ],
    questions: [],
    warnings: ["기관 판단이 아닌 합성 진단 표시"],
    actions: [
      { id: "existing", title: "기존 등록 과제", notes: "원래 과제 설명" },
      { id: "technology", title: "같은 제목 보강 과제", notes: "  기술 자료 확인\n기술 둘째 줄  " },
      { id: "market", title: "같은 제목 보강 과제", notes: "  고객 자료 확인\n고객 둘째 줄  " },
    ],
  };
  company.diagnoses = [
    {
      ...structuredClone(diagnosis),
      id: agencyId(80),
      clientRequestId: agencyId(79),
      version: 1,
      stale: true,
    },
    diagnosis,
  ];
  company.tasks.push({
    id: agencyId(83),
    title: "담당자가 바꾼 기존 진단 업무",
    category: "other",
    dueDate: "2026-10-30",
    notes: "보관한 처리 메모",
    status: "done",
    owners: { materials: "자료 담당", writing: "작성 담당", review: "검토 담당" },
    diagnosisOrigin: { diagnosisId: diagnosis.id, actionId: "existing" },
  });
  const request: DiagnosisTasksCommand = {
    action: "diagnosis-tasks",
    revision: company.revision,
    diagnosisId: diagnosis.id,
    actionIds: ["market", "technology"],
  };
  return {
    company: caseSchema.parse(company),
    request,
    saved: diagnosisTasksResult(company, request),
  };
}
export function diagnosisTasksResult(base: StudioCase, command: DiagnosisTasksCommand) {
  const saved = structuredClone(base),
    diagnosis = base.diagnoses.find((d) => d.id === command.diagnosisId)!;
  for (const [index, actionId] of command.actionIds.entries()) {
    if (
      saved.tasks.some(
        (t) =>
          t.diagnosisOrigin?.diagnosisId === diagnosis.id &&
          t.diagnosisOrigin.actionId === actionId,
      )
    )
      continue;
    const action = diagnosis.actions.find((a) => a.id === actionId)!;
    saved.tasks.push(
      taskSchema.parse({
        id: agencyId(90 + index),
        title: action.title,
        notes: action.notes,
        category: "evidence",
        dueDate: "",
        status: "pending",
        diagnosisOrigin: { diagnosisId: diagnosis.id, actionId },
      }),
    );
  }
  saved.revision++;
  return caseSchema.parse(saved);
}
