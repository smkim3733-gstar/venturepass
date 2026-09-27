import { z } from "zod";
import {
  createPlanQualityRecordTemplate,
  planQualityCatalogSchema,
  planQualityRunSnapshotSchema,
  planQualityRequestResultSchema,
  planQualityEvaluationSchema,
  planQualityFixtureResponseSchema,
  planQualityArchiveSchema,
  planQualityDownloadName,
  planQualityRequestDigestInput,
  planQualityStoreLimits,
  type PlanQualityEvaluation,
  type PlanQualityManifestEntry,
  type PlanQualityRunSnapshot,
  type PlanQualityReceipt,
  type PlanQualityCreateRunRequest,
  type PlanQualitySaveRecordRequest,
} from "@/lib/studio-plan-quality-store-types";
import { jsonBody } from "./shared";

export const QUALITY_EDITOR_BYTES = planQualityStoreLimits.recordBytes;
export type QualityCatalog = z.infer<typeof planQualityCatalogSchema>;
export type QualityRun = PlanQualityRunSnapshot;
export type QualityPending =
  | { kind: "create"; request: PlanQualityCreateRunRequest }
  | {
      kind: "record";
      runId: string;
      manifestDigest: string;
      request: PlanQualitySaveRecordRequest;
    };

export type QualityRecordBinding = Pick<
  PlanQualityEvaluation,
  "fixtureId" | "sourceDigest" | "candidateDigest" | "inputPlanDigest" | "rubricDigest"
>;

export const qualityStatusLabels = {
  unevaluated: "미평가",
  assisted: "자료 정리 결과 기록",
  mock: "모의 결과 기록",
  "review-needed": "평가 기록 보완 필요",
  "review-disagreement": "검토 의견 조정 필요",
  failed: "실패 또는 기록 조건 미달",
  passed: "입력 기록의 점검 조건 일치",
  invalid: "기록 연결 확인 필요",
} as const;

/** Start without declaring an execution, answer key, independent review, or outcome. */
export function emptyQualityEvaluation(binding: PlanQualityManifestEntry): PlanQualityEvaluation {
  return createPlanQualityRecordTemplate(binding);
}

/** Only editor context is checked here. Full schema and digest validation belongs to the server. */
export function qualityDraftValue(
  raw: string,
  binding: QualityRecordBinding,
  maximumBytes: number,
) {
  if (new TextEncoder().encode(raw).byteLength > maximumBytes)
    throw new Error("평가 JSON이 저장 가능한 크기를 초과했습니다.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("평가 JSON 형식을 확인해 주세요. 입력 내용은 유지했습니다.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("평가 기록은 JSON 객체로 입력해 주세요.");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    (
      ["fixtureId", "sourceDigest", "candidateDigest", "inputPlanDigest", "rubricDigest"] as const
    ).some((key) => record[key] !== binding[key])
  )
    throw new Error("선택한 합성 사례와 입력 기록이 다릅니다. 사례와 원본 연결값을 확인해 주세요.");
  const parsed = planQualityEvaluationSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `평가 기록 형식을 확인해 주세요: ${parsed.error.issues[0]?.message ?? "필수 항목 확인"}`,
    );
  return parsed.data;
}

export function qualityRecordText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function unique(values: string[]) {
  return new Set(values).size === values.length;
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
// Request/response identity only. Existing execution and human-review digests are never rewritten.
async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function bindingMatches(value: QualityRecordBinding, expected: QualityRecordBinding) {
  return (
    ["fixtureId", "sourceDigest", "candidateDigest", "inputPlanDigest", "rubricDigest"] as const
  ).every((key) => value[key] === expected[key]);
}
export function qualityCatalog(raw: unknown): QualityCatalog {
  const value = planQualityCatalogSchema.parse(raw);
  if (
    !unique(value.manifest.map((item) => item.fixtureId)) ||
    !unique(value.runs.map((item) => item.id)) ||
    !unique(value.runs.map((item) => item.clientRequestId))
  )
    throw new Error("평가 회차 목록의 연결 정보를 확인하지 못했습니다.");
  return value;
}
export function qualitySnapshot(
  raw: unknown,
  expected: { id: string; revision?: number },
): QualityRun {
  const value = planQualityRunSnapshotSchema.parse(raw);
  if (
    value.id !== expected.id ||
    (expected.revision !== undefined && value.revision !== expected.revision) ||
    value.revision > value.currentRevision ||
    value.currentRevision > planQualityStoreLimits.revisions ||
    !unique(value.manifest.map((item) => item.fixtureId)) ||
    !unique(value.records.map((item) => item.fixtureId)) ||
    value.records.some((record) => {
      const entry = value.manifest.find((item) => item.fixtureId === record.fixtureId);
      return !entry || !bindingMatches(record, entry);
    }) ||
    !unique(value.history.map((item) => item.clientRequestId)) ||
    value.history.length !== value.revision + 1 ||
    value.history[0]?.clientRequestId !== value.clientRequestId ||
    value.history.some(
      (item, index) =>
        item.runId !== value.id ||
        item.revision !== index ||
        item.kind !== (index === 0 ? "create" : "record"),
    )
  )
    throw new Error("선택한 평가 회차·버전의 기록을 확인하지 못했습니다.");
  if (value.summary) {
    const counts = value.summary.counts;
    if (
      value.summary.fixtureCount !== 50 ||
      Object.keys(qualityStatusLabels).some(
        (key) =>
          !Number.isInteger(counts[key as keyof typeof qualityStatusLabels]) ||
          counts[key as keyof typeof qualityStatusLabels] < 0,
      ) ||
      Object.values(counts).reduce((sum, count) => sum + count, 0) !== 50 ||
      value.summary.cases.length !== 50 ||
      !unique(value.summary.cases.map((item) => item.fixtureId)) ||
      value.summary.cases.some(
        (item) =>
          !value.manifest.some((entry) => entry.fixtureId === item.fixtureId) ||
          !(item.status in qualityStatusLabels),
      ) ||
      !Array.isArray(value.summary.limitations) ||
      !value.summary.limitations.every((item) => typeof item === "string")
    )
      throw new Error("평가 집계와 합성 사례 연결을 확인하지 못했습니다.");
  }
  return value;
}
export async function qualityRecovery(raw: unknown, pending: QualityPending) {
  const value = planQualityRequestResultSchema.parse(raw);
  if (value.state === "not-observed") return value;
  const receipt = value.receipt;
  const input =
    pending.kind === "create"
      ? planQualityRequestDigestInput("create", pending.request)
      : planQualityRequestDigestInput("record", pending.request, pending.runId);
  if (
    receipt.clientRequestId !== pending.request.clientRequestId ||
    receipt.kind !== pending.kind ||
    receipt.inputDigest !== (await digest(input)) ||
    (pending.kind === "create"
      ? receipt.revision !== 0
      : receipt.runId !== pending.runId || receipt.revision !== pending.request.revision + 1)
  )
    throw new Error("이 요청과 일치하는 저장 결과를 확인하지 못했습니다. 조회 상태를 유지합니다.");
  return value;
}
export function qualityCommittedSnapshot(
  raw: unknown,
  pending: QualityPending,
  receipt: PlanQualityReceipt,
) {
  const value = qualitySnapshot(raw, { id: receipt.runId, revision: receipt.revision });
  const history = value.history.filter(
    (item) => item.clientRequestId === pending.request.clientRequestId,
  );
  if (
    history.length !== 1 ||
    history[0].inputDigest !== receipt.inputDigest ||
    history[0].revision !== receipt.revision ||
    history[0].kind !== pending.kind ||
    value.manifestDigest !==
      (pending.kind === "create" ? pending.request.manifestDigest : pending.manifestDigest) ||
    (pending.kind === "create"
      ? value.title !== pending.request.title ||
        value.records.some(
          (item) =>
            item.answerKey !== null ||
            item.execution !== null ||
            item.humanReviews.length !== 0 ||
            item.resolution !== null,
        )
      : !same(
          value.records.find((item) => item.fixtureId === pending.request.record.fixtureId),
          pending.request.record,
        ))
  )
    throw new Error(
      "보관한 평가 기록이 요청한 내용과 일치하지 않습니다. 입력 내용은 유지했습니다.",
    );
  return value;
}
export async function qualityFixture(raw: unknown, binding: PlanQualityManifestEntry) {
  const value = planQualityFixtureResponseSchema.parse(raw);
  if (
    value.fixture.id !== binding.fixtureId ||
    !same(value.template, emptyQualityEvaluation(binding)) ||
    (await digest({ profile: value.fixture.profile, sources: value.fixture.sources })) !==
      binding.sourceDigest ||
    (await digest(value.fixture.candidate)) !== binding.candidateDigest ||
    (await digest(value.fixture.plan)) !== binding.inputPlanDigest ||
    (await digest({
      deterministic: value.fixture.deterministicExpectation,
      semantic: value.fixture.semanticRubric,
    })) !== binding.rubricDigest
  )
    throw new Error("선택한 합성 사례와 입력 자료의 연결이 일치하지 않습니다.");
  return value;
}
export class QualityWriteRejection extends Error {
  readonly accepted = false;
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function qualityPost(url: string, input: unknown) {
  const response = await fetch(url, { method: "POST", cache: "no-store", ...jsonBody(input) });
  const raw: unknown = await response.json().catch(() => null);
  if (response.ok) return;
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const message =
    typeof body.error === "string" ? body.error : "평가 기록의 저장 결과를 확인하지 못했습니다.";
  if (response.status >= 400 && response.status < 500 && body.accepted === false)
    throw new QualityWriteRejection(message, response.status);
  throw new Error(message);
}

export async function qualityArchiveDownload(
  response: Response,
  expected: { id: string; revision: number },
) {
  const filename = planQualityDownloadName(expected.id, expected.revision);
  const disposition = response.headers.get("content-disposition")?.trim();
  const declared = response.headers.get("content-length");
  const limit = planQualityStoreLimits.totalBytes;
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json" ||
    ![
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      `attachment; filename="${filename}"`,
    ].includes(disposition ?? "") ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
  ) {
    await response.body?.cancel();
    throw new Error("평가 기록 다운로드의 형식·파일 이름·크기를 확인하지 못했습니다.");
  }
  if (!response.body) throw new Error("내려받을 평가 기록이 없습니다.");
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("평가 기록 다운로드 크기가 너무 큽니다.");
      chunks.push(new Uint8Array(chunk.value).buffer);
    }
    if (declared !== null && Number(declared) !== size)
      throw new Error("평가 기록 다운로드가 완전하지 않습니다.");
    const blob = new Blob(chunks, { type: "application/json" });
    const archive = planQualityArchiveSchema.parse(JSON.parse(await blob.text()));
    const snapshot = Object.fromEntries(
      Object.entries(archive).filter(([key]) => key !== "schemaVersion" && key !== "notice"),
    );
    // Use the same exact revision/binding checks without inventing live metadata in the downloaded file.
    qualitySnapshot(
      { ...snapshot, currentRevision: archive.revision, manifestCurrent: false, summary: null },
      expected,
    );
    return { blob, filename };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
