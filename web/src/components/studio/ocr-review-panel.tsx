"use client";

import { useState } from "react";
import { Download, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SourceDocument } from "@/lib/studio-schema";
import { localOcrLimits, type LocalOcrPreview } from "@/lib/studio-local-ocr-types";
import { formatDate, Notice } from "./shared";

const mimeByExtension = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);
export function supportsLocalOcr(source: SourceDocument) {
  const extension = source.originalName?.split(".").pop()?.toLowerCase();
  const expectedMime = mimeByExtension.get(extension ?? "");
  return (
    source.extraction === "pending" &&
    Boolean(source.originalName) &&
    Boolean(expectedMime) &&
    (source.mimeType === null ||
      source.mimeType === "application/octet-stream" ||
      source.mimeType === expectedMime)
  );
}

export function validateLocalOcrPreview(
  value: unknown,
  source: SourceDocument,
  revision: number,
): LocalOcrPreview {
  const preview = value as LocalOcrPreview | null;
  if (
    !preview ||
    !supportsLocalOcr(source) ||
    preview.caseRevision !== revision ||
    preview.sourceId !== source.id ||
    preview.sourceUpdatedAt !== source.updatedAt ||
    preview.reviewStatus !== "unreviewed" ||
    preview.sourceChanged !== false ||
    preview.externalTransmission !== false ||
    preview.engine !== "windows-ko" ||
    typeof preview.observedAt !== "string" ||
    !Number.isFinite(Date.parse(preview.observedAt)) ||
    !preview.original ||
    preview.original.originalName !== source.originalName ||
    preview.original.mimeType !== source.mimeType ||
    !Number.isSafeInteger(preview.original.sizeBytes) ||
    preview.original.sizeBytes <= 0 ||
    preview.original.sizeBytes > localOcrLimits.bytes ||
    typeof preview.original.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(preview.original.sha256) ||
    typeof preview.text !== "string" ||
    preview.text.length > localOcrLimits.text ||
    !Array.isArray(preview.warnings) ||
    preview.warnings.length > 30 ||
    preview.warnings.some((warning) => typeof warning !== "string" || warning.length > 2000) ||
    !Array.isArray(preview.pages) ||
    preview.pages.length === 0 ||
    preview.pages.length > localOcrLimits.pages ||
    preview.pages.some(
      (page, index) =>
        !page ||
        page.pageNumber !== index + 1 ||
        typeof page.text !== "string" ||
        page.text.length > localOcrLimits.text,
    ) ||
    preview.pages.reduce((count, page) => count + page.text.length, 0) > localOcrLimits.text ||
    preview.pages.every((page) => !page.text.trim()) ||
    preview.text !==
      preview.pages.map((page) => `[페이지 ${page.pageNumber}]\n${page.text}`).join("\n\n")
  )
    throw new Error(
      "글자 읽기 결과와 현재 자료가 일치하지 않습니다. 최신 자료에서 다시 준비해 주세요.",
    );
  return preview;
}

export function ocrReviewSaveBlockedReason(
  text: string,
  reviewed: boolean,
  blockedReason: string,
  busy: boolean,
) {
  if (blockedReason) return blockedReason;
  if (busy) return "확인한 본문을 저장하고 있습니다.";
  if (!text.trim()) return "원본에서 확인한 본문을 입력해 주세요.";
  if (text.length > 100000)
    return "저장할 본문을 100,000자 이내로 교정해 주세요. 초안은 자동으로 자르지 않습니다.";
  if (!reviewed) return "원본과 교정 본문을 대조한 뒤 확인 항목을 선택해 주세요.";
  return "";
}

export function OcrReviewPanel({
  caseId,
  source,
  preview,
  busy,
  blockedReason,
  error,
  onSave,
  onClose,
}: {
  caseId: string;
  source: SourceDocument;
  preview: LocalOcrPreview;
  busy: boolean;
  blockedReason: string;
  error: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(preview.text);
  const [reviewed, setReviewed] = useState(false);
  const saveBlockedReason = ocrReviewSaveBlockedReason(text, reviewed, blockedReason, busy);
  const originalUrl = `/api/studio/cases/${caseId}/sources/${source.id}`;
  return (
    <section
      aria-label="로컬 글자 읽기 초안 검토"
      className="mt-5 space-y-4 rounded-2xl border border-primary/30 bg-primary/[.025] p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <Badge variant="outline">글자 읽기 초안 · 미검토</Badge>
          <h3 className="break-words font-semibold">{source.name}</h3>
          <p className="text-xs leading-6 text-muted-foreground">
            이 PC에서 한국어 글자 읽기 · {preview.pages.length}페이지 ·{" "}
            {formatDate(preview.observedAt)}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="글자 읽기 초안 닫기"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <Notice>
        글자 읽기는 원본을 외부 AI로 보내지 않습니다. 숫자·날짜·이름과 표의 행·열을 잘못 읽거나
        빠뜨릴 수 있습니다. 아직 자료 본문을 저장하지 않았으며, 원본과 대조하기 전에는 분석 근거로
        사용하지 않습니다.
      </Notice>
      {preview.warnings.length > 0 && (
        <Notice tone="warning">
          <ul className="list-inside list-disc">
            {preview.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
      {blockedReason && (
        <Notice tone="warning">{blockedReason} 교정 내용은 이 화면에 유지했습니다.</Notice>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm leading-6 text-destructive"
        >
          {error}
        </p>
      )}
      <div className="space-y-2 rounded-xl border bg-background p-4 text-xs leading-6">
        <p className="break-words">
          대조 원본: {preview.original.originalName} · {preview.original.sizeBytes.toLocaleString()}
          바이트
        </p>
        <details>
          <summary className="cursor-pointer">읽을 때 확인한 원본 SHA256</summary>
          <p className="break-all font-mono">{preview.original.sha256}</p>
        </details>
        <Button asChild type="button" variant="outline" size="sm">
          <a href={originalUrl} download>
            <Download />
            원본 내려받아 대조
          </a>
        </Button>
        <p className="text-muted-foreground">
          원본 다운로드는 현재 보관 파일입니다. 저장 시 자료 버전과 원본 SHA256을 다시 대조합니다.
        </p>
      </div>
      <details className="rounded-xl border bg-background p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          페이지별 미검토 초안과 원본 대조 안내
        </summary>
        <div className="mt-4 space-y-4">
          {preview.pages.map((page) => (
            <article key={page.pageNumber} className="space-y-2 rounded-lg border p-3">
              <h4 className="text-sm font-semibold">원본 {page.pageNumber}페이지 · 미검토</h4>
              <a href={originalUrl} download className="text-xs underline underline-offset-2">
                원본 내려받아 {page.pageNumber}페이지 대조
              </a>
              <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm leading-7">
                {page.text || "읽힌 글자가 없습니다. 원본을 직접 확인해 주세요."}
              </p>
            </article>
          ))}
        </div>
      </details>
      <fieldset disabled={busy || !!blockedReason} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="local-ocr-corrected-text">원본과 대조해 교정할 본문</Label>
          <Textarea
            id="local-ocr-corrected-text"
            className="min-h-72 bg-background leading-7"
            value={text}
            maxLength={100000}
            onChange={(event) => {
              setText(event.target.value);
              setReviewed(false);
            }}
          />
          <p className="text-right text-xs text-muted-foreground">
            {text.length.toLocaleString()} / 100,000자
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm leading-6">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
          />
          <span>원본의 각 페이지와 대조하여 저장할 본문을 교정·확인했습니다.</span>
        </label>
        <Notice>
          확인한 본문을 저장하면 직접 입력 자료로 등록되어 이후 분석 근거에 포함될 수 있습니다. 보관
          원본은 유지됩니다. 근거가 바뀌므로 분석과 기존 사업계획서는 다시 검토해야 합니다. 자료
          저장은 사업계획서의 검토 완료나 기관 제출이 아닙니다.
        </Notice>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            초안 닫기
          </Button>
          <Button
            type="button"
            disabled={!!saveBlockedReason}
            onClick={() => {
              if (!saveBlockedReason) onSave(text);
            }}
          >
            <Save />
            {busy ? "본문 저장 중" : "확인한 본문 저장"}
          </Button>
        </div>
        {saveBlockedReason && (
          <p className="text-xs leading-6 text-muted-foreground">{saveBlockedReason}</p>
        )}
      </fieldset>
    </section>
  );
}
