"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import {
  qualityExecutionNotice,
  type QualityExecutionPreparation,
  type QualityExecutionSnapshot,
} from "@/lib/studio-plan-quality-execution-types";
import { studioFetch, jsonBody } from "./shared";
import { qualityPost, QualityWriteRejection } from "./quality-evaluation-ui";
import {
  candidateRegistrySnapshot,
  candidateRegistryVersions,
} from "./quality-candidate-registry-ui";
import {
  qualityExecutionBase,
  qualityExecutionPreparation,
  qualityExecutionPending,
  qualityExecutionRecovery,
  qualityExecutionCommitted,
  qualityExecutionSnapshot,
  qualityExecutionList,
  qualityExecutionArchive,
  qualityExecutionUnsettled,
  qualityExecutionStateLabels,
  qualityExecutionCanRetry,
  type QualityExecutionPending,
} from "./quality-execution-ui";

const buttonClass = "h-auto min-h-11 min-w-0 max-w-full shrink whitespace-normal break-words py-2";
const noop = () => undefined;
type Prepared = { preparation: QualityExecutionPreparation; registry: CandidateRegistrySnapshot };
type Viewed = { snapshot: QualityExecutionSnapshot; registry: CandidateRegistrySnapshot };
export function QualityExecutionPanel({
  registry,
  blockedReason = "",
  onBusyChange = noop,
}: {
  registry: CandidateRegistrySnapshot | null;
  blockedReason?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [candidate, setCandidate] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const [startedPreparation, setStartedPreparation] = useState<string | null>(null);
  const [pending, setPending] = useState<QualityExecutionPending | null>(null);
  const [committedNonce, setCommittedNonce] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState<string | null>(null);
  const [viewed, setViewed] = useState<Viewed | null>(null);
  const [history, setHistory] = useState<QualityExecutionSnapshot[] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(false),
    busy = useRef(false),
    pendingRef = useRef<QualityExecutionPending | null>(null);
  const historySequence = useRef(0),
    preparedRef = useRef<Prepared | null>(null);
  const retryRef = useRef<string | null>(null),
    committedRef = useRef<string | null>(null);
  const candidateId = registry?.entries.some((entry) => entry.candidateId === candidate)
    ? candidate
    : "";
  const preparedCurrent =
    !!prepared &&
    prepared.registry.versionDigest === registry?.versionDigest &&
    prepared.preparation.candidateId === candidateId;
  const locked = working || !!pending || !!blockedReason;
  const ownsDraft = working || !!pending || !!prepared;

  useEffect(() => {
    mounted.current = true;
    const sequence = ++historySequence.current;
    return () => {
      mounted.current = false;
      historySequence.current = sequence + 1;
    };
  }, []);
  useEffect(() => {
    onBusyChange(ownsDraft);
    return () => onBusyChange(false);
  }, [ownsDraft, onBusyChange]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (busy.current || pendingRef.current || preparedRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (
        !link ||
        link.getAttribute("href")?.startsWith("#") ||
        (link.hasAttribute("download") && link.getAttribute("href")?.startsWith("blob:"))
      )
        return;
      if (busy.current || pendingRef.current || preparedRef.current) {
        event.preventDefault();
        setError("모의 요청의 기록을 확인하거나 준비안을 닫은 뒤 이동해 주세요.");
      }
    };
    window.addEventListener("beforeunload", prevent);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", prevent);
      document.removeEventListener("click", navigate, true);
    };
  }, []);
  async function work(action: () => Promise<void>) {
    if (busy.current || blockedReason) return;
    busy.current = true;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (caught) {
      if (mounted.current)
        setError(caught instanceof Error ? caught.message : "모의 기록을 확인하지 못했습니다.");
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function refreshList() {
    const sequence = ++historySequence.current;
    const values = await qualityExecutionList(await studioFetch<unknown>(qualityExecutionBase));
    if (mounted.current && sequence === historySequence.current) setHistory(values);
  }
  async function prepare() {
    if (!registry || !candidateId || locked || prepared || pendingRef.current) return;
    const selected = structuredClone(registry),
      id = candidateId;
    await work(async () => {
      const value = await qualityExecutionPreparation(
        await studioFetch<unknown>(`${qualityExecutionBase}/prepare`, {
          method: "POST",
          ...jsonBody({ version: selected.version, candidateId: id }),
        }),
        selected,
        id,
      );
      if (!mounted.current) return;
      const draft = { preparation: value, registry: selected };
      preparedRef.current = draft;
      setPrepared(draft);
      setAcknowledged(null);
      setStartedPreparation(null);
      setMessage(
        "선택한 후보 한 개의 무료 모의 연결 시험 준비안을 만들었습니다. 아직 실행하지 않았습니다.",
      );
    });
  }
  async function recover(waiting: QualityExecutionPending) {
    retryRef.current = null;
    setRetryNonce(null);
    const receipt = await qualityExecutionRecovery(
      await studioFetch<unknown>(
        `${qualityExecutionBase}/requests/${waiting.request.clientRequestId}`,
      ),
      waiting,
    );
    if (!mounted.current || pendingRef.current !== waiting) return;
    if (receipt.state === "not-observed") {
      if (committedRef.current !== waiting.request.clientRequestId) {
        retryRef.current = waiting.request.clientRequestId;
        setRetryNonce(waiting.request.clientRequestId);
      }
      setMessage(
        "아직 이 요청의 시작 기록이 보이지 않습니다. 미접수 확정은 아닙니다. 다시 조회하거나 동일 요청의 저장 재확인을 직접 선택해 주세요.",
      );
      return;
    }
    setCommittedNonce(waiting.request.clientRequestId);
    committedRef.current = waiting.request.clientRequestId;
    const snapshot = await qualityExecutionCommitted(
      await studioFetch<unknown>(`${qualityExecutionBase}/${receipt.receipt.executionId}`),
      waiting,
      receipt.receipt,
    );
    if (!mounted.current || pendingRef.current !== waiting) return;
    pendingRef.current = null;
    setPending(null);
    setViewed({ snapshot, registry: waiting.registry });
    setStartedPreparation(waiting.request.preparation.planDigest);
    setAcknowledged(null);
    setMessage(
      qualityExecutionUnsettled(snapshot)
        ? "실행 시작 기록을 확인했습니다. 결과는 아직 확정되지 않았으며 자동으로 재개하지 않습니다. 기록을 다시 조회하거나 준비안을 닫을 수 있습니다."
        : `${qualityExecutionStateLabels[snapshot.state]}. 실제 AI 성능이나 품질 합격 결과는 아닙니다.`,
    );
    await refreshList();
  }
  async function write(waiting: QualityExecutionPending, retry = false) {
    if (
      retry &&
      !qualityExecutionCanRetry(
        waiting.request.clientRequestId,
        retryRef.current,
        committedRef.current,
      )
    )
      return;
    if (committedRef.current === waiting.request.clientRequestId) return recover(waiting);
    retryRef.current = null;
    setRetryNonce(null);
    pendingRef.current = waiting;
    setPending(waiting);
    try {
      await qualityPost(qualityExecutionBase, waiting.request);
    } catch (caught) {
      if (caught instanceof QualityWriteRejection && caught.accepted === false) {
        pendingRef.current = null;
        if (mounted.current) {
          setPending(null);
          setAcknowledged(null);
          setMessage(
            "서버가 시작 요청을 거절했습니다. 준비안은 보존했습니다. 닫은 뒤 최신 조건으로 다시 준비해 주세요.",
          );
        }
      }
      throw caught;
    }
    await recover(waiting);
  }
  async function start() {
    if (
      !prepared ||
      !preparedCurrent ||
      locked ||
      acknowledged !== prepared.preparation.planDigest ||
      pendingRef.current ||
      startedPreparation === prepared.preparation.planDigest
    )
      return;
    const waiting = qualityExecutionPending(
      prepared.preparation,
      prepared.registry,
      crypto.randomUUID(),
    );
    setCommittedNonce(null);
    committedRef.current = null;
    await work(() => write(waiting));
  }
  function closePreparation() {
    if (locked || pendingRef.current) return;
    preparedRef.current = null;
    setPrepared(null);
    setAcknowledged(null);
    setStartedPreparation(null);
    setMessage("준비안을 닫았습니다. 저장된 실행 기록은 이력에서 계속 확인할 수 있습니다.");
  }
  async function openRecord(item: QualityExecutionSnapshot, revision?: number) {
    if (locked || pendingRef.current) return;
    await work(async () => {
      const registered = await candidateRegistrySnapshot(
        await studioFetch<unknown>(`${candidateRegistryVersions}/${item.run.preparation.version}`),
        {
          version: item.run.preparation.version,
          versionDigest: item.run.preparation.versionDigest,
        },
      );
      const value = await qualityExecutionSnapshot(
        await studioFetch<unknown>(
          `${qualityExecutionBase}/${item.run.id}${revision === undefined ? "" : `/revisions/${revision}`}`,
        ),
        registered,
        { id: item.run.id, ...(revision === undefined ? {} : { revision }) },
      );
      if (mounted.current) setViewed({ snapshot: value, registry: registered });
    });
  }
  async function download() {
    if (!viewed || locked || pendingRef.current) return;
    const selected = viewed;
    await work(async () => {
      const { snapshot } = selected;
      const file = await qualityExecutionArchive(
        await fetch(
          `${qualityExecutionBase}/${snapshot.run.id}/revisions/${snapshot.revision}/download`,
          { cache: "no-store" },
        ),
        snapshot,
        selected.registry,
      );
      if (!mounted.current) return;
      const url = URL.createObjectURL(file.blob),
        link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`실행 기록 r${snapshot.revision} JSON 내려받기를 요청했습니다.`);
    });
  }
  const started = !!prepared && startedPreparation === prepared.preparation.planDigest;
  return (
    <section
      aria-label="후보 모의 연결 시험"
      aria-busy={working}
      className="min-w-0 space-y-4 rounded-xl border border-blue-200 bg-blue-50/30 p-4 sm:p-5"
    >
      <header className="space-y-2">
        <h3 className="font-semibold">등록 후보 한 개 · 무료 모의 연결 시험</h3>
        <p className="text-sm leading-6">
          {qualityExecutionNotice} 생성·검토 연결을 최대 2회 시험하며 실제 AI 호출은 0회, 비용은
          0원입니다.
        </p>
      </header>
      {blockedReason && <p className="text-sm text-amber-900">{blockedReason}</p>}
      {error && (
        <p
          role="alert"
          className="break-words rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm"
        >
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="break-words rounded-xl border p-3 text-sm">
          {message}
        </p>
      )}
      {!registry ? (
        <p className="text-sm">위의 고정된 등록 버전을 열면 후보를 선택할 수 있습니다.</p>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-2 text-sm">
            <span>시험할 후보 · 등록 v{registry.version}</span>
            <select
              aria-label="모의 시험 후보"
              className="min-h-11 w-full min-w-0 max-w-full rounded-lg border bg-white px-3"
              value={candidateId}
              disabled={locked || !!prepared}
              onChange={(event) => setCandidate(event.target.value)}
            >
              <option value="">후보 한 개 선택</option>
              {registry.entries.map((entry) => (
                <option key={entry.candidateId} value={entry.candidateId}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            className={buttonClass}
            variant="outline"
            disabled={locked || !!prepared || !candidateId}
            onClick={() => void prepare()}
          >
            모의 시험 준비안 확인
          </Button>
        </div>
      )}
      {prepared && (
        <div className="space-y-3 rounded-xl border bg-white p-4">
          <p className="font-medium break-words">
            등록 v{prepared.preparation.version} · {prepared.preparation.label}
          </p>
          <p className="text-sm leading-6">
            이 버전의 기업정보·자료 본문·신청 주제와 생성 초안만 사용합니다. 검토자 메모는
            제외합니다. 제공자: 로컬 모의 공급자 · 최대 2회 · 비용 0원 · 실제 AI 실행 불가.
          </p>
          {!preparedCurrent && (
            <p className="text-sm text-amber-900">
              현재 선택과 다른 준비안을 보존했습니다. 시작하지 않고 닫은 뒤 다시 준비해 주세요.
            </p>
          )}
          {!started && (
            <>
              <label className="flex min-h-11 items-start gap-3 text-sm leading-6">
                <input
                  className="mt-1 size-4 shrink-0"
                  type="checkbox"
                  disabled={locked || !preparedCurrent}
                  checked={acknowledged === prepared.preparation.planDigest}
                  onChange={(event) =>
                    setAcknowledged(event.target.checked ? prepared.preparation.planDigest : null)
                  }
                />
                <span>
                  선택한 후보로 0원 모의 연결 시험을 합니다. 실제 AI 작성·검토나 품질 평가가 아님을
                  확인했습니다.
                </span>
              </label>
              <Button
                className={buttonClass}
                disabled={
                  locked || !preparedCurrent || acknowledged !== prepared.preparation.planDigest
                }
                onClick={() => void start()}
              >
                확인한 모의 시험 시작
              </Button>
            </>
          )}
          <Button
            className={buttonClass}
            variant="outline"
            disabled={locked}
            onClick={closePreparation}
          >
            {started ? "기록 보관하고 준비안 닫기" : "모의 시험 준비 취소"}
          </Button>
        </div>
      )}
      {pending && (
        <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h4 className="font-semibold">모의 요청 기록 확인 필요</h4>
          <p className="text-sm leading-6">
            {committedNonce === pending.request.clientRequestId
              ? "시작 영수증을 확인했습니다. 정확한 실행 기록을 조회하고 있으며, 시작 요청을 다시 보내지 않습니다."
              : "요청 번호와 내용을 보존했습니다. 자동 재전송하지 않습니다. 아래 재확인은 같은 번호와 내용만 사용합니다."}
          </p>
          <p className="break-all text-xs">{pending.request.clientRequestId}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              className={buttonClass}
              disabled={working || !!blockedReason}
              onClick={() => void work(() => recover(pending))}
            >
              모의 요청 상태 조회
            </Button>
            <Button
              className={buttonClass}
              variant="outline"
              disabled={
                working ||
                !!blockedReason ||
                !qualityExecutionCanRetry(
                  pending.request.clientRequestId,
                  retryNonce,
                  committedNonce,
                )
              }
              onClick={() => void work(() => write(pending, true))}
            >
              동일 요청으로 저장 재확인
            </Button>
          </div>
        </div>
      )}
      <section className="space-y-3" aria-label="모의 실행 이력">
        <div className="flex flex-wrap items-center gap-3">
          <h4 className="font-semibold">모의 실행 이력</h4>
          <Button
            className={buttonClass}
            variant="outline"
            disabled={locked}
            onClick={() => void work(refreshList)}
          >
            실행 이력 읽기
          </Button>
        </div>
        {history === null ? (
          <p className="text-sm">이력을 읽으면 이전 모의 기록을 확인할 수 있습니다.</p>
        ) : !history.length ? (
          <p className="text-sm">마지막 조회에서는 실행 이력이 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {history.map((item) => (
              <Button
                key={item.run.id}
                className={`${buttonClass} w-full justify-start text-left`}
                variant="outline"
                disabled={locked}
                onClick={() => void openRecord(item)}
              >
                v{item.run.preparation.version} · {item.run.preparation.label} ·{" "}
                {qualityExecutionStateLabels[item.state]}
              </Button>
            ))}
          </div>
        )}
      </section>
      {viewed && (
        <section
          className="space-y-3 rounded-xl border bg-white p-4"
          aria-label="선택한 모의 실행 기록"
        >
          <h4 className="font-semibold break-words">
            {viewed.snapshot.run.preparation.label} · 기록 r{viewed.snapshot.revision}
          </h4>
          <p className="text-sm">
            {qualityExecutionStateLabels[viewed.snapshot.state]} · 모의 요청{" "}
            {viewed.snapshot.dispatchCount}/2 · 응답 {viewed.snapshot.responseCount}/2
          </p>
          {qualityExecutionUnsettled(viewed.snapshot) && (
            <p className="text-sm text-amber-900">
              실행 시작 기록은 보관됐습니다. 결과를 확정하거나 자동으로 재개하지 않습니다. 조회만
              가능합니다.
            </p>
          )}
          <p className="break-all text-xs text-muted-foreground">
            실행 번호 {viewed.snapshot.run.id} · 시작 {viewed.snapshot.run.authorizedAt}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              className={buttonClass}
              variant="outline"
              disabled={locked}
              onClick={() => void openRecord(viewed.snapshot)}
            >
              이 실행 최신 기록 조회
            </Button>
            <Button
              className={buttonClass}
              variant="outline"
              disabled={locked}
              onClick={() => void download()}
            >
              이 기록 JSON 내려받기
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: viewed.snapshot.revision + 1 }, (_, revision) => (
              <Button
                key={revision}
                className={buttonClass}
                variant="outline"
                disabled={locked}
                onClick={() => void openRecord(viewed.snapshot, revision)}
              >
                기록 r{revision}
              </Button>
            ))}
          </div>
          <details className="min-w-0">
            <summary className="cursor-pointer text-sm">모의 출력·검토 기록 보기</summary>
            <p className="my-2 text-xs">
              자료 정리로 만든 모의 출력입니다. 실제 AI 원고나 제출용 계획서가 아닙니다.
            </p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-xs [overflow-wrap:anywhere]">
              {JSON.stringify(viewed.snapshot.output, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </section>
  );
}
