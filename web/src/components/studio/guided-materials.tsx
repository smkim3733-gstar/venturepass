"use client";
import { useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, FileText, LoaderCircle, Search } from "lucide-react";
import { sourceKindLabels, type SourceDocument, type StudioCase } from "@/lib/studio-schema";
import styles from "./guided-materials.module.css";

export function attachmentFormat(name: string) {
  const extension = name.match(/\.([^.]+)$/)?.[1].toLowerCase();
  if (!extension) return "자료";
  return (
    (
      { docx: "WORD", doc: "WORD", xlsx: "EXCEL", xls: "EXCEL", jpeg: "JPG" } as Record<
        string,
        string
      >
    )[extension] ?? extension.toUpperCase().slice(0, 8)
  );
}
export function attachmentSize(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
export function AttachmentCard({
  name,
  state,
  label,
  detail,
  meta,
  children,
  onOpen,
  disabled,
}: {
  name: string;
  state: string;
  label: string;
  detail?: string;
  meta?: string;
  children?: ReactNode;
  onOpen?: () => void;
  disabled?: boolean;
}) {
  const success = state === "saved" || state === "ready";
  const attention = state === "pending" || state === "failed" || state === "unknown";
  const Icon = success
    ? CheckCircle2
    : attention
      ? CircleAlert
      : state === "uploading"
        ? LoaderCircle
        : null;
  return (
    <li className={styles.card} data-state={state}>
      <div className={styles.fileHeading}>
        <div className={styles.fileIcon} aria-hidden="true">
          <FileText />
          <span>{attachmentFormat(name)}</span>
        </div>
        <div className={styles.fileIdentity}>
          {onOpen ? (
            <button
              type="button"
              className={styles.fileName}
              disabled={disabled}
              onClick={onOpen}
              aria-label={"자료 열기 · " + name}
            >
              {name}
            </button>
          ) : (
            <strong className={styles.fileName}>{name}</strong>
          )}
          {meta && <span className={styles.meta}>{meta}</span>}
        </div>
      </div>
      <span className={styles.badge}>
        {Icon && <Icon aria-hidden="true" />}
        {label}
      </span>
      {detail && <p className={styles.detail}>{detail}</p>}
      {children}
    </li>
  );
}
export type MaterialFilter = "all" | "ready" | "pending";
export function needsMaterialText(source: SourceDocument) {
  return source.extraction === "pending" || !source.text.trim();
}
export function filterMaterials(sources: SourceDocument[], query: string, filter: MaterialFilter) {
  const search = query.trim().toLocaleLowerCase("ko-KR");
  return sources
    .filter(
      (source) =>
        (filter === "all" || needsMaterialText(source) === (filter === "pending")) &&
        (!search ||
          [source.name, source.originalName ?? "", source.text].some((value) =>
            value.toLocaleLowerCase("ko-KR").includes(search),
          )),
    )
    .slice()
    .reverse();
}
function registeredAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "등록 시각 확인 필요"
    : new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date) + " 등록";
}
export function GuidedMaterials({
  company,
  locked,
  onReview,
}: {
  company: Pick<StudioCase, "id" | "sources">;
  locked: boolean;
  onReview: (source: SourceDocument) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MaterialFilter>("all");
  const [limit, setLimit] = useState(12);
  const pending = company.sources.filter(needsMaterialText).length;
  const filtered = filterMaterials(company.sources, query, filter);
  const shown = filtered.slice(0, limit);
  return (
    <section className={styles.library} aria-label="저장된 자료 목록">
      <div className={styles.libraryHeading}>
        <h3>저장된 자료 {company.sources.length}개</h3>
        <span>
          본문 있음 {company.sources.length - pending}개 · 본문 확인 필요 {pending}개
        </span>
      </div>
      {!company.sources.length ? (
        <p className={styles.empty}>
          아직 저장된 자료가 없습니다. 파일을 선택하면 첨부 카드로 표시됩니다.
        </p>
      ) : (
        <>
          <div className={styles.toolbar}>
            <label className={styles.search}>
              <Search aria-hidden="true" />
              <span className="sr-only">파일명·본문 검색</span>
              <input
                type="search"
                value={query}
                placeholder="파일명이나 본문으로 찾기"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(12);
                }}
              />
            </label>
            <label className={styles.filter}>
              <span className="sr-only">자료 상태 필터</span>
              <select
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value as MaterialFilter);
                  setLimit(12);
                }}
              >
                <option value="all">전체 자료</option>
                <option value="ready">본문 있음</option>
                <option value="pending">본문 확인 필요</option>
              </select>
            </label>
          </div>
          <p className={styles.help}>
            최근 등록순 · 검색·필터는 목록만 바꿉니다. AI에 보낼 자료는 다음 단계에서 별도로
            확인합니다.
          </p>
          <p role="status" className={styles.count}>
            검색 결과 {filtered.length}개 · 현재 {shown.length}개 표시
          </p>
          <ul className={styles.grid}>
            {shown.map((source) => (
              <AttachmentCard
                key={source.id}
                name={source.name}
                onOpen={() => onReview(source)}
                disabled={locked}
                state={needsMaterialText(source) ? "pending" : "ready"}
                label={
                  needsMaterialText(source)
                    ? source.originalName
                      ? "원본 보관 · 본문 확인 필요"
                      : "본문 확인 필요"
                    : "저장 완료 · 본문 있음"
                }
                meta={sourceKindLabels[source.kind] + " · " + registeredAt(source.createdAt)}
              >
                <p className={styles.preview}>
                  {needsMaterialText(source)
                    ? "아직 읽은 본문이 없습니다. 원본과 대조해 내용을 확인해 주세요."
                    : source.text.replace(/\s+/g, " ").trim().slice(0, 160)}
                </p>
                <span className={styles.help}>
                  {needsMaterialText(source)
                    ? "AI 본문 근거로 사용하기 전 확인 필요"
                    : "본문 일부 미리보기 · 사실 확인은 별도"}
                </span>
                <div className={styles.cardActions}>
                  <button type="button" disabled={locked} onClick={() => onReview(source)}>
                    본문 확인·고치기<span className="sr-only"> · {source.name}</span>
                  </button>
                  {source.originalName && (
                    <a href={`/api/studio/cases/${company.id}/sources/${source.id}`} download>
                      원본 내려받기<span className="sr-only"> · {source.name}</span>
                    </a>
                  )}
                </div>
              </AttachmentCard>
            ))}
          </ul>
          {!filtered.length && (
            <p className={styles.empty}>
              조건에 맞는 자료가 없습니다. 검색어나 상태 필터를 바꿔 주세요.
            </p>
          )}
          {shown.length < filtered.length && (
            <button
              className={styles.more}
              type="button"
              onClick={() => setLimit((count) => count + 12)}
            >
              자료 더 보기 ({filtered.length - shown.length}개 남음)
            </button>
          )}
        </>
      )}
    </section>
  );
}
export const attachmentGridClass = styles.grid;
