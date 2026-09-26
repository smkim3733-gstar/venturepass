"use client";

import { Button } from "@/components/ui/button";
import type { StudioCase } from "@/lib/studio-schema";
import {
  sourceIntakeExternalEngineLabels,
  sourceIntakeExternalPurposeLabels,
} from "@/lib/studio-source-intake-external-types";
import { Notice } from "./shared";
import {
  intakeExternalCommand,
  intakeExternalPreviewProblem,
  type IntakeExternalReview,
} from "./source-intake-external-ui";

export function IntakeExternalApprovalReview({
  company,
  review,
  disabled,
  onChange,
  onExecute,
  onClose,
}: {
  company: StudioCase;
  review: IntakeExternalReview;
  disabled: boolean;
  onChange: (review: IntakeExternalReview) => void;
  onExecute: () => void;
  onClose: () => void;
}) {
  const { approval } = review.preview,
    problem = intakeExternalPreviewProblem(company, review.preview);
  const canExecute = !!intakeExternalCommand(company, review);
  return (
    <section
      aria-label="외부 판독·전사 전송 승인"
      className="space-y-4 rounded-xl border border-primary/30 p-4"
    >
      <h4 className="font-semibold">선택한 원본의 외부 전송 검토</h4>
      <Notice tone="warning">
        아래 원본 전체를 표시한 외부 서비스로 전송합니다. 서비스 처리에 비용이 발생할 수 있습니다.
        이 미리보기는 전송하지 않으며, 아래 동의와 실행 버튼을 누른 요청만 보냅니다.
      </Notice>
      <dl className="grid gap-3 text-sm leading-6 sm:grid-cols-2">
        {(
          [
            ["선택 기업", company.profile.companyName],
            ["전송 원본", approval.originalName],
            ["파일 크기", `${approval.sizeBytes.toLocaleString()}바이트`],
            ["파일 형식", approval.mimeType || "MIME 미기록"],
            ["처리 방식", sourceIntakeExternalEngineLabels[approval.engine]],
            ["공급자", approval.provider],
            ["전송 대상", approval.destination],
            ["사용 모델", approval.model],
            ["처리 목적", sourceIntakeExternalPurposeLabels[approval.purpose]],
            ["원본 SHA-256", approval.originalSha256],
          ] as Array<[string, string]>
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-6 text-muted-foreground">
        응답이 없거나 시간이 초과돼도 미전송·처리 취소·비용 취소를 의미하지 않습니다. 결과 미확인 시
        자동 재전송하지 않습니다. 판독문은 미검토 상태로 보관하며 별도 교정·확인 후에만 자료
        본문으로 채택합니다.
      </p>
      {approval.engine === "ai-transcription" && (
        <p className="text-xs">
          음성 전사는 반환된 본문만 보관합니다. 실제 시간 정보가 없으면 타임스탬프를 만들어 넣지
          않습니다.
        </p>
      )}
      {review.preview.requiresDuplicateAcknowledgement && (
        <Notice tone="warning">
          이전 외부 요청이 이미 처리됐을 수 있습니다. 이번 요청은 별도 전송이며 중복 처리·중복
          비용이 발생할 수 있습니다. 이전 시도 이력은 보존합니다.
        </Notice>
      )}
      {problem && <Notice tone="warning">{problem}</Notice>}
      <fieldset disabled={disabled || !!problem} className="space-y-3">
        <label className="flex items-start gap-2 text-sm leading-6">
          <input
            type="checkbox"
            className="mt-1"
            checked={!problem && review.approved}
            onChange={(event) => onChange({ ...review, approved: event.target.checked })}
          />
          표시한 정확한 원본을 위 공급자·전송 대상·모델로 보내 해당 목적의 판독·전사를 실행하는 데
          동의합니다.
        </label>
        {review.preview.requiresDuplicateAcknowledgement && (
          <label className="flex items-start gap-2 text-sm leading-6">
            <input
              type="checkbox"
              className="mt-1"
              checked={!problem && review.acknowledgePossibleDuplicate}
              onChange={(event) =>
                onChange({ ...review, acknowledgePossibleDuplicate: event.target.checked })
              }
            />
            이전 요청의 결과가 미확인이며, 새 전송으로 중복 처리·비용이 발생할 수 있음을
            확인했습니다.
          </label>
        )}
        <Button type="button" disabled={!canExecute} onClick={onExecute}>
          승인한 원본 외부 전송 1회 실행
        </Button>
      </fieldset>
      <Button type="button" variant="outline" disabled={disabled} onClick={onClose}>
        전송하지 않고 검토 닫기
      </Button>
    </section>
  );
}
