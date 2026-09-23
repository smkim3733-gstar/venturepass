import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { parseMock, constructorMock } = vi.hoisted(() => ({
  parseMock: vi.fn(),
  constructorMock: vi.fn(),
}));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: parseMock };
    constructor(options: unknown) {
      constructorMock(options);
    }
  },
}));

import { analyzeCompany, generatePlan, getAiStatus, reviewPlan } from "./studio-engine";
import {
  emptyProfile,
  sectionDefinitions,
  type AnalysisContent,
  type PlanContent,
  type StudioCase,
} from "./studio-schema";

const sourceId = "1e410c7d-f7f3-4ee8-977f-bbf9f1135841";
function fixture(): StudioCase {
  return {
    id: "af3915aa-353a-45ec-9331-73c5bb3b25c3",
    profile: {
      ...emptyProfile(),
      companyName: "검증용 기업",
      technologySummary: "금형 냉각 유로를 설계하는 기술을 개발 중입니다.",
      customers: "금형 제조기업을 대상으로 고객 인터뷰를 진행할 계획입니다.",
      foundedOn: "2024-03-01",
      applicationDate: "2026-09-22",
      developmentPlan: "2027년 시제품 검증을 계획하고 있습니다.",
    },
    sources: [
      {
        id: sourceId,
        name: "기술 설명 메모",
        kind: "technology",
        text: "시제품 냉각 구조를 개발 중이다. 성능시험은 아직 진행하지 않았다.",
        originalName: null,
        mimeType: null,
        extraction: "manual",
        warnings: [],
        createdAt: "2026-09-22",
        updatedAt: "2026-09-22",
      },
    ],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 1,
    createdAt: "2026-09-22",
    updatedAt: "2026-09-22",
  };
}

function aiAnalysis(value = fixture()): AnalysisContent {
  return {
    summary: "금형 냉각 설계 기술을 중심으로 신청 준비가 가능합니다. 개발 단계 확인이 필요합니다.",
    facts: [
      {
        id: "fact-1",
        statement: value.profile.technologySummary,
        status: "reported",
        evidence: [
          {
            sourceId: "profile",
            quote: value.profile.technologySummary,
            locator: "기술·제품 설명",
          },
        ],
      },
    ],
    candidates: [
      {
        id: "candidate-1",
        title: "금형 냉각 유로 설계",
        problem: "고객 문제 확인 필요",
        solution: value.profile.technologySummary,
        targetCustomer: "금형 제조기업",
        differentiation: "시험 비교가 필요합니다.",
        stage: "개발 중",
        businessModel: "확인 필요",
        recommendation: "기술 원리를 확인할 수 있는 설명자료가 있습니다.",
        evidence: [{ sourceId, quote: value.sources[0].text, locator: "기술 설명 메모" }],
        gaps: ["시험 조건과 비교 결과를 확인해 주세요."],
      },
    ],
    questions: [
      {
        id: "q-1",
        question: "언제 시제품을 검증하나요?",
        reason: "완료와 계획을 구분하기 위해 필요합니다.",
        priority: "high",
      },
    ],
    warnings: [],
  };
}

function validPlan(value = fixture()): PlanContent {
  return {
    title: "금형 냉각 유로 설계 사업계획서",
    summary: "작성 초안입니다.",
    sections: sectionDefinitions.map(({ key, title }) => ({
      key,
      title,
      content: value.profile.technologySummary,
      evidence: [
        { sourceId: "profile", quote: value.profile.technologySummary, locator: "기술·제품 설명" },
      ],
      needsConfirmation: false,
    })),
    actionItems: [],
    interviewQuestions: [],
  };
}

beforeEach(() => {
  parseMock.mockReset();
  constructorMock.mockReset();
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_MODEL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("assisted company analysis and plan assembly", () => {
  it("uses actual company statements and valid citations without making an AI request", async () => {
    const value = fixture();
    const result = await analyzeCompany(value, "assisted");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].solution).toBe(value.profile.technologySummary);
    expect(
      result.facts.find((fact) => fact.statement === value.profile.developmentPlan)?.status,
    ).toBe("planned");
    expect(result.facts.find((fact) => fact.evidence[0].sourceId === sourceId)?.status).toBe(
      "reported",
    );
    expect(result.summary).toContain("신규 · 3년 미만");
    expect(result.warnings[0]).toContain("자료 정리 모드");
    expect(constructorMock).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("does not invent a candidate from company name or finance data alone", async () => {
    const value = fixture();
    value.profile.technologySummary = "";
    value.profile.financials = "매출 관련 자료를 준비하고 있습니다.";
    value.sources = [];
    const result = await analyzeCompany(value, "assisted");
    expect(result.candidates).toHaveLength(0);
    expect(result.questions.some((question) => question.id === "question-solution")).toBe(true);
    expect(result.warnings.join(" ")).toContain("기술 설명이 없습니다");
  });

  it("preserves exact quotes with CRLF and correctly identifies the third anniversary", async () => {
    const value = fixture();
    value.profile.technologySummary = "  냉각 유로 설계 기술.\r\n두 번째 설명입니다.  ";
    value.profile.applicationDate = "2027-03-01";
    const result = await analyzeCompany(value, "assisted");
    expect(result.summary).toContain("신규 · 3년 이상");
    for (const fact of result.facts)
      for (const ref of fact.evidence) {
        const text =
          ref.sourceId === "profile"
            ? Object.values(value.profile).join("\n")
            : value.sources[0].text;
        expect(text).toContain(ref.quote);
      }
  });

  it("does not guess age from malformed dates and includes renewal-specific questions", async () => {
    const value = fixture();
    value.profile.foundedOn = "2024-02-31";
    expect((await analyzeCompany(value, "assisted")).summary).toContain("구분하지 않았습니다");
    value.profile.applicationKind = "renewal";
    const result = await analyzeCompany(value, "assisted");
    expect(result.summary).toContain("재확인");
    expect(result.questions.some((question) => question.id === "question-renewal")).toBe(true);
  });

  it("creates ten distinct sections with targeted gaps and valid sources for a renewal", async () => {
    const value = fixture();
    value.profile.applicationKind = "renewal";
    const analysis = await analyzeCompany(value, "assisted");
    const content = await generatePlan(value, analysis.candidates[0], "assisted");
    expect(content.sections.map(({ key }) => key)).toEqual(
      sectionDefinitions.map(({ key }) => key),
    );
    expect(content.sections.every((section) => section.needsConfirmation)).toBe(true);
    expect(content.sections.find((section) => section.key === "performance")?.content).toContain(
      "최근 3년",
    );
    expect(content.actionItems.length).toBeGreaterThanOrEqual(10);
    expect(
      reviewPlan(value, content).filter((finding) => finding.category === "invalid-reference"),
    ).toHaveLength(0);
  });
});

describe("explicit AI mode and structured output validation", () => {
  it("reports configuration without exposing credentials and never falls back silently", async () => {
    expect(getAiStatus()).toEqual({ aiConfigured: false, model: "gpt-5.4" });
    await expect(analyzeCompany(fixture(), "ai")).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
      status: 503,
    });
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("uses server credentials, requested model, nonstored responses and an untrusted-data instruction", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-local-key");
    vi.stubEnv("OPENAI_MODEL", "configured-model");
    const value = fixture();
    value.profile.businessNumber = "PRIVATE-BUSINESS-NUMBER";
    parseMock.mockResolvedValue({ status: "completed", output_parsed: aiAnalysis(value) });
    const result = await analyzeCompany(value, "ai");
    expect(result.candidates[0].title).toBe("금형 냉각 유로 설계");
    expect(constructorMock).toHaveBeenCalledWith({
      apiKey: "test-local-key",
      timeout: 120000,
      maxRetries: 1,
    });
    const request = parseMock.mock.calls[0][0];
    expect(request).toMatchObject({
      model: "configured-model",
      store: false,
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(request.input[0].content).toContain("신뢰할 수 없는 참고 데이터");
    expect(request.input[1].content).not.toContain("PRIVATE-BUSINESS-NUMBER");
    expect(request.input[1].content).not.toContain("test-local-key");
  });

  it.each(["unknown-source", "invented-quote"])(
    "rejects %s citations instead of displaying apparent evidence",
    async (kind) => {
      vi.stubEnv("OPENAI_API_KEY", "test");
      const content = aiAnalysis();
      if (kind === "unknown-source") content.facts[0].evidence[0].sourceId = "not-real";
      else content.facts[0].evidence[0].quote = "특허 등록과 시험 검증을 완료했다.";
      parseMock.mockResolvedValue({ status: "completed", output_parsed: content });
      await expect(analyzeCompany(fixture(), "ai")).rejects.toMatchObject({
        code: "AI_INVALID_EVIDENCE",
      });
    },
  );

  it("rejects duplicated candidate IDs and marks facts without evidence unverified", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const duplicate = aiAnalysis();
    duplicate.candidates.push(duplicate.candidates[0]);
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: duplicate });
    await expect(analyzeCompany(fixture(), "ai")).rejects.toMatchObject({
      code: "AI_INVALID_ANALYSIS",
    });
    const noEvidence = aiAnalysis();
    noEvidence.facts[0].evidence = [];
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: noEvidence });
    expect((await analyzeCompany(fixture(), "ai")).facts[0].status).toBe("unverified");
  });

  it("rejects oversized input before transmission", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const value = fixture();
    value.sources = Array.from({ length: 3 }, (_, index) => ({
      ...value.sources[0],
      id: `source-${index}`,
      text: "가".repeat(100000),
    }));
    await expect(analyzeCompany(value, "ai")).rejects.toMatchObject({
      code: "AI_INPUT_TOO_LARGE",
      status: 413,
    });
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("handles refusal, incomplete response and upstream errors without leaking server data", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: null });
    await expect(analyzeCompany(fixture(), "ai")).rejects.toMatchObject({ code: "AI_INCOMPLETE" });
    parseMock.mockResolvedValueOnce({ status: "incomplete", output_parsed: aiAnalysis() });
    await expect(analyzeCompany(fixture(), "ai")).rejects.toMatchObject({ code: "AI_INCOMPLETE" });
    parseMock.mockRejectedValueOnce(new Error("secret upstream content test-local-key"));
    await expect(analyzeCompany(fixture(), "ai")).rejects.toMatchObject({
      code: "AI_REQUEST_FAILED",
      message: expect.not.stringContaining("secret upstream"),
    });
  });

  it("rejects incomplete AI plans and invented quotes, and retains flags for ungrounded figures", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const missing = validPlan();
    missing.sections.pop();
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: missing });
    await expect(generatePlan(fixture(), aiAnalysis().candidates[0], "ai")).rejects.toMatchObject({
      code: "AI_INVALID_PLAN",
    });
    const invented = validPlan();
    invented.sections[0].evidence[0].quote = "매출 100억원을 달성했다.";
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: invented });
    await expect(generatePlan(fixture(), aiAnalysis().candidates[0], "ai")).rejects.toMatchObject({
      code: "AI_INVALID_EVIDENCE",
    });
    const numeric = validPlan();
    numeric.sections[0].content += " 성능 90% 향상을 목표로 제안합니다.";
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: numeric });
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: { findings: [] } });
    const content = await generatePlan(fixture(), aiAnalysis().candidates[0], "ai");
    expect(content.sections[0].needsConfirmation).toBe(true);
  });

  it("runs an independent semantic review and adds clearly marked review actions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: validPlan() });
    parseMock.mockResolvedValueOnce({
      status: "completed",
      output_parsed: {
        findings: [
          {
            id: "ai-review-1",
            severity: "warning",
            category: "timeline",
            message: "시제품 검증 일정과 개발인력 투입 일정의 정합성을 확인해야 합니다.",
            action: "개발인력 투입 시점을 추가해 주세요.",
            sectionKey: "development",
            sourceIds: ["profile"],
          },
        ],
      },
    });
    const result = await generatePlan(fixture(), aiAnalysis().candidates[0], "ai");
    expect(parseMock).toHaveBeenCalledTimes(2);
    expect(parseMock.mock.calls[1][0].text.format.name).toBe("business_plan_review");
    expect(
      result.sections.find((section) => section.key === "development")?.needsConfirmation,
    ).toBe(true);
    expect(result.actionItems[0]).toContain("[AI 검토 의견");
    expect(result.actionItems[0]).toContain("개발인력 투입 시점을 추가");
  });

  it("does not return a draft when the independent review fails or cites unknown sources", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: validPlan() });
    parseMock.mockRejectedValueOnce(new Error("review unavailable"));
    await expect(generatePlan(fixture(), aiAnalysis().candidates[0], "ai")).rejects.toMatchObject({
      code: "AI_REQUEST_FAILED",
    });
    parseMock.mockResolvedValueOnce({ status: "completed", output_parsed: validPlan() });
    parseMock.mockResolvedValueOnce({
      status: "completed",
      output_parsed: {
        findings: [
          {
            id: "ai-review-1",
            severity: "warning",
            category: "contradiction",
            message: "자료가 상충합니다.",
            action: "자료를 확인해 주세요.",
            sectionKey: "development",
            sourceIds: ["unknown-source"],
          },
        ],
      },
    });
    await expect(generatePlan(fixture(), aiAnalysis().candidates[0], "ai")).rejects.toMatchObject({
      code: "AI_INVALID_REVIEW",
    });
  });

  it("rejects approval guarantees in AI results", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const invalid = aiAnalysis();
    invalid.summary = "반드시 통과하는 기업입니다.";
    parseMock.mockResolvedValue({ status: "completed", output_parsed: invalid });
    await expect(analyzeCompany(fixture(), "ai")).rejects.toMatchObject({
      code: "AI_INVALID_CLAIM",
    });
  });
});

describe("deterministic submission review", () => {
  it("does not misread a quoted guarantee inside a warning as the app's own claim", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const content = aiAnalysis();
    content.warnings = ["자료의 '반드시 통과'라는 표현은 근거로 사용할 수 없습니다."];
    parseMock.mockResolvedValue({ status: "completed", output_parsed: content });
    expect((await analyzeCompany(fixture(), "ai")).warnings[0]).toContain(
      "근거로 사용할 수 없습니다",
    );
    const plan = validPlan();
    plan.actionItems = ["기존 문서의 '무조건 통과' 표현을 제거했는지 확인해 주세요."];
    expect(reviewPlan(fixture(), plan).some((finding) => finding.category === "guarantee")).toBe(
      false,
    );
  });
  it("detects deleted evidence, duplicate and missing sections, and explicit guarantees", () => {
    const content = validPlan();
    content.sections[0].evidence[0].sourceId = "deleted-source";
    content.sections[0].content += " 무조건 통과합니다.";
    content.sections[1] = { ...content.sections[0] };
    const categories = reviewPlan(fixture(), content).map((finding) => finding.category);
    expect(categories).toEqual(
      expect.arrayContaining([
        "missing-section",
        "duplicate-section",
        "invalid-reference",
        "guarantee",
      ]),
    );
  });

  it("checks numeric claims against citations and recognizes a legitimate negation", () => {
    const value = fixture();
    value.profile.financials = "2025년 매출 2억원";
    const content = validPlan(value);
    content.summary = "심사 통과를 보장하지 않습니다.";
    content.sections[0].content = "2025년 매출 2억원, 향후 매출 목표 5억원";
    content.sections[0].evidence = [
      { sourceId: "profile", quote: value.profile.financials, locator: "재무·자금" },
    ];
    const review = reviewPlan(value, content);
    const finding = review.find((item) => item.category === "numeric-evidence");
    expect(finding?.message).toContain("5억원");
    expect(finding?.message).not.toContain("2억원");
    expect(review.some((item) => item.category === "guarantee")).toBe(false);
    expect(review.some((item) => item.category === "review-scope")).toBe(true);
  });
});
