import { z } from "zod";

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
export const sourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(sourceKinds),
  text: z.string().max(100000),
  originalName: text(200).nullable(),
  mimeType: text(150).nullable(),
  extraction: z.enum(["manual", "local", "ai"]),
  warnings: z.array(text(1000)).max(30),
  createdAt: z.string(),
  updatedAt: z.string(),
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
});
export type WorkflowTask = z.infer<typeof taskSchema>;
export const caseSchema = z.object({
  id: z.string().uuid(),
  profile: companyProfileSchema,
  sources: z.array(sourceSchema).max(40),
  analysis: analysisSchema.nullable(),
  selectedCandidateId: z.string().nullable(),
  plans: z.array(planSchema).max(100),
  tasks: z.array(taskSchema).max(200),
  stage: z.enum(stageValues),
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
};
export type StudioStatus = {
  aiConfigured: boolean;
  model: string;
  storage: "local";
  supportedFiles: string[];
};
export const mutationSchema = z.discriminatedUnion("action", [
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
  z.object({
    action: z.literal("select-candidate"),
    revision: z.number().int(),
    candidateId: z.string(),
  }),
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
  z.object({ action: z.literal("stage"), revision: z.number().int(), stage: z.enum(stageValues) }),
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
