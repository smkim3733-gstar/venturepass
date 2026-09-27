import { z } from "zod";
import { guidedPreparationRunSchema } from "./studio-guided-preparation-types";
import {
  preparationAutomationSchema,
  preparationAutomationSettingInputSchema,
  emptyPreparationAutomation,
} from "./studio-preparation-automation-types";
import {
  criteriaVersionMutationSchema,
  criteriaVersionSchema,
  applicationCriteriaBindingSchema,
  applicationCriteriaContextsSchema,
  criteriaVersionLimits,
} from "./studio-criteria-version-types";
import {
  appendApplicationProcedureSchema,
  applicationProcedureSchema,
  applicationProcedureLimits,
} from "./studio-application-procedure-types";
import {
  adoptSourceSuggestionsMutationSchema,
  sourceSuggestionLimits,
  sourceSuggestionReceiptSchema,
} from "./studio-source-suggestion-types";
import { sourceIntakeItemSchema, sourceIntakeLimits } from "./studio-source-intake-types";
import {
  appendClaimReviewMutationSchema,
  claimReviewLimits,
  claimReviewRecordSchema,
} from "./studio-claim-review-types";
import { candidateClassificationSchema } from "./studio-candidate-classification";
import {
  appendCompanyContactsMutationSchema,
  companyContactsLimits,
  companyContactsRecordSchema,
} from "./studio-company-contacts-types";
import {
  candidateSelectionLimits,
  candidateSelectionMutationSchema,
  candidateSelectionSchema,
} from "./studio-candidate-selection-types";
import {
  certificateTaskOriginSchema,
  createCertificateTaskMutationSchema,
} from "./studio-certificate-renewal-types";
import {
  numericCheckAppendMutationSchema,
  numericCheckLimits,
  numericCheckSchema,
} from "./studio-numeric-check-types";
import {
  appendPlanReviewMutationSchema,
  planReviewDecisionSchema,
  planReviewLimits,
} from "./studio-plan-review-types";
import {
  visitAnswerAppendMutationSchema,
  visitAnswerLimits,
  visitAnswerSchema,
} from "./studio-visit-answer-types";
import {
  responsePreparationSchema,
  responsePreparationLimits,
  appendResponsePreparationMutationSchema,
  registerPreparedResponseMutationSchema,
} from "./studio-response-preparation-types";
import {
  applicationCycleSchema,
  applicationEventSchema,
  applicationLimits,
  applicationMutationSchema,
} from "./studio-application-types";
import { taskProcessingSchema } from "./studio-task-processing-types";
import { MAX_PREPARATION_RUNS, preparationRunSchema } from "./studio-preparation-types";
import {
  diagnosisAnswersSchema,
  diagnosisSchema,
  emptyDiagnosisAnswers,
  MAX_DIAGNOSES,
} from "./studio-diagnosis-types";
import { agencyAppendMutationSchema, agencyRecordSchema } from "./studio-agency-records";
import {
  appealAppendMutationSchema,
  appealPreparationSchema,
  MAX_APPEAL_VERSIONS,
} from "./studio-appeal-types";
import {
  MAX_OCR_REVIEWS,
  reviewLocalOcrMutationSchema,
  sourceOcrReviewSchema,
} from "./studio-ocr-review";

export const sourceKinds = [
  "consultation",
  "patent",
  "technology",
  "finance",
  "market",
  "team",
  "other",
] as const;
export const sourceKindLabels: Record<(typeof sourceKinds)[number], string> = {
  consultation: "상담·녹취",
  patent: "특허·지식재산",
  technology: "기술·제품",
  finance: "재무·자금",
  market: "시장·고객",
  team: "인력·협업",
  other: "기타 서류",
};
const text = (max = 10000) => z.string().max(max);
const optionalPaidInCapital = z
  .string()
  .max(16, "납입자본금은 9,007,199,254,740,991원 이하여야 합니다.")
  .refine((value) => {
    if (value === "") return true;
    const amount = Number(value);
    return Number.isSafeInteger(amount) && amount >= 0 && String(amount) === value;
  }, "납입자본금은 0 이상 9,007,199,254,740,991원 이하의 정수를 쉼표 없이 입력해 주세요.");
const optionalClosingMonth = z.enum(
  ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
  { error: "결산월은 1월부터 12월 중에서 선택해 주세요." },
);
const optionalDate = z.string().refine((value) => {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1900 &&
    year <= 2200 &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}, "날짜를 YYYY-MM-DD 형식으로 입력해 주세요.");
export const companyProfileSchema = z
  .object({
    companyName: z.string().trim().min(1, "기업명을 입력해 주세요.").max(100),
    businessNumber: text(30),
    industry: text(100),
    foundedOn: optionalDate,
    paidInCapital: optionalPaidInCapital.default(""),
    closingMonth: optionalClosingMonth.default(""),
    applicationDate: optionalDate,
    applicationKind: z.enum(["new", "renewal"]),
    technologySummary: text(),
    customers: text(),
    team: text(),
    financials: text(),
    developmentPlan: text(),
    patents: text(),
  })
  .refine(
    (profile) =>
      !profile.foundedOn ||
      !profile.applicationDate ||
      profile.applicationDate >= profile.foundedOn,
    { message: "신청예정일은 설립일 이후여야 합니다.", path: ["applicationDate"] },
  );
export type CompanyProfile = z.infer<typeof companyProfileSchema>;
export function emptyProfile(): CompanyProfile {
  return {
    companyName: "",
    businessNumber: "",
    industry: "",
    foundedOn: "",
    paidInCapital: "",
    closingMonth: "",
    applicationDate: "",
    applicationKind: "new",
    technologySummary: "",
    customers: "",
    team: "",
    financials: "",
    developmentPlan: "",
    patents: "",
  };
}
export const originalOnlyWarnings = [
  "원본만 보관했습니다. 본문을 추출하지 않았습니다.",
  "원본 내용을 검토하고 필요한 본문을 직접 입력해 주세요. 원본 보관은 분석·검토 완료를 의미하지 않습니다.",
] as const;
export const sourceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    kind: z.enum(sourceKinds),
    text: z.string().max(100000),
    originalName: text(200).nullable(),
    mimeType: text(150).nullable(),
    extraction: z.enum(["manual", "local", "ai", "pending"]),
    warnings: z.array(text(1000)).max(30),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .refine((source) => source.extraction !== "pending" || source.text === "", {
    message: "본문 미추출 자료는 원본만 보관할 수 있습니다. 본문 입력은 별도로 저장해 주세요.",
    path: ["text"],
  });
export type SourceDocument = z.infer<typeof sourceSchema>;
export const referenceSchema = z.object({
  sourceId: z.string(),
  quote: text(1500),
  locator: text(150),
});
export const factSchema = z.object({
  id: z.string(),
  statement: text(3000),
  status: z.enum(["documented", "reported", "planned", "unverified"]),
  evidence: z.array(referenceSchema),
});
export const candidateSchema = z.object({
  id: z.string(),
  classification: candidateClassificationSchema.optional(),
  title: text(250),
  problem: text(3000),
  solution: text(4000),
  targetCustomer: text(2000),
  differentiation: text(4000),
  stage: text(1000),
  businessModel: text(2000),
  recommendation: text(3000),
  evidence: z.array(referenceSchema),
  gaps: z.array(text(2000)),
});
export type Candidate = z.infer<typeof candidateSchema>;
export const analysisContentSchema = z.object({
  summary: text(6000),
  facts: z.array(factSchema).max(60),
  candidates: z.array(candidateSchema).max(3),
  questions: z
    .array(
      z.object({
        id: z.string(),
        question: text(2000),
        reason: text(2000),
        priority: z.enum(["high", "medium"]),
      }),
    )
    .max(30),
  warnings: z.array(text(2000)).max(30),
});
export type AnalysisContent = z.infer<typeof analysisContentSchema>;
export const analysisSchema = analysisContentSchema.extend({
  generatedAt: z.string(),
  mode: z.enum(["ai", "assisted"]),
  sourceRevision: z.number().int(),
});
export type CompanyAnalysis = z.infer<typeof analysisSchema>;
export const sectionDefinitions = [
  { key: "problem", title: "개발 필요성과 고객의 문제" },
  { key: "solution", title: "신청기술의 구성과 해결방법" },
  { key: "differentiation", title: "기술 차별성과 경쟁 비교" },
  { key: "development", title: "개발 경과와 향후 3년 계획" },
  { key: "team", title: "대표·기술인력과 연구개발 역량" },
  { key: "ip", title: "지식재산권과 기술 활용" },
  { key: "market", title: "목표시장·고객과 경쟁환경" },
  { key: "commercialization", title: "사업화·시장진입·협업 전략" },
  { key: "funding", title: "자금 조달·운용과 실행계획" },
  { key: "performance", title: "사업성과와 지속적인 혁신" },
] as const;
export const sectionSchema = z.object({
  key: z.string(),
  title: text(200),
  content: text(18000),
  evidence: z.array(referenceSchema),
  needsConfirmation: z.boolean(),
});
export const planContentSchema = z.object({
  title: text(300),
  summary: text(6000),
  sections: z.array(sectionSchema).max(20),
  actionItems: z.array(text(3000)).max(40),
  interviewQuestions: z.array(text(3000)).max(30),
});
export type PlanContent = z.infer<typeof planContentSchema>;
export const reviewSchema = z.object({
  id: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  category: z.string(),
  message: text(3000),
  action: text(3000),
  sectionKey: z.string().nullable(),
  sourceIds: z.array(z.string()),
});
export type ReviewFinding = z.infer<typeof reviewSchema>;
export const planSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  generatedAt: z.string(),
  mode: z.enum(["ai", "assisted", "manual"]),
  candidateId: z.string(),
  sourceRevision: z.number().int(),
  content: planContentSchema,
  review: z.array(reviewSchema),
  confirmedAt: z.string().nullable(),
});
export type BusinessPlan = z.infer<typeof planSchema>;
export const stageValues = [
  "preparing",
  "drafting",
  "submitted",
  "payment",
  "evaluating",
  "visit",
  "decision",
  "appeal",
  "confirmed",
  "closed",
] as const;
export const stageLabels: Record<(typeof stageValues)[number], string> = {
  preparing: "자료 준비",
  drafting: "사업계획서 작성",
  submitted: "신청서 제출",
  payment: "납부 대기",
  evaluating: "접수 완료·평가",
  visit: "실사 준비",
  decision: "결과 확인",
  appeal: "이의신청",
  confirmed: "확인서 발급",
  closed: "미확인 종료",
};
export const taskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  category: z.enum(["evidence", "payment", "supplement", "visit", "appeal", "other"]),
  dueDate: optionalDate,
  status: z.enum(["pending", "done"]),
  notes: text(10000),
  certificateOrigin: certificateTaskOriginSchema.optional(),
  processing: taskProcessingSchema.optional(),
  owners: z
    .object({
      materials: z.string().trim().max(100),
      writing: z.string().trim().max(100),
      review: z.string().trim().max(100),
    })
    .strict()
    .optional(),
  diagnosisOrigin: z
    .object({
      diagnosisId: z.string().uuid(),
      actionId: z.string().min(1).max(100),
    })
    .strict()
    .optional(),
  agencyOrigin: z
    .object({
      requestRecordId: z.string().uuid(),
      requestVersionId: z.string().uuid(),
    })
    .strict()
    .optional(),
});
export type WorkflowTask = z.infer<typeof taskSchema>;
export const stageRecordSchema = z
  .object({
    id: z.string().uuid(),
    from: z.enum(stageValues),
    to: z.enum(stageValues),
    origin: z.enum(["manual", "plan-created"]),
    recordedAt: z.string().datetime(),
    occurredOn: optionalDate,
    note: text(2000),
  })
  .strict();
export type StageRecord = z.infer<typeof stageRecordSchema>;
export const caseSchema = z.object({
  id: z.string().uuid(),
  profile: companyProfileSchema,
  companyContacts: z
    .array(companyContactsRecordSchema)
    .max(companyContactsLimits.records)
    .default([]),
  sources: z.array(sourceSchema).max(40),
  analysis: analysisSchema.nullable(),
  selectedCandidateId: z.string().nullable(),
  candidateSelections: z
    .array(candidateSelectionSchema)
    .max(candidateSelectionLimits.records)
    .default([]),
  plans: z.array(planSchema).max(100),
  planReviewDecisions: z.array(planReviewDecisionSchema).max(planReviewLimits.records).default([]),
  tasks: z.array(taskSchema).max(200),
  stage: z.enum(stageValues),
  stageHistory: z.array(stageRecordSchema).max(500).default([]),
  agencyRecords: z.array(agencyRecordSchema).max(200).default([]),
  applications: z.array(applicationCycleSchema).max(applicationLimits.cycles).default([]),
  applicationEvents: z.array(applicationEventSchema).max(applicationLimits.events).default([]),
  criteriaVersions: z.array(criteriaVersionSchema).max(criteriaVersionLimits.versions).default([]),
  applicationCriteriaBindings: z
    .array(applicationCriteriaBindingSchema)
    .max(criteriaVersionLimits.bindings)
    .default([]),
  applicationCriteriaContexts: applicationCriteriaContextsSchema.optional(),
  applicationProcedures: z
    .array(applicationProcedureSchema)
    .max(applicationProcedureLimits.versions)
    .default([]),
  appealPreparations: z.array(appealPreparationSchema).max(MAX_APPEAL_VERSIONS).default([]),
  visitAnswers: z.array(visitAnswerSchema).max(visitAnswerLimits.versions).default([]),
  numericChecks: z.array(numericCheckSchema).max(numericCheckLimits.versions).default([]),
  claimReviews: z.array(claimReviewRecordSchema).max(claimReviewLimits.versions).default([]),
  sourceIntakes: z.array(sourceIntakeItemSchema).max(sourceIntakeLimits.items).default([]),
  sourceSuggestionAdoptions: z
    .array(sourceSuggestionReceiptSchema)
    .max(sourceSuggestionLimits.receipts)
    .default([]),
  responsePreparations: z
    .array(responsePreparationSchema)
    .max(responsePreparationLimits.versions)
    .default([]),
  sourceOcrReviews: z.array(sourceOcrReviewSchema).max(MAX_OCR_REVIEWS).default([]),
  diagnosisAnswers: diagnosisAnswersSchema.default(emptyDiagnosisAnswers),
  diagnoses: z.array(diagnosisSchema).max(MAX_DIAGNOSES).default([]),
  preparationRuns: z.array(preparationRunSchema).max(MAX_PREPARATION_RUNS).default([]),
  guidedPreparationRuns: z.array(guidedPreparationRunSchema).max(30).optional(),
  preparationAutomation: preparationAutomationSchema.default(emptyPreparationAutomation),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StudioCase = z.infer<typeof caseSchema>;
export type CaseSummary = Pick<
  StudioCase,
  "id" | "stage" | "revision" | "createdAt" | "updatedAt"
> & {
  companyName: string;
  industry: string;
  sourceCount: number;
  planCount: number;
  pendingTaskCount: number;
  attention?: import("./studio-case-summary").CaseAttention;
};
export type StudioStatus = {
  aiConfigured: boolean;
  model: string;
  storage: "local";
  supportedFiles: string[];
};
export const mutationSchema = z.discriminatedUnion("action", [
  preparationAutomationSettingInputSchema,
  ...criteriaVersionMutationSchema.options,
  appendApplicationProcedureSchema,
  createCertificateTaskMutationSchema,
  appendPlanReviewMutationSchema,
  appendResponsePreparationMutationSchema,
  registerPreparedResponseMutationSchema,
  ...applicationMutationSchema.options,
  z
    .object({
      action: z.literal("diagnosis-answers"),
      revision: z.number().int().nonnegative().safe(),
      answers: diagnosisAnswersSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("diagnose"),
      revision: z.number().int().nonnegative().safe(),
      clientRequestId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("diagnosis-tasks"),
      revision: z.number().int().nonnegative().safe(),
      diagnosisId: z.string().uuid(),
      actionIds: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(30)
        .refine(
          (values) => new Set(values).size === values.length,
          "중복 과제는 선택할 수 없습니다.",
        ),
    })
    .strict(),
  agencyAppendMutationSchema,
  appendCompanyContactsMutationSchema,
  adoptSourceSuggestionsMutationSchema,
  appealAppendMutationSchema,
  visitAnswerAppendMutationSchema,
  numericCheckAppendMutationSchema,
  appendClaimReviewMutationSchema,
  z
    .object({
      action: z.literal("create-agency-task"),
      revision: z.number().int().nonnegative().safe(),
      requestRecordId: z.string().uuid(),
      requestVersionId: z.string().uuid(),
    })
    .strict(),
  reviewLocalOcrMutationSchema,
  z.object({
    action: z.literal("profile"),
    revision: z.number().int(),
    profile: companyProfileSchema,
  }),
  z.object({ action: z.literal("source"), revision: z.number().int(), source: sourceSchema }),
  z.object({
    action: z.literal("delete-source"),
    revision: z.number().int(),
    sourceId: z.string().uuid(),
  }),
  candidateSelectionMutationSchema,
  z.object({
    action: z.literal("save-plan"),
    revision: z.number().int(),
    planId: z.string().uuid(),
    content: planContentSchema,
  }),
  z.object({
    action: z.literal("confirm-plan"),
    revision: z.number().int(),
    planId: z.string().uuid(),
  }),
  z
    .object({
      action: z.literal("stage"),
      revision: z.number().int(),
      stage: z.enum(stageValues),
      occurredOn: optionalDate.optional(),
      note: text(2000).optional(),
    })
    .strict(),
  z.object({ action: z.literal("task"), revision: z.number().int(), task: taskSchema }),
  z.object({
    action: z.literal("delete-task"),
    revision: z.number().int(),
    taskId: z.string().uuid(),
  }),
]);
export type CaseMutation = z.infer<typeof mutationSchema>;
export const generationSchema = z.object({
  revision: z.number().int(),
  operation: z.enum(["analyze", "plan"]),
  mode: z.enum(["ai", "assisted"]),
});
