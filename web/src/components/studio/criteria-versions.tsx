"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StudioCase } from "@/lib/studio-schema";
import { applicationMetadata } from "@/lib/studio-application-types";
import {
  criteriaContextReasonLabels,
  criteriaReferenceDownloadName,
  criteriaVersionLimits,
  criteriaVersionMutationSchema,
  latestApplicationCriteriaBinding,
  type CriteriaVersion,
  type CriteriaVersionDetails,
  type ApplicationCriteriaBinding,
} from "@/lib/studio-criteria-version-types";
import { Notice, formatDate, selectClass, useDirty, type PanelProps } from "./shared";
import {
  criteriaApplicationUiContext,
  criteriaCommandProblem,
  criteriaSaveAcknowledged,
  emptyCriteriaPin,
  emptyCriteriaVersion,
  latestCriteriaVersions,
  newCriteriaDocument,
  type CriteriaCommand,
} from "./criteria-versions-ui";

const documentLabels = [
  ["name", "서류 이름 *"],
  ["appliesTo", "적용 대상"],
  ["period", "대상 기간"],
  ["issueDateCondition", "발급일 조건"],
  ["alternativeCondition", "대체자료 조건"],
  ["autoLinkGuidance", "자동연계 가능 안내 (실제 수신 결과 아님)"],
  ["note", "확인할 사항"],
] as const;
const sourceLabels = [
  ["title", "출처 제목", 200],
  ["url", "출처 URL", 2000],
  ["quote", "해당 조건의 원문 인용", 3000],
  ["note", "확인 메모", 2000],
] as const;

export function CriteriaDetailsEditor({
  details,
  onChange,
}: {
  details: CriteriaVersionDetails;
  onChange: (details: CriteriaVersionDetails) => void;
}) {
  const prefix = useId();
  return (
    <div className="space-y-4">
      {(
        [
          ["title", "기준 제목 *", 200],
          ["versionLabel", "내부 버전 표기 *", 100],
          ["applicationPath", "적용 경로 (미확인 시 공란)", 200],
        ] as const
      ).map(([key, label, maxLength]) => (
        <div key={key} className="space-y-2">
          <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
          <Input
            id={`${prefix}-${key}`}
            value={details[key]}
            maxLength={maxLength}
            onChange={(event) => onChange({ ...details, [key]: event.target.value })}
          />
        </div>
      ))}
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-date`}>담당자 확인일 (선택)</Label>
        <Input
          id={`${prefix}-date`}
          type="date"
          value={details.checkedOn}
          onInput={(event) => onChange({ ...details, checkedOn: event.currentTarget.value })}
          onChange={(event) => onChange({ ...details, checkedOn: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          공란은 미확인입니다. 이 날짜를 기입해도 앱이 기관을 조회한 것으로 표시하지 않습니다.
        </p>
      </div>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="font-medium">
            출처·원문 인용 {details.sources.length}/{criteriaVersionLimits.sources}
          </h5>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={details.sources.length >= criteriaVersionLimits.sources}
            onClick={() =>
              onChange({
                ...details,
                sources: [...details.sources, { title: "", url: "", quote: "", note: "" }],
              })
            }
          >
            출처 추가
          </Button>
        </div>
        {details.sources.map((source, index) => (
          <fieldset key={index} className="space-y-3 rounded-xl border p-3">
            <legend className="px-1 text-sm">출처 {index + 1}</legend>
            {sourceLabels.map(([key, label, maxLength]) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={`${prefix}-source-${index}-${key}`}>{label}</Label>
                <Textarea
                  id={`${prefix}-source-${index}-${key}`}
                  value={source[key]}
                  maxLength={maxLength}
                  onChange={(event) =>
                    onChange({
                      ...details,
                      sources: details.sources.map((item, row) =>
                        row === index ? { ...item, [key]: event.target.value } : item,
                      ),
                    })
                  }
                />
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange({ ...details, sources: details.sources.filter((_, row) => row !== index) })
              }
            >
              이 출처 입력 제거
            </Button>
          </fieldset>
        ))}
      </section>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="font-medium">
            서류별 조건 {details.documents.length}/{criteriaVersionLimits.documents}
          </h5>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={details.documents.length >= criteriaVersionLimits.documents}
            onClick={() =>
              onChange({ ...details, documents: [...details.documents, newCriteriaDocument()] })
            }
          >
            서류 조건 추가
          </Button>
        </div>
        {details.documents.map((document, index) => (
          <fieldset key={document.id} className="space-y-3 rounded-xl border p-3">
            <legend className="px-1 text-sm">서류 {index + 1}</legend>
            {documentLabels.map(([key, label]) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={`${prefix}-document-${document.id}-${key}`}>{label}</Label>
                <Textarea
                  id={`${prefix}-document-${document.id}-${key}`}
                  value={document[key]}
                  maxLength={key === "name" ? 200 : 2000}
                  onChange={(event) =>
                    onChange({
                      ...details,
                      documents: details.documents.map((item) =>
                        item.id === document.id ? { ...item, [key]: event.target.value } : item,
                      ),
                    })
                  }
                />
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange({
                  ...details,
                  documents: details.documents.filter((item) => item.id !== document.id),
                })
              }
            >
              이 서류 조건 입력 제거
            </Button>
          </fieldset>
        ))}
      </section>
    </div>
  );
}

export function CriteriaVersionView({
  record,
  anchor = true,
}: {
  record: CriteriaVersion;
  anchor?: boolean;
}) {
  return (
    <article
      id={anchor ? `criteria-version-${record.id}` : undefined}
      tabIndex={anchor ? -1 : undefined}
      className="scroll-mt-24 space-y-3 rounded-xl border p-4 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="font-semibold">
          {record.details.title} · v{record.version} · {record.details.versionLabel}
        </h5>
        <Badge variant="outline">수동 기준 기록 · 현행 여부 미검증</Badge>
      </div>
      <p className="text-xs leading-6">
        기입 적용 경로: {record.details.applicationPath || "미확인"} · 기입 확인일:{" "}
        {record.details.checkedOn || "미확인"}
      </p>
      <p className="text-xs text-muted-foreground">
        기록자: {record.recordedBy} · 앱 보관 시각: {formatDate(record.recordedAt)}
      </p>
      <p className="whitespace-pre-wrap break-words text-xs">기록·정정 이유: {record.reason}</p>
      {record.details.sources.length === 0 && (
        <p className="text-xs">출처 미기입 · 조건의 현행 여부 확인 필요</p>
      )}
      {record.details.sources.map((source, index) => (
        <details key={index} className="rounded-lg border p-3 text-xs leading-6">
          <summary className="cursor-pointer font-medium">
            기입 출처 {index + 1}: {source.title || "제목 미기입"}
          </summary>
          <p className="whitespace-pre-wrap break-words">기입 URL: {source.url || "미확인"}</p>
          <p className="whitespace-pre-wrap break-words">
            보관한 원문 인용: {source.quote || "미기입"}
          </p>
          <p className="whitespace-pre-wrap break-words">확인 메모: {source.note || "미기입"}</p>
          <p className="text-muted-foreground">
            출처를 자동 조회하거나 원문의 진위를 확인하지 않았습니다.
          </p>
        </details>
      ))}
      {record.details.documents.length === 0 && <p className="text-xs">서류 조건 미기입</p>}
      {record.details.documents.map((document) => (
        <details key={document.id} className="rounded-lg border p-3 text-xs leading-6">
          <summary className="cursor-pointer font-medium">{document.name}</summary>
          <dl className="mt-2 space-y-2">
            {documentLabels
              .filter(([key]) => key !== "name")
              .map(([key, label]) => (
                <div key={key}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="whitespace-pre-wrap break-words">{document[key] || "미확인"}</dd>
                </div>
              ))}
          </dl>
        </details>
      ))}
      <details className="text-xs">
        <summary className="cursor-pointer">보관한 기준 내용 SHA-256</summary>
        <p className="break-all">{record.contentSha256}</p>
      </details>
    </article>
  );
}

export function CriteriaApplicationStatus({
  company,
  applicationId,
}: {
  company: StudioCase;
  applicationId: string;
}) {
  const { binding, context } = criteriaApplicationUiContext(company, applicationId);
  return (
    <div className="space-y-1 rounded-lg bg-muted/30 p-3 text-xs leading-6">
      {!binding ? (
        <p>이 회차에 명시적으로 고정한 기준 버전 없음</p>
      ) : (
        <p>
          회차에 고정한 기준: {binding.criteriaSummary.title} · v{binding.criteriaVersion} ·{" "}
          {binding.criteriaSummary.versionLabel}
        </p>
      )}
      {binding && !context && (
        <p className="text-amber-800">
          현재 연결 상태 확인 정보가 없습니다. 최신 기업 기록을 불러와 확인해 주세요.
        </p>
      )}
      {context?.reasons.map((reason) => (
        <p key={reason} className="text-amber-800">
          {criteriaContextReasonLabels[reason]}
        </p>
      ))}
      {context?.status === "pinned-unverified" && (
        <p>로컬 연결 정보 대조 완료 · 기준의 현행 여부와 회사 적격성은 미검증</p>
      )}
      {context?.status === "unresolved" && (
        <p>연결 상태 미확인 · 과거 버전을 자동 대체하지 않습니다.</p>
      )}
      <a
        href={`#criteria-application-${applicationId}`}
        className="text-primary underline underline-offset-4"
      >
        이 회차의 기준 연결·과거 버전 보기
      </a>
    </div>
  );
}

export function CriteriaBindingView({
  company,
  binding,
  blocked = false,
}: {
  company: StudioCase;
  binding: ApplicationCriteriaBinding;
  blocked?: boolean;
}) {
  const versions = (company.criteriaVersions ?? []).filter(
    (record) => record.caseId === company.id && record.id === binding.criteriaVersionId,
  );
  const record =
    versions.length === 1 && versions[0].contentSha256 === binding.criteriaContentSha256
      ? versions[0]
      : null;
  const belongs = binding.caseId === company.id;
  return (
    <article className="space-y-3 rounded-xl border p-4 text-xs leading-6">
      <h5 className="font-semibold">
        회차 기준 연결 v{binding.version} · {binding.criteriaSummary.title} · 기준 v
        {binding.criteriaVersion}
      </h5>
      <p>
        보관 당시 회차: {binding.applicationSnapshot.title} · 내부 기준 표기:{" "}
        {binding.criteriaSummary.versionLabel}
      </p>
      <p>
        연결 당시 회사: {binding.companySnapshot.companyName} ·{" "}
        {binding.companySnapshot.businessNumber || "사업자번호 미기입"}
      </p>
      <p>
        기입 확인일: {binding.criteriaSummary.checkedOn || "미확인"} · 기입 적용 경로:{" "}
        {binding.criteriaSummary.applicationPath || "미확인"}
      </p>
      <p>
        연결 기록자: {binding.recordedBy} · 앱 보관 시각: {formatDate(binding.recordedAt)}
      </p>
      <p className="whitespace-pre-wrap break-words">연결·변경 이유: {binding.reason}</p>
      <p className="text-muted-foreground">
        담당자가 선택한 정확한 버전입니다. 기관이 적용을 승인하거나 서류를 수신했다는 기록이
        아닙니다.
      </p>
      {record ? (
        <details>
          <summary className="cursor-pointer font-medium">
            이 연결에 고정한 기준 원문·조건 펼치기
          </summary>
          <div className="mt-3">
            <CriteriaVersionView record={record} anchor={false} />
          </div>
        </details>
      ) : (
        <p className="text-amber-800">
          고정한 기준 버전의 연결을 확인할 수 없습니다. 다른 버전으로 대체하지 않습니다.
        </p>
      )}
      {belongs && record && !blocked ? (
        <a
          href={`/api/studio/cases/${company.id}/criteria-bindings/${binding.id}/export`}
          download={criteriaReferenceDownloadName}
          className="inline-block text-primary underline underline-offset-4"
        >
          이 연결의 수동 기준 참고자료 내려받기
        </a>
      ) : (
        <p className="text-muted-foreground">
          편집 또는 연결 확인을 마친 뒤 보관한 참고자료를 출력하세요.
        </p>
      )}
    </article>
  );
}

type Props = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason: string;
  onDirtyChange: (dirty: boolean) => void;
};
type Form = {
  input: CriteriaCommand;
  baseline: string;
  nonce: string;
  attempted: string | null;
  confirmed: boolean;
};
export function CriteriaVersions(props: Props) {
  return <CriteriaVersionsBody key={`${props.company.id}:${props.company.revision}`} {...props} />;
}
function CriteriaVersionsBody({ company, mutate, blockedReason, onDirtyChange }: Props) {
  const prefix = useId(),
    mounted = useRef(false),
    inFlight = useRef(false);
  const [form, setForm] = useState<Form | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty =
    !!form && (!!form.attempted || form.confirmed || JSON.stringify(form.input) !== form.baseline);
  useDirty(dirty, onDirtyChange);
  const blocked = saving || !!blockedReason,
    versions = company.criteriaVersions ?? [],
    bindings = company.applicationCriteriaBindings ?? [],
    latest = latestCriteriaVersions(company);
  const input = form?.input;
  const selectedVersion =
    input?.action === "pin-application-criteria"
      ? versions.find(
          (record) => record.caseId === company.id && record.id === input.criteriaVersionId,
        )
      : null;
  function open(command: CriteriaCommand) {
    if (
      blocked ||
      inFlight.current ||
      (dirty && !window.confirm("저장하지 않은 기준 편집을 닫고 다른 기록을 열까요?"))
    )
      return;
    setForm({
      input: command,
      baseline: JSON.stringify(command),
      nonce: crypto.randomUUID(),
      attempted: null,
      confirmed: false,
    });
    setError("");
  }
  function edit(command: CriteriaCommand) {
    if (!form || blocked || form.attempted) return;
    setForm({ ...form, input: command, confirmed: false });
    setError("");
  }
  function cancel() {
    if (saving || inFlight.current) return;
    if (
      dirty &&
      !window.confirm(
        form?.attempted
          ? "저장됐을 수 있습니다. 최신 기록을 확인한 뒤 새 요청을 작성하세요. 이 편집본을 닫을까요?"
          : "저장하지 않은 기준 편집을 취소할까요?",
      )
    )
      return;
    setForm(null);
    setError("");
  }
  async function save() {
    if (!form || !form.confirmed || blocked || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const problem = await criteriaCommandProblem(company, form.input);
      if (!mounted.current) return;
      if (problem) {
        setError(problem);
        return;
      }
      const parsed = criteriaVersionMutationSchema.parse({
        ...form.input,
        revision: company.revision,
        clientRequestId: form.nonce,
      });
      const payload = JSON.stringify(parsed);
      if (form.attempted && form.attempted !== payload) {
        setError("저장 결과를 확인하기 전에는 요청 내용을 변경할 수 없습니다.");
        return;
      }
      setForm({ ...form, attempted: payload });
      const { revision: ignored, ...command } = parsed;
      void ignored;
      const result = await mutate(command);
      if (!mounted.current) return;
      const acknowledged =
        result && (await criteriaSaveAcknowledged(result, company, form.nonce, form.input));
      if (!mounted.current) return;
      if (acknowledged) setForm(null);
      else
        setError(
          "저장 결과를 확인하지 못했습니다. 같은 내용과 요청 번호를 유지합니다. 최신 기록을 확인하거나 같은 내용으로 저장 확인을 다시 누르세요. 자동 재시도하지 않습니다.",
        );
    } catch {
      if (mounted.current)
        setError(
          "저장 결과를 확인하지 못했습니다. 새 기록을 만들기 전에 최신 기록을 확인해 주세요. 같은 내용과 요청 번호를 유지했습니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section aria-label="기준·서류 조건 버전" className="mt-5 space-y-4 rounded-2xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold">기준·서류 조건 버전</h3>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={blocked || versions.length >= criteriaVersionLimits.versions}
            onClick={() => open(emptyCriteriaVersion())}
          >
            수동 기준 버전 추가
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              blocked ||
              versions.length === 0 ||
              company.applications.length === 0 ||
              bindings.length >= criteriaVersionLimits.bindings
            }
            onClick={() => open(emptyCriteriaPin())}
          >
            회차에 기준 버전 연결
          </Button>
        </div>
      </div>
      <Notice>
        담당자가 확인한 출처와 서류 조건을 버전으로 보관합니다. 조건의 현행 여부·회사
        적격성·자동연계 수신 성공은 확인하지 않습니다. 내장 사전진단 기준과 기존 원고의 검토 상태는
        변경하지 않습니다.
      </Notice>
      <p className="text-xs leading-6 text-muted-foreground">
        기준 {versions.length}/{criteriaVersionLimits.versions}개 · 연결 {bindings.length}/
        {criteriaVersionLimits.bindings}개. 신청 회차의 정확한 기준 버전을 직접 선택하며 최신
        버전으로 자동 교체하지 않습니다. 공란은 미확인입니다.
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
          aria-label={
            input.action === "append-criteria-version" ? "기준 버전 편집" : "회차 기준 연결 편집"
          }
          className="space-y-4 rounded-xl border border-primary/30 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-semibold">
              {input.action === "append-criteria-version"
                ? input.criteriaId
                  ? "새 기준 버전으로 정정"
                  : "수동 기준 버전 작성"
                : "정확한 회차·기준 버전 연결"}
            </h4>
            <Button type="button" variant="ghost" disabled={saving} onClick={cancel}>
              기준 편집 취소
            </Button>
          </div>
          {form.attempted && (
            <Notice tone="warning">
              저장 요청의 내용과 요청 번호를 유지합니다. 편집 없이 같은 내용으로 저장 확인만 다시 할
              수 있습니다.
            </Notice>
          )}
          <fieldset disabled={blocked || !!form.attempted} className="space-y-4">
            {input.action === "append-criteria-version" ? (
              <>
                {input.criteriaId && (
                  <Notice>
                    이전 조건을 복사했고 확인일은 비웠습니다. 수정할 내용과 확인일을 직접
                    기록하세요. 과거 기준과 회차 연결은 보존됩니다.
                  </Notice>
                )}
                <CriteriaDetailsEditor
                  details={input.details}
                  onChange={(details) => edit({ ...input, details })}
                />
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor={`${prefix}-application`}>신청 회차의 현재 정보 *</Label>
                  <select
                    id={`${prefix}-application`}
                    className={selectClass}
                    value={input.applicationId}
                    onChange={(event) => {
                      const application = applicationMetadata(company, event.target.value);
                      edit({
                        ...input,
                        applicationId: application?.id ?? "",
                        applicationMetadataVersionId: application?.metadataVersionId ?? "",
                        previousBindingId: application
                          ? (latestApplicationCriteriaBinding(company, application.id)?.id ?? null)
                          : null,
                        criteriaVersionId: "",
                        criteriaContentSha256: "",
                      });
                    }}
                  >
                    <option value="">회차를 직접 선택하세요</option>
                    {company.applications.map((application) => (
                      <option key={application.id} value={application.id}>
                        {applicationMetadata(company, application.id)?.title ?? application.title}
                      </option>
                    ))}
                  </select>
                </div>
                {input.applicationId && (
                  <CriteriaApplicationStatus
                    company={company}
                    applicationId={input.applicationId}
                  />
                )}
                <div className="space-y-2">
                  <Label htmlFor={`${prefix}-version`}>연결할 정확한 기준 버전 *</Label>
                  <select
                    id={`${prefix}-version`}
                    className={selectClass}
                    value={input.criteriaVersionId}
                    disabled={!input.applicationId}
                    onChange={(event) => {
                      const record = versions.find(
                        (item) => item.id === event.target.value && item.caseId === company.id,
                      );
                      edit({
                        ...input,
                        criteriaVersionId: record?.id ?? "",
                        criteriaContentSha256: record?.contentSha256 ?? "",
                      });
                    }}
                  >
                    <option value="">기준 버전을 직접 선택하세요</option>
                    {versions
                      .filter((record) => record.caseId === company.id)
                      .map((record) => (
                        <option key={record.id} value={record.id}>
                          {record.details.title} · v{record.version} · {record.details.versionLabel}
                          {latest.some((item) => item.id === record.id) ? "" : " · 과거 버전"}
                        </option>
                      ))}
                  </select>
                </div>
                {selectedVersion && <CriteriaVersionView record={selectedVersion} anchor={false} />}
                <p className="text-xs text-muted-foreground">
                  이 버전의 모든 조건과 내용 식별값을 회차에 고정합니다. 기존 연결은 별도 이력으로
                  보존됩니다. 기준 연결만으로 신청·제출·검토를 완료하지 않습니다.
                </p>
              </>
            )}
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-author`}>기록 담당자 *</Label>
              <Input
                id={`${prefix}-author`}
                value={input.recordedBy}
                maxLength={100}
                onChange={(event) => edit({ ...input, recordedBy: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-reason`}>기록·정정·연결 이유 *</Label>
              <Textarea
                id={`${prefix}-reason`}
                value={input.reason}
                maxLength={2000}
                onChange={(event) => edit({ ...input, reason: event.target.value })}
              />
            </div>
            <label className="flex items-start gap-2 text-sm leading-6">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.confirmed}
                onChange={(event) => setForm({ ...form, confirmed: event.target.checked })}
              />
              기입한 출처·조건과 선택한 버전을 직접 확인했습니다. 기관 검증이 아닌 담당자 기록으로
              보관합니다.
            </label>
          </fieldset>
          <Button type="button" disabled={blocked || !form.confirmed} onClick={() => void save()}>
            {saving
              ? "저장 확인 중"
              : form.attempted
                ? "같은 내용으로 저장 확인"
                : input.action === "append-criteria-version"
                  ? "기준 버전 저장"
                  : "선택한 기준 버전을 회차에 연결"}
          </Button>
        </section>
      )}
      {latest.length === 0 && (
        <p className="text-sm text-muted-foreground">
          수기로 보관한 기준 버전이 없습니다. 기관 기준을 추정해 기본값으로 채우지 않습니다.
        </p>
      )}
      {latest.map((record) => (
        <div key={record.id} className="space-y-2">
          <CriteriaVersionView record={record} />
          <Button
            type="button"
            variant="outline"
            disabled={blocked || versions.length >= criteriaVersionLimits.versions}
            onClick={() => open(emptyCriteriaVersion(record))}
          >
            새 기준 버전으로 정정
          </Button>
          {versions.some(
            (item) => item.criteriaId === record.criteriaId && item.id !== record.id,
          ) && (
            <details className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm">이 기준의 과거 버전 보기</summary>
              <div className="mt-3 space-y-3">
                {versions
                  .filter((item) => item.criteriaId === record.criteriaId && item.id !== record.id)
                  .map((item) => (
                    <CriteriaVersionView key={item.id} record={item} />
                  ))}
              </div>
            </details>
          )}
        </div>
      ))}
      {company.applications.map((application) => {
        const current = latestApplicationCriteriaBinding(company, application.id),
          past = bindings.filter(
            (binding) =>
              binding.caseId === company.id &&
              binding.applicationId === application.id &&
              binding.id !== current?.id,
          );
        return (
          <section
            key={application.id}
            id={`criteria-application-${application.id}`}
            tabIndex={-1}
            className="scroll-mt-24 space-y-3 rounded-xl bg-muted/20 p-4"
          >
            <h4 className="font-semibold">
              {applicationMetadata(company, application.id)?.title ?? application.title} · 기준 연결
            </h4>
            <CriteriaApplicationStatus company={company} applicationId={application.id} />
            {current && (
              <CriteriaBindingView company={company} binding={current} blocked={blocked || dirty} />
            )}
            {past.length > 0 && (
              <details className="rounded-lg border p-3">
                <summary className="cursor-pointer text-sm">과거 회차 기준 연결 보기</summary>
                <div className="mt-3 space-y-3">
                  {past.map((binding) => (
                    <CriteriaBindingView
                      key={binding.id}
                      company={company}
                      binding={binding}
                      blocked={blocked || dirty}
                    />
                  ))}
                </div>
              </details>
            )}
          </section>
        );
      })}
    </section>
  );
}
