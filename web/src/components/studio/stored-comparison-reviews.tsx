"use client";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { StudioCase } from "@/lib/studio-schema";
import type {
  StoredReviewCatalog,
  StoredReviewCatalogEntry,
} from "@/lib/studio-comparison-review-catalog";
import {
  createStoredReviewRequest,
  fetchStoredReviewCatalog,
} from "@/lib/studio-comparison-review-http";
import { useComparisonReviewScreen } from "@/lib/studio-public-claim-comparison-review-react";
import { useStoredComparison } from "./stored-comparison-provider";
import { ComparisonReviewOpinion } from "./comparison-review-opinion";
import { Notice, selectClass } from "./shared";
import { comparisonPlanTarget } from "@/lib/studio-comparison-plan-reference";
import type { ComparisonPlanReview } from "@/lib/studio-comparison-plan-reference";

type EditComparisonPlan = (
  result: ComparisonPlanReview,
  isCurrent: () => boolean,
) => Promise<boolean>;

type Screen = NonNullable<ReturnType<typeof useStoredComparison>["screen"]>;
function SelectedReview({
  screen,
  company,
  entry,
  onEditComparisonPlan,
}: {
  screen: Screen;
  company: StudioCase;
  entry: StoredReviewCatalogEntry;
  onEditComparisonPlan?: EditComparisonPlan;
}) {
  const [mode, setMode] = useState<"historical" | "inspect-current">("historical");
  const id = useId();
  const frame = {
    snapshot: company,
    expected: {
      runId: entry.runId,
      dispatchCommandDigest: entry.dispatchCommandDigest,
      mode,
      selection: entry.selection,
      binding: entry.binding,
      sectionKey: entry.sectionKey,
    },
    open: true,
    blocked: false,
    dirty: false,
    aborted: false,
  };
  const review = useComparisonReviewScreen(screen, frame);
  const [message, setMessage] = useState("");
  const [opening, setOpening] = useState(false);
  const result = review.display?.kind === "result" ? review.display.result : null;
  const navigationResult = useRef<ComparisonPlanReview | null>(null);
  useLayoutEffect(() => {
    navigationResult.current = review.canForget && mode === "inspect-current" ? result : null;
    return () => {
      navigationResult.current = null;
    };
  }, [result, review.canForget, mode, company, entry]);
  function read() {
    const query = { runId: entry.runId, dispatchCommandDigest: entry.dispatchCommandDigest, mode };
    const started = review.read({
      signal: new AbortController().signal,
      startRequest: createStoredReviewRequest(
        window.location.origin,
        company,
        query,
        window.fetch.bind(window),
      ),
    });
    setMessage(started.ok ? "" : "이전 읽기가 끝난 뒤 다시 시도해 주세요.");
  }
  return (
    <section aria-label="보관 비교 결과" className="min-w-0 space-y-3">
      <p className="whitespace-pre-wrap break-words text-sm">보관 주장: {entry.claimQuote}</p>
      <label htmlFor={id} className="block text-sm font-medium">
        조회 범위
      </label>
      <select
        id={id}
        className={selectClass}
        value={mode}
        onChange={(e) => setMode(e.target.value as typeof mode)}
      >
        <option value="historical">보관 당시 결과 보기</option>
        <option value="inspect-current">현재 회사·원고 연결도 확인</option>
      </select>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={read} disabled={!review.canPrepare}>
          선택한 비교 결과 읽기
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!review.occupied || review.canForget}
          onClick={() => review.cancel()}
        >
          읽기 취소
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!review.occupied || !review.canForget}
          onClick={() => {
            review.release();
            setMessage("");
          }}
        >
          표시 비우기
        </Button>
      </div>
      <p role="status" className="text-sm" aria-live="polite">
        {review.occupied && !review.canForget
          ? "비교 결과를 읽거나 이전 요청의 종료 상태를 확인 중입니다. 자동 재조회하지 않습니다."
          : result
            ? "보관 결과를 읽었습니다."
            : message}
      </p>
      {review.display?.kind === "error" && <p role="alert">{review.display.message}</p>}
      {result && (
        <Notice>
          보관 당시 의견입니다. 현재 연결:{" "}
          {
            {
              "not-checked": "확인하지 않음",
              "exact-original-request": "원래 요청과 일치",
              changed: "변경됨",
              unavailable: "확인할 수 없음",
            }[result.current.status]
          }
          . 사실 확인 완료나 기관 적합성을 의미하지 않습니다.
        </Notice>
      )}
      <ComparisonReviewOpinion result={result} />
      {result && onEditComparisonPlan && (
        <div className="space-y-2">
          <p className="text-sm">
            현재 회사·원고 연결이 일치하는 의견만 원래 원고 항목과 함께 볼 수 있습니다. 수정할
            문장과 저장은 직접 결정하세요.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={opening || !review.canForget || !comparisonPlanTarget(company, result)}
            onClick={async () => {
              if (opening || !review.canForget || !comparisonPlanTarget(company, result)) return;
              setOpening(true);
              try {
                const opened = await onEditComparisonPlan(
                  result,
                  () => navigationResult.current === result,
                );
                setMessage(
                  opened
                    ? ""
                    : "원고 연결을 다시 확인해 주세요. 편집 내용과 원고는 변경하지 않았습니다.",
                );
              } catch {
                setMessage("원고 연결을 확인하지 못했습니다. 현재 연결을 다시 조회해 주세요.");
              } finally {
                setOpening(false);
              }
            }}
          >
            {opening ? "원고 연결 확인 중" : "이 의견을 보며 원고 보완"}
          </Button>
          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
export function StoredComparisonReviews({
  company,
  blocked,
  onEditComparisonPlan,
}: {
  company: StudioCase;
  blocked: boolean;
  onEditComparisonPlan?: EditComparisonPlan;
}) {
  const id = useId(),
    owner = useStoredComparison();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [catalog, setCatalog] = useState<{
    snapshot: StudioCase;
    data: StoredReviewCatalog;
  } | null>(null);
  const [selected, setSelected] = useState("");
  const pending = useRef<AbortController | null>(null),
    latest = useRef({ company, blocked, open });
  useLayoutEffect(() => {
    latest.current = { company, blocked, open };
    return () => {
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
      setCatalog(null);
      setSelected("");
      setMessage("");
    };
  }, [company, blocked, open]);
  async function load() {
    if (pending.current || blocked || !open) return;
    owner.open();
    setCatalog(null);
    setSelected("");
    setMessage("");
    setBusy(true);
    const snapshot = company,
      controller = new AbortController();
    pending.current = controller;
    try {
      const data = await fetchStoredReviewCatalog(snapshot, controller.signal);
      if (
        pending.current === controller &&
        latest.current.company === snapshot &&
        !latest.current.blocked &&
        latest.current.open
      )
        setCatalog({ snapshot, data });
    } catch (error) {
      if (pending.current === controller && !controller.signal.aborted)
        setMessage(
          error instanceof Error && error.message === "NOT_CONFIGURED"
            ? "보관 비교 조회 연결이 설정되지 않았습니다. 서버의 기존 비교 저장소 설정이 필요합니다."
            : error instanceof Error && error.message === "CLEANUP_REQUIRED"
              ? "이전 조회 연결의 정리가 필요합니다. 조회 연결 정리를 누른 뒤 목록을 다시 불러오세요."
              : "보관 목록을 확인하지 못했습니다. 회사와 저장 기록을 확인한 뒤 다시 불러오세요.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function cleanup() {
    if (pending.current || blocked) return;
    const snapshot = company,
      controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/studio/cases/${company.id}/public-claim-comparison/stored-reviews`,
        {
          method: "DELETE",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        },
      );
      if (pending.current === controller && latest.current.company === snapshot)
        setMessage(
          response.ok
            ? owner.screen?.getSnapshot().state.occupied &&
              !owner.screen.getSnapshot().state.canForget
              ? "서버 조회 연결은 정리됐지만 이 창에서 이전 읽기의 종료를 확인하지 못했습니다. 앱을 새로고침한 뒤 다시 선택해 주세요."
              : "조회 연결을 정리했습니다. 목록을 다시 불러오세요."
            : "조회 연결 정리를 마치지 못했습니다. 원래 요청을 보관합니다.",
        );
    } catch {
      if (pending.current === controller && !controller.signal.aborted)
        setMessage("정리 상태를 확인하지 못했습니다.");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const current = open && !blocked && catalog?.snapshot === company ? catalog.data : null;
  const entry = current?.reviews.find((r) => r.runId === selected);
  return (
    <details
      className="min-w-0 rounded-xl border p-4"
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (!e.currentTarget.open) {
          pending.current?.abort();
          pending.current = null;
          setBusy(false);
          setCatalog(null);
          setSelected("");
          setMessage("");
        }
      }}
    >
      <summary className="cursor-pointer font-semibold">보관된 공개 근거 비교 결과 (선택)</summary>
      <div className="mt-4 min-w-0 space-y-4" aria-busy={busy}>
        <Notice>
          이 PC에 보관된 비교 의견을 읽습니다. 새 AI 실행·사실 확인·원고 수정·비용 정산은 하지
          않습니다.
        </Notice>
        {blocked && <Notice>편집 또는 저장을 마친 뒤 확인해 주세요.</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={blocked || busy} onClick={() => void load()}>
            {busy ? "조회 상태 확인 중" : "보관 비교 목록 불러오기"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={blocked || busy}
            onClick={() => void cleanup()}
          >
            조회 연결 정리
          </Button>
        </div>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        {current &&
          (current.reviews.length === 0 ? (
            <p role="status">이 회사의 보관된 비교 결과가 없습니다.</p>
          ) : (
            <>
              <label htmlFor={id} className="block text-sm font-medium">
                확인할 보관 결과
              </label>
              <select
                id={id}
                className={selectClass}
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">직접 선택하세요</option>
                {current.reviews.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    원고 v{r.binding.planVersion} · 주장 v{r.selection.claimVersion} ·{" "}
                    {r.sectionTitle} · {r.claimQuote.slice(0, 80)}
                  </option>
                ))}
              </select>
            </>
          ))}
        {entry && owner.screen && (
          <SelectedReview
            screen={owner.screen}
            company={company}
            entry={entry}
            onEditComparisonPlan={onEditComparisonPlan}
          />
        )}
      </div>
    </details>
  );
}
