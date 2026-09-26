import { z } from "zod";
import { appealReferenceSchema, appealPreparationSchema } from "./studio-appeal-types";
import type { StudioCase } from "./studio-schema";

export const responsePreparationLimits = {
  versions: 50,
  characters: 200_000,
  items: 10,
  sources: 10,
  body: 20_000,
  originalBytes: 12 * 1024 * 1024,
  totalOriginalBytes: 24 * 1024 * 1024,
  requestBytes: 256 * 1024,
} as const;
const nonblank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => Boolean(value.trim()));
export const responsePreparationItemSchema = z
  .object({
    id: z.string().uuid(),
    requestQuote: nonblank(1500),
    summary: z.string().trim().min(1).max(200),
    planClaim: z
      .object({ planId: z.string().uuid(), sectionKey: nonblank(100), quote: nonblank(1500) })
      .strict()
      .nullable(),
    evidence: z
      .array(appealReferenceSchema)
      .max(6)
      .refine((refs) => new Set(refs.map((ref) => ref.sourceId)).size === refs.length),
    gap: z.string().max(2000),
    draft: z.string().max(responsePreparationLimits.body),
  })
  .strict();
export type ResponsePreparationItem = z.infer<typeof responsePreparationItemSchema>;
const inputFields = {
  requestRecordId: z.string().uuid(),
  requestVersionId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  items: z
    .array(responsePreparationItemSchema)
    .min(1)
    .max(responsePreparationLimits.items)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
};
export const responsePreparationInputSchema = z
  .object({
    preparationId: z.string().uuid().nullable(),
    previousVersionId: z.string().uuid().nullable(),
    ...inputFields,
  })
  .strict()
  .refine((value) => (value.preparationId === null) === (value.previousVersionId === null));
export type ResponsePreparationInput = z.infer<typeof responsePreparationInputSchema>;
export const responsePreparationSchema = z
  .object({
    ...inputFields,
    id: z.string().uuid(),
    preparationId: z.string().uuid(),
    previousVersionId: z.string().uuid().nullable(),
    version: z.number().int().min(1).max(responsePreparationLimits.versions),
    clientRequestId: z.string().uuid(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: z.string().datetime(),
    origin: z.literal("manual"),
    mode: z.literal("assisted"),
    reviewStatus: z.literal("unreviewed"),
    sourceSnapshots: appealPreparationSchema.shape.sourceSnapshots,
    planSnapshots: appealPreparationSchema.shape.planSnapshots,
  })
  .strict();
export type ResponsePreparation = z.infer<typeof responsePreparationSchema>;
export const appendResponsePreparationMutationSchema = z
  .object({
    action: z.literal("append-response-preparation"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: z.string().uuid(),
    preparation: responsePreparationInputSchema,
  })
  .strict();
export const registerPreparedResponseMutationSchema = z
  .object({
    action: z.literal("register-prepared-response"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: z.string().uuid(),
    preparationId: z.string().uuid(),
    preparationVersionId: z.string().uuid(),
    previousResponseId: z.string().uuid().nullable(),
  })
  .strict();
export type RegisterPreparedResponse = z.infer<typeof registerPreparedResponseMutationSchema>;

/** Fixed local formatting only. Input text remains unverified source material. */
export function buildLocalResponseDraft(item: ResponsePreparationItem): string {
  return [
    "[미검토 답변 초안 · 기관 발송 아님]",
    `요청 원문: ${item.requestQuote}`,
    `담당자 요약: ${item.summary}`,
    `기존 원고 기재: ${item.planClaim?.quote ?? "[확인 필요: 관련 원고 미연결]"}`,
    "선택 자료 기재:",
    ...(item.evidence.length
      ? item.evidence.map((ref) =>
          ref.quote
            ? `- ${ref.quote} (${ref.locator || "위치 미기재"})`
            : "- [본문 미추출 또는 인용 없음: 원본을 직접 확인]",
        )
      : ["- [확인 필요: 근거 자료 미연결]"]),
    `부족 자료·확보 이유: ${item.gap || "[추가 확인 필요]"}`,
    "답변 내용: [담당자가 확인한 설명을 작성해 주세요.]",
  ].join("\n");
}
export function preparedResponseBody(preparation: Pick<ResponsePreparationInput, "items">): string {
  return preparation.items
    .map(
      (item, index) => `${index + 1}. ${item.summary}\n${item.draft || "[확인 필요: 답변 미작성]"}`,
    )
    .join("\n\n");
}
type ContextCompany = Pick<StudioCase, "agencyRecords" | "sources" | "plans">;
export function responsePreparationContext(company: ContextCompany, record: ResponsePreparation) {
  const requests = company.agencyRecords.filter(
    (entry) =>
      (entry.kind === "request" || entry.kind === "request-correction") &&
      entry.requestRecordId === record.requestRecordId,
  );
  const request = requests.at(-1);
  const issues: string[] = [];
  if (!request || request.id !== record.requestVersionId)
    issues.push("요청 버전이 변경되었거나 없습니다.");
  for (const item of record.items) {
    if (request && !request.body.includes(item.requestQuote))
      issues.push("요청 인용을 다시 확인해 주세요.");
    if (item.planClaim) {
      const claim = item.planClaim;
      const plans = company.plans.filter((entry) => entry.id === claim.planId);
      const sections = plans[0]?.content.sections.filter(
        (section) => section.key === claim.sectionKey,
      );
      if (
        plans.length !== 1 ||
        sections?.length !== 1 ||
        !sections[0].content.includes(claim.quote) ||
        record.planSnapshots.find((saved) => saved.planId === claim.planId)?.version !==
          plans[0].version
      )
        issues.push("연결한 원고를 다시 확인해 주세요.");
    }
    for (const reference of item.evidence) {
      const sources = company.sources.filter((source) => source.id === reference.sourceId);
      const source = sources[0];
      const snapshot = record.sourceSnapshots.find(
        (entry) => entry.sourceId === reference.sourceId,
      );
      if (
        sources.length !== 1 ||
        !snapshot ||
        source.updatedAt !== reference.sourceUpdatedAt ||
        source.updatedAt !== snapshot.sourceUpdatedAt ||
        source.name !== snapshot.sourceName ||
        source.extraction !== snapshot.extraction ||
        source.originalName !== (snapshot.original?.originalName ?? null) ||
        source.mimeType !== (snapshot.original?.mimeType ?? null) ||
        (reference.quote !== "" &&
          (source.extraction === "pending" || !source.text.includes(reference.quote)))
      )
        issues.push("연결한 자료를 다시 확인해 주세요.");
    }
  }
  return {
    state: issues.length ? ("stale" as const) : ("current" as const),
    issues: [...new Set(issues)],
    originalCheck: "saved-only" as const,
  };
}
