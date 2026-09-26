// Node-only local preparation. No AI, official portal, or message transmission.
import { createHash } from "node:crypto";
import type { StudioCase, SourceDocument } from "./studio-schema";
import { StudioError } from "./studio-http";
import {
  buildAgencyRecord,
  agencyRecordSchema,
  type AgencyEvidenceSnapshot,
} from "./studio-agency-records";
import { originalConflicts, planConflicts } from "./studio-evidence-history";
import {
  responsePreparationInputSchema,
  responsePreparationSchema,
  responsePreparationLimits,
  preparedResponseBody,
  type ResponsePreparation,
  type ResponsePreparationInput,
  type RegisterPreparedResponse,
} from "./studio-response-preparation-types";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Generated = Pick<ResponsePreparation, "id" | "clientRequestId" | "inputDigest" | "recordedAt">;
type OriginalReader = (sourceId: string) => {
  source: SourceDocument;
  buffer: Buffer;
  sha256: string;
};
function fail(code: string, status = 409): never {
  throw new StudioError(
    "최신 요청과 연결한 원고·자료를 확인해 주세요. 기존 답변 준비 이력은 보존했습니다.",
    status,
    code,
  );
}
export const responsePreparationDigest = (input: ResponsePreparationInput) =>
  hash(JSON.stringify(responsePreparationInputSchema.parse(input)));
export const preparedResponseRegistrationDigest = (input: RegisterPreparedResponse) =>
  hash(
    JSON.stringify({
      action: input.action,
      preparationId: input.preparationId,
      preparationVersionId: input.preparationVersionId,
      previousResponseId: input.previousResponseId,
    }),
  );
export function isResponsePreparationReplay(
  records: ResponsePreparation[],
  nonce: string,
  digest: string,
) {
  const matches = records.filter((entry) => entry.clientRequestId === nonce);
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== digest) fail("RESPONSE_REQUEST_CONFLICT");
  return true;
}
export function assertResponsePreparationCapacity(records: ResponsePreparation[]) {
  const count = (value: unknown): number =>
    typeof value === "string"
      ? value.length
      : Array.isArray(value)
        ? value.reduce((sum, item) => sum + count(item), 0)
        : value && typeof value === "object"
          ? Object.values(value).reduce<number>((sum, item) => sum + count(item), 0)
          : 0;
  if (
    records.length > responsePreparationLimits.versions ||
    count(records) > responsePreparationLimits.characters
  )
    fail("RESPONSE_PREPARATION_LIMIT", 413);
}

function captureContext(
  company: StudioCase,
  input: ResponsePreparationInput,
  recordedAt: string,
  readOriginal: OriginalReader,
) {
  const root = company.agencyRecords.filter(
    (entry) => entry.kind === "request" && entry.id === input.requestRecordId,
  );
  const request = company.agencyRecords
    .filter(
      (entry) =>
        (entry.kind === "request" || entry.kind === "request-correction") &&
        entry.requestRecordId === input.requestRecordId,
    )
    .at(-1);
  if (root.length !== 1 || !request) fail("RESPONSE_REQUEST_NOT_FOUND", 404);
  if (request.id !== input.requestVersionId) fail("RESPONSE_REQUEST_STALE");
  if (preparedResponseBody(input).length > responsePreparationLimits.body)
    fail("RESPONSE_BODY_LIMIT", 413);
  const references = input.items.flatMap((item) => item.evidence);
  const sourceIds = [...new Set(references.map((ref) => ref.sourceId))];
  if (sourceIds.length > responsePreparationLimits.sources) fail("RESPONSE_SOURCE_LIMIT", 413);
  // Membership and all exact quotes are checked before any original is opened.
  for (const reference of references) {
    const matches = company.sources.filter((source) => source.id === reference.sourceId);
    if (matches.length !== 1) fail("RESPONSE_SOURCE_NOT_FOUND", 404);
    const source = matches[0];
    if (
      source.updatedAt !== reference.sourceUpdatedAt ||
      (reference.quote === ""
        ? !source.originalName
        : !reference.quote.trim() ||
          source.extraction === "pending" ||
          !source.text.includes(reference.quote))
    )
      fail("RESPONSE_SOURCE_STALE");
  }
  const planSnapshots: ResponsePreparation["planSnapshots"] = [];
  for (const item of input.items) {
    if (!request.body.includes(item.requestQuote)) fail("RESPONSE_QUOTE_INVALID", 422);
    if (!item.planClaim) continue;
    const claim = item.planClaim;
    const matches = company.plans.filter((plan) => plan.id === claim.planId);
    if (matches.length !== 1) fail("RESPONSE_PLAN_NOT_FOUND", 404);
    const plan = matches[0];
    const sections = plan.content.sections.filter((section) => section.key === claim.sectionKey);
    if (sections.length !== 1 || !sections[0].content.includes(claim.quote))
      fail("RESPONSE_PLAN_QUOTE_INVALID", 422);
    const snapshot = {
      planId: plan.id,
      version: plan.version,
      contentSha256: hash(JSON.stringify(plan.content)),
    };
    if (planConflicts(company, snapshot)) fail("RESPONSE_PLAN_CHANGED");
    if (!planSnapshots.some((entry) => entry.planId === plan.id)) planSnapshots.push(snapshot);
  }
  const sourceSnapshots: ResponsePreparation["sourceSnapshots"] = [];
  let totalBytes = 0;
  for (const sourceId of sourceIds) {
    const source = company.sources.find((entry) => entry.id === sourceId)!;
    let original: AgencyEvidenceSnapshot | null = null;
    if (source.originalName) {
      const current = readOriginal(sourceId);
      if (
        JSON.stringify(current.source) !== JSON.stringify(source) ||
        current.sha256 !== hash(current.buffer)
      )
        fail("RESPONSE_SOURCE_STALE");
      totalBytes += current.buffer.length;
      if (
        current.buffer.length > responsePreparationLimits.originalBytes ||
        totalBytes > responsePreparationLimits.totalOriginalBytes
      )
        fail("RESPONSE_ORIGINAL_LIMIT", 413);
      original = {
        sourceId,
        sourceName: source.name,
        originalName: source.originalName,
        mimeType: source.mimeType,
        sizeBytes: current.buffer.length,
        sha256: current.sha256,
        sourceUpdatedAt: source.updatedAt,
        capturedAt: recordedAt,
      };
      if (originalConflicts(company, original)) fail("RESPONSE_ORIGINAL_CHANGED");
    }
    sourceSnapshots.push({
      sourceId,
      sourceName: source.name,
      sourceUpdatedAt: source.updatedAt,
      extraction: source.extraction,
      textSha256: hash(source.text),
      original,
    });
  }
  for (const snapshot of sourceSnapshots) {
    if (!snapshot.original) continue;
    const current = readOriginal(snapshot.sourceId);
    const source = company.sources.find((entry) => entry.id === snapshot.sourceId)!;
    if (
      JSON.stringify(current.source) !== JSON.stringify(source) ||
      current.sha256 !== snapshot.original.sha256 ||
      hash(current.buffer) !== snapshot.original.sha256 ||
      current.buffer.length !== snapshot.original.sizeBytes
    )
      fail("RESPONSE_ORIGINAL_CHANGED");
  }
  return { sourceSnapshots, planSnapshots };
}

export function buildResponsePreparation(
  company: StudioCase,
  raw: ResponsePreparationInput,
  generated: Generated,
  readOriginal: OriginalReader,
): ResponsePreparation {
  const input = responsePreparationInputSchema.parse(raw);
  if (company.responsePreparations.length >= responsePreparationLimits.versions)
    fail("RESPONSE_PREPARATION_LIMIT", 413);
  let previous: ResponsePreparation | undefined;
  if (input.preparationId) {
    const roots = company.responsePreparations.filter(
      (entry) => entry.id === input.preparationId && entry.previousVersionId === null,
    );
    if (roots.length !== 1) fail("RESPONSE_PREPARATION_NOT_FOUND", 404);
    if (roots[0].requestRecordId !== input.requestRecordId) fail("RESPONSE_ROOT_MISMATCH");
    previous = company.responsePreparations
      .filter((entry) => entry.preparationId === input.preparationId)
      .at(-1)!;
    if (previous.id !== input.previousVersionId) fail("RESPONSE_VERSION_STALE");
  } else if (
    company.responsePreparations.some((entry) => entry.requestRecordId === input.requestRecordId)
  )
    fail("RESPONSE_ALREADY_EXISTS");
  const snapshots = captureContext(company, input, generated.recordedAt, readOriginal);
  const record = responsePreparationSchema.parse({
    ...input,
    ...generated,
    preparationId: input.preparationId ?? generated.id,
    previousVersionId: previous?.id ?? null,
    version: (previous?.version ?? 0) + 1,
    origin: "manual",
    mode: "assisted",
    reviewStatus: "unreviewed",
    ...snapshots,
  });
  assertResponsePreparationCapacity([...company.responsePreparations, record]);
  return record;
}

export function buildPreparedAgencyResponse(
  company: StudioCase,
  input: RegisterPreparedResponse,
  generated: Generated,
  readOriginal: OriginalReader,
) {
  const preparation = company.responsePreparations
    .filter((entry) => entry.preparationId === input.preparationId)
    .at(-1);
  if (!preparation) fail("RESPONSE_PREPARATION_NOT_FOUND", 404);
  if (preparation.id !== input.preparationVersionId) fail("RESPONSE_VERSION_STALE");
  if (
    company.agencyRecords.some(
      (entry) =>
        entry.kind === "response" && entry.preparedFrom?.preparationVersionId === preparation.id,
    )
  )
    fail("RESPONSE_ALREADY_REGISTERED");
  const raw: ResponsePreparationInput = {
    preparationId: preparation.preparationId,
    previousVersionId: preparation.previousVersionId,
    requestRecordId: preparation.requestRecordId,
    requestVersionId: preparation.requestVersionId,
    title: preparation.title,
    items: preparation.items,
  };
  const snapshots = captureContext(company, raw, generated.recordedAt, readOriginal);
  const withoutCaptureTime = (sources: ResponsePreparation["sourceSnapshots"]) =>
    responsePreparationSchema.shape.sourceSnapshots.parse(sources).map((source) => ({
      ...source,
      original: source.original ? { ...source.original, capturedAt: "" } : null,
    }));
  if (
    JSON.stringify(withoutCaptureTime(snapshots.sourceSnapshots)) !==
      JSON.stringify(withoutCaptureTime(preparation.sourceSnapshots)) ||
    JSON.stringify(snapshots.planSnapshots) !== JSON.stringify(preparation.planSnapshots)
  )
    fail("RESPONSE_CONTEXT_CHANGED");
  const evidence = snapshots.sourceSnapshots.flatMap((source) =>
    source.original ? [source.original] : [],
  );
  const response = buildAgencyRecord(
    company.agencyRecords,
    {
      kind: "response",
      requestRecordId: preparation.requestRecordId,
      previousVersionId: input.previousResponseId,
      title: preparation.title,
      body: preparedResponseBody(preparation),
      occurredOn: "",
      note: "로컬 작성 보조에서 등록한 미검토·미발송 답변 초안입니다.",
      responseStatus: "draft",
      sourceIds: evidence.map((source) => source.sourceId),
    },
    { ...generated, evidence },
  );
  return agencyRecordSchema.parse({
    ...response,
    preparedFrom: {
      preparationId: preparation.preparationId,
      preparationVersionId: preparation.id,
    },
  });
}
