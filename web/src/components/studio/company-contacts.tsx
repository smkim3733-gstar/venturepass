"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import {
  companyContactsInputSchema,
  companyContactsLabels,
  companyContactsLimits,
  emptyCompanyContacts,
  latestCompanyContacts,
  type CompanyContactsFields,
  type CompanyContactsInput,
  type CompanyContactsRecord,
} from "@/lib/studio-company-contacts-types";
import { Notice, formatDate, selectClass, useDirty, type PanelProps } from "./shared";

export function companyContactsEditorInput(
  record: CompanyContactsRecord | null,
): CompanyContactsInput {
  return {
    previousVersionId: record?.id ?? null,
    contacts: record ? structuredClone(record.contacts) : emptyCompanyContacts(),
  };
}

export function companyContactsSaveAcknowledged(
  response: StudioCase | null,
  company: StudioCase,
  clientRequestId: string,
  raw: CompanyContactsInput,
): boolean {
  const savedCase = caseSchema.safeParse(response),
    originalCase = caseSchema.safeParse(company);
  const input = companyContactsInputSchema.safeParse(raw);
  if (!savedCase.success || !originalCase.success || !input.success) return false;
  const saved = savedCase.data,
    original = originalCase.data;
  if (saved.id !== original.id || saved.revision <= original.revision) return false;
  const previous = original.companyContacts,
    records = saved.companyContacts;
  if (previous.length >= companyContactsLimits.records) return false;
  for (const list of [previous, records])
    for (const key of ["id", "version", "clientRequestId"] as const)
      if (new Set(list.map((record) => record[key])).size !== list.length) return false;
  const prior = latestCompanyContacts(original);
  if (previous.some((record) => record.version > (prior?.version ?? 0))) return false;
  const matches = records.filter((record) => record.clientRequestId === clientRequestId);
  if (matches.length !== 1) return false;
  const record = matches[0];
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    record.previousVersionId !== input.data.previousVersionId ||
    record.version !== (prior?.version ?? 0) + 1 ||
    (prior?.id ?? null) !== input.data.previousVersionId ||
    !equal(record.contacts, input.data.contacts) ||
    !equal(records, [...previous, record])
  )
    return false;
  for (const key of [
    "profile",
    "sources",
    "analysis",
    "selectedCandidateId",
    "candidateSelections",
    "plans",
    "planReviewDecisions",
    "tasks",
    "agencyRecords",
    "applications",
    "applicationEvents",
    "stage",
    "stageHistory",
    "diagnosisAnswers",
    "diagnoses",
  ] as const)
    if (!equal(saved[key], original[key])) return false;
  return true;
}

const contactKeys = Object.keys(companyContactsLabels) as (keyof CompanyContactsFields)[];
const roleKeys = new Set<keyof CompanyContactsFields>([
  "materialsOwner",
  "finalReviewOwner",
  "paymentOwner",
]);

export function CompanyContactsRecordView({ record }: { record: CompanyContactsRecord }) {
  return (
    <article
      className="space-y-3 rounded-xl border p-4"
      aria-label={`연락처·담당 역할 v${record.version}`}
    >
      <h4 className="text-sm font-semibold">연락처·담당 역할 v{record.version}</h4>
      <p className="text-xs text-muted-foreground">
        {formatDate(record.recordedAt)} · 담당자 직접 기록 · 연락 가능 여부 미확인
      </p>
      <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-2">
        {contactKeys.map((key) => (
          <div key={key} className={key === "note" ? "min-w-0 sm:col-span-2" : "min-w-0"}>
            <dt className="mb-1 text-xs font-semibold text-muted-foreground">
              {companyContactsLabels[key]}
            </dt>
            <dd className="whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">
              {record.contacts[key] || "미확인"}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function CompanyContactsComparison({ records }: { records: CompanyContactsRecord[] }) {
  const [selectedId, setSelectedId] = useState("");
  const prefix = useId();
  const latest = records.at(-1);
  if (!latest || records.length < 2) return null;
  const matches = records.filter((record) => record.id === selectedId);
  const previous = matches.length === 1 && matches[0] !== latest ? matches[0] : null;
  const changed = previous
    ? contactKeys.filter((key) => previous.contacts[key] !== latest.contacts[key])
    : [];
  return (
    <section
      aria-label="연락 메모 변경 비교"
      className="mt-3 min-w-0 space-y-3 rounded-xl border p-4"
    >
      <h4 className="text-sm font-semibold">저장한 연락 메모 비교</h4>
      <p id={prefix + "-help"} className="text-xs leading-6 text-muted-foreground">
        과거 버전을 직접 선택하면 현재 화면의 마지막 저장 버전과 다른 입력만 표시합니다. 편집 중인
        입력은 포함하지 않습니다.
      </p>
      <Label htmlFor={prefix + "-version"}>비교할 과거 연락 메모</Label>
      <select
        id={prefix + "-version"}
        className={selectClass}
        value={selectedId}
        aria-describedby={prefix + "-help"}
        onChange={(event) => setSelectedId(event.target.value)}
      >
        <option value="">과거 버전 선택</option>
        {records
          .slice(0, -1)
          .reverse()
          .map((record, index) => (
            <option key={record.id + "-" + index} value={record.id}>
              과거 v{record.version} · {formatDate(record.recordedAt)}
            </option>
          ))}
      </select>
      {!selectedId ? (
        <p className="text-sm">비교할 과거 버전을 직접 선택해 주세요.</p>
      ) : !previous ? (
        <p role="alert" className="text-sm text-amber-900">
          선택한 과거 기록을 하나로 확인할 수 없어 비교하지 않았습니다.
        </p>
      ) : (
        <>
          <p className="text-sm font-medium">
            v{previous.version} → 마지막 저장 v{latest.version} · 다른 항목 {changed.length} /{" "}
            {contactKeys.length}개
          </p>
          {changed.length === 0 && (
            <p className="text-sm">{contactKeys.length}개 입력이 모두 같습니다.</p>
          )}
          {changed.map((key) => (
            <article
              key={key}
              aria-label={companyContactsLabels[key] + " 변경"}
              className="min-w-0 space-y-2 rounded-lg bg-muted/30 p-3"
            >
              <h5 className="text-sm font-semibold">{companyContactsLabels[key]}</h5>
              <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
                {[
                  ["과거 v" + previous.version, previous.contacts[key]],
                  ["마지막 저장 v" + latest.version, latest.contacts[key]],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="mb-1 text-xs text-muted-foreground">{label}</dt>
                    <dd className="whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">
                      {value === "" ? "기록 없음" : value}
                    </dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </>
      )}
    </section>
  );
}

export function CompanyContactsFieldsEditor({
  value,
  onChange,
}: {
  value: CompanyContactsFields;
  onChange: (value: CompanyContactsFields) => void;
}) {
  const prefix = useId();
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
      {contactKeys.map((key) => {
        const id = `${prefix}-${key}`;
        const maximum = key === "note" ? 2000 : roleKeys.has(key) ? 100 : 500;
        return (
          <div key={key} className={`min-w-0 space-y-2 ${key === "note" ? "sm:col-span-2" : ""}`}>
            <Label htmlFor={id}>{companyContactsLabels[key]} (선택)</Label>
            {roleKeys.has(key) ? (
              <Input
                id={id}
                value={value[key]}
                maxLength={maximum}
                onChange={(event) => onChange({ ...value, [key]: event.target.value })}
              />
            ) : (
              <Textarea
                id={id}
                className="min-w-0 max-w-full"
                value={value[key]}
                maxLength={maximum}
                onChange={(event) => onChange({ ...value, [key]: event.target.value })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

type Props = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason?: string;
  onDirtyChange: (dirty: boolean) => void;
};
export function CompanyContacts(props: Props) {
  return <CompanyContactsPanel key={`${props.company.id}:${props.company.revision}`} {...props} />;
}

function CompanyContactsPanel({ company, mutate, blockedReason = "", onDirtyChange }: Props) {
  const [editor, setEditor] = useState<CompanyContactsInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const inFlight = useRef(false),
    mounted = useRef(true);
  const nonce = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useDirty(editor !== null, onDirtyChange);
  const records = company.companyContacts ?? [];
  const latest = latestCompanyContacts(company);
  const atLimit = records.length >= companyContactsLimits.records;
  const blocked = Boolean(blockedReason) || saving;

  async function save() {
    if (!editor || blocked || inFlight.current || atLimit) return;
    const parsed = companyContactsInputSchema.safeParse(editor);
    if (!parsed.success) {
      setError("연락 메모와 담당자 항목의 길이·형식을 확인해 주세요.");
      return;
    }
    const payload = JSON.stringify(parsed.data);
    if (!nonce.current || nonce.current.payload !== payload)
      nonce.current = { payload, id: crypto.randomUUID() };
    const requestId = nonce.current.id;
    inFlight.current = true;
    setSaving(true);
    setAttempted(true);
    setError("");
    try {
      const response = await mutate({
        action: "append-company-contacts",
        clientRequestId: requestId,
        ...parsed.data,
      });
      if (!mounted.current) return;
      if (companyContactsSaveAcknowledged(response, company, requestId, parsed.data)) {
        setEditor(null);
        nonce.current = null;
        setAttempted(false);
      } else
        setError(
          "저장 결과를 확인하지 못했습니다. 입력은 유지합니다. 같은 내용으로 결과를 확인하거나 최신 기업 기록을 확인해 주세요.",
        );
    } catch {
      if (mounted.current)
        setError(
          "저장 결과를 확인하지 못했습니다. 같은 내용의 재확인에는 기존 요청 번호를 사용합니다. 자동 재시도하지 않습니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <section
      aria-label="기업 연락처·신청 담당 역할"
      className="mt-8 space-y-4 rounded-2xl border p-5"
    >
      <h3 className="font-bold">연락처·신청 담당 역할</h3>
      <p className="text-sm leading-6 text-muted-foreground">
        기업 차원의 연락 메모를 별도 보관합니다. 기존 서류·요청별 담당자에서 자동 복사하지 않으며,
        빈 값은 미확인으로 남깁니다.
      </p>
      <Notice>
        담당자 기록은 계정 권한·알림 발송 동의·납부 승인·검토 완료가 아닙니다. 기본
        분석·원고·진단·제출 준비 묶음에 자동 포함하지 않습니다.
      </Notice>
      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {atLimit && (
        <Notice tone="warning">
          연락 메모 {companyContactsLimits.records}개 버전 한도입니다. 과거 기록을 보존하며 새
          기록은 추가할 수 없습니다.
        </Notice>
      )}
      {latest ? (
        <CompanyContactsRecordView record={latest} />
      ) : (
        <p className="text-sm text-muted-foreground">
          아직 기록한 연락처·신청 담당 역할이 없습니다. 기존 기업의 연락처나 담당자를 추정하지
          않습니다.
        </p>
      )}
      {!editor && (
        <Button
          type="button"
          variant="outline"
          disabled={blocked || atLimit}
          onClick={() => {
            if (blocked || inFlight.current) return;
            setEditor(companyContactsEditorInput(latest));
            setError("");
            setAttempted(false);
            nonce.current = null;
          }}
        >
          {latest ? "연락 메모 새 버전 작성" : "연락처·담당 역할 기록"}
        </Button>
      )}
      {editor && (
        <fieldset
          disabled={blocked}
          className="min-w-0 space-y-4 rounded-xl border bg-muted/20 p-4"
        >
          <legend className="px-2 text-sm font-semibold">
            {latest ? `v${latest.version}의 정정·새 버전` : "첫 연락 메모"}
          </legend>
          <p className="text-xs leading-6">
            확인한 정보만 직접 입력하세요. 공란으로 정정할 수 있으며 이전 버전은 보존합니다.
            전화·이메일 형식을 자동 변환하거나 수신 가능한 주소로 검증하지 않습니다.
          </p>
          <CompanyContactsFieldsEditor
            value={editor.contacts}
            onChange={(contacts) => {
              if (blocked || inFlight.current) return;
              setEditor({ ...editor, contacts });
              setError("");
            }}
          />
          {attempted && !saving && (
            <p className="text-xs text-amber-900">
              이전 요청이 저장됐을 수 있습니다. 같은 내용은 같은 요청 번호로 확인합니다. 내용을
              바꾸면 새 요청이 되므로 최신 기록을 먼저 확인해 주세요.
            </p>
          )}
          {error && (
            <div role="alert">
              <Notice tone="warning">{error}</Notice>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={atLimit} onClick={() => void save()}>
              {saving ? "연락 메모 저장 중" : "연락 메모 새 버전 저장"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (inFlight.current || blocked) return;
                if (
                  (attempted ||
                    JSON.stringify(editor) !==
                      JSON.stringify(companyContactsEditorInput(latest))) &&
                  !window.confirm(
                    attempted
                      ? "저장됐을 수 있는 요청이 있습니다. 편집을 닫고 최신 기록을 확인할까요?"
                      : "저장하지 않은 연락 메모 편집을 취소할까요?",
                  )
                )
                  return;
                setEditor(null);
                nonce.current = null;
                setError("");
                setAttempted(false);
              }}
            >
              편집 취소
            </Button>
          </div>
        </fieldset>
      )}
      {records.length > 1 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">
            과거 연락 메모 {records.length - 1}개 버전
          </summary>
          <CompanyContactsComparison records={records} />
          <div className="mt-3 space-y-3">
            {records
              .slice(0, -1)
              .reverse()
              .map((record) => (
                <CompanyContactsRecordView key={record.id} record={record} />
              ))}
          </div>
        </details>
      )}
    </section>
  );
}
