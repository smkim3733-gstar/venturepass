"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StudioCase } from "@/lib/studio-schema";
import {
  claimReviewInputSchema,
  claimReviewRecordSchema,
  claimReviewLimits,
  claimReviewContext,
  claimNatureLabels as natureLabels,
  claimMethodLabels as methodLabels,
  claimJudgementLabels as judgementLabels,
  latestClaimReviews,
  type ClaimReviewInput,
  type ClaimReviewRecord,
} from "@/lib/studio-claim-review-types";
import { AppealEvidenceEditor } from "./appeal-preparation";
import { Notice, formatDate, selectClass, useDirty, type PanelProps } from "./shared";

const emptyJudgement = (): ClaimReviewInput["judgement"] => ({
  state: "unreviewed",
  reviewer: "",
  reason: "",
  checkedOn: "",
});

export function claimReviewInputFor(previous?: ClaimReviewRecord): ClaimReviewInput {
  return {
    claimId: previous?.claimId ?? null,
    previousVersionId: previous?.id ?? null,
    planId: previous?.planId ?? "",
    planVersion: previous?.planVersion ?? 1,
    sectionKey: previous?.sectionKey ?? "",
    claimQuote: previous?.claimQuote ?? "",
    nature: previous?.nature ?? "unknown",
    references: previous ? structuredClone(previous.references) : [],
    contextNote: previous?.contextNote ?? "",
    owner: previous?.owner ?? "",
    dueOn: previous?.dueOn ?? "",
    nextCheck: previous?.nextCheck ?? "",
    method: previous?.method ?? "unreviewed",
    externalCheck: previous
      ? structuredClone(previous.externalCheck)
      : { target: "", content: "", occurredOn: "" },
    judgement: emptyJudgement(),
    numericReferences: previous ? structuredClone(previous.numericReferences) : [],
    planReviewReferences: previous ? structuredClone(previous.planReviewReferences) : [],
  };
}

export function resetClaimJudgementAfterEdit(
  previous: ClaimReviewInput,
  next: ClaimReviewInput,
): ClaimReviewInput {
  return JSON.stringify({ ...previous, judgement: null }) ===
    JSON.stringify({ ...next, judgement: null })
    ? next
    : { ...next, judgement: emptyJudgement() };
}

function Field({
  id,
  label,
  value,
  onChange,
  max = 2000,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  max?: number;
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
function DateField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="date"
        value={value}
        onInput={(event) => onChange(event.currentTarget.value)}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function ClaimReviewFields({
  company,
  value,
  onChange,
}: {
  company: StudioCase;
  value: ClaimReviewInput;
  onChange: (value: ClaimReviewInput) => void;
}) {
  const prefix = useId();
  const planMatches = company.plans.filter((plan) => plan.id === value.planId);
  const plan = planMatches.length === 1 ? planMatches[0] : null;
  const sections =
    plan?.content.sections.filter(
      (section) => plan.content.sections.filter((item) => item.key === section.key).length === 1,
    ) ?? [];
  const section = sections.find((item) => item.key === value.sectionKey);
  const fixedSection = Boolean(value.claimId);
  const unresolvedReferences =
    value.numericReferences.some(
      (ref) =>
        company.numericChecks.filter(
          (record) => record.id === ref.id && record.version === ref.version,
        ).length !== 1,
    ) ||
    value.planReviewReferences.some(
      (ref) =>
        company.planReviewDecisions.filter(
          (record) =>
            record.id === ref.id &&
            record.version === ref.version &&
            record.planId === value.planId &&
            record.planVersion === value.planVersion,
        ).length !== 1,
    );
  return (
    <div className="space-y-5">
      <h4 className="font-semibold">1. 정확한 원고 문장과 주장 성격</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-plan`}>저장 원고 버전 직접 선택 *</Label>
          <select
            id={`${prefix}-plan`}
            className={selectClass}
            value={value.planId}
            onChange={(event) => {
              const matches = company.plans.filter((item) => item.id === event.target.value);
              const chosen = matches.length === 1 ? matches[0] : null;
              onChange({
                ...value,
                planId: chosen?.id ?? "",
                planVersion: chosen?.version ?? 1,
                sectionKey: fixedSection ? value.sectionKey : "",
                claimQuote: "",
                planReviewReferences: [],
              });
            }}
          >
            <option value="">원고 직접 선택</option>
            {[...company.plans].reverse().map((item, index) => (
              <option
                key={`${item.id}-${index}`}
                value={item.id}
                disabled={
                  company.plans.filter((candidate) => candidate.id === item.id).length !== 1 ||
                  (fixedSection &&
                    item.content.sections.filter((entry) => entry.key === value.sectionKey)
                      .length !== 1)
                }
              >
                원고 v{item.version} · {item.content.title}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-section`}>고유 원고 항목 *</Label>
          <select
            id={`${prefix}-section`}
            className={selectClass}
            value={value.sectionKey}
            disabled={fixedSection}
            onChange={(event) =>
              onChange({ ...value, sectionKey: event.target.value, claimQuote: "" })
            }
          >
            <option value="">항목 직접 선택</option>
            {sections.map((item) => (
              <option key={item.key} value={item.key}>
                {item.title}
              </option>
            ))}
          </select>
        </div>
      </div>
      {fixedSection && (
        <Notice>
          같은 주장 이력에서는 항목 키를 유지합니다. 새 원고 버전을 고르면 인용과 원고 검토 참조를
          비우므로 다시 선택해 주세요. 재연결만으로 의미가 같다고 확인하지 않습니다.
        </Notice>
      )}
      {value.planId && !section && (
        <Notice tone="warning">
          선택한 원고·항목을 고유하게 찾을 수 없습니다. 저장 원고의 정확한 버전과 항목을 확인해
          주세요.
        </Notice>
      )}
      {section && (
        <details>
          <summary className="cursor-pointer text-sm underline">
            선택 원고 v{plan?.version}의 등록 본문 대조
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs">
            {section.content}
          </pre>
        </details>
      )}
      <Field
        id={`${prefix}-quote`}
        label="주장 문장을 원문 그대로 인용 *"
        value={value.claimQuote}
        max={1500}
        onChange={(claimQuote) => onChange({ ...value, claimQuote })}
      />
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-nature`}>주장 성격 (담당자 분류)</Label>
        <select
          id={`${prefix}-nature`}
          className={selectClass}
          value={value.nature}
          onChange={(event) =>
            onChange({ ...value, nature: event.target.value as ClaimReviewInput["nature"] })
          }
        >
          {Object.entries(natureLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          ‘현재 사실에 관한 주장’도 사실 검증 완료가 아닙니다.
        </p>
      </div>
      <h4 className="font-semibold">2. 선택한 근거와 확인 범위</h4>
      <AppealEvidenceEditor
        company={company}
        prefix={`${prefix}-evidence`}
        label="대조할 등록 자료"
        references={value.references}
        maxReferences={10}
        onChange={(references) => onChange({ ...value, references })}
      />
      <Field
        id={`${prefix}-context`}
        label="기업·기간·단위·범위 해석 메모"
        value={value.contextNote}
        onChange={(contextNote) => onChange({ ...value, contextNote })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-owner`}>확인 담당자 (수동 기록)</Label>
          <Input
            id={`${prefix}-owner`}
            value={value.owner}
            maxLength={100}
            onChange={(event) => onChange({ ...value, owner: event.target.value })}
          />
        </div>
        <DateField
          id={`${prefix}-due`}
          label="직접 정한 확인 기한 (미확인은 비움)"
          value={value.dueOn}
          onChange={(dueOn) => onChange({ ...value, dueOn })}
        />
      </div>
      <Field
        id={`${prefix}-next`}
        label="다음 확인 사항"
        value={value.nextCheck}
        onChange={(nextCheck) => onChange({ ...value, nextCheck })}
      />
      <h4 className="font-semibold">3. 기존 대조·판단의 정확한 버전 참고</h4>
      {unresolvedReferences && (
        <Notice tone="warning">
          기존에 선택한 참고 버전을 고유하게 찾을 수 없습니다. 현재 목록에서 정확한 버전을 다시
          선택해 주세요. 최신 기록으로 자동 대체하지 않습니다.
        </Notice>
      )}
      <p className="text-xs leading-6">
        선택한 기록은 참고 연결입니다. 산술 결과나 담당자의 해결 판단을 사실 확인으로 승격하지
        않습니다. 자동 선택하지 않습니다.
      </p>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-numeric`}>수치 대조 참고 버전 (최대 10개)</Label>
        <select
          id={`${prefix}-numeric`}
          multiple
          className={`${selectClass} !h-32`}
          value={value.numericReferences.map((ref) => ref.id)}
          onChange={(event) => {
            const ids = Array.from(event.target.selectedOptions, (item) => item.value);
            onChange({
              ...value,
              numericReferences: ids
                .map((id) => company.numericChecks.filter((item) => item.id === id))
                .filter((items) => items.length === 1)
                .map(([item]) => ({ id: item.id, version: item.version })),
            });
          }}
        >
          {company.numericChecks.map((item, index) => (
            <option
              key={`${item.id}-${index}`}
              value={item.id}
              disabled={
                company.numericChecks.filter((record) => record.id === item.id).length !== 1
              }
            >
              대조 v{item.version} · {item.title}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-plan-review`}>선택한 원고의 검토 판단 버전 (최대 10개)</Label>
        <select
          id={`${prefix}-plan-review`}
          multiple
          className={`${selectClass} !h-32`}
          value={value.planReviewReferences.map((ref) => ref.id)}
          onChange={(event) => {
            const ids = Array.from(event.target.selectedOptions, (item) => item.value);
            onChange({
              ...value,
              planReviewReferences: ids
                .map((id) =>
                  company.planReviewDecisions.filter(
                    (item) =>
                      item.id === id &&
                      item.planId === value.planId &&
                      item.planVersion === value.planVersion,
                  ),
                )
                .filter((items) => items.length === 1)
                .map(([item]) => ({ id: item.id, version: item.version })),
            });
          }}
        >
          {company.planReviewDecisions
            .filter(
              (item) => item.planId === value.planId && item.planVersion === value.planVersion,
            )
            .map((item, index) => (
              <option
                key={`${item.id}-${index}`}
                value={item.id}
                disabled={
                  company.planReviewDecisions.filter((record) => record.id === item.id).length !== 1
                }
              >
                판단 v{item.version} · {item.finding.message}
                {item.stale ? " · 현재 근거 재확인 필요" : ""}
              </option>
            ))}
        </select>
      </div>
      <h4 className="font-semibold">4. 검토 방식과 담당자 판단</h4>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-method`}>검토 방식</Label>
        <select
          id={`${prefix}-method`}
          className={selectClass}
          value={value.method}
          onChange={(event) =>
            onChange({ ...value, method: event.target.value as ClaimReviewInput["method"] })
          }
        >
          {Object.entries(methodLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-3 rounded-xl border p-3">
        <p className="text-xs leading-6">
          외부 확인은 담당자의 수동 기록입니다. 앱이 외부 기관을 조회하거나 답변을 검증하지
          않습니다. 외부 방식은 대상·내용·확인일을 모두 입력하며, 복수 방식에서도 외부 내용을
          기록하면 세 값을 함께 입력합니다.
        </p>
        <Field
          id={`${prefix}-external-target`}
          label="직접 확인한 외부 대상 (미확인은 비움)"
          value={value.externalCheck.target}
          max={300}
          onChange={(target) =>
            onChange({ ...value, externalCheck: { ...value.externalCheck, target } })
          }
        />
        <Field
          id={`${prefix}-external-content`}
          label="외부에서 확인했다고 기록한 내용"
          value={value.externalCheck.content}
          onChange={(content) =>
            onChange({ ...value, externalCheck: { ...value.externalCheck, content } })
          }
        />
        <DateField
          id={`${prefix}-external-on`}
          label="외부 확인일 (직접 입력)"
          value={value.externalCheck.occurredOn}
          onChange={(occurredOn) =>
            onChange({ ...value, externalCheck: { ...value.externalCheck, occurredOn } })
          }
        />
      </div>
      {value.claimId ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-judgement`}>이번 버전의 담당자 판단</Label>
            <select
              id={`${prefix}-judgement`}
              className={selectClass}
              value={value.judgement.state}
              onChange={(event) =>
                onChange({
                  ...value,
                  judgement: {
                    ...value.judgement,
                    state: event.target.value as ClaimReviewInput["judgement"]["state"],
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
            <Label htmlFor={`${prefix}-reviewer`}>판단자</Label>
            <Input
              id={`${prefix}-reviewer`}
              value={value.judgement.reviewer}
              maxLength={100}
              onChange={(event) =>
                onChange({
                  ...value,
                  judgement: { ...value.judgement, reviewer: event.target.value },
                })
              }
            />
          </div>
          <Field
            id={`${prefix}-judgement-reason`}
            label="판단 이유"
            value={value.judgement.reason}
            onChange={(reason) => onChange({ ...value, judgement: { ...value.judgement, reason } })}
          />
          <DateField
            id={`${prefix}-checked`}
            label="판단 확인일 (직접 입력)"
            value={value.judgement.checkedOn}
            onChange={(checkedOn) =>
              onChange({ ...value, judgement: { ...value.judgement, checkedOn } })
            }
          />
        </div>
      ) : (
        <Notice>
          최초 주장은 미검토로 저장합니다. 저장한 주장의 다음 버전에서 판단자·이유·확인일을 직접
          기록할 수 있습니다.
        </Notice>
      )}
      <p className="text-xs leading-6 text-muted-foreground">
        ‘일치’는 문장과 선택 자료를 대조한 담당자 판단입니다. 사실 진위·법적 효력·기관 적합성을
        보장하지 않습니다. 주장·근거·해석을 바꾸면 판단 입력을 미검토로 되돌립니다.
      </p>
    </div>
  );
}

export function claimReviewSaveAcknowledged(
  response: StudioCase | null,
  company: StudioCase,
  nonce: string,
  raw: ClaimReviewInput,
): boolean {
  if (!response || response.id !== company.id || response.revision < company.revision) return false;
  const input = claimReviewInputSchema.safeParse(raw);
  if (!input.success) return false;
  const matches = (response.claimReviews ?? []).filter(
    (record) => record.clientRequestId === nonce,
  );
  if (matches.length !== 1) return false;
  const stored = claimReviewRecordSchema.safeParse(matches[0]);
  if (!stored.success) return false;
  const record = stored.data;
  const prior = input.data.claimId
    ? latestClaimReviews(company).find((item) => item.claimId === input.data.claimId)
    : undefined;
  if (
    (prior?.id ?? null) !== input.data.previousVersionId ||
    record.version !== (prior?.version ?? 0) + 1 ||
    record.claimId !== (input.data.claimId ?? record.id)
  )
    return false;
  const { recordedAt: _recordedAt, ...judgement } = record.judgement;
  void _recordedAt;
  const persistedInput = {
    ...claimReviewInputFor(record),
    claimId: input.data.claimId,
    previousVersionId: record.previousVersionId,
    judgement,
  };
  const persisted = claimReviewInputSchema.safeParse(persistedInput);
  return persisted.success && JSON.stringify(persisted.data) === JSON.stringify(input.data);
}

export function ClaimReviewRecordView({
  company,
  record,
}: {
  company: StudioCase;
  record: ClaimReviewRecord;
}) {
  const context = claimReviewContext(company, record);
  return (
    <article
      id={`claim-review-${record.id}`}
      aria-label={`주장 검토 v${record.version}`}
      className="space-y-3 rounded-xl border p-4"
    >
      <h4 className="text-sm font-semibold">
        주장 검토 v{record.version} · 연결 원고 v{record.planVersion}
      </h4>
      <p className="text-xs text-muted-foreground">
        {formatDate(record.recordedAt)} · 담당자 직접 기록 · {natureLabels[record.nature]}
      </p>
      <p className="text-xs">
        원고 항목: {record.sectionKey} · {methodLabels[record.method]}
      </p>
      <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3 text-sm leading-6">
        {record.claimQuote}
      </blockquote>
      <Notice tone={context.state === "current" ? "info" : "warning"}>
        {context.state === "current"
          ? "등록된 연결 문맥 확인 — 현재 원본 파일을 다시 읽거나 사실을 검증한 결과는 아닙니다."
          : "연결 문맥 재확인 필요 — 아래 판단은 저장 당시 기록이며 현재 근거의 판단으로 이어지지 않습니다."}
        {context.issues.length > 0 && (
          <ul className="mt-2 list-disc pl-4">
            {context.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </Notice>
      <dl className="grid gap-3 text-xs leading-6 sm:grid-cols-2">
        <div>
          <dt className="font-semibold">저장 당시 담당자 판단</dt>
          <dd>{judgementLabels[record.judgement.state]}</dd>
        </div>
        <div>
          <dt className="font-semibold">판단자 · 직접 기록한 확인일</dt>
          <dd>
            {record.judgement.reviewer || "미확인"} · {record.judgement.checkedOn || "미확인"}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="font-semibold">판단 이유</dt>
          <dd className="whitespace-pre-wrap break-words">{record.judgement.reason || "미기록"}</dd>
        </div>
        <div>
          <dt className="font-semibold">확인 담당자 · 직접 정한 기한</dt>
          <dd>
            {record.owner || "미지정"} · {record.dueOn || "미확인"}
          </dd>
        </div>
        <div>
          <dt className="font-semibold">다음 확인 사항</dt>
          <dd className="whitespace-pre-wrap break-words">{record.nextCheck || "미기록"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="font-semibold">기업·기간·단위·범위 해석 메모</dt>
          <dd className="whitespace-pre-wrap break-words">{record.contextNote || "미기록"}</dd>
        </div>
      </dl>
      {(record.externalCheck.target ||
        record.externalCheck.content ||
        record.externalCheck.occurredOn) && (
        <div className="space-y-1 text-xs leading-6">
          <p className="font-semibold">외부 확인 수동 기록 · 앱의 외부 조회 아님</p>
          <p className="whitespace-pre-wrap break-words">
            대상: {record.externalCheck.target || "미확인"}
          </p>
          <p className="whitespace-pre-wrap break-words">
            내용: {record.externalCheck.content || "미확인"}
          </p>
          <p>직접 기록한 확인일: {record.externalCheck.occurredOn || "미확인"}</p>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-xs font-semibold">
          저장 당시 원고·자료·참고 버전 ({record.sourceSnapshots.length}개 자료)
        </summary>
        <div className="mt-3 space-y-3 text-xs leading-6">
          <p>
            당시 인용과 파일 식별값을 보존합니다. 과거 원본을 새로 내려받거나 현재 파일의 진위를
            확인하는 기능은 아닙니다. 원본만 연결한 자료는 본문 검토 완료가 아닙니다.
          </p>
          {record.planSnapshots.map((plan) => (
            <p key={plan.planId} className="break-all">
              저장 원고 v{plan.version} · 본문 SHA-256: {plan.contentSha256}
            </p>
          ))}
          {record.sourceSnapshots.length === 0 && <p>연결 자료 없음 · 근거 확인 필요</p>}
          {record.sourceSnapshots.map((source) => {
            const reference = record.references.find((item) => item.sourceId === source.sourceId);
            return (
              <div key={source.sourceId} className="space-y-1 rounded-lg border p-3">
                <p className="font-semibold">{source.sourceName}</p>
                <p>
                  자료 기준: {formatDate(source.sourceUpdatedAt)} ·{" "}
                  {source.extraction === "pending" ? "원본만 보관 · 본문 확인 필요" : "등록 본문"}
                </p>
                <p className="whitespace-pre-wrap break-words">
                  당시 인용: {reference?.quote || "원본만 연결 · 본문 인용 없음"}
                </p>
                <p className="whitespace-pre-wrap break-words">
                  위치: {reference?.locator || "미기록"}
                </p>
                <p className="break-all">본문 SHA-256: {source.textSha256}</p>
                {source.original && (
                  <>
                    <p className="break-words">
                      원본: {source.original.originalName} ·{" "}
                      {source.original.sizeBytes.toLocaleString()} bytes ·{" "}
                      {source.original.mimeType || "MIME 미기록"}
                    </p>
                    <p className="break-all">원본 SHA-256: {source.original.sha256}</p>
                  </>
                )}
              </div>
            );
          })}
          {record.auxiliarySnapshots.map((reference) => (
            <div key={`${reference.kind}:${reference.id}`} className="rounded-lg border p-3">
              <p>
                {reference.kind === "numeric" ? "수치 대조" : "원고 검토 판단"} v{reference.version}{" "}
                · {formatDate(reference.recordedAt)}
              </p>
              <p className="break-all">참고 내용 SHA-256: {reference.contentSha256}</p>
              <p>정확한 당시 버전 참고 · 사실 확인으로 자동 승격하지 않음</p>
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

type ClaimReviewsProps = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason?: string;
  onDirtyChange: (dirty: boolean) => void;
};
export function ClaimReviews(props: ClaimReviewsProps) {
  return <ClaimReviewsPanel key={`${props.company.id}:${props.company.revision}`} {...props} />;
}
function ClaimReviewsPanel({
  company,
  mutate,
  blockedReason = "",
  onDirtyChange,
}: ClaimReviewsProps) {
  const [editor, setEditor] = useState<ClaimReviewInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const inFlight = useRef(false),
    mounted = useRef(true);
  const request = useRef<{ payload: string; nonce: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useDirty(editor !== null, onDirtyChange);
  const records = company.claimReviews ?? [];
  const latest = latestClaimReviews(company);
  const older = records.filter((record) => !latest.some((item) => item.id === record.id));
  const atLimit = records.length >= claimReviewLimits.versions;
  const blocked = Boolean(blockedReason) || saving;
  function open(previous?: ClaimReviewRecord) {
    if (blocked || editor || inFlight.current || atLimit) return;
    setEditor(claimReviewInputFor(previous));
    setError("");
    setAttempted(false);
    request.current = null;
  }
  async function save() {
    if (!editor || blocked || inFlight.current || atLimit) return;
    const parsed = claimReviewInputSchema.safeParse(editor);
    if (!parsed.success) {
      setError("정확한 원고·인용·자료 버전과 길이, 날짜, 판단 필수 항목을 확인해 주세요.");
      return;
    }
    const payload = JSON.stringify(parsed.data);
    if (!request.current || request.current.payload !== payload)
      request.current = { payload, nonce: crypto.randomUUID() };
    const nonce = request.current.nonce;
    inFlight.current = true;
    setSaving(true);
    setAttempted(true);
    setError("");
    try {
      const response = await mutate({
        action: "append-claim-review",
        clientRequestId: nonce,
        claim: parsed.data,
      });
      if (!mounted.current) return;
      if (claimReviewSaveAcknowledged(response, company, nonce, parsed.data)) {
        setEditor(null);
        request.current = null;
        setAttempted(false);
      } else
        setError(
          "저장 결과를 확인하지 못했습니다. 편집은 유지합니다. 같은 내용으로 결과를 확인하거나 최신 기업 기록을 확인해 주세요.",
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
    <section aria-label="주장·근거 검토 기록" className="space-y-4 rounded-2xl border p-5">
      <h3 className="font-bold">주장·근거 검토 기록</h3>
      <p className="text-sm leading-6 text-muted-foreground">
        저장 원고의 문장을 직접 선택해 근거·해석·검토 방식을 기록합니다. 현재 화면의 원고에서 자동
        선택하지 않으며 최초 기록은 미검토입니다.
      </p>
      <Notice>
        담당자 판단은 사실 진위·법적 효력·기관 적합성을 보장하지 않습니다. 원고 검토 완료·업무
        완료·신청 단계를 자동 변경하지 않습니다.
      </Notice>
      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {atLimit && (
        <Notice tone="warning">
          주장 검토 {claimReviewLimits.versions}개 버전 한도입니다. 과거 이력을 보존하며 새 버전
          추가를 중단합니다.
        </Notice>
      )}
      {latest.length === 0 && (
        <p className="text-sm text-muted-foreground">
          아직 주장 검토 기록이 없습니다. 기존 문장과 자료의 사실 여부를 추정하지 않습니다.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={blocked || !!editor || atLimit || company.plans.length === 0}
        onClick={() => open()}
      >
        새 주장·근거 기록
      </Button>
      {[...latest].reverse().map((record) => (
        <div key={record.id} className="space-y-2">
          <ClaimReviewRecordView company={company} record={record} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={blocked || !!editor || atLimit}
            onClick={() => open(record)}
          >
            이 주장 v{record.version}에서 새 검토 버전 작성
          </Button>
        </div>
      ))}
      {editor && (
        <fieldset disabled={blocked} className="space-y-4 rounded-xl border bg-muted/20 p-4">
          <legend className="px-2 text-sm font-semibold">
            {editor.claimId ? "기존 주장 새 버전 · 판단 미검토로 시작" : "첫 주장 기록"}
          </legend>
          <ClaimReviewFields
            company={company}
            value={editor}
            onChange={(next) => {
              if (blocked || inFlight.current) return;
              setEditor(resetClaimJudgementAfterEdit(editor, next));
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
              {saving ? "주장 검토 저장 중" : "주장 검토 새 버전 저장"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (blocked || inFlight.current) return;
                if (
                  !window.confirm(
                    attempted
                      ? "저장됐을 수 있는 요청이 있습니다. 편집을 닫고 최신 기록을 확인할까요?"
                      : "저장하지 않은 주장 검토 편집을 취소할까요?",
                  )
                )
                  return;
                setEditor(null);
                setError("");
                setAttempted(false);
                request.current = null;
              }}
            >
              편집 취소
            </Button>
          </div>
        </fieldset>
      )}
      {older.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">
            과거 주장 검토 {older.length}개 버전
          </summary>
          <div className="mt-3 space-y-3">
            {[...older].reverse().map((record) => (
              <ClaimReviewRecordView key={record.id} company={company} record={record} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
