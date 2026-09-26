import { z } from "zod";
import { appealPreparationSchema } from "./studio-appeal-types";
import { numericCheckContext } from "./studio-numeric-check-types";
import type { StudioCase } from "./studio-schema";

export const claimReviewLimits = {
  versions: 200,
  characters: 300_000,
  sources: 10,
  references: 10,
  originalBytes: 24 * 1024 * 1024,
  requestBytes: 512 * 1024,
} as const;
export const claimNatureLabels = {
  unknown: "주장 성격 미확인",
  "current-claim": "현재 사실에 관한 주장",
  "future-plan": "향후 계획",
  assumption: "가정",
} as const;
export const claimMethodLabels = {
  unreviewed: "미검토",
  document: "문서 대조",
  "company-statement": "기업 진술 확인",
  external: "외부 확인 기록 (수동)",
  multiple: "복수 방식",
} as const;
export const claimJudgementLabels = {
  unreviewed: "미검토",
  consistent: "일치한다고 판단 (담당자)",
  conflict: "충돌 발견 (담당자)",
  insufficient: "근거 부족 (담당자)",
} as const;
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const nonblank = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => Boolean(value.trim()));
const manualDate = z
  .string()
  .max(10)
  .refine(
    (value) =>
      value === "" ||
      (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(new Date(`${value}T00:00:00.000Z`).getTime()) &&
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value),
    "날짜는 YYYY-MM-DD 형식으로 입력하거나 미확인으로 비워 주세요.",
  );
export const claimReferenceSchema = z
  .object({
    sourceId: uuid,
    sourceUpdatedAt: z.string().min(1).max(100),
    quote: z.string().max(1500),
    locator: z.string().max(150),
  })
  .strict();
export type ClaimReference = z.infer<typeof claimReferenceSchema>;
const recordReference = z
  .object({ id: uuid, version: z.number().int().positive().safe() })
  .strict();
const references = z
  .array(recordReference)
  .max(claimReviewLimits.references)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "같은 기록 버전을 중복 연결할 수 없습니다.",
  );
const fields = {
  planId: uuid,
  planVersion: z.number().int().positive().safe(),
  sectionKey: nonblank(100),
  claimQuote: nonblank(1500),
  nature: z.enum(["unknown", "current-claim", "future-plan", "assumption"]),
  references: z
    .array(claimReferenceSchema)
    .max(claimReviewLimits.sources)
    .refine(
      (items) => new Set(items.map((item) => item.sourceId)).size === items.length,
      "한 주장에 같은 자료를 중복 연결할 수 없습니다.",
    ),
  contextNote: z.string().max(2000),
  owner: z.string().trim().max(100),
  dueOn: manualDate,
  nextCheck: z.string().max(2000),
  method: z.enum(["unreviewed", "document", "company-statement", "external", "multiple"]),
  externalCheck: z
    .object({
      target: z.string().trim().max(300),
      content: z.string().trim().max(2000),
      occurredOn: manualDate,
    })
    .strict(),
  numericReferences: references,
  planReviewReferences: references,
};
const judgement = z
  .object({
    state: z.enum(["unreviewed", "consistent", "conflict", "insufficient"]),
    reviewer: z.string().trim().max(100),
    reason: z.string().trim().max(2000),
    checkedOn: manualDate,
  })
  .strict();
export const claimReviewInputSchema = z
  .object({ claimId: uuid.nullable(), previousVersionId: uuid.nullable(), ...fields, judgement })
  .strict()
  .refine(
    (input) => (input.claimId === null) === (input.previousVersionId === null),
    "최신 주장 버전의 연결 정보를 확인해 주세요.",
  )
  .refine(
    (input) =>
      input.judgement.state === "unreviewed" ||
      (input.claimId !== null &&
        input.method !== "unreviewed" &&
        Boolean(input.judgement.reviewer) &&
        Boolean(input.judgement.reason) &&
        Boolean(input.judgement.checkedOn)),
    "최초 기록은 미검토입니다. 후속 판단에는 검토 방식·판단자·이유·확인일을 입력해 주세요.",
  )
  .refine((input) => {
    const external = input.externalCheck;
    return (
      !(
        input.method === "external" ||
        external.target ||
        external.content ||
        external.occurredOn
      ) || Boolean(external.target && external.content && external.occurredOn)
    );
  }, "외부 확인을 기록할 때는 대상·내용·확인일을 모두 수동 입력해 주세요.");
export type ClaimReviewInput = z.infer<typeof claimReviewInputSchema>;
export const appendClaimReviewMutationSchema = z
  .object({
    action: z.literal("append-claim-review"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: uuid,
    claim: claimReviewInputSchema,
  })
  .strict();
export const claimReviewRecordSchema = z
  .object({
    id: uuid,
    claimId: uuid,
    previousVersionId: uuid.nullable(),
    version: z.number().int().min(1).max(claimReviewLimits.versions),
    clientRequestId: uuid,
    inputDigest: hash,
    origin: z.literal("manual"),
    recordedAt: z.string().datetime(),
    ...fields,
    judgement: judgement.extend({ recordedAt: z.string().datetime().nullable() }).strict(),
    sourceSnapshots: appealPreparationSchema.shape.sourceSnapshots,
    planSnapshots: appealPreparationSchema.shape.planSnapshots.min(1).max(1),
    auxiliarySnapshots: z
      .array(
        z
          .object({
            kind: z.enum(["numeric", "plan-review"]),
            id: uuid,
            version: z.number().int().positive().safe(),
            inputDigest: hash,
            recordedAt: z.string().datetime(),
            contentSha256: hash,
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type ClaimReviewRecord = z.infer<typeof claimReviewRecordSchema>;
export function latestClaimReviews(company: {
  claimReviews?: ClaimReviewRecord[];
}): ClaimReviewRecord[] {
  const roots = new Map<string, ClaimReviewRecord>();
  for (const record of company.claimReviews ?? []) roots.set(record.claimId, record);
  return [...roots.values()];
}
/** Current registered metadata/exact quotes only; original bytes are rechecked on save. */
export function claimReviewContext(
  company: Pick<StudioCase, "plans" | "sources" | "numericChecks" | "planReviewDecisions">,
  record: ClaimReviewRecord,
) {
  const issues: string[] = [];
  let missing = false;
  const plans = company.plans.filter((item) => item.id === record.planId),
    plan = plans.length === 1 ? plans[0] : undefined;
  const sections = plan?.content.sections.filter((item) => item.key === record.sectionKey);
  if (!plan) {
    missing = true;
    issues.push("연결 원고를 고유하게 찾을 수 없습니다.");
  } else if (
    plan.version !== record.planVersion ||
    sections?.length !== 1 ||
    !sections[0].content.includes(record.claimQuote)
  )
    issues.push("원고 항목·주장 인용이 변경되었습니다.");
  for (const ref of record.references) {
    const sources = company.sources.filter((item) => item.id === ref.sourceId),
      source = sources.length === 1 ? sources[0] : undefined;
    const snapshot = record.sourceSnapshots.find((item) => item.sourceId === ref.sourceId);
    if (!source || !snapshot) {
      missing = true;
      issues.push("연결 자료를 고유하게 찾을 수 없습니다.");
    } else if (
      source.updatedAt !== ref.sourceUpdatedAt ||
      source.updatedAt !== snapshot.sourceUpdatedAt ||
      source.name !== snapshot.sourceName ||
      source.extraction !== snapshot.extraction ||
      source.originalName !== (snapshot.original?.originalName ?? null) ||
      (snapshot.original && source.mimeType !== snapshot.original.mimeType) ||
      (ref.quote === ""
        ? !source.originalName
        : source.extraction === "pending" || !source.text.includes(ref.quote))
    )
      issues.push("연결 자료·인용이 변경되었습니다.");
  }
  for (const ref of record.numericReferences) {
    const matches = company.numericChecks.filter((item) => item.id === ref.id),
      target = matches.length === 1 ? matches[0] : undefined;
    const snapshot = record.auxiliarySnapshots.find(
      (item) => item.kind === "numeric" && item.id === ref.id,
    );
    if (!target || !snapshot) {
      missing = true;
      issues.push("연결 수치 대조 버전을 찾을 수 없습니다.");
    } else if (
      target.version !== ref.version ||
      target.inputDigest !== snapshot.inputDigest ||
      numericCheckContext(company, target).state !== "current"
    )
      issues.push("연결 수치 대조의 근거를 다시 확인해 주세요.");
  }
  for (const ref of record.planReviewReferences) {
    const matches = company.planReviewDecisions.filter((item) => item.id === ref.id),
      target = matches.length === 1 ? matches[0] : undefined;
    const snapshot = record.auxiliarySnapshots.find(
      (item) => item.kind === "plan-review" && item.id === ref.id,
    );
    if (!target || !snapshot) {
      missing = true;
      issues.push("연결 원고 검토 판단 버전을 찾을 수 없습니다.");
    } else if (
      target.version !== ref.version ||
      target.planId !== record.planId ||
      target.planVersion !== record.planVersion ||
      target.inputDigest !== snapshot.inputDigest ||
      target.stale
    )
      issues.push("연결 원고 검토 판단의 근거를 다시 확인해 주세요.");
  }
  const state = missing ? "missing" : issues.length ? "stale" : "current";
  return {
    state: state as "current" | "stale" | "missing",
    issues: [...new Set(issues)],
    judgementCurrent: state === "current" && record.judgement.state !== "unreviewed",
    originalCheck: "saved-only" as const,
  };
}
