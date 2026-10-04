"use client";
import { useEffect, useRef, useState } from "react";
import { sectionDefinitions, type StudioCase } from "@/lib/studio-schema";
import { planSupplementExecutionCommandSchema } from "@/lib/studio-plan-supplement-execution-types";
import {
  planSupplementAdoptionCommandSchema,
  type PlanSupplementAdoptionInspection,
} from "@/lib/studio-plan-supplement-adoption-types";
import type { PlanSupplementInput } from "@/lib/studio-plan-supplement-types";
import {
  SupplementRequestJournal,
  supplementBrowserLock,
  supplementTransport,
  supplementInput,
  validateSupplementPreview,
  validateSupplementComparison,
  type SupplementStatus,
  type SupplementPreview,
  type SupplementComparison,
  type SupplementCommand,
} from "./plan-supplement-ui";
import styles from "./guided-workspace.module.css";

type Props = {
  company: StudioCase;
  onCompany: (company: StudioCase) => void;
  onBusyChange: (label: string) => void;
  onUnsettledChange: (value: boolean) => void;
  onClose: () => void;
  initialSelection?: { sourceId: string; sectionKey: PlanSupplementInput["sectionKey"] };
};
export function PlanSupplementPanel({
  company,
  onCompany,
  onBusyChange,
  onUnsettledChange,
  onClose,
  initialSelection,
}: Props) {
  const [status, setStatus] = useState<SupplementStatus | null>(null);
  const [pending, setPending] = useState<SupplementCommand | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [sectionKey, setSectionKey] = useState<PlanSupplementInput["sectionKey"]>(
    initialSelection?.sectionKey ?? "development",
  );
  const [sourceIds, setSourceIds] = useState<string[]>(() =>
    initialSelection &&
    company.sources.some(
      (s) => s.id === initialSelection.sourceId && s.extraction !== "pending" && s.text.trim(),
    )
      ? [initialSelection.sourceId]
      : [],
  );
  const [preview, setPreview] = useState<{
    value: SupplementPreview;
    input: PlanSupplementInput;
  } | null>(null);
  const [closure, setClosure] = useState<PlanSupplementAdoptionInspection | null>(null);
  const [closeConsent, setCloseConsent] = useState(false);
  const [comparison, setComparison] = useState<SupplementComparison | null>(null);
  const [consent, setConsent] = useState(false),
    [adoptConsent, setAdoptConsent] = useState(false);
  const [working, setWorking] = useState(""),
    [writing, setWriting] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const journal = useRef<SupplementRequestJournal | null>(null);
  const initialRead = useRef<Promise<{
    value: SupplementStatus;
    saved: SupplementCommand | null;
  }> | null>(null);
  const flight = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true);
  const current = status?.company ?? company,
    plan = current.plans.at(-1);
  const unresolved =
    !!pending ||
    !!status?.active ||
    !!status?.retainedCapture ||
    !!status?.executions.some(
      (item) => item.state === "result-unconfirmed" || item.state === "unobserved",
    );
  useEffect(() => {
    onUnsettledChange(unresolved || writing);
    return () => onUnsettledChange(false);
  }, [onUnsettledChange, unresolved, writing]);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    // Strict Mode subscribers share one read; storage access and failures stay in the async read.
    initialRead.current ??= Promise.resolve().then(async () => {
      let storage: Storage;
      try {
        storage = window.localStorage;
      } catch {
        throw Error(
          "이 브라우저에서 요청 기록을 보관할 수 없습니다. 수정안을 전송하지 않았습니다.",
        );
      }
      const port =
        journal.current ??
        new SupplementRequestJournal(
          company.id,
          storage,
          supplementBrowserLock,
          supplementTransport(company.id),
        );
      journal.current = port;
      const value = await port.read();
      return { value, saved: await port.pending() };
    });
    void initialRead.current
      .then(({ value, saved }) => {
        if (active) {
          setStatus(value);
          setPending(saved);
        }
      })
      .catch((error) => {
        if (active)
          setError(error instanceof Error ? error.message : "저장 상태를 확인할 수 없습니다.");
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [company.id]);
  function invalidate() {
    epoch.current++;
    setPreview(null);
    setComparison(null);
    setConsent(false);
    setAdoptConsent(false);
    setClosure(null);
    setCloseConsent(false);
    setNotice("");
  }
  async function task(
    label: string,
    action: (port: SupplementRequestJournal) => Promise<void>,
    write = false,
  ) {
    if (flight.current || !journal.current) return;
    flight.current = true;
    setWorking(label);
    setError("");
    if (write) {
      setWriting(true);
      onBusyChange(label);
    }
    try {
      await action(journal.current);
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : "원래 요청의 저장 상태를 확인해 주세요.");
    } finally {
      if (mounted.current) {
        try {
          setPending(await journal.current.pending());
        } catch {
          setError("브라우저 요청 기록을 확인할 수 없습니다. 새 요청을 만들지 않았습니다.");
        }
        setWorking("");
        setWriting(false);
      }
      if (write) onBusyChange("");
      flight.current = false;
    }
  }
  async function accept(value: SupplementStatus) {
    if (!mounted.current) return;
    if (value.company.id !== company.id || value.company.revision < current.revision)
      throw Error("현재 회사보다 이전 저장 상태입니다. 다시 확인해 주세요.");
    setStatus(value);
    onCompany(value.company);
  }
  function read() {
    if (flight.current) return;
    invalidate();
    void task("저장 상태 확인 중", async (port) => {
      await accept(await port.read());
    });
  }
  const disabled = !!working || unresolved || !status;
  const sourceCharacters = current.sources
    .filter((item) => sourceIds.includes(item.id))
    .reduce((sum, item) => sum + item.text.length, 0);
  return (
    <section className={styles.sheet} aria-label="한 항목 보완 수정안">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className={styles.subheading}>보완 자료로 한 항목 수정하기</h3>
        <button
          type="button"
          className={styles.link}
          disabled={writing}
          onClick={() => {
            epoch.current++;
            onClose();
          }}
        >
          계획서로 돌아가기
        </button>
      </div>
      <p className={styles.helper}>
        보관한 질문과 관련 자료로 수정안을 만들고, 현재 문장과 비교한 뒤 새 버전으로 저장합니다.
        원고의 사실 확인은 별도로 필요합니다.
      </p>
      {working && <p role="status">{working}</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.helper}>
          {notice}
        </p>
      )}
      <button type="button" className={styles.link} disabled={!!working} onClick={read}>
        저장 상태 확인
      </button>
      {pending && (
        <div className="my-4 rounded border p-4">
          <p>
            이전 요청의 결과가 아직 확인되지 않았습니다. 새 요청을 만들지 않고 원래 요청을
            확인합니다.
          </p>
          <button
            type="button"
            className={styles.link}
            disabled={!!working}
            onClick={() =>
              void task(
                "원래 요청 확인 중",
                async (port) => {
                  invalidate();
                  await accept(await port.execute(pending, true));
                },
                true,
              )
            }
          >
            원래 요청으로 이어가기
          </button>
          {pending.action === "adopt-section-supplement" && (
            <section className="mt-4" aria-label="이전 채택 요청 종료 확인">
              <button
                type="button"
                className={styles.link}
                disabled={!!working}
                onClick={() => {
                  if (flight.current) return;
                  invalidate();
                  const token = epoch.current;
                  void task("이전 요청 종료 가능 여부 확인 중", async (port) => {
                    const result = await port.inspectClosure(pending);
                    if (!mounted.current || epoch.current !== token) return;
                    await accept(result.status);
                    setClosure(result.inspection);
                    if (!result.inspection)
                      setNotice("원래 요청으로 저장한 새 버전을 확인했습니다.");
                  });
                }}
              >
                이 요청의 종료 가능 여부 확인
              </button>
              {closure && !closure.canClose && (
                <p className={styles.helper}>
                  이 요청이 저장되지 않았다고 확정할 수 없습니다. 요청 기록을 유지합니다. 저장
                  상태를 확인하거나 원래 요청으로 이어가세요.
                </p>
              )}
              {closure?.canClose && (
                <div className="mt-3 rounded border p-3">
                  <p>
                    이 요청으로 저장된 버전은 없습니다. 자료 또는 원고가 바뀌어 이 요청의 이전
                    기준으로는 저장할 수 없습니다.
                  </p>
                  <p className={styles.helper}>
                    종료하면 이 브라우저의 대기 요청만 닫습니다. 서버의 수정안·응답·원고와 다른
                    요청으로 저장한 버전은 그대로 보관합니다. 새 AI 요청이나 원고 저장은 실행하지
                    않습니다.
                  </p>
                  <label className="my-3 flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={closeConsent}
                      disabled={!!working}
                      onChange={(event) => setCloseConsent(event.target.checked)}
                    />
                    저장되지 않은 이 요청의 대기를 종료하겠습니다.
                  </label>
                  <button
                    type="button"
                    className={styles.link}
                    disabled={!!working || !closeConsent}
                    onClick={() => {
                      if (flight.current) return;
                      const expected = closure;
                      setCloseConsent(false);
                      void task(
                        "이전 요청 종료 전 다시 확인 중",
                        async (port) => {
                          const result = await port.closeUnadopted(expected, true);
                          if (!mounted.current) return;
                          await accept(result.status);
                          invalidate();
                          setNotice(
                            result.outcome === "adopted"
                              ? "원래 요청으로 저장한 새 버전을 확인했습니다."
                              : "저장되지 않은 이전 요청의 대기를 종료했습니다. 보관한 원고와 수정안은 그대로입니다.",
                          );
                        },
                        true,
                      );
                    }}
                  >
                    저장되지 않은 이전 요청 종료
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      )}
      {status?.retainedCapture && !status.active && (
        <button
          type="button"
          className={styles.link}
          disabled={!!working}
          onClick={() =>
            void task(
              "보관 응답 저장 복구 중",
              async (port) => {
                const run = status.executions.find((item) => item.record.capture === null);
                if (!run) throw Error("원래 요청의 저장 상태를 확인해 주세요.");
                invalidate();
                await accept(await port.recover(run.record.command));
              },
              true,
            )
          }
        >
          받아 둔 응답 저장 복구
        </button>
      )}
      {status?.active && (
        <p className={styles.helper}>
          원래 수정안 요청이 진행 중입니다. 잠시 후 저장 상태를 확인해 주세요.
        </p>
      )}
      {plan?.content.interviewQuestions.length ? (
        <fieldset disabled={disabled} className="my-6 grid min-w-0 gap-4">
          <legend className={styles.label}>기준 원고 v{plan.version} · 질문과 관련 항목</legend>
          <label className={styles.label}>
            보완할 질문
            <select
              aria-label="보완할 질문"
              className="mt-2 block w-full min-w-0 rounded border bg-white p-3 text-sm"
              value={questionIndex}
              onChange={(event) => {
                invalidate();
                setQuestionIndex(Number(event.target.value));
              }}
            >
              {plan.content.interviewQuestions.map((question, index) => (
                <option key={index} value={index}>
                  {index + 1}. {question}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.label}>
            수정할 항목
            <select
              aria-label="수정할 항목"
              className="mt-2 block w-full min-w-0 rounded border bg-white p-3 text-sm"
              value={sectionKey}
              onChange={(event) => {
                invalidate();
                setSectionKey(event.target.value as typeof sectionKey);
              }}
            >
              {sectionDefinitions.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <div
            className="max-h-64 overflow-y-auto rounded border p-3"
            aria-label="보완에 사용할 자료"
          >
            <p className={styles.helper}>
              본문이 준비된 자료 중 최대 6개 · 60,000자. 답변·메모도 자료에서 선택합니다.
            </p>
            {current.sources.map((source) => {
              const usable = source.extraction !== "pending" && !!source.text.trim();
              return (
                <label key={source.id} className="my-2 flex items-start gap-2 break-all">
                  <input
                    type="checkbox"
                    checked={sourceIds.includes(source.id)}
                    disabled={!usable}
                    onChange={(event) => {
                      invalidate();
                      setSourceIds((previous) =>
                        event.target.checked
                          ? [...previous, source.id]
                          : previous.filter((id) => id !== source.id),
                      );
                    }}
                  />
                  {source.name} ·{" "}
                  {usable ? `${source.text.length.toLocaleString()}자` : "본문 판독·채택 필요"}
                </label>
              );
            })}
          </div>
          <p>
            {sourceIds.length}개 선택 · {sourceCharacters.toLocaleString()}자
          </p>
          <button
            type="button"
            className={styles.primary}
            disabled={!sourceIds.length || sourceIds.length > 6 || sourceCharacters > 60000}
            onClick={() => {
              if (flight.current) return;
              const token = ++epoch.current;
              setPreview(null);
              setComparison(null);
              setConsent(false);
              setAdoptConsent(false);
              void task("전송 범위 확인 중", async () => {
                const input = await supplementInput(current, questionIndex, sectionKey, sourceIds);
                if (!input) throw Error("보관한 원고 질문과 본문이 준비된 자료를 선택해 주세요.");
                const raw = await supplementTransport(company.id)("execution", {
                  action: "prepare-ai",
                  input,
                });
                const value = await validateSupplementPreview(raw, current, input);
                if (mounted.current && epoch.current === token) setPreview({ input, value });
              });
            }}
          >
            전송 범위 확인
          </button>
        </fieldset>
      ) : (
        <p className={styles.helper}>보관한 원고의 준비 질문이 있어야 수정안을 만들 수 있습니다.</p>
      )}
      {preview && (
        <section className="my-5 rounded border p-4" aria-label="수정안 전송 동의">
          <h4 className={styles.subheading}>이 범위로 수정안을 만들까요?</h4>
          <p className={styles.helper}>
            OpenAI · {preview.value.approval.model} · 1회 요청 · 자동 재시도 없음
          </p>
          <p>선택한 질문, 지정 항목의 제목·본문, 선택 자료의 이름·본문이 전송됩니다.</p>
          <p className={styles.helper}>
            {preview.value.characters.toLocaleString()} / 240,000자 · 실제 토큰 적합성과 후속 응답
            품질은 별도입니다.
          </p>
          <details className={styles.details}>
            <summary>전송할 정확한 내용 읽기</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
              {preview.value.payload}
            </pre>
          </details>
          <label className="my-4 flex items-start gap-2">
            <input
              type="checkbox"
              checked={consent}
              disabled={disabled}
              onChange={(event) => setConsent(event.target.checked)}
            />
            표시한 내용을 전송해 이 항목의 수정안을 1회 만드는 데 동의합니다.
          </label>
          {!preview.value.aiConfigured && <p>설정에서 AI 연결을 확인해 주세요.</p>}
          <button
            type="button"
            className={styles.primary}
            disabled={disabled || !consent || !preview.value.aiConfigured}
            onClick={() => {
              if (flight.current) return;
              const command = planSupplementExecutionCommandSchema.parse({
                action: "propose-section",
                clientRequestId: crypto.randomUUID(),
                input: preview.input,
                approval: preview.value.approval,
                approved: true,
              });
              void task(
                "수정안 만드는 중",
                async (port) => {
                  invalidate();
                  await accept(await port.execute(command));
                },
                true,
              );
            }}
          >
            동의하고 수정안 만들기
          </button>
        </section>
      )}
      {!!status?.executions.length && (
        <section className="my-5" aria-label="수정안 요청 이력">
          <h4 className={styles.subheading}>보관한 수정안 요청</h4>
          {status.executions
            .slice()
            .reverse()
            .map((item) => {
              const receipt = status.company.planSupplementAdoptions?.find(
                (entry) => entry.command.executionId === item.record.id,
              );
              const labels = {
                "comparison-ready": "비교 가능 · 내용 확인 필요",
                "result-unconfirmed": "결과 미확인 · 새 요청으로 재시도하지 않음",
                "context-changed": "자료 또는 원고 변경 · 이전 수정안 채택 불가",
                "captured-response-unusable": "보관 응답을 수정안으로 사용할 수 없음",
                "not-sent": "전송 시작 전 중단",
                unobserved: "응답 미관측 · 자동 재시도 없음",
              };
              return (
                <article className="my-3 rounded border p-3" key={item.record.id}>
                  <p>
                    {item.record.command.input.target.kind === "visit-question"
                      ? item.record.command.input.target.questionText
                      : "원래 질문"}
                  </p>
                  <p className={styles.helper}>
                    {receipt
                      ? `새 버전 v${receipt.planVersion} 저장됨 · 사실 확인 별도`
                      : labels[item.state]}
                  </p>
                  {item.state === "comparison-ready" && !receipt && (
                    <button
                      type="button"
                      className={styles.link}
                      disabled={!!working || unresolved}
                      onClick={() => {
                        if (flight.current) return;
                        const token = ++epoch.current;
                        setComparison(null);
                        setAdoptConsent(false);
                        setPreview(null);
                        void task("수정안 비교 준비 중", async () => {
                          const raw = await supplementTransport(company.id)("adoption", {
                            action: "prepare-adoption",
                            revision: status.company.revision,
                            executionId: item.record.id,
                          });
                          const value = await validateSupplementComparison(
                            raw,
                            status,
                            item.record.id,
                          );
                          if (mounted.current && epoch.current === token) setComparison(value);
                        });
                      }}
                    >
                      현재 원고와 비교
                    </button>
                  )}
                </article>
              );
            })}
        </section>
      )}
      {comparison && (
        <section aria-label="수정 전후 비교" className="my-5">
          <h4 className={styles.subheading}>
            {comparison.proposal.before.title} · 원고 v{comparison.proposal.basePlanVersion}
          </h4>
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <article className="min-w-0 rounded border p-4">
              <h5>현재 문장</h5>
              <p className="whitespace-pre-wrap break-words">
                {comparison.proposal.before.content}
              </p>
            </article>
            <article className="min-w-0 rounded border p-4">
              <h5>수정안</h5>
              <p className="whitespace-pre-wrap break-words">{comparison.proposal.after.content}</p>
            </article>
          </div>
          <details className={styles.details}>
            <summary>추가 인용과 확인 사항</summary>
            {comparison.proposal.additions.map((item, index) => (
              <p key={index} className="my-3 whitespace-pre-wrap break-words">
                {item.sourceName}: {item.quote}
              </p>
            ))}
            {comparison.proposal.warnings.map((item) => (
              <p key={item} className={styles.helper}>
                {item}
              </p>
            ))}
          </details>
          <label className="my-4 flex items-start gap-2">
            <input
              type="checkbox"
              checked={adoptConsent}
              disabled={!!working || unresolved}
              onChange={(event) => setAdoptConsent(event.target.checked)}
            />
            수정 전후를 비교했으며, 이 항목의 수정안을 새 버전으로 보관하겠습니다. 사실 확인은
            별도로 진행합니다.
          </label>
          <button
            type="button"
            className={styles.primary}
            disabled={!!working || unresolved || !adoptConsent}
            onClick={() => {
              if (flight.current) return;
              const command = planSupplementAdoptionCommandSchema.parse({
                ...comparison.selection,
                action: "adopt-section-supplement",
                clientRequestId: crypto.randomUUID(),
                confirmed: true,
              });
              void task(
                "새 버전 저장 중",
                async (port) => {
                  const value = await port.execute(command);
                  await accept(value);
                  invalidate();
                  const receipt = value.company.planSupplementAdoptions?.find(
                    (item) => item.command.clientRequestId === command.clientRequestId,
                  );
                  if (!receipt)
                    throw Error("채택 결과가 미확인입니다. 원래 요청의 저장 상태를 확인해 주세요.");
                  setNotice(
                    `새 버전 v${receipt.planVersion}에 저장했습니다. 이전 원고는 그대로 보관되어 있습니다.`,
                  );
                },
                true,
              );
            }}
          >
            비교한 수정안을 새 버전으로 저장
          </button>
        </section>
      )}
      <p className={styles.helper}>
        응답이 끊기면 저장 상태를 확인하세요. 같은 브라우저·사이트에 원래 요청의 신원을 보관합니다.
        파일·원고 본문과 응답은 브라우저 요청 기록에 저장하지 않습니다.
      </p>
    </section>
  );
}
