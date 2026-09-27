import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applicationCycleSchema } from "@/lib/studio-application-types";
import {
  buildApplicationCriteriaBinding,
  buildCriteriaVersion,
  criteriaVersionInputDigest,
  withApplicationCriteriaContexts,
} from "@/lib/studio-criteria-version";
import type { AppendCriteriaVersionInput } from "@/lib/studio-criteria-version-types";
import { caseSchema, emptyProfile, type BusinessPlan, type StudioCase } from "@/lib/studio-schema";
import { GuidedPlanEvidence } from "./guided-plan-evidence";
import type { CriteriaCommand } from "./criteria-versions-ui";

const now = "2026-09-26T02:00:00.000Z";
const quote = "합성 인터뷰에서 고객의 반복 입력 문제가 기록되었습니다.";

function fixture() {
  const sourceId = randomUUID();
  const plan: BusinessPlan = {
    id: randomUUID(),
    version: 2,
    mode: "manual",
    generatedAt: now,
    candidateId: "synthetic-candidate",
    sourceRevision: 3,
    confirmedAt: null,
    review: [],
    content: {
      title: "가상 회사의 고객 문제 개선 계획",
      summary: "합성 UI 검증용 원고입니다.",
      sections: [
        {
          key: "problem",
          title: "고객 문제",
          content: "반복 입력 문제의 개선을 계획합니다.",
          evidence: [{ sourceId, quote, locator: "합성 인터뷰 2쪽" }],
          needsConfirmation: true,
        },
      ],
      interviewQuestions: [],
      actionItems: [],
    },
  };
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 근거 화면 기업", technologySummary: quote },
    sources: [
      {
        id: sourceId,
        name: "합성 인터뷰 기록",
        kind: "consultation",
        text: `합성 자료입니다. ${quote}`,
        originalName: null,
        mimeType: null,
        extraction: "manual",
        warnings: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    analysis: null,
    selectedCandidateId: "synthetic-candidate",
    plans: [plan],
    tasks: [],
    stage: "drafting",
    revision: 3,
    createdAt: now,
    updatedAt: now,
  });
  return { company, plan: company.plans[0] };
}

const recordBase = () => ({
  id: randomUUID(),
  clientRequestId: randomUUID(),
  inputDigest: "a".repeat(64),
  recordedAt: now,
});

function criteriaBase(company: StudioCase, input: CriteriaCommand) {
  const record = recordBase();
  return {
    ...record,
    inputDigest: criteriaVersionInputDigest({
      ...input,
      revision: company.revision,
      clientRequestId: record.clientRequestId,
    }),
  };
}

function addCriteria(company: StudioCase) {
  const application = applicationCycleSchema.parse({
    ...recordBase(),
    origin: "manual",
    title: "합성 첫 신청",
    kind: "new",
    plannedOn: "",
    criteriaNote: "",
    previousApplicationId: null,
    companyAtCreation: {
      companyName: company.profile.companyName,
      businessNumber: company.profile.businessNumber,
    },
  });
  company.applications.push(application);
  const input: AppendCriteriaVersionInput = {
    criteriaId: null,
    previousVersionId: null,
    recordedBy: "합성 담당자",
    reason: "합성 기준 기록",
    details: {
      title: "합성 보관 기준",
      versionLabel: "내부 참고 1",
      applicationPath: "합성 신청 경로",
      checkedOn: "2026-09-25",
      sources: [
        {
          title: "합성 기준 출처",
          url: "https://example.invalid/synthetic-criteria",
          quote: "합성 조건 원문입니다.",
          note: "",
        },
      ],
      documents: [
        {
          id: randomUUID(),
          name: "합성 개발 근거",
          appliesTo: "개발 실적을 설명하는 경우",
          period: "설명한 개발 기간",
          issueDateCondition: "",
          alternativeCondition: "확인 필요",
          autoLinkGuidance: "확인하지 않음",
          note: "",
        },
      ],
    },
  };
  const version = buildCriteriaVersion(
    company,
    input,
    criteriaBase(company, { action: "append-criteria-version", ...input }),
  );
  company.criteriaVersions.push(version);
  const pin = {
    applicationId: application.id,
    applicationMetadataVersionId: application.id,
    criteriaVersionId: version.id,
    criteriaContentSha256: version.contentSha256,
    previousBindingId: null,
    recordedBy: "합성 담당자",
    reason: "합성 버전 연결",
  };
  const binding = buildApplicationCriteriaBinding(
    company,
    pin,
    criteriaBase(company, { action: "pin-application-criteria", ...pin }),
  );
  company.applicationCriteriaBindings.push(binding);
  Object.assign(company, withApplicationCriteriaContexts(company));
  return { input, version, binding, application };
}

function render(company: StudioCase, plan = company.plans[0]) {
  const before = structuredClone({ company, plan });
  const html = renderToStaticMarkup(createElement(GuidedPlanEvidence, { company, plan }));
  expect({ company, plan }).toEqual(before);
  expect(html).not.toMatch(/<(?:button|input|form)\b/);
  return { html, text: html.replace(/<[^>]*>/g, "") };
}

const fetchGuard = vi.fn(() => {
  throw new Error("합성 근거 SSR 검증에서는 외부 요청을 보내지 않습니다.");
});
beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
});
afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("기본 계획서의 기준·근거 읽기", () => {
  it("관련 가이드와 원문을 수정 버튼 없이 읽고 공식 판정과 구분한다", () => {
    const { company } = fixture();
    const { html, text } = render(company);
    expect(text).toContain("기준·근거 보기");
    expect(text).toContain("원고 v2의 인용문을 현재 등록본문과 비교");
    expect(text).toContain("앱의 내부 점검용");
    expect(text).toContain("공식 배점표나 모든 회사의 필수서류 목록은 아닙니다");
    expect(text).toContain("고객 문제 · 근거 1개");
    expect(text).toContain("고객 문제와 신청기술의 연결");
    expect(text).not.toContain("인력·자금·일정의 실행 가능성과 일치");
    expect(text).toContain("현재 등록본문에 인용문이 있어요");
    expect(text).toContain("합성 인터뷰 2쪽");
    expect(text).toContain("저장된 원문 보기");
    expect(text).not.toMatch(/승인확률|기준 충족|심사 통과|검증 완료/);
    expect(html).toMatch(/^<details[^>]*><summary>기준·근거 보기<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("근거가 없는 항목을 연결 완료로 표시하지 않는다", () => {
    const { company, plan } = fixture();
    plan.content.sections[0].evidence = [];
    const { text } = render(company);
    expect(text).toContain("고객 문제 · 근거 0개");
    expect(text).toContain("연결된 근거가 없습니다");
    expect(text).not.toContain("현재 등록본문에 인용문이 있어요");
  });

  it("삭제된 자료의 인용은 보존하면서 연결 소실을 표시한다", () => {
    const { company } = fixture();
    company.sources = [];
    const { text } = render(company);
    expect(text).toContain("연결한 자료가 없어요");
    expect(text).toContain(quote);
    expect(text).not.toContain("현재 등록본문에 인용문이 있어요");
  });

  it("본문 미추출 자료를 인용 일치로 표시하지 않는다", () => {
    const { company } = fixture();
    company.sources[0].extraction = "pending";
    company.sources[0].text = "";
    const { text } = render(company);
    expect(text).toContain("본문을 아직 추출하지 않은 자료예요");
    expect(text).not.toContain("현재 등록본문에 인용문이 있어요");
  });

  it("교정으로 달라진 인용은 불일치로 표시한다", () => {
    const { company } = fixture();
    company.sources[0].text = "고객의 반복 입력 문제는 확인되지 않았습니다.";
    const { text } = render(company);
    expect(text).toContain("현재 등록본문과 인용문이 달라요");
    expect(text).toContain(quote);
    expect(text).not.toContain("현재 등록본문에 인용문이 있어요");
  });

  it("빈 인용문을 문자열 포함 성공으로 처리하지 않는다", () => {
    const { company, plan } = fixture();
    plan.content.sections[0].evidence[0].quote = "  ";
    const { text } = render(company);
    expect(text).toContain("인용문이 비어 있어요");
    expect(text).not.toContain("현재 등록본문에 인용문이 있어요");
  });

  it("기업 입력 내용의 인용 일치는 증빙 확인과 구분한다", () => {
    const { company, plan } = fixture();
    plan.content.sections[0].evidence[0] = {
      sourceId: "profile",
      quote,
      locator: "technologySummary",
    };
    const { text } = render(company);
    expect(text).toContain("기업 입력 내용과 인용문이 일치해요");
    expect(text).toContain("별도 증빙 확인이 필요합니다");
    expect(text).not.toContain("저장된 원문 보기");
    company.profile.technologySummary = "이후 수정한 합성 설명";
    expect(render(company).text).toContain("현재 기업 입력 내용과 인용문이 달라요");
  });

  it("인용이 남아 있어도 원고 이후 수정된 자료는 변경 확인을 안내한다", () => {
    const { company } = fixture();
    company.sources[0].updatedAt = "2026-09-26T03:00:00.000Z";
    const { text } = render(company);
    expect(text).toContain("현재 등록본문에 인용문이 있어요");
    expect(text).toContain("원고 작성 후 수정된 자료입니다");
  });

  it("중복 자료 ID를 확실한 연결로 표시하지 않는다", () => {
    const { company } = fixture();
    company.sources.push({ ...company.sources[0], text: "다른 합성 원문" });
    const { text } = render(company);
    expect(text).toContain("연결할 자료를 하나로 확인하지 못했어요");
    expect(text).not.toContain("현재 등록본문에 인용문이 있어요");
  });

  it("연결 기준의 출처·기간을 보여도 회사별 적용 확인으로 간주하지 않는다", () => {
    const { company } = fixture();
    addCriteria(company);
    const { text } = render(company);
    expect(text).toContain("신청별 기준 기록");
    expect(text).toContain("담당자가 보관한 기준");
    expect(text).toContain("합성 보관 기준 · 내부 참고 1 · 버전 1");
    expect(text).toContain("기록한 확인일: 2026-09-25");
    expect(text).toContain("현행 기준 여부와 이 회사의 적용 여부는 확인이 필요합니다");
    expect(text).toContain("합성 조건 원문입니다");
    expect(text).toContain("개발 실적을 설명하는 경우");
    expect(text).toContain("설명한 개발 기간");
    expect(text).not.toMatch(/기준 충족|공식 검증 완료|적용 확정/);
  });

  it("새 기준이 있어도 연결된 과거 버전을 자동으로 대체하지 않는다", () => {
    const { company } = fixture();
    const { input, version } = addCriteria(company);
    const nextInput = {
      ...input,
      criteriaId: version.criteriaId,
      previousVersionId: version.id,
      details: {
        ...input.details,
        title: "자동 선택하면 안 되는 새 기준",
        versionLabel: "참고 2",
      },
    };
    company.criteriaVersions.push(
      buildCriteriaVersion(
        company,
        nextInput,
        criteriaBase(company, { action: "append-criteria-version", ...nextInput }),
      ),
    );
    Object.assign(company, withApplicationCriteriaContexts(company));
    const { text } = render(company);
    expect(text).toContain("합성 보관 기준");
    expect(text).toContain("새 기준 버전이 있습니다. 과거 연결은 자동 교체하지 않습니다");
    expect(text).not.toContain("자동 선택하면 안 되는 새 기준");
  });

  it("서버 연결 상태가 누락되거나 중복되면 현재 상태를 추정하지 않는다", () => {
    const { company } = fixture();
    addCriteria(company);
    const contexts = structuredClone(company.applicationCriteriaContexts!);
    delete company.applicationCriteriaContexts;
    expect(render(company).text).toContain("현재 연결 상태를 확인하지 못했습니다");
    company.applicationCriteriaContexts = [...contexts, ...contexts];
    const { text } = render(company);
    expect(text).toContain("현재 연결 상태를 확인하지 못했습니다");
    expect(text).not.toContain("기준 버전 연결 기록이 있습니다");
  });

  it("다른 회사 기준이나 다른 식별값의 기준 원문을 펼치지 않는다", () => {
    const { company } = fixture();
    const { version } = addCriteria(company);
    version.caseId = randomUUID();
    const foreign = render(company).text;
    expect(foreign).toContain("연결한 기준 원문 기록을 확인하지 못했습니다");
    expect(foreign).not.toContain("합성 조건 원문입니다");
    version.caseId = company.id;
    version.contentSha256 = "b".repeat(64);
    Object.assign(company, withApplicationCriteriaContexts(company));
    const { text } = render(company);
    expect(text).toContain("기준 연결을 다시 확인해 주세요");
    expect(text).not.toContain("합성 조건 원문입니다");
  });

  it("기준이 등록돼 있어도 신청 연결이 없으면 임의로 적용하지 않는다", () => {
    const { company } = fixture();
    addCriteria(company);
    company.applicationCriteriaBindings = [];
    Object.assign(company, withApplicationCriteriaContexts(company));
    expect(render(company).text).toContain("이 신청에 연결한 기준 버전이 없습니다");
    expect(render(company).text).not.toContain("합성 조건 원문입니다");
    company.applications = [];
    expect(render(company).text).toContain("신청별로 연결한 기준 기록이 없습니다");
  });

  it("현재 회사에 없는 원고와 저장본이 아닌 변경 원고를 표시하지 않는다", () => {
    const { company, plan } = fixture();
    expect(render(company, { ...plan, id: randomUUID() }).html).toBe("");
    const edited = structuredClone(plan);
    edited.content.sections[0].content = "저장하지 않은 원고";
    expect(render(company, edited).html).toBe("");
    company.plans.push(structuredClone(plan));
    expect(render(company).html).toBe("");
  });
});
