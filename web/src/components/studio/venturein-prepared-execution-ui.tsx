import { z } from "zod";
import {
  ventureExecutionRecordSchema,
  venturePreparedComparisonSchema,
  venturePreparedPackageBindingSchema,
  type VentureExecutionReview,
  type VentureExecutionRecord,
  type VentureRecoveryReview,
  type VenturePreparedComparison,
  type VenturePreparedPackageBinding,
} from "@/lib/venturein-execution-schema";
import type { PreparedPackageSummary } from "@/lib/studio-prepared-package-types";
import type { VentureResolvedAttachment, VentureResolvedText } from "@/lib/venturein-preflight";
import { formatDate, Notice } from "./shared";

export type PreparedExecutionComparison = VenturePreparedComparison;
type ComparisonContext = Pick<
  VenturePreparedComparison,
  | "caseId"
  | "workflowRevision"
  | "companyRevision"
  | "accountRevision"
  | "snapshotId"
  | "sessionStartedAt"
>;
function fail(): never {
  throw new Error(
    "준비본 연결과 현재 선택 범위를 확인하지 못했습니다. 최신 상태를 읽고 다시 대조해 주세요.",
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);
async function sha(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validateTargets(
  prepared: VenturePreparedPackageBinding,
  text: readonly VentureResolvedText[],
  files: readonly VentureResolvedAttachment[],
) {
  const value = venturePreparedPackageBindingSchema.parse(prepared);
  if ((await sha(canonical(value.binding))) !== value.digest) fail();
  const fileKeys = [...new Set(files.map((file) => file.fieldKey))];
  if (
    value.binding.targets.length !== text.length + fileKeys.length ||
    new Set(value.binding.targets.map((target) => target.fieldKey)).size !==
      value.binding.targets.length
  )
    fail();
  for (const [index, field] of text.entries()) {
    const target = value.binding.targets[index];
    if (
      !target ||
      target.kind !== "text" ||
      target.fieldKey !== field.fieldKey ||
      !field.confirmed ||
      !equal(target.source, field.source) ||
      target.characterCount !== field.characterCount ||
      field.characterCount !== field.value.length ||
      target.valueSha256 !== (await sha(field.value))
    )
      fail();
  }
  for (const [index, key] of fileKeys.entries()) {
    const target = value.binding.targets[text.length + index];
    const expected = files.filter((file) => file.fieldKey === key);
    if (
      !target ||
      target.kind !== "file" ||
      target.fieldKey !== key ||
      target.files.length !== expected.length
    )
      fail();
    for (const [fileIndex, file] of expected.entries()) {
      const bound = target.files[fileIndex];
      if (
        !file.confirmed ||
        bound.sourceId !== file.sourceId ||
        bound.sourceUpdatedAt !== file.sourceUpdatedAt ||
        bound.originalName !== file.originalName ||
        bound.mimeType !== file.mimeType ||
        bound.sizeBytes !== file.sizeBytes ||
        ("sha256" in file && file.sha256 !== bound.sha256)
      )
        fail();
    }
  }
}

export async function validatePreparedComparison(
  raw: unknown,
  expected: ComparisonContext,
  selected: PreparedPackageSummary,
  text: readonly VentureResolvedText[],
  files: readonly VentureResolvedAttachment[],
): Promise<VenturePreparedComparison> {
  const value = venturePreparedComparisonSchema.parse(raw);
  if (
    Object.entries(expected).some(
      ([key, item]) => value[key as keyof ComparisonContext] !== item,
    ) ||
    selected.caseId !== expected.caseId ||
    !equal(value.preparedPackage, selected)
  )
    fail();
  const result = value.result;
  if (result.packageDraft !== null && result.packageDraft !== selected.draft) fail();
  if (
    result.companyRevisionChanged !== null &&
    result.companyRevisionChanged !== (expected.companyRevision !== selected.caseRevision)
  )
    fail();
  if (result.matched) {
    const binding = result.binding!;
    if (
      binding.caseId !== expected.caseId ||
      binding.companyRevision !== expected.companyRevision ||
      binding.package.id !== selected.id ||
      binding.package.version !== selected.version ||
      binding.package.caseRevision !== selected.caseRevision ||
      binding.package.createdAt !== selected.createdAt ||
      binding.package.zipSha256 !== selected.zipSha256 ||
      binding.package.zipSizeBytes !== selected.sizeBytes ||
      binding.plan.id !== selected.planId ||
      binding.plan.version !== selected.planVersion ||
      binding.plan.contentSha256 !== selected.planContentSha256 ||
      binding.targets.some(
        (target) =>
          target.kind === "file" &&
          target.files.some((file) => !selected.sourceIds.includes(file.sourceId)),
      )
    )
      fail();
    await validateTargets(
      {
        binding,
        digest: result.digest!,
        packageDraft: result.packageDraft!,
        companyRevisionChanged: result.companyRevisionChanged!,
      },
      text,
      files,
    );
  }
  return value;
}

export async function validatePreparedExecutionReview(
  review: VentureExecutionReview,
  comparison: VenturePreparedComparison,
  text: readonly VentureResolvedText[],
  files: readonly VentureResolvedAttachment[],
) {
  if (
    !comparison.result.matched ||
    !comparison.result.binding ||
    !comparison.result.digest ||
    !z.string().uuid().safeParse(review.token).success ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.now() ||
    review.scope !== "selected-fields" ||
    review.workflowRevision !== comparison.workflowRevision ||
    review.companyRevision !== comparison.companyRevision ||
    review.accountRevision !== comparison.accountRevision ||
    review.snapshotId !== comparison.snapshotId ||
    review.sessionStartedAt !== comparison.sessionStartedAt ||
    !Array.isArray(review.fields) ||
    !Array.isArray(review.attachments) ||
    !equal(review.fields, text) ||
    review.attachments.length !== files.length ||
    review.fieldCount !== text.length ||
    review.attachmentCount !== files.length
  )
    fail();
  const prepared = venturePreparedPackageBindingSchema.parse(review.preparedPackage);
  if (
    !equal(prepared, {
      binding: comparison.result.binding,
      digest: comparison.result.digest,
      packageDraft: comparison.result.packageDraft,
      companyRevisionChanged: comparison.result.companyRevisionChanged,
    })
  )
    fail();
  for (const [index, file] of review.attachments.entries()) {
    const { sha256: _sha, ...metadata } = file;
    void _sha;
    if (!equal(metadata, files[index])) fail();
  }
  await validateTargets(prepared, review.fields, review.attachments);
  return review;
}

/** Legacy review remains legacy; recovery cannot replace or add the original prepared scope. */
export function validateRecoveryPreparedBinding(
  received: unknown,
  expected: VenturePreparedPackageBinding | undefined,
) {
  if (expected === undefined) {
    if (received !== undefined) fail();
    return;
  }
  const value = venturePreparedPackageBindingSchema.parse(received);
  if (!equal(value, venturePreparedPackageBindingSchema.parse(expected))) fail();
}
export async function validateRecoveryPreparedTargets(
  prepared: VenturePreparedPackageBinding | undefined,
  fields: readonly VentureResolvedText[],
) {
  if (prepared !== undefined) await validateTargets(prepared, fields, []);
}

export function validatePreparedExecutionReceipt(
  raw: unknown,
  expected: VenturePreparedPackageBinding | undefined,
  caseId: string,
) {
  const record = ventureExecutionRecordSchema.parse(raw);
  if (!record.manifest || record.manifest.caseId !== caseId) fail();
  if (expected === undefined) {
    if (record.manifest.version !== 1) fail();
  } else {
    if (record.manifest.version !== 2) fail();
    validateRecoveryPreparedBinding(record.manifest.preparedPackage, expected);
  }
  return record;
}

export type PreparedExecutionExpectation = {
  caseId: string;
  companyRevision: number;
  accountRevision: number;
  workflowRevision: number;
  snapshotId: string;
  sessionStartedAt: string;
  previousExecutionId: string | null;
  priorExecutionId: string | null;
  requestedFieldKeys: string[];
  preservedFieldKeys: string[];
  preparedPackage: VenturePreparedPackageBinding | undefined;
  originalManifest: NonNullable<VentureExecutionRecord["manifest"]> | null;
};

/** Capture before POST. A later GET must prove this request's scope, not merely a newer ID. */
export function createPreparedExecutionExpectation(
  caseId: string,
  review: VentureExecutionReview | VentureRecoveryReview,
  previous: VentureExecutionRecord | null,
): PreparedExecutionExpectation {
  const recovery = review.scope === "text-recovery";
  if (recovery && (!previous?.manifest || previous.id !== review.priorExecutionId)) fail();
  if (!recovery && !review.preparedPackage) fail();
  const value: PreparedExecutionExpectation = {
    caseId,
    companyRevision: review.companyRevision,
    accountRevision: review.accountRevision,
    workflowRevision: review.workflowRevision,
    snapshotId: review.snapshotId,
    sessionStartedAt: review.sessionStartedAt,
    previousExecutionId: previous?.id ?? null,
    priorExecutionId: recovery ? review.priorExecutionId : null,
    requestedFieldKeys: [
      ...review.fields.map((field) => field.fieldKey),
      ...(!recovery ? [...new Set(review.attachments.map((file) => file.fieldKey))] : []),
    ],
    preservedFieldKeys: recovery ? review.protectedFields.map((field) => field.fieldKey) : [],
    preparedPackage: review.preparedPackage,
    originalManifest: recovery ? previous!.manifest! : null,
  };
  return structuredClone(value);
}

export function validatePreparedExecutionOutcome(
  raw: unknown,
  expected: PreparedExecutionExpectation,
) {
  const record = validatePreparedExecutionReceipt(raw, expected.preparedPackage, expected.caseId);
  const manifest = record.manifest!;
  const touched = record.touchedFieldKeys;
  if (
    record.id === expected.previousExecutionId ||
    record.snapshotId !== expected.snapshotId ||
    manifest.snapshotId !== expected.snapshotId ||
    manifest.companyRevision !== expected.companyRevision ||
    manifest.accountRevision !== expected.accountRevision ||
    manifest.sessionStartedAt !== expected.sessionStartedAt ||
    record.priorExecutionId !== expected.priorExecutionId ||
    !equal(record.requestedFieldKeys, expected.requestedFieldKeys) ||
    !equal(record.preservedFieldKeys, expected.preservedFieldKeys) ||
    (expected.originalManifest
      ? !equal(manifest, expected.originalManifest)
      : manifest.workflowRevision !== expected.workflowRevision) ||
    (record.status !== "running" && !record.finishedAt) ||
    !touched ||
    !equal(touched, expected.requestedFieldKeys.slice(0, touched.length)) ||
    new Set(record.completedFieldKeys).size !== record.completedFieldKeys.length ||
    record.completedFieldKeys.some((key) => !touched.includes(key)) ||
    (record.attemptedFieldKey !== null && record.attemptedFieldKey !== touched.at(-1)) ||
    (record.status === "completed" &&
      (record.code !== null ||
        record.attemptedFieldKey !== null ||
        !equal(record.completedFieldKeys, expected.requestedFieldKeys))) ||
    (record.status === "stopped" && record.code === null)
  )
    fail();
  return { record, settled: record.status !== "running" && record.code !== "INPUT_RESULT_UNKNOWN" };
}

const draftReasonLabels: Record<string, string> = {
  PLAN_NOT_CURRENT: "최신 기업자료를 반영해 원고를 다시 확인해 주세요.",
  OLDER_PLAN_VERSION: "더 최근에 작성한 원고가 있습니다. 사용할 작성본을 다시 확인해 주세요.",
  NOT_REVIEWED: "원고의 내부 검토 완료 기록이 필요합니다.",
  UNCONFIRMED_SECTION: "사실·증빙을 확인해야 할 본문 항목이 남아 있습니다.",
  REVIEW_ERROR: "현재 원고 검토에서 발견한 오류를 보완해 주세요.",
  REVIEW_CONFIRMATION: "현재 원고 검토에서 추가 사실 확인이 필요합니다.",
  STORED_REVIEW_ERROR: "보관된 원고 검토에 오류 기록이 남아 있습니다.",
  STORED_REVIEW_CONFIRMATION: "보관된 원고 검토의 사실 확인 요청을 점검해 주세요.",
  STORED_SEMANTIC_FINDINGS: "본문의 일관성과 근거 연결에 대한 추가 검토가 필요합니다.",
  INVALID_REFERENCE: "원고에 연결한 자료와 인용문을 다시 확인해 주세요.",
};

export function preparedExecutionDraftReasons(reasons: readonly string[]) {
  return [
    ...new Set(
      reasons.map((reason) =>
        Object.hasOwn(draftReasonLabels, reason)
          ? draftReasonLabels[reason]
          : "추가 검토가 필요합니다",
      ),
    ),
  ];
}

const issueLabels: Record<string, string> = {
  INVALID_INPUT: "선택 항목의 값·파일 정보를 다시 확인해 주세요.",
  PACKAGE_COMPANY_MISMATCH: "현재 기업과 다른 준비본입니다.",
  PACKAGE_METADATA_INCONSISTENT: "준비본 기록을 확인하지 못했습니다.",
  PACKAGE_ARCHIVE_UNVERIFIED: "보관 ZIP의 무결성을 확인하지 못했습니다.",
  PACKAGE_ARCHIVE_MISMATCH: "보관 ZIP의 식별값이 다릅니다.",
  PLAN_BINDING_MISMATCH: "준비본과 현재 원고 ID·버전이 다릅니다.",
  PLAN_CONTENT_MISMATCH: "준비본과 현재 원고 내용이 다릅니다.",
  SELECTION_EMPTY: "이번에 입력할 항목을 선택해 주세요.",
  SELECTION_LIMIT: "이번 실행 범위의 입력·첨부 한도를 초과했습니다.",
  TARGET_DUPLICATE: "같은 입력 항목이 중복 연결되었습니다.",
  TARGET_UNCONFIRMED: "이 항목의 연결 내용을 먼저 확인해 주세요.",
  TEXT_VALUE_INVALID: "입력값이나 글자 수 제한을 다시 확인해 주세요.",
  TEXT_CURRENT_MISMATCH: "선택 입력값과 현재 원문이 다릅니다.",
  PROFILE_VALUE_MISMATCH: "준비본과 현재 기업정보의 선택 값이 다릅니다.",
  PLAN_SECTION_AMBIGUOUS: "선택한 원고 항목이 없거나 중복되었습니다.",
  ATTACHMENT_SOURCE_DUPLICATE: "같은 첨부 항목에 같은 원본이 중복 연결되었습니다.",
  ATTACHMENT_TARGET_INVALID: "첨부 항목의 파일 선택 조건이 다릅니다.",
  ATTACHMENT_NOT_PACKAGED:
    "선택 원본이 준비본에 없습니다. 해당 원본을 포함한 준비본을 보관해 주세요.",
  ATTACHMENT_METADATA_MISMATCH: "선택 원본의 이름·형식·크기·변경시각이 다릅니다.",
  ATTACHMENT_CONTENT_MISMATCH: "선택 원본의 내용 식별값이 다릅니다.",
};

export function VentureinPreparedComparisonView({
  comparison,
  fieldLabel,
}: {
  comparison: VenturePreparedComparison;
  fieldLabel: (key: string) => string;
}) {
  const result = comparison.result;
  return (
    <div className="min-w-0 space-y-2 rounded-lg border p-3 text-sm leading-6">
      <p className="font-semibold">
        {result.matched ? "준비본과 이번 선택 항목 일치" : "준비본과 다른 항목 확인 필요"}
      </p>
      <p className="text-xs">
        기관 화면의 입력 상태나 최종 접수 결과를 확인한 것이 아닙니다. 다른 항목·파일을 자동으로
        추가하거나 바꾸지 않습니다.
      </p>
      {result.companyRevisionChanged && (
        <p className="text-xs">
          보관 이후 기업정보가 변경되었습니다. 이번 선택 범위만 대조한 결과입니다.
        </p>
      )}
      {result.issues.length > 0 && (
        <ul className="space-y-2">
          {result.issues.map((issue, index) => (
            <li key={index} className="break-words">
              {issue.fieldKey && (
                <span className="font-medium">{fieldLabel(issue.fieldKey)} · </span>
              )}
              {issueLabels[issue.code] ?? "연결 정보를 다시 확인해 주세요."}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VentureinPreparedBindingSummary({
  prepared,
  historical = false,
  recovery = false,
  required = false,
}: {
  prepared: VenturePreparedPackageBinding | undefined;
  historical?: boolean;
  recovery?: boolean;
  required?: boolean;
}) {
  if (prepared === undefined && !required)
    return historical || recovery ? (
      <p className="text-xs leading-6 text-muted-foreground">
        이전 실행에는 준비본 연결 기록이 없습니다. 기존 실행 범위를 유지하며 준비본을 새로 연결하지
        않습니다.
      </p>
    ) : null;
  const parsed = venturePreparedPackageBindingSchema.safeParse(prepared);
  if (!parsed.success)
    return (
      <Notice tone="warning">
        준비본 연결 기록을 확인하지 못했습니다. 연결된 것으로 표시하지 않습니다.
      </Notice>
    );
  const value = parsed.data;
  return (
    <div className="min-w-0 space-y-2 rounded-lg border p-3 text-sm leading-6">
      <p className="font-semibold">
        {historical ? "실행 당시 연결한 준비본" : "이번 승인에 고정한 준비본"}{" "}
        {value.binding.package.version} · 원고 {value.binding.plan.version}
      </p>
      <p className="text-xs">보관 시각: {formatDate(value.binding.package.createdAt)}</p>
      {recovery && (
        <p className="text-xs">
          준비본 연결은 원래 실행 전체 범위로 고정됩니다. 아래 보호 항목은 입력에서 제외하고, 새로
          승인한 빈 텍스트만 입력합니다.
        </p>
      )}
      {value.packageDraft && (
        <Notice tone="warning">
          보관 당시 확인이 남은 준비본입니다. 연결·전송 승인이 사실·증빙 검토 완료를 뜻하지
          않습니다.
        </Notice>
      )}
      <details className="text-xs">
        <summary className="min-h-11 cursor-pointer py-2">준비본·원고·ZIP 식별값 보기</summary>
        <dl className="space-y-2 break-all">
          <div>
            <dt>준비본 ID</dt>
            <dd>{value.binding.package.id}</dd>
          </div>
          <div>
            <dt>원고 내용 SHA256</dt>
            <dd>{value.binding.plan.contentSha256}</dd>
          </div>
          <div>
            <dt>보관 ZIP SHA256</dt>
            <dd>{value.binding.package.zipSha256}</dd>
          </div>
          <div>
            <dt>이번 선택 범위 식별값</dt>
            <dd>{value.digest}</dd>
          </div>
        </dl>
      </details>
      <p className="text-xs text-muted-foreground">
        준비본·선택 항목의 연결 기록이며 기관 저장·접수 완료를 뜻하지 않습니다.
      </p>
    </div>
  );
}
