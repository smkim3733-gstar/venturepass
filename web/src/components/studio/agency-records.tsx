"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileCheck, Plus, Save, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  agencyRecordInputSchema,
  isAgencyNoticeRecord,
  MAX_AGENCY_RECORDS,
  type AgencyRecord,
  type AgencyRecordInput,
  type AgencyEvidenceSnapshot,
} from "@/lib/studio-agency-records";
import type { SourceDocument, StudioCase } from "@/lib/studio-schema";
import { agencyTaskContext } from "@/lib/studio-agency-tasks";
import { Notice, formatDate, selectClass, studioFetch, useDirty, type PanelProps } from "./shared";
import { TaskOwnersSummary } from "./task-owners";
import { TaskProcessingSummary } from "./task-processing";

type NoticeDetails = Extract<AgencyRecordInput, { kind: "notice" }>["details"];
type NoticeCategory = NoticeDetails["category"];
const noticeCategoryLabels: Record<NoticeCategory, string> = {
  payment: "납부 안내",
  receipt: "접수 통보",
  visit: "현장실사 안내",
  decision: "심사 결과 통보",
  certificate: "확인서 관련 통보",
};
type NoticeField = {
  key: string;
  label: string;
  type?: "date" | "long" | "amount";
  maxLength?: number;
};
const noticeDetailFields: Record<NoticeCategory, NoticeField[]> = {
  payment: [
    { key: "amountWon", label: "통보에 기재된 금액 (원)", type: "amount", maxLength: 16 },
    { key: "dueOn", label: "통보에 기재된 납부기한", type: "date" },
    { key: "dueNote", label: "납부기한 근거", type: "long", maxLength: 2000 },
    { key: "paidOn", label: "담당자가 기입한 납부일", type: "date" },
    { key: "referenceNumber", label: "납부 참조번호", maxLength: 200 },
    { key: "statusText", label: "통보에 기재된 상태 문구", type: "long", maxLength: 1000 },
  ],
  receipt: [
    { key: "receiptNumber", label: "접수번호", maxLength: 200 },
    { key: "receivedOn", label: "통보에 기재된 접수일", type: "date" },
    { key: "statusText", label: "통보에 기재된 상태 문구", type: "long", maxLength: 1000 },
  ],
  visit: [
    { key: "scheduledOn", label: "안내된 실사 예정일", type: "date" },
    { key: "timeText", label: "안내된 실사 시간", maxLength: 100 },
    { key: "location", label: "안내된 실사 장소", maxLength: 500 },
    { key: "preparation", label: "안내된 준비사항", type: "long", maxLength: 2000 },
  ],
  decision: [
    { key: "decisionText", label: "통보에 기재된 결과 문구", type: "long", maxLength: 1000 },
    { key: "notifiedOn", label: "통보에 기재된 결과 통보일", type: "date" },
    { key: "reasons", label: "통보에 기재된 사유", type: "long", maxLength: 2000 },
  ],
  certificate: [
    { key: "certificateNumber", label: "확인서 번호", maxLength: 200 },
    { key: "issuedOn", label: "기재된 발급일", type: "date" },
    { key: "validFrom", label: "기재된 유효기간 시작일", type: "date" },
    { key: "validUntil", label: "기재된 유효기간 종료일", type: "date" },
    { key: "statusText", label: "통보에 기재된 상태 문구", type: "long", maxLength: 1000 },
  ],
};

export function emptyAgencyNoticeDetails(category: NoticeCategory): NoticeDetails {
  switch (category) {
    case "payment":
      return {
        category,
        amountWon: "",
        dueOn: "",
        dueNote: "",
        paidOn: "",
        referenceNumber: "",
        statusText: "",
      };
    case "receipt":
      return { category, receiptNumber: "", receivedOn: "", statusText: "" };
    case "visit":
      return { category, scheduledOn: "", timeText: "", location: "", preparation: "" };
    case "decision":
      return { category, decisionText: "", notifiedOn: "", reasons: "" };
    case "certificate":
      return {
        category,
        certificateNumber: "",
        issuedOn: "",
        validFrom: "",
        validUntil: "",
        statusText: "",
      };
  }
}

function noticeDetailValue(details: NoticeDetails, key: string) {
  return (details as Record<string, string>)[key] ?? "";
}

export function AgencyNoticeFields({
  details,
  onChange,
}: {
  details: NoticeDetails;
  onChange: (details: NoticeDetails) => void;
}) {
  return (
    <fieldset className="space-y-4 rounded-xl border p-4">
      <legend className="px-1 text-sm font-semibold">
        담당자 기입 통보 상세 · 각 항목 선택 입력
      </legend>
      <div className="space-y-2">
        <Label htmlFor="agency-notice-category">통보 분류</Label>
        <select
          id="agency-notice-category"
          className={selectClass}
          value={details.category}
          onChange={(event) => {
            const category = event.target.value as NoticeCategory;
            if (category === details.category || !(category in noticeCategoryLabels)) return;
            const hasDetails = noticeDetailFields[details.category].some((field) =>
              noticeDetailValue(details, field.key),
            );
            if (
              hasDetails &&
              !window.confirm("분류를 변경하면 현재 상세 입력은 비워집니다. 분류를 변경할까요?")
            )
              return;
            onChange(emptyAgencyNoticeDetails(category));
          }}
        >
          {Object.entries(noticeCategoryLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs leading-6 text-muted-foreground">
        확인한 내용만 입력하세요. 빈 상세값은 미확인으로 남으며, 날짜·금액·상태를 자동으로 추정하지
        않습니다.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {noticeDetailFields[details.category].map((field) => {
          const id = `agency-notice-${field.key}`;
          const value = noticeDetailValue(details, field.key);
          const change = (value: string) => onChange({ ...details, [field.key]: value });
          return (
            <div
              key={field.key}
              className={field.type === "long" ? "space-y-2 sm:col-span-2" : "space-y-2"}
            >
              <Label htmlFor={id}>{field.label} (선택)</Label>
              {field.type === "long" ? (
                <Textarea
                  id={id}
                  value={value}
                  maxLength={field.maxLength}
                  placeholder="미확인"
                  onChange={(event) => change(event.target.value)}
                />
              ) : (
                <Input
                  id={id}
                  type={field.type === "date" ? "date" : "text"}
                  inputMode={field.type === "amount" ? "numeric" : undefined}
                  value={value}
                  maxLength={field.maxLength}
                  placeholder={
                    field.type === "amount" ? "미확인 · 쉼표 없는 원 단위 정수" : "미확인"
                  }
                  onChange={(event) => change(event.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
      <Notice>
        담당자가 기록한 통보입니다. 저장해도 진행 단계는 바뀌지 않습니다. 기관 송수신·납부
        성공·접수·실사 진행·심사 결과·확인서 진위와 유효성을 자동 확인하지 않습니다.
      </Notice>
    </fieldset>
  );
}

function AgencyNoticeDetailsView({ details }: { details: NoticeDetails }) {
  return (
    <div className="space-y-2 rounded-lg bg-muted/30 p-3 text-xs leading-6">
      <p className="font-semibold">
        통보 분류: {noticeCategoryLabels[details.category]} · 담당자 기입
      </p>
      <dl className="space-y-2">
        {noticeDetailFields[details.category].map((field) => (
          <div key={field.key}>
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="whitespace-pre-wrap break-words">
              {noticeDetailValue(details, field.key) || "미확인"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export type AgencyEvidenceCheck = {
  caseRevision: number;
  recordId: string;
  observedAt: string;
  evidence: { sourceId: string; state: "matched" | "changed" | "unavailable" }[];
};

export function validateAgencyEvidenceCheck(
  value: AgencyEvidenceCheck,
  record: AgencyRecord,
  revision: number,
) {
  const expected = new Set(record.evidence.map((item) => item.sourceId));
  if (
    !value ||
    value.caseRevision !== revision ||
    value.recordId !== record.id ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length !== expected.size ||
    new Set(value.evidence.map((item) => item?.sourceId)).size !== expected.size ||
    value.evidence.some(
      (item) =>
        !item ||
        !expected.has(item.sourceId) ||
        !["matched", "changed", "unavailable"].includes(item.state),
    )
  )
    throw new Error(
      "원본 확인 결과와 현재 기록이 일치하지 않습니다. 최신 기록을 불러온 뒤 다시 확인해 주세요.",
    );
  return value;
}

export function AgencySourcePicker({
  sources,
  selected,
  onChange,
}: {
  sources: SourceDocument[];
  selected: string[];
  onChange: (sourceIds: string[]) => void;
}) {
  const originals = sources.filter((source) => source.originalName);
  return (
    <fieldset className="space-y-3 rounded-xl border p-4">
      <legend className="px-1 text-sm font-semibold">연결할 원본 증빙 · 최대 10개</legend>
      <p className="text-xs leading-6 text-muted-foreground">
        자료함에 보관한 원본만 연결합니다. 한 기록의 원본 합계는 24MiB까지입니다. 선택한 원본의
        이름·크기·SHA256을 저장하며 내용 검토나 기관 송수신을 확인하는 것은 아닙니다.
      </p>
      {!originals.length && (
        <p className="text-sm text-muted-foreground">
          연결할 원본이 없습니다. 자료함에서 원본을 먼저 보관하거나 증빙 없이 기록할 수 있습니다.
        </p>
      )}
      {originals.map((source) => (
        <label key={source.id} className="flex items-start gap-2 text-sm leading-6">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={selected.includes(source.id)}
            disabled={selected.length >= 10 && !selected.includes(source.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, source.id]
                  : selected.filter((id) => id !== source.id),
              )
            }
          />
          <span className="min-w-0 break-words">
            {source.name}
            <span className="block text-xs text-muted-foreground">{source.originalName}</span>
            {source.extraction === "pending" && (
              <Badge variant="outline">본문 미추출 · 분석 완료 아님</Badge>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function AgencyEvidenceView({
  caseId,
  evidence,
  sources,
  check,
}: {
  caseId: string;
  evidence: AgencyEvidenceSnapshot[];
  sources: SourceDocument[];
  check?: AgencyEvidenceCheck;
}) {
  return (
    <div className="space-y-3">
      {!evidence.length && <p className="text-xs text-muted-foreground">연결한 원본 증빙 없음</p>}
      {check && (
        <p role="status" className="text-xs leading-6 text-muted-foreground">
          원본 확인 시각: {formatDate(check.observedAt)}. 이후 변경은 반영하지 않습니다.
        </p>
      )}
      {evidence.map((item) => {
        const source = sources.find((candidate) => candidate.id === item.sourceId);
        const state = check?.evidence.find(
          (candidate) => candidate.sourceId === item.sourceId,
        )?.state;
        return (
          <div key={item.sourceId} className="space-y-2 rounded-lg border p-3 text-xs leading-6">
            <p className="break-words font-semibold">{item.sourceName}</p>
            <p className="break-all">
              보관 당시 원본: {item.originalName} · {item.sizeBytes.toLocaleString()}바이트 ·{" "}
              {item.mimeType || "형식 기록 없음"}
            </p>
            <p className="text-muted-foreground">
              증빙 연결 시각 {formatDate(item.capturedAt)} · 자료 수정 시각{" "}
              {formatDate(item.sourceUpdatedAt)}
            </p>
            {source?.extraction === "pending" && (
              <Badge variant="outline">현재 자료 본문 미추출 · 분석 완료 아님</Badge>
            )}
            {state && (
              <p className={state === "matched" ? "font-medium" : "font-medium text-amber-900"}>
                {state === "matched"
                  ? "보관 당시 원본과 현재 파일 일치 · 기관 접수 증명 아님"
                  : state === "changed"
                    ? "보관 당시 원본 또는 자료 정보와 현재 상태가 다릅니다."
                    : "현재 원본을 확인할 수 없습니다. 일치로 판단하지 않습니다."}
              </p>
            )}
            <details>
              <summary className="cursor-pointer">보관 당시 원본 SHA256 보기</summary>
              <p className="break-all font-mono">{item.sha256}</p>
            </details>
            {source?.originalName && (
              <Button type="button" variant="outline" size="sm" asChild>
                <a href={`/api/studio/cases/${caseId}/sources/${item.sourceId}`} download>
                  <Download />
                  현재 보관 원본 다운로드
                </a>
              </Button>
            )}
            <p className="text-muted-foreground">
              다운로드는 현재 파일입니다. 기록 당시 SHA256과 다를 수 있습니다. 원본 연결은 내용
              검토·기관 수신·발송 성공을 증명하지 않습니다.
            </p>
          </div>
        );
      })}
    </div>
  );
}

const recordKindLabel = (record: AgencyRecord) =>
  isAgencyNoticeRecord(record)
    ? record.kind === "notice"
      ? "기관 통보 담당자 기록"
      : "통보 정정 담당자 기록"
    : record.kind === "request"
      ? "기관 요청 담당자 기록"
      : record.kind === "request-correction"
        ? "요청 정정 기록"
        : record.responseStatus === "reported-sent"
          ? "담당자 기입 발송 기록"
          : "답변 초안 기록";

export function AgencyRecordView({
  caseId,
  record,
  sources,
  requestVersion,
  previousNoticeCategory,
  check,
  busy,
  onCheck,
}: {
  caseId: string;
  record: AgencyRecord;
  sources: SourceDocument[];
  requestVersion?: number;
  previousNoticeCategory?: NoticeCategory;
  check?: AgencyEvidenceCheck;
  busy: boolean;
  onCheck: () => void;
}) {
  const isNotice = isAgencyNoticeRecord(record);
  return (
    <article
      id={`agency-record-${record.id}`}
      tabIndex={-1}
      className="space-y-3 rounded-xl border bg-background p-4 scroll-mt-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{recordKindLabel(record)}</Badge>
        <span className="text-xs text-muted-foreground">
          {isNotice ? "통보" : record.kind === "response" ? "답변" : "요청"} v{record.version}
          {record.kind === "response" && requestVersion ? ` · 요청 v${requestVersion} 기준` : ""}
        </span>
      </div>
      <h5 className="break-words text-sm font-semibold">{record.title}</h5>
      <p className="text-xs leading-6 text-muted-foreground">
        기관: {record.institution} · 기록 시각 {formatDate(record.recordedAt)}
      </p>
      <p className="text-xs leading-6">
        {isNotice
          ? record.kind === "notice-correction"
            ? "정정된 통보의 수신·발생일"
            : "담당자 기입 통보 수신·발생일"
          : record.kind === "response"
            ? record.responseStatus === "reported-sent"
              ? "담당자 기입 발송일"
              : "담당자 기입 발생일"
            : record.kind === "request-correction"
              ? "정정된 요청의 수신·발생일"
              : "담당자 기입 수신일"}
        : {record.occurredOn || "미기재"}
      </p>
      {!isNotice && record.kind !== "response" && (
        <div className="rounded-lg bg-muted/30 p-3 text-xs leading-6">
          <p>담당자 기입 기한: {record.dueOn || "미기재"} · 법정기한 자동 검증 아님</p>
          <p className="whitespace-pre-wrap break-words">기한 근거: {record.dueNote || "미기재"}</p>
        </div>
      )}
      {isNotice && (
        <>
          {record.kind === "notice-correction" && previousNoticeCategory && (
            <p className="text-xs leading-6 text-muted-foreground">
              정정 분류: {noticeCategoryLabels[previousNoticeCategory]} →{" "}
              {noticeCategoryLabels[record.details.category]}
            </p>
          )}
          <AgencyNoticeDetailsView details={record.details} />
          <Notice>
            담당자가 기록한 통보 내용입니다. 기관 송수신·납부 성공·심사 결과·확인서 진위 확인이나
            진행 단계 변경을 의미하지 않습니다.
          </Notice>
        </>
      )}
      <p className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm leading-7">
        {record.body}
      </p>
      {record.note && (
        <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-xs leading-6">
          {record.note}
        </p>
      )}
      {!isNotice && record.responseStatus === "reported-sent" && (
        <Notice>
          담당자가 실제 발송했다고 입력한 기록입니다. 이 앱이 발송하거나 기관 수신을 확인한 기록이
          아닙니다.
        </Notice>
      )}
      <AgencyEvidenceView
        caseId={caseId}
        evidence={record.evidence}
        sources={sources}
        check={check}
      />
      {record.evidence.length > 0 && (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCheck}>
          <FileCheck />
          연결 원본 현재 상태 확인
        </Button>
      )}
    </article>
  );
}

export function AgencyRequestTasks({
  company,
  requestRecordId,
}: {
  company: StudioCase;
  requestRecordId: string;
}) {
  const linked = company.tasks.filter(
    (task) => task.agencyOrigin?.requestRecordId === requestRecordId,
  );
  if (!linked.length) return null;
  return (
    <div className="mt-4 space-y-3 rounded-xl bg-muted/30 p-4">
      <h5 className="text-sm font-semibold">이 요청에서 연결한 업무</h5>
      {linked.map((task) => {
        const context = agencyTaskContext(company, task);
        return (
          <div key={task.id} className="space-y-1 border-t pt-3 text-xs leading-6">
            <a
              href={`#workflow-task-${task.id}`}
              className="font-semibold text-primary underline underline-offset-4"
            >
              {task.title} · 업무로 이동
            </a>
            <p>
              업무 상태: {task.status === "done" ? "담당자 표시 완료" : "진행 필요"} · 업무 기한:{" "}
              {task.dueDate || "미기재"}
            </p>
            <p>
              연결 기준:{" "}
              {context?.version ? `요청 v${context.version.version}` : "요청 버전 확인 불가"}
            </p>
            <TaskOwnersSummary owners={task.owners} />
            <TaskProcessingSummary processing={task.processing} plans={company.plans} />
            {context?.state === "updated" && (
              <p className="text-amber-800">
                요청이 v{context.latest?.version}으로 정정되었습니다. 이 업무의 기존 기한·완료
                상태는 자동 변경하지 않습니다.
              </p>
            )}
            {context?.state === "missing" && (
              <p className="text-amber-800">
                연결한 요청 원문을 찾지 못했습니다. 기록을 확인해 주세요.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

type FormState = {
  input: AgencyRecordInput;
  baseline: string;
  clientRequestId: string;
  binding: string;
};
type Props = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason: string;
  onDirtyChange: (dirty: boolean) => void;
};

export function AgencyRecords({ company, mutate, blockedReason, onDirtyChange }: Props) {
  const records = company.agencyRecords ?? [];
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [creatingTaskId, setCreatingTaskId] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, AgencyEvidenceCheck>>({});
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const context = useRef(`${company.id}:${company.revision}`);
  const binding = `${company.id}:${company.revision}`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    context.current = binding;
  }, [binding]);
  const dirty = Boolean(form && JSON.stringify(form.input) !== form.baseline);
  useDirty(dirty || saving || creatingTaskId !== null, onDirtyChange);
  const busy = saving || checkingId !== null || creatingTaskId !== null;

  function open(input: AgencyRecordInput) {
    if (
      blockedReason ||
      busy ||
      (dirty && !window.confirm("작성 중인 기관 기록을 취소하고 새 기록을 열까요?"))
    )
      return;
    setForm({
      input,
      baseline: JSON.stringify(input),
      clientRequestId: crypto.randomUUID(),
      binding,
    });
    setError("");
  }
  function edit(input: AgencyRecordInput) {
    if (form) setForm({ ...form, input });
  }
  function cancel() {
    if (!dirty || window.confirm("작성 중인 기관 기록을 취소할까요?")) {
      setForm(null);
      setError("");
    }
  }
  async function save() {
    if (!form || blockedReason || inFlight.current) return;
    if (form.binding !== binding) {
      setError(
        "기업 기록 버전이 바뀌어 이 편집본을 저장할 수 없습니다. 작성 내용을 확인한 뒤 최신 기록에서 다시 준비해 주세요.",
      );
      return;
    }
    const parsed = agencyRecordInputSchema.safeParse(form.input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "기록 내용을 확인해 주세요.");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await mutate({
        action: "append-agency-record",
        clientRequestId: form.clientRequestId,
        record: parsed.data,
      });
      if (mounted.current && context.current === binding) {
        if (saved) setForm(null);
        else
          setError(
            "기록을 저장하지 못했습니다. 작성 내용은 유지했습니다. 오류 안내와 최신 저장 상태를 확인해 주세요.",
          );
      }
    } catch (caught) {
      if (mounted.current && context.current === binding)
        setError(
          caught instanceof Error
            ? caught.message
            : "기록을 저장하지 못했습니다. 작성 내용은 유지했습니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function checkOriginal(record: AgencyRecord) {
    if (busy || inFlight.current || blockedReason) return;
    inFlight.current = true;
    setCheckingId(record.id);
    setError("");
    setChecks((current) => {
      const next = { ...current };
      delete next[record.id];
      return next;
    });
    try {
      const response = await studioFetch<AgencyEvidenceCheck>(
        `/api/studio/cases/${company.id}/agency-records/evidence?recordId=${record.id}&revision=${company.revision}`,
      );
      if (!mounted.current || context.current !== binding) return;
      const checked = validateAgencyEvidenceCheck(response, record, company.revision);
      setChecks((current) => ({ ...current, [record.id]: checked }));
    } catch (caught) {
      if (mounted.current && context.current === binding)
        setError(
          caught instanceof Error ? caught.message : "연결 원본 상태를 확인하지 못했습니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setCheckingId(null);
    }
  }
  async function createRequestTask(requestRecordId: string, requestVersionId: string) {
    if (busy || inFlight.current || blockedReason || dirty) return;
    const latest = records
      .filter(
        (record) =>
          !isAgencyNoticeRecord(record) &&
          record.kind !== "response" &&
          record.requestRecordId === requestRecordId,
      )
      .at(-1);
    if (
      !latest ||
      latest.id !== requestVersionId ||
      company.tasks.some(
        (task) =>
          task.agencyOrigin?.requestRecordId === requestRecordId &&
          task.agencyOrigin.requestVersionId === requestVersionId,
      )
    )
      return;
    if (company.tasks.length >= 200) {
      setError("업무는 200개까지 보관합니다. 기존 업무를 확인해 주세요.");
      return;
    }
    inFlight.current = true;
    setCreatingTaskId(requestVersionId);
    setError("");
    try {
      const saved = await mutate({
        action: "create-agency-task",
        requestRecordId,
        requestVersionId,
      });
      if (!mounted.current || context.current !== binding) return;
      if (!saved)
        setError(
          "업무 저장 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다. 최신 내용을 확인하거나 같은 요청 버전의 업무 추가를 다시 누르면 이미 만든 업무를 확인합니다.",
        );
    } catch (caught) {
      if (mounted.current && context.current === binding)
        setError(
          caught instanceof Error
            ? caught.message
            : "업무 저장 결과를 확인하지 못했습니다. 같은 요청 버전으로 다시 확인해 주세요.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setCreatingTaskId(null);
    }
  }
  const requestRecords = records.filter((record) => !isAgencyNoticeRecord(record));
  const roots = requestRecords.filter((record) => record.kind === "request");
  const noticeRecords = records.filter(isAgencyNoticeRecord);
  const noticeRoots = noticeRecords.filter((record) => record.kind === "notice");
  const input = form?.input;
  const recordLimitReached = records.length >= MAX_AGENCY_RECORDS;
  const requestContext =
    input && (input.kind === "response" || input.kind === "request-correction")
      ? requestRecords
          .filter(
            (record) =>
              record.requestRecordId === input.requestRecordId && record.kind !== "response",
          )
          .at(-1)
      : null;
  const noticeContext =
    input?.kind === "notice-correction"
      ? noticeRecords.find((record) => record.id === input.previousVersionId)
      : null;
  return (
    <section
      aria-label="기관 요청·답변·통보와 원본 증빙"
      className="mt-5 space-y-4 rounded-2xl border p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold">
          기관 요청·답변·통보와 원본 증빙{" "}
          <span className="text-sm font-normal text-muted-foreground">
            {records.length} / {MAX_AGENCY_RECORDS}개 기록
          </span>
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!!blockedReason || busy || recordLimitReached}
            onClick={() =>
              open({
                kind: "request",
                title: "",
                body: "",
                occurredOn: "",
                note: "",
                sourceIds: [],
                institution: "",
                dueOn: "",
                dueNote: "",
              })
            }
          >
            <Plus />
            기관 요청 기록 추가
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!!blockedReason || busy || recordLimitReached}
            onClick={() =>
              open({
                kind: "notice",
                institution: "",
                title: "",
                body: "",
                occurredOn: "",
                note: "",
                sourceIds: [],
                details: emptyAgencyNoticeDetails("payment"),
              })
            }
          >
            <Plus />
            기관 통보 기록 추가
          </Button>
        </div>
      </div>
      <Notice>
        담당자가 확인한 요청 원문과 기한, 답변 초안·발송 여부, 기관 통보를 이 PC에 기록합니다. 기관
        송수신·기한·접수 상태를 자동 검증하지 않으며 외부로 전송하지 않습니다. 원문 정정과 답변은 새
        버전으로 남기고 이전 기록은 보존합니다. 통보를 기록해도 진행 단계를 자동으로 변경하지
        않습니다.
      </Notice>
      {blockedReason && <p className="text-xs leading-6 text-muted-foreground">{blockedReason}</p>}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm leading-6 text-destructive"
        >
          {error}
        </p>
      )}
      {checkingId && (
        <p role="status" className="text-xs text-muted-foreground">
          현재 보관 원본을 읽어 등록 당시 정보와 대조하고 있습니다.
        </p>
      )}
      {form && form.binding !== binding && (
        <Notice tone="warning">
          기업 기록 버전이 바뀌어 이 편집본은 저장할 수 없습니다. 작성 내용을 확인한 뒤 최신
          기록에서 다시 준비해 주세요.
        </Notice>
      )}
      {input && (
        <fieldset
          disabled={busy || !!blockedReason || form?.binding !== binding}
          className="space-y-4 rounded-xl border border-primary/30 bg-primary/[.025] p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-semibold">
              {input.kind === "notice"
                ? "새 기관 통보 기록"
                : input.kind === "notice-correction"
                  ? "통보 정정 기록 추가"
                  : input.kind === "request"
                    ? "새 기관 요청 기록"
                    : input.kind === "request-correction"
                      ? "요청 정정 기록 추가"
                      : "답변 새 버전 기록"}
            </h4>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="기관 기록 편집 취소"
              onClick={cancel}
            >
              <X />
            </Button>
          </div>
          {requestContext && (
            <p className="text-xs leading-6 text-muted-foreground">
              기준 요청: {requestContext.title} · {requestContext.institution} · 요청 v
              {requestContext.version}
            </p>
          )}
          {noticeContext && (
            <p className="text-xs leading-6 text-muted-foreground">
              기준 통보: {noticeContext.title} · 통보 v{noticeContext.version} · 이전 분류:{" "}
              {noticeCategoryLabels[noticeContext.details.category]}
            </p>
          )}
          {(input.kind === "request-correction" || input.kind === "notice-correction") && (
            <Notice>
              기존 원문을 덮어쓰지 않습니다. 정정된 내용과 근거를 새 기록에 남기세요. 원본 증빙은
              자동으로 다시 선택하지 않습니다.
            </Notice>
          )}
          <div className="space-y-2">
            <Label htmlFor="agency-title">기록 제목 *</Label>
            <Input
              id="agency-title"
              value={input.title}
              maxLength={300}
              onChange={(event) => edit({ ...input, title: event.target.value })}
            />
          </div>
          {input.kind !== "response" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="agency-institution">기관명 *</Label>
                <Input
                  id="agency-institution"
                  value={input.institution}
                  maxLength={200}
                  onChange={(event) => edit({ ...input, institution: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agency-occurred">
                  {input.kind === "notice" || input.kind === "notice-correction"
                    ? "담당자 기입 통보 수신·발생일 (선택)"
                    : input.kind === "request-correction"
                      ? "정정된 요청 수신·발생일 (선택)"
                      : "담당자 기입 수신일 (선택)"}
                </Label>
                <Input
                  id="agency-occurred"
                  type="date"
                  value={input.occurredOn}
                  onChange={(event) => edit({ ...input, occurredOn: event.target.value })}
                />
              </div>
              {(input.kind === "request" || input.kind === "request-correction") && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="agency-due">담당자 기입 기한 (선택)</Label>
                    <Input
                      id="agency-due"
                      type="date"
                      value={input.dueOn}
                      onChange={(event) => edit({ ...input, dueOn: event.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="agency-due-note">기한 근거·확인한 안내</Label>
                    <Textarea
                      id="agency-due-note"
                      value={input.dueNote}
                      maxLength={2000}
                      onChange={(event) => edit({ ...input, dueNote: event.target.value })}
                    />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="agency-response-status">담당자 기록 구분</Label>
                <select
                  id="agency-response-status"
                  className={selectClass}
                  value={input.responseStatus}
                  onChange={(event) =>
                    edit({
                      ...input,
                      responseStatus: event.target.value as "draft" | "reported-sent",
                    })
                  }
                >
                  <option value="draft">답변 초안 · 미발송</option>
                  <option value="reported-sent">담당자가 발송했다고 기록</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="agency-occurred">
                  {input.responseStatus === "reported-sent"
                    ? "담당자 기입 발송일 *"
                    : "담당자 기입 발생일 (선택)"}
                </Label>
                <Input
                  id="agency-occurred"
                  type="date"
                  value={input.occurredOn}
                  onChange={(event) => edit({ ...input, occurredOn: event.target.value })}
                />
              </div>
            </div>
          )}
          {(input.kind === "notice" || input.kind === "notice-correction") && (
            <AgencyNoticeFields
              details={input.details}
              onChange={(details) => edit({ ...input, details })}
            />
          )}
          <div className="space-y-2">
            <Label htmlFor="agency-body">
              {input.kind === "notice" || input.kind === "notice-correction"
                ? "통보 원문·정정 내용 *"
                : input.kind === "response"
                  ? "답변 내용 *"
                  : "요청 원문·정정 내용 *"}
            </Label>
            <Textarea
              id="agency-body"
              className="min-h-40 bg-background leading-7"
              value={input.body}
              maxLength={20000}
              onChange={(event) => edit({ ...input, body: event.target.value })}
            />
            <p className="text-right text-xs text-muted-foreground">
              {input.body.length.toLocaleString()} / 20,000자
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agency-note">
              {input.kind === "response" ? "발송 방법·확인 근거·메모" : "기록·정정 근거 메모"}
            </Label>
            <Textarea
              id="agency-note"
              value={input.note}
              maxLength={2000}
              onChange={(event) => edit({ ...input, note: event.target.value })}
            />
          </div>
          <AgencySourcePicker
            sources={company.sources}
            selected={input.sourceIds}
            onChange={(sourceIds) => edit({ ...input, sourceIds })}
          />
          {input.kind === "response" && input.responseStatus === "reported-sent" && (
            <Notice>
              실제 발송 후 확인한 날짜와 근거만 기록하세요. 저장 버튼은 이메일·공식 사이트로
              발송하지 않습니다.
            </Notice>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={cancel}>
              기록 편집 취소
            </Button>
            <Button type="button" onClick={save}>
              <Save />
              {saving ? "로컬 기록 저장 중" : "로컬 기록 저장"}
            </Button>
          </div>
        </fieldset>
      )}
      <h4 className="text-sm font-semibold">기관 요청·답변</h4>
      {!roots.length && (
        <p className="text-sm leading-6 text-muted-foreground">
          아직 기관 요청 기록이 없습니다. 확인한 원문이나 보관 원본부터 연결하세요.
        </p>
      )}
      {[...roots].reverse().map((root) => {
        const related = requestRecords.filter((record) => record.requestRecordId === root.id);
        const currentRequest =
          related.filter((record) => record.kind !== "response").at(-1) ?? root;
        const latestResponse = related.filter((record) => record.kind === "response").at(-1);
        const currentTask = company.tasks.find(
          (task) =>
            task.agencyOrigin?.requestRecordId === root.id &&
            task.agencyOrigin.requestVersionId === currentRequest.id,
        );
        return (
          <details key={root.id} className="rounded-xl border p-4" open>
            <summary className="cursor-pointer text-sm font-semibold">
              {currentRequest.title} · {currentRequest.institution} · 요청 v{currentRequest.version}
            </summary>
            <AgencyRequestTasks company={company} requestRecordId={root.id} />
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  busy || !!blockedReason || dirty || !!currentTask || company.tasks.length >= 200
                }
                onClick={() => void createRequestTask(root.id, currentRequest.id)}
              >
                <Plus />
                {currentTask
                  ? `요청 v${currentRequest.version} 업무 이미 등록됨`
                  : creatingTaskId === currentRequest.id
                    ? "업무 연결 중…"
                    : `요청 v${currentRequest.version} 업무 추가`}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !!blockedReason || recordLimitReached}
                onClick={() =>
                  open({
                    kind: "request-correction",
                    requestRecordId: root.id,
                    previousVersionId: currentRequest.id,
                    title: currentRequest.title,
                    body: currentRequest.body,
                    institution: currentRequest.institution,
                    dueOn: currentRequest.dueOn,
                    dueNote: currentRequest.dueNote,
                    occurredOn: currentRequest.occurredOn,
                    note: "",
                    sourceIds: [],
                  })
                }
              >
                요청 정정 기록 추가
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !!blockedReason || recordLimitReached}
                onClick={() =>
                  open({
                    kind: "response",
                    requestRecordId: root.id,
                    previousVersionId: latestResponse?.id ?? null,
                    title: latestResponse?.title ?? `${currentRequest.title} 답변`.slice(0, 300),
                    body: latestResponse?.body ?? "",
                    occurredOn: "",
                    note: "",
                    sourceIds: [],
                    responseStatus: "draft",
                  })
                }
              >
                답변 새 버전 기록
              </Button>
            </div>
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              현재 요청 버전의 기한을 업무에 처음 기록합니다. 요청 정정 후에도 이전 업무의 기한·완료
              상태를 덮어쓰지 않습니다. 업무 추가는 답변 발송·기관 수신·진행 단계 변경이 아닙니다.
            </p>
            <div className="mt-4 space-y-3">
              {[...related].reverse().map((record) => (
                <AgencyRecordView
                  key={record.id}
                  caseId={company.id}
                  record={record}
                  sources={company.sources}
                  requestVersion={
                    records.find((candidate) => candidate.id === record.requestVersionId)?.version
                  }
                  check={
                    checks[record.id]?.caseRevision === company.revision
                      ? checks[record.id]
                      : undefined
                  }
                  busy={busy || !!blockedReason}
                  onCheck={() => void checkOriginal(record)}
                />
              ))}
            </div>
          </details>
        );
      })}
      <h4 className="text-sm font-semibold">기관 통보</h4>
      <p className="text-xs leading-6 text-muted-foreground">
        납부·접수·현장실사·심사 결과·확인서 통보를 담당자가 기록합니다. 선택한 분류나 기재된 문구는
        앱의 성공·진위 판정이 아닙니다.
      </p>
      {!noticeRoots.length && (
        <p className="text-sm leading-6 text-muted-foreground">
          아직 기관 통보 기록이 없습니다. 확인한 원문과 증빙을 기록하고 모르는 상세값은 비워 두세요.
        </p>
      )}
      {[...noticeRoots].reverse().map((root) => {
        const related = noticeRecords.filter((record) => record.noticeRecordId === root.id);
        const currentNotice = related.at(-1) ?? root;
        return (
          <details key={root.id} className="rounded-xl border p-4" open>
            <summary className="cursor-pointer text-sm font-semibold">
              {currentNotice.title} · {currentNotice.institution} ·{" "}
              {noticeCategoryLabels[currentNotice.details.category]} · 통보 v{currentNotice.version}
            </summary>
            <div className="mt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !!blockedReason || recordLimitReached}
                onClick={() =>
                  open({
                    kind: "notice-correction",
                    noticeRecordId: root.id,
                    previousVersionId: currentNotice.id,
                    title: currentNotice.title,
                    body: currentNotice.body,
                    institution: currentNotice.institution,
                    occurredOn: currentNotice.occurredOn,
                    details: { ...currentNotice.details },
                    note: "",
                    sourceIds: [],
                  })
                }
              >
                통보 정정 기록 추가
              </Button>
            </div>
            <div className="mt-4 space-y-3">
              {[...related].reverse().map((record) => (
                <AgencyRecordView
                  key={record.id}
                  caseId={company.id}
                  record={record}
                  sources={company.sources}
                  previousNoticeCategory={
                    related.find((candidate) => candidate.id === record.previousVersionId)?.details
                      .category
                  }
                  check={
                    checks[record.id]?.caseRevision === company.revision
                      ? checks[record.id]
                      : undefined
                  }
                  busy={busy || !!blockedReason}
                  onCheck={() => void checkOriginal(record)}
                />
              ))}
            </div>
          </details>
        );
      })}
    </section>
  );
}
