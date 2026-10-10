import { it, expect } from "vitest";
import { agencyTaskFixture, agencyId } from "../../../scripts/fixtures/agency-task-receipt";
import { agencyTaskSaveAcknowledged as acknowledged } from "./agency-task-response";
it("최신 정정 요청의 정확한 업무만 수락하고 기존 수정 업무와 입력을 보존한다", () => {
  const f = agencyTaskFixture(),
    before = structuredClone(f);
  expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
  expect(f).toEqual(before);
});
for (const mismatch of [
  "missing",
  "title",
  "date",
  "notes",
  "category",
  "done",
  "owners",
  "root",
  "version",
  "duplicate-origin",
  "duplicate-id",
  "extra",
  "old-task",
  "history",
  "company",
  "revision",
  "command-revision",
  "profile",
  "plan",
  "stage",
  "events",
  "format",
] as const)
  it(`${mismatch} 응답 불일치 거절`, () => {
    const { company, request, saved } = agencyTaskFixture(),
      task = saved.tasks.at(-1)!;
    if (mismatch === "missing") saved.tasks.pop();
    if (mismatch === "title") task.title = "다른 제목";
    if (mismatch === "date") task.dueDate = "2026-10-21";
    if (mismatch === "notes") task.notes = "다른 기한 근거";
    if (mismatch === "category") task.category = "other";
    if (mismatch === "done") task.status = "done";
    if (mismatch === "owners") task.owners = { materials: "새 담당자", writing: "", review: "" };
    if (mismatch === "root") task.agencyOrigin!.requestRecordId = agencyId(99);
    if (mismatch === "version") task.agencyOrigin!.requestVersionId = agencyId(1);
    if (mismatch === "duplicate-origin") saved.tasks.push({ ...task, id: agencyId(98) });
    if (mismatch === "duplicate-id") task.id = saved.tasks[0].id;
    if (mismatch === "extra")
      saved.tasks.push({ ...task, id: agencyId(98), agencyOrigin: undefined });
    if (mismatch === "old-task") saved.tasks[0].notes = "이전 업무 변조";
    if (mismatch === "history") saved.agencyRecords[0].body = "원문 변조";
    if (mismatch === "company") saved.id = agencyId(99);
    if (mismatch === "revision") saved.revision = company.revision;
    if (mismatch === "command-revision") request.revision--;
    if (mismatch === "profile") saved.profile.companyName = "다른 회사 정보";
    if (mismatch === "plan") saved.plans[0].content.title += " 응답 변조";
    if (mismatch === "stage") saved.stage = "preparing";
    if (mismatch === "events") saved.applicationEvents = [];
    expect(acknowledged(mismatch === "format" ? { revision: 9 } : saved, company, request)).toBe(
      false,
    );
  });
it("화면에 이미 있던 담당자 수정 업무는 같은 revision으로 확인하고 기본값으로 되돌리지 않는다", () => {
  const { saved: company, request } = agencyTaskFixture();
  company.tasks.at(-1)!.title = "담당자가 수정한 제목";
  company.tasks.at(-1)!.status = "done";
  company.tasks.at(-1)!.dueDate = "2026-11-01";
  request.revision = company.revision;
  expect(acknowledged(structuredClone(company), company, request)).toBe(true);
  const changed = structuredClone(company);
  changed.tasks.at(-1)!.status = "pending";
  expect(acknowledged(changed, company, request)).toBe(false);
});
it("현재 화면에 없는 다른 편집 업무를 생성 결과로 추정하지 않는다", () => {
  const { company, request, saved } = agencyTaskFixture();
  saved.tasks.at(-1)!.notes = "다른 탭이 이후에 편집함";
  expect(acknowledged(saved, company, request)).toBe(false);
});
for (const mismatch of [
  "old-request",
  "missing-root",
  "duplicate-record",
  "duplicate-old-task",
  "capacity",
] as const)
  it(`${mismatch} 원래 대상이 모호하거나 현재 요청이 아니면 거절`, () => {
    const { company, request, saved } = agencyTaskFixture();
    if (mismatch === "old-request") request.requestVersionId = agencyId(1);
    if (mismatch === "missing-root")
      company.agencyRecords = company.agencyRecords.filter((r) => r.id !== agencyId(1));
    if (mismatch === "duplicate-record") company.agencyRecords.push(company.agencyRecords.at(-1)!);
    if (mismatch === "duplicate-old-task") company.tasks.push(company.tasks[0]);
    if (mismatch === "capacity")
      company.tasks = Array.from({ length: 200 }, (_, i) => ({
        ...company.tasks[0],
        id: agencyId(100 + i),
        agencyOrigin: undefined,
      }));
    saved.agencyRecords = structuredClone(company.agencyRecords);
    expect(acknowledged(saved, company, request)).toBe(false);
  });
