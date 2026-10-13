import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase, type WorkflowTask } from "@/lib/studio-schema";
import type { AgencyRequestRecord } from "@/lib/studio-agency-records";
import { AgencyTaskReference, WorkflowPanel, workflowTaskMatchesDueFilter } from "./workflow-panel";
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

describe("기본 후속 업무의 상세 진입", () => {
  function guided(
    c: StudioCase,
    target: import("@/lib/studio-guided-followup").GuidedWorkflowTarget,
  ) {
    const mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(WorkflowPanel, { company: c, mutate, setDirty: vi.fn(), guidedTarget: target }),
    );
    expect(mutate).not.toHaveBeenCalled();
    return html;
  }
  it("opens exactly the selected task while retaining original dates and completed status", () => {
    const c = company();
    const before = JSON.stringify(c);
    const html = guided(c, { caseId: c.id, companyRevision: c.revision, kind: "task", taskId });
    expect(html).toContain('id="workflow-task-editor"');
    expect(html).toContain('value="가상 후속 업무"');
    expect(html).toContain('value="2026-10-02"');
    expect(JSON.stringify(c)).toBe(before);
  });
  it("opens the exact corrected request, preserving old completed task", () => {
    const c = company({
      agencyRecords: [
        request(),
        request({
          id: correctedId,
          kind: "request-correction",
          requestVersionId: correctedId,
          previousVersionId: requestId,
          version: 2,
          title: "정정된 요청",
        }),
      ],
    });
    const html = guided(c, {
      caseId: c.id,
      companyRevision: c.revision,
      kind: "response",
      requestRecordId: requestId,
      requestVersionId: correctedId,
    });
    expect(html).toContain('value="답변 준비: 정정된 요청"');
    expect(html).toContain("기준 요청: 정정된 요청 · 요청 v2");
    expect(html).not.toContain('id="workflow-task-editor"');
    expect(c.tasks[0].status).toBe("done");
  });
  it.each(["case", "revision", "task"])("stale %s never opens a replacement task", (field) => {
    const c = company();
    const target = { caseId: c.id, companyRevision: c.revision, kind: "task" as const, taskId };
    if (field === "case") target.caseId = correctedId;
    if (field === "revision") target.companyRevision = 99;
    if (field === "task") target.taskId = correctedId;
    const html = guided(c, target);
    expect(html).not.toContain('id="workflow-task-editor"');
    expect(html).toContain("현재 안내를 다시 확인");
  });
});

describe("저장 업무의 기한 필터", () => {
  it("날짜 경계와 완료·미입력 업무를 구분하며 저장 입력을 바꾸지 않는다", () => {
    const tasks = [
      task({ title: "overdue", status: "pending", dueDate: "2026-10-12" }),
      task({ title: "today", status: "pending", dueDate: "2026-10-13" }),
      task({ title: "seventh", status: "pending", dueDate: "2026-10-20" }),
      task({ title: "eighth", status: "pending", dueDate: "2026-10-21" }),
      task({ title: "undated", status: "pending", dueDate: "" }),
      task({ title: "done-overdue", status: "done", dueDate: "2026-10-12" }),
      task({ title: "done-soon", status: "done", dueDate: "2026-10-20" }),
      task({ title: "done-undated", status: "done", dueDate: "" }),
    ];
    const before = structuredClone(tasks);
    const selected = (filter: Parameters<typeof workflowTaskMatchesDueFilter>[1]) =>
      tasks
        .filter((t) => workflowTaskMatchesDueFilter(t, filter, "2026-10-13"))
        .map((t) => t.title);
    expect(selected("all")).toEqual(tasks.map((t) => t.title));
    expect(selected("overdue")).toEqual(["overdue"]);
    expect(selected("due-soon")).toEqual(["today", "seventh"]);
    expect(selected("undated")).toEqual(["undated"]);
    expect(tasks).toEqual(before);
  });
  it.each([
    ["2026-12-28", "2027-01-04", "2027-01-05"],
    ["2028-02-25", "2028-03-03", "2028-03-04"],
  ])("%s의 7일 범위는 연도·윤년 경계를 달력 날짜로 넘긴다", (today, seventh, eighth) => {
    expect(
      workflowTaskMatchesDueFilter(
        task({ status: "pending", dueDate: seventh }),
        "due-soon",
        today,
      ),
    ).toBe(true);
    expect(
      workflowTaskMatchesDueFilter(task({ status: "pending", dueDate: eighth }), "due-soon", today),
    ).toBe(false);
  });
  it.each(["", "not-a-date", "2026-02-30"])(
    "유효하지 않은 기준일 %s에서 기한 경과·임박을 단정하지 않는다",
    (today) => {
      const dated = task({ status: "pending", dueDate: "2026-01-01" });
      expect(workflowTaskMatchesDueFilter(dated, "overdue", today)).toBe(false);
      expect(workflowTaskMatchesDueFilter(dated, "due-soon", today)).toBe(false);
      expect(workflowTaskMatchesDueFilter(dated, "all", today)).toBe(true);
      expect(
        workflowTaskMatchesDueFilter(task({ status: "pending", dueDate: "" }), "undated", today),
      ).toBe(true);
    },
  );
});
