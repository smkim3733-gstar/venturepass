"use client";

import { useState } from "react";
import { Download, FileText, Pencil, Plus, Save, Trash2, UploadCloud, X } from "lucide-react";
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
import { EmptyPanel, Notice, PanelHeading, selectClass, useDirty, type PanelProps } from "./shared";

type SourceKind = SourceDocument["kind"];
export function SourcesPanel({
  company,
  mutate,
  setDirty,
  upload,
  supportedFiles,
  aiConfigured,
}: PanelProps & {
  upload: (file: File, kind: SourceKind, allowAi: boolean) => Promise<StudioCase | null>;
  supportedFiles: string[];
  aiConfigured: boolean;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SourceDocument | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SourceKind>("consultation");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKind, setFileKind] = useState<SourceKind>("technology");
  const [allowAi, setAllowAi] = useState(false);
  const dirty =
    !!file ||
    (formOpen &&
      (editing
        ? name !== editing.name || kind !== editing.kind || text !== editing.text
        : !!name || !!text));
  useDirty(dirty, setDirty);
  function openForm(source: SourceDocument | null) {
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
      extraction: editing?.extraction || "manual",
      warnings: editing?.warnings || [],
      createdAt: editing?.createdAt || now,
      updatedAt: now,
    };
    await mutate({ action: "source", source });
  }
  async function remove(source: SourceDocument) {
    if (dirty) {
      toast.error("편집 중인 자료를 먼저 저장하거나 취소해 주세요.");
      return;
    }
    if (
      window.confirm(
        `‘${source.name}’ 자료를 삭제할까요? 기존 사업계획서의 근거를 다시 확인해야 합니다.`,
      )
    )
      await mutate({ action: "delete-source", sourceId: source.id });
  }
  async function uploadFile() {
    if (!file) return;
    if (formOpen && (name || text)) {
      toast.error("텍스트 자료를 먼저 저장하거나 취소해 주세요.");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast.error("12MB 이하의 파일을 선택해 주세요.");
      return;
    }
    await upload(file, fileKind, allowAi);
  }
  return (
    <div>
      <PanelHeading
        title="기술과 사업의 근거를 모으세요"
        description="자료는 원문과 함께 보관합니다. 추출된 내용을 확인하고 정확한 정보로 다듬어 주세요."
        actions={<Badge variant="outline">{company.sources.length} / 40개 자료</Badge>}
      />
      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <div className="rounded-2xl border bg-muted/20 p-5">
          <div className="mb-4 flex items-center gap-2 font-semibold">
            <UploadCloud className="size-5 text-primary" />
            원본 파일 추가
          </div>
          <Label htmlFor="source-file" className="mb-2 block text-xs text-muted-foreground">
            {supportedFiles.length ? supportedFiles.join(" · ") : "지원 형식 확인 중"} · 파일당 최대
            12MB
          </Label>
          <Input
            id="source-file"
            type="file"
            className="h-auto min-h-10 bg-white py-2"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
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
              disabled={!file || company.sources.length >= 40}
              onClick={uploadFile}
            >
              <UploadCloud />
              자료 업로드
            </Button>
          </div>
          <label className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <input
              type="checkbox"
              className="mt-1 accent-teal-700"
              checked={allowAi}
              disabled={!aiConfigured}
              onChange={(event) => setAllowAi(event.target.checked)}
            />
            <span>
              필요 시 AI 문서·음성 분석을 허용합니다. 원본이 연결된 AI 서비스로 전송됩니다.
              {!aiConfigured && " AI 연결 후 사용할 수 있습니다."}
            </span>
          </label>
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
      </div>
      {formOpen && (
        <section
          className="mt-5 rounded-2xl border border-primary/30 bg-primary/[.025] p-5"
          aria-label="자료 편집"
        >
          <div className="mb-4 flex items-center justify-between gap-2">
            <h3 className="font-semibold">{editing ? "추출 내용·분류 수정" : "새 텍스트 자료"}</h3>
            <Button variant="ghost" size="icon" aria-label="자료 편집 취소" onClick={closeForm}>
              <X />
            </Button>
          </div>
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
                      <span className="text-[11px] text-muted-foreground">
                        {source.extraction === "manual"
                          ? "직접 입력"
                          : source.extraction === "ai"
                            ? "AI 추출"
                            : "문서 추출"}{" "}
                        · {source.text.length.toLocaleString()}자
                      </span>
                    </div>
                    <h3 className="break-words font-semibold">{source.name}</h3>
                    <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                      {source.text || "추출된 텍스트가 없습니다. 내용을 직접 입력해 주세요."}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
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
                      onClick={() => openForm(source)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      aria-label={`${source.name} 삭제`}
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
    </div>
  );
}
