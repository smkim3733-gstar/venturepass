import { it, expect } from "vitest";
import {
  workflowTaskDeleteFixture,
  agencyId,
} from "../../../scripts/fixtures/workflow-task-delete";
import { workflowTaskDeleteAcknowledged as acknowledged } from "./workflow-task-response";
it("같은 이름이어도 선택 ID 하나만 삭제하며 원래 입력과 나머지 업무를 보존한다", () => {
  const f = workflowTaskDeleteFixture(),
    original = structuredClone(f);
  expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
  expect(f).toEqual(original);
});
it("유일한 마지막 업무 삭제 후 빈 목록을 수락한다", () => {
  const f = workflowTaskDeleteFixture();
  f.company.tasks = [f.company.tasks.at(-1)!];
  f.saved.tasks = [];
  expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
});
for (const mismatch of [
  "unchanged",
  "wrong-target",
  "both",
  "extra",
  "notes",
  "owners",
  "status",
  "origin",
  "processing",
  "duplicate-before",
  "duplicate-after",
  "unknown",
  "company",
  "revision",
  "command-revision",
  "profile",
  "plans",
  "records",
  "applications",
  "stage",
  "format",
] as const)
  it(`${mismatch} 삭제 결과가 원래 선택과 다르면 거절`, () => {
    const { company, request, saved } = workflowTaskDeleteFixture();
    if (mismatch === "unchanged") saved.tasks = structuredClone(company.tasks);
    if (mismatch === "wrong-target") saved.tasks = [structuredClone(company.tasks.at(-1)!)];
    if (mismatch === "both") saved.tasks = [];
    if (mismatch === "extra") saved.tasks.push({ ...saved.tasks[0], id: agencyId(99) });
    if (mismatch === "notes") saved.tasks[0].notes = "다른 메모";
    if (mismatch === "owners") saved.tasks[0].owners!.review = "다른 담당자";
    if (mismatch === "status") saved.tasks[0].status = "pending";
    if (mismatch === "origin") saved.tasks[0].agencyOrigin!.requestVersionId = agencyId(99);
    if (mismatch === "processing") saved.tasks[0].processing = { stage: "ready", planRefs: [] };
    if (mismatch === "duplicate-before") company.tasks.push(company.tasks.at(-1)!);
    if (mismatch === "duplicate-after") saved.tasks.push(saved.tasks[0]);
    if (mismatch === "unknown") request.taskId = agencyId(99);
    if (mismatch === "company") saved.id = agencyId(99);
    if (mismatch === "revision") saved.revision = company.revision;
    if (mismatch === "command-revision") request.revision--;
    if (mismatch === "profile") saved.profile.companyName += " 변경";
    if (mismatch === "plans") saved.plans[0].content.title += " 변경";
    if (mismatch === "records") saved.agencyRecords = [];
    if (mismatch === "applications") saved.applications = [];
    if (mismatch === "stage") saved.stage = "preparing";
    expect(acknowledged(mismatch === "format" ? {} : saved, company, request)).toBe(false);
  });
it("남은 업무 순서를 바꾸는 응답은 수락하지 않는다", () => {
  const f = workflowTaskDeleteFixture(),
    other = { ...structuredClone(f.company.tasks[0]), id: agencyId(99) };
  f.company.tasks.push(other);
  f.saved.tasks.push(other);
  expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
  f.saved.tasks.reverse();
  expect(acknowledged(f.saved, f.company, f.request)).toBe(false);
});
