"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileCheck, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  VentureExecutionReview,
  VentureInputComparison,
  VentureInputComparisonField,
  VentureRecoveryReview,
} from "@/lib/venturein-execution-schema";
import type { VentureTextSource } from "@/lib/venturein-preflight";
import type { VentureWorkflowStatus } from "@/lib/venturein-workflow";
import { Loading, Notice, formatDate, jsonBody, studioFetch } from "./shared";
import {
  validateVentureInputComparison,
  VentureinComparisonPanel,
} from "./venturein-comparison-panel";
import {
  validateVentureRecoveryReview,
  ventureRecoveryBlockedReason,
  VentureinRecoveryPanel,
} from "./venturein-recovery-panel";

type Props = {
  endpoint: string;
  workflow: VentureWorkflowStatus;
  companyRevision: number;
  accountRevision: number;
  sessionStartedAt: string | null;
  bindingKey: string;
  blockedReason: string;
  canRefresh: boolean;
  describeSource: (source: VentureTextSource) => string;
  onBusyChange: (busy: boolean) => void;
  onWorkflowChange: (workflow: VentureWorkflowStatus) => void;
};

function fileSize(bytes: number) {
  return `${Math.ceil(bytes / 1024).toLocaleString()}KB (${bytes.toLocaleString()}바이트)`;
}

export function VentureinApprovalScope({
  review,
}: {
  review: Pick<VentureExecutionReview, "scope" | "submissionReady" | "remainingIssues">;
}) {
  return (
    <div className="space-y-3">
      <Notice>
        이번에 선택한 항목만 입력·첨부합니다. 이 승인은 전체 필수 항목 확인이나 약관·동의 처리, 최종
        제출 완료를 뜻하지 않습니다.
      </Notice>
      <div className="space-y-2 rounded-lg border p-3 text-sm leading-6">
        <p className="font-semibold">
          전체 제출 전 점검:{" "}
          {review.submissionReady ? "현재 보고서의 보완 항목 없음" : "아직 보완할 항목이 있습니다"}
        </p>
        {review.remainingIssues.length > 0 && (
          <div>
            <p className="font-medium">전체 제출 전 남은 확인사항</p>
            <ul className="mt-2 space-y-2">
              {review.remainingIssues.map((issue, index) => (
                <li key={`${issue.code}:${index}`} className="rounded-md bg-muted/30 p-2">
                  <span className="mr-2 text-xs font-semibold">
                    {issue.severity === "error" ? "보완 필요" : "확인 필요"}
                  </span>
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalReview({
  prepare,
  execute,
  blockedReason,
  busy,
  describeSource,
}: {
  prepare: () => Promise<VentureExecutionReview | null>;
  execute: (review: VentureExecutionReview) => Promise<void>;
  blockedReason: string;
  busy: boolean;
  describeSource: Props["describeSource"];
}) {
  const [review, setReview] = useState<VentureExecutionReview | null>(null);
  const [approved, setApproved] = useState(false);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(false);

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
    setReview(null);
    setApproved(false);
    setExpired(false);
    const next = await prepare();
    if (mounted.current && next) setReview(next);
  }

  async function executeOnce() {
    if (!review || !approved || busy || blockedReason) return;
    if (Date.parse(review.expiresAt) <= Date.now()) {
      setReview(null);
      setApproved(false);
      setExpired(true);
      return;
    }
    const approvedReview = review;
    setReview(null);
    setApproved(false);
    await execute(approvedReview);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !!blockedReason}
          onClick={prepareReview}
        >
          <FileCheck />
          {review ? "입력·첨부 검토안 다시 준비" : "입력·첨부 검토안 준비"}
        </Button>
        <p className="text-xs leading-6 text-muted-foreground">
          검토안을 준비하는 동안 공식 사이트에 값을 입력하거나 파일을 첨부하지 않습니다.
        </p>
      </div>
      {blockedReason && <p className="text-sm leading-6 text-muted-foreground">{blockedReason}</p>}
      {expired && (
        <Notice tone="warning">검토안이 만료되었습니다. 최신 값으로 다시 준비해 주세요.</Notice>
      )}
      {review && !blockedReason && (
        <section aria-label="공식 화면 입력·첨부 승인" className="space-y-4 rounded-xl border p-4">
          <h4 className="font-semibold">
            이번에 전송할 텍스트 {review.fieldCount}개 · 파일 {review.attachmentCount}개
          </h4>
          <VentureinApprovalScope review={review} />
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
              <dt className="text-muted-foreground">승인 유효 시각</dt>
              <dd>{formatDate(review.expiresAt)}</dd>
            </div>
            {review.attachmentCount > 0 && (
              <div>
                <dt className="text-muted-foreground">첨부파일 합계</dt>
                <dd>{fileSize(review.totalAttachmentBytes)}</dd>
              </div>
            )}
          </dl>
          <div className="space-y-3">
            {review.fields.map((field) => (
              <article
                key={field.fieldKey}
                className="space-y-2 rounded-lg bg-muted/30 p-3 text-sm leading-6"
              >
                <h5 className="break-words font-semibold">{field.label}</h5>
                <p className="text-xs text-muted-foreground">
                  연결 근거: {describeSource(field.source)}
                </p>
                <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3">
                  {field.value || "빈 문자열"}
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
            {review.attachments.map((file) => (
              <article
                key={`${file.fieldKey}:${file.sourceId}`}
                className="space-y-2 rounded-lg bg-muted/30 p-3 text-sm leading-6"
              >
                <h5 className="break-words font-semibold">첨부 항목: {file.label}</h5>
                <p className="break-all font-medium">{file.originalName}</p>
                <p className="text-xs text-muted-foreground">{fileSize(file.sizeBytes)}</p>
                <p className="break-all text-xs text-muted-foreground">
                  파일 형식(MIME): {file.mimeType || "기록 없음"}
                </p>
                <p className="text-xs">
                  {file.confirmed
                    ? "연결 단계에서 기업·내용·제출 용도를 확인한 파일입니다."
                    : "기업·내용·제출 용도 확인이 필요합니다."}
                </p>
                <details className="border-t pt-2 text-xs">
                  <summary className="cursor-pointer">원본 파일 식별값(SHA256) 보기</summary>
                  <p className="mt-2 break-all font-mono">{file.sha256}</p>
                </details>
              </article>
            ))}
          </div>
          <Notice tone="warning">
            승인하면 위 텍스트와 파일을 공식 사이트의 빈 입력란·첨부란에 한 번 연결합니다. 기존
            값이나 파일이 있으면 멈춥니다. 저장·동의·제출 버튼은 누르지 않습니다. 입력값과 파일은
            사이트 처리 방식에 따라 즉시 전송·저장될 수 있습니다. 아래 전송 승인은 연결 단계의 개별
            용도 확인과 별도입니다.
          </Notice>
          <label className="flex items-start gap-2 text-sm leading-6">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-primary"
              checked={approved}
              disabled={busy}
              onChange={(event) => setApproved(event.target.checked)}
            />
            <span>위 텍스트와 파일을 www.smes.go.kr에 전송해 입력·첨부하는 데 동의합니다.</span>
          </label>
          <Button type="button" disabled={!approved || busy} onClick={executeOnce}>
            <Send />
            승인한 입력·첨부 1회 실행
          </Button>
        </section>
      )}
    </div>
  );
}

export function VentureinExecutionPanel({
  endpoint,
  workflow,
  companyRevision,
  accountRevision,
  sessionStartedAt,
  bindingKey,
  blockedReason,
  canRefresh,
  describeSource,
  onBusyChange,
  onWorkflowChange,
}: Props) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [executionBeforeRequest, setExecutionBeforeRequest] = useState<string | null>(null);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const context = useRef(bindingKey);
  const execution = workflow.execution;
  const attachmentKeys = new Set(execution?.attachmentFieldKeys ?? []);
  const completedAttachments =
    execution?.completedFieldKeys.filter((key) => attachmentKeys.has(key)) ?? [];
  const completedText =
    execution?.completedFieldKeys.filter((key) => !attachmentKeys.has(key)) ?? [];
  const outcomeUnknown = execution?.code === "INPUT_RESULT_UNKNOWN";
  const sameSnapshot = Boolean(execution && execution.snapshotId === workflow.snapshot?.screen.id);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    context.current = bindingKey;
  }, [bindingKey]);

  function begin(message: string) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setError("");
    setBusy(message);
    onBusyChange(true);
    return true;
  }
  function finish() {
    inFlight.current = false;
    if (mounted.current) {
      setBusy("");
      onBusyChange(false);
    }
  }
  function current() {
    return mounted.current && context.current === bindingKey;
  }
  const unavailable = uncertain
    ? "앞선 입력·첨부 결과를 확인하지 못했습니다. 저장된 실행 결과와 공식 화면을 확인하세요."
    : sameSnapshot
      ? outcomeUnknown
        ? "이 화면의 입력·첨부 결과가 미확인 상태입니다. 공식 화면을 직접 확인한 뒤 화면을 다시 읽고 연결해 주세요."
        : execution?.status === "running"
          ? "실행 결과 확인이 필요합니다. 입력 완료로 판단하지 말고 저장된 실행 결과를 확인하세요."
          : "이 화면 기록으로 이미 입력·첨부를 시도했습니다. 공식 화면을 확인한 뒤 다시 읽고 새 연결을 검토해 주세요."
      : blockedReason ||
        (!workflow.report.inputReadiness
          ? "선택 입력 준비 정보가 없습니다. 점검 결과 새로고침으로 최신 상태를 확인해 주세요."
          : workflow.report.inputReadiness.ready !== true
            ? "선택 항목 입력 전 보완사항을 먼저 해결해 주세요."
            : "");

  const comparisonUnavailable =
    blockedReason ||
    (!workflow.snapshot || !workflow.draft || !sessionStartedAt
      ? "현재 화면을 읽고 항목 연결을 저장한 뒤 대조할 수 있습니다."
      : !workflow.report.inputReadiness
        ? "선택 입력 준비 정보가 없습니다. 점검 결과 새로고침으로 최신 상태를 확인해 주세요."
        : workflow.report.inputReadiness.ready !== true
          ? "선택 항목 입력 전 보완사항을 해결한 뒤 대조할 수 있습니다."
          : "");

  const recoveryUnavailable = uncertain
    ? "앞선 입력·첨부 결과가 미확인 상태입니다. 저장된 실행 결과와 공식 화면을 확인하세요."
    : comparisonUnavailable ||
      ventureRecoveryBlockedReason(
        execution,
        {
          caseId: workflow.report.caseId,
          companyRevision,
          accountRevision,
          sessionStartedAt,
          snapshotId: workflow.snapshot?.screen.id ?? null,
        },
        workflow.report.textFields,
      );

  async function prepareRecovery() {
    if (
      recoveryUnavailable ||
      !execution ||
      !workflow.snapshot ||
      !sessionStartedAt ||
      !begin("중단 기록과 현재 화면을 읽고 미시도 빈 텍스트를 새로 검토하고 있습니다")
    )
      return null;
    setReviewVersion((version) => version + 1);
    try {
      const { review } = await studioFetch<{ review: VentureRecoveryReview }>(
        `${endpoint}/execution`,
        {
          method: "POST",
          ...jsonBody({
            action: "prepare-recovery",
            revision: workflow.revision,
            companyRevision,
            accountRevision,
          }),
        },
      );
      if (!current()) return null;
      const touched = new Set(
        [...(execution.previousAttempts ?? []), execution].flatMap((attempt) => [
          ...(attempt.touchedFieldKeys ?? []),
          ...attempt.completedFieldKeys,
        ]),
      );
      return validateVentureRecoveryReview(
        review,
        {
          workflowRevision: workflow.revision,
          companyRevision,
          accountRevision,
          snapshotId: workflow.snapshot.screen.id,
          sessionStartedAt,
          priorExecutionId: execution.id,
          destination: workflow.snapshot.screen.url,
        },
        workflow.report.textFields,
        touched,
      );
    } catch (caught) {
      if (current())
        setError(
          caught instanceof Error ? caught.message : "부분 실행 검토안을 준비하지 못했습니다.",
        );
      return null;
    } finally {
      finish();
    }
  }

  async function executeRecovery(review: VentureRecoveryReview) {
    if (recoveryUnavailable || !begin("새로 승인한 미시도 빈 텍스트만 한 번 입력하고 있습니다"))
      return;
    setExecutionBeforeRequest(execution?.id ?? null);
    try {
      const result = await studioFetch<{ workflow: VentureWorkflowStatus }>(
        `${endpoint}/execution`,
        {
          method: "POST",
          ...jsonBody({ action: "execute-recovery", token: review.token, approved: true }),
        },
      );
      if (!current()) {
        if (mounted.current) setUncertain(true);
        return;
      }
      if (
        !result.workflow?.execution ||
        result.workflow.execution.id === review.priorExecutionId ||
        result.workflow.execution.priorExecutionId !== review.priorExecutionId
      )
        throw new Error("새 입력 실행 결과를 확인하지 못했습니다.");
      setUncertain(false);
      onWorkflowChange(result.workflow);
    } catch (caught) {
      if (mounted.current) {
        setUncertain(true);
        setError(
          caught instanceof Error ? caught.message : "새 입력 실행 응답을 확인하지 못했습니다.",
        );
      }
    } finally {
      finish();
    }
  }

  async function compare() {
    if (
      comparisonUnavailable ||
      !workflow.snapshot ||
      !sessionStartedAt ||
      !begin("현재 연결안과 공식 화면의 값·파일 선택 상태를 읽어 대조하고 있습니다")
    )
      return null;
    setReviewVersion((version) => version + 1);
    setRecoveryVersion((version) => version + 1);
    try {
      const { comparison } = await studioFetch<{ comparison: VentureInputComparison }>(
        `${endpoint}/execution`,
        {
          method: "POST",
          ...jsonBody({
            action: "compare",
            revision: workflow.revision,
            companyRevision,
            accountRevision,
          }),
        },
      );
      if (!current()) return null;
      const fields = new Map<string, VentureInputComparisonField["kind"]>([
        ...workflow.report.textFields.map((field) => [field.fieldKey, "text"] as const),
        ...workflow.report.attachments.map((field) => [field.fieldKey, "file"] as const),
      ]);
      return validateVentureInputComparison(
        comparison,
        {
          workflowRevision: workflow.revision,
          companyRevision,
          accountRevision,
          snapshotId: workflow.snapshot.screen.id,
          sessionStartedAt,
        },
        fields,
      );
    } catch (caught) {
      if (current())
        setError(
          caught instanceof Error ? caught.message : "현재 화면 대조 결과를 확인하지 못했습니다.",
        );
      return null;
    } finally {
      finish();
    }
  }

  async function prepare() {
    if (unavailable || !begin("입력·첨부 전 기업·항목·원본 파일을 확인하고 있습니다")) return null;
    setRecoveryVersion((version) => version + 1);
    try {
      const { review } = await studioFetch<{ review: VentureExecutionReview }>(
        `${endpoint}/execution`,
        {
          method: "POST",
          ...jsonBody({
            action: "prepare",
            revision: workflow.revision,
            accountRevision,
            companyRevision,
          }),
        },
      );
      if (!current()) return null;
      const destination = new URL(review.destination);
      if (
        review.scope !== "selected-fields" ||
        typeof review.submissionReady !== "boolean" ||
        !Array.isArray(review.remainingIssues) ||
        review.workflowRevision !== workflow.revision ||
        review.companyRevision !== companyRevision ||
        review.accountRevision !== accountRevision ||
        review.snapshotId !== workflow.snapshot?.screen.id ||
        review.sessionStartedAt !== sessionStartedAt ||
        review.fields.length !== review.fieldCount ||
        review.attachments.length !== review.attachmentCount ||
        (review.fieldCount === 0 && review.attachmentCount === 0) ||
        !Number.isSafeInteger(review.totalAttachmentBytes) ||
        review.totalAttachmentBytes < 0 ||
        review.totalAttachmentBytes !==
          review.attachments.reduce((sum, file) => sum + file.sizeBytes, 0) ||
        review.attachments.some(
          (file) => !file.confirmed || !/^[a-f0-9]{64}$/i.test(file.sha256),
        ) ||
        !Number.isFinite(Date.parse(review.expiresAt)) ||
        Date.parse(review.expiresAt) <= Date.now() ||
        destination.origin !== "https://www.smes.go.kr" ||
        destination.username ||
        destination.password
      )
        throw new Error("검토안과 현재 연결이 일치하지 않습니다. 최신 점검 결과를 확인해 주세요.");
      return review;
    } catch (caught) {
      if (current())
        setError(caught instanceof Error ? caught.message : "입력 검토안을 준비하지 못했습니다.");
      return null;
    } finally {
      finish();
    }
  }

  async function execute(review: VentureExecutionReview) {
    if (unavailable || !begin("승인한 입력·첨부를 한 번 실행하고 결과를 확인하고 있습니다")) return;
    setExecutionBeforeRequest(execution?.id ?? null);
    try {
      const result = await studioFetch<{ workflow: VentureWorkflowStatus }>(
        `${endpoint}/execution`,
        {
          method: "POST",
          ...jsonBody({ action: "execute", token: review.token, approved: true }),
        },
      );
      if (!current()) {
        if (mounted.current) setUncertain(true);
        return;
      }
      if (!result.workflow?.execution) throw new Error("입력 실행 결과를 확인하지 못했습니다.");
      setUncertain(false);
      onWorkflowChange(result.workflow);
    } catch (caught) {
      if (mounted.current) {
        setUncertain(true);
        setError(
          caught instanceof Error ? caught.message : "입력 실행 응답을 확인하지 못했습니다.",
        );
      }
    } finally {
      finish();
    }
  }

  async function checkResult() {
    if (!canRefresh || !begin("저장된 실행 결과를 불러오고 있습니다")) return;
    try {
      const value = await studioFetch<VentureWorkflowStatus>(endpoint);
      if (!current()) return;
      if (value.execution && value.execution.id !== executionBeforeRequest) setUncertain(false);
      onWorkflowChange(value);
    } catch (caught) {
      if (current())
        setError(caught instanceof Error ? caught.message : "실행 결과를 불러오지 못했습니다.");
    } finally {
      finish();
    }
  }

  function fieldLabel(key: string) {
    if (execution?.snapshotId !== workflow.snapshot?.screen.id) return key;
    const field = workflow.snapshot?.screen.fields.find((item) => item.key === key);
    return field?.labels.join(" · ") || field?.name || field?.id || key;
  }

  return (
    <section aria-label="승인 후 공식 화면 입력·첨부" className="space-y-4 border-t pt-4">
      <h4 className="font-semibold">검토 후 공식 화면에 입력·첨부</h4>
      <p className="text-xs leading-6 text-muted-foreground">
        선택 항목 검토안 준비 → 전송 승인 → 입력·첨부 1회 실행 순서로 진행합니다. 실행 직전 공식
        화면과 로그인 상태, 승인한 원본 파일을 다시 확인합니다. 전체 제출 준비와 동의 사항은 별도로
        확인해야 합니다.
      </p>
      {busy && <Loading text={busy} />}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm leading-6 text-destructive"
        >
          {error}
        </div>
      )}
      {(uncertain || outcomeUnknown) && (
        <Notice tone="warning">
          입력·첨부 결과가 미확인 상태입니다. 일부 또는 모든 값·파일이 이미 전송됐을 수 있습니다.
          확인된 항목이 0개여도 실제로 전송되지 않았다는 뜻은 아닙니다. 자동으로 다시 실행하지
          않습니다. 저장된 실행 결과를 조회하고 공식 화면을 직접 확인하세요.
        </Notice>
      )}
      {execution && (
        <div role="status" className="space-y-2 rounded-xl border p-4 text-sm leading-6">
          <p className="text-xs text-muted-foreground">
            {uncertain && execution.id === executionBeforeRequest
              ? "이전 실행 기록 · 이번 요청 결과는 미확인"
              : "최근 저장된 실행 기록"}
          </p>
          <p className="flex items-center gap-2 font-semibold">
            {execution.status === "completed" && !outcomeUnknown && (
              <CheckCircle2 className="size-4" />
            )}
            {outcomeUnknown
              ? "입력·첨부 결과 미확인"
              : execution.status === "completed"
                ? "공식 화면 입력·첨부 상태 확인 완료"
                : execution.status === "stopped"
                  ? "입력·첨부 중단"
                  : "실행 결과 확인 필요"}
          </p>
          <p>
            확인된 항목: 텍스트 {completedText.length}개 · 첨부 {completedAttachments.length}개.
            시작: {formatDate(execution.startedAt)}
            {execution.finishedAt ? ` · 종료: ${formatDate(execution.finishedAt)}` : ""}
          </p>
          {execution.status === "running" && (
            <p>완료 기록이 아직 없습니다. 입력 완료로 판단하지 말고 실행 결과를 확인해 주세요.</p>
          )}
          {execution.completedFieldKeys.length > 0 && (
            <details>
              <summary className="cursor-pointer">확인된 입력·첨부 항목 보기</summary>
              <ul className="mt-2 list-inside list-disc break-words">
                {execution.completedFieldKeys.map((key) => (
                  <li key={key}>
                    {attachmentKeys.has(key) ? "첨부" : "텍스트"} · {fieldLabel(key)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!execution.preservedFieldKeys?.length && (
            <details>
              <summary className="cursor-pointer">
                새 승인에서 입력 제외한 보호 대상 · {execution.preservedFieldKeys.length}개
              </summary>
              <ul className="mt-2 list-inside list-disc break-words">
                {execution.preservedFieldKeys.map((key) => (
                  <li key={key}>{fieldLabel(key)} · 입력 제외 대상으로 승인됨</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                이 목록만으로 현재 값이 계속 일치한다고 판단하지 않습니다. 중단·미확인 결과는 공식
                화면에서 확인하세요.
              </p>
            </details>
          )}
          {execution.attemptedFieldKey && execution.status !== "completed" && (
            <p className="break-words">
              마지막 실행 시도 항목:{" "}
              {attachmentKeys.has(execution.attemptedFieldKey) ? "첨부" : "텍스트"} ·{" "}
              {fieldLabel(execution.attemptedFieldKey)}. 전송됐을 수 있으므로 공식 화면에서
              확인하세요.
            </p>
          )}
          {execution.code && (
            <p className="break-all text-xs text-muted-foreground">중단 코드: {execution.code}</p>
          )}
          <p className="text-xs text-muted-foreground">
            입력·첨부 시도와 화면 확인 상태의 기록입니다. 기관의 저장·접수 완료를 의미하지 않습니다.
            저장·동의·제출 버튼은 실행하지 않았습니다.
          </p>
        </div>
      )}
      {(execution || uncertain) && (
        <Button
          type="button"
          variant="outline"
          disabled={!!busy || !canRefresh}
          onClick={checkResult}
        >
          <RefreshCw />
          저장된 실행 결과 확인
        </Button>
      )}
      <VentureinComparisonPanel
        key={bindingKey}
        compare={compare}
        blockedReason={comparisonUnavailable}
        busy={!!busy}
        fieldLabel={(key) =>
          workflow.snapshot?.screen.fields.find((field) => field.key === key)?.labels.join(" · ") ||
          key
        }
      />
      {(execution || uncertain) && (
        <VentureinRecoveryPanel
          key={`${bindingKey}:${recoveryVersion}`}
          prepare={prepareRecovery}
          execute={executeRecovery}
          blockedReason={recoveryUnavailable}
          busy={!!busy}
          describeSource={describeSource}
        />
      )}
      <ApprovalReview
        key={`${bindingKey}:${reviewVersion}`}
        prepare={prepare}
        execute={execute}
        blockedReason={unavailable}
        busy={!!busy}
        describeSource={describeSource}
      />
    </section>
  );
}
