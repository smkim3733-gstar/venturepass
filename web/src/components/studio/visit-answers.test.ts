import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  caseSchema,
  emptyProfile,
  type StudioCase,
  type SourceDocument,
} from "@/lib/studio-schema";
import { buildVisitAnswer } from "@/lib/studio-visit-answer";
import type { VisitAnswerInput } from "@/lib/studio-visit-answer-types";
import {
  VisitAnswers,
  VisitAnswerView,
  VisitAnswerPairEditor,
  latestVisitAnswers,
  resetVisitReviewAfterEdit,
  visitAnswerDraftText,
  visitAnswerInputFor,
} from "./visit-answers";

const now = "2026-09-25T10:00:00.000Z";
function fixture() {
  const company: StudioCase = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 UI 회사" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [
      {
        id: randomUUID(),
        version: 3,
        mode: "manual",
        generatedAt: now,
        candidateId: "fixture",
        sourceRevision: 0,
        content: {
          title: "검증 계획 v3",
          summary: "요약",
          sections: [
            {
              key: "technology",
              title: "기술",
              content: "실험 10건",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: ["시제품 검증 상태는?", "시제품 검증 상태는?"],
        },
        review: [],
        confirmedAt: null,
      },
    ],
    tasks: [],
    stage: "preparing",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const input = visitAnswerInputFor(company.plans[0], 1);
  input.respondentName = "합성 응답자";
  input.answerText = "실험 12건 진행 중";
  input.pairs = [
    {
      id: randomUUID(),
      answerQuote: "실험 12건",
      planReference: { sectionKey: "technology", quote: "실험 10건" },
      sources: [],
      contextNote: "동일 기간인지 확인",
    },
  ];
  const record = buildVisitAnswer(
    company,
    input,
    {
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: "a".repeat(64),
      recordedAt: now,
    },
    () => {
      throw new Error("No originals in UI fixture");
    },
  );
  return { company, input, record };
}
function panel(company: StudioCase, blockedReason = "") {
  const mutate = vi.fn();
  const html = renderToStaticMarkup(
    createElement(VisitAnswers, { company, mutate, onDirtyChange: vi.fn(), blockedReason }),
  );
  expect(mutate).not.toHaveBeenCalled();
  return html;
}
describe("실사 답변 화면", () => {
  it("starts with explicit plan/question choices and no official claims", () => {
    const { company } = fixture();
    const html = panel(company);
    expect(html).toContain("기준 원고 버전 직접 선택");
    expect(html).toContain("원고의 예상 질문 직접 선택");
    expect(html).toContain("사실 진위·기관 확정 질문·실사 통과를 판정하지 않습니다");
    expect(html).toMatch(/<option value="" selected="">원고 선택/);
    expect(html).toContain("미검토 답변 작성 시작");
  });
  it("shows an empty-state without fabricating questions", () => {
    const { company } = fixture();
    company.plans = [];
    const html = panel(company);
    expect(html).toContain("예상 질문이 있는 원고를 저장하면");
    expect(html).not.toContain("시제품 검증 상태는?");
  });
  it("respects parent dirty/busy blocking", () => {
    const { company } = fixture();
    company.visitAnswers.push(fixture().record);
    const html = panel(company, "기관 기록을 먼저 저장하거나 취소해 주세요.");
    expect(html).toContain("기관 기록을 먼저 저장하거나 취소해 주세요.");
    expect(html).toContain('<fieldset disabled=""');
  });
  it("does not identify repeated question text as the same index", () => {
    const { company } = fixture();
    const first = visitAnswerInputFor(company.plans[0], 0);
    const second = visitAnswerInputFor(company.plans[0], 1);
    expect(first.questionText).toBe(second.questionText);
    expect(first.questionIndex).toBe(0);
    expect(second.questionIndex).toBe(1);
  });
  it("copies a saved answer into a new unreviewed version without refreshing source bindings", () => {
    const { company, record } = fixture();
    record.review = { reviewedAt: now, reviewer: "검토자", note: "과거 검토" };
    const sourceId = randomUUID();
    record.pairs[0].sources = [
      { sourceId, sourceUpdatedAt: "old", quote: "과거 인용", locator: "1쪽" },
    ];
    const next = visitAnswerInputFor(company.plans[0], 0, record);
    expect(next).toMatchObject({
      answerId: record.id,
      previousVersionId: record.id,
      questionIndex: 1,
      review: { reviewed: false, reviewer: "", note: "" },
    });
    expect(next.pairs[0].sources[0].sourceUpdatedAt).toBe("old");
    next.pairs[0].contextNote = "새 메모";
    expect(record.pairs[0].contextNote).not.toBe("새 메모");
  });
  it.each(["answer", "quote", "role", "source", "followup", "submission"])(
    "clears review after editing %s",
    (kind) => {
      const { input, record } = fixture();
      input.answerId = record.id;
      input.previousVersionId = record.id;
      input.review = { reviewed: true, reviewer: "검토자", note: "" };
      const next = structuredClone(input);
      if (kind === "answer") next.answerText += "추가";
      if (kind === "quote") next.pairs[0].answerQuote += "추가";
      if (kind === "role") next.respondentRole = "other";
      if (kind === "source")
        next.pairs[0].sources.push({
          sourceId: randomUUID(),
          sourceUpdatedAt: now,
          quote: "인용",
          locator: "",
        });
      if (kind === "followup") next.followUpNote += "추가";
      if (kind === "submission") next.submissionRecordId = randomUUID();
      expect(resetVisitReviewAfterEdit(input, next).review.reviewed).toBe(false);
      expect(input.review.reviewed).toBe(true);
    },
  );
  it("allows explicit review toggle without immediately undoing it", () => {
    const { input } = fixture();
    const next = { ...input, review: { ...input.review, reviewed: true } };
    expect(resetVisitReviewAfterEdit(input, next).review.reviewed).toBe(true);
  });
  it("groups by immutable answer root and shows previous versions separately", () => {
    const { company, record } = fixture();
    const second = {
      ...record,
      id: randomUUID(),
      previousVersionId: record.id,
      version: 2,
      answerText: "새 답변",
    };
    company.visitAnswers = [record, second];
    expect(latestVisitAnswers(company)).toEqual([second]);
    const html = panel(company);
    expect(html).toContain("이전 답변 버전 1개");
    expect(html).toContain("실사 답변 v1");
    expect(html).toContain("실사 답변 v2");
  });
  it("shows history cap without trimming existing records", () => {
    const { company, record } = fixture();
    company.visitAnswers = Array.from({ length: 100 }, () => ({ ...record, id: randomUUID() }));
    const html = panel(company);
    expect(html).toContain("기업당 답변 버전 100개 한도");
    expect(company.visitAnswers).toHaveLength(100);
  });
  it("prints fixed plan/question snapshots even if the current plan changed", () => {
    const { company, record } = fixture();
    company.plans[0].version = 9;
    company.plans[0].content.title = "현재 다른 제목";
    const text = visitAnswerDraftText(company, record);
    expect(text).toContain("DRAFT · 실사 모의 답변");
    expect(text).toContain("기준 원고: v3 · 검증 계획 v3");
    expect(text).toContain("질문 2: 시제품 검증 상태는?");
    expect(text).not.toContain("기준 원고: v9");
    expect(text).toContain("재확인 필요");
  });
  it("exports only connected sources and saved SHA, with original-only limits clear", () => {
    const { company, record } = fixture();
    const sourceId = randomUUID();
    record.pairs[0].sources = [{ sourceId, sourceUpdatedAt: now, quote: "", locator: "1쪽" }];
    record.sourceSnapshots = [
      {
        sourceId,
        sourceName: "연결한 원본",
        sourceUpdatedAt: now,
        extraction: "pending",
        textSha256: "b".repeat(64),
        original: {
          sourceId,
          sourceName: "연결한 원본",
          originalName: "fixture.pdf",
          mimeType: "application/pdf",
          sha256: "c".repeat(64),
          sizeBytes: 12,
          sourceUpdatedAt: now,
          capturedAt: now,
        },
      },
    ];
    const text = visitAnswerDraftText(company, record);
    expect(text).toContain("자료: 연결한 원본");
    expect(text).toContain("원본만 연결 · 본문 미확인");
    expect(text).toContain(`12 bytes · SHA256 ${"c".repeat(64)}`);
    expect(text).toContain("현재 파일 바이트의 일치를 이 내려받기로 확인하지 않습니다");
  });
  it("does not assert current internal review when a source is missing", () => {
    const { company, record } = fixture();
    record.review = { reviewedAt: now, reviewer: "검토자", note: "" };
    record.pairs[0].sources = [
      { sourceId: randomUUID(), sourceUpdatedAt: now, quote: "인용", locator: "" },
    ];
    const html = renderToStaticMarkup(createElement(VisitAnswerView, { company, record }));
    expect(html).toContain("현재 연결 재확인 필요");
    expect(html).toContain("연결한 자료를 찾을 수 없습니다");
  });
  it("escapes answer/question/metadata HTML as text", () => {
    const { company, record } = fixture();
    record.answerText = '<script>alert("x")</script>';
    record.respondentName = '<img src="x" onerror="alert(1)">';
    const html = renderToStaticMarkup(createElement(VisitAnswerView, { company, record }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('<img src="x"');
    expect(html).toContain("&lt;script&gt;");
  });
  it("pair editor excludes ambiguous plan sections and preserves missing-reference warnings", () => {
    const { company, input } = fixture();
    company.plans[0].content.sections.push(structuredClone(company.plans[0].content.sections[0]));
    const html = renderToStaticMarkup(
      createElement(VisitAnswerPairEditor, {
        company,
        plan: company.plans[0],
        pair: input.pairs[0],
        index: 0,
        onChange: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain("연결한 항목을 고유하게 찾을 수 없습니다");
    expect(html).not.toContain('<option value="technology"');
  });
  it("pair editor displays pending originals without pretending there is extracted text", () => {
    const { company, input } = fixture();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "미판독 원본",
      kind: "other",
      text: "",
      originalName: "fixture.pdf",
      mimeType: "application/pdf",
      extraction: "pending",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    company.sources.push(source);
    input.pairs[0].sources = [
      { sourceId: source.id, sourceUpdatedAt: now, quote: "", locator: "" },
    ];
    const html = renderToStaticMarkup(
      createElement(VisitAnswerPairEditor, {
        company,
        plan: company.plans[0],
        pair: input.pairs[0],
        index: 0,
        onChange: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain("본문 확인 필요 · 원본 파일만 연결할 수 있습니다");
    expect(html).toContain("빈 인용은 보관 원본이 있는 자료에만 허용");
  });
  it("does not mutate supplied input during review reset", () => {
    const { input } = fixture();
    const before: VisitAnswerInput = structuredClone(input);
    resetVisitReviewAfterEdit(input, { ...input, answerText: "새 답변" });
    expect(input).toEqual(before);
  });
});
