"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { BusinessPlan, SourceDocument, StudioCase } from "@/lib/studio-schema";
import {
  isApplicationSubmission,
  type ApplicationSubmission,
} from "@/lib/studio-application-types";
import {
  visitAnswerContext,
  visitRespondentLabels,
  type VisitAnswer,
} from "@/lib/studio-visit-answer-types";
import {
  VISIT_PACKAGE_DOWNLOAD_NAME,
  visitPackageLimits,
  visitPackageRequestSchema,
} from "@/lib/studio-visit-package-types";
import { readPackageDownload } from "./package-panel";
import { Notice, formatDate, jsonBody, selectClass } from "./shared";

type Mode = "draft" | "recorded-submission";
export type VisitPackageSelection = {
  mode: Mode | "";
  basisId: string;
  answerVersionIds: string[];
  sourceIds: string[];
};
export const emptyVisitPackageSelection = (): VisitPackageSelection => ({
  mode: "",
  basisId: "",
  answerVersionIds: [],
  sourceIds: [],
});
export function changeVisitPackageBasis(mode: Mode | "", basisId = ""): VisitPackageSelection {
  return { mode, basisId, answerVersionIds: [], sourceIds: [] };
}
export type VisitPackageBasis = {
  mode: Mode;
  plan: BusinessPlan;
  submission: ApplicationSubmission | null;
};
export function resolveVisitPackageBasis(
  company: StudioCase,
  selection: Pick<VisitPackageSelection, "mode" | "basisId">,
): VisitPackageBasis | null {
  if (!selection.mode || !selection.basisId) return null;
  let submission: ApplicationSubmission | null = null;
  if (selection.mode === "recorded-submission") {
    const matches = company.applicationEvents
      .filter(isApplicationSubmission)
      .filter((record) => record.id === selection.basisId);
    if (matches.length !== 1) return null;
    submission = matches[0];
    if (
      submission.companySnapshot.caseId !== company.id ||
      company.applications.filter((cycle) => cycle.id === submission!.applicationId).length !== 1
    )
      return null;
  }
  const plans = company.plans.filter(
    (plan) => plan.id === (submission?.plan.id ?? selection.basisId),
  );
  if (plans.length !== 1 || (submission && plans[0].version !== submission.plan.version))
    return null;
  return { mode: selection.mode, plan: plans[0], submission };
}

export function visitPackageAnswerEligible(
  company: StudioCase,
  basis: VisitPackageBasis,
  answer: VisitAnswer,
): boolean {
  const question = answer.questionSnapshot;
  return (
    company.visitAnswers.filter((record) => record.id === answer.id).length === 1 &&
    answer.planId === basis.plan.id &&
    question.planId === basis.plan.id &&
    question.planVersion === basis.plan.version &&
    answer.questionIndex === question.questionIndex &&
    answer.questionText === question.questionText &&
    basis.plan.content.interviewQuestions[answer.questionIndex] === answer.questionText &&
    (answer.submissionRecordId === null
      ? answer.submissionSnapshot === null
      : basis.mode === "recorded-submission" &&
        answer.submissionRecordId === basis.submission?.id &&
        answer.submissionSnapshot?.id === basis.submission.id)
  );
}
export function selectedVisitPackageAnswers(
  company: StudioCase,
  basis: VisitPackageBasis,
  ids: string[],
): VisitAnswer[] | null {
  if (ids.length > visitPackageLimits.answers || new Set(ids).size !== ids.length) return null;
  const records: VisitAnswer[] = [];
  for (const id of ids) {
    const matches = company.visitAnswers.filter((record) => record.id === id);
    if (
      matches.length !== 1 ||
      !visitPackageAnswerEligible(company, basis, matches[0]) ||
      records.some((record) => record.answerId === matches[0].answerId)
    )
      return null;
    records.push(matches[0]);
  }
  return records;
}
export type VisitPackageSource = { source: SourceDocument; historical: boolean };
export function visitPackageSources(
  company: StudioCase,
  basis: VisitPackageBasis,
  answers: VisitAnswer[],
): VisitPackageSource[] {
  const linked = new Set(
    basis.plan.content.sections.flatMap((section) =>
      section.evidence.map((reference) => reference.sourceId),
    ),
  );
  const historical = new Set<string>();
  for (const answer of answers)
    for (const source of answer.sourceSnapshots)
      if (source.original) {
        linked.add(source.sourceId);
        historical.add(source.sourceId);
      }
  for (const source of basis.submission?.originals ?? []) {
    linked.add(source.sourceId);
    historical.add(source.sourceId);
  }
  return company.sources
    .filter(
      (source) =>
        linked.has(source.id) &&
        source.originalName &&
        company.sources.filter((item) => item.id === source.id).length === 1,
    )
    .map((source) => ({ source, historical: historical.has(source.id) }));
}
export function visitPackageRequestFor(company: StudioCase, selection: VisitPackageSelection) {
  const basis = resolveVisitPackageBasis(company, selection);
  if (!basis) return null;
  const answers = selectedVisitPackageAnswers(company, basis, selection.answerVersionIds);
  if (!answers) return null;
  const available = visitPackageSources(company, basis, answers);
  if (
    new Set(selection.sourceIds).size !== selection.sourceIds.length ||
    selection.sourceIds.some(
      (id) => available.filter((entry) => entry.source.id === id).length !== 1,
    )
  )
    return null;
  const parsed = visitPackageRequestSchema.safeParse({
    revision: company.revision,
    mode: basis.mode,
    planId: basis.plan.id,
    submissionRecordId: basis.submission?.id ?? null,
    answerVersionIds: selection.answerVersionIds,
    sourceIds: selection.sourceIds,
  });
  return parsed.success ? parsed.data : null;
}

export function VisitPackageChoices({
  company,
  selection,
  onChange,
  disabled = false,
}: {
  company: StudioCase;
  selection: VisitPackageSelection;
  onChange: (value: VisitPackageSelection) => void;
  disabled?: boolean;
}) {
  const prefix = useId();
  const basis = resolveVisitPackageBasis(company, selection);
  const answers = basis
    ? selectedVisitPackageAnswers(company, basis, selection.answerVersionIds)
    : null;
  const sources = basis && answers ? visitPackageSources(company, basis, answers) : [];
  const matchingAnswers = basis
    ? company.visitAnswers.filter((answer) => answer.planId === basis.plan.id)
    : [];
  const unanswered =
    basis?.plan.content.interviewQuestions.filter(
      (_, index) =>
        !answers?.some((answer) => answer.questionIndex === index && answer.answerText.trim()),
    ).length ?? 0;
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-mode`}>출력 기준 직접 선택</Label>
          <select
            id={`${prefix}-mode`}
            className={selectClass}
            value={selection.mode}
            onChange={(event) => onChange(changeVisitPackageBasis(event.target.value as Mode | ""))}
          >
            <option value="">기준 선택</option>
            <option value="draft">정확한 저장 원고 · DRAFT</option>
            <option value="recorded-submission">담당자 제출 기록 · DRAFT 실사 준비</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-basis`}>
            {selection.mode === "recorded-submission"
              ? "정확한 수동 제출 기록 버전"
              : "정확한 저장 원고 버전"}
          </Label>
          <select
            id={`${prefix}-basis`}
            className={selectClass}
            disabled={!selection.mode}
            value={selection.basisId}
            onChange={(event) =>
              onChange(changeVisitPackageBasis(selection.mode, event.target.value))
            }
          >
            <option value="">직접 선택 · 최신 자동 선택 없음</option>
            {selection.mode === "draft"
              ? [...company.plans].reverse().map((plan, index) => (
                  <option
                    key={`${plan.id}-${index}`}
                    value={plan.id}
                    disabled={
                      !resolveVisitPackageBasis(company, { mode: "draft", basisId: plan.id })
                    }
                  >
                    원고 v{plan.version} · {plan.content.title}
                  </option>
                ))
              : selection.mode === "recorded-submission"
                ? [...company.applicationEvents]
                    .reverse()
                    .filter(isApplicationSubmission)
                    .map((record, index) => (
                      <option
                        key={`${record.id}-${index}`}
                        value={record.id}
                        disabled={
                          !resolveVisitPackageBasis(company, {
                            mode: "recorded-submission",
                            basisId: record.id,
                          })
                        }
                      >
                        수동 제출 기록 v{record.version} · {record.occurredOn} · 원고 v
                        {record.plan.version} · {record.companySnapshot.companyName}
                      </option>
                    ))
                : null}
          </select>
        </div>
      </div>
      {selection.basisId && !basis && (
        <Notice tone="warning">
          기준 기업·원고·제출 기록을 고유하게 찾을 수 없습니다. 최신 버전으로 대체하지 않습니다.
        </Notice>
      )}
      {basis && (
        <>
          <Notice>
            <p>
              선택 원고 v{basis.plan.version} · {basis.plan.content.title}
            </p>
            {basis.submission ? (
              <>
                <p>
                  수동 제출 기록 v{basis.submission.version} · 직접 기록한 제출일{" "}
                  {basis.submission.occurredOn} · 기록자 {basis.submission.recordedBy}
                </p>
                <p>
                  당시 기업명: {basis.submission.companySnapshot.companyName} · 현재 기업명:{" "}
                  {company.profile.companyName}
                </p>
                <p>공식 제출·기관 수신 미확인입니다. 최신 원고나 최신 답변으로 바꾸지 않습니다.</p>
              </>
            ) : (
              <p>DRAFT 원고 기준입니다. 실제 제출본으로 추정하지 않습니다.</p>
            )}
          </Notice>
          <div className="space-y-3 rounded-xl border p-4">
            <h4 className="font-semibold">
              포함할 답변 버전 직접 선택 · {selection.answerVersionIds.length}/
              {visitPackageLimits.answers}개
            </h4>
            <p className="text-xs leading-6">
              한 답변 이력에서 한 버전만 선택합니다. 원고의 전체 예상 질문 목록을 포함하며 답변
              미선택·미작성 질문은 별도로 표시합니다. 선택은 내부 검토 완료가 아닙니다.
            </p>
            <details>
              <summary className="cursor-pointer text-xs underline">
                선택 원고의 예상 질문 {basis.plan.content.interviewQuestions.length}개
              </summary>
              <ol className="mt-2 list-decimal space-y-2 pl-5 text-xs leading-6">
                {basis.plan.content.interviewQuestions.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ol>
            </details>
            <p className="text-xs text-amber-900">
              선택된 작성 답변이 없는 질문: {unanswered}개 · 기관 확정 질문이 아닙니다.
            </p>
            {matchingAnswers.length === 0 && (
              <p className="text-sm text-muted-foreground">
                이 원고에 저장한 답변이 없습니다. 질문·미응답 안내만 출력할 수 있습니다.
              </p>
            )}
            {matchingAnswers.map((answer, index) => {
              const eligible = visitPackageAnswerEligible(company, basis, answer);
              const selected = selection.answerVersionIds.includes(answer.id);
              const duplicateRoot =
                !selected && Boolean(answers?.some((item) => item.answerId === answer.answerId));
              const context = visitAnswerContext(company, answer);
              return (
                <div key={`${answer.id}-${index}`} className="space-y-2 rounded-lg border p-3">
                  <label className="flex items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 accent-teal-700"
                      checked={selected}
                      disabled={
                        !eligible ||
                        duplicateRoot ||
                        (!selected &&
                          selection.answerVersionIds.length >= visitPackageLimits.answers)
                      }
                      onChange={(event) => {
                        if (!eligible || disabled) return;
                        onChange({
                          ...selection,
                          answerVersionIds: event.target.checked
                            ? [...selection.answerVersionIds, answer.id]
                            : selection.answerVersionIds.filter((id) => id !== answer.id),
                          sourceIds: [],
                        });
                      }}
                    />
                    <span className="min-w-0 break-words">
                      <span className="font-semibold">
                        질문 {answer.questionIndex + 1} · 답변 v{answer.version}
                      </span>
                      <span className="block text-xs">{answer.questionText}</span>
                      <span className="block text-xs">
                        {visitRespondentLabels[answer.respondentRole]} ·{" "}
                        {answer.respondentName || "응답자 미기록"} · {formatDate(answer.recordedAt)}
                      </span>
                    </span>
                  </label>
                  <p className="text-xs">
                    {answer.review.reviewedAt
                      ? "내부 검토 수동 기록 있음 · 진위 검증 아님"
                      : "미검토 답변"}{" "}
                    ·{" "}
                    {answer.submissionRecordId
                      ? "수동 제출 기록 연결 있음"
                      : "제출 기록 미연결 · 이번 선택으로 소급 귀속하지 않음"}
                  </p>
                  {!eligible && (
                    <p className="text-xs text-amber-900">
                      원고·질문·제출 기록 연결을 확인해 주세요. 제출 기록에 연결된 답변은 해당 기록
                      기준 모드에서 선택합니다.
                    </p>
                  )}
                  {duplicateRoot && (
                    <p className="text-xs text-muted-foreground">
                      이 답변 이력의 다른 버전을 이미 선택했습니다. 먼저 해당 선택을 해제해 주세요.
                    </p>
                  )}
                  {context.state !== "current" && (
                    <p className="text-xs text-amber-900">
                      현재 연결 재확인 필요 · 과거 답변·근거 인용은 보존합니다.
                    </p>
                  )}
                  <details>
                    <summary className="cursor-pointer text-xs underline">
                      정확한 답변 v{answer.version} 본문·저장 당시 근거 확인
                    </summary>
                    <pre className="my-2 max-h-44 overflow-auto whitespace-pre-wrap text-xs">
                      {answer.answerText || "미작성 답변"}
                    </pre>
                    <p className="whitespace-pre-wrap text-xs">
                      추가 확인: {answer.followUpNote || "미기록"}
                    </p>
                    {answer.sourceSnapshots.map((source) => (
                      <div key={source.sourceId} className="mt-2 space-y-1 text-xs leading-6">
                        <p>
                          {source.sourceName} · 저장 기준 {formatDate(source.sourceUpdatedAt)}
                        </p>
                        {source.original && (
                          <p className="break-all">
                            당시 원본: {source.original.originalName} · {source.original.sizeBytes}{" "}
                            bytes · SHA-256 {source.original.sha256}
                          </p>
                        )}
                        {answer.pairs
                          .flatMap((pair) =>
                            pair.sources.filter((ref) => ref.sourceId === source.sourceId),
                          )
                          .map((ref, refIndex) => (
                            <p key={refIndex} className="whitespace-pre-wrap">
                              {ref.locator || "위치 미기록"}:{" "}
                              {ref.quote || "원본만 연결 · 본문 인용 없음"}
                            </p>
                          ))}
                      </div>
                    ))}
                  </details>
                </div>
              );
            })}
          </div>
          <div className="space-y-3 rounded-xl border p-4">
            <h4 className="font-semibold">
              포함할 원본 직접 선택 · {selection.sourceIds.length}/{visitPackageLimits.files}개
            </h4>
            <p className="text-xs leading-6">
              선택 원고·답변·제출 기록에 연결된 같은 기업의 현재 원본만 선택합니다. 답변 선택을
              바꾸면 원본 선택을 해제합니다. 원본 선택은 내용 검토가 아닙니다.
            </p>
            {sources.length === 0 && (
              <p className="text-sm text-muted-foreground">
                선택 기준에 연결된 현재 원본이 없습니다. 원본 미포함으로 출력할 수 있습니다.
              </p>
            )}
            {sources.map(({ source, historical }) => (
              <label
                key={source.id}
                className="flex items-start gap-3 rounded-lg border p-3 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-teal-700"
                  checked={selection.sourceIds.includes(source.id)}
                  disabled={
                    !selection.sourceIds.includes(source.id) &&
                    selection.sourceIds.length >= visitPackageLimits.files
                  }
                  onChange={(event) => {
                    if (disabled) return;
                    onChange({
                      ...selection,
                      sourceIds: event.target.checked
                        ? [...selection.sourceIds, source.id]
                        : selection.sourceIds.filter((id) => id !== source.id),
                    });
                  }}
                />
                <span className="min-w-0 break-words">
                  <span className="block font-medium">{source.name}</span>
                  <span className="block text-xs">현재 원본: {source.originalName}</span>
                  <span className="block text-xs">
                    {historical
                      ? "저장 당시 원본 식별값 있음 · 생성 시 SHA 대조"
                      : "현재 원고 근거 파일 별도 선택 · 과거 원본 일치 미보장"}
                  </span>
                  {source.extraction === "pending" && (
                    <Badge variant="outline" className="mt-1">
                      원본만 보관 · 본문 확인 필요
                    </Badge>
                  )}
                </span>
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              원본 0개 허용 · 개별 12MiB / 합계 24MiB, ZIP 28MiB 한도는 생성 시 서버에서 확인합니다.
              선택 원본의 전체 내용이 포함됩니다.
            </p>
          </div>
        </>
      )}
    </fieldset>
  );
}

type Props = {
  company: StudioCase;
  blockedReason?: string;
  onBusyChange: (message: string) => void;
};
export function VisitPackagePanel(props: Props) {
  return (
    <VisitPackagePanelInner key={`${props.company.id}:${props.company.revision}`} {...props} />
  );
}
function VisitPackagePanelInner({ company, blockedReason = "", onBusyChange }: Props) {
  const [selection, setSelection] = useState<VisitPackageSelection>(emptyVisitPackageSelection);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const inFlight = useRef(false),
    mounted = useRef(false);
  const binding = `${company.id}:${company.revision}`;
  const context = useRef(binding);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    context.current = binding;
  }, [binding]);
  const request = visitPackageRequestFor(company, selection);
  const disabled = busy || !!blockedReason;
  async function download() {
    if (disabled || inFlight.current || !request) return;
    const started = binding;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    onBusyChange("선택한 실사 질문·답변·원본의 로컬 ZIP을 만드는 중입니다");
    let objectUrl: string | null = null;
    try {
      const response = await fetch(`/api/studio/cases/${company.id}/visit-package`, {
        method: "POST",
        cache: "no-store",
        ...jsonBody(request),
      });
      const file = await readPackageDownload(response, VISIT_PACKAGE_DOWNLOAD_NAME);
      if (!mounted.current || context.current !== started) return;
      objectUrl = URL.createObjectURL(file.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = file.filename;
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      const completedUrl = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(completedUrl), 1000);
      objectUrl = null;
      setMessage(
        `선택 답변 ${request.answerVersionIds.length}개·원본 ${request.sourceIds.length}개의 ZIP 다운로드를 요청했습니다. 브라우저 다운로드 목록을 확인해 주세요. 선택 옵션은 유지합니다.`,
      );
    } catch (caught) {
      if (mounted.current && context.current === started)
        setError(
          caught instanceof Error ? caught.message : "실사 준비 묶음을 내려받지 못했습니다.",
        );
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange("");
      }
    }
  }
  return (
    <section
      aria-label="실사 질문·답변 출력 묶음"
      className="mt-5 space-y-4 rounded-2xl border bg-white p-5"
    >
      <h3 className="font-bold">실사 질문·답변 출력 묶음</h3>
      <Badge variant="outline">DRAFT · 로컬 실사 준비</Badge>
      <p className="text-sm leading-6 text-muted-foreground">
        정확한 원고 또는 수동 제출 기록과 답변 버전을 고르고, 필요한 원본을 ZIP으로 내려받습니다.
        최신 버전·답변·원본을 자동 선택하지 않습니다.
      </p>
      <Notice>
        예상 질문은 기관이 확정한 질문이 아닙니다. 묶음 생성은 실제 제출·기관 수신·실사 완료·내용
        검토 완료를 기록하지 않습니다. 수동 제출 기록 기준도 DRAFT 실사 준비 자료입니다.
      </Notice>
      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      <VisitPackageChoices
        company={company}
        selection={selection}
        disabled={disabled}
        onChange={(next) => {
          if (disabled || inFlight.current) return;
          setSelection(next);
          setMessage("");
          setError("");
        }}
      />
      <p className="text-xs leading-6 text-muted-foreground">
        이 선택은 출력 옵션이며 기업 기록을 바꾸지 않습니다. 회사·자료 버전 또는 출력 기준을 바꾸면
        다시 선택합니다. 다운로드 성공·실패 후 옵션은 유지하며 자동 재시도하지 않습니다. 미선택
        답변·원본·연락 메모를 일괄 포함하지 않습니다.
      </p>
      {error && (
        <div role="alert">
          <Notice tone="warning">{error} 상태를 확인한 뒤 직접 다시 만들 수 있습니다.</Notice>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={disabled || !request} onClick={() => void download()}>
          <Download />
          {busy ? "실사 ZIP 준비 중…" : "선택한 실사 준비 ZIP 내려받기"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || !selection.mode}
          onClick={() => {
            if (disabled || inFlight.current) return;
            setSelection(emptyVisitPackageSelection());
            setError("");
            setMessage("");
          }}
        >
          출력 선택 초기화
        </Button>
      </div>
    </section>
  );
}
