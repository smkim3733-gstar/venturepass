import { z } from "zod";
import { agencyEvidenceSnapshotSchema, isAgencyNoticeRecord } from "./studio-agency-records";
import type { StudioCase } from "./studio-schema";

export const MAX_APPEAL_VERSIONS = 50;
export const MAX_APPEAL_TEXT = 200_000;
export const MAX_APPEAL_REASONS = 20;
export const MAX_APPEAL_SOURCES = 10;
export const MAX_APPEAL_ORIGINAL_BYTES = 24 * 1024 * 1024;
const date = z.string().refine((value) => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "확인한 날짜를 YYYY-MM-DD로 입력하거나 미확인이면 비워 주세요.");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const appealIntentLabels = {
  undecided: "진행 여부 미정",
  preparing: "소명 준비 중",
  "not-pursuing": "진행하지 않기로 기록",
} as const;
export const appealReferenceSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceUpdatedAt: z.string().min(1).max(100),
    quote: z.string().max(1500),
    locator: z.string().max(150),
  })
  .strict();
export type AppealReference = z.infer<typeof appealReferenceSchema>;
export const appealReasonInputSchema = z
  .object({
    id: z.string().uuid(),
    noticeField: z.enum(["body", "reasons"]),
    noticeQuote: z
      .string()
      .min(1)
      .max(3000)
      .refine((value) => Boolean(value.trim())),
    claim: z.string().max(3000),
    planClaim: z
      .object({
        planId: z.string().uuid(),
        sectionKey: z.string().min(1).max(100),
        quote: z
          .string()
          .min(1)
          .max(3000)
          .refine((value) => Boolean(value.trim())),
      })
      .strict()
      .nullable(),
    gap: z.string().max(3000),
    evidence: z.array(appealReferenceSchema).max(MAX_APPEAL_SOURCES),
    additionalEvidence: z.array(appealReferenceSchema).max(MAX_APPEAL_SOURCES),
    draft: z.string().max(10_000),
  })
  .strict()
  .refine((reason) => {
    const ids = [...reason.evidence, ...reason.additionalEvidence].map((entry) => entry.sourceId);
    return new Set(ids).size === ids.length;
  }, "한 사유에 같은 자료를 중복 연결할 수 없습니다.");
export type AppealReasonInput = z.infer<typeof appealReasonInputSchema>;
const preparationFields = {
  noticeRecordId: z.string().uuid(),
  noticeVersionId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  intent: z.enum(["undecided", "preparing", "not-pursuing"]),
  intentNote: z.string().max(2000),
  deadlineOn: date,
  deadlineNote: z.string().max(2000),
  reasons: z
    .array(appealReasonInputSchema)
    .min(1)
    .max(MAX_APPEAL_REASONS)
    .refine(
      (reasons) => new Set(reasons.map((reason) => reason.id)).size === reasons.length,
      "사유 식별자는 중복될 수 없습니다.",
    ),
};
export const appealPreparationInputSchema = z
  .object({
    preparationId: z.string().uuid().nullable(),
    previousVersionId: z.string().uuid().nullable(),
    ...preparationFields,
    review: z
      .object({
        reviewed: z.boolean(),
        reviewer: z.string().trim().max(100),
        note: z.string().max(2000),
      })
      .strict()
      .refine(
        (review) => !review.reviewed || Boolean(review.reviewer),
        "내부 검토를 기록하려면 검토 담당자를 입력해 주세요.",
      ),
  })
  .strict()
  .refine(
    (input) => (input.preparationId === null) === (input.previousVersionId === null),
    "새 준비 건 또는 최신 버전의 연결 정보를 확인해 주세요.",
  );
export type AppealPreparationInput = z.infer<typeof appealPreparationInputSchema>;
export const appealAppendMutationSchema = z
  .object({
    action: z.literal("append-appeal-preparation"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: z.string().uuid(),
    preparation: appealPreparationInputSchema,
  })
  .strict();
export const appealPreparationSchema = z
  .object({
    id: z.string().uuid(),
    preparationId: z.string().uuid(),
    previousVersionId: z.string().uuid().nullable(),
    version: z.number().int().min(1).max(MAX_APPEAL_VERSIONS),
    clientRequestId: z.string().uuid(),
    inputDigest: hash,
    origin: z.literal("manual"),
    recordedAt: z.string().datetime(),
    ...preparationFields,
    review: z
      .object({
        reviewedAt: z.string().datetime().nullable(),
        reviewer: z.string().max(100),
        note: z.string().max(2000),
      })
      .strict(),
    sourceSnapshots: z
      .array(
        z
          .object({
            sourceId: z.string().uuid(),
            sourceName: z.string().min(1).max(200),
            sourceUpdatedAt: z.string().min(1).max(100),
            extraction: z.enum(["local", "ai", "manual", "pending"]),
            textSha256: hash,
            original: agencyEvidenceSnapshotSchema.nullable(),
          })
          .strict(),
      )
      .max(MAX_APPEAL_SOURCES),
    planSnapshots: z
      .array(
        z
          .object({
            planId: z.string().uuid(),
            version: z.number().int().positive(),
            contentSha256: hash,
          })
          .strict(),
      )
      .max(MAX_APPEAL_REASONS),
  })
  .strict();
export type AppealPreparation = z.infer<typeof appealPreparationSchema>;
export type AppealContextCompany = Pick<StudioCase, "agencyRecords" | "sources" | "plans">;

/** Registered context only. Original bytes are captured on save, not re-read by this browser helper. */
export function appealPreparationContext(company: AppealContextCompany, record: AppealPreparation) {
  const issues: string[] = [];
  let missing = false;
  const notices = company.agencyRecords
    .filter(isAgencyNoticeRecord)
    .filter((notice) => notice.noticeRecordId === record.noticeRecordId);
  const notice = notices.find((item) => item.id === record.noticeVersionId);
  if (!notice) {
    missing = true;
    issues.push("연결한 결과 통보를 찾을 수 없습니다.");
  } else if (notices.at(-1)?.id !== notice.id || notice.details.category !== "decision")
    issues.push("결과 통보가 정정되었습니다. 최신 통보를 기준으로 새 버전을 준비해 주세요.");
  for (const reason of record.reasons) {
    if (
      notice &&
      (notice.details.category !== "decision" ||
        !(reason.noticeField === "body" ? notice.body : notice.details.reasons).includes(
          reason.noticeQuote,
        ))
    )
      issues.push("통보 사유의 인용을 다시 확인해 주세요.");
    if (reason.planClaim) {
      const claim = reason.planClaim;
      const plan = company.plans.find((entry) => entry.id === claim.planId);
      const sections = plan?.content.sections.filter((section) => section.key === claim.sectionKey);
      if (!plan) {
        missing = true;
        issues.push("연결한 계획서 버전을 찾을 수 없습니다.");
      } else if (
        sections?.length !== 1 ||
        !sections[0].content.includes(claim.quote) ||
        record.planSnapshots.find((entry) => entry.planId === plan.id)?.version !== plan.version
      )
        issues.push("연결한 계획서의 기존 설명이 변경되었습니다.");
    }
    for (const reference of [...reason.evidence, ...reason.additionalEvidence]) {
      const source = company.sources.find((entry) => entry.id === reference.sourceId);
      const snapshot = record.sourceSnapshots.find(
        (entry) => entry.sourceId === reference.sourceId,
      );
      if (!source || !snapshot) {
        missing = true;
        issues.push("연결한 자료를 찾을 수 없습니다.");
      } else if (
        source.updatedAt !== reference.sourceUpdatedAt ||
        source.updatedAt !== snapshot.sourceUpdatedAt ||
        source.name !== snapshot.sourceName ||
        source.extraction !== snapshot.extraction ||
        source.originalName !== (snapshot.original?.originalName ?? null) ||
        source.mimeType !== (snapshot.original?.mimeType ?? null) ||
        (reference.quote !== "" &&
          (source.extraction === "pending" || !source.text.includes(reference.quote)))
      )
        issues.push("연결한 자료가 변경되었습니다. 인용과 원본을 다시 확인해 주세요.");
    }
  }
  const uniqueIssues = [...new Set(issues)];
  const state = missing ? "missing" : uniqueIssues.length ? "stale" : "current";
  return {
    state: state as "current" | "stale" | "missing",
    issues: uniqueIssues,
    reviewCurrent: state === "current" && record.review.reviewedAt !== null,
    originalCheck: "saved-only" as const,
  };
}
