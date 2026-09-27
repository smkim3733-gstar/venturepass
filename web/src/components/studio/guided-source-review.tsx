"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import type { LocalOcrPreview } from "@/lib/studio-local-ocr-types";
import type { SourceDocument, StudioCase } from "@/lib/studio-schema";
import {
  ocrReviewSaveBlockedReason,
  supportsLocalOcr,
  validateLocalOcrPreview,
} from "./ocr-review-panel";
import { jsonBody, studioFetch, useDirty, type StudioMutation } from "./shared";
import styles from "./guided-workspace.module.css";

export type GuidedSourceReviewBinding = {
  caseId: string;
  revision: number;
  source: SourceDocument;
};
export type GuidedSourceReviewDraft = {
  text: string;
  reviewed: boolean;
  preview: LocalOcrPreview | null;
  clientRequestId: string | null;
};
type DraftAction =
  | { type: "text"; text: string }
  | { type: "reviewed"; reviewed: boolean }
  | { type: "preview"; preview: LocalOcrPreview; clientRequestId: string };

export function guidedSourceReviewReducer(
  state: GuidedSourceReviewDraft,
  action: DraftAction,
): GuidedSourceReviewDraft {
  if (action.type === "text") return { ...state, text: action.text, reviewed: false };
  if (action.type === "reviewed") return { ...state, reviewed: action.reviewed };
  return {
    text: action.preview.text,
    reviewed: false,
    preview: action.preview,
    clientRequestId: action.clientRequestId,
  };
}

export function guidedSourceReviewBindingReason(
  company: StudioCase,
  source: SourceDocument,
  binding: GuidedSourceReviewBinding,
) {
  const matches = company.sources.filter((item) => item.id === binding.source.id);
  if (
    company.id !== binding.caseId ||
    company.revision !== binding.revision ||
    source.id !== binding.source.id ||
    matches.length !== 1 ||
    source.updatedAt !== binding.source.updatedAt ||
    matches[0].updatedAt !== binding.source.updatedAt ||
    source.text !== binding.source.text ||
    matches[0].text !== binding.source.text ||
    source.extraction !== binding.source.extraction ||
    matches[0].extraction !== binding.source.extraction ||
    source.originalName !== binding.source.originalName ||
    matches[0].originalName !== binding.source.originalName ||
    source.mimeType !== binding.source.mimeType ||
    matches[0].mimeType !== binding.source.mimeType
  )
    return "기업 또는 자료 버전이 바뀌어 저장을 멈췄습니다. 교정 본문은 유지했습니다. 내용을 복사한 뒤 최신 자료에서 다시 확인해 주세요.";
  return "";
}

export function guidedSourceReviewMutation(
  company: StudioCase,
  source: SourceDocument,
  binding: GuidedSourceReviewBinding,
  draft: GuidedSourceReviewDraft,
  blockedReason = "",
  busy = false,
): StudioMutation {
  const reason = ocrReviewSaveBlockedReason(
    draft.text,
    draft.reviewed,
    blockedReason || guidedSourceReviewBindingReason(company, source, binding),
    busy,
  );
  if (reason) throw new Error(reason);
  if (draft.preview) {
    const preview = validateLocalOcrPreview(draft.preview, binding.source, binding.revision);
    if (
      !draft.clientRequestId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        draft.clientRequestId,
      )
    )
      throw new Error("글자 읽기 저장 요청을 확인할 수 없습니다. 교정 본문은 유지했습니다.");
    return {
      action: "review-local-ocr",
      clientRequestId: draft.clientRequestId,
      sourceId: binding.source.id,
      sourceUpdatedAt: preview.sourceUpdatedAt,
      originalSha256: preview.original.sha256,
      text: draft.text,
      reviewed: true,
    };
  }
  return {
    action: "source",
    source: {
      ...binding.source,
      text: draft.text,
      extraction: "manual",
      updatedAt: new Date().toISOString(),
    },
  };
}

export function guidedSourceReviewSaved(
  company: StudioCase | null,
  binding: GuidedSourceReviewBinding,
  draft: GuidedSourceReviewDraft,
) {
  if (
    !company ||
    company.id !== binding.caseId ||
    !Number.isSafeInteger(company.revision) ||
    company.revision <= binding.revision
  )
    return false;
  const matches = company.sources.filter((item) => item.id === binding.source.id);
  if (matches.length !== 1) return false;
  const saved = matches[0];
  if (
    saved.text !== draft.text ||
    saved.extraction !== "manual" ||
    saved.updatedAt === binding.source.updatedAt ||
    saved.originalName !== binding.source.originalName ||
    saved.mimeType !== binding.source.mimeType ||
    saved.name !== binding.source.name ||
    saved.kind !== binding.source.kind ||
    saved.createdAt !== binding.source.createdAt
  )
    return false;
  if (draft.preview) {
    const receipts = company.sourceOcrReviews.filter(
      (item) => item.clientRequestId === draft.clientRequestId,
    );
    if (
      receipts.length !== 1 ||
      receipts[0].sourceId !== saved.id ||
      receipts[0].originalSha256 !== draft.preview.original.sha256 ||
      receipts[0].sourceUpdatedAt !== saved.updatedAt
    )
      return false;
  }
  return true;
}

export function GuidedSourceReview({
  company,
  source,
  busy,
  blockedReason,
  onBusyChange,
  mutate,
  onClose,
  onDirtyChange,
}: {
  company: StudioCase;
  source: SourceDocument;
  busy: boolean;
  blockedReason: string;
  onBusyChange: (message: string) => void;
  mutate: (mutation: StudioMutation) => Promise<StudioCase | null>;
  onClose: () => void;
  onDirtyChange: (value: boolean) => void;
}) {
  const [binding] = useState<GuidedSourceReviewBinding>(() => ({
    caseId: company.id,
    revision: company.revision,
    source: structuredClone(source),
  }));
  const [draft, dispatch] = useReducer(guidedSourceReviewReducer, {
    text: source.text,
    reviewed: false,
    preview: null,
    clientRequestId: null,
  });
  const [operation, setOperation] = useState<"reading" | "saving" | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const fieldId = useId();
  const bindingReason = guidedSourceReviewBindingReason(company, source, binding);
  const lockedReason = blockedReason || bindingReason;
  const locked = busy || operation !== null;
  const dirty =
    !saved &&
    (draft.text !== binding.source.text ||
      draft.reviewed ||
      draft.preview !== null ||
      operation !== null);
  const saveReason = ocrReviewSaveBlockedReason(draft.text, draft.reviewed, lockedReason, locked);
  const canRead = supportsLocalOcr(binding.source) && !draft.preview;
  const originalUrl = `/api/studio/cases/${binding.caseId}/sources/${binding.source.id}`;
  useDirty(dirty, onDirtyChange);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);

  async function readOriginal() {
    if (inFlight.current || locked || lockedReason || !canRead || draft.text.trim()) return;
    inFlight.current = true;
    setOperation("reading");
    setError("");
    onBusyChange("이 PC에서 원본 글자를 읽고 있습니다");
    try {
      const response = await studioFetch<unknown>(
        `/api/studio/cases/${binding.caseId}/sources/${binding.source.id}/ocr-preview`,
        {
          method: "POST",
          ...jsonBody({ revision: binding.revision }),
        },
      );
      const preview = validateLocalOcrPreview(response, binding.source, binding.revision);
      if (mounted.current)
        dispatch({ type: "preview", preview, clientRequestId: crypto.randomUUID() });
    } catch (caught) {
      if (mounted.current)
        setError(
          `${caught instanceof Error ? caught.message : "이 PC에서 글자를 읽지 못했습니다."} 원본과 입력 본문은 유지했습니다.`,
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setOperation(null);
        onBusyChange("");
      }
    }
  }

  async function save() {
    if (inFlight.current) return;
    let mutation: StudioMutation;
    try {
      mutation = guidedSourceReviewMutation(company, source, binding, draft, blockedReason, locked);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "저장할 본문을 확인해 주세요.");
      return;
    }
    inFlight.current = true;
    setOperation("saving");
    setError("");
    onBusyChange("확인한 본문을 보관하고 있습니다");
    let completed = false;
    try {
      const result = await mutate(mutation);
      if (!mounted.current) return;
      if (!guidedSourceReviewSaved(result, binding, draft)) {
        setError(
          "저장 결과를 확인하지 못했습니다. 교정 본문과 확인 상태를 유지했습니다. 최신 저장 상태를 확인해 주세요.",
        );
        return;
      }
      setSaved(true);
      onDirtyChange(false);
      completed = true;
    } catch (caught) {
      if (mounted.current)
        setError(
          `${caught instanceof Error ? caught.message : "본문을 저장하지 못했습니다."} 교정 본문과 원본은 유지했습니다.`,
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setOperation(null);
        onBusyChange("");
      }
    }
    if (completed && mounted.current) onClose();
  }

  function close() {
    if (inFlight.current || locked) return;
    if (dirty && !window.confirm("저장하지 않은 교정 본문을 닫을까요? 보관한 원본은 유지됩니다."))
      return;
    onDirtyChange(false);
    onClose();
  }

  return (
    <section className={styles.sheet} aria-label="자료 본문 확인">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={styles.eyebrow}>
            {draft.preview ? "글자 읽기 초안 · 미검토" : "원본과 본문 확인"}
          </p>
          <h2 className={styles.subheading}>{binding.source.name}</h2>
        </div>
        <button type="button" className={styles.link} disabled={locked} onClick={close}>
          닫기
        </button>
      </div>
      <p className={styles.helper}>
        숫자·날짜·이름을 원본과 대조해 고쳐 주세요. 저장한 본문은 이후 계획서의 근거로 쓰이며,
        보관한 원본은 유지됩니다.
      </p>
      {binding.source.originalName && (
        <a className={`${styles.link} inline-block`} href={originalUrl} download>
          원본 내려받아 대조
        </a>
      )}
      {canRead && (
        <div className={styles.support}>
          <button
            type="button"
            className={styles.link}
            disabled={locked || !!lockedReason || !!draft.text.trim()}
            onClick={() => void readOriginal()}
          >
            이 PC에서 글자 읽기
          </button>
          <p className={styles.helper}>
            원본을 외부 AI로 보내지 않습니다. 직접 본문을 입력해도 됩니다.
          </p>
        </div>
      )}
      {operation === "reading" && (
        <p role="status" className={styles.notice}>
          이 PC에서 글자를 읽고 있습니다. 최대 2분이 걸릴 수 있습니다. 원본과 저장된 본문은 바꾸지
          않습니다.
        </p>
      )}
      {lockedReason && (
        <p role="alert" className={styles.notice}>
          {lockedReason}
        </p>
      )}
      {error && (
        <p role="alert" className={`${styles.error} mt-4`}>
          {error}
        </p>
      )}
      {draft.preview && (
        <div className={styles.notice}>
          <strong>읽은 글자는 아직 확인하지 않은 초안입니다</strong>
          <p>
            원본 {draft.preview.pages.length}페이지와 대조해 주세요. 저장하기 전에는 분석 근거로
            쓰지 않습니다.
          </p>
          {!!draft.preview.warnings.length && (
            <ul className={styles.reviewList}>
              {draft.preview.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
          <details className={styles.details}>
            <summary>페이지별 읽기 결과</summary>
            {draft.preview.pages.map((page) => (
              <div key={page.pageNumber} className="mt-4">
                <p className={styles.label}>{page.pageNumber}페이지 · 미검토</p>
                <p className={styles.body}>
                  {page.text || "읽힌 글자가 없습니다. 원본에서 직접 확인해 주세요."}
                </p>
              </div>
            ))}
          </details>
        </div>
      )}
      <label className={`${styles.label} mt-5`} htmlFor={fieldId}>
        원본과 대조할 본문
      </label>
      <textarea
        id={fieldId}
        className={`${styles.textarea} min-h-64`}
        value={draft.text}
        readOnly={locked || !!lockedReason}
        maxLength={100000}
        onChange={(event) => dispatch({ type: "text", text: event.target.value })}
      />
      <p className={`${styles.helper} text-right`}>
        {draft.text.length.toLocaleString()} / 100,000자
      </p>
      <label className="mt-4 flex items-start gap-3 text-sm leading-7">
        <input
          type="checkbox"
          className="mt-1.5 size-4 shrink-0 accent-[#172D4D]"
          checked={draft.reviewed}
          disabled={locked || !!lockedReason}
          onChange={(event) => dispatch({ type: "reviewed", reviewed: event.target.checked })}
        />
        <span>원본과 대조해 저장할 본문을 확인했습니다.</span>
      </label>
      <div className={styles.actions}>
        <p className={styles.helper}>
          {saveReason || "본문을 고치면 기존 분석과 계획서는 다시 검토해야 합니다."}
        </p>
        <button
          type="button"
          className={styles.primary}
          disabled={!!saveReason}
          onClick={() => void save()}
        >
          {operation === "saving" ? "본문 저장 중" : "확인한 본문 저장"}
        </button>
      </div>
    </section>
  );
}
