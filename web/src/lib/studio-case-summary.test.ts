import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioStore } from "./studio-storage";
import { caseSchema, emptyProfile, type StudioCase } from "./studio-schema";
import { summarizeCase, caseAttentionAt } from "./studio-case-summary";

let directory: string;
let store: StudioStore;
let company: StudioCase;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-summary-test-"));
  store = new StudioStore(directory);
  company = store.create({ ...emptyProfile(), companyName: "합성 현황 회사" });
});
afterEach(() => {
  store.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-summary-test-") || boundary.includes(".."))
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
});
const task = (dueDate: string, status: "pending" | "done" = "pending") => ({
  id: randomUUID(),
  title: "합성 비공개 업무 제목",
  notes: "합성 비공개 본문",
  category: "other" as const,
  dueDate,
  status,
});
function request() {
  company = store.mutate(
    company.id,
    {
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        title: "합성 요청",
        body: "합성 비공개 요청 본문",
        institution: "합성",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [],
      },
    },
    () => [],
  );
  return company.agencyRecords.at(-1)!;
}

describe("다기업 목록의 직접 기록 기반 준비 상태", () => {
  it("미추출 원본과 항목 확인을 마쳤지만 내부검토 전인 원고를 각각 표시한다", () => {
    company.sources = [
      {
        id: randomUUID(),
        name: "합성 파일",
        kind: "other",
        text: "",
        originalName: "synthetic.pdf",
        mimeType: "application/pdf",
        extraction: "pending",
        warnings: [],
        createdAt: company.createdAt,
        updatedAt: company.updatedAt,
      },
    ];
    company.plans = [
      {
        id: randomUUID(),
        version: 1,
        generatedAt: company.updatedAt,
        mode: "manual",
        candidateId: "synthetic",
        sourceRevision: company.revision,
        confirmedAt: null,
        review: [],
        content: {
          title: "합성 원고",
          summary: "",
          sections: [
            {
              key: "test",
              title: "합성항목",
              content: "합성본문",
              evidence: [],
              needsConfirmation: false,
            },
          ],
          actionItems: [],
          interviewQuestions: [],
        },
      },
    ];
    expect(summarizeCase(company).attention).toMatchObject({
      pendingSourceCount: 1,
      unconfirmedSectionCount: 0,
      planReviewRequired: true,
    });
    company.plans[0].confirmedAt = company.updatedAt;
    expect(summarizeCase(company).attention?.planReviewRequired).toBe(false);
    company.plans[0].review = [
      {
        id: "test",
        severity: "warning",
        category: "confirmation",
        message: "합성",
        action: "합성",
        sectionKey: null,
        sourceIds: [],
      },
    ];
    expect(summarizeCase(company).attention?.planReviewRequired).toBe(true);
  });
  it("처음 기업과 이전 저장형식은 미실행을 표시하고 회사 내용을 목록에 복제하지 않는다", () => {
    const old = { ...company } as Partial<StudioCase>;
    delete old.diagnoses;
    delete old.preparationRuns;
    delete old.agencyRecords;
    const summary = summarizeCase(caseSchema.parse(old));
    expect(summary.attention).toMatchObject({
      diagnosisState: "not_run",
      preparationState: "not_started",
      pendingDueDates: [],
      requestsWithoutSentResponse: 0,
    });
    expect(caseAttentionAt(summary, "2026-09-25").needsAttention).toBe(true);
    expect(summary).not.toHaveProperty("profile");
    expect(summary).not.toHaveProperty("sources");
    expect(summary).not.toHaveProperty("agencyRecords");
    expect(caseAttentionAt({ ...summary, attention: undefined }, "2026-09-25")).toEqual({
      overdue: 0,
      dueSoon: 0,
      nextDueDate: null,
      needsAttention: false,
    });
  });

  it("완료업무 제외·미지정 날짜 보존·오늘과 7일 경계를 기관 기한 추정 없이 계산한다", () => {
    company.tasks = [
      task("2026-10-03"),
      task("2026-09-24"),
      task("2026-10-02"),
      task("2026-09-25"),
      task(""),
      task("2026-09-23", "done"),
    ];
    const summary = summarizeCase(company);
    expect(summary.pendingTaskCount).toBe(5);
    expect(summary.attention?.pendingDueDates).toEqual([
      "2026-09-24",
      "2026-09-25",
      "2026-10-02",
      "2026-10-03",
    ]);
    expect(summary.attention?.undatedTaskCount).toBe(1);
    expect(caseAttentionAt(summary, "2026-09-25")).toMatchObject({
      overdue: 1,
      dueSoon: 2,
      nextDueDate: "2026-09-24",
    });
    expect(JSON.stringify(summary)).not.toContain("비공개");
  });

  it.each(["2026-02-30", "", "bad"])(
    "잘못된 현재 날짜 %s는 지연·임박 수를 추정하지 않는다",
    (today) => {
      company.tasks = [task("2026-01-01")];
      expect(caseAttentionAt(summarizeCase(company), today)).toMatchObject({
        overdue: 0,
        dueSoon: 0,
      });
    },
  );

  it("연도와 윤년 경계를 달력 날짜로 비교한다", () => {
    company.tasks = [task("2027-01-01"), task("2027-01-02")];
    expect(caseAttentionAt(summarizeCase(company), "2026-12-25").dueSoon).toBe(1);
    company.tasks = [task("2028-02-29")];
    expect(caseAttentionAt(summarizeCase(company), "2028-02-22").dueSoon).toBe(1);
  });

  it("최신 요청의 담당자 발송 기록만 대기 수를 바꾸고 정정되면 다시 확인한다", () => {
    const root = request();
    expect(summarizeCase(company).attention?.requestsWithoutSentResponse).toBe(1);
    company = store.mutate(
      company.id,
      {
        action: "append-agency-record",
        revision: company.revision,
        clientRequestId: randomUUID(),
        record: {
          kind: "response",
          requestRecordId: root.id,
          previousVersionId: null,
          responseStatus: "reported-sent",
          title: "합성발송",
          body: "합성비공개답변",
          occurredOn: "2026-09-25",
          note: "",
          sourceIds: [],
        },
      },
      () => [],
    );
    expect(summarizeCase(company).attention?.requestsWithoutSentResponse).toBe(0);
    company = store.mutate(
      company.id,
      {
        action: "append-agency-record",
        revision: company.revision,
        clientRequestId: randomUUID(),
        record: {
          kind: "request-correction",
          requestRecordId: root.id,
          previousVersionId: root.id,
          title: "정정",
          body: "합성정정",
          institution: "합성",
          occurredOn: "",
          dueOn: "",
          dueNote: "",
          note: "",
          sourceIds: [],
        },
      },
      () => [],
    );
    const summary = summarizeCase(company);
    expect(summary.attention?.requestsWithoutSentResponse).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("합성비공개답변");
    expect(company.stage).toBe("preparing");
  });

  it("DB 목록과 저장 뒤 클라이언트 요약이 일치하고 조회는 revision을 바꾸지 않는다", () => {
    request();
    company = store.mutate(
      company.id,
      { action: "task", revision: company.revision, task: task("2026-09-26") },
      () => [],
    );
    const before = store.get(company.id);
    expect(store.list()[0]).toEqual(summarizeCase(before));
    expect(store.get(company.id)).toEqual(before);
    store.create({ ...emptyProfile(), companyName: "합성 다른 회사" });
    const other = store.list().find((entry) => entry.id !== company.id)!;
    expect(other.attention?.requestsWithoutSentResponse).toBe(0);
    expect(other.pendingTaskCount).toBe(0);
  });
});
