// Node-only engine; client components import studio-diagnosis-types instead.
import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import type { CompanyProfile, SourceDocument } from "./studio-schema";
import {
  diagnosisAnswersSchema,
  diagnosisContentSchema,
  diagnosisCriteriaVersion,
  type Diagnosis,
  type DiagnosisAnswers,
  type DiagnosisContent,
  type DiagnosisEvidence,
  type DiagnosisItem,
} from "./studio-diagnosis-types";

export type DiagnosisInput = {
  profile: CompanyProfile;
  sources: SourceDocument[];
  diagnosisAnswers: DiagnosisAnswers;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

/** Binds registered text and metadata only. It neither reads nor attests original file bytes. */
export function diagnosisInputFingerprint(record: DiagnosisInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          profile: record.profile,
          sources: [...record.sources].sort((a, b) => a.id.localeCompare(b.id)),
          answers: record.diagnosisAnswers,
        }),
      ),
    )
    .digest("hex");
}

function sourceEvidence(
  record: DiagnosisInput,
  input: DiagnosisAnswers["sme"]["evidence"][number],
): DiagnosisEvidence | null {
  const matches = record.sources.filter((source) => source.id === input.sourceId);
  if (matches.length !== 1) return null;
  const source = matches[0];
  if (
    source.extraction === "pending" ||
    source.updatedAt !== input.sourceUpdatedAt ||
    !input.quote.trim() ||
    !source.text.includes(input.quote)
  )
    return null;
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceUpdatedAt: source.updatedAt,
    quote: input.quote,
    locator: input.locator,
    provenance: source.originalName && source.kind !== "consultation" ? "documented" : "reported",
  };
}

function eligibleAssessment(
  record: DiagnosisInput,
  answers: DiagnosisAnswers,
  key: "sme" | "industryEligibility",
) {
  const assessment = answers[key];
  const evidence = assessment.evidence.map((ref) => sourceEvidence(record, ref));
  const allCurrent = evidence.every((ref) => ref !== null);
  const supportedReview =
    assessment.status !== "unknown" &&
    assessment.reviewed &&
    answers.criteriaVersion === diagnosisCriteriaVersion &&
    evidence.length > 0 &&
    allCurrent &&
    evidence.every((ref) => ref?.provenance === "documented");
  return {
    assessment,
    evidence: evidence.filter((ref): ref is DiagnosisEvidence => ref !== null),
    allCurrent,
    supportedReview,
  };
}

/** Explicit edits fail closed; old references may later become invalid without blocking re-diagnosis. */
export function assertDiagnosisAnswers(record: DiagnosisInput, answers: DiagnosisAnswers): void {
  const parsed = diagnosisAnswersSchema.parse(answers);
  for (const key of ["sme", "industryEligibility"] as const) {
    const state = eligibleAssessment(record, parsed, key);
    if (!state.allCurrent || (state.assessment.status !== "unknown" && !state.supportedReview))
      throw new StudioError(
        "현재 기업의 본문이 있는 문서에서 정확한 인용을 선택하고 현재 기준을 검토해 주세요. 진술이나 미추출 원본만으로 기본요건을 확정할 수 없습니다.",
        422,
        "DIAGNOSIS_EVIDENCE_INVALID",
      );
  }
}

type ExplanationRule = {
  id: string;
  title: string;
  area: "technology" | "growth";
  profileKeys: (keyof CompanyProfile)[];
  kinds: SourceDocument["kind"][];
  keywords: RegExp;
  question: string;
  action: string;
};
const rules: ExplanationRule[] = [
  {
    id: "technology-description",
    title: "신청 기술과 현재 개발 상태",
    area: "technology",
    profileKeys: ["technologySummary"],
    kinds: ["technology", "consultation", "patent"],
    keywords: /기술|제품|작동|구조|구현|개발|시제품/,
    question: "신청 기술이 어떻게 작동하며 현재 구현한 부분과 앞으로 만들 부분은 무엇인가요?",
    action: "현재 기술·제품의 작동 방식과 개발 범위를 확인하기",
  },
  {
    id: "technology-difference",
    title: "기술 차별성과 비교 근거",
    area: "technology",
    profileKeys: [],
    kinds: ["technology", "market", "patent", "consultation"],
    keywords: /차별|비교|경쟁|시험|검증|측정/,
    question: "비교 대상·조건·기간과 실제 시험 또는 고객 검증 자료가 있나요?",
    action: "차별성 주장에 필요한 비교 조건과 검증 자료 정리하기",
  },
  {
    id: "technology-development",
    title: "개발 이력과 향후 실행계획",
    area: "technology",
    profileKeys: ["developmentPlan"],
    kinds: ["technology", "consultation"],
    keywords: /개발|일정|계획|단계|완료|예정/,
    question: "완료한 개발과 향후 목표·일정·담당 인력·검증방법을 구분했나요?",
    action: "완료한 개발과 향후 개발계획을 구분하기",
  },
  {
    id: "technology-team",
    title: "인력과 자사 개발 역량",
    area: "technology",
    profileKeys: ["team"],
    kinds: ["team", "technology", "consultation"],
    keywords: /인력|담당|경력|연구|개발자|외주/,
    question: "담당자의 실제 역할·경력·참여 이력과 자사·외부 개발 범위의 근거가 있나요?",
    action: "핵심 인력·개발 참여·외부 의존 범위를 확인하기",
  },
  {
    id: "growth-customer",
    title: "목표 고객과 수요·시장 설명",
    area: "growth",
    profileKeys: ["customers"],
    kinds: ["market", "consultation", "technology"],
    keywords: /고객|시장|수요|문제|구매|납품/,
    question: "목표 고객의 문제를 무엇으로 확인했고 수요·협의·계약·매출·향후 목표를 구분했나요?",
    action: "고객 문제와 실제 수요·거래 근거를 구분하기",
  },
  {
    id: "growth-funding",
    title: "자금과 인력·일정의 실행 가능성",
    area: "growth",
    profileKeys: ["financials"],
    kinds: ["finance", "consultation"],
    keywords: /자금|비용|재무|조달|예산|투자/,
    question: "필요 자금과 확보·조달 예정 자금, 투입 인력과 시기를 같은 기준으로 맞췄나요?",
    action: "자금 소요·확보 현황과 조달 일정을 확인하기",
  },
];

function explanationEvidence(record: DiagnosisInput, rule: ExplanationRule): DiagnosisEvidence[] {
  const result: DiagnosisEvidence[] = [];
  for (const key of rule.profileKeys) {
    const text = record.profile[key];
    if (typeof text !== "string" || !text.trim()) continue;
    result.push({
      sourceId: "profile",
      sourceName: "기업정보 · 담당자 입력",
      sourceUpdatedAt: "",
      quote: text.trim().slice(0, 1500),
      locator: key,
      provenance: "reported",
    });
  }
  for (const source of [...record.sources].sort((a, b) => a.id.localeCompare(b.id))) {
    if (source.extraction === "pending" || !rule.kinds.includes(source.kind)) continue;
    const quote = source.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && rule.keywords.test(line));
    if (!quote) continue;
    const evidence = sourceEvidence(record, {
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt,
      quote: quote.slice(0, 1500),
      locator: source.name.slice(0, 150),
    });
    if (evidence) result.push(evidence);
  }
  return result.slice(0, 6);
}

/** Deterministic preparation guidance. Text presence never establishes merit, fact, or eligibility. */
export function buildLocalDiagnosis(record: DiagnosisInput): DiagnosisContent {
  const items: DiagnosisItem[] = [];
  const questions: DiagnosisContent["questions"] = [];
  const actions: DiagnosisContent["actions"] = [];
  const addFollowup = (itemId: string, title: string, question: string, reason: string) => {
    const id = `action-${itemId}`;
    actions.push({
      id,
      title,
      notes: `${reason}\n확인할 내용: ${question}\n실제 자료·활동 확인이 필요하며 문장 수정이나 업무 완료 체크만으로 근거가 보강되지 않습니다.`,
    });
    questions.push({ id: `question-${itemId}`, itemId, question, reason });
    return [title];
  };
  for (const key of ["sme", "industryEligibility"] as const) {
    const title = key === "sme" ? "중소기업 해당 여부" : "신청 제외업종 해당 여부";
    const id = `eligibility-${key}`;
    const state = eligibleAssessment(record, record.diagnosisAnswers, key);
    const status = state.supportedReview ? state.assessment.status : "unknown";
    const reason =
      status === "unknown"
        ? "현재 기준과 같은 기업의 등록 문서 본문을 대조한 사용자 검토가 부족합니다. 파일명·업종명·코드나 자료 보유만으로 충족 여부를 판단하지 않습니다."
        : `사용자가 현재 기준과 등록 문서의 인용을 대조해 ${status === "supported" ? "충족 근거가 있다고" : "미충족 근거가 있다고"} 기록했습니다. 앱의 독립 사실 확인이나 기관 판정은 아닙니다.${state.assessment.note ? ` 검토 메모: ${state.assessment.note}` : ""}`;
    const question =
      key === "sme"
        ? "현재 신청 기업에 적용되는 중소기업 해당 여부와 확인 근거의 유효기간을 원문에서 확인했나요?"
        : "현재 실제 영위 업종을 공식 신청불가 업종 안내와 직접 대조하고 적용 여부를 확인했나요?";
    items.push({
      id,
      title,
      area: "eligibility",
      status,
      reason,
      evidence: state.evidence,
      unknowns:
        status === "supported"
          ? ["등록 문서의 진위와 최신성은 독립 검증하지 않았습니다."]
          : [question],
      nextActions:
        status === "supported"
          ? []
          : addFollowup(id, `${title} 근거 다시 확인하기`, question, reason),
    });
  }
  for (const rule of rules) {
    const evidence = explanationEvidence(record, rule);
    const reason = evidence.length
      ? "관련 등록 설명을 찾았습니다. 설명의 정확성·충분성, 실제 성과와 계획의 구분, 비교 조건과 증빙을 추가 검토해야 합니다. 글의 길이나 키워드는 준비 완료의 근거가 아닙니다."
      : "이 항목을 판단할 등록 설명을 찾지 못했습니다. 자료 부재를 기술·실적 부재나 신청 불가로 해석하지 않습니다.";
    items.push({
      id: rule.id,
      title: rule.title,
      area: rule.area,
      status: evidence.length ? "needs_work" : "unknown",
      reason,
      evidence,
      unknowns: [rule.question],
      nextActions: addFollowup(rule.id, rule.action, rule.question, reason),
    });
  }
  const pending = record.sources.filter((source) => source.extraction === "pending");
  const identityQuestion =
    "기업 형태, 문서의 대상 기업·기간·발급일·유효기간, 수치의 기준과 단위가 서로 일치하나요?";
  const reliabilityReason = `등록 자료 ${record.sources.length}건 중 미추출 원본 ${pending.length}건은 본문 근거에서 제외했습니다. 등록된 설명·인용만 대조했으며 원본 파일 바이트, 기업·기간·수치의 일치나 진위를 자동 확인하지 않았습니다.`;
  items.push({
    id: "reliability-context",
    title: "자료의 기업·기간·수치와 신뢰성",
    area: "reliability",
    status: "needs_work",
    reason: reliabilityReason,
    evidence: [],
    unknowns: [
      identityQuestion,
      ...(record.diagnosisAnswers.entityType === "unknown"
        ? ["법인·개인 구분이 미확인입니다."]
        : []),
      ...pending.slice(0, 6).map((source) => `${source.name}: 미추출 원본입니다.`),
    ],
    nextActions: addFollowup(
      "reliability-context",
      "자료의 기업·기간·수치와 원본 내용 대조하기",
      identityQuestion,
      reliabilityReason,
    ),
  });
  const eligibility = items.filter((item) => item.area === "eligibility");
  const core = items.filter((item) =>
    ["technology-description", "growth-customer"].includes(item.id),
  );
  // Recommending a draft is a writing next step, never a positive technical assessment.
  const outcome: DiagnosisContent["outcome"] = eligibility.some(
    (item) => item.status === "contradicted",
  )
    ? "eligibility_issue"
    : eligibility.some((item) => item.status === "unknown") ||
        core.some((item) => !item.evidence.length)
      ? "insufficient"
      : "draft_recommended";
  return diagnosisContentSchema.parse({
    mode: "assisted",
    outcome,
    items,
    questions,
    actions,
    warnings: [
      "이 결과는 등록 본문과 사용자의 검토 기록을 정리한 준비 안내입니다. 기관의 신청자격 확정·기술 평가·심사 통과 판정이 아닙니다.",
      "원본 파일 바이트·기재 사실의 진위·기업 및 기간의 일치를 독립 확인하지 않았습니다. 원본 무결성은 원본 대조·전송 기능에서 별도로 확인합니다.",
      "문서 기재, 담당자 진술, 향후 계획을 구분해 주세요. 자료 보유나 정확한 인용만으로 실제 성과·권리·고객 확보가 검증되지는 않습니다.",
      "작성 진행 권장은 미확인 사항을 남긴 초안 작성을 시작할 수 있다는 안내이며 전체 제출 준비 완료가 아닙니다. 통과확률이나 합격점수는 계산하지 않습니다.",
      "같은 등록 근거와 기준 버전에서는 같은 결과를 사용합니다. 원고 표현 수정·업무 완료 체크만으로 진단을 상향하지 않습니다.",
    ],
  });
}

/** Keep historical findings unchanged; only their current applicability is derived. */
export function refreshDiagnosisStaleness(
  record: DiagnosisInput & { diagnoses: Diagnosis[] },
): void {
  const fingerprint = diagnosisInputFingerprint(record);
  for (const diagnosis of record.diagnoses)
    diagnosis.stale =
      diagnosis.inputFingerprint !== fingerprint ||
      diagnosis.criteriaVersion !== diagnosisCriteriaVersion;
}

export function diagnosisHistoryCharacters(diagnoses: Diagnosis[]): number {
  const count = (value: unknown): number => {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + count(item), 0);
    if (value && typeof value === "object")
      return Object.values(value).reduce<number>((sum, item) => sum + count(item), 0);
    return 0;
  };
  return diagnoses.reduce(
    (sum, { items, questions, actions, warnings, outcome, mode }) =>
      sum + count({ items, questions, actions, warnings, outcome, mode }),
    0,
  );
}
