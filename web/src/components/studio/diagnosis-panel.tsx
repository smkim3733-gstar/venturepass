"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, ClipboardCheck, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  diagnosisAnswersSchema,
  diagnosisCriteriaSources,
  diagnosisCriteriaVersion,
  emptyDiagnosisAnswers,
  MAX_DIAGNOSES,
  type Diagnosis,
  type DiagnosisAnswers,
  type DiagnosisItem,
} from "@/lib/studio-diagnosis-types";
import type { SourceDocument } from "@/lib/studio-schema";
import {
  EmptyPanel,
  formatDate,
  Notice,
  PanelHeading,
  selectClass,
  useDirty,
  type PanelProps,
  type StudioMutation,
} from "./shared";

type Assessment = DiagnosisAnswers["sme"];
type AssessmentKey = "sme" | "industryEligibility";
const outcomeLabels: Record<Diagnosis["outcome"], string> = {
  draft_recommended: "미확인 사항을 표시한 초안 작성 진행 권장",
  reinforce_first: "보강 후 진행 권장",
  eligibility_issue: "신청요건 관련 검토 문제 있음",
  insufficient: "자료 부족으로 판단 보류",
};
const areaLabels: Record<DiagnosisItem["area"], string> = {
  eligibility: "기본요건",
  technology: "기술 설명 준비",
  growth: "고객·사업 설명 준비",
  reliability: "자료 신뢰성과 일치",
};
const statusLabels: Record<DiagnosisItem["status"], string> = {
  supported: "연결 근거 있음",
  contradicted: "문제 근거 있음",
  unknown: "확인 필요",
  not_applicable: "해당 없음",
  needs_work: "보강 필요",
};

export function canReviewDiagnosisAssessment(
  value: Assessment,
  sources: SourceDocument[],
  criteriaCurrent: boolean,
) {
  return (
    criteriaCurrent &&
    value.evidence.length > 0 &&
    value.evidence.every((reference) => {
      const matches = sources.filter((source) => source.id === reference.sourceId);
      const source = matches[0];
      return (
        matches.length === 1 &&
        source.extraction !== "pending" &&
        source.updatedAt === reference.sourceUpdatedAt &&
        Boolean(reference.quote.trim() && reference.locator.trim()) &&
        source.text.includes(reference.quote.trim()) &&
        (value.status === "unknown" ||
          Boolean(source.originalName && source.kind !== "consultation"))
      );
    })
  );
}

export function DiagnosisAssessmentEditor({
  assessmentKey,
  value,
  sources,
  criteriaCurrent,
  onChange,
}: {
  assessmentKey: AssessmentKey;
  value: Assessment;
  sources: SourceDocument[];
  criteriaCurrent: boolean;
  onChange: (value: Assessment) => void;
}) {
  const isSme = assessmentKey === "sme";
  const title = isSme ? "중소기업 해당 여부" : "신청 제외업종 해당 여부";
  const prefix = `diagnosis-${assessmentKey}`;
  const change = (next: Assessment) => onChange({ ...next, reviewed: false });
  const canReview = canReviewDiagnosisAssessment(value, sources, criteriaCurrent);
  return (
    <fieldset className="space-y-4 rounded-xl border p-4">
      <legend className="px-1 text-sm font-semibold">{title} · 사용자 검토</legend>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-status`}>검토한 상태</Label>
        <select
          id={`${prefix}-status`}
          className={selectClass}
          value={value.status}
          onChange={(event) =>
            change({ ...value, status: event.target.value as Assessment["status"] })
          }
        >
          <option value="unknown">확인 필요 · 아직 판단하지 않음</option>
          <option value="supported">
            {isSme ? "중소기업에 해당하는 근거 있음" : "신청 제외업종이 아닌 근거 있음"}
          </option>
          <option value="contradicted">
            {isSme ? "중소기업에 해당하지 않는 근거 있음" : "신청 제외업종에 해당하는 근거 있음"}
          </option>
        </select>
      </div>
      <p className="text-xs leading-6 text-muted-foreground">
        자료에 기재된 사실과 공식 안내의 적용 여부를 직접 검토하세요. 본문이 없는 원본이나
        보유자료의 제목만으로 해당 여부를 판단하지 않습니다.
      </p>
      {value.evidence.map((reference, index) => {
        const source = sources.find((item) => item.id === reference.sourceId);
        const usable = source && source.extraction !== "pending" && source.text.trim();
        const exact = Boolean(
          usable &&
          reference.sourceUpdatedAt === source.updatedAt &&
          reference.quote.trim() &&
          source.text.includes(reference.quote.trim()),
        );
        const changeReference = (changed: typeof reference) =>
          change({
            ...value,
            evidence: value.evidence.map((item, position) => (position === index ? changed : item)),
          });
        return (
          <div key={index} className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold">근거 {index + 1}</h4>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${title} 근거 ${index + 1} 삭제`}
                onClick={() =>
                  change({
                    ...value,
                    evidence: value.evidence.filter((_, position) => position !== index),
                  })
                }
              >
                <Trash2 />
                근거 삭제
              </Button>
            </div>
            <Label htmlFor={`${prefix}-source-${index}`}>현재 기업의 자료</Label>
            <select
              id={`${prefix}-source-${index}`}
              className={selectClass}
              value={reference.sourceId}
              onChange={(event) =>
                changeReference({
                  sourceId: event.target.value,
                  sourceUpdatedAt:
                    sources.find((item) => item.id === event.target.value)?.updatedAt ?? "",
                  quote: "",
                  locator: "",
                })
              }
            >
              <option value="">자료 선택</option>
              {reference.sourceId && !source && (
                <option value={reference.sourceId} disabled>
                  현재 자료에 없는 이전 연결
                </option>
              )}
              {sources.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={item.extraction === "pending" || !item.text.trim()}
                >
                  {item.name}
                  {item.extraction === "pending" || !item.text.trim() ? " · 본문 확인 필요" : ""}
                </option>
              ))}
            </select>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-quote-${index}`}>현재 본문의 정확한 원문 인용</Label>
              <Textarea
                id={`${prefix}-quote-${index}`}
                value={reference.quote}
                maxLength={1500}
                onChange={(event) => changeReference({ ...reference, quote: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-locator-${index}`}>
                원문 위치 · 페이지 또는 확인 가능한 위치
              </Label>
              <Input
                id={`${prefix}-locator-${index}`}
                value={reference.locator}
                maxLength={150}
                placeholder="예: 원본 2페이지, 업종 항목"
                onChange={(event) => changeReference({ ...reference, locator: event.target.value })}
              />
            </div>
            <p
              className={`text-xs leading-6 ${exact ? "text-muted-foreground" : "text-amber-900"}`}
            >
              {exact
                ? "인용 문구가 현재 자료 본문에 있습니다. 기재 사실의 진위나 요건 충족을 확인한 것은 아닙니다."
                : "현재 본문에서 정확한 인용을 확인할 수 없습니다. 자료와 인용을 다시 확인해 주세요."}
            </p>
            {usable && reference.sourceUpdatedAt !== source.updatedAt && (
              <div className="space-y-2">
                <p className="text-xs leading-6 text-amber-900">
                  연결 후 자료가 변경되었습니다. 인용이 남아 있어도 이전 검토를 재사용하지 않습니다.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    changeReference({ ...reference, sourceUpdatedAt: source.updatedAt })
                  }
                >
                  현재 자료로 연결 갱신 · 다시 검토
                </Button>
              </div>
            )}
            {usable && (!source.originalName || source.kind === "consultation") && (
              <p className="text-xs leading-6 text-amber-900">
                기업 설명·직접 메모 자료입니다. 이 자료만으로 기본요건의 긍정·부정 판단을 확정할 수
                없습니다.
              </p>
            )}
            {usable && (
              <details>
                <summary className="cursor-pointer text-xs font-medium">
                  선택한 자료 본문 확인
                </summary>
                <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm leading-7">
                  {source.text}
                </p>
              </details>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={value.evidence.length >= 6}
        onClick={() =>
          change({
            ...value,
            evidence: [
              ...value.evidence,
              { sourceId: "", sourceUpdatedAt: "", quote: "", locator: "" },
            ],
          })
        }
      >
        <Plus />
        원문 근거 연결
      </Button>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-note`}>검토 사유·미확인 사항</Label>
        <Textarea
          id={`${prefix}-note`}
          maxLength={2000}
          value={value.note}
          onChange={(event) => change({ ...value, note: event.target.value })}
        />
      </div>
      <label className="flex items-start gap-2 text-sm leading-6">
        <input
          type="checkbox"
          className="mt-1 accent-primary"
          checked={value.reviewed && canReview}
          disabled={!canReview}
          onChange={(event) => onChange({ ...value, reviewed: event.target.checked })}
        />
        <span>공식 안내와 연결한 원문을 대조하고 위 판단 사유를 검토했습니다.</span>
      </label>
      {!canReview && (
        <p className="text-xs leading-6 text-muted-foreground">
          현재 기준 확인과 최신 원문·위치 연결 후 검토 확인을 선택할 수 있습니다. 미확인 사항은 확인
          필요로 남기세요.
        </p>
      )}
    </fieldset>
  );
}

export function DiagnosisResultView({
  diagnosis,
  current,
}: {
  diagnosis: Diagnosis;
  current: boolean;
}) {
  return (
    <section
      aria-label={`사전진단 v${diagnosis.version} 결과`}
      className="space-y-4 rounded-2xl border p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">사전진단 v{diagnosis.version}</Badge>
        <Badge variant="outline">{current ? "현재 자료 기준" : "지난 결과 · 재진단 필요"}</Badge>
        <span className="text-xs text-muted-foreground">{formatDate(diagnosis.generatedAt)}</span>
      </div>
      <h3 className="text-lg font-semibold">{outcomeLabels[diagnosis.outcome]}</h3>
      <p className="break-words text-xs leading-6 text-muted-foreground">
        기준 {diagnosis.criteriaVersion} · 생성 당시 자료 버전 {diagnosis.sourceRevision}
      </p>
      <Notice>
        자료와 사용자 검토를 정리한 로컬 사전진단입니다. 외부 AI를 사용하지 않으며 기재 사실의
        진위·신청자격 확정·심사 통과를 판정하지 않습니다. 기술·고객 설명은 검토 전 참고이며, 원고
        작성 권장은 제출 준비 완료가 아닙니다.
      </Notice>
      {!current && (
        <Notice tone="warning">
          이 결과는 현재 자료·답변·기준을 반영하지 않을 수 있습니다. 지난 근거를 보존해 표시하며,
          보강 업무 등록에는 최신 진단을 사용하세요.
        </Notice>
      )}
      {diagnosis.warnings.length > 0 && (
        <Notice tone="warning">
          <ul className="list-inside list-disc">
            {diagnosis.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="space-y-3">
        {diagnosis.items.map((item) => (
          <article key={item.id} className="space-y-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{areaLabels[item.area]}</Badge>
              <Badge variant="outline">
                {item.area === "eligibility" && item.status === "supported"
                  ? "사용자 검토 근거 있음"
                  : statusLabels[item.status]}
              </Badge>
            </div>
            <h4 className="font-semibold">{item.title}</h4>
            <p className="whitespace-pre-wrap text-sm leading-7">{item.reason}</p>
            {item.unknowns.length > 0 && (
              <div className="text-sm leading-7">
                <p className="font-medium">미확인 사항</p>
                <ul className="list-inside list-disc">
                  {item.unknowns.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </div>
            )}
            {item.nextActions.length > 0 && (
              <div className="text-sm leading-7">
                <p className="font-medium">다음 행동</p>
                <ul className="list-inside list-disc">
                  {item.nextActions.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </div>
            )}
            {item.evidence.length ? (
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  진단 당시 근거 {item.evidence.length}개
                </summary>
                <div className="mt-3 space-y-3">
                  {item.evidence.map((reference, index) => (
                    <div key={index} className="rounded-lg bg-muted/30 p-3 text-xs leading-6">
                      <p className="break-words font-semibold">
                        {reference.sourceName} · {reference.locator || "위치 미기재"}
                      </p>
                      <p>
                        {reference.provenance === "reported" ? "기업 설명 자료" : "문서 기재 자료"}{" "}
                        {Number.isFinite(Date.parse(reference.sourceUpdatedAt))
                          ? ` · 당시 자료 수정 시각 ${formatDate(reference.sourceUpdatedAt)}`
                          : " · 개별 수정 시각 미기록 · 진단 생성 시점 기준"}
                      </p>
                      <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 pl-3">
                        {reference.quote}
                      </blockquote>
                      <p className="mt-2 text-muted-foreground">
                        생성 당시 보관한 인용입니다. 현재 본문이나 사실의 진위를 보증하지 않습니다.
                      </p>
                    </div>
                  ))}
                </div>
              </details>
            ) : (
              <p className="text-xs text-muted-foreground">이 항목에 연결된 원문 근거 없음</p>
            )}
          </article>
        ))}
      </div>
      {diagnosis.questions.length > 0 && (
        <div className="space-y-3">
          <h4 className="font-semibold">추가 질문·부족 자료</h4>
          {diagnosis.questions.map((question) => (
            <div key={question.id} className="rounded-xl bg-muted/30 p-4 text-sm leading-7">
              <p className="font-medium">{question.question}</p>
              <p className="text-muted-foreground">{question.reason}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function DiagnosisPanel({
  company,
  mutate,
  setDirty,
  goToProfile,
  goToSources,
  goToAnalysis,
}: PanelProps & { goToProfile: () => void; goToSources: () => void; goToAnalysis: () => void }) {
  const savedAnswers = company.diagnosisAnswers ?? emptyDiagnosisAnswers();
  const [answers, setAnswers] = useState<DiagnosisAnswers>(() => structuredClone(savedAnswers));
  const diagnoses = [...(company.diagnoses ?? [])].sort((one, two) => two.version - one.version);
  const latest = diagnoses[0];
  const diagnosisLimitReached =
    diagnoses.length >= MAX_DIAGNOSES &&
    !(latest && !latest.stale && latest.criteriaVersion === diagnosisCriteriaVersion);
  const [selectedId, setSelectedId] = useState(latest?.id ?? "");
  const selected = diagnoses.find((diagnosis) => diagnosis.id === selectedId);
  const [selectedActions, setSelectedActions] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [initialBinding] = useState(`${company.id}:${company.revision}`);
  const binding = `${company.id}:${company.revision}`;
  const context = useRef(binding);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const diagnosisNonce = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    context.current = binding;
  }, [binding]);
  const answersDirty = JSON.stringify(answers) !== JSON.stringify(savedAnswers);
  const bindingChanged = initialBinding !== binding;
  const currentResult = Boolean(
    selected &&
    !selected.stale &&
    selected.criteriaVersion === diagnosisCriteriaVersion &&
    selected.id === latest?.id,
  );
  const registeredActions = new Set(
    company.tasks
      .filter((task) => task.diagnosisOrigin?.diagnosisId === selected?.id)
      .map((task) => task.diagnosisOrigin!.actionId),
  );
  useDirty(answersDirty || selectedActions.length > 0 || !!busy, setDirty);
  async function run(mutation: StudioMutation, message: string) {
    if (inFlight.current || bindingChanged) return;
    inFlight.current = true;
    setBusy(message);
    setError("");
    try {
      const saved = await mutate(mutation);
      if (!saved && mounted.current && context.current === binding)
        setError(
          "저장하지 못했습니다. 입력 내용은 유지했습니다. 오류 안내와 최신 기업 버전을 확인해 주세요.",
        );
    } catch (caught) {
      if (mounted.current && context.current === binding)
        setError(
          caught instanceof Error
            ? caught.message
            : "처리하지 못했습니다. 입력 내용은 유지했습니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy("");
    }
  }
  function saveAnswers() {
    const parsed = diagnosisAnswersSchema.safeParse(answers);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "검토 답변과 원문 근거를 확인해 주세요.");
      return;
    }
    void run(
      { action: "diagnosis-answers", answers: parsed.data },
      "기본요건 검토 답변을 저장하고 있습니다.",
    );
  }
  function diagnose() {
    if (answersDirty || selectedActions.length || diagnosisLimitReached) return;
    diagnosisNonce.current ??= crypto.randomUUID();
    void run(
      { action: "diagnose", clientRequestId: diagnosisNonce.current },
      "저장된 기업자료와 검토 답변으로 사전진단을 만들고 있습니다.",
    );
  }
  function createTasks() {
    if (answersDirty || !currentResult || !selected || !selectedActions.length) return;
    const allowed = new Set(selected.actions.map((action) => action.id));
    if (selectedActions.some((id) => !allowed.has(id) || registeredActions.has(id))) return;
    void run(
      { action: "diagnosis-tasks", diagnosisId: selected.id, actionIds: selectedActions },
      "선택한 보강 과제를 진행 관리에 등록하고 있습니다.",
    );
  }
  return (
    <div className="space-y-5">
      <PanelHeading
        title="우리 회사 혁신성장유형 사전진단"
        description="저장된 회사 설명과 현재 자료, 사용자가 검토한 기본요건을 구분해 부족한 근거와 다음 행동을 확인합니다."
      />
      <Notice>
        기본요건에 관한 긍정·부정 판단에는 현재 기준의 직접 검토와 정확한 원문 인용이 필요합니다.
        자료 부족을 요건 미충족으로 처리하지 않습니다. 특허·연구소·매출 보유만으로 일률적인 신청
        가능 여부를 판단하지 않습니다.
      </Notice>
      {bindingChanged && (
        <Notice tone="warning">
          기업 버전이 바뀌어 이 편집본은 저장할 수 없습니다. 작성 내용을 보존한 뒤 최신 기업자료에서
          다시 준비해 주세요.
        </Notice>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm leading-6 text-destructive"
        >
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm leading-6">
          {busy}
        </p>
      )}
      <fieldset disabled={!!busy || bindingChanged} className="space-y-4 rounded-2xl border p-5">
        <legend className="px-1 font-semibold">기본요건 검토 답변</legend>
        <div className="space-y-2">
          <Label htmlFor="diagnosis-entity-type">기업 형태</Label>
          <select
            id="diagnosis-entity-type"
            className={selectClass}
            value={answers.entityType}
            onChange={(event) =>
              setAnswers({
                ...answers,
                entityType: event.target.value as DiagnosisAnswers["entityType"],
                sme: { ...answers.sme, reviewed: false },
                industryEligibility: { ...answers.industryEligibility, reviewed: false },
              })
            }
          >
            <option value="unknown">확인 필요</option>
            <option value="corporate">법인</option>
            <option value="sole">개인사업자</option>
          </select>
        </div>
        <details className="space-y-3 rounded-xl bg-muted/30 p-4" open>
          <summary className="cursor-pointer text-sm font-semibold">적용 기준과 검토 출처</summary>
          <p className="break-all text-xs leading-6">{diagnosisCriteriaVersion}</p>
          {diagnosisCriteriaSources.map((source) => (
            <div key={source.url} className="text-xs leading-6">
              <a
                className="font-medium underline underline-offset-2"
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                {source.title}
              </a>
              <p>
                {source.checkedOn} 확인 · {source.scope}
              </p>
            </div>
          ))}
        </details>
        <label className="flex items-start gap-2 text-sm leading-6">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={answers.criteriaVersion === diagnosisCriteriaVersion}
            onChange={(event) =>
              setAnswers({
                ...answers,
                criteriaVersion: event.target.checked ? diagnosisCriteriaVersion : null,
                sme: { ...answers.sme, reviewed: false },
                industryEligibility: { ...answers.industryEligibility, reviewed: false },
              })
            }
          />
          <span>위 기준과 공식 안내를 현재 기업에 적용할 때 확인할 내용을 직접 검토했습니다.</span>
        </label>
        {(["sme", "industryEligibility"] as const).map((key) => (
          <DiagnosisAssessmentEditor
            key={key}
            assessmentKey={key}
            value={answers[key]}
            sources={company.sources}
            criteriaCurrent={answers.criteriaVersion === diagnosisCriteriaVersion}
            onChange={(value) => setAnswers({ ...answers, [key]: value })}
          />
        ))}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!answersDirty}
            onClick={() => {
              if (window.confirm("저장하지 않은 검토 답변을 되돌릴까요?"))
                setAnswers(structuredClone(savedAnswers));
            }}
          >
            편집 되돌리기
          </Button>
          <Button type="button" disabled={!answersDirty} onClick={saveAnswers}>
            <Save />
            검토 답변 저장
          </Button>
        </div>
      </fieldset>
      <div className="space-y-2">
        <Button
          type="button"
          disabled={
            !!busy ||
            bindingChanged ||
            answersDirty ||
            selectedActions.length > 0 ||
            diagnosisLimitReached
          }
          onClick={diagnose}
        >
          <ClipboardCheck />
          {latest ? "현재 자료로 진단 확인" : "저장된 자료로 사전진단"}
        </Button>
        <p className="text-xs leading-6 text-muted-foreground">
          자료·검토 답변·기준이 같으면 생성 시각과 버전을 유지한 기존 결과를 사용합니다.
        </p>
        {answersDirty && (
          <p className="text-xs text-muted-foreground">
            변경한 검토 답변을 먼저 저장하세요. 아래 결과는 이전에 저장한 답변 기준입니다.
          </p>
        )}
        {diagnosisLimitReached && (
          <p className="text-xs text-muted-foreground">
            진단 이력 보관 한도에 도달했습니다. 기존 결과는 보존합니다.
          </p>
        )}
      </div>
      {diagnoses.length > 0 ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="diagnosis-history">보관한 진단 이력</Label>
            <select
              id="diagnosis-history"
              className={selectClass}
              value={selectedId}
              disabled={!!busy}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setSelectedActions([]);
              }}
            >
              {diagnoses.map((diagnosis) => (
                <option key={diagnosis.id} value={diagnosis.id}>
                  v{diagnosis.version} · {formatDate(diagnosis.generatedAt)} ·{" "}
                  {diagnosis.stale ||
                  diagnosis.criteriaVersion !== diagnosisCriteriaVersion ||
                  diagnosis.id !== latest?.id
                    ? "지난 결과"
                    : "현재 자료 기준"}
                </option>
              ))}
            </select>
          </div>
          {selected && (
            <DiagnosisResultView
              diagnosis={selected}
              current={currentResult && !answersDirty && !bindingChanged}
            />
          )}
          {selected && selected.actions.length > 0 && (
            <fieldset
              disabled={!!busy || answersDirty || bindingChanged || !currentResult}
              className="space-y-3 rounded-2xl border p-5"
            >
              <legend className="px-1 font-semibold">보강 과제를 진행 관리에 연결</legend>
              <p className="text-xs leading-6 text-muted-foreground">
                실제 자료 확인·발급·시험·고객 검증이 필요한 일을 선택하세요. 문구 수정이나 업무
                등록만으로 과제가 해결되지는 않습니다.
              </p>
              {selected.actions.map((action) => (
                <label key={action.id} className="flex items-start gap-2 text-sm leading-6">
                  <input
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={selectedActions.includes(action.id)}
                    disabled={registeredActions.has(action.id)}
                    onChange={(event) =>
                      setSelectedActions(
                        event.target.checked
                          ? [...selectedActions, action.id]
                          : selectedActions.filter((id) => id !== action.id),
                      )
                    }
                  />
                  <span>
                    <span className="block font-medium">{action.title}</span>
                    {registeredActions.has(action.id) && (
                      <Badge variant="outline">이미 등록됨</Badge>
                    )}
                    <span className="block whitespace-pre-wrap text-xs text-muted-foreground">
                      {action.notes}
                    </span>
                  </span>
                </label>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={!selectedActions.length}
                onClick={createTasks}
              >
                선택한 보강 업무 등록
              </Button>
              {!currentResult && (
                <p className="text-xs text-muted-foreground">
                  현재 자료로 만든 최신 진단에서 업무를 등록해 주세요.
                </p>
              )}
            </fieldset>
          )}
        </>
      ) : (
        <EmptyPanel
          title="아직 보관한 사전진단이 없습니다"
          description="모르는 기본요건은 확인 필요로 남겨도 됩니다. 저장된 기업정보와 확인한 자료로 진단을 만들고 필요한 근거부터 보강하세요."
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={!!busy} onClick={goToProfile}>
          기업정보 보강
        </Button>
        <Button type="button" variant="outline" disabled={!!busy} onClick={goToSources}>
          자료함에서 근거 보강
        </Button>
        <Button type="button" variant="outline" disabled={!!busy} onClick={goToAnalysis}>
          미확인 사항을 유지하고 아이템 분석
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}
