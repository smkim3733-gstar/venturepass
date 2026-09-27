"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderSnapshot } from "@/lib/studio-plan-quality-provider-types";
import type {
  ProviderReviewView,
  ProviderLedgerOverview,
  ProviderLedgerArtifactKey,
} from "@/lib/studio-plan-quality-provider-review-types";
import { studioFetch, jsonBody } from "./shared";
import { QualityProviderProposalDetails } from "./quality-provider-proposal-details";
import {
  qualityProviderReview,
  qualityProviderOverview,
  qualityProviderSnapshot,
  qualityProviderArchive,
  qualityProviderArtifact,
  qualityProviderReviewArchive,
  qualityProviderStateSummary,
  qualityProviderReviewInspectUrl,
  qualityProviderLedgerBase,
} from "./quality-provider-review-ui";

const buttonClass = "h-auto min-h-11 min-w-0 max-w-full shrink whitespace-normal break-words py-2";
const noop = () => undefined;
const artifactLabels: Record<ProviderLedgerArtifactKey, string> = {
  "generation-request": "생성 요청 원문",
  "generation-response": "생성 응답 원문",
  "generation-validated": "검증된 최초 원고",
  "review-request": "검토 요청 원문",
  "review-response": "검토 응답 원문",
  "review-validated": "검증된 검토 의견",
  "final-result": "최종 검토 반영 원고",
};
const eventLabels: Record<string, string> = {
  "transmission-approved": "별도 전송 승인 기록",
  "request-prepared": "요청 원문 준비",
  "dispatch-intent": "전송 의도 기록",
  "response-received": "응답·사용량 보관",
  "domain-validated": "출력 구조·근거 검증",
  "execution-stopped": "실행 종료·중단 기록",
  "cancelled-before-dispatch": "전송 전 예약 취소",
};
function saveText(value: { text: string; filename: string }) {
  const url = URL.createObjectURL(
    new Blob([value.text], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = value.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function readRaw(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (
    !response.ok ||
    !response.headers.get("Content-Type")?.toLowerCase().includes("application/json")
  )
    throw new Error("원문 조회 실패");
  return {
    text: await response.text(),
    sha: response.headers.get("X-Content-SHA256") ?? undefined,
  };
}
export function QualityProviderRecordDetails({ snapshot }: { snapshot: ProviderSnapshot }) {
  const status = qualityProviderStateSummary(snapshot);
  return (
    <div className="min-w-0 space-y-3">
      <p className="font-semibold" role="status">
        {status.label}
      </p>
      <p className="text-sm leading-6">{status.detail}</p>
      <p className="text-sm leading-6">{status.costLabel}</p>
      <p className="text-xs leading-6 text-muted-foreground">
        {snapshot.run.environment === "synthetic-test"
          ? "합성 연결시험 기록 · 실제 AI 성능·운영 견적을 뜻하지 않습니다."
          : "운영 출처 보관 기록 · 조회로 전송을 재개하지 않습니다."}
      </p>
      <p className="break-words text-xs [overflow-wrap:anywhere]">
        기록 r{snapshot.revision} · 마지막 기록 시각{" "}
        {snapshot.events.at(-1)?.recordedAt ?? snapshot.run.recordedAt}
      </p>
      <details className="min-w-0 rounded-lg border p-3">
        <summary className="cursor-pointer text-sm">기록된 단계·전송 범위</summary>
        <p className="my-3 text-xs leading-6">
          전송 의도 기록은 공급자의 수신·청구 확인과 다릅니다. 원고 검증 기록과 실행 종료도 따로
          확인합니다.
        </p>
        <ol className="space-y-2 text-xs leading-6">
          <li>r0 · 예약 전용 동의 · {snapshot.run.recordedAt}</li>
          {snapshot.events.map((event) => (
            <li key={event.eventDigest}>
              r{event.revision} · {eventLabels[event.payload.kind]}
              {"phase" in event.payload
                ? ` · ${event.payload.phase === "generation" ? "생성" : "검토"}`
                : ""}{" "}
              · {event.recordedAt}
            </li>
          ))}
        </ol>
        <p className="mt-3 break-words text-xs [overflow-wrap:anywhere]">
          실행 ID {snapshot.run.id}
          <br />
          고정 모델 {snapshot.run.preparation.model}
          <br />
          본문 범위: 등록 후보 한 건 · 생성 1회 + 검토 1회 · 자동 재시도 없음
        </p>
        <details className="mt-3">
          <summary className="cursor-pointer text-xs">승인·비용·보관 근거 원문</summary>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-xs [overflow-wrap:anywhere]">
            {JSON.stringify(
              {
                preparation: snapshot.run.preparation,
                events: snapshot.events,
                budgetEvents: snapshot.budgetEvents,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </details>
    </div>
  );
}

export function QualityProviderReviewPanel({
  registry,
  blockedReason = "",
  onBusyChange = noop,
}: {
  registry: CandidateRegistrySnapshot | null;
  blockedReason?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [candidate, setCandidate] = useState("");
  const [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const [loaded, setLoaded] = useState<{
    key: string;
    view: ProviderReviewView;
    overview: ProviderLedgerOverview;
  } | null>(null);
  const [record, setRecord] = useState<ProviderSnapshot | null>(null),
    [head, setHead] = useState<ProviderSnapshot | null>(null);
  const [raw, setRaw] = useState<{
    key: ProviderLedgerArtifactKey;
    text: string;
    filename: string;
    snapshotDigest: string;
  } | null>(null);
  const candidateId = registry?.entries.some((row) => row.candidateId === candidate)
    ? candidate
    : "";
  const selectionKey = `${registry?.versionDigest ?? ""}:${candidateId}`;
  const current = loaded?.key === selectionKey ? loaded : null;
  const busy = useRef(false),
    mounted = useRef(false),
    sequence = useRef(0),
    latestSelection = useRef(selectionKey);
  useEffect(() => {
    latestSelection.current = selectionKey;
  }, [selectionKey]);
  useEffect(() => {
    mounted.current = true;
    const mountSequence = ++sequence.current;
    return () => {
      mounted.current = false;
      sequence.current = mountSequence + 1;
    };
  }, []);
  useEffect(() => {
    onBusyChange(working || !!current);
    return () => onBusyChange(false);
  }, [working, current, onBusyChange]);
  const locked = working || !!blockedReason;
  async function work(action: (active: () => boolean) => Promise<void>) {
    if (busy.current || blockedReason || !registry || !candidateId) return;
    busy.current = true;
    setWorking(true);
    setError("");
    const serial = ++sequence.current,
      key = selectionKey;
    const active = () =>
      mounted.current && serial === sequence.current && latestSelection.current === key;
    try {
      await action(active);
    } catch {
      if (active())
        setError(
          "조회 내용을 확인하지 못했습니다. 선택과 마지막 확인 기록은 유지했습니다. 다시 읽기로 확인해 주세요.",
        );
    } finally {
      busy.current = false;
      if (mounted.current && serial === sequence.current) setWorking(false);
    }
  }
  async function inspect() {
    if (!registry) return;
    await work(async (active) => {
      const [view, overview] = await Promise.all([
        studioFetch<unknown>(qualityProviderReviewInspectUrl, {
          method: "POST",
          ...jsonBody({
            version: registry.version,
            versionDigest: registry.versionDigest,
            candidateId,
          }),
        }).then((value) => qualityProviderReview(value, registry, candidateId)),
        studioFetch<unknown>(qualityProviderLedgerBase).then((value) =>
          qualityProviderOverview(value, registry, candidateId),
        ),
      ]);
      if (active()) {
        setLoaded({ key: selectionKey, view, overview });
        setRecord(null);
        setHead(null);
        setRaw(null);
      }
    });
  }
  async function openRecord(target: ProviderSnapshot, revision = target.revision) {
    if (!registry) return;
    await work(async (active) => {
      const value = await qualityProviderSnapshot(
        await studioFetch<unknown>(
          `${qualityProviderLedgerBase}/runs/${target.run.id}/revisions/${revision}`,
        ),
        registry,
        {
          id: target.run.id,
          candidateId,
          revision,
          ...(revision === target.revision ? { snapshotDigest: target.snapshotDigest } : {}),
        },
      );
      if (value.run.runDigest !== target.run.runDigest) throw new Error("실행 원본 불일치");
      if (active()) {
        setRecord(value);
        setHead(target);
        setRaw(null);
      }
    });
  }
  async function downloadReview() {
    if (!current || !registry) return;
    await work(async (active) => {
      const value = await qualityProviderReviewArchive(current.view, registry, candidateId);
      if (active()) saveText(value);
    });
  }
  async function downloadRecord() {
    if (!record) return;
    await work(async (active) => {
      const value = await readRaw(
        `${qualityProviderLedgerBase}/runs/${record.run.id}/revisions/${record.revision}/download`,
      );
      const checked = await qualityProviderArchive(value.text, record, value.sha);
      if (active()) saveText(checked);
    });
  }
  async function openArtifact(key: ProviderLedgerArtifactKey) {
    if (!record) return;
    await work(async (active) => {
      const value = await readRaw(
        `${qualityProviderLedgerBase}/runs/${record.run.id}/revisions/${record.revision}/artifacts/${key}`,
      );
      const checked = await qualityProviderArtifact(value.text, record, key, value.sha);
      if (active()) setRaw({ ...checked, key, snapshotDigest: record.snapshotDigest });
    });
  }
  const visibleRecord = current ? record : null;
  return (
    <section aria-label="실행 검토안·보관 이력" className="min-w-0 space-y-4 rounded-xl border p-4">
      <div>
        <h3 className="font-semibold">실행 검토안·보관 이력</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          후보 한 건의 운영 준비 상태와 보관한 기록을 확인합니다. 조회 중에는 AI 호출·비용 예약이
          없습니다.
        </p>
      </div>
      {!registry ? (
        <p className="text-sm">먼저 보관한 후보 등록 버전을 열어 주세요.</p>
      ) : (
        <>
          <label className="block space-y-2 text-sm">
            <span>검토할 합성 후보</span>
            <select
              aria-label="검토할 합성 후보"
              disabled={locked}
              value={candidateId}
              className="min-h-11 w-full min-w-0 rounded-lg border bg-background px-3"
              onChange={(event) => {
                setCandidate(event.target.value);
                setLoaded(null);
                setRecord(null);
                setHead(null);
                setRaw(null);
                setError("");
                sequence.current++;
                latestSelection.current = `${registry.versionDigest}:${event.target.value}`;
              }}
            >
              <option value="">후보 선택</option>
              {registry.entries.map((entry) => (
                <option key={entry.candidateId} value={entry.candidateId}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              className={buttonClass}
              variant={current ? "outline" : "default"}
              disabled={locked || !candidateId}
              onClick={() => void inspect()}
            >
              {working ? "확인 중…" : current ? "검토안·이력 다시 읽기" : "검토안·이력 보기"}
            </Button>
            {current && (
              <Button
                variant="outline"
                className={buttonClass}
                disabled={working}
                onClick={() => {
                  setLoaded(null);
                  setRecord(null);
                  setHead(null);
                  setRaw(null);
                  setError("");
                  sequence.current++;
                }}
              >
                검토안 닫기
              </Button>
            )}
          </div>
          {blockedReason && <p className="text-sm text-amber-900">{blockedReason}</p>}
          {error && (
            <p role="alert" className="text-sm leading-6 text-destructive">
              {error}
            </p>
          )}
          {current && (
            <>
              <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
                <p className="font-semibold" role="status">
                  {current.view.state === "proposal-only"
                    ? "실행 전 검토 제안 · 승인 전"
                    : "실제 실행 준비 미완료"}
                </p>
                <p className="text-sm leading-6">
                  {current.view.scope.label} · 등록 v{current.view.scope.version}
                </p>
                {current.view.state === "proposal-only" ? (
                  <QualityProviderProposalDetails view={current.view} />
                ) : (
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">운영 모델·금액</dt>
                      <dd>미설정</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">검토할 호출 범위</dt>
                      <dd>생성 1회 · 검토 1회 · 재시도 없음</dd>
                    </div>
                  </dl>
                )}
                <details>
                  <summary className="cursor-pointer text-sm">준비에 필요한 조건</summary>
                  <ul className="mt-3 space-y-2 text-sm leading-6">
                    {current.view.blockers.map((item) => (
                      <li key={item.code}>{item.message}</li>
                    ))}
                  </ul>
                  {current.view.state === "configuration-missing" && (
                    <p className="mt-3 text-xs leading-6">
                      모델과 근거가 정해지면 정확한 생성 요청과 비용을 검토할 수 있습니다. 두 번째
                      검토 요청은 같은 실행의 검증된 최초 원고에서만 만들어집니다.
                    </p>
                  )}
                </details>
                <p className="text-xs leading-6 text-muted-foreground">
                  조회 시각 {current.view.inspectedAt} · 조회본은 전송 승인서가 아닙니다.
                </p>
                <Button
                  variant="outline"
                  className={buttonClass}
                  disabled={locked}
                  onClick={() => void downloadReview()}
                >
                  이 검토 조회본 JSON 내려받기
                </Button>
              </div>
              <section aria-label="선택 후보의 보관 이력" className="min-w-0 space-y-3">
                <h4 className="font-semibold">이 후보의 보관 이력</h4>
                <p className="text-xs leading-6 text-muted-foreground">
                  마지막 조회 기준입니다. 다른 후보·등록 버전의 기록을 함께 보여 주지 않습니다.
                </p>
                {current.overview.executions.length === 0 ? (
                  <p className="text-sm">이 등록 후보에 연결된 보관 기록이 없습니다.</p>
                ) : (
                  <div className="space-y-2">
                    {[...current.overview.executions]
                      .sort((a, b) => b.run.recordedAt.localeCompare(a.run.recordedAt))
                      .map((item) => (
                        <Button
                          key={item.run.id}
                          variant={visibleRecord?.run.id === item.run.id ? "secondary" : "outline"}
                          className={`${buttonClass} w-full justify-start text-left`}
                          disabled={locked}
                          onClick={() => void openRecord(item)}
                        >
                          {item.run.environment === "synthetic-test" ? "합성" : "운영"} ·{" "}
                          {qualityProviderStateSummary(item).label} · {item.run.recordedAt}
                          <span className="sr-only"> · 실행 {item.run.id}</span>
                        </Button>
                      ))}
                  </div>
                )}
              </section>
              {visibleRecord && head && (
                <section
                  aria-label="선택 실행 기록"
                  className="min-w-0 space-y-4 rounded-xl border p-4"
                >
                  <label className="block space-y-2 text-sm">
                    <span>확인할 기록 시점</span>
                    <select
                      aria-label="확인할 기록 시점"
                      disabled={locked}
                      value={visibleRecord.revision}
                      className="min-h-11 w-full min-w-0 rounded-lg border bg-background px-3"
                      onChange={(event) => void openRecord(head, Number(event.target.value))}
                    >
                      {Array.from({ length: head.revision + 1 }, (_, revision) => (
                        <option key={revision} value={revision}>
                          r{revision}
                          {revision === head.revision ? " · 마지막 조회 시점" : " · 과거 기록"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <QualityProviderRecordDetails snapshot={visibleRecord} />
                  <Button
                    className={buttonClass}
                    variant="outline"
                    disabled={locked}
                    onClick={() => void downloadRecord()}
                  >
                    이 시점의 보관 JSON 내려받기
                  </Button>
                  <details className="min-w-0">
                    <summary className="cursor-pointer text-sm">
                      이 시점에 보관한 원문 {visibleRecord.artifacts.length}개
                    </summary>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {visibleRecord.artifacts.map((item) => (
                        <Button
                          key={item.key}
                          className={buttonClass}
                          variant="outline"
                          disabled={locked}
                          onClick={() => void openArtifact(item.key)}
                        >
                          {artifactLabels[item.key]}
                        </Button>
                      ))}
                    </div>
                    {raw?.snapshotDigest === visibleRecord.snapshotDigest && (
                      <div className="mt-3 min-w-0 space-y-3">
                        <p className="text-sm font-semibold">{artifactLabels[raw.key]}</p>
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-xs [overflow-wrap:anywhere]">
                          {raw.text}
                        </pre>
                        <Button
                          className={buttonClass}
                          variant="outline"
                          disabled={locked}
                          onClick={() => saveText(raw)}
                        >
                          이 원문 JSON 내려받기
                        </Button>
                      </div>
                    )}
                  </details>
                </section>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
