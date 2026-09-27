import "server-only";

import OpenAI from "openai";
import {
  aiInput,
  buildPlanGenerationRequest,
  buildPlanReviewRequest,
  candidateClassificationInstructions,
  executionDigest,
  getPlanExecutionContract,
  planGenerationInstruction,
  planReviewInstruction,
  planSemanticReviewSchema,
  requestFormat,
  StudioEngineError,
  systemPrompt,
  trackContext,
  type EnginePlanPreparedRequest,
} from "./studio-engine-request-preparation";
export { getPlanExecutionContract, StudioEngineError } from "./studio-engine-request-preparation";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { evaluationFocusItems } from "./evaluation-guide";
import {
  candidateClassificationSchema,
  getCandidateClassification,
} from "./studio-candidate-classification";
import {
  engineExecutionRequestSchema,
  engineExecutionResponseSchema,
  engineExecutionUsageSchema,
  engineExecutionValidatedSchema,
  type EngineExecutionContract,
  type EngineExecutionOptions,
  type EngineExecutionRequest,
  type EngineExecutionOutput,
  type EngineExecutionPhase,
  type EngineExecutionResult,
  type EngineExecutionJson,
  type EngineExecutionCapturedResponse,
} from "./studio-engine-execution-types";
import {
  analysisContentSchema,
  candidateSchema,
  planContentSchema,
  sectionDefinitions,
  type AnalysisContent,
  type Candidate,
  type CompanyProfile,
  type PlanContent,
  type ReviewFinding,
  type StudioCase,
} from "./studio-schema";

type Reference = Candidate["evidence"][number];
type SectionKey = (typeof sectionDefinitions)[number]["key"];
type Mode = "ai" | "assisted";
// New AI responses must provide a classification; persisted legacy analyses remain optional.
const aiAnalysisContentSchema = analysisContentSchema.extend({
  candidates: z
    .array(candidateSchema.extend({ classification: candidateClassificationSchema }))
    .max(3),
});
export function getAiStatus() {
  return {
    aiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    model: process.env.OPENAI_MODEL?.trim() || "gpt-5.4",
  };
}

const fieldLabels: Record<keyof CompanyProfile, string> = {
  companyName: "기업명",
  businessNumber: "사업자등록번호",
  industry: "업종",
  foundedOn: "설립·개업일",
  applicationDate: "신청예정일",
  applicationKind: "신청구분",
  technologySummary: "기술·제품 설명",
  customers: "고객·시장",
  team: "인력·역량",
  financials: "재무·자금",
  paidInCapital: "납입자본금(원)",
  closingMonth: "결산월",
  developmentPlan: "개발계획",
  patents: "특허·지식재산",
};

const sectionRules: Record<
  SectionKey,
  {
    fields: (keyof CompanyProfile)[];
    kinds: StudioCase["sources"][number]["kind"][];
    keywords: RegExp;
    question: string;
  }
> = {
  problem: {
    fields: ["customers", "technologySummary"],
    kinds: ["consultation", "market"],
    keywords: /문제|불편|필요|수요|요구|어려움|개선/,
    question:
      "목표 고객이 현재 겪는 문제와 그 문제를 확인한 상담·현장·고객 자료를 구체적으로 알려 주세요.",
  },
  solution: {
    fields: ["technologySummary"],
    kinds: ["technology", "patent"],
    keywords: /기술|제품|구조|공정|원리|설계|개발/,
    question:
      "신청 기술의 작동 원리·구성요소와 회사가 직접 개발한 부분, 외주·외부 기술을 사용하는 범위를 구분하고 해당 설명자료·사용 근거를 확인해 주세요.",
  },
  differentiation: {
    fields: ["technologySummary"],
    kinds: ["technology", "market"],
    keywords: /차별|비교|경쟁|성능|시험|측정|개선/,
    question:
      "비교할 기존 제품·기술, 동일한 시험 조건과 측정 결과를 알려 주세요. 근거 없는 우수성 수치는 사용하지 않습니다.",
  },
  development: {
    fields: ["developmentPlan"],
    kinds: ["technology", "consultation"],
    keywords: /개발|시제품|일정|단계|목표|계획|완료/,
    question:
      "완료한 개발과 앞으로의 계획을 구분하고, 향후 3년 단계별 목표·일정·인력·비용·검증방법을 알려 주세요.",
  },
  team: {
    fields: ["team"],
    kinds: ["team"],
    keywords: /인력|연구원|대표|경력|전공|담당|조직/,
    question:
      "대표·핵심 개발인력의 경력, 역할, 실제 참여 이력과 사용 가능한 개발환경·장비·협업 근거를 확인해 주세요. 신청기술을 지속해서 개선할 담당자를 구분해 주세요.",
  },
  ip: {
    fields: ["patents"],
    kinds: ["patent"],
    keywords: /특허|출원|등록|권리|실용|지식재산/,
    question:
      "해당 시 특허의 출원·등록번호, 권리자, 유효 상태, 회사의 사용 근거와 신청 기술 적용 부분을 확인해 주세요. 미보유라면 미보유로 기재합니다.",
  },
  market: {
    fields: ["customers"],
    kinds: ["market"],
    keywords: /시장|고객|경쟁|수요|구매|산업/,
    question:
      "구체적인 목표 고객과 구매 이유, 경쟁 대안, 시장 규모 자료의 출처·기준연도를 알려 주세요.",
  },
  commercialization: {
    fields: ["customers"],
    kinds: ["market", "consultation"],
    keywords: /판매|납품|계약|요금|구독|유통|제휴|협업|수익|진입/,
    question:
      "신청기술의 고객 가치와 판매 방식·가격 근거·고객 확보 및 시장확대 경로를 연결해 주세요. 확정 계약·협의 중 사항·향후 목표를 구분하고 일반적인 홍보 계획에 그치지 않도록 해 주세요.",
  },
  funding: {
    fields: ["financials", "developmentPlan"],
    kinds: ["finance"],
    keywords: /자금|투자|비용|원가|예산|조달|매출|재무/,
    question:
      "현재 자금과 향후 3년 개발·사업화 소요자금, 조달 방법·시기·확정 여부를 개발 일정과 맞춰 확인해 주세요.",
  },
  performance: {
    fields: ["financials"],
    kinds: ["finance", "technology", "market"],
    keywords: /실적|성과|매출|고용|수출|개발|완료|납품/,
    question: "기간별 실제 개발·사업성과와 산정 기준·증빙을 제공하고, 미래 목표와 구분해 주세요.",
  },
};

/** Keep verbatim substrings so every citation can be checked against the original input. */
function excerpts(value: string, count = 3): string[] {
  const blocks = value
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return blocks.slice(0, count).map((block) => block.slice(0, 1200));
}

function fieldRefs(value: StudioCase, fields: (keyof CompanyProfile)[]): Reference[] {
  return fields.flatMap((field) =>
    excerpts(value.profile[field], 1).map((quote) => ({
      sourceId: "profile",
      quote,
      locator: fieldLabels[field],
    })),
  );
}

function collectReferences(value: StudioCase, key: SectionKey): Reference[] {
  const rule = sectionRules[key];
  const refs = fieldRefs(value, rule.fields);
  for (const source of value.sources) {
    if (source.extraction === "pending") continue;
    if (!rule.kinds.includes(source.kind)) continue;
    const matching = source.text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && rule.keywords.test(line));
    // Kind alone only permits a neutral excerpt in its directly corresponding section.
    const blocks = matching.length
      ? matching
      : source.kind === "consultation"
        ? []
        : excerpts(source.text, 1);
    for (const quote of blocks.slice(0, 2)) {
      refs.push({
        sourceId: source.id,
        quote: quote.slice(0, 1200),
        locator: source.name.slice(0, 150),
      });
    }
  }
  return uniqueReferences(refs).slice(0, 6);
}

function uniqueReferences(refs: Reference[]) {
  return refs.filter(
    (ref, index) =>
      refs.findIndex((other) => other.sourceId === ref.sourceId && other.quote === ref.quote) ===
      index,
  );
}

function validReference(value: StudioCase, ref: Reference): boolean {
  if (!ref.quote.trim()) return false;
  if (ref.sourceId === "profile") {
    return Object.values(value.profile).some(
      (field) => typeof field === "string" && field.includes(ref.quote),
    );
  }
  return value.sources.some(
    (source) =>
      source.extraction !== "pending" &&
      source.id === ref.sourceId &&
      source.text.includes(ref.quote),
  );
}

function sourceName(value: StudioCase, ref: Reference) {
  if (ref.sourceId === "profile") return `기업정보 · ${ref.locator}`;
  return value.sources.find((source) => source.id === ref.sourceId)?.name || "찾을 수 없는 자료";
}

const guaranteePattern =
  /(?:반드시|무조건|100\s*[%％])\s*(?:심사에?\s*)?(?:통과|합격|승인)|(?:통과|합격|승인)(?:율|확률)\s*(?:은|이|:)?\s*\d|(?:통과|합격|승인)(?:를|을)?\s*보장(?:합니다|한다|됨|된다|할\s*수\s*있)/;

const preparationQuestionPrefix = "[실무 준비 질문 · 기관 확정 질문 아님] ";
function markPreparationQuestion(question: string) {
  return question.startsWith(preparationQuestionPrefix)
    ? question
    : `${preparationQuestionPrefix}${question.slice(0, 3000 - preparationQuestionPrefix.length)}`;
}

function assistedPreparationQuestions(value: StudioCase, candidate: Candidate): string[] {
  const questions = evaluationFocusItems.map((item) => {
    const refs = uniqueReferences(
      item.sectionKeys.flatMap((key) => collectReferences(value, key as SectionKey)),
    );
    const ref = refs[0];
    const context = ref
      ? `${sourceName(value, ref)}의 “${ref.quote.slice(0, 240)}${ref.quote.length > 240 ? "…" : ""}” 내용을 기준으로, `
      : `신청 아이템 “${candidate.title.slice(0, 180)}”을 기준으로, `;
    return markPreparationQuestion(
      `${context}${item.question} 관련 원문과 실제 제출한 내용·현재 상태를 함께 대조해 주세요.`,
    );
  });
  if (value.profile.applicationKind === "renewal") {
    questions.push(
      markPreparationQuestion(
        `신청 아이템 “${candidate.title.slice(0, 180)}”과 관련해 이전 확인기간 동안 무엇이 개선되었나요? 이전 제출본과 기간별 개발·사업성과의 산정 근거를 대조해 설명해 주세요.`,
      ),
    );
  }
  return questions;
}

function buildAssistedAnalysis(value: StudioCase): AnalysisContent {
  const facts: AnalysisContent["facts"] = [];
  const usefulFields: (keyof CompanyProfile)[] = [
    "technologySummary",
    "customers",
    "team",
    "financials",
    "developmentPlan",
    "patents",
  ];
  for (const field of usefulFields) {
    for (const ref of fieldRefs(value, [field])) {
      facts.push({
        id: `fact-${facts.length + 1}`,
        statement: ref.quote,
        status: field === "developmentPlan" ? "planned" : "reported",
        evidence: [ref],
      });
    }
  }
  for (const source of value.sources) {
    if (source.extraction === "pending") continue;
    for (const quote of excerpts(source.text, 1)) {
      facts.push({
        id: `fact-${facts.length + 1}`,
        statement: quote,
        status:
          source.kind === "consultation" || source.extraction === "manual"
            ? "reported"
            : "documented",
        evidence: [{ sourceId: source.id, quote, locator: source.name.slice(0, 150) }],
      });
    }
  }
  const directTech = fieldRefs(value, ["technologySummary"]);
  const techSource = value.sources.find(
    (source) =>
      source.extraction !== "pending" &&
      ["technology", "patent"].includes(source.kind) &&
      source.text.trim(),
  );
  const evidence = directTech.length
    ? directTech
    : techSource
      ? excerpts(techSource.text, 1).map((quote) => ({
          sourceId: techSource.id,
          quote,
          locator: techSource.name.slice(0, 150),
        }))
      : [];
  const questions = sectionDefinitions.map(({ key }) => ({
    id: `question-${key}`,
    question: sectionRules[key].question,
    reason: collectReferences(value, key).length
      ? "관련 입력자료가 있습니다. 신청서에 사용할 사실과 증빙을 확인해야 합니다."
      : "해당 항목을 설명할 자료가 아직 연결되지 않았습니다.",
    priority: (["solution", "differentiation", "development", "funding"] as string[]).includes(key)
      ? ("high" as const)
      : ("medium" as const),
  }));
  if (value.profile.applicationKind === "renewal")
    questions.push({
      id: "question-renewal",
      question: "이전 확인서·신청서와 최근 3년 사업성과 지표의 기간별 증빙을 제공해 주세요.",
      reason: "재확인에 필요한 이전 기간의 개선·성과를 비교하기 위한 자료입니다.",
      priority: "high",
    });
  const candidates: Candidate[] = evidence.length
    ? [
        {
          id: "candidate-1",
          classification: "unknown",
          title: evidence[0].quote.replace(/\s+/g, " ").slice(0, 100),
          problem: "[확인 필요] " + sectionRules.problem.question,
          solution: evidence[0].quote,
          targetCustomer: value.profile.customers.trim()
            ? value.profile.customers.slice(0, 1900)
            : "[확인 필요] 구체적인 목표 고객과 구매·사용 상황",
          differentiation: "[확인 필요] " + sectionRules.differentiation.question,
          stage: "[확인 필요] 현재 개발 단계와 완료·계획의 구분",
          businessModel: "[확인 필요] 판매 방식, 가격 산정 근거와 고객 확보 경로",
          recommendation:
            "입력한 기술 설명을 신청 아이템 검토안으로 묶었습니다. 자료 정리 모드는 후보를 평가하거나 새로운 기술을 추론하지 않습니다. 기술 범위와 고객 문제를 확인한 뒤 아이템을 확정하세요.",
          evidence: uniqueReferences([...evidence, ...fieldRefs(value, ["customers"])]),
          gaps: questions
            .filter((question) => question.priority === "high")
            .map((question) => question.question),
        },
      ]
    : [];
  return analysisContentSchema.parse({
    summary: `${value.profile.companyName}의 본문 자료 ${value.sources.filter((source) => source.extraction !== "pending" && source.text.trim()).length}건과 기업정보를 정리했습니다.${value.sources.some((source) => source.extraction === "pending") ? ` 원본만 보관한 ${value.sources.filter((source) => source.extraction === "pending").length}건은 본문 미추출 상태로 분석 근거에서 제외했습니다.` : ""} ${trackContext(value)}\n자료 정리 모드는 원문 발췌와 추가 질문을 제공합니다. 기술의 우수성·권리 상태·실적의 진위를 독립적으로 검증하지 않습니다.`,
    facts: facts.slice(0, 60),
    candidates,
    questions,
    warnings: [
      "자료 정리 모드 결과입니다. AI 분석·아이템 비교·서술형 자동 작성은 AI 모드에서 실행하세요.",
      "자료 근거는 원문에 해당 내용이 있다는 뜻이며, 사실에 대한 기관 확인이나 독립 검증을 의미하지 않습니다.",
      ...(!evidence.length
        ? [
            "신청 아이템을 묶을 기술 설명이 없습니다. 기업정보의 기술·제품 설명 또는 기술·특허 자료를 입력해 주세요.",
          ]
        : []),
      ...value.sources
        .flatMap((source) => source.warnings.map((warning) => `${source.name}: ${warning}`))
        .slice(0, 20),
    ],
  });
}

function buildAssistedPlan(value: StudioCase, candidate: Candidate): PlanContent {
  const sections = sectionDefinitions.map(({ key, title }) => {
    const refs = collectReferences(value, key);
    if (key === "solution")
      refs.unshift(...candidate.evidence.filter((ref) => validReference(value, ref)));
    const evidence = uniqueReferences(refs).slice(0, 6);
    const sourceText = evidence.length
      ? evidence.map((ref) => `• ${sourceName(value, ref)}\n“${ref.quote}”`).join("\n\n")
      : "이 항목에 연결할 입력자료가 없습니다.";
    const renewal =
      key === "performance" && value.profile.applicationKind === "renewal"
        ? "\n[확인 필요] 이전 확인기간과 비교한 최근 3년 사업성과, 선택할 지표와 산정 기준·증빙을 준비해 주세요."
        : "";
    return {
      key,
      title,
      content: `입력자료 정리\n${sourceText}\n\n[확인 필요] ${sectionRules[key].question}${renewal}\n\n작성 시 완료된 사실·현재 상태·향후 계획을 구분하고, 수치에는 기준기간과 산정 근거를 연결해 주세요.`,
      evidence,
      needsConfirmation: true,
    };
  });
  return planContentSchema.parse({
    title: `${value.profile.companyName} · ${candidate.title.slice(0, 170)} 사업계획서`,
    summary: `신청 아이템 검토안: ${candidate.title}\n${trackContext(value)}\n이 문서는 입력자료를 항목별로 배치한 자료 정리 초안입니다. [확인 필요] 항목을 보강하고 실제 사업내용을 검토한 뒤 제출용 문서로 확정하세요.`,
    sections,
    actionItems: [
      ...sections.map(
        (section) => `${section.title}: ${sectionRules[section.key as SectionKey].question}`,
      ),
      ...candidate.gaps,
    ]
      .filter((item, index, all) => all.indexOf(item) === index)
      .slice(0, 40),
    interviewQuestions: assistedPreparationQuestions(value, candidate),
  });
}

function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => {
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
type PlanExecutionObservation = {
  options: EngineExecutionOptions;
  contract: EngineExecutionContract;
  requests: EngineExecutionRequest[];
  validated: Set<EngineExecutionPhase>;
};
function observationError(code: string, message: string): never {
  throw new StudioEngineError(code, message, 502);
}
function observedMetadata(raw: unknown, request: EngineExecutionRequest) {
  const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const string = (item: unknown, max: number) =>
    typeof item === "string" && item.length > 0 && item.length <= max ? item : null;
  const usage =
    value.usage !== null && typeof value.usage === "object"
      ? (value.usage as Record<string, unknown>)
      : {};
  const details = (item: unknown, key: string) =>
    item !== null && typeof item === "object"
      ? ((item as Record<string, unknown>)[key] ?? null)
      : null;
  const parsed = engineExecutionUsageSchema.safeParse({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: details(usage.input_tokens_details, "cached_tokens"),
    reasoningOutputTokens: details(usage.output_tokens_details, "reasoning_tokens"),
  });
  return engineExecutionResponseSchema.parse({
    request,
    responseId: string(value.id, 500),
    requestId: string(value._request_id, 500),
    responseModel: string(value.model, 200),
    status: string(value.status, 100),
    usage: parsed.success ? parsed.data : null,
  });
}
const capturedResponseLimit = 8 * 1024 * 1024;
function ownDataValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new Error("Response accessors are not JSON");
  return descriptor.value;
}
/** Copy only SDK JSON fields. Never serialize arbitrary clients, headers, errors, or toJSON hooks. */
function captureObservedResponse(raw: unknown): EngineExecutionCapturedResponse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Response is not an object");
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (value: number) => {
    bytes += value;
    if (bytes > capturedResponseLimit) throw new Error("Response exceeds capture limit");
  };
  const copy = (value: unknown, depth = 0): EngineExecutionJson => {
    if (depth > 100) throw new Error("Response nesting exceeds capture limit");
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      add(Buffer.byteLength(JSON.stringify(value), "utf8"));
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value))
      throw new Error("Response contains non-JSON or cyclic values");
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      throw new Error("Response contains a non-JSON object");
    if (
      Object.getOwnPropertySymbols(value).some(
        (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable,
      )
    )
      throw new Error("Response contains symbol fields");
    ancestors.add(value);
    add(2);
    let result: EngineExecutionJson;
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length)
        throw new Error("Response contains a sparse or decorated array");
      result = Array.from({ length: value.length }, (_, index) => {
        if (index) add(1);
        return copy(ownDataValue(value, String(index)), depth + 1);
      });
    } else {
      const output: { [key: string]: EngineExecutionJson } = {};
      Object.keys(value).forEach((key, index) => {
        add(Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + (index ? 1 : 0));
        Object.defineProperty(output, key, {
          value: copy(ownDataValue(value, key), depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      });
      result = output;
    }
    ancestors.delete(value);
    return result;
  };
  const result: Partial<EngineExecutionCapturedResponse> = {};
  for (const key of ["id", "_request_id", "model", "status", "usage"] as const) {
    const value = ownDataValue(raw, key);
    if (value !== undefined) result[key] = copy(value);
  }
  const output = ownDataValue(raw, "output");
  if (!Array.isArray(output)) throw new Error("Response output is not an array");
  result.output = copy(output) as EngineExecutionJson[];
  // Include the exact B artifact envelope in the byte cap, not only its payload.
  if (
    Buffer.byteLength(
      JSON.stringify({ captureKind: "sdk-response-json", response: result }),
      "utf8",
    ) > capturedResponseLimit
  )
    throw new Error("Response artifact exceeds capture limit");
  return result as EngineExecutionCapturedResponse;
}
function metadataAfterCaptureFailure(raw: unknown, request: EngineExecutionRequest) {
  // Salvage metadata without evaluating accessors or copying unsafe response branches.
  const safe = (value: unknown, key: string) => {
    try {
      return ownDataValue(value, key);
    } catch {
      return undefined;
    }
  };
  const usage = safe(raw, "usage");
  return observedMetadata(
    {
      id: safe(raw, "id"),
      _request_id: safe(raw, "_request_id"),
      model: safe(raw, "model"),
      status: safe(raw, "status"),
      usage: {
        input_tokens: safe(usage, "input_tokens"),
        output_tokens: safe(usage, "output_tokens"),
        total_tokens: safe(usage, "total_tokens"),
        input_tokens_details: {
          cached_tokens: safe(safe(usage, "input_tokens_details"), "cached_tokens"),
        },
        output_tokens_details: {
          reasoning_tokens: safe(safe(usage, "output_tokens_details"), "reasoning_tokens"),
        },
      },
    },
    request,
  );
}
function observedJson(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object")
    observationError("AI_INVALID_OUTPUT", "AI 응답 구조를 확인하지 못했습니다.");
  const value = raw as Record<string, unknown>;
  if (value.status !== "completed" || !Array.isArray(value.output))
    observationError("AI_INCOMPLETE", "AI가 완전한 결과를 반환하지 못했습니다.");
  const texts: string[] = [];
  for (const item of value.output as unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    if (message.type !== "message" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === "refusal")
        observationError("AI_INCOMPLETE", "AI가 작성 결과를 반환하지 않았습니다.");
      if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  if (texts.length !== 1 || texts[0].length > 2 * 1024 * 1024)
    observationError("AI_INVALID_OUTPUT", "AI 구조화 응답의 범위를 확인하지 못했습니다.");
  try {
    return JSON.parse(texts[0]);
  } catch {
    return observationError("AI_INVALID_OUTPUT", "AI 구조화 응답을 해석하지 못했습니다.");
  }
}
async function requestObservedStructured<T>(
  schema: z.ZodType<T>,
  name: string,
  instruction: string,
  input: string,
  observation: PlanExecutionObservation,
  prepared: EnginePlanPreparedRequest | undefined,
): Promise<T> {
  const { options, contract } = observation;
  const definition = contract.phases.find((phase) => phase.name === name);
  const sequence = observation.requests.length + 1;
  if (
    !definition ||
    sequence > contract.maxCalls ||
    sequence !== (definition.phase === "generation" ? 1 : 2) ||
    (sequence === 2 && !observation.validated.has("generation")) ||
    contract.contractDigest !== getPlanExecutionContract().contractDigest ||
    definition.instructionDigest !== executionDigest(instruction) ||
    definition.schemaDigest !== executionDigest(requestFormat(schema, name)) ||
    input.length > contract.maxInputChars ||
    !prepared ||
    prepared.phase !== definition.phase ||
    prepared.contractDigest !== contract.contractDigest ||
    prepared.body.model !== options.model ||
    prepared.body.input[0]?.role !== "system" ||
    prepared.body.input[0]?.content !== `${systemPrompt}\n\n${instruction}` ||
    prepared.body.input[1]?.role !== "user" ||
    prepared.body.input[1]?.content !== input ||
    prepared.body.input.length !== 2 ||
    executionDigest(prepared.body.text.format) !== definition.schemaDigest ||
    prepared.requestDigest !== executionDigest(prepared.body)
  )
    observationError("AI_EXECUTION_SCOPE_CHANGED", "승인한 AI 실행 범위가 달라졌습니다.");
  const body = prepared.body;
  const inputChars = body.input.reduce((sum, message) => sum + message.content.length, 0);
  if (inputChars > contract.maxInputChars)
    observationError("AI_INPUT_TOO_LARGE", "AI 요청 입력이 승인한 문자 한도를 초과했습니다.");
  const request = engineExecutionRequestSchema.parse({
    phase: definition.phase,
    sequence,
    mode: options.mode,
    provider: options.mode === "mock" ? "mock" : "OpenAI",
    configuredModel: options.model,
    contractDigest: contract.contractDigest,
    requestDigest: prepared.requestDigest,
    inputChars,
    maxOutputTokens: 16000,
  });
  let realClient: OpenAI | undefined;
  if (options.mode === "actual-ai") {
    const status = getAiStatus();
    if (!status.aiConfigured || status.model !== options.model)
      observationError(
        "AI_EXECUTION_CONFIGURATION_CHANGED",
        "승인한 AI 모델 설정을 확인해 주세요.",
      );
    realClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY?.trim(),
      timeout: 120000,
      maxRetries: 0,
      baseURL: "https://api.openai.com/v1",
    });
  }
  // Durable hooks deliberately sit outside transport/validation error conversion.
  await options.hooks.onRequestPrepared?.(immutableCopy({ request, body }));
  await options.hooks.onDispatch(immutableCopy(request));
  observation.requests.push(request);
  let raw: unknown;
  try {
    raw =
      options.mode === "mock"
        ? await options.transport(immutableCopy({ request, body }))
        : await realClient!.responses.create(body);
  } catch {
    return observationError(
      "AI_REQUEST_FAILED",
      "AI 요청 결과를 확인하지 못했습니다. 자동으로 다시 전송하지 않습니다.",
    );
  }
  // Capture synchronously before any awaited hook can mutate a retained SDK response.
  let captured: EngineExecutionCapturedResponse;
  try {
    captured = captureObservedResponse(raw);
  } catch {
    await options.hooks.onResponse(immutableCopy(metadataAfterCaptureFailure(raw, request)));
    return observationError("AI_INVALID_OUTPUT", "AI 응답 구조를 보관할 수 없습니다.");
  }
  const metadata = observedMetadata(captured, request);
  // The raw hook owns durable response recording for ledger runners; their legacy hook is a noop.
  await options.hooks.onResponseCaptured?.(immutableCopy({ metadata, capturedResponse: captured }));
  await options.hooks.onResponse(immutableCopy(metadata));
  const parsed = schema.safeParse(observedJson(captured));
  if (!parsed.success) observationError("AI_INVALID_OUTPUT", "AI 출력 형식 검증에 실패했습니다.");
  return parsed.data;
}
async function recordObservedValidation(
  observation: PlanExecutionObservation,
  phase: EngineExecutionPhase,
  output: EngineExecutionOutput,
) {
  const request = observation.requests.at(-1);
  if (!request || request.phase !== phase || observation.validated.has(phase))
    observationError("AI_EXECUTION_SCOPE_CHANGED", "AI 출력 검증 단계가 일치하지 않습니다.");
  const event = engineExecutionValidatedSchema.parse({
    request,
    output,
    outputDigest: executionDigest(output),
  });
  await observation.options.hooks.onValidated(immutableCopy(event));
  observation.validated.add(phase);
}
/** One generation and one independent review. No repair, retry, company writes, or input auto-selection. */
export async function generateObservedPlan(
  value: StudioCase,
  candidate: Candidate,
  options: EngineExecutionOptions,
): Promise<EngineExecutionResult> {
  const contract = getPlanExecutionContract();
  if (
    !options ||
    !["mock", "actual-ai"].includes(options.mode) ||
    !options.model ||
    options.model.trim() !== options.model ||
    options.model.length > 200 ||
    options.contractDigest !== contract.contractDigest ||
    (options.mode === "mock" ? typeof options.transport !== "function" : "transport" in options)
  )
    observationError("AI_EXECUTION_SCOPE_CHANGED", "AI 실행 출처와 승인 범위를 확인해 주세요.");
  const isolatedOptions = { ...options, hooks: { ...options.hooks } } as EngineExecutionOptions;
  const observation: PlanExecutionObservation = {
    options: isolatedOptions,
    contract,
    requests: [],
    validated: new Set(),
  };
  const result = await generateReviewedAiPlan(
    structuredClone(value),
    structuredClone(candidate),
    isolatedOptions.beforeRequest,
    observation,
  );
  if (observation.validated.size !== 2)
    observationError("AI_EXECUTION_INCOMPLETE", "AI 실행 검증을 완료하지 못했습니다.");
  return { ...result, contractDigest: contract.contractDigest };
}

async function requestStructured<T>(
  schema: z.ZodType<T>,
  name: string,
  instruction: string,
  input: string,
  approvedProviderOnly = false,
  observation?: PlanExecutionObservation,
  prepared?: EnginePlanPreparedRequest,
): Promise<T> {
  if (observation)
    return requestObservedStructured(schema, name, instruction, input, observation, prepared);
  const status = getAiStatus();
  if (!status.aiConfigured)
    throw new StudioEngineError(
      "AI_NOT_CONFIGURED",
      "AI 연결이 설정되지 않았습니다. 서버의 OPENAI_API_KEY를 설정하거나 자료 정리 모드를 사용해 주세요.",
      503,
    );
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY?.trim(),
      timeout: 120000,
      maxRetries: approvedProviderOnly ? 0 : 1,
      // Guided consent names OpenAI; an inherited SDK endpoint override must not change that destination.
      ...(approvedProviderOnly ? { baseURL: "https://api.openai.com/v1" } : {}),
    });
    const response = await client.responses.parse({
      model: status.model,
      store: false,
      max_output_tokens: 16000,
      input: [
        { role: "system", content: `${systemPrompt}\n\n${instruction}` },
        { role: "user", content: input },
      ],
      text: { format: zodTextFormat(schema, name) },
    });
    if (response.status !== "completed" || !response.output_parsed) {
      throw new StudioEngineError(
        "AI_INCOMPLETE",
        "AI가 완전한 결과를 반환하지 못했습니다. 입력자료를 확인하고 다시 실행해 주세요. 기존 결과는 유지됩니다.",
        502,
      );
    }
    return schema.parse(response.output_parsed);
  } catch (error) {
    if (error instanceof StudioEngineError) throw error;
    // Do not expose upstream error bodies, request content, or credentials to the browser.
    throw new StudioEngineError(
      "AI_REQUEST_FAILED",
      "AI 요청을 완료하지 못했습니다. 서버의 API 연결·모델 접근·사용 한도를 확인한 뒤 다시 실행해 주세요. 자료 정리 모드로 자동 전환하지 않았습니다.",
      502,
    );
  }
}

function validateEvidence(value: StudioCase, refs: Reference[]) {
  if (refs.some((ref) => !validReference(value, ref))) {
    throw new StudioEngineError(
      "AI_INVALID_EVIDENCE",
      "AI 결과에 원문과 일치하지 않는 근거가 있어 저장하지 않았습니다. 자료를 확인하고 다시 생성해 주세요.",
      502,
    );
  }
}

export async function analyzeCompany(
  value: StudioCase,
  mode: Mode,
  beforeRequest?: () => void,
): Promise<AnalysisContent> {
  if (mode === "assisted") return buildAssistedAnalysis(value);
  beforeRequest?.();
  const result = await requestStructured(
    aiAnalysisContentSchema,
    "company_analysis",
    "회사의 역량과 고객 문제를 분석하고 현재 자료로 설명할 수 있는 신청 아이템 후보를 1~3개 제안하라. 정보가 부족하면 후보 0개와 구체적인 자료 질문을 반환하라. 후보 수를 채우기 위해 기술·사업을 발명하지 마라. 각 후보에 기술 범위, 고객, 해결방식, 차별성 근거, 현재 단계, 수익방식, 추천 이유와 보강과제를 작성하라. 신청기술이 실제 사업과 어떻게 연결되는지, 비교조건을 갖춘 차별성 자료가 있는지, 자사·외부 개발의 범위와 지속 개발 인력·인프라, 완료·계획 구분, 인력·자금·일정의 실행 조건을 함께 분석하라. 시장확대 전략은 신청기술의 고객 가치와 구매·도입 경로에 연결하고 추상적인 우수성·홍보 표현은 구체적 확인 질문으로 바꾸라. 새 제안은 제안이라고 표시하라. facts와 candidates의 id는 각각 중복 없이 부여하라. 후보에는 적어도 하나의 실질적 evidence가 필요하다. questions는 답하면 문서를 보강할 수 있는 구체적 질문이어야 한다." +
      candidateClassificationInstructions,
    aiInput(value),
    Boolean(beforeRequest),
  );
  const facts = new Set(result.facts.map((fact) => fact.id));
  const candidates = new Set(result.candidates.map((candidate) => candidate.id));
  if (
    facts.size !== result.facts.length ||
    candidates.size !== result.candidates.length ||
    result.candidates.some((candidate) => !candidate.evidence.length)
  ) {
    throw new StudioEngineError(
      "AI_INVALID_ANALYSIS",
      "AI 분석 결과의 아이템·근거 구조가 올바르지 않아 저장하지 않았습니다. 다시 분석해 주세요.",
      502,
    );
  }
  validateEvidence(value, [
    ...result.facts.flatMap((fact) => fact.evidence),
    ...result.candidates.flatMap((candidate) => candidate.evidence),
  ]);
  for (const fact of result.facts)
    if (!fact.evidence.length && ["documented", "reported"].includes(fact.status))
      fact.status = "unverified";
  const ownClaims = [
    result.summary,
    ...result.candidates.flatMap((candidate) => [
      candidate.title,
      candidate.problem,
      candidate.solution,
      candidate.targetCustomer,
      candidate.differentiation,
      candidate.stage,
      candidate.businessModel,
      candidate.recommendation,
    ]),
  ].join("\n");
  if (guaranteePattern.test(ownClaims))
    throw new StudioEngineError(
      "AI_INVALID_CLAIM",
      "AI 결과에 심사 통과를 보장하거나 확률을 단정하는 표현이 있어 저장하지 않았습니다. 다시 분석해 주세요.",
      502,
    );
  for (const fact of result.facts) {
    if (guaranteePattern.test(fact.statement)) {
      fact.status = "unverified";
      result.warnings.unshift(
        "입력자료에서 심사 결과를 단정하는 진술이 발견되었습니다. 해당 진술은 미검증으로 표시했으며 신청 근거로 사용할 수 없습니다.",
      );
    }
  }
  result.warnings = [
    ...result.warnings,
    "근거 연결은 원문 기재 여부 확인이며, 권리·실적에 대한 독립 검증이나 심사 결과 예측이 아닙니다.",
  ].slice(0, 30);
  return result;
}

export async function generatePlan(
  value: StudioCase,
  candidate: Candidate,
  mode: Mode,
  beforeRequest?: () => void,
): Promise<PlanContent> {
  if (mode === "assisted") return buildAssistedPlan(value, candidate);
  return (await generateReviewedAiPlan(value, candidate, beforeRequest)).content;
}

async function generateReviewedAiPlan(
  value: StudioCase,
  candidate: Candidate,
  beforeRequest?: () => void,
  observation?: PlanExecutionObservation,
) {
  beforeRequest?.();
  const prepared = observation
    ? buildPlanGenerationRequest(value, candidate, observation.options.model)
    : undefined;
  const result = await requestStructured(
    planContentSchema,
    "business_plan",
    planGenerationInstruction,
    prepared?.body.input[1].content ??
      aiInput(value, {
        selectedCandidate: { ...candidate, classification: getCandidateClassification(candidate) },
        sectionDefinitions,
      }),
    Boolean(beforeRequest),
    observation,
    prepared,
  );
  return independentlyReviewPlan(value, candidate, result, beforeRequest, undefined, observation);
}

function validatePlanDraft(value: StudioCase, result: PlanContent) {
  const keys = result.sections.map((section) => section.key);
  if (
    keys.length !== sectionDefinitions.length ||
    sectionDefinitions.some((definition, index) => keys[index] !== definition.key)
  ) {
    throw new StudioEngineError(
      "AI_INVALID_PLAN",
      "AI 결과의 사업계획서 항목이 누락되거나 중복되어 저장하지 않았습니다. 다시 작성해 주세요.",
      502,
    );
  }
  validateEvidence(
    value,
    result.sections.flatMap((section) => section.evidence),
  );
  result.sections.forEach((section, index) => {
    section.title = sectionDefinitions[index].title;
  });
  const findings = reviewPlan(value, result);
  if (findings.some((finding) => finding.category === "guarantee"))
    throw new StudioEngineError(
      "AI_INVALID_CLAIM",
      "AI 결과에 심사 통과를 단정하는 표현이 있어 저장하지 않았습니다. 다시 작성해 주세요.",
      502,
    );
  for (const section of result.sections) {
    if (
      findings.some((finding) => finding.sectionKey === section.key && finding.severity !== "info")
    )
      section.needsConfirmation = true;
  }
}

/** Pure domain boundary for the separate provider observer; never creates an AI client. */
export function validateObservedPlanDraft(value: StudioCase, raw: unknown): PlanContent {
  const result = planContentSchema.parse(raw);
  validatePlanDraft(value, result);
  return result;
}

export function validateObservedPlanReview(value: StudioCase, raw: unknown): ReviewFinding[] {
  const result = planSemanticReviewSchema.parse(raw);
  const sourceIds = new Set([
    "profile",
    ...value.sources.filter((source) => source.extraction !== "pending").map((source) => source.id),
  ]);
  const sectionKeys = new Set<string>(sectionDefinitions.map((section) => section.key));
  if (
    result.findings.some(
      (finding) =>
        finding.sourceIds.some((id) => !sourceIds.has(id)) ||
        (finding.sectionKey !== null && !sectionKeys.has(finding.sectionKey)),
    )
  ) {
    throw new StudioEngineError(
      "AI_INVALID_REVIEW",
      "AI 검토 의견에 존재하지 않는 자료나 항목이 연결되어 저장하지 않았습니다. 다시 작성해 주세요.",
      502,
    );
  }
  return result.findings;
}

export function finalizeObservedPlanReview(
  value: StudioCase,
  draft: PlanContent,
  findings: ReviewFinding[],
) {
  const result = planContentSchema.parse(draft);
  for (const finding of findings) {
    if (finding.severity !== "info") {
      for (const section of result.sections)
        if (finding.sectionKey === null || finding.sectionKey === section.key)
          section.needsConfirmation = true;
    }
  }
  const reviewActions = findings.map(planReviewAction);
  result.actionItems = [...reviewActions, ...result.actionItems].slice(0, 40);
  result.interviewQuestions = result.interviewQuestions.map(markPreparationQuestion);
  return {
    content: planContentSchema.parse(result),
    review: [...reviewPlan(value, result), ...findings],
    semanticReview: findings,
  };
}

async function independentlyReviewPlan(
  value: StudioCase,
  candidate: Candidate,
  result: PlanContent,
  beforeRequest?: () => void,
  previous?: { initial: PlanContent; initialReview: ReviewFinding[] },
  observation?: PlanExecutionObservation,
) {
  validatePlanDraft(value, result);
  if (observation)
    await recordObservedValidation(observation, "generation", { kind: "plan", content: result });
  beforeRequest?.();
  const prepared = observation
    ? buildPlanReviewRequest(value, candidate, result, observation.options.model)
    : undefined;
  const independentReview = await requestStructured(
    planSemanticReviewSchema,
    "business_plan_review",
    planReviewInstruction,
    prepared?.body.input[1].content ??
      aiInput(value, { selectedCandidate: candidate, draft: result, ...previous }),
    Boolean(beforeRequest),
    observation,
    prepared,
  );
  validateObservedPlanReview(value, independentReview);
  if (observation)
    await recordObservedValidation(observation, "review", {
      kind: "review",
      findings: independentReview.findings,
    });
  return finalizeObservedPlanReview(value, result, independentReview.findings);
}

export type PlanRepairResult = {
  initial: PlanContent;
  content: PlanContent;
  initialReview: ReviewFinding[];
  finalReview: ReviewFinding[];
  repairStatus: "not-needed" | "applied" | "unresolved" | "rejected" | "failed";
  repairReason: string;
  attempted: boolean;
};
export type PlanRepairHooks = {
  onInitial: (initial: PlanContent, initialReview: ReviewFinding[]) => void;
  beforeRepair: () => void;
};
function planReviewAction(finding: ReviewFinding) {
  const label =
    sectionDefinitions.find((definition) => definition.key === finding.sectionKey)?.title ||
    "문서 전체";
  return `[AI 검토 의견 · ${label}] ${finding.message.slice(0, 1300)}\n확인·수정: ${finding.action.slice(0, 1300)}`;
}
const semanticRepairCategories = new Set([
  "semantic-evidence",
  "contradiction",
  "timeline",
  "financial-plan",
  "fact-vs-plan",
]);
const reviewSeverity = { info: 0, warning: 1, error: 2 } as const;
const reviewKey = (finding: ReviewFinding) => `${finding.category}:${finding.sectionKey ?? "all"}`;
function repairableFinding(finding: ReviewFinding) {
  if (
    finding.severity === "info" ||
    !semanticRepairCategories.has(finding.category) ||
    !finding.sourceIds.length
  )
    return false;
  // A missing fact or new evidence request belongs to the user, not a paid wording loop.
  const missing =
    /(?:자료|증빙|근거|정보|수치|일정|인력|자금|시험|측정|성과).{0,30}(?:없|부족|미제공|미확인|제공되지|빠졌|누락)/.test(
      finding.message,
    );
  const request = /추가|제공|요청|제출|보강|확인/.test(finding.action);
  return !(missing && request);
}
function reviewRegressed(initial: ReviewFinding[], next: ReviewFinding[]) {
  const before = initial.filter((finding) => finding.severity !== "info");
  const after = next.filter((finding) => finding.severity !== "info");
  for (const finding of after) {
    const matched = before.filter((previous) => reviewKey(previous) === reviewKey(finding));
    if (
      !matched.length ||
      reviewSeverity[finding.severity] >
        Math.max(...matched.map((previous) => reviewSeverity[previous.severity]))
    )
      return true;
  }
  return (
    after.length > before.length ||
    after.reduce((sum, finding) => sum + reviewSeverity[finding.severity], 0) >
      before.reduce((sum, finding) => sum + reviewSeverity[finding.severity], 0)
  );
}

/** At most one repair and one independent rereview. It never verifies facts or clears human checks. */
export async function generatePlanWithRepair(
  value: StudioCase,
  candidate: Candidate,
  beforeRequest: () => void,
  hooks?: PlanRepairHooks,
): Promise<PlanRepairResult> {
  let guardFailed = false;
  let guardError: unknown;
  const checked = () => {
    guardFailed = false;
    try {
      beforeRequest();
    } catch (error) {
      guardFailed = true;
      guardError = error;
      throw error;
    }
  };
  const reviewed = await generateReviewedAiPlan(value, candidate, checked);
  checked();
  const initial = structuredClone(reviewed.content);
  const initialReview = structuredClone(reviewed.review);
  // Durable checkpoint hooks are outside the provider-error fallback path.
  hooks?.onInitial(structuredClone(initial), structuredClone(initialReview));
  checked();
  const fallback = (
    repairStatus: PlanRepairResult["repairStatus"],
    repairReason: string,
    attempted: boolean,
  ): PlanRepairResult => {
    checked();
    return {
      initial,
      content: initial,
      initialReview,
      finalReview: initialReview,
      repairStatus,
      repairReason,
      attempted,
    };
  };
  const actionable = reviewed.semanticReview.filter(repairableFinding);
  if (!actionable.length)
    return fallback(
      "not-needed",
      "현재 자료로 바로 고칠 문장 문제가 없습니다. 필요한 사실 확인과 자료 요청은 유지합니다.",
      false,
    );
  hooks?.beforeRepair();
  checked();
  try {
    const result = await requestStructured(
      planContentSchema,
      "business_plan_repair",
      "제공된 원문으로 입증할 수 있는 표현 문제만 한 번 수정하라. actionableFindings에 표시한 부분의 과장·원문 충돌·완료와 계획 혼동·서술 연결을 고친다. 새로운 사실·수치·실적·권리·인력·계약·일정을 만들지 마라. 새로운 자료나 대표 확인이 필요한 문제는 기존 확인 질문과 actionItems로 남긴다. sectionDefinitions의 10개 key와 순서를 유지하고, finding의 sectionKey가 지정된 경우 해당 항목만 수정하며 다른 항목의 본문·근거는 그대로 둔다. sectionKey=null인 문제는 연관된 항목을 함께 수정할 수 있다. initial의 needsConfirmation=true는 그대로 true를 유지한다. 확인·검토가 끝났다고 표시하거나 합격을 보장하지 않는다. evidence는 제공된 sourceId와 원문에 그대로 있는 quote만 쓴다. 기존 자료 요청과 interviewQuestions를 삭제하지 말고 필요한 질문만 추가한다. 해결한 이전 AI 검토 의견을 현재 미해결 의견으로 복제하지 마라. 완전한 계획서 구조를 반환하라.",
      aiInput(value, {
        selectedCandidate: candidate,
        initial,
        actionableFindings: actionable,
        sectionDefinitions,
      }),
      true,
    );
    validatePlanDraft(value, result);
    const globalIssue = actionable.some((finding) => finding.sectionKey === null);
    const targeted = new Set(actionable.map((finding) => finding.sectionKey));
    for (const section of result.sections) {
      const prior = initial.sections.find((item) => item.key === section.key)!;
      if (
        !globalIssue &&
        !targeted.has(section.key) &&
        (section.content !== prior.content ||
          JSON.stringify(section.evidence) !== JSON.stringify(prior.evidence))
      )
        throw new StudioEngineError(
          "AI_REPAIR_SCOPE_CHANGED",
          "수정 대상 밖의 내용이 바뀌어 기존 초안을 유지합니다.",
          502,
        );
      section.needsConfirmation ||= prior.needsConfirmation;
    }
    // Only replace opinions this repair could address. Missing facts and evidence requests remain.
    const previousReviewActions = new Set(actionable.map(planReviewAction));
    const priorActions = initial.actionItems.filter((item) => !previousReviewActions.has(item));
    result.actionItems = [
      ...new Set([
        ...priorActions,
        ...result.actionItems.filter((item) => !previousReviewActions.has(item)),
      ]),
    ];
    result.interviewQuestions = [
      ...new Set([
        ...initial.interviewQuestions,
        ...result.interviewQuestions.map(markPreparationQuestion),
      ]),
    ];
    if (result.actionItems.length > 40 || result.interviewQuestions.length > 30)
      throw new StudioEngineError(
        "AI_REPAIR_LIMIT",
        "기존 확인 과제를 모두 보존할 수 없어 기존 초안을 유지합니다.",
        502,
      );
    const next = await independentlyReviewPlan(value, candidate, result, checked, {
      initial,
      initialReview,
    });
    checked();
    if (
      reviewRegressed(initialReview, next.review) ||
      priorActions.some((item) => !next.content.actionItems.includes(item))
    )
      return fallback(
        "rejected",
        "수정본에서 새로운 문제나 누락이 발견되어 검토한 기존 초안을 유지합니다.",
        true,
      );
    const unresolved = next.semanticReview.some((finding) => finding.severity !== "info");
    return {
      initial,
      content: next.content,
      initialReview,
      finalReview: next.review,
      repairStatus: unresolved ? "unresolved" : "applied",
      repairReason: unresolved
        ? "한 번 수정하고 다시 검토했습니다. 남은 의견은 사용자 확인과 보완 과제로 유지합니다."
        : "원문에 맞게 한 번 수정하고 다시 검토했습니다. 사실 확인과 검토 완료는 별도로 확인해야 합니다.",
      attempted: true,
    };
  } catch (error) {
    if (guardFailed && error === guardError) throw error;
    const rejected =
      error instanceof z.ZodError ||
      (error instanceof StudioEngineError && /^(AI_INVALID_|AI_REPAIR_)/.test(error.code));
    return fallback(
      rejected ? "rejected" : "failed",
      rejected
        ? "수정본의 근거·구조를 검증하지 못해 검토한 기존 초안을 유지합니다."
        : "추가 수정 요청을 완료하지 못해 검토한 기존 초안을 유지합니다. 자동으로 다시 요청하지 않습니다.",
      true,
    );
  }
}

export function reviewPlan(value: StudioCase, content: PlanContent): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  function add(
    severity: ReviewFinding["severity"],
    category: string,
    message: string,
    action: string,
    sectionKey: string | null = null,
    sourceIds: string[] = [],
  ) {
    findings.push({
      id: `review-${findings.length + 1}`,
      severity,
      category,
      message,
      action,
      sectionKey,
      sourceIds,
    });
  }
  const expected = new Set<string>(sectionDefinitions.map((section) => section.key));
  const seen = new Set<string>();
  for (const definition of sectionDefinitions) {
    if (!content.sections.some((section) => section.key === definition.key))
      add(
        "error",
        "missing-section",
        `${definition.title} 항목이 없습니다.`,
        "누락된 항목을 작성하고 해당 근거를 연결해 주세요.",
        definition.key,
      );
  }
  if (guaranteePattern.test(`${content.title}\n${content.summary}`))
    add(
      "error",
      "guarantee",
      "문서에 심사 결과를 보장하거나 확률을 단정하는 표현이 있습니다.",
      "심사 결과 예측을 제거하고 기술·사업 근거 중심으로 수정해 주세요.",
    );
  for (const section of content.sections) {
    if (seen.has(section.key))
      add(
        "error",
        "duplicate-section",
        "같은 사업계획서 항목이 중복되어 있습니다.",
        "내용과 근거를 하나의 항목으로 통합해 주세요.",
        section.key,
      );
    seen.add(section.key);
    if (!expected.has(section.key))
      add(
        "warning",
        "unknown-section",
        "기본 작성 항목에 없는 항목입니다.",
        "기본 항목을 대체한 내용인지 확인하고 적절한 항목으로 옮겨 주세요.",
        section.key,
      );
    if (!section.content.trim())
      add(
        "error",
        "empty-section",
        "작성 내용이 비어 있습니다.",
        "회사 자료를 근거로 내용을 작성하거나 부족한 자료를 명시해 주세요.",
        section.key,
      );
    const badRefs = section.evidence.filter((ref) => !validReference(value, ref));
    if (badRefs.length)
      add(
        "error",
        "invalid-reference",
        "삭제된 자료 또는 원문과 일치하지 않는 인용이 있습니다.",
        "현재 원문에서 정확한 문장을 다시 연결해 주세요.",
        section.key,
        [...new Set(badRefs.map((ref) => ref.sourceId))],
      );
    if (section.content.trim() && !section.evidence.length)
      add(
        "warning",
        "missing-evidence",
        "본문을 뒷받침하는 근거가 연결되지 않았습니다.",
        "입력자료의 관련 문장과 증빙을 연결하거나 제안·미확인임을 명시해 주세요.",
        section.key,
      );
    if (
      /\[확인\s*필요\]|\[자료\s*필요\]|TODO|TBD|미입력|미확인|추가\s*확인\s*필요/i.test(
        section.content,
      ) ||
      section.needsConfirmation
    )
      add(
        "warning",
        "confirmation",
        "추가 확인 또는 자료 보강이 필요한 항목입니다.",
        "확인 질문에 답하고 문장·수치·근거를 함께 수정한 뒤 검토 여부를 표시해 주세요.",
        section.key,
      );
    if (guaranteePattern.test(section.content))
      add(
        "error",
        "guarantee",
        "심사 결과를 보장하거나 합격확률을 단정하는 표현이 있습니다.",
        "결과 보장을 제거하고 입증 가능한 기술·사업 내용으로 수정해 주세요.",
        section.key,
      );
    const numbers = [
      ...new Set(
        section.content.match(
          /\d[\d,.]*\s*(?:%|％|억원|만원|백만원|천만원|억\s*원|만\s*원|원|명|건|개사|배)/g,
        ) || [],
      ),
    ];
    const quotes = section.evidence
      .filter((ref) => validReference(value, ref))
      .map((ref) => ref.quote.replace(/\s+/g, ""));
    const unmatched = numbers.filter(
      (number) => !quotes.some((quote) => quote.includes(number.replace(/\s+/g, ""))),
    );
    if (unmatched.length)
      add(
        "warning",
        "numeric-evidence",
        `인용 근거와 직접 대조되지 않은 수치가 있습니다: ${unmatched.slice(0, 8).join(", ")}`,
        "실적이면 기준기간·산식·원본을 연결하고, 목표나 가정이면 제안·계획임을 표시해 주세요. 단위 변환 수치는 산식을 확인해 주세요.",
        section.key,
      );
    if (
      section.evidence.length &&
      section.evidence.every(
        (ref) =>
          ref.sourceId === "profile" ||
          value.sources.find((source) => source.id === ref.sourceId)?.kind === "consultation",
      )
    )
      add(
        "info",
        "reported-only",
        "현재 연결된 근거는 기업 입력 또는 상담 진술입니다.",
        "주요 기술·계약·실적 주장에 해당하는 객관적 원본 자료도 확인해 주세요.",
        section.key,
        [...new Set(section.evidence.map((ref) => ref.sourceId))],
      );
  }
  add(
    "info",
    "review-scope",
    "이 검토는 항목·인용 일치·누락·일부 수치 표현을 점검합니다. 문장 전체의 사실성·법적 권리·심사 적합성을 자동 확정하지 않습니다.",
    "제출 전 원본 서류, 최신 공식 신청 항목, 대표의 실제 설명과 대조해 주세요.",
  );
  return findings;
}
