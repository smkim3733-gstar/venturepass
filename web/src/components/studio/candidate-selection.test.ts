import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  caseSchema,
  emptyProfile,
  planSchema,
  type Candidate,
  type StudioCase,
} from "@/lib/studio-schema";
import type { CandidateSelection } from "@/lib/studio-candidate-selection-types";
import {
  CandidateSelectionEditor,
  CandidateSelectionHistory,
  candidateSelectionAcknowledged,
  candidateSelectionRequest,
} from "./candidate-selection";
import { AnalysisPanel } from "./analysis-panel";
import { PlanEditor } from "./plan-editor";

const companyId = "11111111-1111-4111-8111-111111111111";
const nonce = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-25T00:00:00.000Z";
const candidate: Candidate = {
  id: "candidate-a",
  title: "가상 아이템",
  problem: "가상 문제",
  solution: "가상 해결",
  targetCustomer: "가상 고객",
  differentiation: "검증 필요",
  stage: "개발 중",
  businessModel: "가설",
  recommendation: "자동 추천 설명은 사용자 선택 이유가 아님",
  gaps: ["실증 자료 확인"],
  evidence: [
    { sourceId: "synthetic-source", quote: "당시 인용 <script>실행 금지</script>", locator: "1쪽" },
  ],
};
function company(change: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "가상 선택 기업" },
    sources: [],
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 2,
    createdAt: now,
    updatedAt: now,
    candidateSelections: [],
    analysis: {
      summary: "가상 분석",
      facts: [],
      candidates: [structuredClone(candidate)],
      questions: [],
      warnings: [],
      generatedAt: now,
      sourceRevision: 1,
      mode: "assisted",
    },
    ...change,
  });
}
function selection(change: Partial<CandidateSelection> = {}): CandidateSelection {
  return {
    id: recordId,
    clientRequestId: nonce,
    inputDigest: "a".repeat(64),
    recordedAt: now,
    origin: "manual",
    event: "selection",
    reason: "담당자가 실제 역량을 대조한 이유",
    previousCandidateId: null,
    candidateId: candidate.id,
    analysisGeneratedAt: now,
    analysisSourceRevision: 1,
    analysisMode: "assisted",
    analysisDigest: "b".repeat(64),
    candidateDigest: "c".repeat(64),
    candidate: structuredClone(candidate),
    previousCandidate: null,
    previousContext: "none",
    previousRecordId: null,
    ...change,
  };
}
function saved(change: Partial<StudioCase> = {}) {
  return company({
    revision: 3,
    selectedCandidateId: candidate.id,
    candidateSelections: [selection()],
    ...change,
  });
}

describe("candidate choice request and acknowledgement", () => {
  it("binds exact analysis, prior choice and explicit reason without copying recommendation", () => {
    expect(
      candidateSelectionRequest(company(), candidate.id, "  직접 판단한 이유  ", nonce),
    ).toEqual({
      action: "select-candidate",
      revision: 2,
      clientRequestId: nonce,
      candidateId: candidate.id,
      analysisGeneratedAt: now,
      analysisSourceRevision: 1,
      expectedSelectedCandidateId: null,
      reason: "직접 판단한 이유",
    });
  });
  it.each(["", "   ", "이".repeat(2001)])("rejects missing or overlong reason", (reason) => {
    expect(candidateSelectionRequest(company(), candidate.id, reason, nonce)).toBeNull();
  });
  it("rejects missing analysis, wrong candidate and duplicate candidate IDs", () => {
    expect(
      candidateSelectionRequest(company({ analysis: null }), candidate.id, "이유", nonce),
    ).toBeNull();
    expect(candidateSelectionRequest(company(), "foreign-candidate", "이유", nonce)).toBeNull();
    const record = company();
    record.analysis!.candidates.push(structuredClone(candidate));
    expect(candidateSelectionRequest(record, candidate.id, "이유", nonce)).toBeNull();
  });
  const request = () =>
    candidateSelectionRequest(company(), candidate.id, selection().reason, nonce)!;
  it("accepts a unique current saved record with exact input", () => {
    expect(candidateSelectionAcknowledged(saved(), company(), request())).toBe(true);
  });
  it("rejects another company, old revision, missing/duplicate nonce", () => {
    expect(candidateSelectionAcknowledged(saved({ id: nonce }), company(), request())).toBe(false);
    expect(candidateSelectionAcknowledged(saved({ revision: 1 }), company(), request())).toBe(
      false,
    );
    expect(
      candidateSelectionAcknowledged(saved({ candidateSelections: [] }), company(), request()),
    ).toBe(false);
    expect(
      candidateSelectionAcknowledged(
        saved({ candidateSelections: [selection(), selection({ id: nonce })] }),
        company(),
        request(),
      ),
    ).toBe(false);
  });
  it.each([
    { reason: "다른 이유" },
    { previousCandidateId: "other" },
    { analysisGeneratedAt: "2026-09-26T00:00:00.000Z" },
    { analysisSourceRevision: 99 },
    { analysisMode: "ai" as const },
    { candidateId: "other" },
    { candidate: { ...candidate, solution: "같은 ID의 다른 내용" } },
  ])("rejects wrong persisted context: %j", (change) => {
    expect(
      candidateSelectionAcknowledged(
        saved({ candidateSelections: [selection(change)] }),
        company(),
        request(),
      ),
    ).toBe(false);
  });
  it("does not treat a past saved choice as current after selection changes", () => {
    expect(
      candidateSelectionAcknowledged(saved({ selectedCandidateId: "other" }), company(), request()),
    ).toBe(false);
    expect(candidateSelectionAcknowledged(saved({ analysis: null }), company(), request())).toBe(
      false,
    );
  });
  it("accepts equivalent candidate object key order", () => {
    const reversed = Object.fromEntries(Object.entries(candidate).reverse()) as Candidate;
    const input = company();
    input.analysis!.candidates = [reversed];
    expect(candidateSelectionAcknowledged(saved(), input, request())).toBe(true);
  });
});

describe("choice reason editor and historical presentation", () => {
  it("starts empty and never invokes mutation when rendering", () => {
    const mutate = vi.fn(),
      onClose = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CandidateSelectionEditor, {
        company: company(),
        candidateId: candidate.id,
        mutate,
        onClose,
      }),
    );
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(html).toContain("추천 이유와 별도로 직접 판단한 이유");
    expect(html).not.toContain(candidate.recommendation);
    expect(html).toContain("사실 확인·기관 적합성 판단·원고 검토 완료가 아닙니다");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("shows legacy selected ID without inventing a reason or timestamp", () => {
    const html = renderToStaticMarkup(
      createElement(CandidateSelectionHistory, {
        company: company({ selectedCandidateId: candidate.id }),
      }),
    );
    expect(html).toContain("기존 선택 · 현재 분석에 맞는 선택 이유 기록 없음");
    expect(html).toContain("아직 저장한 선택 이유가 없습니다");
    expect(html).not.toContain("현재 선택의 기록");
  });
  it("preserves historical snapshot and escaped quotes after analysis disappears", () => {
    const html = renderToStaticMarkup(
      createElement(CandidateSelectionHistory, {
        company: saved({ analysis: null, selectedCandidateId: null }),
      }),
    );
    expect(html).toContain(selection().reason);
    expect(html).toContain(candidate.title);
    expect(html).toContain("과거 기록");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("현재 선택의 기록");
  });
  it("labels reason correction separately and keeps previous snapshots", () => {
    const html = renderToStaticMarkup(
      createElement(CandidateSelectionHistory, {
        company: saved({
          candidateSelections: [
            selection({
              event: "reason-recorded",
              previousCandidateId: candidate.id,
              previousContext: "available",
              previousCandidate: { ...candidate, title: "이전 선택 제목" },
            }),
          ],
        }),
      }),
    );
    expect(html).toContain("이유 추가·정정");
    expect(html).toContain("이전 선택 제목");
    expect(html).toContain("현재 선택의 기록");
  });
  it("explains an unavailable prior context and malformed legacy dates without Invalid Date", () => {
    const html = renderToStaticMarkup(
      createElement(CandidateSelectionHistory, {
        company: saved({
          candidateSelections: [
            selection({
              previousCandidateId: "unknown-old",
              previousContext: "unavailable",
              analysisGeneratedAt: "unknown",
            }),
          ],
        }),
      }),
    );
    expect(html).toContain("당시 후보 설명 확인 불가");
    expect(html).toContain("시각 확인 필요");
    expect(html).not.toContain("Invalid Date");
  });
  it("exposes limit without trimming or losing historical records", () => {
    const records = Array.from({ length: 100 }, (_, index) =>
      selection({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }),
    );
    const html = renderToStaticMarkup(
      createElement(CandidateSelectionHistory, {
        company: saved({ candidateSelections: records }),
      }),
    );
    expect(html).toContain("선택 기록 100개 한도");
    expect((html.match(/<article/g) ?? []).length).toBe(100);
  });
  it("keeps the selection history visible when no current analysis exists", () => {
    const mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AnalysisPanel, {
        company: saved({ analysis: null, selectedCandidateId: null }),
        mutate,
        setDirty: vi.fn(),
        generate: vi.fn(),
        goToPlan: vi.fn(),
      }),
    );
    expect(html).toContain("아이템 선택 이유·변경 이력");
    expect(html).toContain(selection().reason);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("offers reason entry for legacy selection and no automatic plan continuation", () => {
    const html = renderToStaticMarkup(
      createElement(AnalysisPanel, {
        company: company({ selectedCandidateId: candidate.id }),
        mutate: vi.fn(),
        setDirty: vi.fn(),
        generate: vi.fn(),
        goToPlan: vi.fn(),
      }),
    );
    expect(html).toContain("선택 이유 기록");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>선택한 아이템으로 사업계획서 작성/);
  });
});

describe("new manuscript generation requires current choice reason", () => {
  function renderPlan(record: StudioCase) {
    const generate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(PlanEditor, {
        company: record,
        mutate: vi.fn(),
        setDirty: vi.fn(),
        generate,
        goToAnalysis: vi.fn(),
        onBusyChange: vi.fn(),
      }),
    );
    return { html, generate };
  }
  const button = (html: string, label: string) =>
    html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((value) => value.includes(label));
  it("blocks generation for a legacy choice and offers reason entry", () => {
    const output = renderPlan(company({ selectedCandidateId: candidate.id }));
    expect(button(output.html, "사업계획서 작성")).toContain('disabled=""');
    expect(output.html).toContain("신청 아이템과 선택 이유를 먼저 확인");
    expect(output.html).toContain("아이템 분석으로 이동");
    expect(output.generate).not.toHaveBeenCalled();
  });
  it("enables generation only for current explicit reason without running it on render", () => {
    const output = renderPlan(saved());
    expect(button(output.html, "사업계획서 작성")).toBeDefined();
    expect(button(output.html, "사업계획서 작성")).not.toContain('disabled=""');
    expect(output.generate).not.toHaveBeenCalled();
  });
  it("preserves old manuscript viewing, download and editing when new generation is blocked", () => {
    const record = company({ selectedCandidateId: candidate.id });
    record.plans.push(
      planSchema.parse({
        id: recordId,
        version: 7,
        candidateId: candidate.id,
        generatedAt: now,
        sourceRevision: 1,
        mode: "manual",
        review: [],
        confirmedAt: null,
        content: {
          title: "과거 원고 보존",
          summary: "과거 요약",
          sections: [
            {
              key: "problem",
              title: "문제",
              content: "보존된 본문",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: [],
        },
      }),
    );
    const output = renderPlan(record);
    expect(button(output.html, "새 버전 작성")).toContain('disabled=""');
    expect(output.html).toContain("기존 원고의 조회·내려받기·직접 편집은 유지");
    expect(output.html).toContain(`export?planId=${recordId}`);
    expect(output.html).toMatch(/<input[^>]*id="plan-title"(?![^>]*disabled)[^>]*>/);
    expect(output.html).toContain("보존된 본문");
    expect(output.generate).not.toHaveBeenCalled();
  });
});
