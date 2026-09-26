"use client";

import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileText,
  Pencil,
  Plus,
  Save,
  ScanText,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  sourceKindLabels,
  sourceKinds,
  type SourceDocument,
  type StudioCase,
} from "@/lib/studio-schema";
import type { LocalOcrPreview } from "@/lib/studio-local-ocr-types";
import {
  EmptyPanel,
  Notice,
  PanelHeading,
  jsonBody,
  selectClass,
  studioFetch,
  useDirty,
  type PanelProps,
} from "./shared";
import { OcrReviewPanel, supportsLocalOcr, validateLocalOcrPreview } from "./ocr-review-panel";

type SourceKind = SourceDocument["kind"];
export type SourceExtractionMode = "extract" | "original-only";
const originalOnlyExtensions = [".pdf", ".png", ".jpg", ".jpeg", ".webp"];

export function SourceUploadOptions({
  originalOnly,
  allowAi,
  aiConfigured,
  onOriginalOnlyChange,
  onAllowAiChange,
}: {
  originalOnly: boolean;
  allowAi: boolean;
  aiConfigured: boolean;
  onOriginalOnlyChange: (value: boolean) => void;
  onAllowAiChange: (value: boolean) => void;
}) {
  return (
    <div className="mt-4 space-y-3">
      <label className="flex items-start gap-2 text-sm leading-6">
        <input
          id="source-original-only"
          type="checkbox"
          className="mt-1 accent-teal-700"
          checked={originalOnly}
          onChange={(event) => onOriginalOnlyChange(event.target.checked)}
        />
        <span>원본만 보관 — 본문 미추출</span>
      </label>
      {originalOnly && (
        <Notice>
          PDF·PNG·JPG·JPEG·WEBP 원본을 이 PC에 보관합니다. 본문을 추출하거나 AI로 전송하지 않습니다.
          원본 내용을 확인하고 필요한 본문을 직접 입력해 주세요. 본문 확인 전에는 분석 근거로
          사용하지 않습니다.
        </Notice>
      )}
      <label className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <input
          id="source-allow-ai"
          type="checkbox"
          className="mt-1 accent-teal-700"
          checked={allowAi && !originalOnly}
          disabled={!aiConfigured || originalOnly}
          onChange={(event) => onAllowAiChange(event.target.checked)}
        />
        <span>
          필요 시 AI 문서·음성 분석을 허용합니다. 원본이 연결된 AI 서비스로 전송됩니다.
          {originalOnly
            ? " 원본만 보관 모드에서는 사용할 수 없습니다."
            : !aiConfigured && " AI 연결 후 사용할 수 있습니다."}
        </span>
      </label>
    </div>
  );
}

export function SourcesPanel({
  company,
  mutate,
  setDirty,
  upload,
  supportedFiles,
  aiConfigured,
  blockedReason = "",
}: PanelProps & {
  upload: (
    file: File,
    kind: SourceKind,
    allowAi: boolean,
    extractionMode?: SourceExtractionMode,
  ) => Promise<StudioCase | null>;
  supportedFiles: string[];
  aiConfigured: boolean;
  blockedReason?: string;
}) {
  const protectedSources = new Set(
    (company.agencyRecords ?? []).flatMap((record) => record.evidence.map((item) => item.sourceId)),
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SourceDocument | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SourceKind>("consultation");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKind, setFileKind] = useState<SourceKind>("technology");
  const [allowAi, setAllowAi] = useState(false);
  const [originalOnly, setOriginalOnly] = useState(false);
  const [ocrDraft, setOcrDraft] = useState<{
    caseId: string;
    source: SourceDocument;
    preview: LocalOcrPreview;
    binding: string;
    clientRequestId: string;
  } | null>(null);
  const [ocrBusy, setOcrBusy] = useState<"reading" | "saving" | null>(null);
  const [ocrError, setOcrError] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const binding = `${company.id}:${company.revision}`;
  const context = useRef(binding);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    context.current = binding;
  }, [binding]);
  const ocrLocked = Boolean(ocrDraft || ocrBusy);
  const ocrBlockedReason =
    ocrDraft &&
    (ocrDraft.binding !== binding ||
      !company.sources.some(
        (source) =>
          source.id === ocrDraft.source.id &&
          source.updatedAt === ocrDraft.preview.sourceUpdatedAt &&
          supportsLocalOcr(source),
      ))
      ? "기업 또는 자료 버전이 바뀌어 이 초안을 저장할 수 없습니다. 최신 자료에서 다시 준비해 주세요."
      : "";
  const invalidOriginalOnlyFile = Boolean(
    originalOnly &&
    file &&
    !originalOnlyExtensions.includes(`.${file.name.split(".").pop()?.toLowerCase()}`),
  );
  const dirty =
    !!file ||
    (formOpen &&
      (editing
        ? name !== editing.name || kind !== editing.kind || text !== editing.text
        : !!name || !!text));
  useDirty(dirty || ocrLocked || mutationBusy, setDirty);
  function otherEditingBlocked() {
    if (blockedReason) {
      toast.error(blockedReason);
      return true;
    }
    if (ocrLocked || inFlight.current) {
      toast.error("진행 중인 글자 읽기와 본문 검토를 먼저 마치거나 초안을 닫아 주세요.");
      return true;
    }
    return false;
  }
  function openForm(source: SourceDocument | null) {
    if (otherEditingBlocked()) return;
    if (dirty && !window.confirm("저장하지 않은 자료 편집을 취소할까요?")) return;
    setEditing(source);
    setName(source?.name || "");
    setKind(source?.kind || "consultation");
    setText(source?.text || "");
    setFormOpen(true);
    setFile(null);
  }
  function closeForm() {
    if (dirty && !window.confirm("저장하지 않은 자료 편집을 취소할까요?")) return;
    setFormOpen(false);
    setEditing(null);
  }
  async function saveSource() {
    if (otherEditingBlocked()) return;
    if (!name.trim() || !text.trim()) {
      toast.error("자료 제목과 내용을 입력해 주세요.");
      return;
    }
    const now = new Date().toISOString();
    const source: SourceDocument = {
      id: editing?.id || crypto.randomUUID(),
      name: name.trim(),
      kind,
      text,
      originalName: editing?.originalName || null,
      mimeType: editing?.mimeType || null,
      extraction: "manual",
      warnings: editing?.warnings || [],
      createdAt: editing?.createdAt || now,
      updatedAt: now,
    };
    inFlight.current = true;
    setMutationBusy(true);
    try {
      await mutate({ action: "source", source });
    } finally {
      inFlight.current = false;
      if (mounted.current) setMutationBusy(false);
    }
  }
  async function remove(source: SourceDocument) {
    if (otherEditingBlocked()) return;
    if (protectedSources.has(source.id)) {
      toast.error("기관 기록에 연결된 원본은 보존해야 합니다.");
      return;
    }
    if (dirty) {
      toast.error("편집 중인 자료를 먼저 저장하거나 취소해 주세요.");
      return;
    }
    if (
      window.confirm(
        `‘${source.name}’ 자료를 삭제할까요? 기존 사업계획서의 근거를 다시 확인해야 합니다.`,
      )
    ) {
      inFlight.current = true;
      setMutationBusy(true);
      try {
        await mutate({ action: "delete-source", sourceId: source.id });
      } finally {
        inFlight.current = false;
        if (mounted.current) setMutationBusy(false);
      }
    }
  }
  async function uploadFile() {
    if (otherEditingBlocked()) return;
    if (!file) return;
    if (formOpen && (name || text)) {
      toast.error("텍스트 자료를 먼저 저장하거나 취소해 주세요.");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast.error("12MB 이하의 파일을 선택해 주세요.");
      return;
    }
    if (invalidOriginalOnlyFile) {
      toast.error("원본만 보관은 PDF·PNG·JPG·JPEG·WEBP 파일만 지원합니다.");
      return;
    }
    inFlight.current = true;
    setMutationBusy(true);
    try {
      await upload(
        file,
        fileKind,
        originalOnly ? false : allowAi,
        originalOnly ? "original-only" : "extract",
      );
    } finally {
      inFlight.current = false;
      if (mounted.current) setMutationBusy(false);
    }
  }
  async function readOcr(source: SourceDocument) {
    if (blockedReason) {
      setOcrError(blockedReason);
      return;
    }
    if (inFlight.current || ocrLocked || !supportsLocalOcr(source)) return;
    if (dirty || formOpen) {
      setOcrError("기존 자료 편집이나 파일 선택을 먼저 저장하거나 취소해 주세요.");
      return;
    }
    inFlight.current = true;
    setOcrBusy("reading");
    setOcrError("");
    try {
      const response = await studioFetch<unknown>(
        `/api/studio/cases/${company.id}/sources/${source.id}/ocr-preview`,
        {
          method: "POST",
          ...jsonBody({ revision: company.revision }),
        },
      );
      if (!mounted.current || context.current !== binding) return;
      const preview = validateLocalOcrPreview(response, source, company.revision);
      setOcrDraft({
        caseId: company.id,
        source,
        preview,
        binding,
        clientRequestId: crypto.randomUUID(),
      });
    } catch (caught) {
      if (mounted.current && context.current === binding)
        setOcrError(
          caught instanceof Error
            ? caught.message
            : "이 PC에서 글자를 읽지 못했습니다. 원본은 그대로 보관되어 있습니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setOcrBusy(null);
    }
  }
  function closeOcr() {
    if (inFlight.current) return;
    if (
      ocrDraft &&
      !window.confirm("저장하지 않은 글자 읽기 초안과 교정 내용을 닫을까요? 원본은 보관됩니다.")
    )
      return;
    setOcrDraft(null);
    setOcrError("");
  }
  async function saveOcr(correctedText: string) {
    if (!ocrDraft || inFlight.current || blockedReason || ocrBlockedReason || dirty || formOpen)
      return;
    if (!correctedText.trim() || correctedText.length > 100000) return;
    inFlight.current = true;
    setOcrBusy("saving");
    setOcrError("");
    try {
      const saved = await mutate({
        action: "review-local-ocr",
        clientRequestId: ocrDraft.clientRequestId,
        sourceId: ocrDraft.source.id,
        sourceUpdatedAt: ocrDraft.preview.sourceUpdatedAt,
        originalSha256: ocrDraft.preview.original.sha256,
        text: correctedText,
        reviewed: true,
      });
      if (mounted.current && context.current === binding) {
        if (saved) setOcrDraft(null);
        else
          setOcrError(
            "본문을 저장하지 못했습니다. 교정 내용과 확인 상태는 유지했습니다. 오류 안내와 최신 저장 상태를 확인해 주세요.",
          );
      }
    } catch (caught) {
      if (mounted.current && context.current === binding)
        setOcrError(
          caught instanceof Error
            ? caught.message
            : "본문을 저장하지 못했습니다. 교정 내용은 유지했습니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setOcrBusy(null);
    }
  }
  return (
    <fieldset disabled={!!blockedReason} className="min-w-0">
      <PanelHeading
        title="기술과 사업의 근거를 모으세요"
        description="본문을 추출하거나 원본만 보관할 수 있습니다. 확인한 본문을 분석 근거로 사용합니다."
        actions={<Badge variant="outline">{company.sources.length} / 40개 자료</Badge>}
      />
      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      <fieldset
        disabled={!!blockedReason || ocrLocked || mutationBusy}
        className="grid gap-4 xl:grid-cols-[1.25fr_1fr]"
      >
        <div className="rounded-2xl border bg-muted/20 p-5">
          <div className="mb-4 flex items-center gap-2 font-semibold">
            <UploadCloud className="size-5 text-primary" />
            원본 파일 추가
          </div>
          <Label htmlFor="source-file" className="mb-2 block text-xs text-muted-foreground">
            {originalOnly
              ? originalOnlyExtensions.join(" · ")
              : supportedFiles.length
                ? supportedFiles.join(" · ")
                : "지원 형식 확인 중"}{" "}
            · 파일당 최대 12MB
          </Label>
          <Input
            id="source-file"
            type="file"
            accept={
              originalOnly
                ? originalOnlyExtensions.join(",")
                : supportedFiles.join(",") || undefined
            }
            className="h-auto min-h-10 bg-white py-2"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
          {invalidOriginalOnlyFile && (
            <p role="alert" className="mt-2 text-xs leading-6 text-destructive">
              원본만 보관은 PDF·PNG·JPG·JPEG·WEBP 파일만 지원합니다. 파일을 바꾸거나 본문 추출
              모드를 사용해 주세요.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-40 flex-1 space-y-2">
              <Label htmlFor="file-kind">자료 분류</Label>
              <select
                id="file-kind"
                className={selectClass}
                value={fileKind}
                onChange={(event) => setFileKind(event.target.value as SourceKind)}
              >
                {sourceKinds.map((value) => (
                  <option key={value} value={value}>
                    {sourceKindLabels[value]}
                  </option>
                ))}
              </select>
            </div>
            <Button
              className="h-10"
              disabled={!file || invalidOriginalOnlyFile || company.sources.length >= 40}
              onClick={uploadFile}
            >
              <UploadCloud />
              {originalOnly ? "원본만 보관" : "자료 업로드"}
            </Button>
          </div>
          <SourceUploadOptions
            originalOnly={originalOnly}
            allowAi={allowAi}
            aiConfigured={aiConfigured}
            onOriginalOnlyChange={(value) => {
              setOriginalOnly(value);
              if (value) setAllowAi(false);
            }}
            onAllowAiChange={setAllowAi}
          />
        </div>
        <div className="flex flex-col items-start rounded-2xl border bg-white p-5">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <FileText className="size-5 text-primary" />
            녹취·메모 직접 입력
          </div>
          <p className="mb-5 text-sm leading-7 text-muted-foreground">
            상담 녹취록, 기술 설명, 고객 인터뷰를 붙여넣으세요. 자료별로 제목과 분류를 지정하면
            근거를 찾기 쉽습니다.
          </p>
          <Button
            className="mt-auto"
            variant="outline"
            disabled={company.sources.length >= 40}
            onClick={() => openForm(null)}
          >
            <Plus />
            텍스트 자료 추가
          </Button>
        </div>
      </fieldset>
      {ocrBusy === "reading" && (
        <p role="status" className="mt-4 rounded-xl border p-4 text-sm leading-6">
          이 PC에서 글자를 읽고 있습니다. 최대 2분이 걸릴 수 있습니다. 원본과 자료 본문은 변경하지
          않습니다.
        </p>
      )}
      {ocrError && !ocrDraft && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-destructive/30 p-4 text-sm leading-6 text-destructive"
        >
          {ocrError}
        </p>
      )}
      {ocrDraft && (
        <OcrReviewPanel
          key={ocrDraft.clientRequestId}
          caseId={ocrDraft.caseId}
          source={ocrDraft.source}
          preview={ocrDraft.preview}
          busy={ocrBusy === "saving"}
          blockedReason={ocrBlockedReason}
          error={ocrError}
          onSave={(text) => void saveOcr(text)}
          onClose={closeOcr}
        />
      )}
      {formOpen && (
        <section
          className="mt-5 rounded-2xl border border-primary/30 bg-primary/[.025] p-5"
          aria-label="자료 편집"
        >
          <div className="mb-4 flex items-center justify-between gap-2">
            <h3 className="font-semibold">
              {editing?.extraction === "pending"
                ? "보관 원본의 본문 입력"
                : editing
                  ? "추출 내용·분류 수정"
                  : "새 텍스트 자료"}
            </h3>
            <Button variant="ghost" size="icon" aria-label="자료 편집 취소" onClick={closeForm}>
              <X />
            </Button>
          </div>
          {editing?.extraction === "pending" && (
            <div className="mb-4">
              <Notice>
                아직 본문을 추출하지 않은 원본입니다. 원문에서 직접 확인한 내용을 입력하세요.
                저장하면 직접 입력 자료로 전환되며 보관한 원본은 유지됩니다.
              </Notice>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-[1fr_190px]">
            <div className="space-y-2">
              <Label htmlFor="source-name">자료 제목</Label>
              <Input
                id="source-name"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                placeholder="예: 대표 상담 녹취 2026-09-22"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="source-kind">분류</Label>
              <select
                id="source-kind"
                className={selectClass}
                value={kind}
                onChange={(event) => setKind(event.target.value as SourceKind)}
              >
                {sourceKinds.map((value) => (
                  <option key={value} value={value}>
                    {sourceKindLabels[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <Label htmlFor="source-text">자료 내용</Label>
            <Textarea
              id="source-text"
              className="min-h-64 bg-white leading-7"
              maxLength={100000}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="원문의 내용을 입력해 주세요. 계획과 이미 완료한 실적을 구분하면 분석이 정확해집니다."
            />
            <p className="text-right text-[11px] text-muted-foreground">
              {text.length.toLocaleString()} / 100,000자
            </p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={closeForm}>
              취소
            </Button>
            <Button onClick={saveSource}>
              <Save />
              자료 저장
            </Button>
          </div>
        </section>
      )}
      <div className="mt-6">
        {company.sources.length === 0 ? (
          <EmptyPanel
            title="아직 등록한 자료가 없습니다"
            description="특허 원문, 제품설명서 또는 상담 녹취부터 시작하세요. 자료가 추가될수록 회사에 맞는 아이템과 사업계획서를 구체화할 수 있습니다."
          />
        ) : (
          <div className="space-y-3">
            {company.sources.map((source) => (
              <article key={source.id} className="rounded-xl border bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="font-normal">
                        {sourceKindLabels[source.kind]}
                      </Badge>
                      {source.extraction === "pending" && (
                        <Badge variant="outline">본문 확인 필요</Badge>
                      )}
                      {protectedSources.has(source.id) && (
                        <Badge variant="outline">기관 기록에 연결 · 삭제 보호</Badge>
                      )}
                      <span className="text-[11px] text-muted-foreground">
                        {source.extraction === "pending"
                          ? "원본만 보관 · 본문 미추출"
                          : source.extraction === "manual"
                            ? "직접 입력"
                            : source.extraction === "ai"
                              ? "AI 추출"
                              : "문서 추출"}{" "}
                        · {source.text.length.toLocaleString()}자
                      </span>
                    </div>
                    <h3 className="break-words font-semibold">{source.name}</h3>
                    <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                      {source.extraction === "pending"
                        ? "본문을 추출하지 않았습니다. 원본을 확인해 본문을 저장하기 전까지 분석 근거로 사용하지 않습니다."
                        : source.text || "추출된 텍스트가 없습니다. 내용을 직접 입력해 주세요."}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {supportsLocalOcr(source) && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!!blockedReason || ocrLocked || mutationBusy || dirty || formOpen}
                        onClick={() => void readOcr(source)}
                      >
                        <ScanText />이 PC에서 글자 읽기
                      </Button>
                    )}
                    {source.originalName && (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon"
                        aria-label={`${source.name} 원본 다운로드`}
                      >
                        <a href={`/api/studio/cases/${company.id}/sources/${source.id}`} download>
                          <Download />
                        </a>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${source.name} 수정`}
                      disabled={!!blockedReason || ocrLocked || mutationBusy}
                      onClick={() => openForm(source)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      aria-label={`${source.name} 삭제`}
                      disabled={
                        !!blockedReason ||
                        protectedSources.has(source.id) ||
                        ocrLocked ||
                        mutationBusy
                      }
                      onClick={() => remove(source)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                {source.warnings.length > 0 && (
                  <div className="mt-3">
                    <Notice tone="warning">
                      <ul className="list-inside list-disc">
                        {source.warnings.map((warning, index) => (
                          <li key={index}>{warning}</li>
                        ))}
                      </ul>
                    </Notice>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </fieldset>
  );
}
