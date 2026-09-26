"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StudioCase } from "@/lib/studio-schema";
import { isAgencyNoticeRecord, type AgencyRecord } from "@/lib/studio-agency-records";
import { applicationMetadata } from "@/lib/studio-application-types";
import {
  applicationProcedureInputSchema,
  applicationProcedureLimits,
  extensionStatusLabels,
  procedureStatusLabels,
  procedureTypeLabels,
  type ApplicationProcedure,
  type ApplicationProcedureInput,
} from "@/lib/studio-application-procedure-types";
import { AppealEvidenceEditor } from "./appeal-preparation";
import { ApplicationAgencyRecordView } from "./application-history";
import { Notice, formatDate, selectClass, useDirty, type PanelProps } from "./shared";
import {
  applicationProcedureInputProblem,
  applicationProcedureSaveAcknowledged,
  applicationProcedureUiContext,
  emptyApplicationProcedure,
  latestApplicationProcedures,
  procedureAgencyChoices,
} from "./application-procedures-ui";

const textFields = [
  ["requester", "요청 주체·담당자 (미확인 시 공란)", 200],
  ["dueBasis", "안내기한 근거", 2000],
  ["extensionBasis", "연장 상태·일자·기한을 기록한 근거", 2000],
  ["statusBasis", "진행 상태 근거", 2000],
  ["completionBasis", "완료됐다고 기록할 근거", 2000],
  ["note", "추가 메모", 2000],
] as const;
const dateFields = [
  ["requestedOn", "요청일"],
  ["dueOn", "안내기한"],
  ["extensionRequestedOn", "연장 요청일"],
  ["extensionDecidedOn", "연장 결과 기록일"],
  ["extendedDueOn", "연장됐다고 기록한 기한"],
] as const;

function ProcedureAgencySnapshot({ record }: { record: AgencyRecord }) {
  return (
    <div className="space-y-2 text-xs leading-6">
      <ApplicationAgencyRecordView record={record} />
      <p>기관 기록의 기입 발생일: {record.occurredOn || "미확인"}</p>
      {!isAgencyNoticeRecord(record) && record.kind !== "response" && (
        <>
          <p>기관 요청에 기입한 기한: {record.dueOn || "미확인"}</p>
          <p className="whitespace-pre-wrap break-words">
            기관 요청의 기한 근거: {record.dueNote || "미확인"}
          </p>
        </>
      )}
      <p className="whitespace-pre-wrap break-words">기관 기록 메모: {record.note || "미기입"}</p>
      {record.evidence.map((source) => (
        <details key={source.sourceId} className="rounded border p-2">
          <summary className="cursor-pointer break-words">
            기관 기록 당시 연결 원본: {source.originalName}
          </summary>
          <p className="break-words">
            {source.sourceName} · {source.sizeBytes.toLocaleString()}바이트 ·{" "}
            {source.mimeType || "형식 미기입"}
          </p>
          <p className="break-all">보관 당시 SHA-256: {source.sha256}</p>
        </details>
      ))}
    </div>
  );
}

export function ApplicationProcedureFields({
  input,
  onChange,
}: {
  input: ApplicationProcedureInput;
  onChange: (input: ApplicationProcedureInput) => void;
}) {
  const prefix = useId();
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-title`}>절차 기록 제목 *</Label>
        <Input
          id={`${prefix}-title`}
          value={input.title}
          maxLength={200}
          onChange={(event) => onChange({ ...input, title: event.target.value })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {(
          [
            ["procedureType", "절차 분류", procedureTypeLabels],
            ["extensionStatus", "연장 상태 (담당자 기록)", extensionStatusLabels],
            ["status", "진행 상태 (담당자 기록)", procedureStatusLabels],
          ] as const
        ).map(([key, label, labels]) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
            <select
              id={`${prefix}-${key}`}
              className={selectClass}
              value={input[key]}
              onChange={(event) => onChange({ ...input, [key]: event.target.value })}
            >
              {Object.entries(labels).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <p className="text-xs leading-6 text-muted-foreground">
        모르는 날짜는 비워 두세요. 기한을 자동 계산하거나 기관 기록의 날짜를 대신 채우지 않습니다.
        연장 기한은 ‘허용됐다고 기록’을 선택한 경우에만 저장할 수 있습니다.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {dateFields.map(([key, label]) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`${prefix}-${key}`}>{label} (선택)</Label>
            <Input
              id={`${prefix}-${key}`}
              type="date"
              value={input[key]}
              onInput={(event) => onChange({ ...input, [key]: event.currentTarget.value })}
              onChange={(event) => onChange({ ...input, [key]: event.target.value })}
            />
          </div>
        ))}
      </div>
      {textFields.map(([key, label, maxLength]) => (
        <div key={key} className="space-y-2">
          <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
          <Textarea
            id={`${prefix}-${key}`}
            value={input[key]}
            maxLength={maxLength}
            onChange={(event) => onChange({ ...input, [key]: event.target.value })}
          />
        </div>
      ))}
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-recordedBy`}>기록 담당자 *</Label>
        <Input
          id={`${prefix}-recordedBy`}
          value={input.recordedBy}
          maxLength={100}
          onChange={(event) => onChange({ ...input, recordedBy: event.target.value })}
        />
      </div>
    </div>
  );
}

function ProcedureContext({
  company,
  record,
}: {
  company: StudioCase;
  record: ApplicationProcedure;
}) {
  const [result, setResult] = useState<{ binding: string; reasons: string[] } | null>(null);
  const binding = `${company.id}:${company.revision}:${record.id}`;
  useEffect(() => {
    let active = true;
    void applicationProcedureUiContext(company, record).then(
      (reasons) => {
        if (active) setResult({ binding, reasons });
      },
      () => {
        if (active) setResult({ binding, reasons: ["현재 연결 상태를 확인하지 못했습니다."] });
      },
    );
    return () => {
      active = false;
    };
  }, [company, record, binding]);
  const reasons = result?.binding === binding ? result.reasons : null;
  return (
    <div className="rounded-lg bg-muted/40 p-3 text-xs leading-6">
      {reasons === null ? (
        <p>현재 연결 대조 전</p>
      ) : reasons.length ? (
        <ul className="list-disc pl-4 text-amber-800">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : (
        <p>현재 앱에 저장된 회차·귀속·기관 기록·추가 증빙 본문과 일치합니다.</p>
      )}
      <p className="text-muted-foreground">
        원본 파일의 현재 바이트와 기관 수신·연장 승인·절차 효력은 이 표시로 확인하지 않습니다.
      </p>
    </div>
  );
}

export function ApplicationProcedureView({
  company,
  record,
}: {
  company: StudioCase;
  record: ApplicationProcedure;
}) {
  return (
    <article
      id={`application-procedure-${record.id}`}
      tabIndex={-1}
      className="scroll-mt-24 space-y-3 rounded-xl border p-4 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="font-semibold">
          {record.title} · v{record.version}
        </h5>
        <Badge variant="outline">담당자 수동 기록 · 기관 미확인</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        보관 당시 회차: {record.applicationTitle} · 기록 담당자: {record.recordedBy} · 앱 보관 시각:{" "}
        {formatDate(record.recordedAt)}
      </p>
      <dl className="grid gap-3 text-xs leading-6 sm:grid-cols-2">
        {(
          [
            ["절차 분류", procedureTypeLabels[record.procedureType]],
            ["연장 상태", extensionStatusLabels[record.extensionStatus]],
            ["진행 상태", procedureStatusLabels[record.status]],
            ...dateFields.map(([key, label]) => [label, record[key]]),
            ...textFields.map(([key, label]) => [label, record[key]]),
          ] as Array<[string, string]>
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="whitespace-pre-wrap break-words">{value || "미확인"}</dd>
          </div>
        ))}
      </dl>
      <ProcedureContext company={company} record={record} />
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">
          보관 당시 기관 원문 v{record.agencySnapshot.version}·추가 증빙
        </summary>
        <div className="mt-3 space-y-3">
          <ProcedureAgencySnapshot record={record.agencySnapshot} />
          {record.sourceSnapshots.length === 0 && (
            <p className="text-xs text-muted-foreground">별도로 연결한 추가 증빙 없음</p>
          )}
          {record.sourceSnapshots.map((source) => {
            const reference = record.evidence.find((item) => item.sourceId === source.sourceId);
            return (
              <div key={source.sourceId} className="rounded-lg border p-3 text-xs leading-6">
                <p className="font-medium">{source.sourceName}</p>
                <p>보관 당시 자료 수정 시각: {formatDate(source.sourceUpdatedAt)}</p>
                <p className="whitespace-pre-wrap break-words">
                  인용: {reference?.quote || "본문 인용 없음 · 원본만 연결"}
                </p>
                <p className="whitespace-pre-wrap break-words">
                  기입 위치: {reference?.locator || "미기입"}
                </p>
                {source.extraction === "pending" && <p>원본만 보관한 자료 · 본문 검토 완료 아님</p>}
                {source.original && (
                  <>
                    <p className="break-words">
                      보관 당시 원본: {source.original.originalName} ·{" "}
                      {source.original.sizeBytes.toLocaleString()}바이트 ·{" "}
                      {source.original.mimeType || "형식 미기입"}
                    </p>
                    <details>
                      <summary className="cursor-pointer">보관 당시 SHA-256</summary>
                      <p className="break-all">{source.original.sha256}</p>
                    </details>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </details>
    </article>
  );
}

type Props = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason: string;
  onDirtyChange: (dirty: boolean) => void;
};
type Form = {
  input: ApplicationProcedureInput;
  baseline: string;
  nonce: string;
  attempted: string | null;
  confirmed: boolean;
};
export function ApplicationProcedures(props: Props) {
  return (
    <ApplicationProceduresBody key={`${props.company.id}:${props.company.revision}`} {...props} />
  );
}
function ApplicationProceduresBody({ company, mutate, blockedReason, onDirtyChange }: Props) {
  const prefix = useId();
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false),
    inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty =
    !!form && (!!form.attempted || form.confirmed || JSON.stringify(form.input) !== form.baseline);
  useDirty(dirty, onDirtyChange);
  const records = company.applicationProcedures ?? [],
    latest = latestApplicationProcedures(records);
  const blocked = saving || !!blockedReason;
  const previous = form?.input.procedureId
    ? latest.find((record) => record.procedureId === form.input.procedureId)
    : null;
  const choices = form ? procedureAgencyChoices(company, form.input.applicationId, previous) : [];
  const selectedAgency = choices.find((entry) => entry.agency.id === form?.input.agencyVersionId);
  function open(record?: ApplicationProcedure) {
    if (
      blocked ||
      inFlight.current ||
      (dirty && !window.confirm("저장하지 않은 절차 편집을 닫고 다른 기록을 열까요?"))
    )
      return;
    const input = emptyApplicationProcedure(record);
    setForm({
      input,
      baseline: JSON.stringify(input),
      nonce: crypto.randomUUID(),
      attempted: null,
      confirmed: false,
    });
    setError("");
  }
  function edit(input: ApplicationProcedureInput) {
    if (form && !blocked && !form.attempted) {
      setForm({ ...form, input, confirmed: false });
      setError("");
    }
  }
  function cancel() {
    if (saving || inFlight.current) return;
    if (
      dirty &&
      !window.confirm(
        form?.attempted
          ? "저장됐을 수 있습니다. 최신 기록을 확인한 뒤 새 기록을 작성하세요. 이 편집본을 닫을까요?"
          : "저장하지 않은 절차 편집을 취소할까요?",
      )
    )
      return;
    setForm(null);
    setError("");
  }
  async function save() {
    if (!form || blocked || inFlight.current || !form.confirmed) return;
    const problem = applicationProcedureInputProblem(company, form.input);
    if (problem) {
      setError(problem);
      return;
    }
    const input = applicationProcedureInputSchema.parse(form.input),
      payload = JSON.stringify(input);
    if (form.attempted && form.attempted !== payload) {
      setError("저장 결과 확인 전에는 같은 요청의 내용을 변경할 수 없습니다.");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError("");
    setForm({ ...form, attempted: payload });
    try {
      const saved = await mutate({
        action: "append-application-procedure",
        clientRequestId: form.nonce,
        procedure: input,
      });
      if (!mounted.current) return;
      const acknowledged =
        saved && (await applicationProcedureSaveAcknowledged(saved, company, form.nonce, input));
      if (!mounted.current) return;
      if (acknowledged) setForm(null);
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
  return (
    <section aria-label="회차별 절차·안내기한" className="mt-5 space-y-4 rounded-2xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold">회차별 절차·안내기한</h3>
        <Button
          type="button"
          variant="outline"
          disabled={
            blocked ||
            company.applications.length === 0 ||
            records.length >= applicationProcedureLimits.versions
          }
          onClick={() => open()}
        >
          절차 기록 추가
        </Button>
      </div>
      <Notice>
        정확한 신청 회차와 귀속된 기관 요청·통보 버전을 선택해 담당자가 기록합니다.
        안내기한·연장·완료 기록은 법정기한 계산이나 기관 승인·수신 확인이 아닙니다. 회사 진행 단계와
        기존 업무 기한·완료 상태는 바뀌지 않습니다.
      </Notice>
      <p className="text-xs text-muted-foreground">
        절차 이력 {records.length}/{applicationProcedureLimits.versions}개 · 미입력 날짜·내용은
        미확인으로 보존합니다.
      </p>
      {company.applications.length === 0 && (
        <p className="text-sm">
          먼저 신청 회차를 등록하고 기관 요청·통보를 해당 회차에 연결해 주세요.
        </p>
      )}
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
      {form && (
        <section
          aria-label={previous ? "절차 기록 정정" : "새 절차 기록"}
          className="space-y-4 rounded-xl border border-primary/30 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-semibold">
              {previous ? `절차 기록 v${previous.version}에서 새 버전 작성` : "새 절차 기록"}
            </h4>
            <Button type="button" variant="ghost" disabled={saving} onClick={cancel}>
              절차 편집 취소
            </Button>
          </div>
          {previous && (
            <Notice>
              기존 기입값을 복사했습니다. 회차 정보와 최신 기관 원문은 다시 선택하고, 필요한 추가
              증빙도 새로 연결하세요. 과거 기록과 원문은 보존됩니다.
            </Notice>
          )}
          {form.attempted && (
            <Notice tone="warning">
              요청한 내용과 요청 번호를 유지합니다. 내용 변경 없이 저장 확인만 다시 할 수 있습니다.
            </Notice>
          )}
          <fieldset disabled={blocked || !!form.attempted} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-application`}>신청 회차의 현재 정보 *</Label>
              <select
                id={`${prefix}-application`}
                className={selectClass}
                value={form.input.applicationMetadataVersionId ? form.input.applicationId : ""}
                onChange={(event) => {
                  const cycle = applicationMetadata(company, event.target.value);
                  edit({
                    ...form.input,
                    applicationId: cycle?.id ?? "",
                    applicationMetadataVersionId: cycle?.metadataVersionId ?? "",
                    agencyVersionId: "",
                    expectedLinkEventId: "",
                  });
                }}
              >
                <option value="">회차를 직접 선택하세요</option>
                {company.applications
                  .filter((cycle) => !previous || cycle.id === previous.applicationId)
                  .map((cycle) => {
                    const current = applicationMetadata(company, cycle.id);
                    return (
                      <option key={cycle.id} value={cycle.id}>
                        {current?.title ?? cycle.title} · 현재 정보
                      </option>
                    );
                  })}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-agency`}>
                이 회차에 귀속된 기관 요청·통보의 최신 버전 *
              </Label>
              <select
                id={`${prefix}-agency`}
                className={selectClass}
                value={form.input.agencyVersionId}
                disabled={!form.input.applicationMetadataVersionId}
                onChange={(event) => {
                  const choice = choices.find((entry) => entry.agency.id === event.target.value);
                  edit({
                    ...form.input,
                    agencyVersionId: choice?.agency.id ?? "",
                    expectedLinkEventId: choice?.link.id ?? "",
                  });
                }}
              >
                <option value="">기관 원문 버전을 직접 선택하세요</option>
                {choices.map(({ agency }) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.title} · v{agency.version} · {agency.institution}
                  </option>
                ))}
              </select>
            </div>
            {form.input.applicationMetadataVersionId && choices.length === 0 && (
              <p className="text-sm text-amber-800">
                선택할 현재 기관 기록이 없습니다. 신청 회차 이력에서 기관 기록 귀속을 먼저 확인해
                주세요. 절차 정정은 기존 기관 체인 안에서만 가능합니다.
              </p>
            )}
            {selectedAgency && (
              <div className="rounded-lg border p-3">
                <h5 className="mb-2 text-sm font-semibold">이번 기록에 연결할 원문</h5>
                <ProcedureAgencySnapshot record={selectedAgency.agency} />
              </div>
            )}
            <ApplicationProcedureFields input={form.input} onChange={edit} />
            <AppealEvidenceEditor
              company={company}
              prefix={`${prefix}-evidence`}
              label="추가 증빙·정확한 인용 (선택)"
              references={form.input.evidence}
              maxReferences={applicationProcedureLimits.sources}
              onChange={(evidence) => edit({ ...form.input, evidence })}
            />
            <label className="flex items-start gap-2 text-sm leading-6">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.confirmed}
                onChange={(event) => setForm({ ...form, confirmed: event.target.checked })}
              />
              선택한 회차·기관 원문과 기입한 기한·상태·근거를 직접 대조했습니다. 담당자 기록으로
              보관합니다.
            </label>
          </fieldset>
          <Button type="button" disabled={blocked || !form.confirmed} onClick={() => void save()}>
            {saving
              ? "저장 확인 중"
              : form.attempted
                ? "같은 내용으로 저장 확인"
                : "담당자 절차 기록 저장"}
          </Button>
        </section>
      )}
      {company.applications.map((cycle) => {
        const group = latest.filter((record) => record.applicationId === cycle.id);
        return (
          <section
            key={cycle.id}
            id={`application-procedures-${cycle.id}`}
            tabIndex={-1}
            className="scroll-mt-24 space-y-3 rounded-xl bg-muted/20 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-semibold">
                {applicationMetadata(company, cycle.id)?.title ?? cycle.title} · 절차 기록
              </h4>
              <a
                href={`#application-cycle-${cycle.id}`}
                className="text-xs text-primary underline underline-offset-4"
              >
                신청 회차·귀속 이력 보기
              </a>
            </div>
            {group.length === 0 && (
              <p className="text-sm text-muted-foreground">
                이 회차에 보관한 절차 기록이 없습니다.
              </p>
            )}
            {group.map((record) => (
              <div key={record.id} className="space-y-2">
                <ApplicationProcedureView company={company} record={record} />
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    blocked ||
                    records.length >= applicationProcedureLimits.versions ||
                    procedureAgencyChoices(company, cycle.id, record).length === 0
                  }
                  onClick={() => open(record)}
                >
                  새 버전으로 정정
                </Button>
                {records.some(
                  (item) => item.procedureId === record.procedureId && item.id !== record.id,
                ) && (
                  <details className="rounded-lg border p-3">
                    <summary className="cursor-pointer text-sm">과거 절차 버전 보기</summary>
                    <div className="mt-3 space-y-3">
                      {records
                        .filter(
                          (item) =>
                            item.procedureId === record.procedureId && item.id !== record.id,
                        )
                        .map((item) => (
                          <ApplicationProcedureView key={item.id} company={company} record={item} />
                        ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
          </section>
        );
      })}
    </section>
  );
}
