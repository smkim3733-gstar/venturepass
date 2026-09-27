"use client";

import { useEffect, useRef, useState } from "react";
import { FileCheck, Send, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  VentureExecutionRecord,
  VentureRecoveryReview,
} from "@/lib/venturein-execution-schema";
import {
  ventureRecoverableCodes,
  ventureExecutionRecordSchema,
} from "@/lib/venturein-execution-schema";
import type { VentureResolvedText, VentureTextSource } from "@/lib/venturein-preflight";
import { formatDate, Notice } from "./shared";
import {
  validateRecoveryPreparedBinding,
  VentureinPreparedBindingSummary,
} from "./venturein-prepared-execution-ui";

const recoveryButtonClass =
  "h-auto min-h-11 min-w-0 max-w-full shrink whitespace-normal break-words py-2";

type RecoveryBinding = Pick<
  VentureRecoveryReview,
  | "workflowRevision"
  | "companyRevision"
  | "accountRevision"
  | "snapshotId"
  | "sessionStartedAt"
  | "priorExecutionId"
  | "destination"
  | "preparedPackage"
>;

export function ventureRecoveryBlockedReason(
  execution: VentureExecutionRecord | null,
  expected: {
    caseId: string;
    companyRevision: number;
    accountRevision: number;
    sessionStartedAt: string | null;
    snapshotId: string | null;
  },
  selectedFields: VentureResolvedText[],
) {
  if (!execution || execution.status !== "stopped")
    return "중단이 확인된 텍스트 전용 실행만 새로 검토할 수 있습니다.";
  const attempts = [...(execution.previousAttempts ?? []), execution];
  if (
    attempts.some(
      (attempt) => attempt.status === "running" || attempt.code === "INPUT_RESULT_UNKNOWN",
    )
  )
    return "결과가 미확인인 실행은 새 입력 대상으로 복구하지 않습니다. 공식 화면을 직접 확인하세요.";
  const manifest = execution.manifest;
  const recoverableCodes = new Set<string>(ventureRecoverableCodes);
  if (manifest?.version === 2 && !ventureExecutionRecordSchema.safeParse(execution).success)
    return "이전 준비본 연결 기록을 확인하지 못했습니다. 다른 준비본으로 바꾸어 복구하지 않습니다.";
  if (
    !manifest ||
    !execution.previousAttempts ||
    attempts.some(
      (attempt) =>
        !attempt.requestedFieldKeys ||
        !attempt.preservedFieldKeys ||
        !attempt.touchedFieldKeys ||
        attempt.priorExecutionId === undefined ||
        attempt.status !== "stopped" ||
        !attempt.finishedAt ||
        !attempt.code ||
        !recoverableCodes.has(attempt.code),
    )
  )
    return "정확한 대상·입력 시도 기록이 없는 이전 실행은 복구할 수 없습니다.";
  if (
    manifest.targets.some((target) => target.kind !== "text") ||
    attempts.some((attempt) => attempt.attachmentFieldKeys.length > 0)
  )
    return "첨부가 포함된 실행은 이 텍스트 전용 복구 경로에서 처리하지 않습니다.";
  if (
    manifest.caseId !== expected.caseId ||
    manifest.companyRevision !== expected.companyRevision ||
    manifest.accountRevision !== expected.accountRevision ||
    manifest.sessionStartedAt !== expected.sessionStartedAt ||
    manifest.snapshotId !== expected.snapshotId ||
    execution.snapshotId !== expected.snapshotId ||
    manifest.targets.length !== selectedFields.length ||
    new Set(manifest.targets.map((target) => target.fieldKey)).size !== selectedFields.length ||
    manifest.targets.some(
      (target) => !selectedFields.some((field) => field.fieldKey === target.fieldKey),
    )
  )
    return "실행 당시 기업·계정·세션·화면·연결 대상이 현재와 다릅니다. 이전 실행을 복구하지 않습니다.";
  if (execution.previousAttempts.length >= 9)
    return "추가 입력 시도 보관 한도에 도달했습니다. 기존 기록을 보존하고 공식 화면을 직접 확인해 주세요.";
  return "";
}

export function validateVentureRecoveryReview(
  review: VentureRecoveryReview,
  expected: RecoveryBinding,
  selectedFields: VentureResolvedText[],
  touchedFieldKeys: ReadonlySet<string>,
) {
  const fields = new Map(selectedFields.map((field) => [field.fieldKey, field]));
  const fail = () => {
    throw new Error(
      "부분 실행 검토안과 현재 연결이 일치하지 않습니다. 최신 상태를 확인한 뒤 다시 검토해 주세요.",
    );
  };
  if (
    !review ||
    review.scope !== "text-recovery" ||
    review.workflowRevision !== expected.workflowRevision ||
    review.companyRevision !== expected.companyRevision ||
    review.accountRevision !== expected.accountRevision ||
    review.snapshotId !== expected.snapshotId ||
    review.sessionStartedAt !== expected.sessionStartedAt ||
    review.priorExecutionId !== expected.priorExecutionId ||
    review.destination !== expected.destination ||
    !Number.isFinite(Date.parse(review.observedAt)) ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.now() ||
    typeof review.submissionReady !== "boolean" ||
    !Array.isArray(review.remainingIssues) ||
    !Array.isArray(review.fields) ||
    !Array.isArray(review.protectedFields) ||
    review.fields.length !== review.fieldCount ||
    review.fieldCount < 1 ||
    selectedFields.length !== fields.size ||
    review.fields.length + review.protectedFields.length !== fields.size
  )
    return fail();
  const allKeys = [...review.fields, ...review.protectedFields].map((field) => field?.fieldKey);
  if (new Set(allKeys).size !== fields.size || allKeys.some((key) => !fields.has(key)))
    return fail();
  for (const field of review.fields) {
    const original = fields.get(field.fieldKey);
    if (
      !original ||
      touchedFieldKeys.has(field.fieldKey) ||
      !field.confirmed ||
      field.value !== original.value ||
      field.label !== original.label ||
      JSON.stringify(field.source) !== JSON.stringify(original.source) ||
      JSON.stringify(field.financialContext) !== JSON.stringify(original.financialContext) ||
      field.characterCount !== original.characterCount ||
      field.maxLength !== original.maxLength ||
      field.required !== original.required
    )
      return fail();
  }
  if (review.protectedFields.some((field) => field.label !== fields.get(field.fieldKey)?.label))
    return fail();
  let destination: URL;
  try {
    destination = new URL(review.destination);
  } catch {
    return fail();
  }
  if (
    destination.origin !== "https://www.smes.go.kr" ||
    destination.username ||
    destination.password
  )
    return fail();
  try {
    validateRecoveryPreparedBinding(review.preparedPackage, expected.preparedPackage);
  } catch {
    return fail();
  }
  return review;
}

type ApprovalProps = {
  review: VentureRecoveryReview;
  approved: boolean;
  busy: boolean;
  describeSource: (source: VentureTextSource) => string;
  onApprovalChange: (value: boolean) => void;
  onExecute: () => void;
};

export function VentureinRecoveryApproval({
  review,
  approved,
  busy,
  describeSource,
  onApprovalChange,
  onExecute,
}: ApprovalProps) {
  return (
    <section
      aria-label="미시도 빈 텍스트 새 전송 승인"
      className="min-w-0 space-y-4 rounded-xl border p-4"
    >
      <h5 className="font-semibold">새로 입력할 미시도 빈 텍스트 {review.fieldCount}개</h5>
      <Notice>
        과거 승인을 복원하지 않습니다. 아래 빈 텍스트 항목에 대한 별도의 새 전송 승인입니다.
        일치하는 항목은 보호하며 다시 입력하지 않습니다. 전체 필수 항목이나 약관·동의, 최종 제출이
        완료됐다는 뜻이 아닙니다.
      </Notice>
      <VentureinPreparedBindingSummary prepared={review.preparedPackage} recovery />
      <dl className="space-y-2 text-sm leading-6">
        <div>
          <dt className="text-muted-foreground">신청 기업</dt>
          <dd className="font-semibold">{review.companyName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">전송 대상 공식 화면</dt>
          <dd className="break-all">{review.destination}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">현재 상태 관측 시각</dt>
          <dd>{formatDate(review.observedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">새 승인 유효 시각 · 2분 단회</dt>
          <dd>{formatDate(review.expiresAt)}</dd>
        </div>
      </dl>
      <div className="space-y-2 rounded-lg border p-3 text-sm leading-6">
        <h6 className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-4" />
          일치 항목 보호 · {review.protectedFields.length}개
        </h6>
        {review.protectedFields.length ? (
          <ul className="space-y-2">
            {review.protectedFields.map((field) => (
              <li key={field.fieldKey} className="flex flex-wrap items-center gap-2">
                <span className="break-words">{field.label}</span>
                <Badge variant="outline">현재 값 일치 · 입력 제외</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            이번 검토에서 보호할 일치 항목은 없습니다.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          실행 직전과 진행 중에도 일치 상태를 확인하며, 달라지면 멈춥니다.
        </p>
      </div>
      <div className="space-y-3">
        {review.fields.map((field) => (
          <article
            key={field.fieldKey}
            className="space-y-2 rounded-lg bg-muted/30 p-3 text-sm leading-6"
          >
            <h6 className="break-words font-semibold">{field.label}</h6>
            <Badge variant="outline">미시도 · 현재 빈칸</Badge>
            <p className="text-xs text-muted-foreground">
              연결 근거: {describeSource(field.source)}
            </p>
            <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3">
              {field.value}
            </p>
            <p className="text-xs text-muted-foreground">
              {field.characterCount.toLocaleString()}자
              {field.maxLength !== null ? ` / 최대 ${field.maxLength.toLocaleString()}자` : ""}
            </p>
            {field.financialContext && (
              <div className="space-y-2 border-t pt-2 text-xs">
                <p className="font-medium">입력 단위: {field.financialContext.unit}</p>
                <p>기업정보의 재무 근거 메모:</p>
                <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                  {field.financialContext.evidenceNote || "저장된 근거 메모가 없습니다."}
                </p>
              </div>
            )}
          </article>
        ))}
      </div>
      <div className="space-y-2 text-sm leading-6">
        <p className="font-semibold">
          전체 제출 전 점검:{" "}
          {review.submissionReady ? "현재 보고서의 보완 항목 없음" : "아직 보완할 항목이 있습니다"}
        </p>
        {review.remainingIssues.length > 0 && (
          <ul className="space-y-2">
            {review.remainingIssues.map((issue, index) => (
              <li key={`${issue.code}:${index}`} className="rounded-lg bg-muted/30 p-3">
                <span className="mr-2 text-xs font-semibold">
                  {issue.severity === "error" ? "보완 필요" : "확인 필요"}
                </span>
                {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Notice tone="warning">
        위 미시도 빈 텍스트만 한 번 입력합니다. 첨부·저장·동의·제출 버튼은 실행하지 않습니다.
        입력값은 사이트 처리 방식에 따라 즉시 전송·저장될 수 있습니다. 결과가 불확실하면 자동으로
        다시 실행하지 않습니다.
      </Notice>
      <label className="flex items-start gap-2 text-sm leading-6">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-primary"
          checked={approved}
          disabled={busy}
          onChange={(event) => onApprovalChange(event.target.checked)}
        />
        <span>
          위 미시도 빈 텍스트를 www.smes.go.kr에 전송해 한 번 입력하는 데 새로 동의합니다.
        </span>
      </label>
      <Button
        className={recoveryButtonClass}
        type="button"
        disabled={!approved || busy}
        onClick={onExecute}
      >
        <Send />
        새로 승인한 빈 텍스트 1회 입력
      </Button>
    </section>
  );
}

export function VentureinRecoveryPanel({
  prepare,
  execute,
  blockedReason,
  busy,
  describeSource,
}: {
  prepare: () => Promise<VentureRecoveryReview | null>;
  execute: (review: VentureRecoveryReview) => Promise<void>;
  blockedReason: string;
  busy: boolean;
  describeSource: ApprovalProps["describeSource"];
}) {
  const [review, setReview] = useState<VentureRecoveryReview | null>(null);
  const [approved, setApproved] = useState(false);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!review) return;
    const timer = window.setTimeout(
      () => {
        setReview(null);
        setApproved(false);
        setExpired(true);
      },
      Math.max(0, Date.parse(review.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [review]);
  async function prepareReview() {
    if (busy || blockedReason || inFlight.current) return;
    inFlight.current = true;
    setReview(null);
    setApproved(false);
    setExpired(false);
    try {
      const value = await prepare();
      if (mounted.current && value) setReview(value);
    } finally {
      inFlight.current = false;
    }
  }
  async function executeOnce() {
    if (!review || !approved || busy || blockedReason || inFlight.current) return;
    if (Date.parse(review.expiresAt) <= Date.now()) {
      setReview(null);
      setApproved(false);
      setExpired(true);
      return;
    }
    const selected = review;
    inFlight.current = true;
    setReview(null);
    setApproved(false);
    try {
      await execute(selected);
    } finally {
      inFlight.current = false;
    }
  }
  return (
    <section
      aria-label="텍스트 부분 실행 재검토"
      className="min-w-0 space-y-3 rounded-xl border p-4"
    >
      <h4 className="text-sm font-semibold">텍스트 부분 실행 재검토</h4>
      <p className="text-xs leading-6 text-muted-foreground">
        정확한 대상·시도 기록이 있는 텍스트 전용 중단 실행만 새로 검토합니다. 현재 일치하는 항목은
        보호하고, 한 번도 시도하지 않은 빈 항목만 별도 승인 대상으로 제시합니다. 검토 준비와 화면
        대조만으로 입력하지 않습니다.
      </p>
      <Button
        className={recoveryButtonClass}
        type="button"
        variant="outline"
        disabled={busy || !!blockedReason}
        onClick={prepareReview}
      >
        <FileCheck />
        {review ? "미시도 빈 텍스트 다시 검토" : "미시도 빈 텍스트 새 검토"}
      </Button>
      {blockedReason && <p className="text-xs leading-6 text-muted-foreground">{blockedReason}</p>}
      {expired && (
        <Notice tone="warning">
          새 검토안이 만료되었습니다. 현재 상태를 다시 검토하고 별도로 승인해 주세요.
        </Notice>
      )}
      {review && !blockedReason && (
        <VentureinRecoveryApproval
          review={review}
          approved={approved}
          busy={busy}
          describeSource={describeSource}
          onApprovalChange={setApproved}
          onExecute={executeOnce}
        />
      )}
    </section>
  );
}
