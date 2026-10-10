import { it, expect } from "vitest";
import {
  workflowStageFixture,
  workflowStageResult,
  agencyId,
} from "../../../scripts/fixtures/workflow-stage-receipt";
import { workflowStageSaveAcknowledged as acknowledged } from "./workflow-stage-response";
it("수동 단계·발생일·메모 원문과 이전 이력을 그대로 대조하며 입력을 바꾸지 않는다", () => {
  const f = workflowStageFixture(),
    before = structuredClone(f);
  expect(acknowledged(f.saved, f.company, f.request)).toBe(true);
  expect(f).toEqual(before);
});
for (const mismatch of [
  "missing",
  "unchanged-stage",
  "other-stage",
  "from",
  "to",
  "origin",
  "date",
  "note",
  "timestamp",
  "previous",
  "duplicate-before",
  "duplicate-after",
  "extra",
  "company",
  "revision",
  "command-revision",
  "profile",
  "plan",
  "task",
  "records",
  "applications",
  "format",
] as const)
  it(`${mismatch} 원래 단계 저장과 다른 응답 거절`, () => {
    const { company, request, saved } = workflowStageFixture(),
      entry = saved.stageHistory.at(-1)!;
    if (mismatch === "missing") saved.stageHistory.pop();
    if (mismatch === "unchanged-stage") saved.stage = company.stage;
    if (mismatch === "other-stage") saved.stage = "confirmed";
    if (mismatch === "from") entry.from = "preparing";
    if (mismatch === "to") entry.to = "confirmed";
    if (mismatch === "origin") entry.origin = "plan-created";
    if (mismatch === "date") entry.occurredOn = "2026-10-09";
    if (mismatch === "note") entry.note = "다른 근거";
    if (mismatch === "timestamp") entry.recordedAt = "invalid";
    if (mismatch === "previous") saved.stageHistory[0].note = "바뀐 이전 근거";
    if (mismatch === "duplicate-before") company.stageHistory.push(company.stageHistory[0]);
    if (mismatch === "duplicate-after") entry.id = company.stageHistory[0].id;
    if (mismatch === "extra") saved.stageHistory.push({ ...entry, id: agencyId(90) });
    if (mismatch === "company") saved.id = agencyId(99);
    if (mismatch === "revision") saved.revision = company.revision;
    if (mismatch === "command-revision") request.revision--;
    if (mismatch === "profile") saved.profile.companyName += " 변경";
    if (mismatch === "plan") saved.plans[0].content.title += " 변경";
    if (mismatch === "task") saved.tasks[0].notes += " 변경";
    if (mismatch === "records") saved.agencyRecords = [];
    if (mismatch === "applications") saved.applications = [];
    expect(acknowledged(mismatch === "format" ? {} : saved, company, request)).toBe(false);
  });
it("발생일·메모 생략은 빈 값으로 대조하며 응답의 임의 내용을 수락하지 않는다", () => {
  const f = workflowStageFixture();
  delete f.request.note;
  delete f.request.occurredOn;
  const saved = workflowStageResult(f.company, f.request);
  expect(acknowledged(saved, f.company, f.request)).toBe(true);
  saved.stageHistory.at(-1)!.note = "추가 근거";
  expect(acknowledged(saved, f.company, f.request)).toBe(false);
});
it("같은 단계는 새 이력을 만들지 않는 기존 계약만 수락한다", () => {
  const f = workflowStageFixture();
  f.request.stage = f.company.stage;
  const saved = workflowStageResult(f.company, f.request);
  expect(acknowledged(saved, f.company, f.request)).toBe(true);
  saved.stageHistory.push(f.saved.stageHistory.at(-1)!);
  expect(acknowledged(saved, f.company, f.request)).toBe(false);
});
it("역방향 단계 정정도 원래 이력을 지우지 않고 새 수동 기록으로 수락한다", () => {
  const f = workflowStageFixture();
  f.request.stage = "drafting";
  expect(acknowledged(workflowStageResult(f.company, f.request), f.company, f.request)).toBe(true);
});
it("500건 한도에서 이력을 잘라내거나 단계만 바꾼 응답을 거절한다", () => {
  const f = workflowStageFixture();
  f.company.stageHistory = Array.from({ length: 500 }, (_, i) => ({
    ...f.company.stageHistory[0],
    id: agencyId(100 + i),
  }));
  f.saved.stageHistory = structuredClone(f.company.stageHistory);
  f.saved.stageHistory.shift();
  f.saved.stageHistory.push({
    ...f.company.stageHistory[0],
    id: agencyId(71),
    to: f.request.stage,
  });
  expect(acknowledged(f.saved, f.company, f.request)).toBe(false);
});
for (const invalid of [{ occurredOn: "2026-02-30" }, { note: "x".repeat(2001) }])
  it("유효하지 않은 발생일·메모 요청을 수락하지 않는다", () => {
    const f = workflowStageFixture();
    expect(acknowledged(f.saved, f.company, { ...f.request, ...invalid })).toBe(false);
  });
