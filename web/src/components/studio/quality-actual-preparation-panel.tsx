"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { QualityActualPreparation } from "@/lib/studio-plan-quality-actual-types";
import { studioFetch, jsonBody } from "./shared";
import {
  qualityActualArchive,
  qualityActualModelPattern,
  qualityActualPreparation,
  qualityActualPreparationUrl,
  qualityActualSelectionMatches,
} from "./quality-actual-preparation-ui";

const buttonClass = "h-auto min-h-11 min-w-0 max-w-full shrink whitespace-normal break-words py-2";
const noop = () => undefined;
export function QualityActualPreparationPanel({
  registry,
  blockedReason = "",
  onBusyChange = noop,
}: {
  registry: CandidateRegistrySnapshot | null;
  blockedReason?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [candidate, setCandidate] = useState("");
  const [model, setModel] = useState("");
  const [working, setWorking] = useState(false);
  const [viewed, setViewed] = useState<QualityActualPreparation | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false),
    sequence = useRef(0),
    mounted = useRef(false);
  const candidateId = registry?.entries.some((entry) => entry.candidateId === candidate)
    ? candidate
    : "";
  const selectedModel = model === "" ? null : model;
  const current =
    viewed && qualityActualSelectionMatches(viewed, registry, candidateId, selectedModel)
      ? viewed
      : null;
  const selectionKey = `${registry?.versionDigest ?? ""}:${candidateId}:${model}`;
  const latestSelection = useRef(selectionKey);
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
  const validModel = model === "" || qualityActualModelPattern.test(model);
  async function inspect() {
    if (busy.current || blockedReason || !registry || !candidateId || !validModel) return;
    busy.current = true;
    setWorking(true);
    setError("");
    setViewed(null);
    const requestSequence = ++sequence.current,
      key = selectionKey;
    try {
      const raw = await studioFetch<unknown>(qualityActualPreparationUrl, {
        method: "POST",
        ...jsonBody({
          version: registry.version,
          versionDigest: registry.versionDigest,
          candidateId,
          model: selectedModel,
        }),
      });
      const checked = await qualityActualPreparation(raw, registry, candidateId, selectedModel);
      if (
        mounted.current &&
        requestSequence === sequence.current &&
        latestSelection.current === key
      )
        setViewed(checked);
    } catch {
      if (mounted.current && requestSequence === sequence.current)
        setError(
          "준비 내용을 확인하지 못했습니다. 선택한 값은 유지했습니다. 실제 실행·비용 예약은 이루어지지 않았습니다.",
        );
    } finally {
      busy.current = false;
      if (mounted.current && requestSequence === sequence.current) setWorking(false);
    }
  }
  async function download() {
    if (!current || !registry || busy.current || blockedReason) return;
    busy.current = true;
    setWorking(true);
    setError("");
    const key = selectionKey;
    try {
      const archive = await qualityActualArchive(current, registry, candidateId, selectedModel);
      if (!mounted.current || latestSelection.current !== key) return;
      const url = URL.createObjectURL(
        new Blob([archive.text], { type: "application/json;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = archive.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (mounted.current)
        setError(
          "현재 준비 조회 결과를 내려받지 못했습니다. 화면의 선택과 조회 결과를 다시 확인해 주세요.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  return (
    <section
      aria-label="실제 AI 실행 전 준비 확인"
      className="min-w-0 space-y-3 rounded-xl border p-4"
    >
      <h3 className="font-semibold">실제 AI 실행 전 준비 확인</h3>
      <p className="text-sm leading-6">
        등록한 합성 후보 한 개의 입력 원문과 부족한 실행 조건을 확인합니다. 현재 단계에서는 실제
        AI를 호출하지 않습니다.
      </p>
      {!registry ? (
        <p className="text-sm text-muted-foreground">먼저 보관한 후보 등록 버전을 열어 주세요.</p>
      ) : (
        <>
          <label className="block space-y-2 text-sm">
            <span>준비 확인할 합성 후보</span>
            <select
              aria-label="준비 확인할 합성 후보"
              className="min-h-11 w-full min-w-0 rounded-lg border bg-background px-3"
              disabled={locked}
              value={candidateId}
              onChange={(event) => {
                setCandidate(event.target.value);
                setViewed(null);
                setError("");
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
          <label className="block space-y-2 text-sm">
            <span>검토할 모델 ID · 선택 입력</span>
            <input
              aria-label="검토할 모델 ID"
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              className="min-h-11 w-full min-w-0 rounded-lg border bg-background px-3"
              value={model}
              disabled={locked}
              onChange={(event) => {
                setModel(event.target.value);
                setViewed(null);
                setError("");
              }}
            />
          </label>
          <p className="text-xs leading-6 text-muted-foreground">
            입력한 ID의 제공 여부·가격·사용 권한은 확인되지 않았습니다. 비워 두면 모델 미선택 상태로
            확인합니다. 키나 계정정보를 입력하지 마세요.
          </p>
          {!validModel && (
            <p role="alert" className="text-sm text-destructive">
              모델 ID에는 영문·숫자와 점·밑줄·콜론·하이픈만 사용할 수 있습니다. 앞뒤 공백은 제거해
              주세요.
            </p>
          )}
          <Button
            className={buttonClass}
            disabled={locked || !candidateId || !validModel}
            onClick={() => void inspect()}
          >
            {working ? "준비 내용 확인 중" : "선택한 후보의 준비 내용 확인"}
          </Button>
        </>
      )}
      {blockedReason && <p className="text-sm text-amber-900">{blockedReason}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {current && (
        <div className="min-w-0 space-y-3 rounded-lg bg-muted/25 p-3">
          <p className="font-medium">실행 준비 미완료</p>
          <p className="break-words text-sm">
            등록 v{current.scope.version} · {current.scope.label} · 모델 {current.model ?? "미선택"}
          </p>
          <p className="text-xs leading-6">
            가격·입력 토큰·총액 상한: 미확인. 생성 1회 + 독립 검토 1회, 최대 2회 범위입니다. 자동
            재시도·자동 수정은 포함하지 않습니다.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {current.blockers.map((item) => (
              <li key={item.code}>{item.message}</li>
            ))}
          </ul>
          <p className="text-xs leading-6">
            조회 시각: {current.preparedAt}. 이 결과는 현재 화면의 준비 조회본이며 서버에
            승인·실행·비용 예약 기록으로 저장되지 않습니다. 사람 정답표와 실제 AI 성능평가는 아직
            없습니다.
          </p>
          {current.requestEvidence && (
            <>
              <details className="min-w-0">
                <summary className="cursor-pointer text-sm">
                  생성 요청 원문 · system / 입력 / 출력 schema
                </summary>
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">
                  {JSON.stringify(current.requestEvidence.generation.body, null, 2)}
                </pre>
              </details>
              <details className="min-w-0">
                <summary className="cursor-pointer text-sm">
                  검토 요청의 고정 입력과 원고 파생 규칙
                </summary>
                <p className="my-2 text-xs leading-6">
                  검토 본문은 아직 완성되지 않았습니다. 같은 실행에서 검증된 최초 생성 원고만 고정
                  입력에 넣습니다. 생성 후 원문 기록·토큰 상한 재확인이 필요하며, 지금 정확한 검토
                  본문을 승인한 것으로 취급하지 않습니다.
                </p>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">
                  {JSON.stringify(current.requestEvidence.reviewTemplate, null, 2)}
                </pre>
              </details>
            </>
          )}
          <p className="break-all text-xs text-muted-foreground">
            조회본 SHA-256: {current.preparationDigest}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              className={buttonClass}
              variant="outline"
              disabled={locked}
              onClick={() => void download()}
            >
              현재 조회본 JSON 내려받기
            </Button>
            <Button
              className={buttonClass}
              variant="outline"
              disabled={working}
              onClick={() => setViewed(null)}
            >
              조회본 닫기
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
