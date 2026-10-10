"use client";
import { useEffect, useRef, useState } from "react";
import { sectionDefinitions, type StudioCase } from "@/lib/studio-schema";
import {
  emptyPublicEvidence,
  publicEvidenceDraftSchema,
  preparePublicEvidence,
  type PublicEvidenceDraft,
  type PublicEvidenceRequest,
} from "@/lib/studio-public-evidence";
import { jsonBody, studioFetch, useDirty } from "./shared";
import {
  PublicEvidenceJournal,
  publicEvidenceBrowserLock,
  publicEvidenceBrowserStorage,
  publicEvidenceRecoveryMessage,
  publicEvidenceRecoveryKey,
  type PublicEvidenceReceipt,
} from "./public-evidence-recovery";
import styles from "./guided-workspace.module.css";
import { PublicResearchLinks } from "./public-research-links";
import { publicResearchCandidateFields } from "@/lib/studio-public-research-result";
import {
  applyPublicCellEvidence,
  canFillPublicCellEvidence,
} from "@/lib/studio-public-cell-evidence";
import { applyPublicCommentEvidence } from "@/lib/studio-public-comment-evidence";
import { isPublicDiscoveryPage } from "@/lib/studio-public-research";
export function PublicEvidencePanel({
  company,
  blocked,
  onCompany,
  onBusyChange,
  onDirtyChange,
  onUnsettledChange,
  onClose,
  onSupplement,
}: {
  company: StudioCase;
  blocked: boolean;
  onCompany: (c: StudioCase) => void;
  onBusyChange: (value: string) => void;
  onDirtyChange: (value: boolean) => void;
  onUnsettledChange: (value: boolean) => void;
  onClose: () => void;
  onSupplement: (sourceId: string, sectionKey: PublicEvidenceDraft["sectionKey"]) => void;
}) {
  const [base, setBase] = useState(() => ({ id: company.id, revision: company.revision }));
  const [draft, setDraft] = useState<PublicEvidenceDraft>({ ...emptyPublicEvidence });
  const [confirmed, setConfirmed] = useState(false),
    [working, setWorking] = useState(false);
  const [pending, setPending] = useState<PublicEvidenceReceipt | null>(null);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<PublicEvidenceRequest | null>(null);
  const [error, setError] = useState("");
  const [recoveryReadError, setRecoveryReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const flight = useRef(false),
    mounted = useRef(true),
    currentCompany = useRef(company);
  useEffect(() => {
    currentCompany.current = company;
  }, [company]);
  const dirty = !saved && JSON.stringify(draft) !== JSON.stringify(emptyPublicEvidence);
  useDirty(dirty, onDirtyChange);
  useEffect(() => {
    onUnsettledChange(working || !!pending || !ready);
    return () => onUnsettledChange(false);
  }, [working, pending, ready, onUnsettledChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty && !pending) return;
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty, pending]);
  function journal() {
    return new PublicEvidenceJournal(
      base.id,
      publicEvidenceBrowserStorage(),
      publicEvidenceBrowserLock,
      (command) =>
        studioFetch<unknown>(
          `/api/studio/cases/${base.id}`,
          command ? { method: "PATCH", ...jsonBody(command) } : undefined,
        ),
    );
  }
  // Observe only identities, never event payloads or source contents. A removed or
  // replaced record cannot acknowledge or replace the request already held here.
  useEffect(() => {
    if (working) return;
    let cancelled = false,
      generation = 0;
    const read = () => {
      const started = ++generation;
      setReady(false);
      void Promise.resolve()
        .then(() =>
          new PublicEvidenceJournal(
            base.id,
            publicEvidenceBrowserStorage(),
            publicEvidenceBrowserLock,
            async () => {
              throw Error("Explicit recovery required");
            },
          ).read(),
        )
        .then((record) => {
          if (!cancelled && started === generation) {
            setPending((original) => original ?? record);
            setReady(true);
            setRecoveryReadError("");
          }
        })
        .catch((error) => {
          if (!cancelled && started === generation) {
            setReady(false);
            setRecoveryReadError(publicEvidenceRecoveryMessage(error, "storage"));
          }
        });
    };
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== publicEvidenceRecoveryKey(base.id)) return;
      // Read current local storage again; delayed event.newValue is not authoritative.
      try {
        if (event.storageArea !== publicEvidenceBrowserStorage()) return;
        read();
      } catch (error) {
        setReady(false);
        setRecoveryReadError(publicEvidenceRecoveryMessage(error, "storage"));
      }
    };
    window.addEventListener("storage", changed);
    // Re-read after every operation too, covering events delivered while it held the lock.
    void Promise.resolve().then(() => {
      if (!cancelled) read();
    });
    return () => {
      cancelled = true;
      window.removeEventListener("storage", changed);
    };
  }, [base.id, working]);
  async function readRecovery() {
    if (flight.current) return;
    flight.current = true;
    setWorking(true);
    try {
      const record = await journal().read();
      if (mounted.current) {
        setPending((original) => original ?? record);
        setReady(true);
        setError("");
      }
    } catch (error) {
      if (mounted.current) {
        setReady(false);
        setError(publicEvidenceRecoveryMessage(error, "storage"));
      }
    } finally {
      flight.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  const changed = company.id !== base.id || company.revision !== base.revision;
  function field<K extends keyof PublicEvidenceDraft>(key: K, value: PublicEvidenceDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setConfirmed(false);
    setError("");
  }
  function accept(
    result: { company: StudioCase; request: PublicEvidenceRequest },
    preserveCurrent = false,
  ) {
    if (!mounted.current) return;
    onCompany(result.company);
    if (preserveCurrent) {
      setNotice(
        "다른 창의 공개 근거 저장을 확인했습니다. 이 창의 입력과 이전에 선택한 자료는 그대로 유지합니다.",
      );
    } else {
      setSaved(result.request);
      setNotice("");
      onDirtyChange(false);
    }
    setPending(null);
    setError("");
  }
  async function save() {
    if (flight.current || !ready || blocked || pending || saved || changed) return;
    let request: PublicEvidenceRequest;
    try {
      request = preparePublicEvidence(
        company,
        draft,
        crypto.randomUUID(),
        new Date().toISOString(),
        confirmed,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "입력 내용을 확인해 주세요.");
      return;
    }
    flight.current = true;
    setWorking(true);
    setError("");
    setSubmittedId(request.command.source.id);
    setNotice("");
    onBusyChange("공개 근거 후보를 보관하고 있습니다");
    try {
      accept(
        await journal().save(
          request,
          () => currentCompany.current,
          (record) => {
            if (mounted.current) setPending(record);
          },
        ),
      );
    } catch (error) {
      // Also inspect a partial storage write; never send if persistence/read-back failed.
      try {
        const record = await journal().read();
        if (mounted.current) {
          setPending((original) => original ?? record);
          setError(publicEvidenceRecoveryMessage(error, record ? "unconfirmed" : "storage"));
        }
      } catch (readError) {
        if (mounted.current) {
          setReady(false);
          setError(publicEvidenceRecoveryMessage(readError, "storage"));
        }
      }
    } finally {
      flight.current = false;
      onBusyChange("");
      if (mounted.current) setWorking(false);
    }
  }
  async function inspect() {
    if (flight.current || !pending || !ready) return;
    flight.current = true;
    setWorking(true);
    setError("");
    try {
      accept(
        await journal().recover(pending, () => currentCompany.current),
        pending.sourceId !== submittedId && (dirty || !!saved),
      );
    } catch (e) {
      if (mounted.current) setError(publicEvidenceRecoveryMessage(e));
    } finally {
      flight.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function resumeDraft() {
    if (
      flight.current ||
      !ready ||
      blocked ||
      pending ||
      saved ||
      !dirty ||
      !changed ||
      company.id !== base.id
    )
      return;
    flight.current = true;
    setWorking(true);
    setError("");
    try {
      const latest = await journal().refresh(() => currentCompany.current);
      if (mounted.current) {
        onCompany(latest);
        setBase({ id: latest.id, revision: latest.revision });
        setConfirmed(false);
        setSubmittedId(null);
        setNotice(
          "최신 자료 기준으로 입력을 이어 쓸 수 있습니다. 내용과 출처를 다시 확인하고 보관 동의에 표시해 주세요.",
        );
      }
    } catch (error) {
      // A request may have appeared while the explicit read was in flight.
      try {
        const record = await journal().read();
        if (mounted.current) {
          setPending((original) => original ?? record);
          setError(publicEvidenceRecoveryMessage(error, "refresh"));
        }
      } catch (readError) {
        if (mounted.current) {
          setReady(false);
          setError(publicEvidenceRecoveryMessage(readError, "storage"));
        }
      }
    } finally {
      flight.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  function close() {
    // Keep the original request available until its exact saved source is acknowledged.
    // Closing an uncertain save would discard its identity and permit a duplicate submission.
    if (flight.current || pending || !ready) return;
    if (dirty && !window.confirm("입력 중인 내용은 이 창을 닫으면 사라집니다. 닫을까요?")) return;
    onDirtyChange(false);
    onClose();
  }
  const inputClass = "mt-1 block w-full min-w-0 rounded border bg-white p-2 text-sm";
  function textField(
    key: "title" | "url" | "publisher" | "publishedOn" | "period" | "readOn",
    label: string,
    type = "text",
  ) {
    return (
      <label className={styles.label}>
        {label}
        <input
          type={type}
          className={inputClass}
          value={draft[key]}
          onChange={(e) => field(key, e.target.value)}
        />
      </label>
    );
  }
  const parsed = publicEvidenceDraftSchema.safeParse(draft);
  return (
    <section className={styles.sheet} aria-label="공개 근거 후보 보관">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className={styles.subheading}>공개 근거 보완</h3>
        <button
          type="button"
          className={styles.link}
          disabled={working || !!pending || !ready}
          aria-describedby={pending ? "public-evidence-pending" : undefined}
          onClick={close}
        >
          닫기
        </button>
      </div>
      <p className={styles.helper}>
        직접 읽은 공개 자료의 발췌와 출처를 이 PC에 보관합니다. 시장·산업 정보가 우리 회사의 실적을
        증명하는 것은 아닙니다. 원고 수정과 AI 전송은 별도로 확인합니다.
      </p>
      {(recoveryReadError || error) && (
        <p role="alert" className={styles.error}>
          {recoveryReadError || error}
        </p>
      )}
      {notice && !pending && ready && (
        <p role="status" className={styles.helper}>
          {notice}
        </p>
      )}
      {pending && pending.sourceId !== submittedId && (dirty || !!saved) && (
        <p role="status" className={styles.helper}>
          다른 창의 저장 요청을 먼저 확인해 주세요. 이 창의 입력과 이전에 선택한 자료는 유지합니다.
        </p>
      )}
      {working && <p role="status">저장 상태 확인 중</p>}
      {!ready && (
        <button
          type="button"
          className={styles.link}
          disabled={working}
          onClick={() => void readRecovery()}
        >
          복구 기록 다시 확인
        </button>
      )}
      {pending && !working && (
        <p id="public-evidence-pending" role="status" className={styles.helper}>
          이전 공개 근거 저장 요청이 미확인입니다. ‘이 자료의 저장 상태 확인’을 눌러 주세요.
          새로고침 후에도 원래 요청을 이어 확인하며 같은 자료를 다시 저장하지 않습니다. 입력 본문은
          브라우저에 보관하지 않으므로 새로고침 후에는 저장이 확인된 본문만 표시합니다.
        </p>
      )}
      {pending && (
        <button
          type="button"
          className={styles.link}
          disabled={working || !ready}
          onClick={() => void inspect()}
        >
          이 자료의 저장 상태 확인
        </button>
      )}
      {saved ? (
        <div className="my-4 space-y-3">
          <p role="status">
            공개 근거 후보를 보관했습니다. 원고 본문은 그대로이며 자료 추가에 따라 기존 원고의 확인
            상태는 해제됩니다.
          </p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">
            {saved.command.source.text}
          </pre>
          {!!company.plans.at(-1)?.content.interviewQuestions.length && (
            <button
              type="button"
              className={styles.link}
              disabled={working || !!pending || !ready}
              onClick={() => {
                if (flight.current || pending || !ready) return;
                onSupplement(saved.command.source.id, saved.sectionKey);
              }}
            >
              이 근거로 원고 보완 준비
            </button>
          )}
          <p className={styles.helper}>
            자료함에서 다시 확인할 수 있습니다. 현재 URL의 내용과 보관한 발췌가 같다는 보장은
            없습니다.
          </p>
        </div>
      ) : (
        <>
          {(!pending || dirty) && (
            <>
              <PublicResearchLinks
                disabled={working || blocked || !!pending || changed || !ready}
                canFill={!draft.title && !draft.url}
                canFillCell={canFillPublicCellEvidence(draft)}
                onCommentEvidence={(result, command, selection) => {
                  if (
                    flight.current ||
                    working ||
                    blocked ||
                    pending ||
                    saved ||
                    changed ||
                    !ready ||
                    !mounted.current
                  )
                    throw Error("현재 입력에 옮길 수 없습니다.");
                  const next = applyPublicCommentEvidence(
                    draft,
                    result,
                    command,
                    selection,
                    base,
                    currentCompany.current,
                  );
                  setDraft(next);
                  setConfirmed(false);
                  setError("");
                }}
                onCellEvidence={(result, command) => {
                  if (
                    flight.current ||
                    working ||
                    blocked ||
                    pending ||
                    saved ||
                    changed ||
                    !ready ||
                    !mounted.current
                  )
                    throw Error("현재 입력에 옮길 수 없습니다.");
                  const next = applyPublicCellEvidence(
                    draft,
                    result,
                    command,
                    base,
                    currentCompany.current,
                  );
                  setDraft(next);
                  setConfirmed(false);
                  setError("");
                }}
                onCandidate={(candidate) => {
                  if (
                    !ready ||
                    working ||
                    blocked ||
                    pending ||
                    changed ||
                    draft.title ||
                    draft.url
                  )
                    return;
                  const fields = publicResearchCandidateFields(candidate);
                  setDraft((d) => (d.title || d.url ? d : { ...d, ...fields }));
                  setConfirmed(false);
                }}
              />
              {changed && (
                <div className="my-3 space-y-2">
                  <p role="alert">
                    회사 자료가 바뀌어 저장을 멈췄습니다. 입력은 그대로 유지됩니다. 미확인 요청을
                    모두 확인한 뒤 최신 자료로 이어쓰기를 선택해 주세요.
                  </p>
                  {dirty && company.id === base.id && (
                    <button
                      type="button"
                      className={styles.link}
                      disabled={working || blocked || !!pending || !ready}
                      onClick={() => void resumeDraft()}
                    >
                      최신 자료로 입력 이어쓰기
                    </button>
                  )}
                </div>
              )}
              <fieldset
                disabled={working || blocked || !!pending || changed || !ready}
                className="my-4 grid min-w-0 gap-4"
              >
                {textField("title", "공개 자료 제목")}
                {textField("url", "원문 URL (HTTPS)", "url")}
                {isPublicDiscoveryPage(draft.url) && (
                  <p role="alert">
                    검색 결과 주소 대신 개별 통계표·보고서의 원문 주소를 입력해 주세요.
                  </p>
                )}
                <label className={styles.label}>
                  원문 발췌
                  <textarea
                    className={inputClass}
                    rows={7}
                    value={draft.quote}
                    onChange={(e) => field("quote", e.target.value)}
                  />
                  <span className={styles.helper}>
                    원문을 그대로 붙여 넣어 주세요. 최대 50,000자이며 넘는 내용을 자동으로 자르지
                    않습니다.
                  </span>
                </label>
                {textField("readOn", "원문을 읽은 날짜 (담당자 기록)", "date")}
                <label className={styles.label}>
                  보완할 항목
                  <select
                    aria-label="보완할 항목"
                    className={inputClass}
                    value={draft.sectionKey}
                    onChange={(e) =>
                      field("sectionKey", e.target.value as PublicEvidenceDraft["sectionKey"])
                    }
                  >
                    {sectionDefinitions.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </label>
                <details className={styles.details}>
                  <summary>발행일·기준 기간·관련성 기록</summary>
                  <div className="mt-3 grid gap-4">
                    {textField("publisher", "발행처 (모르면 비워 두기)")}
                    {textField("publishedOn", "발행일 (원문 표기, 모르면 비워 두기)", "date")}
                    {textField("period", "자료의 기준 기간·대상 (모르면 비워 두기)")}
                    <label className={styles.label}>
                      이 항목과 관련된 이유
                      <textarea
                        className={inputClass}
                        rows={3}
                        value={draft.relevance}
                        onChange={(e) => field("relevance", e.target.value)}
                      />
                    </label>
                    <label className={styles.label}>
                      기존 자료와 다른 점·추가 확인 사항
                      <textarea
                        className={inputClass}
                        rows={3}
                        value={draft.conflicts}
                        onChange={(e) => field("conflicts", e.target.value)}
                      />
                    </label>
                  </div>
                </details>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  발췌와 출처를 확인했으며 후보 자료로 보관하겠습니다. 회사 사실 확인·AI 전송 동의는
                  별도입니다.
                </label>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!confirmed || !parsed.success}
                  onClick={() => void save()}
                >
                  공개 근거 후보 보관
                </button>
                {!parsed.success && dirty && (
                  <p className={styles.helper}>
                    제목·공개 HTTPS 주소·발췌·읽은 날짜를 확인해 주세요. 관련 메모는 각각
                    3,000자까지입니다.
                  </p>
                )}
              </fieldset>
            </>
          )}
          <p className={styles.helper}>
            원문 주소는 자동 조회하지 않습니다. 공개 후보 조회와 원문 확인은 구분합니다. 자료 추가
            시 기존 분석·주제 선택과 원고 확인 상태가 해제됩니다. 원고 본문과 과거 실행은
            보존합니다. 미저장 입력은 현재 창에서만 유지됩니다. 저장을 누르면 본문 없이 원래 요청의
            복구 식별 정보만 이 브라우저에 남깁니다.
          </p>
        </>
      )}
    </section>
  );
}
