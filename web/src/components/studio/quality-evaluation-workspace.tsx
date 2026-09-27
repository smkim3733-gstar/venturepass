"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { studioFetch } from "./shared";
import { QualityCandidateRegistryPanel } from "./quality-candidate-registry-panel";
import {
  emptyQualityEvaluation,
  qualityCatalog,
  qualityArchiveDownload,
  qualityCommittedSnapshot,
  qualityDraftValue,
  qualityFixture,
  qualityPost,
  qualityRecordText,
  qualityRecovery,
  qualitySnapshot,
  qualityStatusLabels,
  QUALITY_EDITOR_BYTES,
  QualityWriteRejection,
  type QualityCatalog,
  type QualityPending,
  type QualityRun,
} from "./quality-evaluation-ui";

const base = "/api/studio/quality/runs";
const panelClass = "min-w-0 space-y-4 rounded-2xl border bg-white p-5 sm:p-6";
const inputClass =
  "w-full min-w-0 max-w-full rounded-lg border bg-white p-3 text-sm disabled:bg-muted/30";
const buttonClass = "h-auto min-h-11 min-w-0 max-w-full shrink whitespace-normal break-words py-2";

export function QualityEvaluationWorkspace() {
  const [catalog, setCatalog] = useState<QualityCatalog | null>(null);
  const [run, setRun] = useState<QualityRun | null>(null);
  const [title, setTitle] = useState("");
  const [fixtureId, setFixtureId] = useState("");
  const [draft, setDraft] = useState("");
  const [savedText, setSavedText] = useState("");
  const [editorRevision, setEditorRevision] = useState(0);
  const [editorManifest, setEditorManifest] = useState("");
  const [fixtureDetails, setFixtureDetails] = useState<unknown>(null);
  const [pending, setPending] = useState<QualityPending | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [registryLocked, setRegistryLocked] = useState(false);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const pendingRef = useRef<QualityPending | null>(null);
  const listSequence = useRef(0);
  const dirty = draft !== savedText;
  const selected = run?.manifest.find((item) => item.fixtureId === fixtureId);
  const record = run?.records.find((item) => item.fixtureId === fixtureId);
  const summary = run?.summary ?? null;
  const outcome = summary?.cases.find((item) => item.fixtureId === fixtureId);
  const historical = !!run && run.revision !== run.currentRevision;
  const staleDraft =
    !!run && (editorRevision !== run.revision || editorManifest !== run.manifestDigest);
  const locked = working || !!pending || registryLocked;

  useEffect(() => {
    mounted.current = true;
    const sequence = ++listSequence.current;
    studioFetch<unknown>(base)
      .then((raw) => {
        if (mounted.current && sequence === listSequence.current) setCatalog(qualityCatalog(raw));
      })
      .catch(() => {
        if (mounted.current && sequence === listSequence.current)
          setError("평가 목록을 불러오지 못했습니다. 목록 다시 읽기를 눌러 주세요.");
      });
    return () => {
      mounted.current = false;
      listSequence.current = sequence + 1;
    };
  }, []);

  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty || pending || working || title.trim()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const navigate = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!target || target.getAttribute("href")?.startsWith("#")) return;
      if (target.hasAttribute("download") && target.getAttribute("href")?.startsWith("blob:"))
        return;
      if (pendingRef.current || busyRef.current) {
        event.preventDefault();
        setError("진행 중인 요청의 저장 상태를 확인한 뒤 이동해 주세요.");
      } else if (
        (dirty || title.trim()) &&
        !window.confirm("저장하지 않은 입력을 취소하고 이동할까요?")
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty, pending, working, title]);

  function mayReplace() {
    return (
      !busyRef.current &&
      !registryLocked &&
      !pendingRef.current &&
      (!dirty || window.confirm("저장하지 않은 평가 JSON을 취소할까요?"))
    );
  }
  function editFrom(value: QualityRun, id: string) {
    const item = value.manifest.find((entry) => entry.fixtureId === id);
    if (!item) throw new Error("선택한 합성 사례를 확인하지 못했습니다.");
    const text = qualityRecordText(
      value.records.find((entry) => entry.fixtureId === id) ?? emptyQualityEvaluation(item),
    );
    setFixtureId(id);
    setDraft(text);
    setSavedText(text);
    setEditorRevision(value.revision);
    setEditorManifest(value.manifestDigest);
    setFixtureDetails(null);
  }
  async function readCatalog() {
    const sequence = ++listSequence.current;
    const value = qualityCatalog(await studioFetch<unknown>(base));
    if (mounted.current && sequence === listSequence.current) setCatalog(value);
  }
  async function work(action: () => Promise<void>) {
    if (busyRef.current || registryLocked) return;
    busyRef.current = true;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (caught) {
      if (mounted.current)
        setError(caught instanceof Error ? caught.message : "요청 결과를 확인하지 못했습니다.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function openRun(id: string, revision?: number, keepDraft = false) {
    if (pendingRef.current || (!keepDraft && !mayReplace())) return;
    await work(async () => {
      const path = revision !== undefined ? `${base}/${id}/revisions/${revision}` : `${base}/${id}`;
      const value = qualitySnapshot(await studioFetch<unknown>(path), { id, revision });
      if (!mounted.current) return;
      setRun(value);
      if (!(keepDraft && dirty))
        editFrom(
          value,
          value.manifest.some((item) => item.fixtureId === fixtureId)
            ? fixtureId
            : value.manifest[0].fixtureId,
        );
      else
        setMessage(
          "최신 기록을 읽었습니다. 작성 중인 JSON은 유지했습니다. 저장된 기록과 대조해 주세요.",
        );
    });
  }
  async function recover(waiting: QualityPending) {
    const result = await qualityRecovery(
      await studioFetch<unknown>(`${base}/requests/${waiting.request.clientRequestId}`),
      waiting,
    );
    if (!mounted.current || pendingRef.current !== waiting) return;
    if (result.state === "not-observed") {
      setMessage(
        "아직 이 요청의 저장 기록이 보이지 않습니다. 잠시 후 저장 상태를 다시 조회해 주세요. 요청을 재전송하지 않습니다.",
      );
      return;
    }
    const receipt = result.receipt;
    const raw = await studioFetch<unknown>(
      `${base}/${receipt.runId}/revisions/${receipt.revision}`,
    );
    const value = qualityCommittedSnapshot(raw, waiting, receipt);
    if (!mounted.current || pendingRef.current !== waiting) return;
    listSequence.current++;
    pendingRef.current = null;
    setPending(null);
    setRun(value);
    editFrom(
      value,
      waiting.kind === "record" ? waiting.request.record.fixtureId : value.manifest[0].fixtureId,
    );
    if (waiting.kind === "create") setTitle("");
    setMessage(
      `평가 회차의 기록 버전 ${value.revision}을 보관했습니다. 입력된 평가 기록이며 실제 AI 실행이나 품질 합격을 확인한 결과는 아닙니다.`,
    );
    await readCatalog();
  }
  async function write(waiting: QualityPending) {
    pendingRef.current = waiting;
    setPending(waiting);
    try {
      await qualityPost(
        waiting.kind === "create" ? base : `${base}/${waiting.runId}/records`,
        waiting.request,
      );
    } catch (caught) {
      if (caught instanceof QualityWriteRejection && caught.accepted === false) {
        pendingRef.current = null;
        if (mounted.current) {
          setPending(null);
          if (caught.status === 409)
            setMessage(
              "서버가 저장을 거절했습니다. JSON 초안은 유지했습니다. 최신 기록 불러오기로 변경 내용을 확인해 주세요.",
            );
        }
      }
      throw caught;
    }
    await recover(waiting);
  }
  async function createRun() {
    if (!catalog || pendingRef.current || !title.trim() || !mayReplace()) return;
    await work(async () => {
      await write({
        kind: "create",
        request: {
          clientRequestId: crypto.randomUUID(),
          title: title.trim(),
          manifestDigest: catalog.manifestDigest,
        },
      });
    });
  }
  async function saveRecord() {
    if (
      !run ||
      !selected ||
      pendingRef.current ||
      historical ||
      staleDraft ||
      !run.manifestCurrent ||
      !dirty
    )
      return;
    await work(async () => {
      const value = qualityDraftValue(draft, selected, QUALITY_EDITOR_BYTES);
      await write({
        kind: "record",
        runId: run.id,
        manifestDigest: run.manifestDigest,
        request: { revision: run.revision, clientRequestId: crypto.randomUUID(), record: value },
      });
    });
  }
  async function inspectFixture() {
    if (!run || !selected || pendingRef.current) return;
    const context = { id: run.id, revision: run.revision, fixtureId: selected.fixtureId };
    await work(async () => {
      const raw = await studioFetch<unknown>(`${base}/${run.id}/fixtures/${selected.fixtureId}`);
      const value = await qualityFixture(raw, selected);
      if (mounted.current && context.id === run.id && context.revision === run.revision)
        setFixtureDetails(value.fixture);
    });
  }
  async function download() {
    if (!run || pendingRef.current) return;
    const context = run;
    await work(async () => {
      const response = await fetch(`${base}/${context.id}/revisions/${context.revision}/download`, {
        cache: "no-store",
      });
      const file = await qualityArchiveDownload(response, {
        id: context.id,
        revision: context.revision,
      });
      if (!mounted.current) return;
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`기록 버전 ${context.revision} 다운로드를 요청했습니다.`);
    });
  }

  return (
    <section
      aria-label="합성 자료 품질 검증"
      className="mx-auto min-w-0 max-w-6xl space-y-6 px-4 py-8 text-[#172d4d] sm:px-6"
    >
      <a href="/studio" className="text-sm underline underline-offset-4">
        벤처패스로 돌아가기
      </a>
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">개발·검토 도구</p>
        <h1 className="text-2xl font-bold">합성 자료 품질 검증</h1>
        <p className="max-w-3xl text-sm leading-6">
          고정 합성 50사례의 평가 기록을 이 PC에 보관합니다. 실제 고객 자료를 넣지 마세요. 이 도구는
          AI를 실행하지 않으며, 입력한 ‘실제 AI’·사람 검토 기록의 실제 수행 여부를 확인하지
          않습니다.
        </p>
        <details className="text-sm leading-6">
          <summary className="cursor-pointer">평가 기록 보관·복원 안내</summary>
          <p className="mt-2">
            평가 기록은 회사 자료와 별도 저장됩니다. JSON 내려받기는 선택 버전의 조회용 내보내기이며
            복원 파일이 아닙니다. 전체 회차·원문·이력의 이전에는 로컬 관리 도구의 quality-backup,
            quality-verify, quality-restore를 사용하세요. 기존 회사 자료 백업에는 이 평가 기록이
            포함되지 않습니다.
          </p>
        </details>
      </header>
      {error && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-xl border p-4 text-sm">
          {message}
        </p>
      )}
      {pending && (
        <section className={panelClass}>
          <h2 className="font-semibold">저장 결과 확인 필요</h2>
          <p className="text-sm">
            먼저 저장 상태를 조회해 주세요. 결과가 없으면 같은 요청 내용과 번호로 저장을 다시 확인할
            수 있습니다. 자동 재전송은 하지 않습니다.
          </p>
          <Button
            className={buttonClass}
            disabled={working}
            onClick={() => void work(() => recover(pending))}
          >
            저장 상태 조회
          </Button>
          <Button
            className={buttonClass}
            variant="outline"
            disabled={working}
            onClick={() => void work(() => write(pending))}
          >
            동일 요청으로 저장 재확인
          </Button>
        </section>
      )}
      <section className={panelClass}>
        <h2 className="font-semibold">평가 회차</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 max-w-full flex-1 basis-60 space-y-2 text-sm">
            <span>새 회차 이름</span>
            <input
              className={inputClass}
              value={title}
              maxLength={100}
              disabled={locked}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="예: 합성 기록 검토 1차"
            />
          </label>
          <Button
            className={buttonClass}
            disabled={locked || !catalog || !title.trim()}
            onClick={() => void createRun()}
          >
            합성 50사례 회차 만들기
          </Button>
          <Button
            className={buttonClass}
            variant="outline"
            disabled={locked}
            onClick={() => void work(readCatalog)}
          >
            목록 다시 읽기
          </Button>
        </div>
        <p className="text-xs leading-6 text-muted-foreground">
          회차를 만들어도 정답표·실행 결과·사람 검토는 미기록으로 시작합니다.
        </p>
        {!catalog ? (
          <p className="text-sm">목록 확인 중</p>
        ) : catalog.runs.length === 0 ? (
          <p className="text-sm">아직 보관한 평가 회차가 없습니다.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {catalog.runs.map((item) => (
              <Button
                key={item.id}
                className={buttonClass}
                variant={run?.id === item.id ? "default" : "outline"}
                disabled={locked}
                onClick={() => void openRun(item.id)}
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {item.title} · 버전 {item.revision}
                </span>
              </Button>
            ))}
          </div>
        )}
      </section>
      {run && (
        <>
          <section className={panelClass}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="min-w-0 max-w-full text-lg font-semibold [overflow-wrap:anywhere]">
                {run.title}
              </h2>
              <div className="flex min-w-0 max-w-full flex-wrap gap-3">
                <label className="min-w-0 max-w-full text-sm">
                  기록 버전{" "}
                  <select
                    aria-label="기록 버전"
                    className="min-h-11 max-w-full rounded border p-2"
                    value={run.revision}
                    disabled={locked}
                    onChange={(event) => void openRun(run.id, Number(event.target.value))}
                  >
                    {Array.from({ length: run.currentRevision + 1 }, (_, index) => index)
                      .reverse()
                      .map((revision) => (
                        <option key={revision} value={revision}>
                          {revision}
                          {revision === run.currentRevision ? " · 최신" : " · 과거"}
                        </option>
                      ))}
                  </select>
                </label>
                <Button
                  className={buttonClass}
                  variant="outline"
                  disabled={locked}
                  onClick={() => void openRun(run.id, undefined, true)}
                >
                  최신 기록 불러오기
                </Button>
                <Button
                  className={buttonClass}
                  variant="outline"
                  disabled={locked}
                  onClick={() => void download()}
                >
                  이 버전 JSON 내려받기
                </Button>
              </div>
            </div>
            {historical && (
              <p className="rounded-lg bg-muted/40 p-3 text-sm">
                과거 버전을 읽고 있습니다. 이전 기록을 덮어쓰지 않습니다.
              </p>
            )}
            {!run.manifestCurrent && (
              <p className="rounded-lg bg-amber-50 p-3 text-sm">
                현재 합성 사례 묶음과 연결값이 다릅니다. 과거 기록은 보존하며 새 평가 회차에서
                진행해 주세요.
              </p>
            )}
            <p className="text-sm">
              아래 수치는 입력된 기록의 집계입니다. 출시·기관 승인·실제 AI 품질의 합격 판정이
              아닙니다.
            </p>
            {summary ? (
              <>
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {Object.entries(qualityStatusLabels).map(([status, label]) => (
                    <div key={status} className="rounded-lg border p-3">
                      <dt className="text-xs">{label}</dt>
                      <dd className="mt-1 text-lg font-semibold">
                        {summary.counts[status as keyof typeof qualityStatusLabels]}건
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="text-sm">
                  실제 AI로 기입된 사례 {summary.actualAiRecorded}건 · 정답표 기록{" "}
                  {summary.answerKeysRecorded}건 · 2인 검토 기록 {summary.reviewedByTwo}건. 수행
                  사실을 자동 확인한 수치가 아닙니다.
                </p>
                <details>
                  <summary className="cursor-pointer text-sm">집계 범위와 한계</summary>
                  <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
                    {summary.limitations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </details>
              </>
            ) : (
              <p className="text-sm">
                이 버전의 집계를 제공할 수 없습니다. 보관한 기록을 확인해 주세요.
              </p>
            )}
          </section>
          <section className={panelClass}>
            <label className="block space-y-2 text-sm">
              <span className="font-semibold">검토할 합성 사례</span>
              <select
                className={inputClass}
                value={fixtureId}
                disabled={locked}
                onChange={(event) => {
                  if (mayReplace()) editFrom(run, event.target.value);
                }}
              >
                {run.manifest.map((item) => (
                  <option key={item.fixtureId} value={item.fixtureId}>
                    {item.label} ·{" "}
                    {summary
                      ? qualityStatusLabels[
                          summary.cases.find((entry) => entry.fixtureId === item.fixtureId)
                            ?.status ?? "unevaluated"
                        ]
                      : "집계 없음"}
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <>
                <p className="text-sm">
                  기록 상태: {outcome ? qualityStatusLabels[outcome.status] : "집계 없음"}
                </p>
                <details>
                  <summary className="cursor-pointer text-sm">사례의 기대 점검 항목</summary>
                  <p className="mt-2 text-xs">
                    합성 사례 설계용 안내입니다. 사람이 작성한 정답표를 대신하지 않습니다.
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {selected.expectedChecks.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </details>
                <Button
                  className={buttonClass}
                  variant="outline"
                  disabled={locked}
                  onClick={() => void inspectFixture()}
                >
                  합성 입력·원고 보기
                </Button>
                {fixtureDetails !== null && (
                  <details open>
                    <summary className="cursor-pointer text-sm">합성 사례 입력</summary>
                    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-4 text-xs">
                      {qualityRecordText(fixtureDetails)}
                    </pre>
                  </details>
                )}
                <label className="block space-y-2 text-sm">
                  <span className="font-semibold">사례 평가 JSON</span>
                  <textarea
                    spellCheck={false}
                    className={`${inputClass} min-h-96 font-mono text-xs`}
                    value={draft}
                    readOnly={historical}
                    disabled={locked}
                    maxLength={QUALITY_EDITOR_BYTES}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                </label>
                <p className="text-xs leading-6 text-muted-foreground">
                  선택한 사례의 연결값을 유지하세요. 실행·정답표·원고가 바뀌면 해당 결과를 다시
                  검토해야 합니다. 기존 검토의 연결값을 자동 갱신하지 않습니다. 저장 시 서버가
                  형식과 연결을 검증합니다.
                </p>
                {staleDraft && dirty && (
                  <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
                    <p>
                      초안은 기록 버전 {editorRevision}에서 시작했습니다. 아래 저장된 기록과 대조한
                      뒤 이어가세요.
                    </p>
                    <Button
                      className={buttonClass}
                      variant="outline"
                      disabled={locked || historical || editorManifest !== run.manifestDigest}
                      onClick={() => {
                        setEditorRevision(run.revision);
                        setMessage(
                          "초안 내용은 그대로 유지했습니다. 현재 저장 기록과 대조한 입력을 새 버전으로 저장할 수 있습니다.",
                        );
                      }}
                    >
                      현재 기록과 대조 후 이 초안 사용
                    </Button>
                  </div>
                )}
                <details>
                  <summary className="cursor-pointer text-sm">선택한 버전에 저장된 JSON</summary>
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-4 text-xs">
                    {qualityRecordText(record)}
                  </pre>
                </details>
                <div className="flex flex-wrap gap-3">
                  <Button
                    className={buttonClass}
                    disabled={locked || !dirty || historical || staleDraft || !run.manifestCurrent}
                    onClick={() => void saveRecord()}
                  >
                    서버 검증 후 새 버전 저장
                  </Button>
                  <Button
                    className={buttonClass}
                    variant="outline"
                    disabled={locked || historical || !run.manifestCurrent}
                    onClick={() => {
                      if (mayReplace()) {
                        setDraft(qualityRecordText(emptyQualityEvaluation(selected)));
                        setEditorRevision(run.revision);
                        setEditorManifest(run.manifestDigest);
                      }
                    }}
                  >
                    미평가 템플릿 불러오기
                  </Button>
                </div>
              </>
            )}
          </section>
        </>
      )}
      <QualityCandidateRegistryPanel
        blockedReason={
          working || pending || dirty || title.trim()
            ? "평가 회차의 작성·저장 상태를 먼저 정리해 주세요."
            : ""
        }
        onBusyChange={setRegistryLocked}
      />
    </section>
  );
}
