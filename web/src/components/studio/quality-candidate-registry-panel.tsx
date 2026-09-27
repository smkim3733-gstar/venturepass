"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  candidateRegistryLimits,
  candidateRegistryNotice,
  type CandidateRegistryCatalog,
  type CandidateRegistrySnapshot,
  type CandidateRegistrySource,
  type CandidateRegistrySummary,
} from "@/lib/studio-plan-quality-candidate-registry-types";
import { studioFetch } from "./shared";
import { qualityPost, QualityWriteRejection } from "./quality-evaluation-ui";
import { QualityExecutionPanel } from "./quality-execution-panel";
import { QualityActualPreparationPanel } from "./quality-actual-preparation-panel";
import { QualityProviderReviewPanel } from "./quality-provider-review-panel";
import {
  candidateRegistryArchive,
  candidateRegistryBase,
  candidateRegistryCatalog,
  candidateRegistryCatalogLabels,
  candidateRegistryCommitted,
  candidateRegistryPending,
  candidateRegistryRecovery,
  candidateRegistrySnapshot,
  candidateRegistryVersions,
  type CandidateRegistryPending,
} from "./quality-candidate-registry-ui";

const buttonClass = "h-auto min-h-11 min-w-0 max-w-full shrink whitespace-normal break-words py-2";
const sectors = { manufacturing: "제조", software: "소프트웨어", service: "서비스" };
const noop = () => undefined;

export function QualityCandidateContents({
  source,
  label,
}: {
  source: CandidateRegistrySource;
  label: string;
}) {
  return (
    <section aria-label={label} className="min-w-0 space-y-3">
      <h3 className="font-semibold">
        {label} · {source.entries.length}개
      </h3>
      <p className="text-xs leading-6 text-muted-foreground">
        입력 자료와 신청 주제는 검토자 메모와 구분되어 있습니다. 아래 내용은 조회용이며 생성 모델로
        보내지 않습니다.
      </p>
      {source.entries.map((entry) => (
        <details key={entry.candidateId} className="min-w-0 rounded-xl border p-3">
          <summary className="cursor-pointer break-words text-sm leading-6 [overflow-wrap:anywhere]">
            {entry.label} · {sectors[entry.reviewerMetadata.sector]} ·{" "}
            {entry.reviewerMetadata.applicationKind === "new" ? "신규" : "재확인"}
          </summary>
          <p className="mt-3 text-xs text-muted-foreground">
            AI 작성 합성 후보 · 사람 정답표 없음 · 독립성 미확정 · 성능 미평가
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm">입력 자료·신청 주제 원문</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-xs [overflow-wrap:anywhere]">
              {JSON.stringify(entry.input, null, 2)}
            </pre>
          </details>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm">검토자용 구성 의도·작성자 메모</summary>
            <p className="mt-2 text-xs leading-6">
              정답표나 성능 판정이 아닙니다. 모델 입력과 분리된 검토용 정보입니다.
            </p>
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-xs [overflow-wrap:anywhere]">
              {JSON.stringify(entry.reviewerMetadata, null, 2)}
            </pre>
          </details>
        </details>
      ))}
    </section>
  );
}

type Props = { blockedReason?: string; onBusyChange?: (busy: boolean) => void };
export function QualityCandidateRegistryPanel({ blockedReason = "", onBusyChange = noop }: Props) {
  const [catalog, setCatalog] = useState<CandidateRegistryCatalog | null>(null);
  const [snapshot, setSnapshot] = useState<CandidateRegistrySnapshot | null>(null);
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);
  const [pending, setPending] = useState<CandidateRegistryPending | null>(null);
  const [working, setWorking] = useState(false);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [actualBusy, setActualBusy] = useState(false);
  const [providerBusy, setProviderBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const pendingRef = useRef<CandidateRegistryPending | null>(null);
  const listSequence = useRef(0);
  const head = catalog ? Math.max(0, ...catalog.versions.map((item) => item.version)) : 0;
  const currentRegistration = catalog?.versions.find(
    (item) => item.sourceDigest === catalog.source.sourceDigest,
  );
  const acknowledgementKey = catalog ? `${catalog.source.sourceDigest}:${head}` : null;
  const acknowledged = acknowledgement !== null && acknowledgement === acknowledgementKey;
  const locked =
    working || !!pending || !!blockedReason || executionBusy || actualBusy || providerBusy;
  const catalogLabels = catalog ? candidateRegistryCatalogLabels(catalog, !!pending) : null;

  useEffect(() => {
    mounted.current = true;
    const sequence = ++listSequence.current;
    studioFetch<unknown>(candidateRegistryBase)
      .then(candidateRegistryCatalog)
      .then((value) => {
        if (mounted.current && sequence === listSequence.current) setCatalog(value);
      })
      .catch(() => {
        if (mounted.current && sequence === listSequence.current)
          setError("후보 등록 목록을 불러오지 못했습니다. 목록 다시 읽기를 눌러 주세요.");
      });
    return () => {
      mounted.current = false;
      listSequence.current = sequence + 1;
    };
  }, []);
  useEffect(() => {
    onBusyChange(working || !!pending || executionBusy || actualBusy || providerBusy);
    return () => onBusyChange(false);
  }, [working, pending, executionBusy, actualBusy, providerBusy, onBusyChange]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (busyRef.current || pendingRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const navigate = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (
        !anchor ||
        anchor.getAttribute("href")?.startsWith("#") ||
        (anchor.hasAttribute("download") && anchor.getAttribute("href")?.startsWith("blob:"))
      )
        return;
      if (busyRef.current || pendingRef.current) {
        event.preventDefault();
        setError("후보 등록 요청의 저장 상태를 확인한 뒤 이동해 주세요.");
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
    };
  }, []);

  async function work(action: () => Promise<void>) {
    if (busyRef.current || blockedReason || executionBusy || actualBusy || providerBusy) return;
    busyRef.current = true;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (caught) {
      if (mounted.current)
        setError(
          caught instanceof Error ? caught.message : "후보 등록 결과를 확인하지 못했습니다.",
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function readCatalog() {
    const sequence = ++listSequence.current;
    const value = await candidateRegistryCatalog(await studioFetch<unknown>(candidateRegistryBase));
    if (mounted.current && sequence === listSequence.current) setCatalog(value);
  }
  async function recover(waiting: CandidateRegistryPending) {
    const result = await candidateRegistryRecovery(
      await studioFetch<unknown>(
        `${candidateRegistryBase}/requests/${waiting.request.clientRequestId}`,
      ),
      waiting,
    );
    if (!mounted.current || pendingRef.current !== waiting) return;
    if (result.state === "not-observed") {
      setMessage(
        "아직 이 요청의 등록 기록이 보이지 않습니다. 미접수 확정은 아닙니다. 다시 조회하거나 동일 요청으로 저장 재확인을 직접 선택해 주세요.",
      );
      return;
    }
    const value = await candidateRegistryCommitted(
      await studioFetch<unknown>(`${candidateRegistryVersions}/${result.receipt.version}`),
      waiting,
      result.receipt,
    );
    if (!mounted.current || pendingRef.current !== waiting) return;
    listSequence.current++;
    pendingRef.current = null;
    setPending(null);
    setSnapshot(value);
    setAcknowledgement(null);
    setMessage(
      `후보 원문을 버전 ${value.version}로 등록했습니다. 사람 정답표·독립 검증·실제 AI 평가를 완료한 것은 아닙니다.`,
    );
    await readCatalog();
  }
  async function write(waiting: CandidateRegistryPending) {
    pendingRef.current = waiting;
    setPending(waiting);
    try {
      await qualityPost(candidateRegistryVersions, waiting.request);
    } catch (caught) {
      if (caught instanceof QualityWriteRejection && caught.accepted === false) {
        pendingRef.current = null;
        if (mounted.current) {
          setPending(null);
          setMessage(
            "서버가 이번 등록을 거절했습니다. 확인한 등록 조건은 보존했습니다. 목록을 다시 읽고 현재 후보와 버전을 확인해 주세요.",
          );
        }
      }
      throw caught;
    }
    await recover(waiting);
  }
  async function register() {
    if (!catalog || !acknowledged || currentRegistration || locked || pendingRef.current) return;
    const waiting = candidateRegistryPending(catalog, crypto.randomUUID());
    await work(() => write(waiting));
  }
  async function openVersion(summary: CandidateRegistrySummary) {
    if (locked || pendingRef.current) return;
    await work(async () => {
      const value = await candidateRegistrySnapshot(
        await studioFetch<unknown>(`${candidateRegistryVersions}/${summary.version}`),
        summary,
      );
      if (mounted.current) setSnapshot(value);
    });
  }
  async function download() {
    if (!snapshot || locked || pendingRef.current) return;
    const selected = snapshot;
    await work(async () => {
      const file = await candidateRegistryArchive(
        await fetch(`${candidateRegistryVersions}/${selected.version}/download`, {
          cache: "no-store",
        }),
        selected,
      );
      if (!mounted.current) return;
      const url = URL.createObjectURL(file.blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`후보 등록 버전 ${selected.version} JSON 내려받기를 요청했습니다.`);
    });
  }

  return (
    <section
      aria-label="합성 품질 후보 버전 등록"
      className="min-w-0 space-y-4 rounded-2xl border bg-white p-5 sm:p-6"
    >
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">추가 합성 후보 12개 · 원문 버전 등록</h2>
        <p className="text-sm leading-6">
          {candidateRegistryNotice} 기존 50개 평가 회차와 별도로 보관합니다. 고객 자료 입력과 외부
          AI 실행은 제공하지 않습니다.
        </p>
      </header>
      {blockedReason && <p className="text-sm text-amber-900">{blockedReason}</p>}
      {error && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-xl border p-3 text-sm">
          {message}
        </p>
      )}
      {pending && (
        <div className="space-y-3 rounded-xl border border-amber-300 p-4">
          <h3 className="font-semibold">후보 등록 결과 확인 필요</h3>
          <p className="text-sm leading-6">
            요청 내용과 번호를 보존했습니다. 조회 결과가 없거나 통신에 실패해도 미저장으로 단정하지
            않습니다. 자동 재전송은 하지 않습니다.
          </p>
          <p className="break-all text-xs">요청 번호: {pending.request.clientRequestId}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              className={buttonClass}
              disabled={working || !!blockedReason}
              onClick={() => void work(() => recover(pending))}
            >
              후보 등록 상태 조회
            </Button>
            <Button
              className={buttonClass}
              variant="outline"
              disabled={working || !!blockedReason}
              onClick={() => void work(() => write(pending))}
            >
              동일 요청으로 저장 재확인
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          className={buttonClass}
          variant="outline"
          disabled={locked}
          onClick={() => void work(readCatalog)}
        >
          후보 목록 다시 읽기
        </Button>
        <Button
          className={buttonClass}
          variant={snapshot ? "outline" : "default"}
          disabled={locked || !catalog}
          onClick={() => setSnapshot(null)}
        >
          현재 코드의 후보 보기
        </Button>
      </div>
      {!catalog ? (
        <p className="text-sm">후보 목록 확인 중</p>
      ) : (
        <>
          <div className="space-y-3 rounded-xl bg-muted/25 p-4">
            <p className="text-sm">
              현재 코드의 합성 후보: {catalog.source.entries.length}개 ·{" "}
              {catalogLabels?.sourceStatus}
            </p>
            <p className="text-xs">{catalogLabels?.history}</p>
            {acknowledgement !== null && !acknowledged && (
              <p className="text-sm text-amber-900">
                후보 원문 또는 등록 버전이 변경되었습니다. 아래 내용을 다시 확인해 주세요.
              </p>
            )}
            <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0"
                checked={acknowledged}
                disabled={
                  locked || !!currentRegistration || head >= candidateRegistryLimits.versions
                }
                onChange={(event) =>
                  setAcknowledgement(event.target.checked ? acknowledgementKey : null)
                }
              />
              <span className="min-w-0">
                현재 코드의 12개 원문을 로컬 후보 버전으로 등록합니다. AI 작성 합성 후보이며 사람
                정답표·독립성·성능평가는 아직 확정되지 않았음을 확인했습니다.
              </span>
            </label>
            <Button
              className={buttonClass}
              disabled={
                locked ||
                !acknowledged ||
                !!currentRegistration ||
                head >= candidateRegistryLimits.versions
              }
              onClick={() => void register()}
            >
              확인한 후보 원문 등록
            </Button>
          </div>
          <section className="space-y-3" aria-label="후보 등록 이력">
            <h3 className="font-semibold">고정된 등록 버전</h3>
            {!catalog.versions.length ? (
              <p className="text-sm">{catalogLabels?.empty}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {[...catalog.versions]
                  .sort((left, right) => right.version - left.version)
                  .map((item) => (
                    <Button
                      key={item.version}
                      className={buttonClass}
                      variant={snapshot?.version === item.version ? "default" : "outline"}
                      disabled={locked}
                      onClick={() => void openVersion(item)}
                    >
                      등록 v{item.version} · {item.registeredAt.slice(0, 10)}
                    </Button>
                  ))}
              </div>
            )}
          </section>
        </>
      )}
      {snapshot && (
        <div className="space-y-2 rounded-xl border p-4">
          <p className="text-sm">
            보관한 등록 버전 {snapshot.version} · 등록 시각 {snapshot.registeredAt}
          </p>
          <p className="text-xs">
            현재 코드에서 다시 만든 원문이 아닙니다. 이 버전에 고정한 입력과 메모를 읽고 있습니다.
          </p>
          <Button
            className={buttonClass}
            variant="outline"
            disabled={locked}
            onClick={() => void download()}
          >
            이 등록 버전 JSON 내려받기
          </Button>
        </div>
      )}
      <QualityExecutionPanel
        registry={snapshot}
        blockedReason={
          blockedReason ||
          (working || pending ? "후보 등록의 저장 상태를 먼저 확인해 주세요." : "") ||
          (actualBusy ? "실제 AI 준비 조회본을 닫은 뒤 모의 시험을 진행해 주세요." : "") ||
          (providerBusy ? "실행 검토안·보관 이력을 닫은 뒤 진행해 주세요." : "")
        }
        onBusyChange={setExecutionBusy}
      />
      <QualityActualPreparationPanel
        registry={snapshot}
        blockedReason={
          blockedReason ||
          (working || pending ? "후보 등록의 저장 상태를 먼저 확인해 주세요." : "") ||
          (executionBusy ? "모의 실행 준비·기록을 먼저 확인하고 닫아 주세요." : "") ||
          (providerBusy ? "실행 검토안·보관 이력을 닫은 뒤 진행해 주세요." : "")
        }
        onBusyChange={setActualBusy}
      />
      <QualityProviderReviewPanel
        key={snapshot?.versionDigest ?? "no-registry"}
        registry={snapshot}
        blockedReason={
          blockedReason ||
          (working || pending ? "후보 등록의 저장 상태를 먼저 확인해 주세요." : "") ||
          (executionBusy ? "모의 실행 준비·기록을 먼저 확인하고 닫아 주세요." : "") ||
          (actualBusy ? "실제 AI 준비 조회본을 먼저 닫아 주세요." : "")
        }
        onBusyChange={setProviderBusy}
      />
      {(snapshot ?? catalog?.source) && (
        <QualityCandidateContents
          source={snapshot ?? catalog!.source}
          label={snapshot ? `보관한 후보 원문 v${snapshot.version}` : "현재 코드의 후보 원문"}
        />
      )}
    </section>
  );
}
