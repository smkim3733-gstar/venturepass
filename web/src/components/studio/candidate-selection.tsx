"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StudioCase } from "@/lib/studio-schema";
import {
  candidateSelectionLimits,
  candidateSelectionMutationSchema,
  candidateSelectionSchema,
  currentCandidateSelection,
  selectionSnapshotMatches,
  type CandidateSelection,
} from "@/lib/studio-candidate-selection-types";
import { Notice, formatDate, type PanelProps } from "./shared";
import { CandidateClassificationNotice } from "./candidate-classification";

export function candidateSelectionRequest(
  company: StudioCase,
  candidateId: string,
  reason: string,
  clientRequestId: string,
) {
  const analysis = company.analysis;
  if (!analysis || analysis.candidates.filter((item) => item.id === candidateId).length !== 1)
    return null;
  const parsed = candidateSelectionMutationSchema.safeParse({
    action: "select-candidate",
    revision: company.revision,
    clientRequestId,
    candidateId,
    analysisGeneratedAt: analysis.generatedAt,
    analysisSourceRevision: analysis.sourceRevision,
    expectedSelectedCandidateId: company.selectedCandidateId,
    reason,
  });
  return parsed.success ? parsed.data : null;
}

export function candidateSelectionAcknowledged(
  response: StudioCase | null,
  company: StudioCase,
  request: NonNullable<ReturnType<typeof candidateSelectionRequest>>,
): boolean {
  if (!response || response.id !== company.id || response.revision < company.revision) return false;
  const matches = (response.candidateSelections ?? []).filter(
    (record) => record.clientRequestId === request.clientRequestId,
  );
  if (matches.length !== 1) return false;
  const parsed = candidateSelectionSchema.safeParse(matches[0]);
  const target = company.analysis?.candidates.filter((item) => item.id === request.candidateId);
  if (!parsed.success || target?.length !== 1) return false;
  const record = parsed.data;
  return (
    record.candidateId === request.candidateId &&
    record.previousCandidateId === request.expectedSelectedCandidateId &&
    record.analysisGeneratedAt === request.analysisGeneratedAt &&
    record.analysisSourceRevision === request.analysisSourceRevision &&
    record.analysisMode === company.analysis?.mode &&
    record.reason === request.reason &&
    selectionSnapshotMatches(record.candidate, target[0]) &&
    currentCandidateSelection(response)?.id === record.id
  );
}

type EditorProps = Pick<PanelProps, "company" | "mutate"> & {
  candidateId: string;
  onClose: () => void;
};

export function CandidateSelectionEditor(props: EditorProps) {
  return (
    <CandidateSelectionForm
      key={`${props.company.id}:${props.company.revision}:${props.candidateId}`}
      {...props}
    />
  );
}

function CandidateSelectionForm({ company, candidateId, mutate, onClose }: EditorProps) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const nonce = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const candidates = company.analysis?.candidates.filter((item) => item.id === candidateId) ?? [];
  const candidate = candidates.length === 1 ? candidates[0] : null;
  const atLimit = (company.candidateSelections ?? []).length >= candidateSelectionLimits.records;
  const selected = company.selectedCandidateId === candidateId;

  async function save() {
    if (inFlight.current || !candidate || atLimit) return;
    const requestId = nonce.current ?? crypto.randomUUID();
    const request = candidateSelectionRequest(company, candidateId, reason, requestId);
    if (!request) {
      setError("현재 분석의 고유 후보와 선택 이유 1~2,000자를 확인해 주세요.");
      return;
    }
    nonce.current = requestId;
    inFlight.current = true;
    setSaving(true);
    setAttempted(true);
    setError("");
    try {
      const response = await mutate(request);
      if (!mounted.current) return;
      if (candidateSelectionAcknowledged(response, company, request)) onClose();
      else
        setError(
          "저장 결과를 확인하지 못했습니다. 선택 이유와 요청 번호를 유지합니다. 같은 내용으로 결과를 확인하거나 최신 기업 기록을 확인해 주세요.",
        );
    } catch {
      if (mounted.current)
        setError(
          "저장 결과를 확인하지 못했습니다. 자동 재시도하지 않으며 같은 요청 번호와 내용을 유지합니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <fieldset disabled={saving} className="space-y-4 border-b bg-muted/20 p-5">
      <legend className="px-2 text-sm font-bold">
        {selected ? "현재 아이템의 선택 이유 기록" : "아이템 선택 이유"}
      </legend>
      <p className="text-sm leading-6">
        {candidate ? `대상: ${candidate.title}` : "현재 분석에서 후보를 고유하게 찾을 수 없습니다."}
      </p>
      {candidate && <CandidateClassificationNotice candidate={candidate} />}
      <p className="text-xs leading-6 text-muted-foreground">
        위 추천 이유와 별도로 직접 판단한 이유를 남깁니다. 과거 이유를 정정할 때도 새 기록으로
        보존합니다. 선택 기록은 사실 확인·기관 적합성 판단·원고 검토 완료가 아닙니다.
      </p>
      {!selected && company.plans.length > 0 && (
        <Notice tone="warning">
          후보를 변경하면 기존 원고를 보존하고 전체 내용을 새 주제로 다시 검토해야 합니다. 이 저장은
          원고를 자동 재작성하지 않습니다.
        </Notice>
      )}
      {atLimit && (
        <Notice tone="warning">
          선택 기록 {candidateSelectionLimits.records}개 한도입니다. 과거 기록은 보존합니다.
        </Notice>
      )}
      <div className="space-y-2">
        <Label htmlFor="candidate-selection-reason">직접 선택한 이유 또는 정정 사유 *</Label>
        <Textarea
          id="candidate-selection-reason"
          value={reason}
          maxLength={2000}
          disabled={attempted}
          onChange={(event) => {
            setReason(event.target.value);
            setError("");
          }}
          placeholder="회사의 실제 역량·고객·근거와 연결해 선택 이유를 적어 주세요."
        />
      </div>
      {attempted && !saving && (
        <p className="text-xs text-amber-900">
          요청 후에는 같은 내용으로만 결과를 확인합니다. 수정하려면 저장 기록을 확인한 뒤 편집을
          다시 시작해 주세요.
        </p>
      )}
      {error && (
        <div role="alert">
          <Notice tone="warning">{error}</Notice>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!candidate || atLimit || !reason.trim()}
          onClick={() => void save()}
        >
          {saving
            ? "선택 기록 저장 중"
            : attempted
              ? "같은 요청으로 저장 결과 확인"
              : selected
                ? "선택 이유 새 기록 저장"
                : "이유와 함께 이 아이템 선택"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (inFlight.current) return;
            if (
              (attempted || reason) &&
              !window.confirm(
                attempted
                  ? "요청이 이미 저장됐을 수 있습니다. 편집을 닫고 최신 기업 기록을 확인할까요?"
                  : "작성 중인 선택 이유를 취소할까요?",
              )
            )
              return;
            onClose();
          }}
        >
          편집 취소
        </Button>
      </div>
    </fieldset>
  );
}

function selectionDate(value: string) {
  return Number.isFinite(new Date(value).getTime()) ? formatDate(value) : "시각 확인 필요";
}

function SelectionRecordView({
  record,
  current,
}: {
  record: CandidateSelection;
  current: boolean;
}) {
  return (
    <article className="space-y-3 rounded-xl border p-4">
      <p className="text-xs text-muted-foreground">
        {selectionDate(record.recordedAt)} · 담당자 기록 ·{" "}
        {record.event === "selection" ? "아이템 선택" : "이유 추가·정정"}
        {current ? " · 현재 선택의 기록" : " · 과거 기록"}
      </p>
      <h4 className="font-semibold">{record.candidate.title}</h4>
      <CandidateClassificationNotice candidate={record.candidate} />
      <p className="text-xs leading-6">
        이전 선택:{" "}
        {record.previousContext === "none"
          ? "없음"
          : (record.previousCandidate?.title ?? "선택 ID만 남음 · 당시 후보 설명 확인 불가")}
      </p>
      <p className="whitespace-pre-wrap text-sm leading-7">{record.reason}</p>
      <details>
        <summary className="cursor-pointer text-xs font-semibold">
          선택 당시 후보 설명·추천 근거
        </summary>
        <p className="mt-3 text-xs text-muted-foreground">
          분석 {selectionDate(record.analysisGeneratedAt)} ·{" "}
          {record.analysisMode === "ai" ? "AI 분석" : "자료 기반 정리"}. 저장 당시 표기이며 현재
          근거 검증이나 원본 진위 확인이 아닙니다.
        </p>
        <dl className="mt-3 space-y-3 text-sm leading-7">
          {(
            [
              ["고객의 문제", record.candidate.problem],
              ["기술과 해결방법", record.candidate.solution],
              ["대상 고객", record.candidate.targetCustomer],
              ["차별성", record.candidate.differentiation],
              ["개발 단계", record.candidate.stage],
              ["사업모델", record.candidate.businessModel],
              ["당시 추천 이유", record.candidate.recommendation],
            ] as const
          ).map(([label, text]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="whitespace-pre-wrap">{text || "미기재"}</dd>
            </div>
          ))}
        </dl>
        {record.candidate.gaps.length > 0 && (
          <ul className="mt-3 list-inside list-disc text-xs leading-6">
            {record.candidate.gaps.map((gap, index) => (
              <li key={index}>{gap}</li>
            ))}
          </ul>
        )}
        {record.candidate.evidence.map((reference, index) => (
          <blockquote key={index} className="mt-3 border-l-2 pl-3 text-xs leading-6">
            <p className="whitespace-pre-wrap">{reference.quote || "인용 미기재"}</p>
            <p>{reference.locator || "위치 미기재"} · 선택 당시 연결 표기</p>
          </blockquote>
        ))}
      </details>
    </article>
  );
}

export function CandidateSelectionHistory({ company }: { company: StudioCase }) {
  const records = company.candidateSelections ?? [];
  const current = currentCandidateSelection(company);
  return (
    <section
      aria-label="아이템 선택 이유·변경 이력"
      className="mt-6 space-y-4 rounded-2xl border p-5"
    >
      <h3 className="font-bold">아이템 선택 이유·변경 이력</h3>
      {records.length >= candidateSelectionLimits.records && (
        <Notice tone="warning">
          선택 기록 {candidateSelectionLimits.records}개 한도입니다. 기존 기록을 보존하며 새
          선택·이유 기록은 추가할 수 없습니다.
        </Notice>
      )}
      {company.selectedCandidateId && !current && (
        <Notice tone="warning">
          기존 선택 · 현재 분석에 맞는 선택 이유 기록 없음. 추천 설명을 확인하고 이유를 직접 기록해
          주세요. 과거 이유나 시각을 추정하지 않습니다.
        </Notice>
      )}
      {records.length ? (
        <div className="space-y-3">
          {[...records].reverse().map((record) => (
            <SelectionRecordView
              key={record.id}
              record={record}
              current={current?.id === record.id}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">아직 저장한 선택 이유가 없습니다.</p>
      )}
      <p className="text-xs leading-6 text-muted-foreground">
        재분석·자료 변경 후에도 당시 선택과 이유를 보존합니다. 새 분석의 후보는 다시 확인하며, 이
        기록을 원고·외부 AI·공식 신청에 자동 전송하지 않습니다.
      </p>
    </section>
  );
}
