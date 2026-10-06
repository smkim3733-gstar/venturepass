import { z } from "zod";
import { publicClaimPreparationSchema } from "./studio-public-claim-comparison-preparation-types";
import {
  comparisonLiteralShape, comparisonPlanAuthority, publicClaimComparisonBoundaries,
  publicClaimComparisonResponseSchema, publicClaimComparisonMismatch,
} from "./studio-public-claim-comparison-types";
import {
  publicClaimComparisonRequestAuthority, publicClaimComparisonRequestIdentitySchema,
} from "./studio-public-claim-comparison-request-types";

export const comparisonReviewWireLimits = Object.freeze({
  queryBytes: 8192, resultBytes: 4 * 1024 * 1024,
  successBytes: 4 * 1024 * 1024 + 8192, errorBytes: 8192, timeoutMs: 30000,
});
export const comparisonReviewErrorStatus = Object.freeze({
  INVALID_QUERY: 400, LOCAL_ONLY: 403, RESULT_UNAVAILABLE: 404, READ_BLOCKED: 409,
  TOO_LARGE: 413, CONTENT_TYPE: 415, READ_FAILED: 500,
});
export type ComparisonReviewErrorCode = keyof typeof comparisonReviewErrorStatus;
export type ComparisonReviewReceiveCode = ComparisonReviewErrorCode |
  "CANCELLED" | "TIMEOUT" | "RECEIVE_LIMIT" | "INVALID_RESPONSE" | "RECEIVE_FAILED";
const messages: Record<ComparisonReviewReceiveCode, string> = {
  INVALID_QUERY: "원래 결과 선택을 확인해 주세요.", LOCAL_ONLY: "로컬 앱에서만 읽을 수 있습니다.",
  RESULT_UNAVAILABLE: "저장된 비교 결과를 확인할 수 없습니다.",
  READ_BLOCKED: "원래 실행 또는 저장 정리를 확인한 뒤 명시적으로 다시 읽어 주세요.",
  TOO_LARGE: "읽기 자료가 허용 한도를 초과했습니다.", CONTENT_TYPE: "읽기 응답 형식이 지원되지 않습니다.",
  READ_FAILED: "저장 결과를 읽지 못했습니다.", CANCELLED: "결과 읽기를 취소했습니다.",
  TIMEOUT: "결과 읽기 대기 시간이 지났습니다.", RECEIVE_LIMIT: "읽기 응답이 허용 한도를 초과했습니다.",
  INVALID_RESPONSE: "원래 선택과 응답 형식을 대조하지 못했습니다.", RECEIVE_FAILED: "결과 응답을 받지 못했습니다.",
};
export class ComparisonReviewReceiveError extends Error {
  constructor(readonly code: ComparisonReviewReceiveCode) { super(messages[code]); }
}
const invalid = (): never => { throw new ComparisonReviewReceiveError("INVALID_RESPONSE"); };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const utf8 = (s: string) => new TextEncoder().encode(s).byteLength;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const querySchema = z.object({
  runId: z.string().uuid(), dispatchCommandDigest: hash,
  mode: z.enum(["historical", "inspect-current"]),
}).strict();
export type ComparisonReviewQuery = z.infer<typeof querySchema>;

/** Capture three scalar fields without invoking accessors/toJSON hooks. Not a capability. */
export function copyComparisonReviewQuery(raw: unknown): ComparisonReviewQuery {
  try {
    if (!raw || typeof raw !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
      throw Error();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 3 || keys.some((key) => typeof key !== "string" ||
        !["runId", "dispatchCommandDigest", "mode"].includes(key))) throw Error();
    for (const key of ["runId", "dispatchCommandDigest", "mode"]) {
      const d = descriptors[key];
      if (!d || !("value" in d) || !d.enumerable || typeof d.value !== "string" ||
          d.value.length > comparisonReviewWireLimits.queryBytes) throw Error();
    }
    const query = querySchema.parse({
      runId: descriptors.runId.value, dispatchCommandDigest: descriptors.dispatchCommandDigest.value,
      mode: descriptors.mode.value,
    });
    if (utf8(JSON.stringify(query)) > comparisonReviewWireLimits.queryBytes) throw Error();
    return query;
  } catch { throw new ComparisonReviewReceiveError("INVALID_QUERY"); }
}
const p = publicClaimPreparationSchema.shape;
const opinion = z.object({
  contractVersion: z.literal("public-claim-comparison-v1"),
  source: z.literal("supplied-response"),
  ...comparisonLiteralShape(publicClaimComparisonBoundaries),
  preparationDigest: hash, selection: p.selection, excludedSourceIds: p.input.shape.excludedSourceIds,
  comparison: publicClaimComparisonResponseSchema,
}).strict();
const validated = z.object({
  source: z.literal("supplied-response"), evidenceOrigin: z.literal("manual-unverified"),
  ...comparisonLiteralShape(publicClaimComparisonRequestAuthority),
  currentContextVerified: z.literal(false), requestIdentity: publicClaimComparisonRequestIdentitySchema,
  responseArtifactSha256: hash,
  state: z.enum(["comparison-ready", "comparison-rejected", "response-incomplete", "response-unsupported", "model-mismatch"]),
  comparison: opinion.nullable(),
}).strict();
const changedReasons = ["PUBLIC_CLAIM_STALE", "PUBLIC_CLAIM_MISSING", "PUBLIC_CLAIM_REQUEST_CHANGED"] as const;
const unavailableReasons = ["PUBLIC_CLAIM_HISTORY", "PUBLIC_CLAIM_FORMAT", "PUBLIC_CLAIM_LIMIT",
  "PUBLIC_CLAIM_UNSUPPORTED", "PUBLIC_CLAIM_REQUEST_LIMIT", "CURRENT_AUDIT_UNAVAILABLE",
  "COMPANY_BUSY", "COMPANY_ROW_INVALID", "CURRENT_READ_UNAVAILABLE"] as const;
const units = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const resultSchema = z.object({
  source: z.literal("synthetic-comparison-stored-review"),
  resultIdentity: z.object({
    runId: z.string().uuid(), dispatchCommandDigest: hash, comparisonEventDigest: hash,
    responseArtifactSha256: hash, validatedArtifactSha256: hash,
    requestIdentity: publicClaimComparisonRequestIdentitySchema,
    preparationDigest: hash, selection: p.selection, binding: p.binding,
  }).strict(),
  historical: z.object({
    prepared: publicClaimPreparationSchema, result: validated, currentContextVerified: z.literal(false),
  }).strict(),
  database: z.object({
    comparisonRecorded: z.literal(true), costSettled: z.boolean(), finalized: z.boolean(),
    currentContextVerified: z.literal(false), runHeldBytes: integer, scopeHeldUnits: units, scopeRecognizedUnits: units,
  }).strict(),
  current: z.object({
    status: z.enum(["not-checked", "exact-original-request", "changed", "unavailable"]),
    originalRevision: integer, observedRevision: integer.nullable(),
    reason: z.enum([...changedReasons, ...unavailableReasons]).nullable(),
  }).strict(),
  owner: z.null(), runtimeObserved: z.literal(false),
  authority: z.object(comparisonLiteralShape(comparisonPlanAuthority)).strict(),
}).strict();
export type ComparisonReviewWireResult = z.infer<typeof resultSchema>;
const successSchema = z.object({
  wireVersion: z.literal(1), kind: z.literal("public-comparison-stored-review"),
  query: querySchema, result: resultSchema,
}).strict();
const errorSchema = z.object({
  wireVersion: z.literal(1), kind: z.literal("public-comparison-stored-review-error"),
  code: z.enum(["INVALID_QUERY", "LOCAL_ONLY", "RESULT_UNAVAILABLE", "READ_BLOCKED", "TOO_LARGE", "CONTENT_TYPE", "READ_FAILED"]),
}).strict();

function checkResult(r: ComparisonReviewWireResult, query: ComparisonReviewQuery) {
  const i = r.resultIdentity, prepared = r.historical.prepared, result = r.historical.result, c = r.current;
  if (i.runId !== query.runId || i.dispatchCommandDigest !== query.dispatchCommandDigest ||
      !equal(i.selection, prepared.selection) || !equal(i.binding, prepared.binding) ||
      i.preparationDigest !== prepared.preparationDigest ||
      i.requestIdentity.preparationDigest !== i.preparationDigest ||
      !equal(i.requestIdentity, result.requestIdentity) || result.responseArtifactSha256 !== i.responseArtifactSha256 ||
      c.originalRevision !== i.selection.companyRevision) invalid();
  const { preparationDigest: _digest, inputCharacters, ...payload } = prepared;
  void _digest;
  const evidence = prepared.input.selectedEvidence;
  if (JSON.stringify(payload).length !== inputCharacters ||
      !prepared.input.claimQuote.trim() || !prepared.input.section.content.includes(prepared.input.claimQuote) ||
      !equal(evidence.map((e) => e.sourceId), prepared.selection.sourceIds) ||
      new Set([...prepared.selection.sourceIds, ...prepared.input.excludedSourceIds]).size !==
        evidence.length + prepared.input.excludedSourceIds.length ||
      evidence.some((e) => !e.originalReference.quote.trim() || !e.excerpt.includes(e.originalReference.quote))) invalid();
  if (result.state === "comparison-ready") {
    const v = result.comparison;
    if (!v || v.preparationDigest !== i.preparationDigest || !equal(v.selection, i.selection) ||
        !equal(v.excludedSourceIds, prepared.input.excludedSourceIds) ||
        JSON.stringify(v.comparison).length > 240000 ||
        publicClaimComparisonMismatch(prepared, v.comparison)) invalid();
  } else if (result.comparison !== null) invalid();
  if (query.mode === "historical") {
    if (c.status !== "not-checked" || c.observedRevision !== null || c.reason !== null) invalid();
  } else {
    if (c.status === "not-checked") invalid();
    if (c.status === "exact-original-request" &&
        (c.observedRevision !== c.originalRevision || c.reason !== null)) invalid();
    if (c.status === "changed" &&
        (c.observedRevision === null || !changedReasons.some((reason) => reason === c.reason))) invalid();
    if (c.status === "unavailable" && !unavailableReasons.some((reason) => reason === c.reason)) invalid();
  }
  if (utf8(JSON.stringify(r)) > comparisonReviewWireLimits.resultBytes)
    throw new ComparisonReviewReceiveError("RECEIVE_LIMIT");
}

/** Trusted server composition additionally owns SQL/response authenticity. This checks data only. */
export function comparisonReviewSuccessWire(query: ComparisonReviewQuery, raw: unknown): string {
  try {
    const value = successSchema.parse({ wireVersion: 1, kind: "public-comparison-stored-review", query, result: raw });
    // No silently trimmed/defaulted fields. The service has already supplied data-only objects.
    if (!equal(value.result, raw)) invalid();
    checkResult(value.result, value.query);
    const text = JSON.stringify(value);
    if (utf8(text) > comparisonReviewWireLimits.successBytes)
      throw new ComparisonReviewReceiveError("RECEIVE_LIMIT");
    return text;
  } catch (e) {
    if (e instanceof ComparisonReviewReceiveError) throw e;
    return invalid();
  }
}
export function comparisonReviewErrorWire(code: ComparisonReviewErrorCode): string {
  return JSON.stringify(errorSchema.parse({ wireVersion: 1, kind: "public-comparison-stored-review-error", code }));
}

/** Called only after the byte boundary. One JSON parse, strict shape, original query, canonical wire. */
export function decodeComparisonReviewWire(text: string, status: number, query: ComparisonReviewQuery): ComparisonReviewWireResult {
  try {
    if (utf8(text) > (status === 200 ? comparisonReviewWireLimits.successBytes : comparisonReviewWireLimits.errorBytes))
      throw new ComparisonReviewReceiveError("RECEIVE_LIMIT");
    if (text.charCodeAt(0) === 0xfeff) invalid();
    const raw: unknown = JSON.parse(text);
    if (status !== 200) {
      const error = errorSchema.parse(raw);
      if (comparisonReviewErrorStatus[error.code] !== status || JSON.stringify(error) !== text) invalid();
      throw new ComparisonReviewReceiveError(error.code);
    }
    const value = successSchema.parse(raw);
    if (JSON.stringify(value) !== text || !equal(value.query, query)) invalid();
    checkResult(value.result, query);
    return value.result;
  } catch (e) {
    if (e instanceof ComparisonReviewReceiveError) throw e;
    return invalid();
  }
}
