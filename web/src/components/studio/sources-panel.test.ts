import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  emptyProfile,
  originalOnlyWarnings,
  type SourceDocument,
  type StudioCase,
} from "@/lib/studio-schema";
import { SourceUploadOptions, SourcesPanel } from "./sources-panel";
import { emptyDiagnosisAnswers } from "@/lib/studio-diagnosis-types";

function checkbox(html: string, id: string) {
  const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
  expect(input).toBeDefined();
  return input!;
}

function options(originalOnly: boolean, allowAi: boolean, aiConfigured = true) {
  const onOriginalOnlyChange = vi.fn();
  const onAllowAiChange = vi.fn();
  const html = renderToStaticMarkup(
    createElement(SourceUploadOptions, {
      originalOnly,
      allowAi,
      aiConfigured,
      onOriginalOnlyChange,
      onAllowAiChange,
    }),
  );
  expect(onOriginalOnlyChange).not.toHaveBeenCalled();
  expect(onAllowAiChange).not.toHaveBeenCalled();
  return html;
}

function source(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "가상 기업 원본 증빙",
    kind: "finance",
    text: "",
    originalName: "sample-evidence.pdf",
    mimeType: "application/pdf",
    extraction: "pending",
    warnings: [...originalOnlyWarnings],
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

function renderSource(document: SourceDocument, blockedReason = "") {
  const mutate = vi.fn();
  const upload = vi.fn();
  const company: StudioCase = {
    id: "11111111-1111-4111-8111-111111111111",
    profile: { ...emptyProfile(), companyName: "가상 시험 기업" },
    sources: [document],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    stageHistory: [],
    agencyRecords: [],
    sourceOcrReviews: [],
    preparationRuns: [],
    appealPreparations: [],
    applications: [],
    applicationEvents: [],
    responsePreparations: [],
    visitAnswers: [],
    planReviewDecisions: [],
    numericChecks: [],
    candidateSelections: [],
    companyContacts: [],
    claimReviews: [],
    sourceIntakes: [],
    sourceSuggestionAdoptions: [],
    applicationProcedures: [],
    criteriaVersions: [],
    applicationCriteriaBindings: [],
    preparationAutomation: { caseId: null, settings: [], events: [], batches: [], overflow: null },
    diagnosisAnswers: emptyDiagnosisAnswers(),
    diagnoses: [],
    revision: 1,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
  const html = renderToStaticMarkup(
    createElement(SourcesPanel, {
      company,
      mutate,
      upload,
      setDirty: vi.fn(),
      supportedFiles: [".pdf", ".docx", ".png"],
      aiConfigured: true,
      blockedReason,
    }),
  );
  expect(mutate).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  return html;
}

describe("원본 전용 자료 보관 안내", () => {
  it("복수 접수의 미저장 파일·교정이 있으면 기존 단일 자료 편집도 잠근다", () => {
    const html = renderSource(source(), "복수 접수 편집을 먼저 마쳐 주세요.");
    expect(html).toContain("복수 접수 편집을 먼저 마쳐 주세요.");
    expect(html).toMatch(/^<fieldset[^>]*disabled=""/);
    expect(html.match(/<button[^>]*aria-label="가상 기업 원본 증빙 수정"[^>]*>/)?.[0]).toContain(
      'disabled=""',
    );
  });
  it("원본만 보관을 선택하면 이전 AI 선택이 있어도 AI는 해제된 비활성 상태다", () => {
    const html = options(true, true);
    expect(checkbox(html, "source-original-only")).toMatch(/\schecked=""/);
    expect(checkbox(html, "source-allow-ai")).toMatch(/\sdisabled=""/);
    expect(checkbox(html, "source-allow-ai")).not.toMatch(/\schecked=""/);
    expect(html).toContain("원본만 보관 — 본문 미추출");
    expect(html).toContain("PDF·PNG·JPG·JPEG·WEBP");
    expect(html).toContain("본문을 추출하거나 AI로 전송하지");
    expect(html).toContain("분석 근거로 사용하지 않습니다");
  });

  it("기본 본문 추출 모드는 AI 연결이 있어도 자동 동의하지 않는다", () => {
    const html = options(false, false);
    expect(checkbox(html, "source-original-only")).not.toMatch(/\schecked=""/);
    expect(checkbox(html, "source-allow-ai")).not.toMatch(/\schecked=""/);
    expect(checkbox(html, "source-allow-ai")).not.toMatch(/\sdisabled=""/);
    expect(html).not.toContain("본문 확인 전에는");
  });

  it("AI가 연결되지 않으면 본문 추출 모드에서도 AI 동의를 사용할 수 없다", () => {
    const html = options(false, false, false);
    expect(checkbox(html, "source-allow-ai")).toMatch(/\sdisabled=""/);
    expect(html).toContain("AI 연결 후 사용할 수 있습니다");
  });

  it("본문 미추출 자료는 0자와 확인 필요 상태를 표시하고 원본 다운로드를 보존한다", () => {
    const html = renderSource(source());
    expect(html).toContain("본문 확인 필요");
    expect(html).toContain("원본만 보관 · 본문 미추출");
    expect(html).toContain("· 0자");
    expect(html).toContain("원본 보관은 분석·검토 완료를 의미하지 않습니다");
    expect(html).toContain(
      "/api/studio/cases/11111111-1111-4111-8111-111111111111/sources/22222222-2222-4222-8222-222222222222",
    );
    expect(html).toContain("가상 기업 원본 증빙 원본 다운로드");
    expect(html).toContain("가상 기업 원본 증빙 수정");
    expect(html).toContain("이 PC에서 글자 읽기");
    expect(html).not.toContain("로컬 글자 읽기 초안 검토");
    expect(html).not.toContain("문서 추출");
    expect(html).not.toContain("AI 추출");
  });

  it("본문을 직접 입력한 자료는 원본을 유지하며 미추출 상태로 표시하지 않는다", () => {
    const html = renderSource(
      source({
        extraction: "manual",
        text: "원문에서 확인한 시험 내용",
        warnings: ["문서 기준일을 확인해 주세요."],
      }),
    );
    expect(html).toContain("직접 입력");
    expect(html).toContain("원문에서 확인한 시험 내용");
    expect(html).toContain("문서 기준일을 확인해 주세요");
    expect(html).toContain("가상 기업 원본 증빙 원본 다운로드");
    expect(html).not.toContain("본문 확인 필요");
    expect(html).not.toContain("이 PC에서 글자 읽기");
    expect(html).not.toContain("원본만 보관 · 본문 미추출");
    expect(html).not.toContain("원본 보관은 분석·검토 완료를 의미하지 않습니다");
  });
  it("pending 이미지도 로컬 글자 읽기를 제공하며 외부 AI 선택을 요구하지 않는다", () => {
    const html = renderSource(source({ originalName: "sample-scan.png", mimeType: "image/png" }));
    expect(html).toContain("이 PC에서 글자 읽기");
    expect(html).not.toContain("글자 읽기 초안 · 미검토");
  });
  it("지원하지 않는 pending 형식에는 글자 읽기 실행 버튼이 없다", () => {
    const html = renderSource(
      source({ originalName: "unknown.bin", mimeType: "application/octet-stream" }),
    );
    expect(html).not.toContain("이 PC에서 글자 읽기");
    expect(html).toContain("본문 확인 필요");
  });
  it.each([null, "application/octet-stream"])(
    "legacy MIME %s의 pending PDF는 글자 읽기 후보로 표시한다",
    (mimeType) => {
      expect(renderSource(source({ mimeType }))).toContain("이 PC에서 글자 읽기");
    },
  );
});
