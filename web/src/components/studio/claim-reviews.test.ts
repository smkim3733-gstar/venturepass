import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import {
  claimReviewRecordSchema,
  type ClaimReviewInput,
  type ClaimReviewRecord,
} from "@/lib/studio-claim-review-types";
import {
  ClaimReviews,
  ClaimReviewFields,
  ClaimReviewRecordView,
  claimReviewInputFor,
  claimReviewSaveAcknowledged,
  resetClaimJudgementAfterEdit,
} from "./claim-reviews";
import { PlanEditor, resolvePlanReviewTarget, type PlanReviewTarget } from "./plan-editor";

const id = (number: number) => `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = "2026-09-25T00:00:00.000Z";
const quote = "합성 제품은 연간 100개를 공급할 계획입니다.";
function company(): StudioCase {
  return caseSchema.parse({
    id: id(1),
    revision: 4,
    createdAt: now,
    updatedAt: now,
    profile: { ...emptyProfile(), companyName: "합성 주장 기업" },
    sources: [
      {
        id: id(4),
        name: "저장 당시 자료",
        kind: "technology",
        text: quote,
        originalName: "synthetic.pdf",
        mimeType: "application/pdf",
        extraction: "manual",
        warnings: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "drafting",
    plans: [1, 2].map((version) => ({
      id: id(version + 1),
      version,
      generatedAt: now,
      mode: "manual",
      candidateId: "synthetic",
      sourceRevision: 4,
      content: {
        title: `합성 원고 ${version}`,
        summary: "",
        sections: [
          {
            key: "growth",
            title: "성장 계획",
            content: quote,
            evidence: [],
            needsConfirmation: true,
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
      review: [],
      confirmedAt: null,
    })),
  });
}
function input(): ClaimReviewInput {
  return {
    ...claimReviewInputFor(),
    planId: id(2),
    planVersion: 1,
    sectionKey: "growth",
    claimQuote: quote,
    nature: "future-plan",
    references: [{ sourceId: id(4), sourceUpdatedAt: now, quote, locator: "합성 p1" }],
  };
}
function record(overrides: Partial<ClaimReviewRecord> = {}): ClaimReviewRecord {
  return claimReviewRecordSchema.parse({
    ...input(),
    id: id(5),
    claimId: id(5),
    previousVersionId: null,
    version: 1,
    clientRequestId: id(6),
    inputDigest: "a".repeat(64),
    origin: "manual",
    recordedAt: now,
    judgement: { ...input().judgement, recordedAt: null },
    sourceSnapshots: [
      {
        sourceId: id(4),
        sourceName: "저장 당시 자료",
        sourceUpdatedAt: now,
        extraction: "manual",
        textSha256: "b".repeat(64),
        original: {
          sourceId: id(4),
          sourceName: "저장 당시 자료",
          originalName: "synthetic.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
          sha256: "c".repeat(64),
          capturedAt: now,
          sourceUpdatedAt: now,
        },
      },
    ],
    planSnapshots: [{ planId: id(2), version: 1, contentSha256: "d".repeat(64) }],
    auxiliarySnapshots: [],
    ...overrides,
  });
}
function approvedRecord(): ClaimReviewRecord {
  return record({
    id: id(7),
    previousVersionId: id(5),
    version: 2,
    method: "document",
    judgement: {
      state: "consistent",
      reviewer: "합성 검토자",
      reason: "선택한 원문을 대조한 담당자 판단",
      checkedOn: "2026-09-25",
      recordedAt: now,
    },
  });
}
const panel = (state = company(), blockedReason = "") =>
  renderToStaticMarkup(
    createElement(ClaimReviews, {
      company: state,
      mutate: vi.fn(),
      onDirtyChange: vi.fn(),
      blockedReason,
    }),
  );
const fields = (value = input(), state = company()) =>
  renderToStaticMarkup(
    createElement(ClaimReviewFields, { company: state, value, onChange: vi.fn() }),
  );

describe("claim editor exact bindings and reset", () => {
  it("starts with no inferred manuscript, quote, source or judgement", () => {
    const next = claimReviewInputFor();
    expect(next.planId).toBe("");
    expect(next.sectionKey).toBe("");
    expect(next.references).toEqual([]);
    expect(next.judgement).toEqual({
      state: "unreviewed",
      reviewer: "",
      reason: "",
      checkedOn: "",
    });
    expect(fields(next)).toContain('value="" selected=""');
    expect(fields(next)).toContain("최초 주장은 미검토로 저장");
    expect(fields(next)).not.toContain("이번 버전의 담당자 판단");
  });
  it("copies prior exact references but clears the entire old judgement", () => {
    const prior = approvedRecord(),
      next = claimReviewInputFor(prior);
    expect(next.claimId).toBe(id(5));
    expect(next.previousVersionId).toBe(id(7));
    expect(next.planId).toBe(id(2));
    expect(next.references).toEqual(prior.references);
    expect(next.judgement).toEqual({
      state: "unreviewed",
      reviewer: "",
      reason: "",
      checkedOn: "",
    });
    next.references[0].quote = "사본 편집";
    expect(prior.references[0].quote).toBe(quote);
  });
  it.each<Partial<ClaimReviewInput>>([
    { claimQuote: "다른 문장" },
    { planId: id(3), planVersion: 2 },
    { nature: "current-claim" },
    { references: [{ ...input().references[0], sourceUpdatedAt: "2026-09-26T00:00:00.000Z" }] },
    { references: [] },
    { contextNote: "단위 정정" },
    { dueOn: "2026-10-01" },
    { owner: "다른 담당자" },
    { method: "multiple" },
    { externalCheck: { target: "직접 확인 대상", content: "메모", occurredOn: "2026-09-25" } },
    { numericReferences: [{ id: id(8), version: 1 }] },
    { planReviewReferences: [{ id: id(9), version: 1 }] },
  ])("resets prior judgement when its context changes: %j", (patch) => {
    const value = {
      ...claimReviewInputFor(approvedRecord()),
      judgement: {
        state: "consistent" as const,
        reviewer: "담당자",
        reason: "대조 기록",
        checkedOn: "2026-09-25",
      },
    };
    expect(resetClaimJudgementAfterEdit(value, { ...value, ...patch }).judgement).toEqual(
      input().judgement,
    );
  });
  it("allows explicit judgement entry without resetting judgement-only changes", () => {
    const value = claimReviewInputFor(approvedRecord());
    const next = {
      ...value,
      judgement: {
        state: "conflict" as const,
        reviewer: "검토자",
        reason: "수치 표기 상충",
        checkedOn: "2026-09-25",
      },
    };
    expect(resetClaimJudgementAfterEdit(value, next)).toEqual(next);
  });
  it("fixes root section while offering an explicit new plan and no automatic semantics", () => {
    const html = fields(claimReviewInputFor(approvedRecord()));
    expect(html).toMatch(/<select[^>]+id="[^"]+-section"[^>]*disabled=""/);
    expect(html).toContain("원고 v2");
    expect(html).toContain("재연결만으로 의미가 같다고 확인하지 않습니다");
    expect(html.match(/type="date"/g)).toHaveLength(3);
  });
  it("excludes duplicate section keys and disables duplicate manuscript ids", () => {
    const state = company();
    state.plans[0].content.sections.push({ ...state.plans[0].content.sections[0] });
    expect(fields(input(), state)).toContain("선택한 원고·항목을 고유하게 찾을 수 없습니다");
    state.plans.push(structuredClone(state.plans[0]));
    const html = fields(input(), state);
    expect(html).toMatch(new RegExp(`<option value="${id(2)}" disabled=""`));
  });
  it("keeps missing exact auxiliary references visible instead of replacing with latest", () => {
    const html = fields({ ...input(), numericReferences: [{ id: id(10), version: 4 }] });
    expect(html).toContain("기존에 선택한 참고 버전을 고유하게 찾을 수 없습니다");
    expect(html).toContain("최신 기록으로 자동 대체하지 않습니다");
  });
  it("shows original-only source boundaries and retains exact stale source timestamp", () => {
    const state = company();
    state.sources[0].extraction = "pending";
    state.sources[0].text = "";
    state.sources[0].updatedAt = "2026-09-26T00:00:00.000Z";
    const value = { ...input(), references: [{ ...input().references[0], quote: "" }] };
    const html = fields(value, state);
    expect(html).toContain("본문 확인 필요 · 원본 파일만 연결할 수 있습니다");
    expect(html).toContain("연결 뒤 자료가 변경되었습니다");
    expect(value.references[0].sourceUpdatedAt).toBe(now);
  });
});

describe("claim save acknowledgement", () => {
  it("accepts exact first save and normalized role fields", () => {
    const response = company();
    response.revision++;
    response.claimReviews = [record({ owner: "담당자" })];
    expect(
      claimReviewSaveAcknowledged(response, company(), id(6), { ...input(), owner: " 담당자 " }),
    ).toBe(true);
  });
  it("accepts exact latest parent and explicit manuscript reconnection", () => {
    const prior = approvedRecord(),
      state = company();
    state.claimReviews = [record(), prior];
    const next = { ...claimReviewInputFor(prior), planId: id(3), planVersion: 2 };
    const saved = record({
      ...next,
      id: id(8),
      claimId: id(5),
      version: 3,
      judgement: { ...next.judgement, recordedAt: null },
      planSnapshots: [{ planId: id(3), version: 2, contentSha256: "e".repeat(64) }],
    });
    const response = { ...state, revision: 5, claimReviews: [...state.claimReviews, saved] };
    // Earlier records have distinct request identifiers.
    response.claimReviews[0].clientRequestId = id(11);
    response.claimReviews[1].clientRequestId = id(12);
    expect(claimReviewSaveAcknowledged(response, state, id(6), next)).toBe(true);
  });
  it.each([
    "null",
    "company",
    "revision",
    "nonce",
    "duplicate",
    "parent",
    "version",
    "quote",
    "plan",
    "judgement",
    "malformed",
  ])("retains edits for mismatched %s result", (kind) => {
    const state = company(),
      response = company();
    response.claimReviews = [record()];
    if (kind === "null") {
      expect(claimReviewSaveAcknowledged(null, state, id(6), input())).toBe(false);
      return;
    }
    if (kind === "company") response.id = id(20);
    if (kind === "revision") response.revision = 0;
    if (kind === "nonce") response.claimReviews[0].clientRequestId = id(20);
    if (kind === "duplicate") response.claimReviews.push(record({ id: id(20) }));
    if (kind === "parent") response.claimReviews[0].previousVersionId = id(20);
    if (kind === "version") response.claimReviews[0].version = 2;
    if (kind === "quote") response.claimReviews[0].claimQuote = "다른 문장";
    if (kind === "plan") response.claimReviews[0].planId = id(3);
    if (kind === "judgement") response.claimReviews[0].judgement.reason = "서버와 다른 내용";
    if (kind === "malformed") response.claimReviews[0].origin = "automatic" as "manual";
    expect(claimReviewSaveAcknowledged(response, state, id(6), input())).toBe(false);
  });
});

describe("saved claim context and history UI", () => {
  it("uses immutable historical evidence when current names and contents change", () => {
    const state = company();
    state.sources[0].name = "지금 다른 자료명";
    state.sources[0].text = "지금 다른 본문";
    const prior = approvedRecord();
    const html = renderToStaticMarkup(
      createElement(ClaimReviewRecordView, { company: state, record: prior }),
    );
    expect(html).toContain("저장 당시 자료");
    expect(html).not.toContain("지금 다른 자료명");
    expect(html).not.toContain("지금 다른 본문");
    expect(html).toContain("연결 문맥 재확인 필요");
    expect(html).toContain("일치한다고 판단 (담당자)");
    expect(html).toContain("저장 당시 기록이며 현재 근거의 판단으로 이어지지 않습니다");
    expect(html).toContain("synthetic.pdf");
    expect(html).toContain("c".repeat(64));
    expect(html).toContain(`id="claim-review-${prior.id}"`);
  });
  it("labels current metadata without claiming current byte or truth verification", () => {
    const html = renderToStaticMarkup(
      createElement(ClaimReviewRecordView, { company: company(), record: record() }),
    );
    expect(html).toContain("현재 원본 파일을 다시 읽거나 사실을 검증한 결과는 아닙니다");
    expect(html).toContain("원본만 연결한 자료는 본문 검토 완료가 아닙니다");
    expect(html).not.toContain("href=");
  });
  it("escapes saved user text and preserves prior exact auxiliary version metadata", () => {
    const saved = record({
      claimQuote: "<script>bad()</script>",
      owner: "<img src=x>",
      auxiliarySnapshots: [
        {
          kind: "numeric",
          id: id(10),
          version: 4,
          inputDigest: "e".repeat(64),
          contentSha256: "f".repeat(64),
          recordedAt: now,
        },
      ],
    });
    const html = renderToStaticMarkup(
      createElement(ClaimReviewRecordView, { company: company(), record: saved }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img ");
    expect(html).toContain("수치 대조");
    expect(html).toContain("v4");
    expect(html).toContain("f".repeat(64));
  });
  it("keeps all history anchors and shows newest roots without automatic requests", () => {
    const state = company();
    state.claimReviews = [record(), approvedRecord()];
    const mutate = vi.fn(),
      onDirtyChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ClaimReviews, { company: state, mutate, onDirtyChange }),
    );
    expect(html).toContain("과거 주장 검토 1개 버전");
    expect(html).toContain(`id="claim-review-${id(5)}"`);
    expect(html).toContain(`id="claim-review-${id(7)}"`);
    expect(mutate).not.toHaveBeenCalled();
    expect(onDirtyChange).not.toHaveBeenCalled();
  });
  it("blocks all editor entry under sibling edits and preserves record cap", () => {
    expect(panel(company(), "원고 편집 중")).toMatch(
      /<button[^>]*disabled=""[^>]*>새 주장·근거 기록/,
    );
    const state = company();
    state.claimReviews = Array.from({ length: 200 }, (_, index) =>
      record({ id: id(100 + index), claimId: id(100 + index) }),
    );
    const html = panel(state);
    expect(html).toContain("200개 버전 한도");
    expect(html).toContain("과거 이력을 보존");
    expect(state.claimReviews).toHaveLength(200);
  });
});

describe("exact review target navigation and PlanEditor mount", () => {
  function target(): PlanReviewTarget {
    return {
      companyId: id(1),
      revision: 4,
      planId: id(2),
      sectionKey: "growth",
      recordKind: "claim",
      recordId: id(5),
    };
  }
  it("resolves the specified old manuscript and claim, not the newest root or manuscript", () => {
    const state = company();
    state.claimReviews = [record(), approvedRecord()];
    const result = resolvePlanReviewTarget(state, target());
    expect(result?.plan?.version).toBe(1);
    expect(result?.anchor).toBe(`claim-review-${id(5)}`);
    const html = renderToStaticMarkup(
      createElement(PlanEditor, {
        company: state,
        mutate: vi.fn(),
        setDirty: vi.fn(),
        generate: vi.fn(),
        goToAnalysis: vi.fn(),
        onBusyChange: vi.fn(),
        reviewTarget: target(),
      }),
    );
    expect(html).toContain("지정한 원고 v1");
    expect(html).toContain("주장·근거 검토 기록");
    expect(html).toContain(`value="${id(2)}" selected=""`);
  });
  it.each([
    "company",
    "revision",
    "plan",
    "section",
    "claim",
    "duplicate-plan",
    "duplicate-section",
    "duplicate-claim",
  ])("rejects invalid target %s without latest fallback", (kind) => {
    const state = company();
    state.claimReviews = [record()];
    const value = target();
    if (kind === "company") value.companyId = id(30);
    if (kind === "revision") value.revision++;
    if (kind === "plan") value.planId = id(30);
    if (kind === "section") value.sectionKey = "missing";
    if (kind === "claim") value.recordId = id(30);
    if (kind === "duplicate-plan") state.plans.push(structuredClone(state.plans[0]));
    if (kind === "duplicate-section")
      state.plans[0].content.sections.push({ ...state.plans[0].content.sections[0] });
    if (kind === "duplicate-claim") state.claimReviews.push(record());
    expect(resolvePlanReviewTarget(state, value)).toEqual({
      valid: false,
      plan: null,
      sectionKey: "",
      anchor: null,
    });
  });
  it("shows an invalid target warning and explicit manual choice, not a selected latest draft", () => {
    const state = company();
    const html = renderToStaticMarkup(
      createElement(PlanEditor, {
        company: state,
        mutate: vi.fn(),
        setDirty: vi.fn(),
        generate: vi.fn(),
        goToAnalysis: vi.fn(),
        onBusyChange: vi.fn(),
        reviewTarget: target(),
      }),
    );
    expect(html).toContain("최신 원고로 자동 대체하지 않습니다");
    expect(html).toContain("보려는 저장 원고 직접 선택");
    expect(html).not.toContain('id="plan-title"');
  });
});
