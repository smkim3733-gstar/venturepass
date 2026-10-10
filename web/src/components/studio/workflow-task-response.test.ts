import { it, expect } from "vitest";
import { workflowTaskFixture, agencyId } from "../../../scripts/fixtures/workflow-task-receipt";
import { workflowTaskSaveAcknowledged as acknowledged } from "./workflow-task-response";
import { taskSchema } from "@/lib/studio-schema";
it("원래 수정 내용만 수락하며 입력 원문·이전 업무·출처를 바꾸지 않는다", () => {
  const f = workflowTaskFixture(),
    original = structuredClone(f);
  expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
  expect(f).toEqual(original);
});
for (const mismatch of [
  "missing",
  "title",
  "date",
  "notes",
  "category",
  "status",
  "owners",
  "processing",
  "quote",
  "origin",
  "duplicate",
  "extra",
  "old-task",
  "company",
  "revision",
  "command-revision",
  "plan",
  "records",
  "stage",
  "format",
] as const)
  it(`${mismatch} 다른 저장 응답 거절`, () => {
    const { company, request, saved } = workflowTaskFixture(),
      task = saved.tasks.at(-1)!;
    if (mismatch === "missing") saved.tasks.pop();
    if (mismatch === "title") task.title = "다른 제목";
    if (mismatch === "date") task.dueDate = "2026-11-04";
    if (mismatch === "notes") task.notes = "다른 메모";
    if (mismatch === "category") task.category = "other";
    if (mismatch === "status") task.status = "done";
    if (mismatch === "owners") task.owners!.review = "다른 담당자";
    if (mismatch === "processing") task.processing!.stage = "ready";
    if (mismatch === "quote") task.processing!.planRefs[0].quote = "다른 인용";
    if (mismatch === "origin") task.agencyOrigin!.requestVersionId = agencyId(1);
    if (mismatch === "duplicate") saved.tasks.push(task);
    if (mismatch === "extra") saved.tasks.push({ ...task, id: agencyId(99) });
    if (mismatch === "old-task") saved.tasks[0].notes = "다른 이전 업무";
    if (mismatch === "company") saved.id = agencyId(99);
    if (mismatch === "revision") saved.revision = company.revision;
    if (mismatch === "command-revision") request.revision--;
    if (mismatch === "plan") saved.plans[0].content.title += " 변경";
    if (mismatch === "records") saved.agencyRecords = [];
    if (mismatch === "stage") saved.stage = "preparing";
    expect(acknowledged(mismatch === "format" ? {} : saved, company, request)).toBe(false);
  });
it("명시 완료/다시 진행은 요청한 상태만 수락한다", () => {
  const { company, request, saved } = workflowTaskFixture();
  request.task.status = "done";
  saved.tasks.at(-1)!.status = "done";
  expect(acknowledged(saved, company, request)).toBe(true);
  request.task.status = "pending";
  expect(acknowledged(saved, company, request)).toBe(false);
  saved.tasks.at(-1)!.status = "pending";
  expect(acknowledged(saved, company, request)).toBe(true);
});
it("생략된 담당자·처리 정보는 원래 값을 보존한다", () => {
  const { company, request, saved } = workflowTaskFixture();
  delete request.task.owners;
  delete request.task.processing;
  saved.tasks.at(-1)!.owners = structuredClone(company.tasks.at(-1)!.owners);
  saved.tasks.at(-1)!.processing = structuredClone(company.tasks.at(-1)!.processing);
  expect(acknowledged(saved, company, request)).toBe(true);
  delete saved.tasks.at(-1)!.owners;
  expect(acknowledged(saved, company, request)).toBe(false);
});
it("명시 빈 담당자와 빈 원고 연결은 보존 기본값으로 덮어쓰지 않는다", () => {
  const { company, request, saved } = workflowTaskFixture();
  request.task.owners = { materials: "", writing: "", review: "" };
  request.task.processing = { stage: "writing", planRefs: [] };
  saved.tasks.at(-1)!.owners = structuredClone(request.task.owners);
  saved.tasks.at(-1)!.processing = structuredClone(request.task.processing);
  expect(acknowledged(saved, company, request)).toBe(true);
});
it("새 업무는 전달된 출처를 만들지 않고 한 건만 추가한다", () => {
  const { company, request, saved } = workflowTaskFixture();
  request.task.id = agencyId(80);
  const task = taskSchema.parse(request.task);
  delete task.agencyOrigin;
  saved.tasks = [...structuredClone(company.tasks), task];
  expect(acknowledged(saved, company, request)).toBe(true);
  saved.tasks.at(-1)!.agencyOrigin = request.task.agencyOrigin;
  expect(acknowledged(saved, company, request)).toBe(false);
});
it("기존 기관 출처는 다른 요청값으로 교체할 수 없다", () => {
  const { company, request, saved } = workflowTaskFixture();
  request.task.agencyOrigin!.requestVersionId = agencyId(99);
  expect(acknowledged(saved, company, request)).toBe(true);
  saved.tasks.at(-1)!.agencyOrigin = request.task.agencyOrigin;
  expect(acknowledged(saved, company, request)).toBe(false);
});
for (const mismatch of ["missing-plan", "wrong-quote", "duplicate-plan", "duplicate-task"] as const)
  it(`${mismatch} 원래 입력/대상이 유효하지 않으면 거절`, () => {
    const { company, request, saved } = workflowTaskFixture();
    if (mismatch === "missing-plan") request.task.processing!.planRefs[0].planId = agencyId(99);
    if (mismatch === "wrong-quote") request.task.processing!.planRefs[0].quote = "원고에 없는 인용";
    if (mismatch === "duplicate-plan") {
      company.plans.push(company.plans.at(-1)!);
      saved.plans = structuredClone(company.plans);
    }
    if (mismatch === "duplicate-task") {
      company.tasks.push(company.tasks[0]);
      saved.tasks.push(saved.tasks[0]);
    }
    expect(acknowledged(saved, company, request)).toBe(false);
  });
