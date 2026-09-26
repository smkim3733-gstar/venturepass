import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase, type WorkflowTask } from "@/lib/studio-schema";
import type { AgencyRequestRecord } from "@/lib/studio-agency-records";
import { AgencyTaskReference, WorkflowPanel } from "./workflow-panel";
import { AgencyRequestTasks } from "./agency-records";

const now = "2026-09-25T00:00:00.000Z";
const companyId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const correctedId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
function request(change: Partial<AgencyRequestRecord> = {}): AgencyRequestRecord {
  return {
    id: requestId,
    clientRequestId: taskId,
    inputDigest: "a".repeat(64),
    kind: "request",
    requestRecordId: requestId,
    requestVersionId: requestId,
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: now,
    institution: "가상 기관",
    title: "원본 요청",
    body: "가상 요청 원문",
    occurredOn: "",
    dueOn: "2026-10-01",
    dueNote: "원문 기재 날짜",
    note: "",
    responseStatus: null,
    evidence: [],
    ...change,
  };
}
function task(change: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: taskId,
    title: "가상 후속 업무",
    category: "supplement",
    dueDate: "2026-10-02",
    status: "done",
    notes: "담당자가 편집한 업무",
    agencyOrigin: { requestRecordId: requestId, requestVersionId: requestId },
    ...change,
  };
}
function company(change: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "가상 시험기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [task()],
    stage: "preparing",
    agencyRecords: [request()],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...change,
  });
}
function reference(record = company(), entry = task()) {
  return renderToStaticMarkup(createElement(AgencyTaskReference, { company: record, task: entry }));
}

describe("workflow agency request references", () => {
  it("links to the exact original request version, not an external page", () => {
    const html = reference();
    expect(html).toContain(`href="#agency-record-${requestId}"`);
    expect(html).toContain("기관 요청 v1 원문 확인");
    expect(html).toContain("업무 완료 표시는 기관 수신 확인이 아닙니다");
    expect(html).not.toContain("https://");
  });
  it("keeps the old request anchor and warns after correction", () => {
    const current = company({
      agencyRecords: [
        request(),
        request({
          id: correctedId,
          kind: "request-correction",
          requestVersionId: correctedId,
          previousVersionId: requestId,
          version: 2,
          dueOn: "2026-10-20",
        }),
      ],
    });
    const html = reference(current);
    expect(html).toContain(`href="#agency-record-${requestId}"`);
    expect(html).not.toContain(`href="#agency-record-${correctedId}"`);
    expect(html).toContain("이후 요청이 v2으로 정정되었습니다");
    expect(html).toContain("업무 기한·완료 상태는 이전 기록을 유지합니다");
    expect(current.tasks[0].dueDate).toBe("2026-10-02");
    expect(current.tasks[0].status).toBe("done");
  });
  it("does not invent a current link for missing request evidence", () => {
    const html = reference(company({ agencyRecords: [] }));
    expect(html).toContain("연결한 기관 요청 버전을 확인하지 못했습니다");
    expect(html).toContain("현재 요청과 일치한다고 판단하지 않습니다");
    expect(html).not.toContain("href=");
  });
  it("does not add a request link to legacy or ordinary tasks", () => {
    expect(reference(company(), task({ agencyOrigin: undefined }))).toBe("");
  });
  it("renders task anchors without running mutations or changing stored deadlines", () => {
    const mutate = vi.fn();
    const record = company();
    const html = renderToStaticMarkup(
      createElement(WorkflowPanel, { company: record, mutate, setDirty: vi.fn() }),
    );
    expect(html).toContain(`id="workflow-task-${taskId}"`);
    expect(html).toContain(`id="agency-record-${requestId}"`);
    expect(html).toContain("2026-10-02");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("업무와 요청별 카드에 해당 요청 버전의 담당자만 표시한다", () => {
    const record = company({
      tasks: [
        task({ owners: { materials: "원요청 준비자", writing: "원요청 작성자", review: "" } }),
        task({
          id: "55555555-5555-4555-8555-555555555555",
          agencyOrigin: { requestRecordId: requestId, requestVersionId: correctedId },
        }),
      ],
      agencyRecords: [
        request(),
        request({
          id: correctedId,
          kind: "request-correction",
          requestVersionId: correctedId,
          previousVersionId: requestId,
          version: 2,
        }),
      ],
    });
    const mutate = vi.fn();
    const linked = renderToStaticMarkup(
      createElement(AgencyRequestTasks, {
        company: record,
        requestRecordId: requestId,
      }),
    );
    expect(linked).toContain("요청 v1");
    expect(linked).toContain("요청 v2");
    expect(linked.match(/원요청 준비자/g)).toHaveLength(1);
    expect(linked.match(/<dd[^>]*>미지정<\/dd>/g)).toHaveLength(4);
    const html = renderToStaticMarkup(
      createElement(WorkflowPanel, {
        company: record,
        mutate,
        setDirty: vi.fn(),
      }),
    );
    expect(html.match(/원요청 작성자/g)).toHaveLength(2);
    expect(html).toContain("계정 권한이나 검토 완료를 부여하지 않으며 알림을 보내지 않습니다");
    expect(mutate).not.toHaveBeenCalled();
    expect(record.tasks[1]).not.toHaveProperty("owners");
  });
});
