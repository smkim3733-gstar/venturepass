import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import type { AgencyNoticeRecord } from "@/lib/studio-agency-records";
import type { AppealPreparation } from "@/lib/studio-appeal-types";
import {
  AppealPreparations,
  AppealPreparationView,
  AppealEvidenceEditor,
  AppealReasonEditor,
  appealDraftText,
  appealInputFor,
  latestDecisionNotices,
  resetAppealReviewAfterEdit,
} from "./appeal-preparation";

const now = "2026-09-25T10:00:00.000Z";
function notice(change: Partial<AgencyNoticeRecord> = {}): AgencyNoticeRecord {
  const id = randomUUID();
  return {
    id,
    noticeRecordId: id,
    clientRequestId: randomUUID(),
    inputDigest: "a".repeat(64),
    kind: "notice",
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: now,
    institution: "합성 평가기관",
    title: "합성 결과",
    body: "기존 설명을 확인할 추가 증빙이 필요합니다.",
    occurredOn: "",
    note: "",
    evidence: [],
    details: {
      category: "decision",
      decisionText: "담당자 기입",
      notifiedOn: "",
      reasons: "개발 근거 부족",
    },
    ...change,
  };
}
function company(record = notice()): StudioCase {
  return caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 시험기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    agencyRecords: [record],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
}
function preparation(entry: AgencyNoticeRecord): AppealPreparation {
  const input = appealInputFor(entry);
  const id = randomUUID();
  input.reasons[0].noticeQuote = "개발 근거 부족";
  input.reasons[0].claim = "기존 설명";
  input.reasons[0].draft = "확인할 사실을 포함한 초안";
  return {
    ...input,
    id,
    preparationId: id,
    version: 1,
    recordedAt: now,
    clientRequestId: randomUUID(),
    inputDigest: "b".repeat(64),
    origin: "manual",
    review: { reviewedAt: null, reviewer: "", note: "" },
    sourceSnapshots: [],
    planSnapshots: [],
  };
}
function renderPanel(record: StudioCase, blockedReason = "") {
  return renderToStaticMarkup(
    createElement(AppealPreparations, {
      company: record,
      mutate: vi.fn(),
      blockedReason,
      onDirtyChange: vi.fn(),
    }),
  );
}

describe("appeal preparation UI", () => {
  it("only starts from latest decision notices and excludes a corrected nondecision", () => {
    const first = notice();
    const second = notice();
    const state = company(first);
    state.agencyRecords.push(
      second,
      notice({
        kind: "notice-correction",
        noticeRecordId: first.id,
        previousVersionId: first.id,
        version: 2,
        details: { category: "receipt", receiptNumber: "", receivedOn: "", statusText: "" },
      }),
    );
    expect(latestDecisionNotices(state).map((item) => item.id)).toEqual([second.id]);
  });
  it("new and revised drafts never inherit a review or invent a deadline", () => {
    const entry = notice();
    const old = preparation(entry);
    old.review = { reviewedAt: now, reviewer: "합성 검토자", note: "이전 검토" };
    const fresh = appealInputFor(entry);
    const revised = appealInputFor(entry, old);
    expect(fresh.intent).toBe("undecided");
    expect(fresh.deadlineOn).toBe("");
    expect(revised.previousVersionId).toBe(old.id);
    expect(revised.preparationId).toBe(old.preparationId);
    expect(revised.review).toEqual({ reviewed: false, reviewer: "", note: "" });
    revised.reasons[0].claim = "새 설명";
    expect(old.reasons[0].claim).toBe("기존 설명");
  });
  it("changing material content clears internal review while reviewer editing does not", () => {
    const input = appealInputFor(notice());
    input.review = { reviewed: true, reviewer: "검토자", note: "" };
    for (const patch of [
      { title: "정정" },
      { deadlineOn: "2026-10-01" },
      { intentNote: "새 판단" },
    ])
      expect(resetAppealReviewAfterEdit(input, { ...input, ...patch }).review.reviewed).toBe(false);
    expect(
      resetAppealReviewAfterEdit(input, {
        ...input,
        review: { ...input.review, note: "검토 메모" },
      }).review.reviewed,
    ).toBe(true);
  });
  it("shows prerequisite without guessing an institutional result", () => {
    const state = company();
    state.agencyRecords = [];
    const html = renderPanel(state);
    expect(html).toContain("심사 결과 원문과 사유를 기록해 주세요");
    expect(html).not.toContain("이 통보의 새 소명 준비");
    expect(html).not.toContain("30일");
  });
  it("blocks duplicate roots and directs the existing chain to a new version", () => {
    const entry = notice();
    const state = company(entry);
    state.appealPreparations = [preparation(entry)];
    const html = renderPanel(state);
    expect(html).toContain("아래 준비안에서 새 버전 작성");
    expect(html).toMatch(/disabled=""[^>]*>아래 준비안에서 새 버전 작성/);
    expect(html).toContain("이 준비안 새 버전 작성");
  });
  it("external editor blocking disables new draft actions", () => {
    const html = renderPanel(company(), "기관 기록 편집 중");
    expect(html).toContain("기관 기록 편집 중");
    expect(html).toMatch(/disabled=""[^>]*>이 통보의 새 소명 준비/);
  });
  it("retains past draft versions and never upgrades review after a corrected notice", () => {
    const entry = notice();
    const state = company(entry);
    const old = preparation(entry);
    old.review = { reviewedAt: now, reviewer: "과거 검토자", note: "" };
    state.agencyRecords.push(
      notice({
        noticeRecordId: entry.id,
        kind: "notice-correction",
        previousVersionId: entry.id,
        version: 2,
      }),
    );
    const html = renderToStaticMarkup(
      createElement(AppealPreparationView, { company: state, record: old }),
    );
    expect(html).toContain("과거 검토 · 현재 내용 재확인 필요");
    expect(html).toContain("현재 파일을 다시 검사한 결과는 아닙니다");
    expect(html).not.toContain("내부 검토: 담당자 검토 기록 있음");
  });
  it("export includes only selected preparation content, not unrelated company data", () => {
    const entry = notice();
    const state = company(entry);
    state.profile.technologySummary = "비선택 기업 비공개 설명";
    const saved = preparation(entry);
    const text = appealDraftText(state, saved);
    expect(text).toContain("DRAFT");
    expect(text).toContain("확인할 사실을 포함한 초안");
    expect(text).toContain("기한: 미확인");
    expect(text).toContain("합성 결과 · 통보 v1");
    expect(text).not.toContain("비선택 기업 비공개 설명");
    expect(text).not.toContain(state.id);
  });
  it("download pins the exact notice and manuscript versions even after notice correction", () => {
    const entry = notice();
    const state = company(entry);
    const saved = preparation(entry);
    const planId = randomUUID();
    saved.reasons[0].planClaim = { planId, sectionKey: "solution", quote: "과거 원고 주장" };
    saved.planSnapshots = [{ planId, version: 2, contentSha256: "a".repeat(64) }];
    state.agencyRecords.push(
      notice({
        noticeRecordId: entry.id,
        kind: "notice-correction",
        previousVersionId: entry.id,
        title: "새 결과",
        version: 2,
      }),
    );
    const text = appealDraftText(state, saved);
    expect(text).toContain("기준 통보: 합성 결과 · 통보 v1");
    expect(text).toContain("원고 v2 · 항목 solution");
    expect(text).not.toContain("기준 통보: 새 결과");
  });
  it("renders exact notice and plan quoting controls with escaped source text", () => {
    const entry = notice({ body: "<script>가상 문자열</script>" });
    const state = company(entry);
    const input = appealInputFor(entry);
    input.reasons[0].noticeField = "body";
    const html = renderToStaticMarkup(
      createElement(AppealReasonEditor, {
        company: state,
        notice: entry,
        reason: input.reasons[0],
        index: 0,
        onChange: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("원문 그대로 인용");
    expect(html).toContain("기존 근거");
    expect(html).toContain("추가 증빙");
  });
  it("changed evidence is not silently rebound and pending source is explicitly unconfirmed", () => {
    const state = company();
    const sourceId = randomUUID();
    state.sources.push({
      id: sourceId,
      name: "합성 스캔",
      kind: "other",
      text: "",
      originalName: "sample.pdf",
      mimeType: "application/pdf",
      extraction: "pending",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    });
    const html = renderToStaticMarkup(
      createElement(AppealEvidenceEditor, {
        company: state,
        prefix: "test",
        label: "추가 증빙",
        references: [{ sourceId, sourceUpdatedAt: "old", quote: "", locator: "" }],
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain("연결 뒤 자료가 변경되었습니다");
    expect(html).toContain("본문 확인 필요");
    expect(html).toContain("원본 파일만 연결");
  });
});
