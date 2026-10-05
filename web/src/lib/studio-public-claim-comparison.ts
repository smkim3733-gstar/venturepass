import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { STUDIO_AI_INPUT_CHARACTER_LIMIT } from "./studio-ai-input";
import { claimReviewInputDigest } from "./studio-claim-review";
import {
  claimReviewInputSchema,
  claimReviewRecordSchema,
  claimReviewLimits,
  type ClaimReviewRecord,
} from "./studio-claim-review-types";
import { readManualPublicEvidence } from "./studio-public-evidence-export";
import { planSchema, sourceSchema, type StudioCase } from "./studio-schema";
import { StudioError } from "./studio-http";

// Internal, synchronous preparation/validation only. No store, SDK, key, file or network access.
export const publicClaimComparisonLimits = Object.freeze({
  selectionBytes: 8 * 1024,
  inputCharacters: STUDIO_AI_INPUT_CHARACTER_LIMIT,
  responseCharacters: 240000,
  sources: claimReviewLimits.sources,
  quoteCharacters: 1500,
  quotesPerSource: 3,
});
const boundaries = Object.freeze({
  scope: "selected-public-excerpts" as const,
  evidenceOrigin: "manual-unverified" as const,
  factVerified: false,
  officialProvenanceVerified: false,
  companyApplicabilityVerified: false,
  fullOriginalVerified: false,
  currentValidityVerified: false,
  semanticTruthVerified: false,
  humanAccepted: false,
  transmissionAllowed: false,
  databaseChanged: false,
});
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nonblank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => Boolean(value.trim()));
const distinctIds = z
  .array(uuid)
  .max(publicClaimComparisonLimits.sources)
  .refine((ids) => new Set(ids).size === ids.length);
export const publicClaimComparisonSelectionSchema = z
  .object({
    companyId: uuid,
    companyRevision: z.number().int().nonnegative().safe(),
    claimRecordId: uuid,
    claimVersion: z.number().int().min(1).max(claimReviewLimits.versions),
    claimInputDigest: digest,
    sourceIds: distinctIds.refine((ids) => ids.length > 0),
  })
  .strict();
export type PublicClaimComparisonSelection = z.infer<typeof publicClaimComparisonSelectionSchema>;

const relation = z.enum([
  "provided-text-support",
  "provided-text-conflict",
  "insufficient",
  "undetermined",
]);
const sourceOpinion = z
  .object({
    sourceId: uuid,
    relation,
    quotes: z
      .array(nonblank(publicClaimComparisonLimits.quoteCharacters))
      .max(publicClaimComparisonLimits.quotesPerSource)
      .refine((quotes) => new Set(quotes).size === quotes.length),
    reason: nonblank(2000),
    nextCheck: z.string().max(2000),
  })
  .strict()
  .refine(
    (value) =>
      !["provided-text-support", "provided-text-conflict"].includes(value.relation) ||
      value.quotes.length > 0,
  );
export const publicClaimComparisonResponseSchema = z
  .object({
    preparationDigest: digest,
    claimQuote: nonblank(publicClaimComparisonLimits.quoteCharacters),
    overall: z.object({ relation, reason: nonblank(2000) }).strict(),
    evidence: z.array(sourceOpinion).min(1).max(publicClaimComparisonLimits.sources),
    checks: z
      .array(
        z
          .object({
            dimension: z.enum([
              "period",
              "unit",
              "population",
              "company-applicability",
              "provenance",
              "other",
            ]),
            sourceIds: distinctIds,
            message: nonblank(1000),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

function fail(code: string, message: string, status = 409): never {
  throw new StudioError(message, status, code);
}
function json(value: unknown, maximum: number, bytes = false) {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    /* Return a fixed error, never input text. */
  }
  if (text === undefined)
    fail("PUBLIC_CLAIM_FORMAT", "공개 주장 대조의 JSON 형식을 확인해 주세요.", 422);
  if ((bytes ? Buffer.byteLength(text, "utf8") : text.length) > maximum)
    fail("PUBLIC_CLAIM_LIMIT", "공개 주장 대조의 입력 또는 응답 한도를 초과했습니다.", 413);
  return text;
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success)
    fail("PUBLIC_CLAIM_FORMAT", "공개 주장 대조의 입력 또는 응답 형식을 확인해 주세요.", 422);
  return result.data;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Reconstruct the original manual command; root records acquired claimId only on storage. */
function originalInput(record: ClaimReviewRecord) {
  const input = Object.fromEntries(
    Object.keys(claimReviewInputSchema.shape).map((key) => [
      key,
      record[key as keyof ClaimReviewRecord],
    ]),
  );
  const { recordedAt: _recordedAt, ...judgement } = record.judgement;
  void _recordedAt;
  return parse(claimReviewInputSchema, {
    ...input,
    claimId: record.previousVersionId === null ? null : record.claimId,
    judgement,
  });
}

/** Audit the selected ancestor chain only. Does not certify unrelated/later records or a DB restore. */
function selectedRecord(company: StudioCase, selection: PublicClaimComparisonSelection) {
  const records = company.claimReviews ?? [];
  if (
    records.length > claimReviewLimits.versions ||
    new Set(records.map((item) => item.id)).size !== records.length ||
    new Set(records.map((item) => item.clientRequestId)).size !== records.length
  )
    fail("PUBLIC_CLAIM_HISTORY", "주장 기록의 고유 신원을 확인할 수 없습니다.");
  const raw = records.find((item) => item.id === selection.claimRecordId);
  if (!raw) fail("PUBLIC_CLAIM_MISSING", "선택한 주장 기록을 찾을 수 없습니다.");
  const selected = parse(claimReviewRecordSchema, raw);
  if (
    selected.version !== selection.claimVersion ||
    selected.inputDigest !== selection.claimInputDigest
  )
    fail("PUBLIC_CLAIM_STALE", "선택한 주장 버전이 변경되었습니다.");
  let current = selected;
  const visited = new Set<string>();
  while (true) {
    if (
      visited.has(current.id) ||
      claimReviewInputDigest(originalInput(current)) !== current.inputDigest ||
      (current.judgement.state === "unreviewed"
        ? current.judgement.recordedAt !== null
        : current.judgement.recordedAt !== current.recordedAt)
    )
      fail("PUBLIC_CLAIM_HISTORY", "원래 주장 명령과 보관 기록이 일치하지 않습니다.");
    visited.add(current.id);
    if (current.previousVersionId === null) {
      if (
        current.version !== 1 ||
        current.claimId !== current.id ||
        current.judgement.state !== "unreviewed"
      )
        fail("PUBLIC_CLAIM_HISTORY", "원래 주장 시작 기록을 확인할 수 없습니다.");
      break;
    }
    const parent = records.find((item) => item.id === current.previousVersionId);
    if (!parent) fail("PUBLIC_CLAIM_HISTORY", "원래 주장 이전 버전이 없습니다.");
    const previous = parse(claimReviewRecordSchema, parent);
    if (
      previous.claimId !== current.claimId ||
      previous.version + 1 !== current.version ||
      previous.sectionKey !== current.sectionKey ||
      records.filter((item) => item.previousVersionId === previous.id).length !== 1
    )
      fail("PUBLIC_CLAIM_HISTORY", "원래 주장 버전 연결이 일치하지 않습니다.");
    current = previous;
  }
  if (
    selected.sourceSnapshots.length !== selected.references.length ||
    new Set(selected.sourceSnapshots.map((s) => s.sourceId)).size !== selected.references.length ||
    selected.sourceSnapshots.some(
      (s) => !selected.references.some((r) => r.sourceId === s.sourceId),
    )
  )
    fail("PUBLIC_CLAIM_HISTORY", "주장의 자료 보관 신원이 일치하지 않습니다.");
  return selected;
}

export function preparePublicClaimComparison(company: StudioCase, rawSelection: unknown) {
  json(rawSelection, publicClaimComparisonLimits.selectionBytes, true);
  const selection = parse(publicClaimComparisonSelectionSchema, rawSelection);
  if (company.id !== selection.companyId || company.revision !== selection.companyRevision)
    fail("PUBLIC_CLAIM_STALE", "원래 기업과 버전이 변경되었습니다.");
  const record = selectedRecord(company, selection);
  const plans = company.plans.filter((item) => item.id === record.planId);
  if (plans.length !== 1) fail("PUBLIC_CLAIM_MISSING", "원래 원고를 고유하게 찾을 수 없습니다.");
  const plan = parse(planSchema, plans[0]);
  const sections = plan.content.sections.filter((item) => item.key === record.sectionKey);
  const planSnapshot = record.planSnapshots[0];
  const planHash = hash(JSON.stringify(plans[0].content));
  if (
    plan.version !== record.planVersion ||
    planSnapshot.planId !== plan.id ||
    planSnapshot.version !== plan.version ||
    planSnapshot.contentSha256 !== planHash ||
    sections.length !== 1 ||
    !sections[0].content.includes(record.claimQuote)
  )
    fail("PUBLIC_CLAIM_STALE", "원래 원고·항목 문맥 또는 주장 인용이 변경되었습니다.");
  const selectedEvidence = selection.sourceIds.map((sourceId) => {
    const ref = record.references.find((item) => item.sourceId === sourceId);
    const snapshot = record.sourceSnapshots.find((item) => item.sourceId === sourceId);
    const matches = company.sources.filter((item) => item.id === sourceId);
    if (!ref || !snapshot || matches.length !== 1)
      fail("PUBLIC_CLAIM_MISSING", "주장에 연결된 공개 자료를 고유하게 찾을 수 없습니다.");
    const source = parse(sourceSchema, matches[0]);
    if (
      source.updatedAt !== ref.sourceUpdatedAt ||
      source.updatedAt !== snapshot.sourceUpdatedAt ||
      source.name !== snapshot.sourceName ||
      source.extraction !== snapshot.extraction ||
      hash(source.text) !== snapshot.textSha256
    )
      fail("PUBLIC_CLAIM_STALE", "원래 공개 자료 본문 또는 보관 신원이 변경되었습니다.");
    if (snapshot.original !== null || source.originalName !== null || source.mimeType !== null)
      fail(
        "PUBLIC_CLAIM_UNSUPPORTED",
        "이 내부 대조는 원본 첨부 없는 수동 공개 발췌만 지원합니다.",
        422,
      );
    const draft = readManualPublicEvidence(source);
    if (!draft || !ref.quote.trim() || !draft.quote.includes(ref.quote))
      fail("PUBLIC_CLAIM_UNSUPPORTED", "수동 공개 발췌의 형식과 정확한 인용을 확인해 주세요.", 422);
    return {
      sourceId,
      sourceUpdatedAt: source.updatedAt,
      textSha256: snapshot.textSha256,
      originalReference: { quote: ref.quote, locator: ref.locator },
      metadata: {
        title: draft.title,
        url: draft.url,
        publisher: draft.publisher,
        publishedOn: draft.publishedOn,
        period: draft.period,
        readOn: draft.readOn,
        sectionKey: draft.sectionKey,
      },
      excerpt: draft.quote,
      manualNotes: { relevance: draft.relevance, conflicts: draft.conflicts },
    };
  });
  const payload = {
    contractVersion: "public-claim-comparison-v1" as const,
    ...boundaries,
    selection,
    binding: {
      claimId: record.claimId,
      claimRecordSha256: hash(JSON.stringify(record)),
      planId: plan.id,
      planVersion: plan.version,
      planContentSha256: planHash,
    },
    input: {
      claimQuote: record.claimQuote,
      section: { key: sections[0].key, title: sections[0].title, content: sections[0].content },
      selectedEvidence,
      excludedSourceIds: record.references
        .filter((ref) => !selection.sourceIds.includes(ref.sourceId))
        .map((ref) => ref.sourceId),
    },
  };
  const serialized = json(payload, publicClaimComparisonLimits.inputCharacters);
  return { ...payload, preparationDigest: hash(serialized), inputCharacters: serialized.length };
}
export type PublicClaimComparisonPreparation = ReturnType<typeof preparePublicClaimComparison>;

/** Rebuild against the original selection/current snapshot; never trust a caller's prepared object. */
export function validatePublicClaimComparison(
  company: StudioCase,
  selection: unknown,
  rawResponse: unknown,
) {
  const prepared = preparePublicClaimComparison(company, selection);
  json(rawResponse, publicClaimComparisonLimits.responseCharacters);
  const response = parse(publicClaimComparisonResponseSchema, rawResponse);
  if (
    response.preparationDigest !== prepared.preparationDigest ||
    response.claimQuote !== prepared.input.claimQuote
  )
    fail("PUBLIC_CLAIM_RESPONSE_MISMATCH", "응답의 원래 주장·준비본이 일치하지 않습니다.", 422);
  const byId = new Map(response.evidence.map((item) => [item.sourceId, item]));
  if (
    byId.size !== response.evidence.length ||
    byId.size !== prepared.input.selectedEvidence.length ||
    prepared.input.selectedEvidence.some((item) => !byId.has(item.sourceId)) ||
    response.checks.some((item) => item.sourceIds.some((id) => !byId.has(id)))
  )
    fail("PUBLIC_CLAIM_RESPONSE_MISMATCH", "응답의 공개 자료 선택 범위가 일치하지 않습니다.", 422);
  for (const source of prepared.input.selectedEvidence) {
    if (byId.get(source.sourceId)!.quotes.some((quote) => !source.excerpt.includes(quote)))
      fail(
        "PUBLIC_CLAIM_RESPONSE_MISMATCH",
        "응답 인용이 원래 공개 발췌와 일치하지 않습니다.",
        422,
      );
  }
  if (
    (response.overall.relation === "provided-text-support" &&
      response.evidence.some((item) => item.relation !== "provided-text-support")) ||
    (response.overall.relation === "provided-text-conflict" &&
      !response.evidence.some((item) => item.relation === "provided-text-conflict"))
  )
    fail(
      "PUBLIC_CLAIM_RESPONSE_MISMATCH",
      "전체 의견과 자료별 의견의 범위가 일치하지 않습니다.",
      422,
    );
  return {
    contractVersion: prepared.contractVersion,
    source: "supplied-response" as const,
    ...boundaries,
    preparationDigest: prepared.preparationDigest,
    selection: prepared.selection,
    excludedSourceIds: prepared.input.excludedSourceIds,
    comparison: response,
  };
}
