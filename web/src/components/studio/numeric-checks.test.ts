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
import { buildNumericCheck } from "@/lib/studio-numeric-check";
import { evaluateNumericCheck, type NumericCheckInput } from "@/lib/studio-numeric-check-types";
import {
  NumericChecks,
  NumericCheckView,
  NumericEvaluationView,
  NumericObservationEditor,
  latestNumericChecks,
  newNumericObservation,
  numericCheckSaveAcknowledged,
  numericDraftText,
  numericInputFor,
  resetNumericJudgementAfterEdit,
} from "./numeric-checks";

const now = "2026-09-25T00:00:00.000Z";
function fixture() {
  const company = caseSchema.parse({
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
        confirmedAt: null,
        review: [],
        content: {
          title: "고정 원고",
          summary: "요약",
          sections: [
            {
              key: "technology",
              title: "수량",
              content: "수량 10개와 20개, 합계 30개입니다.",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: [],
        },
      },
    ],
    tasks: [],
    stage: "preparing",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const input: NumericCheckInput = {
    checkId: null,
    previousVersionId: null,
    title: "합성 수치 대조",
    observations: ["10", "20", "30"].map((valueText, index) => ({
      ...newNumericObservation(),
      label: `수치 ${index + 1}`,
      valueText,
      unit: "item",
      basis: "reported",
      period: { kind: "range", start: "2025-01-01", end: "2025-12-31" },
      reference: {
        kind: "plan",
        planId: company.plans[0].id,
        sectionKey: "technology",
        quote: `${valueText}개`,
      },
    })),
    comparisons: [],
    formulas: [],
    judgement: { state: "unreviewed", reviewer: "", note: "" },
  };
  input.comparisons.push({
    id: randomUUID(),
    leftId: input.observations[0].id,
    rightId: input.observations[1].id,
  });
  input.formulas.push({
    id: randomUUID(),
    operation: "sum",
    operandIds: input.observations.slice(0, 2).map((item) => item.id),
    expectedId: input.observations[2].id,
  });
  const record = buildNumericCheck(
    company,
    input,
    {
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: "a".repeat(64),
      recordedAt: now,
    },
    () => {
      throw new Error("No original in UI fixture");
    },
  );
  return { company, input, record };
}
function panel(company: StudioCase, blockedReason = "") {
  const mutate = vi.fn();
  const html = renderToStaticMarkup(
    createElement(NumericChecks, { company, mutate, blockedReason, onDirtyChange: vi.fn() }),
  );
  expect(mutate).not.toHaveBeenCalled();
  return html;
}
describe("수치 대조 UI", () => {
  it("starts blank with all interpretation categories unknown", () => {
    expect(newNumericObservation()).toMatchObject({
      valueText: "",
      unit: "unknown",
      basis: "unknown",
      reference: null,
      period: { kind: "unknown", start: "", end: "" },
    });
    const value = numericInputFor();
    expect(value.judgement.state).toBe("unreviewed");
    expect(value.observations).toHaveLength(1);
    expect(value.comparisons).toEqual([]);
    expect(value.formulas).toEqual([]);
  });
  it("renders local scope without automatic mutation", () => {
    const { company } = fixture();
    const html = panel(company);
    expect(html).toContain("새 미검토 수치 대조");
    expect(html).toContain("기관 판단·사실 진위·자동 단위 환산은 수행하지 않습니다");
    expect(html).toContain("외부 AI로 전송하지 않습니다");
  });
  it("honors parent busy/dirty blocking", () => {
    const html = panel(fixture().company, "먼저 작성 중인 내용을 저장해 주세요.");
    expect(html).toContain("먼저 작성 중인 내용을 저장해 주세요.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>새 미검토 수치 대조/);
  });
  it("refuses creating more than the history cap without trimming", () => {
    const { company, record } = fixture();
    company.numericChecks = Array.from({ length: 100 }, () => ({ ...record, id: randomUUID() }));
    expect(panel(company)).toContain("수치 대조 버전 100개 한도");
    expect(company.numericChecks).toHaveLength(100);
  });
  it("copies a previous version without silently refreshing its source or judgement", () => {
    const { record } = fixture();
    record.observations[0].reference = {
      kind: "source",
      sourceId: randomUUID(),
      sourceUpdatedAt: "old",
      quote: "10",
      locator: "1쪽",
    };
    record.judgement = {
      state: "reviewed",
      reviewer: "담당자",
      note: "과거 판단",
      recordedAt: now,
    };
    const next = numericInputFor(record);
    expect(next).toMatchObject({
      checkId: record.checkId,
      previousVersionId: record.id,
      judgement: { state: "unreviewed", reviewer: "", note: "" },
    });
    expect(next.observations[0].reference).toMatchObject({ sourceUpdatedAt: "old" });
    next.observations[0].label = "새 이름";
    expect(record.observations[0].label).not.toBe("새 이름");
  });
  it.each(["value", "unit", "basis", "period", "reference", "formula", "comparison", "title"])(
    "clears judgement when changing %s",
    (kind) => {
      const { input } = fixture();
      input.judgement = { state: "reviewed", reviewer: "검토자", note: "판단" };
      const next = structuredClone(input);
      if (kind === "value") next.observations[0].valueText = "11";
      if (kind === "unit") next.observations[0].unit = "unknown";
      if (kind === "basis") next.observations[0].basis = "target";
      if (kind === "period") next.observations[0].period.start = "2024-01-01";
      if (kind === "reference") next.observations[0].reference = null;
      if (kind === "formula") next.formulas[0].operation = "difference";
      if (kind === "comparison") next.comparisons = [];
      if (kind === "title") next.title += " 수정";
      expect(resetNumericJudgementAfterEdit(input, next).judgement.state).toBe("unreviewed");
      expect(input.judgement.state).toBe("reviewed");
    },
  );
  it("preserves an explicit judgement selection when evidence is unchanged", () => {
    const { input } = fixture();
    const next: NumericCheckInput = {
      ...input,
      judgement: { state: "reviewed", reviewer: "검토자", note: "" },
    };
    expect(resetNumericJudgementAfterEdit(input, next).judgement.state).toBe("reviewed");
  });
  it("keeps initial reference and category selection explicit", () => {
    const { company } = fixture();
    const html = renderToStaticMarkup(
      createElement(NumericObservationEditor, {
        company,
        value: newNumericObservation(),
        index: 0,
        onChange: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain('<option value="unknown" selected="">단위 미확인');
    expect(html).toContain('<option value="unknown" selected="">기간 미확인');
    expect(html).toContain('<option value="" selected="">미연결 · 비교 불가로 보관');
    expect(html).toContain("숫자 일부, 지수, 분수, 회계 음수 기호는 변환하지");
  });
  it("marks source pending unavailable and changed bindings require explicit reselection", () => {
    const { company, input } = fixture();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "원본만",
      kind: "other",
      text: "",
      extraction: "pending",
      originalName: "fixture.pdf",
      mimeType: "application/pdf",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    company.sources.push(source);
    const value = {
      ...input.observations[0],
      reference: {
        kind: "source" as const,
        sourceId: source.id,
        sourceUpdatedAt: "old",
        quote: "10",
        locator: "",
      },
    };
    const html = renderToStaticMarkup(
      createElement(NumericObservationEditor, {
        company,
        value,
        index: 0,
        onChange: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain("본문 미추출 (수치 연결 불가)");
    expect(html).toMatch(/<option[^>]*disabled=""[^>]*>원본만/);
    expect(html).toContain("자료가 변경되었습니다");
  });
  it("does not offer ambiguous duplicate plan sections", () => {
    const { company, input } = fixture();
    company.plans[0].content.sections.push({
      ...company.plans[0].content.sections[0],
      title: "중복",
    });
    const html = renderToStaticMarkup(
      createElement(NumericObservationEditor, {
        company,
        value: input.observations[0],
        index: 0,
        onChange: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).not.toContain('<option value="technology"');
  });
  it("shows differing contexts as not comparable instead of numerical agreement", () => {
    const { input } = fixture();
    input.observations[1].valueText = "10";
    input.observations[1].unit = "person";
    const html = renderToStaticMarkup(
      createElement(NumericEvaluationView, { evaluation: evaluateNumericCheck(input) }),
    );
    expect(html).toContain("비교 불가 · 확인 필요");
    expect(html).toContain("단위 표기 다름");
    expect(html).not.toContain("입력 수치 같음");
    expect(html).toContain("사실 진위와 단위·기간의 실제 의미는 확인하지 않았습니다");
  });
  it("displays exact repeating fractions without invented rounding", () => {
    const { input } = fixture();
    input.observations[0].valueText = "1";
    input.observations[1].valueText = "3";
    input.observations[2].unit = "ratio";
    input.observations[2].valueText = "0.333333";
    input.formulas[0].operation = "quotient";
    const html = renderToStaticMarkup(
      createElement(NumericEvaluationView, { evaluation: evaluateNumericCheck(input) }),
    );
    expect(html).toContain("1/3 (분수 그대로 · 반올림 없음)");
    expect(html).toContain("계산값과 입력값 다름");
  });
  it("groups immutable roots and leaves old versions inspectable", () => {
    const { company, record } = fixture();
    const second = { ...record, id: randomUUID(), previousVersionId: record.id, version: 2 };
    company.numericChecks = [record, second];
    expect(latestNumericChecks(company)).toEqual([second]);
    const html = panel(company);
    expect(html).toContain("이전 수치 대조 버전 1개");
    expect(html).toContain("수치 대조 v1");
    expect(html).toContain("수치 대조 v2");
  });
  it("exports frozen version and SHA even if current plan changed", () => {
    const { company, record } = fixture();
    company.plans[0].version = 9;
    const text = numericDraftText(company, record);
    expect(text).toContain("DRAFT · 기간·단위·산식 수치 대조");
    expect(text).toContain("원고: v3 · technology");
    expect(text).not.toContain("원고: v9");
    expect(text).toContain(record.planSnapshots[0].contentSha256);
    expect(text).toContain("재확인 필요");
    expect(text).toContain("파일 바이트를 이 내려받기로 다시 검사하지 않습니다");
  });
  it("escapes recorded user text", () => {
    const { company, record } = fixture();
    record.title = "<script>fixture()</script>";
    const html = renderToStaticMarkup(createElement(NumericCheckView, { company, record }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("수치 대조 저장 응답 검증", () => {
  it("accepts exact single new record and exact appended version", () => {
    const { company, input, record } = fixture();
    company.numericChecks = [record];
    expect(numericCheckSaveAcknowledged(company, company.id, record.clientRequestId, input)).toBe(
      true,
    );
    const next = numericInputFor(record);
    const appended = buildNumericCheck(
      company,
      next,
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: "b".repeat(64),
        recordedAt: now,
      },
      () => {
        throw new Error("No original");
      },
    );
    company.numericChecks.push(appended);
    expect(numericCheckSaveAcknowledged(company, company.id, appended.clientRequestId, next)).toBe(
      true,
    );
  });
  it.each([
    "null",
    "company",
    "nonce",
    "duplicate",
    "root",
    "previous",
    "version",
    "title",
    "value",
    "reference",
    "comparisons",
    "formula",
    "judgement",
    "malformed",
  ])("refuses %s mismatch without claiming save success", (kind) => {
    const { company, input, record } = fixture();
    company.numericChecks = [record];
    if (kind === "company") company.id = randomUUID();
    if (kind === "nonce") record.clientRequestId = randomUUID();
    if (kind === "duplicate") company.numericChecks.push(structuredClone(record));
    if (kind === "root") record.checkId = randomUUID();
    if (kind === "previous") record.previousVersionId = randomUUID();
    if (kind === "version") record.version = 2;
    if (kind === "title") record.title += " 다른 내용";
    if (kind === "value") record.observations[0].valueText = "11";
    if (kind === "reference") record.observations[0].reference = null;
    if (kind === "comparisons") record.comparisons = [];
    if (kind === "formula") record.formulas[0].operation = "difference";
    if (kind === "judgement") record.judgement.note = "다른 메모";
    if (kind === "malformed") record.recordedAt = "invalid";
    const expectedId = kind === "company" ? randomUUID() : company.id;
    const expectedNonce = kind === "nonce" ? randomUUID() : record.clientRequestId;
    expect(
      numericCheckSaveAcknowledged(
        kind === "null" ? null : company,
        expectedId,
        expectedNonce,
        input,
      ),
    ).toBe(false);
  });
});
