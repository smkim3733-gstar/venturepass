"use client";
import { useLayoutEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StudioCase } from "@/lib/studio-schema";
import { readManualPublicEvidence } from "@/lib/studio-public-evidence-export";
import {
  publicClaimComparisonRequestCommandSchema,
  publicClaimComparisonRequestVersion,
} from "@/lib/studio-public-claim-comparison-request-types";
import { publicClaimPreviewResponse, type PublicClaimPreviewView } from "./public-claim-preview-ui";
import { Notice, selectClass, studioFetch, jsonBody } from "./shared";

export function PublicClaimPreview({
  company,
  blocked,
}: {
  company: StudioCase;
  blocked: boolean;
}) {
  const id = useId(),
    [open, setOpen] = useState(false),
    [recordId, setRecordId] = useState(""),
    [sourceIds, setSourceIds] = useState<string[]>([]),
    [model, setModel] = useState("");
  const [view, setView] = useState<(PublicClaimPreviewView & { snapshot: StudioCase }) | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null),
    latest = useRef({ company, blocked });
  useLayoutEffect(() => {
    latest.current = { company, blocked };
    return () => {
      pending.current?.abort();
      pending.current = null;
      // The canceled request no longer owns pending, so its finally cannot release busy.
      setBusy(false);
    };
  }, [company, blocked]);
  const record = (company.claimReviews ?? []).find((r) => r.id === recordId);
  function clear() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setView(null);
    setError("");
  }
  async function preview() {
    if (!open || blocked || pending.current || !record) return;
    setView(null);
    setError("");
    const parsed = publicClaimComparisonRequestCommandSchema.safeParse({
      requestVersion: publicClaimComparisonRequestVersion,
      model,
      selection: {
        companyId: company.id,
        companyRevision: company.revision,
        claimRecordId: record.id,
        claimVersion: record.version,
        claimInputDigest: record.inputDigest,
        sourceIds,
      },
    });
    if (!parsed.success) {
      setError("주장·공개 근거 1~10개와 모델 식별자를 직접 선택·입력해 주세요.");
      return;
    }
    const command = parsed.data,
      snapshot = company,
      controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const raw = await studioFetch<unknown>(
        "/api/studio/cases/" + company.id + "/public-claim-comparison/preview",
        { method: "POST", ...jsonBody(command), signal: controller.signal },
      );
      const checked = await publicClaimPreviewResponse(raw, snapshot, command);
      if (
        pending.current !== controller ||
        controller.signal.aborted ||
        latest.current.company !== snapshot ||
        latest.current.blocked
      )
        return;
      setView({ ...checked, snapshot });
    } catch {
      if (pending.current === controller && !controller.signal.aborted)
        setError(
          "미리보기를 만들지 못했습니다. 원래 주장·자료 버전과 선택 범위를 확인해 주세요. 자동으로 다시 요청하지 않습니다.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <details
      className="min-w-0 rounded-xl border p-4"
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        if (!next) clear();
      }}
    >
      <summary className="cursor-pointer font-semibold">
        공개 근거 비교 입력 미리보기 (선택)
      </summary>
      <div className="mt-4 min-w-0 space-y-4">
        <Notice>
          저장 주장과 선택한 공개 발췌를 이 PC에서 확인합니다. AI 전송·비용 발생·자료 저장은 하지
          않습니다. 새 예약과 기존 예약 실행은 아래의 별도 화면에서 진행합니다.
        </Notice>
        <fieldset disabled={blocked} className="min-w-0 space-y-3">
          <label className="block space-y-1" htmlFor={id + "-claim"}>
            <span>비교할 저장 주장 버전</span>
            <select
              id={id + "-claim"}
              className={selectClass}
              value={recordId}
              onChange={(e) => {
                clear();
                setRecordId(e.target.value);
                setSourceIds([]);
              }}
            >
              <option value="">직접 선택하세요</option>
              {[...(company.claimReviews ?? [])].reverse().map((r) => (
                <option key={r.id} value={r.id}>
                  v{r.version} · {r.claimQuote}
                </option>
              ))}
            </select>
          </label>
          {record && (
            <div className="min-w-0 space-y-2">
              <p className="text-sm">
                비교할 공개 근거를 직접 선택하세요. 형식이 지원돼도 현재 버전·본문은 미리보기 때
                다시 대조합니다.
              </p>
              {record.references.map((ref) => {
                const source = company.sources.find((s) => s.id === ref.sourceId),
                  draft = source && readManualPublicEvidence(source);
                const supported = Boolean(
                  draft && source?.originalName === null && source?.mimeType === null,
                );
                return (
                  <label
                    key={ref.sourceId}
                    className="flex min-w-0 items-start gap-2 text-sm [overflow-wrap:anywhere]"
                  >
                    <input
                      type="checkbox"
                      checked={sourceIds.includes(ref.sourceId)}
                      disabled={
                        !supported || (!sourceIds.includes(ref.sourceId) && sourceIds.length >= 10)
                      }
                      onChange={(e) => {
                        clear();
                        setSourceIds(
                          e.target.checked
                            ? [...sourceIds, ref.sourceId]
                            : sourceIds.filter((id) => id !== ref.sourceId),
                        );
                      }}
                    />
                    <span>
                      {source?.name ?? ref.sourceId}
                      {!supported && " · 수동 공개 발췌 형식 미지원"}
                    </span>
                  </label>
                );
              })}
              <p className="text-xs text-muted-foreground">
                선택 {sourceIds.length}개 / 제외 {record.references.length - sourceIds.length}개.
                제외 자료는 ID만 포함합니다.
              </p>
            </div>
          )}
          <label className="block space-y-1" htmlFor={id + "-model"}>
            <span>미리보기 모델 식별자</span>
            <Input
              id={id + "-model"}
              value={model}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => {
                clear();
                setModel(e.target.value);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            모델 지원 여부·토큰·비용은 확인하지 않습니다. 키나 URL을 입력하지 마세요.
          </p>
          <Button
            type="button"
            disabled={busy || !record || !sourceIds.length || !model}
            onClick={() => void preview()}
          >
            {busy ? "로컬 미리보기 확인 중" : "선택 입력 미리보기"}
          </Button>
        </fieldset>
        {blocked && <Notice>원고·주장 편집 또는 저장을 마친 뒤 선택해 주세요.</Notice>}
        {error && (
          <div role="alert">
            <Notice tone="warning">{error}</Notice>
          </div>
        )}
        {view && view.snapshot === company && !blocked && <PublicClaimPreviewResult view={view} />}
      </div>
    </details>
  );
}
export function PublicClaimPreviewResult({
  view,
  reserved = false,
}: {
  view: PublicClaimPreviewView;
  reserved?: boolean;
}) {
  const { prepared: p, preview: r } = view;
  const text = "whitespace-pre-wrap text-sm [overflow-wrap:anywhere]";
  return (
    <section
      aria-label="공개 주장 비교 입력 미리보기"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-xl border p-3"
    >
      <Notice>
        수동 공개 근거·미검증 입력입니다. 사실 확인·출처 진위·회사 해당성을 확인한 결과가 아닙니다.
        {reserved
          ? "이 예약의 입력·응답 보관 범위는 위의 보관 안내를 따릅니다."
          : "이 내용은 현재 창에만 남습니다."}
      </Notice>
      <p className={text}>주장: {p.input.claimQuote}</p>
      <p className={text}>
        회사 {p.selection.companyId} · revision {p.selection.companyRevision} · 주장 v
        {p.selection.claimVersion} ({p.selection.claimRecordId})
      </p>
      <p className={text}>
        모델 {r.command.model} · 계약 {r.command.requestVersion}
      </p>
      <p className={text}>
        선택 {p.input.selectedEvidence.length}개 · 제외 {p.input.excludedSourceIds.length}개{"\n"}
        제외 ID: {p.input.excludedSourceIds.join(", ") || "없음"}
      </p>
      <div>
        <h4 className="font-semibold">포함되는 항목 전체 문맥 · {p.input.section.title}</h4>
        <p className={text}>{p.input.section.content}</p>
      </div>
      {p.input.selectedEvidence.map((s) => (
        <article key={s.sourceId} className="min-w-0 space-y-2 rounded-lg border p-3">
          <h4 className={text}>{s.metadata.title}</h4>
          <p className={text}>
            자료 ID {s.sourceId} · 보관 시각 {s.sourceUpdatedAt}
          </p>
          <p className={text}>
            수동 URL: {s.metadata.url}
            {"\n"}발행처: {s.metadata.publisher || "미확인"}
            {"\n"}발행일: {s.metadata.publishedOn || "미확인"}
            {"\n"}기준 기간: {s.metadata.period || "미확인"}
            {"\n"}담당자 읽은 날짜: {s.metadata.readOn}
            {"\n"}보완 항목: {s.metadata.sectionKey || "미지정"}
          </p>
          <p className={text}>
            원래 연결 인용: {s.originalReference.quote}
            {"\n"}위치: {s.originalReference.locator}
          </p>
          <h5 className="text-sm font-semibold">선택 발췌 전체</h5>
          <p className={text}>{s.excerpt}</p>
          <p className={text}>
            담당자 관련성 메모: {s.manualNotes.relevance || "없음"}
            {"\n"}상충 메모: {s.manualNotes.conflicts || "없음"}
          </p>
        </article>
      ))}
      <p className={text}>
        준비 내용 {r.sizes.preparationPayloadCharacters}자 · 메시지{" "}
        {r.sizes.messageContentCharacters}자{"\n"}전체 요청 JSON {r.sizes.requestCharacters}자 /
        UTF-8 {r.sizes.requestUtf8Bytes}바이트{"\n"}문자는 UTF-16 단위이며 토큰·비용·모델 적합성은
        미확인입니다.
      </p>
      <details className="min-w-0">
        <summary className="cursor-pointer text-sm">요청 원문·대조 정보</summary>
        <p className={text}>
          요청 SHA-256 {r.identity.rawBodySha256}
          {"\n"}정규화 digest {r.identity.requestDigest}
        </p>
        <pre className={text}>{r.rawBody}</pre>
      </details>
    </section>
  );
}
