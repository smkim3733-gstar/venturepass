import { z } from "zod";

export const diagnosisCriteriaVersion = "innovation-growth-2026-09-25-v1";
export const MAX_DIAGNOSES = 50;
export const MAX_DIAGNOSIS_TEXT = 200_000;
export const diagnosisCriteriaSources = [
  {
    title: "공식 혁신성장유형 안내",
    url: "https://www.smes.go.kr/venturein/institution/requireGuide?rgCd=C",
    checkedOn: "2026-09-25",
    scope:
      "중소기업 해당 여부와 기술혁신성·사업성장성의 기관 평가. 앱은 기관 판정을 대신하지 않습니다.",
  },
  {
    title: "공식 신청불가 업종 안내",
    url: "https://www.smes.go.kr/venturein/resources/images/sub/ventureRestricted11thIndustry.jpg",
    checkedOn: "2026-09-25",
    scope:
      "공식 안내 연결 위치를 확인했습니다. 업종 목록을 코드로 판독하지 않았으며 실제 영위 업종과 적용 여부는 사용자가 원문을 검토해야 합니다.",
  },
] as const;

const boundedText = (maximum: number) => z.string().max(maximum);
export const diagnosisEvidenceInputSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceUpdatedAt: z.string().min(1).max(100),
    quote: z.string().trim().min(1).max(1500),
    locator: z.string().trim().min(1).max(150),
  })
  .strict();
export const diagnosisAssessmentSchema = z
  .object({
    status: z.enum(["unknown", "supported", "contradicted"]),
    reviewed: z.boolean(),
    note: boundedText(2000),
    evidence: z.array(diagnosisEvidenceInputSchema).max(6),
  })
  .strict()
  .superRefine((assessment, context) => {
    if (assessment.status !== "unknown" && (!assessment.reviewed || !assessment.evidence.length))
      context.addIssue({
        code: "custom",
        message: "기본요건 판단에는 원문 인용과 사용자 검토 확인이 필요합니다.",
      });
  });
export const diagnosisAnswersSchema = z
  .object({
    entityType: z.enum(["unknown", "corporate", "sole"]),
    criteriaVersion: z.string().min(1).max(100).nullable(),
    sme: diagnosisAssessmentSchema,
    industryEligibility: diagnosisAssessmentSchema,
  })
  .strict();
export type DiagnosisAnswers = z.infer<typeof diagnosisAnswersSchema>;
export function emptyDiagnosisAnswers(): DiagnosisAnswers {
  const empty = () => ({ status: "unknown" as const, reviewed: false, note: "", evidence: [] });
  return {
    entityType: "unknown",
    criteriaVersion: null,
    sme: empty(),
    industryEligibility: empty(),
  };
}

export const diagnosisEvidenceSchema = z
  .object({
    sourceId: z.string(),
    sourceName: boundedText(200),
    sourceUpdatedAt: boundedText(100),
    quote: z.string().min(1).max(1500),
    locator: boundedText(150),
    provenance: z.enum(["reported", "documented"]),
  })
  .strict();
export const diagnosisItemSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    area: z.enum(["eligibility", "technology", "growth", "reliability"]),
    status: z.enum(["supported", "contradicted", "unknown", "not_applicable", "needs_work"]),
    reason: boundedText(3000),
    evidence: z.array(diagnosisEvidenceSchema).max(6),
    unknowns: z.array(boundedText(1500)).max(10),
    nextActions: z.array(boundedText(1500)).max(10),
  })
  .strict();
export const diagnosisActionSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    notes: boundedText(3000),
  })
  .strict();
const diagnosisContentShape = {
  mode: z.literal("assisted"),
  outcome: z.enum(["draft_recommended", "reinforce_first", "eligibility_issue", "insufficient"]),
  items: z.array(diagnosisItemSchema).min(1).max(40),
  questions: z
    .array(
      z
        .object({
          id: z.string().min(1).max(100),
          itemId: z.string().min(1).max(100),
          question: boundedText(2000),
          reason: boundedText(2000),
        })
        .strict(),
    )
    .max(40),
  actions: z.array(diagnosisActionSchema).max(40),
  warnings: z.array(boundedText(2000)).max(30),
};
export const diagnosisContentSchema = z.object(diagnosisContentShape).strict();
export type DiagnosisContent = z.infer<typeof diagnosisContentSchema>;
export type DiagnosisItem = z.infer<typeof diagnosisItemSchema>;
export type DiagnosisEvidence = z.infer<typeof diagnosisEvidenceSchema>;
export const diagnosisSchema = z
  .object({
    ...diagnosisContentShape,
    id: z.string().uuid(),
    clientRequestId: z.string().uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.number().int().positive().safe(),
    sourceRevision: z.number().int().nonnegative().safe(),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    criteriaVersion: z.string().min(1).max(100),
    generatedAt: z.string().datetime(),
    stale: z.boolean().default(true),
  })
  .strict();
export type Diagnosis = z.infer<typeof diagnosisSchema>;
