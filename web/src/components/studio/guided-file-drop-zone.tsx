"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./guided-file-drop-zone.module.css";

const hasFiles = (transfer: DataTransfer | null) =>
  !!transfer && Array.from(transfer.types).includes("Files");

// Keep this mounted in the workspace, including its busy/reconciliation views.
export function useFileDropNavigationGuard() {
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);
}

export function GuidedFileDropZone({
  disabled,
  onFiles,
  className,
  children,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  className?: string;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const depth = useRef(0);
  const reset = () => {
    depth.current = 0;
    setDragging(false);
  };

  useEffect(() => {
    const outsideDrop = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      setNotice("파일을 아래 점선 영역에 놓아 주세요.");
    };
    const finishDrag = () => {
      depth.current = 0;
      setDragging(false);
    };
    window.addEventListener("drop", outsideDrop);
    window.addEventListener("dragend", finishDrag);
    window.addEventListener("blur", finishDrag);
    return () => {
      window.removeEventListener("drop", outsideDrop);
      window.removeEventListener("dragend", finishDrag);
      window.removeEventListener("blur", finishDrag);
    };
  }, []);

  return (
    <section
      className={`${className ?? ""} ${styles.zone}`}
      aria-label="자료 파일 끌어놓기"
      data-disabled={disabled}
      data-dragging={dragging && !disabled}
      onChangeCapture={(event) => {
        if (event.target instanceof HTMLInputElement && event.target.type === "file") setNotice("");
      }}
      onDragEnter={(event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current += 1;
        setNotice("");
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        reset();
        if (!hasFiles(event.dataTransfer)) return;
        if (disabled) return;
        // Read the browser's file list synchronously; it is protected after this event.
        const files = Array.from(event.dataTransfer.files);
        try {
          const directory = Array.from(event.dataTransfer.items).some(
            (item) => item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory,
          );
          if (directory) {
            setNotice(
              "폴더는 열어서 안의 파일들을 선택해 놓아 주세요. 이번 자료는 전송하지 않았습니다.",
            );
            return;
          }
        } catch {
          setNotice("끌어온 파일을 확인하지 못했습니다. 자료 올리기 버튼으로 선택해 주세요.");
          return;
        }
        if (!files.length) {
          setNotice("끌어온 파일을 읽지 못했습니다. 자료 올리기 버튼으로 선택해 주세요.");
          return;
        }
        setNotice("");
        onFiles(files);
      }}
    >
      <p className={styles.instruction} role="status">
        {disabled
          ? "진행 중인 저장이나 상태 확인을 마친 뒤 파일을 놓아 주세요."
          : notice ||
            (dragging ? "여기에 놓으면 업로드를 시작합니다" : "파일을 이곳에 끌어다 놓으세요")}
      </p>
      <p className={styles.helper}>
        여러 파일을 한 번에 놓거나, 자료 올리기 버튼으로 선택할 수 있습니다.
      </p>
      {children}
    </section>
  );
}
