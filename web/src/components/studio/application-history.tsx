"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Plus, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  applicationLimits,
  applicationMetadata,
  applicationMutationSchema,
  currentApplicationLinks,
  isApplicationLink,
  isApplicationSubmission,
  latestApplicationSubmissions,
  type ApplicationMutation,
  type ApplicationState,
  type ApplicationSubmission,
} from "@/lib/studio-application-types";
import { isAgencyNoticeRecord, type AgencyRecord } from "@/lib/studio-agency-records";
import type { StudioCase } from "@/lib/studio-schema";
import { AgencySourcePicker } from "./agency-records";
import { TaskOwnersSummary } from "./task-owners";
import { CriteriaApplicationStatus } from "./criteria-versions";
import { Notice, formatDate, selectClass, useDirty, type PanelProps } from "./shared";

type Command = ApplicationMutation extends infer M
  ? M extends ApplicationMutation
    ? Omit<M, "revision" | "clientRequestId">
    : never
  : never;
type FormState = {
  input: Command;
  baseline: string;
  binding: string;
  clientRequestId: string;
  attempted: string | null;
};
type Props = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason: string;
  onDirtyChange: (dirty: boolean) => void;
};
const manualNotice =
  "담당자가 기록한 신청 이력입니다. 회차 등록·원본 연결·제출 기록 저장은 공식 사이트 전송이나 기관 접수·심사 결과 확인이 아닙니다. 회사 전체 진행 단계와 원고 검토 상태도 바꾸지 않습니다.";
function stateOf(company: StudioCase): ApplicationState {
  return {
    applications: company.applications ?? [],
    applicationEvents: company.applicationEvents ?? [],
  };
}
function rootId(record: AgencyRecord) {
  return isAgencyNoticeRecord(record) ? record.noticeRecordId : record.requestRecordId;
}
function recordLabel(record: AgencyRecord) {
  const kind = isAgencyNoticeRecord(record)
    ? (
        {
          payment: "납부 통보",
          receipt: "접수 통보",
          visit: "실사 통보",
          decision: "결과 통보",
          certificate: "확인서 통보",
        } as const
      )[record.details.category]
    : record.kind === "response"
      ? "답변"
      : "기관 요청";
  return `${kind} v${record.version} · ${record.title}`;
}
function applicationTitle(state: ApplicationState, id: string | null) {
  if (!id) return "회차 미지정";
  return applicationMetadata(state, id)?.title ?? "연결 회차 확인 필요";
}
export function applicationSaveAcknowledged(
  saved: StudioCase,
  companyId: string,
  revision: number,
  clientRequestId: string,
) {
  return (
    saved.id === companyId &&
    saved.revision >= revision &&
    [...(saved.applications ?? []), ...(saved.applicationEvents ?? [])].filter(
      (record) => record.clientRequestId === clientRequestId,
    ).length === 1
  );
}
export function ApplicationAgencyRecordView({ record }: { record: AgencyRecord }) {
  const labels: Record<string, string> = {
    amountWon: "기입 금액(원)",
    dueOn: "기입 기한",
    dueNote: "기한 근거",
    paidOn: "기입 납부일",
    referenceNumber: "기입 참조번호",
    statusText: "기관 안내 상태 문구",
    receiptNumber: "기입 접수번호",
    receivedOn: "기입 접수일",
    scheduledOn: "예정일",
    timeText: "시간",
    location: "장소",
    preparation: "준비 안내",
    decisionText: "결과 문구",
    notifiedOn: "통보일",
    reasons: "사유 원문",
    certificateNumber: "기입 확인서번호",
    issuedOn: "발급일",
    validFrom: "유효기간 시작일",
    validUntil: "유효기간 종료일",
  };
  return (
    <div className="space-y-2 text-xs leading-6">
      <p className="font-medium">
        {recordLabel(record)} · {record.institution}
      </p>
      <p className="whitespace-pre-wrap break-words">{record.body}</p>
      {isAgencyNoticeRecord(record) && (
        <dl className="space-y-1">
          {Object.entries(record.details)
            .filter(([key]) => key !== "category")
            .map(([key, value]) => (
              <div key={key}>
                <dt className="text-muted-foreground">{labels[key] ?? "통보 기입값"}</dt>
                <dd className="whitespace-pre-wrap break-words">{value || "미확인"}</dd>
              </div>
            ))}
        </dl>
      )}
      <p className="text-muted-foreground">
        담당자가 보관한 정확한 기록 버전입니다. 원문 진위·기관 접수·납부·최종 결과를 자동 검증하지
        않습니다.
      </p>
    </div>
  );
}
function emptyCycle(previousApplicationId: string | null = null): Command {
  return {
    action: "create-application",
    title: "",
    kind: "new",
    plannedOn: "",
    criteriaNote: "",
    previousApplicationId,
  };
}
function emptySubmission(applicationId: string): Command {
  return {
    action: "record-application-submission",
    applicationId,
    planId: "",
    sourceIds: [],
    taskIds: [],
    receiptRecordId: null,
    occurredOn: "",
    recordedBy: "",
    note: "",
  };
}

export function ApplicationSubmissionView({
  submission,
  company,
}: {
  submission: ApplicationSubmission;
  company: StudioCase;
}) {
  const receipt = company.agencyRecords.find((record) => record.id === submission.receiptRecordId);
  const pending = submission.plan.sections.filter((section) => section.needsConfirmation).length;
  const warnings = submission.plan.review.filter(
    (issue) => issue.severity === "error" || issue.category === "confirmation",
  );
  return (
    <article className="space-y-3 rounded-xl border p-4 text-xs leading-6">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="font-semibold">제출했다고 기록 · 기록 v{submission.version}</h5>
        <Badge variant="outline">기관 확인 미실시</Badge>
      </div>
      <p>
        담당자 기입 제출일: {submission.occurredOn} · 기록자: {submission.recordedBy}
      </p>
      <p className="text-muted-foreground">앱 보관 시각: {formatDate(submission.recordedAt)}</p>
      <p className="text-muted-foreground">
        검토·원본·담당자 정보는 이 기록을 저장할 때의 값입니다. 기입한 과거 제출일의 실제 상태를
        소급 검증한 값이 아닙니다.
      </p>
      <p>
        당시 회사: {submission.companySnapshot.companyName} · 사업자번호:{" "}
        {submission.companySnapshot.businessNumber || "미기재"}
      </p>
      {(submission.companySnapshot.companyName !== company.profile.companyName ||
        submission.companySnapshot.businessNumber !== company.profile.businessNumber) && (
        <p className="text-amber-800">현재 기업정보와 다른 당시 값을 보존하고 있습니다.</p>
      )}
      <div className="rounded-lg bg-muted/30 p-3">
        <p className="font-semibold">당시 선택 원고 v{submission.plan.version}</p>
        <p>
          기록 당시 최신 버전: {submission.plan.latestVersion ? "예" : "아니요"} · 당시 근거 현재성:{" "}
          {submission.plan.currentEvidence ? "일치" : "재검토 필요"}
        </p>
        <p>
          당시 내부 검토 표시:{" "}
          {submission.plan.confirmedAt ? formatDate(submission.plan.confirmedAt) : "미확인"} · 확인
          필요 항목 {pending}개
        </p>
        {(!submission.plan.confirmedAt ||
          pending > 0 ||
          warnings.length > 0 ||
          !submission.plan.currentEvidence ||
          !submission.plan.latestVersion) && (
          <p className="mt-1 font-medium text-amber-800">
            미검토·과거 버전·확인 필요 상태를 포함한 담당자 기록입니다. 저장으로 검토 완료가 되지
            않습니다.
          </p>
        )}
        <details className="mt-2">
          <summary className="cursor-pointer">당시 검토 의견·원고 내용 해시 보기</summary>
          <p className="break-all font-mono">SHA256: {submission.plan.contentSha256}</p>
          {submission.plan.review.map((issue, index) => (
            <p key={index}>
              {issue.message} · {issue.action}
            </p>
          ))}
          {!submission.plan.review.length && (
            <p>보관한 자동 검토 의견 없음 · 사실 확인 완료의 뜻이 아닙니다.</p>
          )}
        </details>
      </div>
      <p>
        접수 근거:{" "}
        {receipt
          ? recordLabel(receipt)
          : submission.receiptRecordId
            ? "연결 기록 확인 필요"
            : "미연결"}
      </p>
      <p className="text-muted-foreground">
        연결한 접수 통보도 담당자가 보관한 기록이며, 기관 접수 자동 확인이 아닙니다.
      </p>
      {receipt && (
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer">당시 연결한 접수 기록 보기</summary>
          <ApplicationAgencyRecordView record={receipt} />
        </details>
      )}
      {submission.note && (
        <p className="whitespace-pre-wrap break-words">메모: {submission.note}</p>
      )}
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer font-semibold">당시 원본·인용·담당자 스냅샷</summary>
        <p className="mt-2">
          선택 원본 {submission.originals.length}개 · 인용 {submission.evidence.length}개 · 담당
          업무 {submission.owners.length}개
        </p>
        {submission.originals.map((original) => (
          <div key={original.sourceId} className="mt-3 border-t pt-2">
            <p className="break-words font-medium">
              {original.sourceName} · {original.originalName}
            </p>
            <p>
              {original.sizeBytes.toLocaleString()}바이트 · {original.mimeType || "형식 미기재"}
            </p>
            <details>
              <summary className="cursor-pointer">보관 당시 SHA256</summary>
              <p className="break-all font-mono">{original.sha256}</p>
            </details>
          </div>
        ))}
        <p className="mt-2 text-muted-foreground">
          이 목록은 기록 당시 원본 정보입니다. 현재 자료함 파일과 같다는 보장이나 기관 수신 증명이
          아닙니다.
        </p>
        {submission.evidence.map((evidence, index) => (
          <blockquote key={index} className="mt-3 whitespace-pre-wrap break-words border-l-2 pl-3">
            {evidence.sourceName || "자료명 확인 필요"} · {evidence.locator || "위치 미기재"} · 당시
            대조{" "}
            {
              (
                {
                  matched: "일치",
                  missing: "자료 없음",
                  pending: "미추출",
                  mismatch: "불일치",
                } as const
              )[evidence.state]
            }
            <p>{evidence.quote}</p>
          </blockquote>
        ))}
        {submission.owners.map((owner) => (
          <div key={owner.taskId} className="mt-3 border-t pt-2">
            <p className="font-medium">당시 업무: {owner.title}</p>
            <TaskOwnersSummary owners={owner.owners} />
          </div>
        ))}
      </details>
    </article>
  );
}

export function ApplicationHistory(props: Props) {
  // The parent already protects dirty navigation; this key also discards stale form bindings.
  return (
    <ApplicationHistoryEditor key={`${props.company.id}:${props.company.revision}`} {...props} />
  );
}

function ApplicationHistoryEditor({ company, mutate, blockedReason, onDirtyChange }: Props) {
  const state = stateOf(company);
  const records = company.agencyRecords ?? [];
  const links = currentApplicationLinks(state);
  const roots = records.filter((record) => record.kind === "request" || record.kind === "notice");
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const id = useId();
  const binding = `${company.id}:${company.revision}`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty = Boolean(form && (form.attempted || JSON.stringify(form.input) !== form.baseline));
  useDirty(dirty || saving, onDirtyChange);
  const blocked = Boolean(blockedReason) || saving;
  const eventLimit = state.applicationEvents.length >= applicationLimits.events;
  const input = form?.input;
  function open(value: Command) {
    if (
      blocked ||
      inFlight.current ||
      (dirty && !window.confirm("저장하지 않은 편집을 취소하고 다른 기록을 열까요?"))
    )
      return;
    setForm({
      input: value,
      baseline: JSON.stringify(value),
      clientRequestId: crypto.randomUUID(),
      binding,
      attempted: null,
    });
    setError("");
  }
  function edit(value: Command) {
    if (form && !form.attempted && !blocked) setForm({ ...form, input: value });
  }
  function cancel() {
    if (saving) return;
    if (
      dirty &&
      !window.confirm(
        form?.attempted
          ? "저장됐을 수 있습니다. 최신 기록을 확인한 뒤 다시 작성해야 합니다. 이 편집본을 닫을까요?"
          : "저장하지 않은 회차 기록 편집을 취소할까요?",
      )
    )
      return;
    setForm(null);
    setError("");
  }
  async function save() {
    if (!form || blocked || inFlight.current || form.binding !== binding) return;
    const parsed = applicationMutationSchema.safeParse({
      ...form.input,
      revision: company.revision,
      clientRequestId: form.clientRequestId,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "기록 내용을 확인해 주세요.");
      return;
    }
    const payload = JSON.stringify(parsed.data);
    if (form.attempted && form.attempted !== payload) {
      setError("저장 결과 확인 전에는 같은 요청의 내용을 변경할 수 없습니다.");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError("");
    setForm({ ...form, attempted: payload });
    try {
      const { revision: _revision, ...mutation } = parsed.data;
      void _revision;
      const saved = await mutate(mutation);
      if (!mounted.current) return;
      if (
        saved &&
        applicationSaveAcknowledged(saved, company.id, company.revision, form.clientRequestId)
      )
        setForm(null);
      else
        setError(
          "저장 결과를 확인하지 못했습니다. 내용과 요청 번호를 유지했습니다. 최신 기록을 확인하거나 같은 내용으로 저장 확인을 다시 누르세요. 자동 재시도하지 않습니다.",
        );
    } catch {
      if (mounted.current)
        setError(
          "저장 결과를 확인하지 못했습니다. 새 기록을 만들기 전에 최신 기록을 확인하세요. 이 편집본의 같은 내용으로 저장 확인을 다시 할 수 있습니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const formTitle =
    input?.action === "create-application"
      ? "신청 회차 등록"
      : input?.action === "correct-application"
        ? "회차 정보 정정"
        : input?.action === "record-application-submission"
          ? "제출했다고 기록"
          : input?.action === "correct-application-submission"
            ? "제출 기록 정정"
            : input?.action === "link-application-agency"
              ? "기관 기록의 회차 연결"
              : "기관 기록 귀속·채택 버전 정정";
  const isCycle = input?.action === "create-application" || input?.action === "correct-application";
  const isSubmission =
    input?.action === "record-application-submission" ||
    input?.action === "correct-application-submission";
  const isLink =
    input?.action === "link-application-agency" ||
    input?.action === "correct-application-agency-link";
  const selectedRecord = isLink
    ? records.find((record) => record.id === input.recordId)
    : undefined;
  const chainRecords = selectedRecord
    ? records.filter((record) => rootId(record) === rootId(selectedRecord))
    : [];
  const receipts = records.filter(
    (record) =>
      isAgencyNoticeRecord(record) &&
      record.details.category === "receipt" &&
      isSubmission &&
      links.some(
        (link) => link.chainRootId === rootId(record) && link.applicationId === input.applicationId,
      ),
  );
  return (
    <section
      aria-label="신청 회차·제출 당시 이력"
      className="mt-5 space-y-4 rounded-2xl border p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold">신청 회차·제출 당시 이력</h3>
        <Button
          type="button"
          variant="outline"
          disabled={blocked || state.applications.length >= applicationLimits.cycles}
          onClick={() => open(emptyCycle())}
        >
          <Plus /> 신청 회차 등록
        </Button>
      </div>
      <Notice>{manualNotice}</Notice>
      <p className="text-xs leading-6 text-muted-foreground">
        회차 {state.applications.length}/{applicationLimits.cycles}개 · 사건{" "}
        {state.applicationEvents.length}/{applicationLimits.events}개. 회차가 없거나 연결하지 않은
        기존 기관 기록은 미지정으로 보존합니다.
      </p>
      {blockedReason && (
        <p role="status" className="text-sm text-amber-800">
          {blockedReason}
        </p>
      )}
      {error && (
        <div role="alert">
          <Notice tone="warning">{error}</Notice>
        </div>
      )}
      {form && input && (
        <section
          aria-label={formTitle}
          className="space-y-4 rounded-xl border border-primary/30 p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-semibold">{formTitle}</h4>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="회차 기록 편집 취소"
              disabled={saving}
              onClick={cancel}
            >
              <X />
            </Button>
          </div>
          {form.attempted && (
            <Notice tone="warning">
              저장 요청을 보낸 내용입니다. 결과를 확인하기 전까지 편집을 잠그고 같은 요청 번호로만
              다시 확인합니다.
            </Notice>
          )}
          <fieldset disabled={blocked || Boolean(form.attempted)} className="space-y-4">
            {isCycle && (
              <>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-title`}>회차 이름 *</Label>
                  <Input
                    id={`${id}-title`}
                    maxLength={200}
                    value={input.title}
                    onChange={(e) => edit({ ...input, title: e.target.value })}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-kind`}>담당자 확인 구분</Label>
                    <select
                      id={`${id}-kind`}
                      className={selectClass}
                      value={input.kind}
                      onChange={(e) =>
                        edit({ ...input, kind: e.target.value as "new" | "renewal" })
                      }
                    >
                      <option value="new">신규</option>
                      <option value="renewal">재확인</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-planned`}>신청 예정일 (선택)</Label>
                    <Input
                      id={`${id}-planned`}
                      type="date"
                      value={input.plannedOn}
                      onChange={(e) => edit({ ...input, plannedOn: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-previous`}>이전 신청 회차 (선택)</Label>
                  <select
                    id={`${id}-previous`}
                    className={selectClass}
                    value={input.previousApplicationId ?? ""}
                    onChange={(e) =>
                      edit({ ...input, previousApplicationId: e.target.value || null })
                    }
                  >
                    <option value="">미연결 · 앱 밖 이력은 기준 메모에 기재</option>
                    {state.applications
                      .filter(
                        (cycle) =>
                          input.action !== "correct-application" ||
                          cycle.id !== input.applicationId,
                      )
                      .map((cycle) => (
                        <option key={cycle.id} value={cycle.id}>
                          {applicationTitle(state, cycle.id)}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-criteria`}>적용 기준·기준일 메모 (선택)</Label>
                  <Textarea
                    id={`${id}-criteria`}
                    maxLength={2000}
                    value={input.criteriaNote}
                    onChange={(e) => edit({ ...input, criteriaNote: e.target.value })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  예정일·신규/재확인 구분·이전 회차는 담당자 기록이며 공식 적합성이나 다음 신청
                  기한을 계산하지 않습니다.
                </p>
              </>
            )}
            {isSubmission && (
              <>
                <p className="text-sm font-medium">
                  대상 회차: {applicationTitle(state, input.applicationId)}
                </p>
                <Notice tone="warning">
                  실제로 제출했다고 담당자가 기록하는 기능입니다. 과거·미검토 원고도 당시 상태
                  그대로 보관하며 내부 검토 완료나 기관 접수로 표시하지 않습니다.
                </Notice>
                <p className="text-xs leading-6 text-muted-foreground">
                  선택한 원고의 검토 상태·원본·담당자는 이번 저장 시점의 값으로 보관합니다. 과거
                  제출일의 실제 상태를 자동 복원하지 않습니다.
                </p>
                {input.action === "correct-application-submission" && (
                  <p className="text-xs text-amber-800">
                    정정 시 원본·담당 업무·접수 근거는 다시 선택하세요. 이전 기록과 원본 보호는
                    유지됩니다.
                  </p>
                )}
                <div className="space-y-2">
                  <Label htmlFor={`${id}-plan`}>제출했다고 기록할 원고 버전 *</Label>
                  <select
                    id={`${id}-plan`}
                    className={selectClass}
                    value={input.planId}
                    onChange={(e) => edit({ ...input, planId: e.target.value })}
                  >
                    <option value="">원고 직접 선택</option>
                    {[...company.plans].reverse().map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        v{plan.version} · {plan.content.title}
                        {plan.confirmedAt ? " · 내부 검토 표시 있음" : " · 내부 검토 미확인"}
                      </option>
                    ))}
                  </select>
                </div>
                <AgencySourcePicker
                  sources={company.sources}
                  selected={input.sourceIds}
                  onChange={(sourceIds) => edit({ ...input, sourceIds })}
                />
                <fieldset className="space-y-2 rounded-xl border p-4">
                  <legend className="px-1 text-sm font-semibold">
                    당시 담당자로 기록할 업무 · 최대 {applicationLimits.taskCount}개
                  </legend>
                  <p className="text-xs text-muted-foreground">
                    직접 선택한 업무의 현재 담당자 이름을 이 제출 기록에 고정합니다. 권한·검토 완료
                    증거가 아닙니다.
                  </p>
                  {company.tasks.map((task) => (
                    <label key={task.id} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 accent-primary"
                        checked={input.taskIds.includes(task.id)}
                        disabled={
                          input.taskIds.length >= applicationLimits.taskCount &&
                          !input.taskIds.includes(task.id)
                        }
                        onChange={(e) =>
                          edit({
                            ...input,
                            taskIds: e.target.checked
                              ? [...input.taskIds, task.id]
                              : input.taskIds.filter((taskId) => taskId !== task.id),
                          })
                        }
                      />
                      <span>
                        {task.title}
                        <span className="block text-xs text-muted-foreground">
                          자료 준비: {task.owners?.materials || "미지정"} · 작성:{" "}
                          {task.owners?.writing || "미지정"} · 내용 확인:{" "}
                          {task.owners?.review || "미지정"}
                        </span>
                      </span>
                    </label>
                  ))}
                  {!company.tasks.length && (
                    <p className="text-xs text-muted-foreground">선택할 업무 없음</p>
                  )}
                </fieldset>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-receipt`}>접수 통보 근거 (선택)</Label>
                  <select
                    id={`${id}-receipt`}
                    className={selectClass}
                    value={input.receiptRecordId ?? ""}
                    onChange={(e) => edit({ ...input, receiptRecordId: e.target.value || null })}
                  >
                    <option value="">미연결</option>
                    {receipts.map((record) => (
                      <option key={record.id} value={record.id}>
                        {recordLabel(record)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    아래 기관 체인에서 이 회차에 연결한 접수 통보만 선택할 수 있습니다. 연결 전에는
                    미연결로 기록할 수 있습니다.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-occurred`}>담당자 기입 제출일 *</Label>
                    <Input
                      id={`${id}-occurred`}
                      type="date"
                      value={input.occurredOn}
                      onChange={(e) => edit({ ...input, occurredOn: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-recorder`}>기록자 이름 *</Label>
                    <Input
                      id={`${id}-recorder`}
                      maxLength={100}
                      autoComplete="off"
                      value={input.recordedBy}
                      onChange={(e) => edit({ ...input, recordedBy: e.target.value })}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  제출일을 모르면 이 기록을 저장하지 말고 준비 단계나 업무 메모로 남겨 주세요.
                </p>
              </>
            )}
            {isLink && (
              <>
                {input.action === "correct-application-agency-link" && (
                  <p className="text-sm">
                    현재 귀속: {applicationTitle(state, input.fromApplicationId)}
                  </p>
                )}
                <div className="space-y-2">
                  <Label htmlFor={`${id}-destination`}>연결할 회차</Label>
                  <select
                    id={`${id}-destination`}
                    className={selectClass}
                    value={
                      input.action === "link-application-agency"
                        ? input.applicationId
                        : (input.toApplicationId ?? "")
                    }
                    onChange={(e) =>
                      edit(
                        input.action === "link-application-agency"
                          ? { ...input, applicationId: e.target.value }
                          : { ...input, toApplicationId: e.target.value || null },
                      )
                    }
                  >
                    <option value="">
                      {input.action === "link-application-agency"
                        ? "회차 선택"
                        : "회차 귀속 해제 · 미지정"}
                    </option>
                    {state.applications.map((cycle) => (
                      <option key={cycle.id} value={cycle.id}>
                        {applicationTitle(state, cycle.id)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-record`}>채택할 기관 기록의 정확한 버전</Label>
                  <select
                    id={`${id}-record`}
                    className={selectClass}
                    value={input.recordId}
                    onChange={(e) => edit({ ...input, recordId: e.target.value })}
                  >
                    {chainRecords.map((record) => (
                      <option key={record.id} value={record.id}>
                        {recordLabel(record)}
                      </option>
                    ))}
                  </select>
                </div>
                {selectedRecord && (
                  <div className="max-h-64 overflow-auto rounded-lg bg-muted/30 p-3">
                    <ApplicationAgencyRecordView record={selectedRecord} />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  이 요청·답변 또는 통보의 전체 체인을 한 회차에 귀속합니다. 채택 버전은 별도로
                  고정하며 이후 정정·답변을 자동 채택하지 않습니다.
                </p>
              </>
            )}
            {input && "note" in input && (
              <div className="space-y-2">
                <Label htmlFor={`${id}-note`}>
                  {input.action === "correct-application-agency-link"
                    ? "귀속·버전 정정 사유 *"
                    : "기록 메모 (선택)"}
                </Label>
                <Textarea
                  id={`${id}-note`}
                  maxLength={2000}
                  value={input.note}
                  onChange={(e) => edit({ ...input, note: e.target.value })}
                />
              </div>
            )}
          </fieldset>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={cancel}>
              편집 취소
            </Button>
            <Button type="button" disabled={blocked} onClick={save}>
              <Save />
              {saving
                ? "저장 중…"
                : form.attempted
                  ? "같은 내용으로 저장 확인"
                  : "담당자 기록 저장"}
            </Button>
          </div>
        </section>
      )}
      {!state.applications.length && (
        <p className="text-sm text-muted-foreground">
          등록한 신청 회차가 없습니다. 기존 회사 단계·원고·기관 기록을 보고 회차를 자동 추정하지
          않습니다.
        </p>
      )}
      {state.applications.map((cycle) => {
        const metadata = applicationMetadata(state, cycle.id)!;
        const submissions = latestApplicationSubmissions(state, cycle.id);
        const current = links.filter((link) => link.applicationId === cycle.id);
        const history = state.applicationEvents.filter(
          (event) =>
            event.applicationId === cycle.id ||
            (isApplicationLink(event) && event.fromApplicationId === cycle.id),
        );
        return (
          <article
            key={cycle.id}
            id={`application-cycle-${cycle.id}`}
            tabIndex={-1}
            className="scroll-mt-24 space-y-3 rounded-xl border p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold">{metadata.title}</h4>
              <Badge variant="outline">
                {metadata.kind === "new" ? "신규" : "재확인"} · 담당자 기록
              </Badge>
            </div>
            <a
              href={`#application-procedures-${cycle.id}`}
              className="inline-block text-xs text-primary underline underline-offset-4"
            >
              이 회차의 절차·안내기한 기록 보기
            </a>
            <p className="text-xs leading-6">
              예정일: {metadata.plannedOn || "미기재"} · 이전 회차:{" "}
              {applicationTitle(state, metadata.previousApplicationId)}
            </p>
            <p className="text-xs leading-6 text-muted-foreground">
              회차 생성 당시 회사: {cycle.companyAtCreation.companyName} ·{" "}
              {cycle.companyAtCreation.businessNumber || "사업자번호 미기재"}
            </p>
            {metadata.criteriaNote && (
              <p className="whitespace-pre-wrap text-xs leading-6">
                기준 메모: {metadata.criteriaNote}
              </p>
            )}
            <CriteriaApplicationStatus company={company} applicationId={cycle.id} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={blocked || eventLimit}
                onClick={() =>
                  open({
                    action: "correct-application",
                    applicationId: cycle.id,
                    previousVersionId: metadata.metadataVersionId,
                    title: metadata.title,
                    kind: metadata.kind,
                    plannedOn: metadata.plannedOn,
                    criteriaNote: metadata.criteriaNote,
                    previousApplicationId: metadata.previousApplicationId,
                  })
                }
              >
                회차 정보 정정
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={blocked || eventLimit || !company.plans.length}
                onClick={() => open(emptySubmission(cycle.id))}
              >
                제출 당시 버전 기록
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={blocked || state.applications.length >= applicationLimits.cycles}
                onClick={() => open(emptyCycle(cycle.id))}
              >
                이 회차 다음 신청 등록
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              현재 귀속된 기관 체인 {current.length}개 · 제출했다고 기록한 건 {submissions.length}개
            </p>
            {current.map((link) => {
              const record = records.find((item) => item.id === link.recordVersionId);
              const latest = records.filter((item) => rootId(item) === link.chainRootId).at(-1);
              return (
                <div key={link.id} className="rounded-lg bg-muted/30 p-3 text-xs leading-6">
                  {record ? (
                    <ApplicationAgencyRecordView record={record} />
                  ) : (
                    <p>고정 기관 기록 확인 필요</p>
                  )}
                  {latest?.id !== link.recordVersionId && (
                    <p className="text-amber-800">
                      후속 정정·답변 있음 · 고정 버전을 자동 변경하지 않습니다.
                    </p>
                  )}
                  <p>귀속 기록 시각: {formatDate(link.recordedAt)}</p>
                </div>
              );
            })}
            {submissions.map((submission) => (
              <div key={submission.id} className="space-y-2">
                <ApplicationSubmissionView submission={submission} company={company} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={blocked || eventLimit}
                  onClick={() =>
                    open({
                      action: "correct-application-submission",
                      applicationId: cycle.id,
                      submissionRecordId: submission.submissionRecordId,
                      previousVersionId: submission.id,
                      planId: submission.plan.id,
                      sourceIds: [],
                      taskIds: [],
                      receiptRecordId: null,
                      occurredOn: submission.occurredOn,
                      recordedBy: submission.recordedBy,
                      note: "",
                    })
                  }
                >
                  제출 기록 정정
                </Button>
              </div>
            ))}
            <details className="rounded-lg border p-3 text-xs leading-6">
              <summary className="cursor-pointer font-semibold">
                회차의 과거·정정 이력 {history.length}건
              </summary>
              <p className="mt-2">
                최초 등록: {cycle.title} · {cycle.kind === "new" ? "신규" : "재확인"} · 예정일{" "}
                {cycle.plannedOn || "미기재"} · {formatDate(cycle.recordedAt)}
              </p>
              <p>
                최초 이전 회차: {applicationTitle(state, cycle.previousApplicationId)} · 최초 기준
                메모: {cycle.criteriaNote || "미기재"}
              </p>
              {history.map((event) => (
                <div key={event.id} className="mt-3 border-t pt-2">
                  {event.kind === "cycle-correction" ? (
                    <p>
                      회차 정보 정정: {event.details.title} ·{" "}
                      {event.details.kind === "new" ? "신규" : "재확인"} · 예정일{" "}
                      {event.details.plannedOn || "미기재"} · 이전 회차{" "}
                      {applicationTitle(state, event.details.previousApplicationId)} ·{" "}
                      {event.details.criteriaNote}
                    </p>
                  ) : isApplicationSubmission(event) ? (
                    <ApplicationSubmissionView submission={event} company={company} />
                  ) : (
                    <p>
                      기관 귀속 기록: {applicationTitle(state, event.fromApplicationId)} →{" "}
                      {applicationTitle(state, event.applicationId)} ·{" "}
                      {(() => {
                        const record = records.find((item) => item.id === event.recordVersionId);
                        return record ? recordLabel(record) : "기록 확인 필요";
                      })()}{" "}
                      · {event.note}
                    </p>
                  )}
                  <p className="text-muted-foreground">보관 시각 {formatDate(event.recordedAt)}</p>
                </div>
              ))}
            </details>
          </article>
        );
      })}
      <div className="space-y-3 border-t pt-4">
        <h4 className="font-semibold">기관 요청·통보 체인의 회차 귀속</h4>
        <p className="text-xs leading-6 text-muted-foreground">
          미지정{" "}
          {
            roots.filter(
              (root) => !links.find((link) => link.chainRootId === root.id)?.applicationId,
            ).length
          }
          개. 답변·정정을 같은 체인으로 관리합니다. 이동·해제는 이력을 남기며 기관 원문과 업무를
          변경하지 않습니다.
        </p>
        {roots.map((root) => {
          const link = links.find((item) => item.chainRootId === root.id);
          const selected = link
            ? records.find((record) => record.id === link.recordVersionId)
            : undefined;
          return (
            <div key={root.id} className="space-y-2 rounded-lg border p-3 text-xs leading-6">
              <p className="font-semibold">{recordLabel(root)}</p>
              <p>현재 귀속: {applicationTitle(state, link?.applicationId ?? null)}</p>
              {selected && <p>채택한 기록: {recordLabel(selected)}</p>}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={blocked || eventLimit || !state.applications.length}
                onClick={() =>
                  open(
                    link
                      ? {
                          action: "correct-application-agency-link",
                          previousLinkEventId: link.id,
                          fromApplicationId: link.applicationId,
                          toApplicationId: link.applicationId,
                          recordId: link.recordVersionId,
                          note: "",
                        }
                      : {
                          action: "link-application-agency",
                          applicationId: "",
                          recordId: root.id,
                          note: "",
                        },
                  )
                }
              >
                {link ? "귀속·채택 버전 정정 / 해제" : "회차 연결"}
              </Button>
            </div>
          );
        })}
        {!roots.length && (
          <p className="text-sm text-muted-foreground">귀속할 기관 요청·통보 기록이 없습니다.</p>
        )}
      </div>
    </section>
  );
}
