"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StudioCase } from "@/lib/studio-schema";
import {
  evaluateNumericCheck,
  numericBasisLabels,
  numericCheckContext,
  numericCheckInputSchema,
  numericCheckSchema,
  numericCheckLimits,
  numericOperationLabels,
  numericReasonLabels,
  numericUnitLabels,
  type NumericCheck,
  type NumericCheckInput,
  type NumericEvaluation,
  type NumericFormula,
  type NumericObservation,
} from "@/lib/studio-numeric-check-types";
import { Notice, selectClass, useDirty, type PanelProps } from "./shared";

export function newNumericObservation(): NumericObservation {
  return {
    id: crypto.randomUUID(),
    label: "",
    valueText: "",
    unit: "unknown",
    customUnit: "",
    period: { kind: "unknown", start: "", end: "" },
    basis: "unknown",
    reference: null,
    note: "",
  };
}
export function numericInputFor(previous?: NumericCheck): NumericCheckInput {
  return {
    checkId: previous?.checkId ?? null,
    previousVersionId: previous?.id ?? null,
    title: previous?.title ?? "",
    observations: previous ? structuredClone(previous.observations) : [newNumericObservation()],
    comparisons: previous ? structuredClone(previous.comparisons) : [],
    formulas: previous ? structuredClone(previous.formulas) : [],
    judgement: { state: "unreviewed", reviewer: "", note: "" },
  };
}
export function resetNumericJudgementAfterEdit(
  previous: NumericCheckInput,
  next: NumericCheckInput,
): NumericCheckInput {
  return JSON.stringify({ ...previous, judgement: null }) ===
    JSON.stringify({ ...next, judgement: null })
    ? next
    : { ...next, judgement: { ...next.judgement, state: "unreviewed" } };
}
export function latestNumericChecks(company: Pick<StudioCase, "numericChecks">) {
  const latest = new Map<string, NumericCheck>();
  for (const record of company.numericChecks ?? []) latest.set(record.checkId, record);
  return [...latest.values()];
}
export function numericCheckSaveAcknowledged(
  saved: StudioCase | null,
  companyId: string,
  nonce: string,
  input: NumericCheckInput,
): boolean {
  if (!saved || saved.id !== companyId || !Array.isArray(saved.numericChecks)) return false;
  const matches = saved.numericChecks.filter((item) => item?.clientRequestId === nonce);
  if (matches.length !== 1) return false;
  const parsed = numericCheckSchema.safeParse(matches[0]);
  if (!parsed.success) return false;
  const record = parsed.data;
  if (
    record.previousVersionId !== input.previousVersionId ||
    record.checkId !== (input.checkId ?? record.id) ||
    (input.checkId === null ? record.version !== 1 : record.version < 2)
  )
    return false;
  return (
    JSON.stringify({
      title: record.title,
      observations: record.observations,
      comparisons: record.comparisons,
      formulas: record.formulas,
      judgement: {
        state: record.judgement.state,
        reviewer: record.judgement.reviewer,
        note: record.judgement.note,
      },
    }) ===
    JSON.stringify({
      title: input.title,
      observations: input.observations,
      comparisons: input.comparisons,
      formulas: input.formulas,
      judgement: input.judgement,
    })
  );
}
const periodLabels = {
  unknown: "기간 미확인",
  point: "기준일",
  range: "기간",
  "not-applicable": "기간 해당 없음 (직접 선택)",
} as const;
const resultLabels = {
  "numeric-equal": "입력 수치 같음",
  "numeric-difference": "입력 수치 다름",
  "arithmetic-equal": "계산값과 입력값 같음",
  "arithmetic-difference": "계산값과 입력값 다름",
  "not-comparable": "비교 불가 · 확인 필요",
  "division-by-zero": "계산 불가 · 0으로 나눔",
} as const;
const judgementLabels = {
  unreviewed: "미검토",
  "needs-work": "보완 필요로 기록",
  reviewed: "담당자 내부 검토 기록",
} as const;
const unitText = (value: NumericObservation) =>
  value.unit === "custom" ? value.customUnit : numericUnitLabels[value.unit];
const periodText = (value: NumericObservation) =>
  `${periodLabels[value.period.kind]}${value.period.start ? ` ${value.period.start}` : ""}${value.period.end ? ` ~ ${value.period.end}` : ""}`;
export function numericDraftText(company: StudioCase, record: NumericCheck): string {
  const context = numericCheckContext(company, record);
  const lines = [
    "# DRAFT · 기간·단위·산식 수치 대조",
    record.title,
    `대조 v${record.version} · ${record.recordedAt}`,
    "담당자가 선택·전사한 값의 산술과 표기 대조입니다. 사실 진위·원문 해석·기관 판단은 확인하지 않았습니다.",
    "",
  ];
  for (const [index, value] of record.observations.entries()) {
    lines.push(
      `## 수치 ${index + 1}. ${value.label}`,
      `입력값: ${value.valueText || "미확인"} · ${unitText(value)}`,
      `기간: ${periodText(value)}`,
      `구분: ${numericBasisLabels[value.basis]}`,
      `메모: ${value.note || "미기재"}`,
    );
    const ref = value.reference;
    if (!ref) lines.push("근거 인용: 미연결");
    else if (ref.kind === "plan") {
      const plan = record.planSnapshots.find((item) => item.planId === ref.planId);
      lines.push(
        `원고: v${plan?.version ?? "확인 필요"} · ${ref.sectionKey}`,
        `인용: ${ref.quote}`,
        `저장 당시 원고 SHA256: ${plan?.contentSha256 ?? "미확인"}`,
      );
    } else {
      const source = record.sourceSnapshots.find((item) => item.sourceId === ref.sourceId);
      lines.push(
        `자료: ${source?.sourceName ?? "확인 필요"} · ${ref.sourceUpdatedAt}`,
        `위치: ${ref.locator || "미기재"}`,
        `인용: ${ref.quote}`,
      );
      if (source?.original)
        lines.push(
          `저장 당시 원본: ${source.original.sizeBytes} bytes · SHA256 ${source.original.sha256}`,
        );
    }
  }
  lines.push("", "## 저장 당시 입력값 대조");
  record.comparisons.forEach((pair, index) => {
    const result = record.evaluation.comparisons.find((item) => item.id === pair.id);
    lines.push(
      `비교 ${index + 1}: ${record.observations.find((item) => item.id === pair.leftId)?.label ?? "확인 필요"} / ${record.observations.find((item) => item.id === pair.rightId)?.label ?? "확인 필요"} · ${result ? resultLabels[result.state] : "결과 없음"}`,
      ...(result?.reasons.map((reason) => `- ${numericReasonLabels[reason]}`) ?? []),
    );
  });
  record.formulas.forEach((formula, index) => {
    const result = record.evaluation.formulas.find((item) => item.id === formula.id);
    lines.push(
      `산식 ${index + 1}: ${numericOperationLabels[formula.operation]} · 피연산값 [${formula.operandIds.map((id) => record.observations.find((item) => item.id === id)?.label ?? "확인 필요").join(", ")}] → 대조값 ${record.observations.find((item) => item.id === formula.expectedId)?.label ?? "확인 필요"}`,
      result ? resultLabels[result.state] : "결과 없음",
      ...(result?.result
        ? [
            `정확한 계산값: ${result.result.decimal ?? `${result.result.numerator}/${result.result.denominator} (분수 그대로 · 반올림 없음)`}`,
          ]
        : []),
      ...(result?.reasons.map((reason) => `- ${numericReasonLabels[reason]}`) ?? []),
    );
  });
  lines.push(
    "",
    `현재 등록정보·인용 대조: ${context.state === "current" ? "연결 유지" : "재확인 필요"}`,
    ...context.issues,
    `내부 판단: ${judgementLabels[record.judgement.state]} · ${record.judgement.reviewer || "담당자 미지정"} · ${record.judgement.recordedAt || "미기록"}`,
    record.judgement.note || "판단 메모 없음",
    "같은 수치·단위 표기도 동일 사실이나 비교 대상임을 입증하지 않습니다. 기간·단위 자동 환산과 기관 제출은 수행하지 않았습니다.",
    "원본 SHA는 저장 당시 값이며 현재 파일 바이트를 이 내려받기로 다시 검사하지 않습니다.",
  );
  return lines.join("\n");
}
function Field({
  id,
  label,
  value,
  max = 2000,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  max?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        maxLength={max}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
export function NumericObservationEditor({
  company,
  value,
  index,
  onChange,
  onRemove,
}: {
  company: StudioCase;
  value: NumericObservation;
  index: number;
  onChange: (value: NumericObservation) => void;
  onRemove: () => void;
}) {
  const prefix = `numeric-observation-${value.id}`,
    ref = value.reference;
  const source =
    ref?.kind === "source" ? company.sources.find((item) => item.id === ref.sourceId) : undefined;
  const plans = ref?.kind === "plan" ? company.plans.filter((item) => item.id === ref.planId) : [];
  const plan = plans.length === 1 ? plans[0] : undefined;
  const sections =
    plan?.content.sections.filter(
      (section) => plan.content.sections.filter((item) => item.key === section.key).length === 1,
    ) ?? [];
  const originalText =
    ref?.kind === "source"
      ? source?.text
      : sections.find((section) => section.key === (ref?.kind === "plan" ? ref.sectionKey : ""))
          ?.content;
  return (
    <fieldset className="space-y-4 rounded-xl border p-4">
      <legend className="px-2 font-semibold">관측 수치 {index + 1}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-label`}>수치 이름 *</Label>
          <Input
            id={`${prefix}-label`}
            value={value.label}
            maxLength={200}
            onChange={(event) => onChange({ ...value, label: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-value`}>원문 숫자 표기 (미확인은 비움)</Label>
          <Input
            id={`${prefix}-value`}
            value={value.valueText}
            maxLength={32}
            onChange={(event) => onChange({ ...value, valueText: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            부호·쉼표·소수를 그대로 입력합니다. 숫자 일부, 지수, 분수, 회계 음수 기호는 변환하지
            않습니다.
          </p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-unit`}>단위 직접 확인</Label>
          <select
            id={`${prefix}-unit`}
            className={selectClass}
            value={value.unit}
            onChange={(event) =>
              onChange({
                ...value,
                unit: event.target.value as NumericObservation["unit"],
                customUnit: "",
              })
            }
          >
            {Object.entries(numericUnitLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-basis`}>자료 기재·목표·가정 구분</Label>
          <select
            id={`${prefix}-basis`}
            className={selectClass}
            value={value.basis}
            onChange={(event) =>
              onChange({ ...value, basis: event.target.value as NumericObservation["basis"] })
            }
          >
            {Object.entries(numericBasisLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {value.unit === "custom" && (
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-custom`}>기타 단위의 정확한 표기 *</Label>
          <Input
            id={`${prefix}-custom`}
            value={value.customUnit}
            maxLength={60}
            onChange={(event) => onChange({ ...value, customUnit: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            표기가 같아도 의미가 같은 단위인지 담당자 확인이 필요합니다.
          </p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-period`}>기준일·기간</Label>
          <select
            id={`${prefix}-period`}
            className={selectClass}
            value={value.period.kind}
            onChange={(event) =>
              onChange({
                ...value,
                period: {
                  kind: event.target.value as NumericObservation["period"]["kind"],
                  start: "",
                  end: "",
                },
              })
            }
          >
            {Object.entries(periodLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {(value.period.kind === "range" || value.period.kind === "point") && (
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-start`}>
              {value.period.kind === "point" ? "기준일 *" : "시작일 *"}
            </Label>
            <Input
              id={`${prefix}-start`}
              type="date"
              value={value.period.start}
              onInput={(event) =>
                onChange({
                  ...value,
                  period: { ...value.period, start: event.currentTarget.value },
                })
              }
              onChange={(event) =>
                onChange({ ...value, period: { ...value.period, start: event.target.value } })
              }
            />
          </div>
        )}
        {value.period.kind === "range" && (
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-end`}>종료일 *</Label>
            <Input
              id={`${prefix}-end`}
              type="date"
              value={value.period.end}
              onInput={(event) =>
                onChange({ ...value, period: { ...value.period, end: event.currentTarget.value } })
              }
              onChange={(event) =>
                onChange({ ...value, period: { ...value.period, end: event.target.value } })
              }
            />
          </div>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-reference-kind`}>정확한 인용 연결</Label>
        <select
          id={`${prefix}-reference-kind`}
          className={selectClass}
          value={ref?.kind ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              reference:
                event.target.value === "source"
                  ? { kind: "source", sourceId: "", sourceUpdatedAt: "", quote: "", locator: "" }
                  : event.target.value === "plan"
                    ? { kind: "plan", planId: "", sectionKey: "", quote: "" }
                    : null,
            })
          }
        >
          <option value="">미연결 · 비교 불가로 보관</option>
          <option value="source">등록 자료 본문</option>
          <option value="plan">저장 원고의 항목</option>
        </select>
      </div>
      {ref?.kind === "source" && (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-source`}>같은 회사 자료 *</Label>
            <select
              id={`${prefix}-source`}
              className={selectClass}
              value={ref.sourceId}
              onChange={(event) => {
                const selected = company.sources.find((item) => item.id === event.target.value);
                onChange({
                  ...value,
                  reference: {
                    kind: "source",
                    sourceId: selected?.id ?? "",
                    sourceUpdatedAt: selected?.updatedAt ?? "",
                    quote: "",
                    locator: "",
                  },
                });
              }}
            >
              <option value="">자료 직접 선택</option>
              {company.sources.map((item) => (
                <option key={item.id} value={item.id} disabled={item.extraction === "pending"}>
                  {item.name}
                  {item.extraction === "pending" ? " · 본문 미추출 (수치 연결 불가)" : ""}
                </option>
              ))}
            </select>
          </div>
          {source && source.updatedAt !== ref.sourceUpdatedAt && (
            <Notice tone="warning">
              자료가 변경되었습니다. 인용을 다시 대조한 뒤 자료를 명시적으로 다시 선택해 주세요.
            </Notice>
          )}
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-locator`}>자료 쪽·위치</Label>
            <Input
              id={`${prefix}-locator`}
              value={ref.locator}
              maxLength={150}
              onChange={(event) =>
                onChange({ ...value, reference: { ...ref, locator: event.target.value } })
              }
            />
          </div>
        </>
      )}
      {ref?.kind === "plan" && (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-plan`}>저장 원고 버전 *</Label>
            <select
              id={`${prefix}-plan`}
              className={selectClass}
              value={ref.planId}
              onChange={(event) =>
                onChange({
                  ...value,
                  reference: {
                    kind: "plan",
                    planId: event.target.value,
                    sectionKey: "",
                    quote: "",
                  },
                })
              }
            >
              <option value="">원고 직접 선택</option>
              {[...company.plans].reverse().map((item, i) => (
                <option
                  key={`${item.id}-${i}`}
                  value={item.id}
                  disabled={company.plans.filter((entry) => entry.id === item.id).length !== 1}
                >
                  v{item.version} · {item.content.title}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-section`}>원고 항목 *</Label>
            <select
              id={`${prefix}-section`}
              className={selectClass}
              value={ref.sectionKey}
              onChange={(event) =>
                onChange({
                  ...value,
                  reference: { ...ref, sectionKey: event.target.value, quote: "" },
                })
              }
            >
              <option value="">고유 항목 직접 선택</option>
              {sections.map((section) => (
                <option key={section.key} value={section.key}>
                  {section.title}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {ref && (
        <>
          <details>
            <summary className="cursor-pointer text-xs underline">선택한 등록 원문 보기</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">
              {originalText?.slice(0, 20000) || "자료·원고 항목을 선택해 주세요."}
            </pre>
            {originalText && originalText.length > 20000 && (
              <p className="text-xs">
                20,000자 이후는 생략했습니다. 자료함·원고 화면에서 전체 본문을 확인해 주세요.
              </p>
            )}
          </details>
          <Field
            id={`${prefix}-quote`}
            label="수치가 포함된 원문 그대로 인용 *"
            value={ref.quote}
            max={1500}
            onChange={(quote) => onChange({ ...value, reference: { ...ref, quote } })}
          />
        </>
      )}
      <Field
        id={`${prefix}-note`}
        label="출처 해석·범위·가정 메모 (수동)"
        value={value.note}
        onChange={(note) => onChange({ ...value, note })}
      />
      <Button type="button" variant="outline" size="sm" onClick={onRemove}>
        이 수치와 연결 비교·산식 삭제
      </Button>
    </fieldset>
  );
}
function TargetSelect({
  id,
  label,
  value,
  observations,
  excluded = [],
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  observations: NumericObservation[];
  excluded?: string[];
  onChange: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">수치 직접 선택</option>
        {observations.map((item, index) => (
          <option key={item.id} value={item.id} disabled={excluded.includes(item.id)}>
            {index + 1}. {item.label || "이름 미입력"} · {item.valueText || "수치 미확인"}{" "}
            {unitText(item)}
          </option>
        ))}
      </select>
    </div>
  );
}
export function NumericEvaluationView({ evaluation }: { evaluation: NumericEvaluation }) {
  return (
    <div className="space-y-3 text-sm">
      <p>입력값의 산술·표기 대조입니다. 사실 진위와 단위·기간의 실제 의미는 확인하지 않았습니다.</p>
      {!evaluation.comparisons.length && !evaluation.formulas.length && (
        <p>비교쌍·산식이 없습니다. 수치 기록만 보관합니다.</p>
      )}
      {evaluation.comparisons.map((item, index) => (
        <div key={item.id} className="rounded-lg border p-3">
          <strong>
            비교 {index + 1}: {resultLabels[item.state]}
          </strong>
          {item.reasons.length > 0 && (
            <p className="mt-2 text-xs">
              {item.reasons.map((reason) => numericReasonLabels[reason]).join(" · ")}
            </p>
          )}
        </div>
      ))}
      {evaluation.formulas.map((item, index) => (
        <div key={item.id} className="rounded-lg border p-3">
          <strong>
            산식 {index + 1}: {resultLabels[item.state]}
          </strong>
          {item.result && (
            <p className="mt-2 break-all">
              정확한 계산값:{" "}
              {item.result.decimal ??
                `${item.result.numerator}/${item.result.denominator} (분수 그대로 · 반올림 없음)`}
            </p>
          )}
          {item.reasons.length > 0 && (
            <p className="mt-2 text-xs">
              {item.reasons.map((reason) => numericReasonLabels[reason]).join(" · ")}
            </p>
          )}
        </div>
      ))}
      {evaluation.unresolved.length > 0 && (
        <p className="text-xs text-amber-900">
          미확인 수치 항목 {evaluation.unresolved.length}개. 해당 수치의 값·인용·단위·기간·구분을
          확인해 주세요.
        </p>
      )}
    </div>
  );
}
export function NumericCheckView({
  company,
  record,
}: {
  company: StudioCase;
  record: NumericCheck;
}) {
  const context = numericCheckContext(company, record);
  return (
    <article
      className="space-y-3 rounded-xl border p-4"
      aria-label={`수치 대조 v${record.version}`}
    >
      <h4 className="font-semibold">
        {record.title} · 대조 v{record.version}
      </h4>
      <p className="text-xs text-muted-foreground">
        {record.recordedAt} · {judgementLabels[record.judgement.state]}
        {record.judgement.reviewer ? ` · ${record.judgement.reviewer}` : ""}
      </p>
      {context.state !== "current" && (
        <Notice tone="warning">
          현재 근거 연결 재확인 필요. 저장 당시 산술 결과를 현재 자료의 결과로 재사용하지 마세요.{" "}
          {context.issues.join(" ")}
        </Notice>
      )}
      <NumericEvaluationView evaluation={record.evaluation} />
      <details>
        <summary className="cursor-pointer text-sm underline">
          저장 수치·정확한 인용·원고/원본 SHA·판단 메모
        </summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
          {numericDraftText(company, record)}
        </pre>
      </details>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          const url = URL.createObjectURL(
            new Blob([numericDraftText(company, record)], { type: "text/plain;charset=utf-8" }),
          );
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `venturepass-numeric-v${record.version}-DRAFT.txt`;
          anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        DRAFT 수치 대조 내려받기
      </Button>
    </article>
  );
}
type Props = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason?: string;
  onDirtyChange: (dirty: boolean) => void;
};
export function NumericChecks(props: Props) {
  return <NumericChecksEditor key={`${props.company.id}:${props.company.revision}`} {...props} />;
}
function NumericChecksEditor({ company, mutate, blockedReason = "", onDirtyChange }: Props) {
  const [editor, setEditor] = useState<NumericCheckInput | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const inFlight = useRef(false),
    mounted = useRef(true),
    nonce = useRef<{ input: string; id: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useDirty(editor !== null, onDirtyChange);
  const latest = latestNumericChecks(company),
    atLimit = company.numericChecks.length >= numericCheckLimits.versions;
  const blocked = Boolean(blockedReason) || saving;
  const parsed = editor ? numericCheckInputSchema.safeParse(editor) : null;
  const preview = parsed?.success ? evaluateNumericCheck(parsed.data) : null;
  function edit(next: NumericCheckInput) {
    if (!editor || inFlight.current) return;
    setEditor(resetNumericJudgementAfterEdit(editor, next));
    setError("");
  }
  async function save() {
    if (!editor || blocked || inFlight.current) return;
    const result = numericCheckInputSchema.safeParse(editor);
    if (!result.success) {
      setError(result.error.issues[0]?.message || "수치·인용·비교 대상을 확인해 주세요.");
      return;
    }
    const serialized = JSON.stringify(result.data);
    if (!nonce.current || nonce.current.input !== serialized)
      nonce.current = { input: serialized, id: crypto.randomUUID() };
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const response = await mutate({
        action: "append-numeric-check",
        clientRequestId: nonce.current.id,
        check: result.data,
      });
      if (!mounted.current) return;
      if (numericCheckSaveAcknowledged(response, company.id, nonce.current.id, result.data)) {
        setEditor(null);
        nonce.current = null;
      } else
        setError(
          "저장 결과를 확인하지 못했습니다. 입력은 유지합니다. 같은 내용으로 재확인하거나 최신 기록을 확인해 주세요.",
        );
    } catch {
      if (mounted.current)
        setError("저장 결과를 확인하지 못했습니다. 같은 내용의 요청 번호를 보존했습니다.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section
      aria-label="기간·단위·산식 수치 대조"
      className="mt-6 space-y-4 rounded-2xl border p-5"
    >
      <h3 className="font-bold">기간·단위·산식 수치 대조</h3>
      <p className="text-sm leading-6 text-muted-foreground">
        등록 자료·원고에서 수치를 직접 전사하고 인용을 연결합니다. 같은 숫자도 같은 사실이나 비교
        대상임을 뜻하지 않습니다. 기관 판단·사실 진위·자동 단위 환산은 수행하지 않습니다.
      </p>
      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {atLimit && (
        <Notice tone="warning">
          수치 대조 버전 {numericCheckLimits.versions}개 한도입니다. 기존 이력은 보존합니다.
        </Notice>
      )}
      {!editor && (
        <Button
          type="button"
          variant="outline"
          disabled={blocked || atLimit}
          onClick={() => {
            setEditor(numericInputFor());
            nonce.current = null;
            setError("");
          }}
        >
          새 미검토 수치 대조
        </Button>
      )}
      {editor && (
        <fieldset disabled={blocked} className="space-y-5 rounded-xl border bg-muted/10 p-4">
          <legend className="px-2 font-semibold">
            {editor.checkId ? "수치 대조의 새 버전" : "새 수치 대조안"}
          </legend>
          <div className="space-y-2">
            <Label htmlFor="numeric-check-title">대조안 제목 *</Label>
            <Input
              id="numeric-check-title"
              value={editor.title}
              maxLength={300}
              onChange={(event) => edit({ ...editor, title: event.target.value })}
            />
          </div>
          <h4 className="font-semibold">1. 관측 수치·기간·단위·원문</h4>
          {editor.observations.map((value, index) => (
            <NumericObservationEditor
              key={value.id}
              company={company}
              value={value}
              index={index}
              onChange={(next) =>
                edit({
                  ...editor,
                  observations: editor.observations.map((item) =>
                    item.id === value.id ? next : item,
                  ),
                })
              }
              onRemove={() =>
                edit({
                  ...editor,
                  observations: editor.observations.filter((item) => item.id !== value.id),
                  comparisons: editor.comparisons.filter(
                    (item) => item.leftId !== value.id && item.rightId !== value.id,
                  ),
                  formulas: editor.formulas.filter(
                    (item) => item.expectedId !== value.id && !item.operandIds.includes(value.id),
                  ),
                })
              }
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={editor.observations.length >= numericCheckLimits.observations}
            onClick={() =>
              edit({ ...editor, observations: [...editor.observations, newNumericObservation()] })
            }
          >
            미확인 수치 항목 추가
          </Button>
          <h4 className="font-semibold">2. 비교쌍·제한 산식</h4>
          <p className="text-xs leading-6">
            단위·기간·자료 기재/목표/가정 구분이 정확히 같은 경우에만 수치 비교를 합니다.
            합계·차이는 같은 단위, 곱·나눗셈은 지원하는 단위 관계만 계산합니다. 원/개 × 개 = 원 등을
            지원하며, 천원 환산이나 % 곱셈은 추정하지 않습니다.
          </p>
          {editor.comparisons.map((pair, index) => (
            <fieldset key={pair.id} className="space-y-3 rounded-xl border p-3">
              <legend className="px-1">비교쌍 {index + 1}</legend>
              <TargetSelect
                id={`numeric-pair-${pair.id}-left`}
                label="왼쪽 수치"
                value={pair.leftId}
                observations={editor.observations}
                excluded={[pair.rightId]}
                onChange={(leftId) =>
                  edit({
                    ...editor,
                    comparisons: editor.comparisons.map((item) =>
                      item.id === pair.id ? { ...item, leftId } : item,
                    ),
                  })
                }
              />
              <TargetSelect
                id={`numeric-pair-${pair.id}-right`}
                label="오른쪽 수치"
                value={pair.rightId}
                observations={editor.observations}
                excluded={[pair.leftId]}
                onChange={(rightId) =>
                  edit({
                    ...editor,
                    comparisons: editor.comparisons.map((item) =>
                      item.id === pair.id ? { ...item, rightId } : item,
                    ),
                  })
                }
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  edit({
                    ...editor,
                    comparisons: editor.comparisons.filter((item) => item.id !== pair.id),
                  })
                }
              >
                비교쌍 삭제
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={editor.comparisons.length >= numericCheckLimits.comparisons}
            onClick={() =>
              edit({
                ...editor,
                comparisons: [
                  ...editor.comparisons,
                  { id: crypto.randomUUID(), leftId: "", rightId: "" },
                ],
              })
            }
          >
            수치 비교쌍 추가
          </Button>
          {editor.formulas.map((formula, index) => {
            const update = (next: NumericFormula) =>
              edit({
                ...editor,
                formulas: editor.formulas.map((item) => (item.id === formula.id ? next : item)),
              });
            return (
              <fieldset key={formula.id} className="space-y-3 rounded-xl border p-3">
                <legend className="px-1">산식 {index + 1}</legend>
                <div className="space-y-2">
                  <Label htmlFor={`numeric-formula-${formula.id}-operation`}>
                    연산 (변경하면 피연산값 선택 초기화)
                  </Label>
                  <select
                    id={`numeric-formula-${formula.id}-operation`}
                    className={selectClass}
                    value={formula.operation}
                    onChange={(event) =>
                      update({
                        ...formula,
                        operation: event.target.value as NumericFormula["operation"],
                        operandIds: ["", ""],
                      })
                    }
                  >
                    {Object.entries(numericOperationLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                {formula.operandIds.map((id, operandIndex) => (
                  <TargetSelect
                    key={operandIndex}
                    id={`numeric-formula-${formula.id}-${operandIndex}`}
                    label={`피연산값 ${operandIndex + 1}`}
                    value={id}
                    observations={editor.observations}
                    excluded={[
                      formula.expectedId,
                      ...formula.operandIds.filter((_, i) => i !== operandIndex),
                    ]}
                    onChange={(selected) =>
                      update({
                        ...formula,
                        operandIds: formula.operandIds.map((item, i) =>
                          i === operandIndex ? selected : item,
                        ),
                      })
                    }
                  />
                ))}
                {formula.operation === "sum" && (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={formula.operandIds.length >= 10}
                      onClick={() =>
                        update({ ...formula, operandIds: [...formula.operandIds, ""] })
                      }
                    >
                      합계 항 추가
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={formula.operandIds.length <= 2}
                      onClick={() =>
                        update({ ...formula, operandIds: formula.operandIds.slice(0, -1) })
                      }
                    >
                      마지막 합계 항 삭제
                    </Button>
                  </div>
                )}
                <TargetSelect
                  id={`numeric-formula-${formula.id}-expected`}
                  label="계산 결과와 대조할 별도 입력값"
                  value={formula.expectedId}
                  observations={editor.observations}
                  excluded={formula.operandIds}
                  onChange={(expectedId) => update({ ...formula, expectedId })}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    edit({
                      ...editor,
                      formulas: editor.formulas.filter((item) => item.id !== formula.id),
                    })
                  }
                >
                  산식 삭제
                </Button>
              </fieldset>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={editor.formulas.length >= numericCheckLimits.formulas}
            onClick={() =>
              edit({
                ...editor,
                formulas: [
                  ...editor.formulas,
                  {
                    id: crypto.randomUUID(),
                    operation: "sum",
                    operandIds: ["", ""],
                    expectedId: "",
                  },
                ],
              })
            }
          >
            산식 추가
          </Button>
          <h4 className="font-semibold">3. 입력값 미리보기·담당자 판단</h4>
          {preview ? (
            <div className="space-y-3 rounded-xl border p-4">
              <p className="text-xs text-amber-900">
                저장 전 입력값 계산입니다. 원문 수치의 정확한 전사·원본 SHA는 저장 시 서버에서
                대조합니다.
              </p>
              <NumericEvaluationView evaluation={preview} />
            </div>
          ) : (
            <Notice>
              대조안 제목·수치 이름과 선택한 인용·비교쌍·산식 항목을 완성하면 입력값 미리보기가
              나타납니다. 수치·단위·기간의 미확인 상태는 그대로 저장할 수 있습니다.
            </Notice>
          )}
          {editor.checkId ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="numeric-judgement">이번 버전의 내부 판단</Label>
                <select
                  id="numeric-judgement"
                  className={selectClass}
                  value={editor.judgement.state}
                  onChange={(event) =>
                    edit({
                      ...editor,
                      judgement: {
                        ...editor.judgement,
                        state: event.target.value as NumericCheckInput["judgement"]["state"],
                      },
                    })
                  }
                >
                  {Object.entries(judgementLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="numeric-reviewer">판단 담당자</Label>
                <Input
                  id="numeric-reviewer"
                  value={editor.judgement.reviewer}
                  maxLength={100}
                  onChange={(event) =>
                    edit({
                      ...editor,
                      judgement: { ...editor.judgement, reviewer: event.target.value },
                    })
                  }
                />
              </div>
            </div>
          ) : (
            <p className="text-xs">
              최초 대조안은 미검토로 저장합니다. 저장한 대조안의 새 버전에서 담당자 판단을
              기록합니다.
            </p>
          )}
          <Field
            id="numeric-judgement-note"
            label="판단 메모·미해결 사항"
            value={editor.judgement.note}
            max={3000}
            onChange={(note) => edit({ ...editor, judgement: { ...editor.judgement, note } })}
          />
          <p className="text-xs text-muted-foreground">
            내부 검토 기록은 비교 불가·수치 차이를 지우거나 사실 확인·원고 검토 완료로 바꾸지
            않습니다. 수치·인용·산식을 수정하면 판단 선택을 미검토로 돌립니다.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" disabled={atLimit} onClick={() => void save()}>
              {saving ? "저장 중" : "수치 대조 버전 저장"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!inFlight.current) {
                  setEditor(null);
                  nonce.current = null;
                  setError("");
                }
              }}
            >
              편집 취소
            </Button>
          </div>
        </fieldset>
      )}
      <div className="space-y-4">
        {latest.map((record) => {
          const history = company.numericChecks.filter((item) => item.checkId === record.checkId);
          return (
            <div key={record.checkId} className="space-y-3">
              <NumericCheckView company={company} record={record} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={blocked || atLimit || editor !== null}
                onClick={() => {
                  setEditor(numericInputFor(record));
                  nonce.current = null;
                  setError("");
                }}
              >
                이 대조안의 새 버전 작성
              </Button>
              {history.length > 1 && (
                <details>
                  <summary className="cursor-pointer text-sm underline">
                    이전 수치 대조 버전 {history.length - 1}개
                  </summary>
                  <div className="mt-3 space-y-3">
                    {history
                      .slice(0, -1)
                      .reverse()
                      .map((previous) => (
                        <NumericCheckView key={previous.id} company={company} record={previous} />
                      ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs leading-6 text-muted-foreground">
        원본은 저장 시 안전하게 읽어 SHA를 고정합니다. 현재 화면은 등록정보·인용 연결만 대조하며
        파일 바이트를 다시 읽지 않습니다. 기존 자료·원고·업무·기관 상태를 변경하거나 외부 AI로
        전송하지 않습니다.
      </p>
    </section>
  );
}
