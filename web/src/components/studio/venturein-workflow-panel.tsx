"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { Download, RefreshCw, Save, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CompanyProfile, StudioCase } from "@/lib/studio-schema";
import type { VentureConnectionStatus } from "@/lib/venturein-schema";
import type { VentureScreenField } from "@/lib/venturein-inspection";
import {
  ventureFieldSupport,
  ventureFinancialContext,
  type VentureSubmissionDraft,
  type VentureTextSource,
} from "@/lib/venturein-preflight";
import type { VentureWorkflowStatus } from "@/lib/venturein-workflow";
import { Loading, Notice, formatDate, jsonBody, selectClass, studioFetch } from "./shared";
import { VentureinExecutionPanel } from "./venturein-execution-panel";
import { VentureinJourneyPanel } from "./venturein-journey-panel";

const profileLabels: Record<keyof CompanyProfile, string> = {
  companyName: "기업명",
  businessNumber: "사업자등록번호",
  industry: "업종",
  foundedOn: "설립·개업일",
  applicationDate: "신청 예정일",
  applicationKind: "신청 구분",
  technologySummary: "기술·제품 설명",
  customers: "고객·시장",
  team: "인력·역량",
  financials: "재무·자금",
  paidInCapital: "납입자본금(원)",
  closingMonth: "결산월",
  developmentPlan: "개발계획",
  patents: "특허·지식재산",
};

function fieldName(field: VentureScreenField) {
  return field.labels.join(" · ") || field.name || field.id || "이름 없는 항목";
}

function Step({
  number,
  title,
  badge,
  children,
}: {
  number: number;
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="min-w-0 rounded-2xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold">
          <span className="mr-2 text-primary">{number}.</span>
          {title}
        </h3>
        {badge}
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function FieldDetails({ field }: { field: VentureScreenField }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs leading-6 text-muted-foreground">
      <span>{field.required ? "필수 항목" : "필수 표시 없음"}</span>
      {field.maxLength !== null && <span>최대 {field.maxLength.toLocaleString()}자</span>}
      {field.kind === "file" && <span>허용 형식: {field.accept || "화면에 표시 없음"}</span>}
      {field.kind === "file" && <span>{field.multiple ? "여러 파일 허용" : "파일 1개"}</span>}
      {(field.disabled || field.readOnly) && <span>현재 화면에서 수정 불가</span>}
    </div>
  );
}

function FinancialEvidence({ context }: { context: { unit: string; evidenceNote: string } }) {
  return (
    <div className="mt-3 space-y-2 border-t pt-3 text-xs leading-6">
      <p>입력값 단위: {context.unit}. 공식 항목의 단위와 근거 자료의 기준일을 확인하세요.</p>
      <details>
        <summary className="cursor-pointer font-medium">기업정보에 저장한 재무 근거 메모</summary>
        <p className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">
          {context.evidenceNote ||
            "근거 메모가 없습니다. 기업정보의 ‘재무와 자금’에 출처와 기준일을 기록하세요."}
        </p>
      </details>
    </div>
  );
}

function OfficialScreenPreview({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState(0);
  const [failed, setFailed] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setFailed(false);
            setSrc(url);
            setPreviewRequest((current) => current + 1);
          }}
        >
          공식 화면 미리보기
        </Button>
        {src && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSrc(null);
              setFailed(false);
            }}
          >
            미리보기 닫기
          </Button>
        )}
      </div>
      {src && (
        <div className="overflow-hidden rounded-xl border bg-muted/20 p-2">
          {failed ? (
            <p role="alert" className="p-3 text-sm leading-6 text-destructive">
              현재 공식 화면을 다시 읽은 뒤 미리보기를 여세요.
            </p>
          ) : (
            <Image
              key={previewRequest}
              src={`${src}&previewRequest=${previewRequest}`}
              alt="현재 연결된 벤처인 공식 화면"
              width={1280}
              height={720}
              unoptimized
              className="h-auto w-full object-contain"
              onError={() => setFailed(true)}
            />
          )}
        </div>
      )}
    </div>
  );
}

type Props = {
  company: StudioCase;
  connection: VentureConnectionStatus;
  executionBlocked?: boolean;
  onDirtyChange: (dirty: boolean) => void;
};

export function VentureinWorkflowPanel({
  company,
  connection,
  executionBlocked = false,
  onDirtyChange,
}: Props) {
  const [workflow, setWorkflow] = useState<VentureWorkflowStatus | null>(null);
  const [draft, setDraft] = useState<VentureSubmissionDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const requestRef = useRef(0);
  const commandRef = useRef(0);
  const mountedRef = useRef(false);
  const [busy, setBusy] = useState("");
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionReviewVersion, setExecutionReviewVersion] = useState(0);
  const [error, setError] = useState("");
  const [requestError, setRequestError] = useState("");
  const endpoint = `/api/studio/cases/${company.id}/venturein/workflow`;
  const latestPlan = company.plans.at(-1);
  const connected = connection.session.state === "connected_unmapped";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    onDirtyChange(dirty || !!busy || executionBusy);
    return () => onDirtyChange(false);
  }, [busy, dirty, executionBusy, onDirtyChange]);

  useEffect(() => {
    let active = true;
    const request = ++requestRef.current;
    studioFetch<VentureWorkflowStatus>(endpoint)
      .then((value) => {
        if (!active || request !== requestRef.current) return;
        setWorkflow(value);
        if (!dirtyRef.current) setDraft(value.draft);
        setError("");
      })
      .catch((caught: unknown) => {
        if (active && request === requestRef.current)
          setError(caught instanceof Error ? caught.message : "제출 준비를 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, [
    endpoint,
    company.revision,
    connection.account.revision,
    connection.session.state,
    connection.session.startedAt,
  ]);

  function acceptStatus(value: VentureWorkflowStatus, request = requestRef.current) {
    if (!mountedRef.current || request !== requestRef.current) return;
    setWorkflow(value);
    setDraft(value.draft);
    dirtyRef.current = false;
    setDirty(false);
    setError("");
  }

  function showError(caught: unknown, command: number) {
    if (!mountedRef.current || command !== commandRef.current) return;
    const message = caught instanceof Error ? caught.message : "제출 준비를 처리하지 못했습니다.";
    setRequestError(message);
    toast.error(message);
  }

  async function refresh() {
    if (executionBusy) return;
    setExecutionReviewVersion((version) => version + 1);
    const request = ++requestRef.current;
    const command = ++commandRef.current;
    setRequestError("");
    setError("");
    setBusy("저장된 연결과 제출 전 점검 결과를 불러오고 있습니다");
    try {
      const value = await studioFetch<VentureWorkflowStatus>(endpoint);
      if (request === requestRef.current) acceptStatus(value);
    } catch (caught) {
      showError(caught, command);
    } finally {
      if (mountedRef.current && command === commandRef.current) setBusy("");
    }
  }

  async function inspect(destination: "application" | "current" | "innovation") {
    if (!workflow || !connected || dirty || executionBusy) return;
    setExecutionReviewVersion((version) => version + 1);
    const request = ++requestRef.current;
    const command = ++commandRef.current;
    setRequestError("");
    setBusy("열린 Edge 창에서 기업과 신청 항목을 확인하고 있습니다");
    setError("");
    try {
      acceptStatus(
        await studioFetch<VentureWorkflowStatus>(endpoint, {
          method: "POST",
          ...jsonBody({
            action: "inspect",
            destination,
            revision: workflow.revision,
            accountRevision: connection.account.revision,
            companyRevision: company.revision,
          }),
        }),
        request,
      );
      if (mountedRef.current && command === commandRef.current && request === requestRef.current)
        toast.success("공식 화면에서 읽은 기업과 신청 항목을 저장했습니다.");
    } catch (caught) {
      showError(caught, command);
    } finally {
      if (mountedRef.current && command === commandRef.current) setBusy("");
    }
  }

  async function save() {
    if (!workflow || !draft || executionBusy) return;
    setExecutionReviewVersion((version) => version + 1);
    const request = ++requestRef.current;
    const command = ++commandRef.current;
    setRequestError("");
    setBusy("항목·첨부 연결을 이 PC에 저장하고 점검하고 있습니다");
    setError("");
    try {
      acceptStatus(
        await studioFetch<VentureWorkflowStatus>(endpoint, {
          method: "PUT",
          ...jsonBody({
            revision: workflow.revision,
            accountRevision: connection.account.revision,
            companyRevision: company.revision,
            draft,
          }),
        }),
        request,
      );
      if (mountedRef.current && command === commandRef.current && request === requestRef.current)
        toast.success("연결을 이 PC에 저장했습니다. 제출 전 점검 결과를 확인하세요.");
    } catch (caught) {
      showError(caught, command);
    } finally {
      if (mountedRef.current && command === commandRef.current) setBusy("");
    }
  }

  function edit(nextDraft: VentureSubmissionDraft) {
    setDraft(nextDraft);
    dirtyRef.current = true;
    setDirty(true);
  }

  function emptyDraft(): VentureSubmissionDraft | null {
    const snapshot = workflow?.snapshot;
    if (!snapshot) return null;
    return {
      caseId: company.id,
      snapshotId: snapshot.screen.id,
      sessionStartedAt: snapshot.sessionStartedAt,
      accountRevision: snapshot.accountRevision,
      companyRevision: company.revision,
      planId: latestPlan?.id ?? null,
      planVersion: latestPlan?.version ?? null,
      textMappings: [],
      attachmentMappings: [],
    };
  }

  const snapshot = workflow?.snapshot;
  const screen = snapshot?.screen;
  const verification = workflow?.report.companyVerification;
  const editableDraft = draft ?? emptyDraft();
  const snapshotCurrent = Boolean(
    snapshot &&
    connected &&
    snapshot.sessionStartedAt === connection.session.startedAt &&
    snapshot.accountRevision === connection.account.revision,
  );
  const draftStale = Boolean(
    draft &&
    (draft.caseId !== company.id ||
      draft.snapshotId !== screen?.id ||
      draft.sessionStartedAt !== snapshot?.sessionStartedAt ||
      draft.accountRevision !== connection.account.revision ||
      draft.companyRevision !== company.revision ||
      draft.planId !== (latestPlan?.id ?? null) ||
      draft.planVersion !== (latestPlan?.version ?? null)),
  );
  const canEdit = snapshotCurrent && !draftStale;
  const currentExecutionComplete = Boolean(
    workflow?.execution &&
    workflow.execution.snapshotId === screen?.id &&
    workflow.execution.status === "completed" &&
    workflow.execution.code !== "INPUT_RESULT_UNKNOWN",
  );
  const canReadNext = Boolean(
    connected &&
    snapshotCurrent &&
    !draftStale &&
    !dirty &&
    !busy &&
    !executionBusy &&
    !executionBlocked &&
    workflow?.report.inputReadiness?.ready === true &&
    currentExecutionComplete,
  );
  const fields = screen?.fields ?? [];
  const textFields = fields.filter((field) => ventureFieldSupport(field) === "text");
  const fileFields = fields.filter((field) => ventureFieldSupport(field) === "file");
  const unsupportedFields = fields.filter((field) => ventureFieldSupport(field) === "unsupported");
  const mappingPlan = editableDraft?.planId
    ? company.plans.find((plan) => plan.id === editableDraft.planId)
    : latestPlan;
  const sourceOptions: { value: string; label: string; source: VentureTextSource }[] = [
    ...(Object.keys(profileLabels) as (keyof CompanyProfile)[]).map((property) => ({
      value: `profile:${property}`,
      label: `기업정보 · ${profileLabels[property]}`,
      source: { kind: "profile" as const, property },
    })),
    ...(latestPlan?.content.sections ?? []).map((section) => ({
      value: `section:${section.key}`,
      label: `작성본 · ${section.title}`,
      source: { kind: "plan-section" as const, sectionKey: section.key },
    })),
  ];

  function selectText(fieldKey: string, optionValue: string) {
    if (!editableDraft || !canEdit) return;
    const selected = sourceOptions.find((option) => option.value === optionValue);
    edit({
      ...editableDraft,
      textMappings: [
        ...editableDraft.textMappings.filter((mapping) => mapping.fieldKey !== fieldKey),
        ...(selected ? [{ fieldKey, source: selected.source, confirmed: false }] : []),
      ],
    });
  }

  function selectFiles(fieldKey: string, sourceIds: string[]) {
    if (!editableDraft || !canEdit) return;
    const mappings = sourceIds.flatMap((sourceId) => {
      const source = company.sources.find((candidate) => candidate.id === sourceId);
      const original = workflow?.originalFiles.find((candidate) => candidate.sourceId === sourceId);
      return source && original?.exists
        ? [{ fieldKey, sourceId, sourceUpdatedAt: source.updatedAt, confirmed: false }]
        : [];
    });
    edit({
      ...editableDraft,
      attachmentMappings: [
        ...editableDraft.attachmentMappings.filter((mapping) => mapping.fieldKey !== fieldKey),
        ...mappings,
      ],
    });
  }

  return (
    <div aria-label="신청서와 첨부자료 연결" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-bold">신청기업 확인부터 제출 전 점검까지</h3>
        <Button
          type="button"
          variant="outline"
          disabled={!!busy || dirty || executionBusy}
          onClick={refresh}
        >
          <RefreshCw />
          점검 결과 새로고침
        </Button>
      </div>
      {(requestError || error) && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm leading-6 text-destructive"
        >
          {requestError || error}
        </div>
      )}
      {busy && <Loading text={busy} />}
      {!workflow ? (
        !requestError && !error && <Loading text="제출 준비를 불러오고 있습니다" />
      ) : (
        <fieldset disabled={!!busy || executionBusy} className="min-w-0 space-y-5">
          <Notice>
            열린 Edge 창의 신청 화면을 읽고, 입력할 원고와 첨부할 원본을 이 PC에서 연결합니다.
            저장한 연결은 제출 전 점검과 검토용 다운로드에 사용합니다.
          </Notice>
          <VentureinJourneyPanel
            journey={workflow.journey}
            currentSnapshotId={screen?.id ?? null}
            canReadNext={canReadNext}
            readNextBlockedReason={
              !connected
                ? "로그인 연결을 먼저 완료해 주세요."
                : dirty || executionBlocked
                  ? "저장하지 않은 변경이나 계정 작업을 먼저 정리해 주세요."
                  : busy || executionBusy
                    ? "진행 중인 작업이 끝난 뒤 연결할 수 있습니다."
                    : !snapshotCurrent
                      ? "현재 로그인 연결의 화면을 먼저 읽어 주세요."
                      : !workflow.report.inputReadiness
                        ? "선택 입력 준비 정보가 없습니다. 점검 결과 새로고침으로 최신 상태를 확인해 주세요."
                        : draftStale || workflow.report.inputReadiness.ready !== true
                          ? "기업자료·항목 연결의 변경과 선택 입력 전 보완사항을 먼저 확인해 주세요."
                          : "현재 화면의 입력·첨부 결과 확인이 완료된 뒤 연결할 수 있습니다. 중단·미확인 상태는 아래 실행 결과와 공식 화면을 먼저 확인하세요."
            }
            onReadCurrent={() => {
              if (canReadNext) void inspect("current");
            }}
          />
          <Step
            number={1}
            title="신청기업 대조"
            badge={
              <Badge variant={verification?.status === "mismatch" ? "destructive" : "outline"}>
                {verification?.status === "matched"
                  ? "사업자등록번호 일치"
                  : verification?.status === "mismatch"
                    ? "기업 불일치"
                    : "기업 확인 필요"}
              </Badge>
            }
          >
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">앱에 저장된 기업</dt>
                <dd className="mt-1 break-words font-semibold">{company.profile.companyName}</dd>
                <dd className="mt-1">
                  {company.profile.businessNumber || "사업자등록번호 미입력"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">공식 화면에서 확인한 기업</dt>
                <dd className="mt-1 break-words">
                  {screen?.companyEvidence
                    .filter((item) => item.kind === "companyName")
                    .map((item) => item.value)
                    .join(" · ") || "기업명 확인 전"}
                </dd>
                <dd className="mt-1 break-words">
                  {verification?.observedBusinessNumbers.join(" · ") || "사업자등록번호 확인 전"}
                </dd>
              </div>
            </dl>
            <p className="text-xs leading-6 text-muted-foreground">
              {verification?.reason ||
                "공식 신청 화면에서 기업정보를 확인하면 사업자등록번호로 대조합니다."}
            </p>
            {screen && (
              <div className="rounded-xl bg-muted/35 p-3 text-xs leading-6">
                <p className="break-words">확인 화면: {screen.title || "공식 벤처인 화면"}</p>
                <p>확인 시각: {formatDate(screen.observedAt)}</p>
                <p className="break-all">{screen.url}</p>
                {!snapshotCurrent && (
                  <p className="font-semibold text-destructive">
                    현재 로그인 연결과 다른 화면 기록입니다. 로그인 후 화면을 다시 확인하세요.
                  </p>
                )}
              </div>
            )}
            {!connected && (
              <Notice>위에서 벤처인 로그인 연결을 완료하면 신청 화면을 확인할 수 있습니다.</Notice>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={!connected || dirty}
                onClick={() => inspect("application")}
              >
                <Search />
                같은 Edge에서 신청 화면 확인
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!connected || dirty}
                onClick={() => inspect("innovation")}
              >
                <Search />
                혁신성장유형 화면 확인
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!connected || dirty}
                onClick={() => inspect("current")}
              >
                <RefreshCw />
                현재 Edge 화면 다시 읽기
              </Button>
            </div>
            <p className="text-xs leading-6 text-muted-foreground">
              열린 Edge 창에서 기업 선택·신청 단계를 이동했다면 현재 화면을 다시 읽으세요. 새로 읽은
              화면의 항목은 다시 연결해야 합니다.
            </p>
            {connected && snapshotCurrent && (
              <OfficialScreenPreview
                key={`${company.id}:${company.revision}:${screen?.id}:${connection.session.startedAt}:${connection.account.revision}:${workflow.revision}`}
                url={`${endpoint}/preview?revision=${workflow.revision}&accountRevision=${connection.account.revision}`}
              />
            )}
          </Step>
          <Step
            number={2}
            title="신청 항목과 원고 연결"
            badge={<Badge variant="outline">입력 항목 {textFields.length}개</Badge>}
          >
            <p className="text-sm leading-6">
              {latestPlan
                ? `연결할 작성본: v${latestPlan.version} · ${latestPlan.content.title}`
                : "사업계획서 작성본이 없습니다. 기업정보 항목은 연결할 수 있지만 제출 전 점검은 완료되지 않습니다."}
            </p>
            {draftStale && (
              <Notice tone="warning">
                기업자료·작성본 또는 로그인 연결이 변경되어 이전 확인을 재사용할 수 없습니다.
                {snapshotCurrent && (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3"
                    onClick={() => {
                      const nextDraft = emptyDraft();
                      if (nextDraft) edit(nextDraft);
                    }}
                  >
                    최신 자료로 연결 다시 작성
                  </Button>
                )}
              </Notice>
            )}
            {textFields.length === 0 ? (
              <p className="text-sm leading-6 text-muted-foreground">
                {screen
                  ? "현재 화면에서 연결할 입력 항목을 찾지 못했습니다. Edge에서 신청서 입력 단계로 이동한 뒤 다시 읽으세요."
                  : "공식 신청 화면을 먼저 확인하면 입력 항목이 표시됩니다."}
              </p>
            ) : (
              <fieldset disabled={!canEdit} className="min-w-0 space-y-3">
                {textFields.map((field, index) => {
                  const mapping = editableDraft?.textMappings.find(
                    (item) => item.fieldKey === field.key,
                  );
                  const source = mapping?.source;
                  const selected = source
                    ? source.kind === "profile"
                      ? `profile:${source.property}`
                      : `section:${source.sectionKey}`
                    : "";
                  const preview =
                    source?.kind === "profile"
                      ? company.profile[source.property]
                      : mappingPlan?.content.sections.find(
                          (section) => section.key === source?.sectionKey,
                        )?.content;
                  const id = `venture-text-${index}`;
                  const financialContext =
                    source && ventureFinancialContext(company.profile, source);
                  return (
                    <div key={field.key} className="space-y-3 rounded-xl border p-4">
                      <label htmlFor={id} className="block break-words text-sm font-semibold">
                        {fieldName(field)}
                      </label>
                      <FieldDetails field={field} />
                      <select
                        id={id}
                        className={selectClass}
                        value={selected}
                        onChange={(event) => selectText(field.key, event.target.value)}
                      >
                        <option value="">연결할 기업정보 또는 원고 선택</option>
                        {selected && !sourceOptions.some((option) => option.value === selected) && (
                          <option value={selected} disabled>
                            이전 작성본 항목 · 재연결 필요
                          </option>
                        )}
                        {sourceOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      {field.kind === "select" && (
                        <p className="break-words text-xs leading-6 text-muted-foreground">
                          공식 화면 선택지:{" "}
                          {field.options
                            .filter((option) => !option.disabled)
                            .map((option) => `${option.label} (${option.value})`)
                            .join(" · ") || "확인된 선택지 없음"}
                        </p>
                      )}
                      {mapping && !draftStale && (
                        <details
                          open={Boolean(financialContext)}
                          className="rounded-lg bg-muted/30 p-3"
                        >
                          <summary className="cursor-pointer text-xs font-medium">
                            연결할 입력값·원고 미리보기 · {(preview ?? "").length.toLocaleString()}
                            자
                          </summary>
                          <p className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">
                            {preview || "입력된 내용이 없습니다."}
                          </p>
                          {financialContext && <FinancialEvidence context={financialContext} />}
                        </details>
                      )}
                      <label className="flex items-start gap-2 text-xs leading-6">
                        <input
                          type="checkbox"
                          className="mt-1 size-4 shrink-0 accent-primary"
                          disabled={!mapping || draftStale}
                          checked={!draftStale && (mapping?.confirmed ?? false)}
                          onChange={(event) => {
                            if (!editableDraft) return;
                            edit({
                              ...editableDraft,
                              textMappings: editableDraft.textMappings.map((item) =>
                                item.fieldKey === field.key
                                  ? { ...item, confirmed: event.target.checked }
                                  : item,
                              ),
                            });
                          }}
                        />
                        <span>
                          ‘{fieldName(field)}’에 연결할 값·단위·근거와 항목 의미를 확인했습니다.
                        </span>
                      </label>
                    </div>
                  );
                })}
              </fieldset>
            )}
            {unsupportedFields.length > 0 && (
              <Notice tone="warning">
                <p>직접 확인할 항목 {unsupportedFields.length}개</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {unsupportedFields.map((field) => (
                    <li key={field.key}>
                      {fieldName(field)}
                      {field.required ? " · 필수" : ""}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">동의·특수 선택·읽기 전용 항목은 연결 대상에서 제외합니다.</p>
              </Notice>
            )}
          </Step>
          <Step
            number={3}
            title="첨부 항목과 원본 연결"
            badge={<Badge variant="outline">첨부 항목 {fileFields.length}개</Badge>}
          >
            {fileFields.length === 0 ? (
              <p className="text-sm leading-6 text-muted-foreground">
                {screen
                  ? "현재 화면에서 파일 첨부 항목을 찾지 못했습니다. 첨부 단계에서 화면을 다시 읽으세요."
                  : "공식 신청 화면의 첨부 항목을 먼저 확인하세요."}
              </p>
            ) : (
              <fieldset disabled={!canEdit} className="min-w-0 space-y-3">
                {fileFields.map((field, index) => {
                  const mappings =
                    editableDraft?.attachmentMappings.filter(
                      (item) => item.fieldKey === field.key,
                    ) ?? [];
                  const id = `venture-file-${index}`;
                  return (
                    <div key={field.key} className="space-y-3 rounded-xl border p-4">
                      <label htmlFor={id} className="block break-words text-sm font-semibold">
                        {fieldName(field)}
                      </label>
                      <FieldDetails field={field} />
                      <select
                        id={id}
                        className={`${selectClass} ${field.multiple ? "h-28 py-2" : ""}`}
                        multiple={field.multiple}
                        value={
                          field.multiple
                            ? mappings.map((mapping) => mapping.sourceId)
                            : (mappings[0]?.sourceId ?? "")
                        }
                        onChange={(event) =>
                          selectFiles(
                            field.key,
                            Array.from(event.target.selectedOptions)
                              .map((option) => option.value)
                              .filter(Boolean),
                          )
                        }
                      >
                        {!field.multiple && <option value="">첨부할 원본 파일 선택</option>}
                        {workflow.originalFiles.map((file) => (
                          <option key={file.sourceId} value={file.sourceId} disabled={!file.exists}>
                            {file.originalName}
                            {file.exists
                              ? ` · ${Math.ceil(file.sizeBytes / 1024).toLocaleString()}KB`
                              : " · 원본 없음"}
                          </option>
                        ))}
                      </select>
                      {field.multiple && (
                        <p className="text-xs text-muted-foreground">
                          Ctrl 키를 누른 채 선택하면 여러 파일을 연결할 수 있습니다.
                        </p>
                      )}
                      {mappings.map((mapping) => (
                        <label
                          key={mapping.sourceId}
                          className="flex items-start gap-2 text-xs leading-6"
                        >
                          <input
                            type="checkbox"
                            className="mt-1 size-4 shrink-0 accent-primary"
                            checked={!draftStale && mapping.confirmed}
                            onChange={(event) => {
                              if (!editableDraft) return;
                              edit({
                                ...editableDraft,
                                attachmentMappings: editableDraft.attachmentMappings.map((item) =>
                                  item.fieldKey === field.key && item.sourceId === mapping.sourceId
                                    ? { ...item, confirmed: event.target.checked }
                                    : item,
                                ),
                              });
                            }}
                          />
                          <span className="break-words">
                            ‘
                            {workflow.originalFiles.find(
                              (file) => file.sourceId === mapping.sourceId,
                            )?.originalName ?? "선택한 원본"}
                            ’의 기업·내용·제출 용도를 확인했습니다.
                          </span>
                        </label>
                      ))}
                    </div>
                  );
                })}
              </fieldset>
            )}
            <details className="rounded-xl border p-4">
              <summary className="cursor-pointer text-sm font-semibold">
                보관 중인 원본 파일 · {workflow.originalFiles.length}개
              </summary>
              {workflow.originalFiles.length === 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  자료함에 원본 파일을 업로드하면 선택할 수 있습니다.
                </p>
              )}
              <ul className="mt-3 space-y-2 text-xs leading-6">
                {workflow.originalFiles.map((file) => (
                  <li key={file.sourceId} className="break-all">
                    {file.exists ? (
                      <a
                        className="underline underline-offset-4"
                        href={`/api/studio/cases/${company.id}/sources/${file.sourceId}`}
                        download
                      >
                        {file.originalName}
                      </a>
                    ) : (
                      <span>{file.originalName} · 원본 없음</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </Step>
          <Step
            number={4}
            title="선택 입력 준비와 전체 제출 전 점검"
            badge={
              <Badge variant="outline">
                {dirty
                  ? "저장 후 재점검 필요"
                  : workflow.report.readyForLocalReview && snapshotCurrent && !draftStale
                    ? "전체 점검 보완 항목 없음"
                    : "전체 점검 보완 필요"}
              </Badge>
            }
          >
            {dirty && (
              <Notice tone="warning">
                저장하지 않은 연결 변경이 있습니다. 아래 결과는 마지막 저장본 기준입니다.
              </Notice>
            )}
            {!workflow.report.inputReadiness ? (
              <Notice tone="warning">
                선택 입력 준비 정보가 없는 이전 점검 결과입니다. 점검 결과 새로고침으로 최신 상태를
                확인해 주세요. 준비 상태를 확인하기 전에는 입력 검토안을 만들 수 없습니다.
              </Notice>
            ) : (
              <section
                aria-label="선택 항목 입력 준비"
                className="space-y-2 rounded-xl border p-4 text-sm leading-6"
              >
                <h4 className="font-semibold">선택 항목 입력 준비</h4>
                <p>
                  {dirty || draftStale || !snapshotCurrent
                    ? "변경 내용을 저장하고 현재 연결의 선택 입력 준비를 다시 확인해 주세요."
                    : workflow.report.inputReadiness.ready === true
                      ? "저장된 선택 항목의 입력 검토안을 준비할 수 있습니다."
                      : "선택 항목 입력 전에 해결할 보완사항이 있습니다."}
                </p>
                {workflow.report.inputReadiness.blockingIssues.length > 0 && (
                  <ul className="space-y-2">
                    {workflow.report.inputReadiness.blockingIssues.map((issue, index) => (
                      <li
                        key={`${issue.code}:${index}`}
                        className="rounded-lg bg-destructive/5 p-2"
                      >
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  선택 입력 가능 여부와 전체 필수 항목·동의·제출 준비는 별개입니다. 아래 전체 점검에
                  남은 사항도 확인하세요.
                </p>
              </section>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!dirty || !draft || !canEdit} onClick={save}>
                <Save />
                연결 저장하고 점검
              </Button>
              {dirty && (
                <Button type="button" variant="ghost" onClick={refresh}>
                  변경 취소
                </Button>
              )}
              <Button type="button" variant="outline" asChild>
                <a href={`${endpoint}?download=1`} download>
                  <Download />
                  저장된 검토 결과 다운로드
                </a>
              </Button>
            </div>
            <p className="text-xs leading-6 text-muted-foreground">
              저장 시각: {workflow.updatedAt ? formatDate(workflow.updatedAt) : "저장 전"}. 현재
              확인한 화면의 항목만 점검합니다. 다음 단계와 기관 전체 필수서류의 확인은 별도로
              필요합니다.
            </p>
            <h4 className="font-semibold">전체 제출 전 점검 결과</h4>
            <ul className="space-y-2 text-sm leading-6">
              {workflow.report.issues.map((issue, index) => (
                <li
                  key={`${issue.code}-${index}`}
                  className={`rounded-lg border p-3 ${issue.severity === "error" ? "border-destructive/20 bg-destructive/5" : "bg-muted/25"}`}
                >
                  <span
                    className={`mr-2 text-xs font-semibold ${issue.severity === "error" ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {issue.severity === "error" ? "보완" : "안내"}
                  </span>
                  {issue.message}
                </li>
              ))}
            </ul>
            {!draftStale &&
              (workflow.report.textFields.length > 0 || workflow.report.attachments.length > 0) && (
                <details className="rounded-xl border p-4">
                  <summary className="cursor-pointer text-sm font-semibold">
                    저장된 입력·첨부 연결 미리보기
                  </summary>
                  <div className="mt-3 space-y-3">
                    {workflow.report.textFields.map((field, index) => (
                      <details
                        key={`${field.fieldKey}-${index}`}
                        className="rounded-lg bg-muted/30 p-3"
                      >
                        <summary className="cursor-pointer break-words text-xs leading-6">
                          {field.label} · {field.characterCount.toLocaleString()}자
                          {field.maxLength !== null
                            ? ` / 최대 ${field.maxLength.toLocaleString()}자`
                            : ""}{" "}
                          · {field.confirmed ? "연결 확인" : "확인 필요"}
                        </summary>
                        <p className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">
                          {field.value || "내용 없음"}
                        </p>
                        {field.financialContext && (
                          <FinancialEvidence context={field.financialContext} />
                        )}
                      </details>
                    ))}
                    {workflow.report.attachments.map((file, index) => (
                      <p
                        key={`${file.fieldKey}-${file.sourceId}-${index}`}
                        className="break-words rounded-lg bg-muted/30 p-3 text-xs leading-6"
                      >
                        {file.label} → {file.originalName} ·{" "}
                        {Math.ceil(file.sizeBytes / 1024).toLocaleString()}KB ·{" "}
                        {file.confirmed ? "용도 확인" : "확인 필요"}
                      </p>
                    ))}
                  </div>
                </details>
              )}
            <VentureinExecutionPanel
              key={company.id}
              endpoint={endpoint}
              workflow={workflow}
              companyRevision={company.revision}
              accountRevision={connection.account.revision}
              sessionStartedAt={connection.session.startedAt}
              bindingKey={[
                company.id,
                company.revision,
                connection.account.revision,
                connection.session.startedAt,
                connection.session.state,
                workflow.revision,
                screen?.id,
                dirty,
                draftStale,
                workflow.report.inputReadiness?.ready ?? "unknown",
                executionBlocked,
                executionReviewVersion,
              ].join(":")}
              blockedReason={
                dirty
                  ? "먼저 연결 변경을 저장하고 선택 입력 준비를 확인해 주세요."
                  : executionBlocked
                    ? "계정의 미저장 변경이나 진행 중인 작업을 먼저 처리해 주세요."
                    : busy
                      ? "진행 중인 작업이 끝난 뒤 검토안을 준비할 수 있습니다."
                      : !connected
                        ? "벤처인 로그인 연결을 먼저 완료해 주세요."
                        : !snapshotCurrent || draftStale
                          ? "현재 연결과 다른 화면 기록입니다. 공식 화면을 다시 읽고 항목을 확인해 주세요."
                          : !workflow.report.inputReadiness
                            ? "선택 입력 준비 정보가 없습니다. 점검 결과 새로고침으로 최신 상태를 확인해 주세요."
                            : workflow.report.inputReadiness.ready !== true
                              ? "위 선택 항목 입력 전 보완사항을 해결한 뒤 검토안을 준비할 수 있습니다."
                              : ""
              }
              canRefresh={!dirty && !busy && !executionBlocked}
              describeSource={(source) =>
                sourceOptions.find(
                  (option) =>
                    option.value ===
                    (source.kind === "profile"
                      ? `profile:${source.property}`
                      : `section:${source.sectionKey}`),
                )?.label ?? "연결 근거 확인 필요"
              }
              onBusyChange={(value) => {
                if (value) ++requestRef.current;
                setExecutionBusy(value);
              }}
              onWorkflowChange={(value) => acceptStatus(value, ++requestRef.current)}
            />
          </Step>
        </fieldset>
      )}
    </div>
  );
}
