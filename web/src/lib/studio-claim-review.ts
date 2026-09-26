// Node-side immutable capture of manual claim reviews. No AI or external verification.
import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import { originalConflicts, planConflicts } from "./studio-evidence-history";
import type { SourceDocument, StudioCase } from "./studio-schema";
import {
  claimReviewInputSchema,
  claimReviewLimits,
  claimReviewRecordSchema,
  type ClaimReviewInput,
  type ClaimReviewRecord,
} from "./studio-claim-review-types";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const claimReviewInputDigest = (input: ClaimReviewInput) =>
  hash(JSON.stringify(claimReviewInputSchema.parse(input)));
function fail(message: string, code: string, status = 409): never {
  throw new StudioError(message, status, code);
}
export function assertClaimReviewCapacity(records: ClaimReviewRecord[]) {
  const size = (value: unknown): number =>
    typeof value === "string"
      ? value.length
      : Array.isArray(value)
        ? value.reduce((sum, item) => sum + size(item), 0)
        : value && typeof value === "object"
          ? Object.values(value).reduce<number>((sum, item) => sum + size(item), 0)
          : 0;
  if (records.length > claimReviewLimits.versions || size(records) > claimReviewLimits.characters)
    fail(
      "주장 검토 이력의 보관 한도에 도달했습니다. 기존 기록은 보존합니다.",
      "CLAIM_REVIEW_LIMIT",
    );
}
export function isClaimReviewReplay(
  records: ClaimReviewRecord[],
  nonce: string,
  digest: string,
): boolean {
  const matches = records.filter((record) => record.clientRequestId === nonce);
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== digest)
    fail("같은 저장 요청의 주장 검토 내용이 다릅니다.", "CLAIM_REVIEW_REQUEST_CONFLICT");
  return true;
}
type ClaimCompany = StudioCase & { claimReviews: ClaimReviewRecord[] };
type Reader = (sourceId: string) => { source: SourceDocument; buffer: Buffer; sha256: string };
type Generated = Pick<ClaimReviewRecord, "id" | "clientRequestId" | "inputDigest" | "recordedAt">;
function auxiliaryHash(kind: "numeric" | "plan-review", value: object): string {
  if (kind === "numeric") return hash(JSON.stringify(value));
  // GET-derived freshness is not part of the immutable manual judgement.
  const {
    stale: _stale,
    staleReasons: _staleReasons,
    ...stored
  } = value as Record<string, unknown>;
  void _stale;
  void _staleReasons;
  return hash(JSON.stringify(stored));
}
export function buildClaimReview(
  company: ClaimCompany,
  raw: ClaimReviewInput,
  generated: Generated,
  readOriginal: Reader,
): ClaimReviewRecord {
  const input = claimReviewInputSchema.parse(raw);
  if (company.claimReviews.length >= claimReviewLimits.versions)
    fail("주장 검토 이력의 보관 한도에 도달했습니다.", "CLAIM_REVIEW_LIMIT");
  let previous: ClaimReviewRecord | undefined;
  if (input.claimId) {
    const roots = company.claimReviews.filter(
      (record) => record.id === input.claimId && record.previousVersionId === null,
    );
    if (roots.length !== 1)
      fail("이 기업의 고유한 주장 이력을 선택해 주세요.", "CLAIM_REVIEW_NOT_FOUND", 404);
    if (roots[0].sectionKey !== input.sectionKey)
      fail("기존 주장을 다른 원고 항목으로 옮길 수 없습니다.", "CLAIM_REVIEW_ROOT_MISMATCH");
    previous = company.claimReviews.filter((record) => record.claimId === roots[0].id).at(-1)!;
    if (previous.id !== input.previousVersionId)
      fail("주장 검토 최신 버전이 변경되었습니다.", "CLAIM_REVIEW_VERSION_STALE");
  }
  if (input.judgement.state !== "unreviewed" && !previous)
    fail("최초 주장 기록은 미검토로 저장해 주세요.", "CLAIM_JUDGEMENT_INVALID", 422);
  const plans = company.plans.filter((item) => item.id === input.planId);
  const plan = plans.length === 1 ? plans[0] : undefined;
  if (!plan) fail("이 기업의 고유한 저장 원고를 선택해 주세요.", "CLAIM_PLAN_NOT_FOUND", 404);
  const sections = plan.content.sections.filter((item) => item.key === input.sectionKey);
  if (
    plan.version !== input.planVersion ||
    sections.length !== 1 ||
    !sections[0].content.includes(input.claimQuote)
  )
    fail(
      "선택한 원고 버전·고유 항목의 원문에서 주장을 정확히 인용해 주세요.",
      "CLAIM_PLAN_QUOTE_INVALID",
      422,
    );
  const planSnapshot = {
    planId: plan.id,
    version: plan.version,
    contentSha256: hash(JSON.stringify(plan.content)),
  };
  if (planConflicts(company, planSnapshot))
    fail(
      "이미 고정한 원고 버전이 변경되었습니다. 새 원고 버전을 선택해 주세요.",
      "CLAIM_PLAN_CHANGED",
    );
  const auxiliarySnapshots: ClaimReviewRecord["auxiliarySnapshots"] = [];
  for (const kind of ["numeric", "plan-review"] as const) {
    const references = kind === "numeric" ? input.numericReferences : input.planReviewReferences;
    for (const ref of references) {
      const matches =
        kind === "numeric"
          ? company.numericChecks.filter((item) => item.id === ref.id)
          : company.planReviewDecisions.filter((item) => item.id === ref.id);
      const target = matches.length === 1 ? matches[0] : undefined;
      if (
        !target ||
        target.version !== ref.version ||
        (kind === "plan-review" &&
          (!("planId" in target) ||
            target.planId !== input.planId ||
            target.planVersion !== input.planVersion))
      )
        fail(
          "이 기업의 정확한 참고 기록 버전을 선택해 주세요. 원고 판단은 선택한 원고에 속해야 합니다.",
          "CLAIM_AUXILIARY_INVALID",
          422,
        );
      const snapshot = {
        kind,
        id: target.id,
        version: target.version,
        inputDigest: target.inputDigest,
        recordedAt: target.recordedAt,
        contentSha256: auxiliaryHash(kind, target),
      };
      if (
        company.claimReviews.some((record) =>
          record.auxiliarySnapshots.some(
            (saved) =>
              saved.kind === kind &&
              saved.id === target.id &&
              (saved.version !== snapshot.version ||
                saved.contentSha256 !== snapshot.contentSha256),
          ),
        )
      )
        fail(
          "기존에 연결한 참고 기록 내용이 변경되었습니다. 과거 기록을 확인해 주세요.",
          "CLAIM_AUXILIARY_CHANGED",
        );
      auxiliarySnapshots.push(snapshot);
    }
  }
  for (const ref of input.references) {
    const matches = company.sources.filter((item) => item.id === ref.sourceId),
      source = matches.length === 1 ? matches[0] : undefined;
    if (!source) fail("이 기업의 고유한 자료를 선택해 주세요.", "CLAIM_SOURCE_NOT_FOUND", 404);
    if (
      source.updatedAt !== ref.sourceUpdatedAt ||
      (ref.quote === ""
        ? !source.originalName
        : !ref.quote.trim() || source.extraction === "pending" || !source.text.includes(ref.quote))
    )
      fail(
        "자료 버전과 정확한 인용을 확인해 주세요. 원본만 연결할 때는 인용을 비워 둡니다.",
        "CLAIM_SOURCE_STALE",
      );
  }
  const sourceSnapshots: ClaimReviewRecord["sourceSnapshots"] = [];
  let totalBytes = 0;
  for (const ref of input.references) {
    const source = company.sources.find((item) => item.id === ref.sourceId)!;
    let original: ClaimReviewRecord["sourceSnapshots"][number]["original"] = null;
    if (source.originalName) {
      const current = readOriginal(source.id);
      if (
        JSON.stringify(current.source) !== JSON.stringify(source) ||
        hash(current.buffer) !== current.sha256
      )
        fail("자료와 원본이 변경되었습니다. 다시 불러와 주세요.", "CLAIM_SOURCE_STALE");
      totalBytes += current.buffer.length;
      if (current.buffer.length > 12 * 1024 * 1024 || totalBytes > claimReviewLimits.originalBytes)
        fail("원본은 개별 12MiB, 합계 24MiB 이내로 연결해 주세요.", "CLAIM_ORIGINAL_LIMIT", 413);
      original = {
        sourceId: source.id,
        sourceName: source.name,
        originalName: source.originalName,
        mimeType: source.mimeType,
        sizeBytes: current.buffer.length,
        sha256: current.sha256,
        capturedAt: generated.recordedAt,
        sourceUpdatedAt: source.updatedAt,
      };
      if (originalConflicts(company, original))
        fail(
          "이미 고정한 원본 내용이 변경되었습니다. 새 원본을 별도 자료로 등록해 주세요.",
          "CLAIM_ORIGINAL_CHANGED",
        );
    }
    sourceSnapshots.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceUpdatedAt: source.updatedAt,
      extraction: source.extraction,
      textSha256: hash(source.text),
      original,
    });
  }
  const record = claimReviewRecordSchema.parse({
    ...generated,
    ...input,
    claimId: input.claimId ?? generated.id,
    previousVersionId: previous?.id ?? null,
    version: (previous?.version ?? 0) + 1,
    origin: "manual",
    sourceSnapshots,
    planSnapshots: [planSnapshot],
    auxiliarySnapshots,
    judgement: {
      ...input.judgement,
      recordedAt: input.judgement.state === "unreviewed" ? null : generated.recordedAt,
    },
  });
  assertClaimReviewCapacity([...company.claimReviews, record]);
  for (const snapshot of sourceSnapshots) {
    if (!snapshot.original) continue;
    const current = readOriginal(snapshot.sourceId),
      source = company.sources.find((item) => item.id === snapshot.sourceId)!;
    if (
      JSON.stringify(current.source) !== JSON.stringify(source) ||
      current.sha256 !== snapshot.original.sha256 ||
      hash(current.buffer) !== snapshot.original.sha256 ||
      current.buffer.length !== snapshot.original.sizeBytes
    )
      fail(
        "저장 중 자료·원본이 변경되어 주장 기록을 저장하지 않았습니다.",
        "CLAIM_ORIGINAL_CHANGED",
      );
  }
  return record;
}
