"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FolderUp } from "lucide-react";
import type { StudioCase } from "@/lib/studio-schema";
import { MAX_COMPANY_SOURCES, occupiedSourceSlots } from "@/lib/studio-source-limits";
import { GuidedFileDropZone } from "./guided-file-drop-zone";
import { AttachmentCard, attachmentGridClass, attachmentSize } from "./guided-materials";
import { intakeFileError } from "./source-intakes-ui";
import {
  browserIntakeBulkUploadQueue,
  type IntakeBulkUploadQueue,
  type IntakeBulkView,
} from "./source-intake-bulk-queue";
import styles from "./guided-workspace.module.css";

export function bulkUploadPresentation(view: IntakeBulkView | null) {
  const queue = view?.queue;
  const last = queue?.actions.at(-1);
  const rows = (view?.files ?? []).map((file) => {
    const request = last?.journal.request;
    const rejected =
      !!last?.rejection &&
      (request?.kind === "command"
        ? request.command.files.some((entry) => entry.clientFileId === file.clientFileId)
        : queue?.files.find((entry) => entry.clientFileId === file.clientFileId)?.originalNonce ===
          request?.input.clientRequestId);
    const label = rejected
      ? "접수 거절 · 전송 중단"
      : {
          stored: "원본 저장됨",
          remaining: "남은 파일",
          confirmation: "저장 여부 확인 필요",
          cancelled: "접수 취소됨",
        }[file.state];
    return {
      ...file,
      label,
      cardState: rejected
        ? "failed"
        : file.state === "stored"
          ? "saved"
          : file.state === "confirmation"
            ? "unknown"
            : "waiting",
    };
  });
  return {
    rows,
    stored: rows.filter((file) => file.state === "stored").length,
    remaining: rows.filter((file) => file.state === "remaining").length,
    confirmation: rows.filter(
      (file) => file.state === "confirmation" && file.cardState !== "failed",
    ).length,
    refused: rows.filter((file) => file.cardState === "failed").length,
    cancelled: rows.filter((file) => file.state === "cancelled").length,
    rejected: !!last?.rejection,
    closable:
      !!queue &&
      !view?.activeItemIds.length &&
      queue.actions.every((action) => action.acknowledged || !!action.rejection),
  };
}
type Props = {
  company: StudioCase;
  locked: boolean;
  onCompany: (company: StudioCase) => void;
  onBusyChange: (message: string) => void;
  onReviewSources: () => void;
};
/** Durable originals only; the existing intake review screen owns reading and adoption. */
export function GuidedBulkUpload(props: Props) {
  return <GuidedBulkUploadInner key={props.company.id} {...props} />;
}
function GuidedBulkUploadInner({
  company,
  locked,
  onCompany,
  onBusyChange,
  onReviewSources,
}: Props) {
  const [view, setView] = useState<IntakeBulkView | null>(null);
  const [ready, setReady] = useState(false),
    [running, setRunning] = useState(false),
    [reading, setReading] = useState(false);
  const [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{ name: string; size: number }[]>([]);
  const [selectedCount, setSelectedCount] = useState(0),
    [limit, setLimit] = useState(12);
  const [stopping, setStopping] = useState(false);
  const controller = useRef<IntakeBulkUploadQueue | null>(null);
  const current = useRef(company),
    callbacks = useRef({ onCompany, onBusyChange });
  const selected = useRef<File[]>([]),
    input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false),
    inFlight = useRef(false),
    keepGoing = useRef(false);
  const companyId = company.id;
  useEffect(() => {
    current.current = company;
    callbacks.current = { onCompany, onBusyChange };
  }, [company, onCompany, onBusyChange]);
  const engine = useCallback(() => {
    controller.current ??= browserIntakeBulkUploadQueue(companyId);
    return controller.current;
  }, [companyId]);
  const apply = useCallback(
    (next: IntakeBulkView) => {
      if (
        !mounted.current ||
        next.company.id !== companyId ||
        next.company.revision < current.current.revision
      )
        return;
      current.current = next.company;
      setView(next);
      setReady(true);
      setPreview([]);
      callbacks.current.onCompany(next.company);
    },
    [companyId],
  );
  const read = useCallback(async () => {
    const next = await engine().inspect(current.current.revision);
    apply(next);
    return next;
  }, [apply, engine]);
  const reportFailure = useCallback(
    async (caught: unknown) => {
      if (!mounted.current) return;
      setError(caught instanceof Error ? caught.message : "자료 저장 상태를 확인하지 못했습니다.");
      try {
        await read();
      } catch {
        if (!mounted.current) return;
        setReady(false);
        try {
          const queue = await engine().readSelection();
          if (mounted.current && queue)
            setView({
              company: current.current,
              queue,
              activeItemIds: [],
              complete: false,
              files: queue.files.map((file) => ({
                clientFileId: file.clientFileId,
                name: file.originalName,
                size: file.sizeBytes,
                state: "confirmation",
              })),
            });
        } catch {
          /* Preserve existing cards and the error; never clear or repair corrupt storage. */
        }
      }
    },
    [engine, read],
  );
  useEffect(() => {
    mounted.current = true;
    let live = true;
    Promise.resolve()
      .then(() => engine().inspect(current.current.revision))
      .then((next) => {
        if (live) apply(next);
      })
      .catch((caught) => {
        if (live) void reportFailure(caught);
      });
    return () => {
      live = false;
      mounted.current = false;
      keepGoing.current = false;
    };
  }, [engine, apply, reportFailure]);
  async function inspect() {
    if (inFlight.current || locked) return;
    inFlight.current = true;
    setReading(true);
    setError("");
    try {
      await read();
    } catch (caught) {
      await reportFailure(caught);
    } finally {
      inFlight.current = false;
      if (mounted.current) setReading(false);
    }
  }
  async function upload(files: File[], startNew: boolean) {
    if (inFlight.current || locked || !ready || !files.length) return;
    const invalid = files
      .map((file, index) => ({ file, index, reason: intakeFileError(file) }))
      .find((item) => item.reason);
    const problem = invalid
      ? `선택한 파일 ${invalid.index + 1} (${invalid.file.name}): ${invalid.reason} 이번 선택 파일은 전송하지 않았습니다.`
      : "";
    if (
      problem ||
      files.length > MAX_COMPANY_SOURCES ||
      (startNew && occupiedSourceSlots(current.current) + files.length > MAX_COMPANY_SOURCES)
    ) {
      setError(problem || "저장된 자료와 접수 대기를 합해 회사별 100개까지 올릴 수 있습니다.");
      return;
    }
    inFlight.current = true;
    keepGoing.current = true;
    selected.current = [...files];
    setSelectedCount(files.length);
    setLimit(12);
    if (startNew) setPreview(files.map((file) => ({ name: file.name, size: file.size })));
    setRunning(true);
    setStopping(false);
    setError("");
    setMessage("");
    callbacks.current.onBusyChange("선택한 자료를 확인하고 순서대로 보관하는 중입니다");
    try {
      if (startNew) {
        await engine().begin(files);
        await read();
      }
      if (!mounted.current) return;
      const result = await engine().run(files, {
        shouldContinue: () => mounted.current && keepGoing.current,
        onProgress: (progress) => {
          if (mounted.current) apply(progress);
        },
      });
      apply(result);
      if (mounted.current)
        setMessage(
          result.complete
            ? "원본을 모두 보관했습니다. 본문 확인·판독에서 내용을 확인해 주세요."
            : !keepGoing.current
              ? "현재 파일 처리를 마치고 멈췄습니다. 이어 올리거나 나중에 원래 파일을 다시 선택할 수 있습니다."
              : "남은 파일을 확인해 주세요. 다음 묶음은 남은 파일들을 함께 선택하면 이어집니다.",
        );
    } catch (caught) {
      await reportFailure(caught);
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setRunning(false);
        setStopping(false);
        callbacks.current.onBusyChange("");
      }
    }
  }
  async function closeList() {
    if (inFlight.current || locked || !ready || !view?.queue) return;
    if (
      !view.complete &&
      !window.confirm(
        "이 선택 목록을 마칠까요? 이미 보관한 원본과 서버의 접수 대기는 그대로 남습니다. 아직 전송하지 않은 파일 목록만 닫습니다.",
      )
    )
      return;
    inFlight.current = true;
    setReading(true);
    setError("");
    try {
      if (view.complete) await engine().clearCompleted();
      else await engine().closeStoppedSelection({ confirmed: true });
      selected.current = [];
      setSelectedCount(0);
      setPreview([]);
      setMessage("");
      await read();
    } catch (caught) {
      await reportFailure(caught);
    } finally {
      inFlight.current = false;
      if (mounted.current) setReading(false);
    }
  }
  const presentation = bulkUploadPresentation(view);
  const disabled = locked || running || reading || !ready;
  const hasQueue = !!view?.queue;
  const rows = hasQueue
    ? presentation.rows
    : preview.map((file, index) => ({
        ...file,
        clientFileId: String(index),
        state: "remaining",
        label: running ? "선택 확인 중" : "전송하지 않음",
        cardState: "waiting",
      }));
  return (
    <section aria-label="자료 업로드와 이어 올리기">
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {!ready && (
        <p role="status" className={styles.helper}>
          저장 상태를 확인하고 있습니다. 확인되지 않으면 아래 저장 상태 확인을 눌러 주세요.
        </p>
      )}
      {hasQueue || preview.length ? (
        <section className={styles.sheet} aria-label="이번 업로드 결과">
          <h3 className={styles.subheading}>이번에 선택한 자료 {rows.length}개</h3>
          <p role="status" className={styles.helper}>
            원본 저장됨 {presentation.stored}개 · 확인 필요 {presentation.confirmation}개 · 남은
            파일 {hasQueue ? presentation.remaining : preview.length}개 · 취소{" "}
            {presentation.cancelled}개
            {presentation.refused > 0 && <> · 거절 {presentation.refused}개</>}
          </p>
          <ul className={attachmentGridClass}>
            {rows.slice(0, limit).map((file) => (
              <AttachmentCard
                key={file.clientFileId}
                name={file.name}
                state={file.cardState}
                label={file.label}
                meta={attachmentSize(file.size)}
              />
            ))}
          </ul>
          {rows.length > limit && (
            <button
              type="button"
              className={styles.link}
              onClick={() => setLimit((value) => value + 12)}
            >
              선택 파일 더 보기 ({rows.length - limit}개)
            </button>
          )}
          {message && (
            <p role="status" className={styles.helper}>
              {message}
            </p>
          )}
          {presentation.rejected && (
            <p className={styles.helper}>
              접수가 거절되어 멈췄습니다. 이 목록을 마친 뒤 자료 형식과 접수 대기를 확인해 주세요.
            </p>
          )}
          {presentation.cancelled > 0 && (
            <p className={styles.helper}>
              취소된 접수가 있어 전송을 멈췄습니다. 기존 원본과 접수 이력은 자료함에 남습니다.
            </p>
          )}
          <div className={styles.actions}>
            {running ? (
              <button
                type="button"
                className={styles.link}
                disabled={stopping}
                onClick={() => {
                  keepGoing.current = false;
                  setStopping(true);
                }}
              >
                현재 파일 뒤 일시 중단
              </button>
            ) : view?.complete ? (
              <button
                type="button"
                className={styles.primary}
                disabled={disabled}
                onClick={onReviewSources}
              >
                본문 확인·판독
              </button>
            ) : (
              !presentation.rejected &&
              !presentation.cancelled && (
                <button
                  type="button"
                  className={styles.primary}
                  disabled={disabled}
                  onClick={() =>
                    selectedCount ? void upload(selected.current, false) : input.current?.click()
                  }
                >
                  {selectedCount ? "이어서 올리기" : "남은 파일 다시 선택"}
                </button>
              )
            )}
            {!view?.complete && !presentation.rejected && !presentation.cancelled && (
              <button
                type="button"
                className={styles.link}
                disabled={disabled}
                onClick={() => input.current?.click()}
              >
                파일 다시 선택
              </button>
            )}
            {hasQueue && presentation.closable && (
              <button
                type="button"
                className={styles.link}
                disabled={disabled}
                onClick={() => void closeList()}
              >
                {view?.complete ? "선택 목록 닫기" : "선택 목록 마치기"}
              </button>
            )}
          </div>
          <p className={styles.helper}>
            새로고침하면 원래 파일을 다시 선택해 주세요. 처음 선택한 파일 전부를 선택해도 확인된
            원본은 다시 전송하지 않습니다.
          </p>
        </section>
      ) : (
        <GuidedFileDropZone
          className={`${styles.sheet} ${styles.upload}`}
          disabled={disabled}
          onFiles={(files) => void upload(files, true)}
        >
          <FolderUp aria-hidden="true" className={styles.uploadIcon} />
          <h3 className={styles.subheading}>사업자등록증 · 회사소개서 · 재무자료 등</h3>
          <p className={styles.helper}>
            PDF·워드(DOCX)·엑셀·이미지 등을 여러 개 선택할 수 있습니다. 파일당 12MB, 회사별
            100개까지 지원합니다. 이전 워드 형식(DOC)은 DOCX 또는 PDF로 저장해 주세요.
          </p>
          <button
            type="button"
            className={styles.primary}
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            자료 올리기
          </button>
        </GuidedFileDropZone>
      )}
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        aria-label={hasQueue ? "남은 회사 자료 파일 다시 선택" : "회사 자료 파일 선택"}
        accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp"
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void upload(files, !hasQueue);
        }}
      />
      <p className={styles.helper}>
        저장된 자료와 접수 대기 {occupiedSourceSlots(company)} / 100개 · 추가 가능{" "}
        {Math.max(0, 100 - occupiedSourceSlots(company))}개
      </p>
      <div className={styles.support}>
        <button
          type="button"
          className={styles.link}
          disabled={locked || running || reading}
          onClick={() => void inspect()}
        >
          저장 상태 확인
        </button>
        {company.sourceIntakes.length > 0 && !view?.complete && (
          <button
            type="button"
            className={styles.link}
            disabled={locked || running || reading}
            onClick={onReviewSources}
          >
            본문 확인·판독과 접수 상세
          </button>
        )}
      </div>
      <p className={styles.helper}>
        원본 보관 후 본문을 판독·검토합니다. 원본 저장은 본문 채택이나 사실 확인 완료가 아닙니다.
        이어 올리기 목록은 같은 브라우저·사이트 주소에 보관됩니다.
      </p>
    </section>
  );
}
