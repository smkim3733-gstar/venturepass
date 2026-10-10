import { expect, it } from "vitest";
import {
  diagnosisTasksFixture,
  diagnosisTasksResult,
  agencyId,
} from "../../../scripts/fixtures/diagnosis-tasks-receipt";
import { diagnosisTasksSaveAcknowledged as acknowledged } from "./diagnosis-tasks-response";
it("선택 순서대로 정확한 두 과제만 등록하고 담당자 수정 업무와 요청을 보존한다", () => {
  const f = diagnosisTasksFixture(),
    before = structuredClone(f);
  expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
  expect(f).toEqual(before);
});
for (const mismatch of [
  "missing",
  "extra",
  "title",
  "notes",
  "category",
  "due",
  "status",
  "owners",
  "origin",
  "action",
  "order",
  "old-task",
  "duplicate-id",
  "duplicate-origin",
  "duplicate-diagnosis",
  "duplicate-version",
  "duplicate-action",
  "stale",
  "criteria",
  "older",
  "array-order",
  "unknown",
  "duplicate-selection",
  "empty-selection",
  "company",
  "revision",
  "command-revision",
  "profile",
  "plan",
  "sources",
  "diagnoses",
  "stage",
  "format",
] as const)
  it(mismatch + " 다른 과제 업무 응답 거절", () => {
    const f = diagnosisTasksFixture(),
      task = f.saved.tasks.at(-1)!,
      diagnosis = f.company.diagnoses.at(-1)!;
    if (mismatch === "missing") f.saved.tasks.pop();
    if (mismatch === "extra")
      f.saved.tasks.push({ ...task, id: agencyId(97), diagnosisOrigin: undefined });
    if (mismatch === "title") task.title = "다른 제목";
    if (mismatch === "notes") task.notes = task.notes.trim();
    if (mismatch === "category") task.category = "other";
    if (mismatch === "due") task.dueDate = "2026-10-30";
    if (mismatch === "status") task.status = "done";
    if (mismatch === "owners") task.owners = { materials: "임의 담당", writing: "", review: "" };
    if (mismatch === "origin") task.diagnosisOrigin!.diagnosisId = f.company.diagnoses[0].id;
    if (mismatch === "action") task.diagnosisOrigin!.actionId = "existing";
    if (mismatch === "order") f.saved.tasks.splice(-2, 2, ...f.saved.tasks.slice(-2).reverse());
    if (mismatch === "old-task") f.saved.tasks[0].notes += "변경";
    if (mismatch === "duplicate-id") task.id = f.saved.tasks[0].id;
    if (mismatch === "duplicate-origin") {
      const copy = { ...f.company.tasks.at(-1)!, id: agencyId(96) };
      f.company.tasks.push(copy);
      f.saved.tasks.splice(f.company.tasks.length - 1, 0, copy);
      f.request.actionIds.unshift("existing");
    }
    if (mismatch === "duplicate-diagnosis") f.company.diagnoses[0].id = diagnosis.id;
    if (mismatch === "duplicate-version") f.company.diagnoses[0].version = diagnosis.version;
    if (mismatch === "duplicate-action") diagnosis.actions.push(diagnosis.actions[0]);
    if (mismatch === "stale") diagnosis.stale = true;
    if (mismatch === "criteria") diagnosis.criteriaVersion = "old";
    if (mismatch === "older") f.request.diagnosisId = f.company.diagnoses[0].id;
    if (mismatch === "array-order") f.company.diagnoses.reverse();
    if (mismatch === "unknown") f.request.actionIds = ["missing"];
    if (mismatch === "duplicate-selection") f.request.actionIds = ["market", "market"];
    if (mismatch === "empty-selection") f.request.actionIds = [];
    if (mismatch === "company") f.saved.id = agencyId(99);
    if (mismatch === "revision") f.saved.revision = f.company.revision;
    if (mismatch === "command-revision") f.request.revision--;
    if (mismatch === "profile") f.saved.profile.companyName += "변경";
    if (mismatch === "plan") f.saved.plans[0].content.title += "변경";
    if (mismatch === "sources")
      f.saved.sources = [
        {
          id: agencyId(98),
          name: "추가 자료",
          kind: "other",
          text: "추가 본문",
          originalName: null,
          mimeType: null,
          extraction: "manual",
          warnings: [],
          createdAt: "2026-10-10T00:00:00.000Z",
          updatedAt: "2026-10-10T00:00:00.000Z",
        },
      ];
    if (mismatch === "diagnoses") f.saved.diagnoses.at(-1)!.warnings.push("변경");
    if (mismatch === "stage") f.saved.stage = "confirmed";
    expect(acknowledged(mismatch === "format" ? {} : f.saved, f.company, f.request)).toBe(false);
  });
it("이미 보유한 수정 업무만 재확인하면 같은 revision과 담당자 완료 상태를 그대로 수락한다", () => {
  const f = diagnosisTasksFixture();
  f.request.actionIds = ["existing"];
  expect(acknowledged(f.company, f.company, f.request)).toBe(true);
});
it("이미 등록된 과제와 새 과제 혼합 선택은 기존 업무를 생성 기본값으로 바꾸지 않는다", () => {
  const f = diagnosisTasksFixture();
  f.request.actionIds = ["existing", "market"];
  expect(acknowledged(diagnosisTasksResult(f.company, f.request), f.company, f.request)).toBe(true);
});
it("업무 200개 한도에서 기존 업무 재확인은 허용하고 새 추가는 거절한다", () => {
  const f = diagnosisTasksFixture();
  while (f.company.tasks.length < 200)
    f.company.tasks.push({
      ...f.company.tasks[0],
      id: agencyId(200 + f.company.tasks.length),
      agencyOrigin: undefined,
    });
  f.request.actionIds = ["existing"];
  expect(acknowledged(f.company, f.company, f.request)).toBe(true);
  f.request.actionIds = ["market"];
  const saved = diagnosisTasksResult;
  expect(() => saved(f.company, f.request)).toThrow();
  const overflow = structuredClone(f.company);
  overflow.tasks.push(f.saved.tasks.at(-2)!);
  overflow.revision++;
  expect(acknowledged(overflow, f.company, f.request)).toBe(false);
});
