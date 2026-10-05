"use client";
import { useEffect, useRef, useState } from "react";
import type { StudioCase } from "@/lib/studio-schema";
import { applicationMetadata } from "@/lib/studio-application-types";
import {
  applicationNumberBindingCommandSchema,
  type ApplicationNumberBindingCommand as Command,
} from "@/lib/studio-application-number-types";
import {
  NumberRequestJournal,
  numberBrowserLock,
  numberTransport,
  type NumberStatus,
  type NumberInspection,
} from "./application-number-ui";
import { Notice, useDirty, selectClass } from "./shared";
type Props = {
  company: StudioCase;
  blockedReason: string;
  onDirtyChange: (dirty: boolean) => void;
  onCompany: (company: StudioCase) => void;
  onClose: () => void;
};
const empty = {
  applicationId: "",
  operation: "bind" as "bind" | "release",
  applicationNumber: "",
  recordedBy: "",
  reason: "",
};
export function ApplicationNumberPanel({
  company,
  blockedReason,
  onDirtyChange,
  onCompany,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(empty),
    [baseRevision, setBaseRevision] = useState(company.revision);
  const [status, setStatus] = useState<NumberStatus | null>(null),
    [pending, setPending] = useState<Command | null>(null);
  const [consent, setConsent] = useState(false),
    [working, setWorking] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [closure, setClosure] = useState<NumberInspection | null>(null),
    [closeConsent, setCloseConsent] = useState(false);
  const journal = useRef<NumberRequestJournal | null>(null),
    initial = useRef<Promise<void> | null>(null);
  const flight = useRef(false),
    mounted = useRef(false),
    current = useRef(company);
  useEffect(() => {
    current.current = company;
  }, [company]);
  const dirty = !!pending || JSON.stringify(draft) !== JSON.stringify(empty);
  useDirty(dirty || working, onDirtyChange);
  const stale =
    company.revision !== baseRevision || (!!status && status.company.revision !== baseRevision);
  const editable = !!status && !working && !blockedReason && !pending && !stale;
  const chosen = status?.current.find((r) => r.applicationId === draft.applicationId);
  function port() {
    return (journal.current ??= new NumberRequestJournal(
      company.id,
      window.localStorage,
      numberBrowserLock,
      numberTransport(company.id),
    ));
  }
  function alive(id: string, revision: number) {
    return mounted.current && current.current.id === id && current.current.revision === revision;
  }
  useEffect(() => {
    mounted.current = true;
    let active = true;
    // Strict Mode shares one initial GET and journal check; no write or replay on mount.
    initial.current ??= Promise.resolve().then(async () => {});
    void initial.current.then(async () => {
      if (!active) return;
      await read();
    });
    return () => {
      active = false;
      mounted.current = false;
    };
    // Company changes are handled by the parent key; revision changes preserve the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function run(task: (p: NumberRequestJournal) => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setWorking(true);
    setError("");
    setClosure(null);
    setCloseConsent(false);
    try {
      await task(port());
    } catch {
      if (mounted.current) {
        setStatus(null);
        setError(
          "연결 상태를 확인하지 못했습니다. 입력과 원래 요청을 유지했습니다. 다시 조회해 주세요.",
        );
      }
    } finally {
      try {
        const value = await port().pending();
        if (mounted.current) setPending(value);
      } catch {
        if (mounted.current)
          setError("브라우저 요청 기록을 읽을 수 없습니다. 새 저장을 중단했습니다.");
      }
      flight.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function read() {
    const id = company.id,
      revision = company.revision;
    await run(async (p) => {
      const result = await p.read(revision);
      if (!alive(id, revision)) return;
      setStatus(result.status);
      setPending(result.pending);
      if (result.receipt)
        setNotice(
          "원래 요청의 저장 기록을 확인했습니다. 현재 연결과 당시 기록은 다를 수 있습니다.",
        );
    });
  }
  function edit<K extends keyof typeof empty>(key: K, value: (typeof empty)[K]) {
    if (!editable) return;
    setDraft((d) => ({ ...d, [key]: value }));
    setConsent(false);
    setNotice("");
    setClosure(null);
  }
  const metadata =
    status && draft.applicationId ? applicationMetadata(status.company, draft.applicationId) : null;
  const parsed = applicationNumberBindingCommandSchema.safeParse({
    action: "record-application-number",
    revision: baseRevision,
    clientRequestId: "00000000-0000-4000-8000-000000000000",
    applicationId: draft.applicationId,
    metadataVersionId: metadata?.metadataVersionId,
    expectedPreviousBindingId: chosen?.record?.id ?? null,
    operation: draft.operation,
    applicationNumber: draft.operation === "release" ? null : draft.applicationNumber,
    recordedBy: draft.recordedBy,
    reason: draft.reason,
    confirmed: true,
  });
  async function save(retry = false) {
    if (blockedReason || !consent || (!retry && (!editable || !parsed.success))) return;
    const command = retry
      ? pending
      : parsed.success
        ? { ...parsed.data, clientRequestId: crypto.randomUUID() }
        : null;
    if (!command) return;
    const id = company.id,
      revision = company.revision;
    setConsent(false);
    await run(async (p) => {
      const result = await p.execute(command, retry);
      if (!alive(id, revision)) return;
      setStatus(result.status);
      setPending(result.pending);
      if (result.receipt) {
        setDraft(empty);
        setBaseRevision(result.status.company.revision);
        setNotice("수동 연결 기록을 보관했습니다. 공식 접수·심사 결과 확인은 아닙니다.");
        onCompany(result.status.company);
      } else
        setNotice(
          "저장 결과가 미확인입니다. 원래 요청으로 조회하거나 명시적으로 다시 확인할 수 있습니다.",
        );
    });
  }
  async function inspectClosure() {
    if (!pending) return;
    const id = company.id,
      revision = company.revision;
    await run(async (p) => {
      const result = await p.inspectClosure(pending);
      if (!alive(id, revision)) return;
      const { command: _, receipt, outcome, ...value } = result;
      void _;
      setStatus(value);
      setClosure(result);
      if (receipt)
        setNotice("원래 저장 기록을 찾았습니다. 최신 연결 반영으로 현재 상태를 확인하세요.");
      else if (outcome === "unconfirmed")
        setNotice("아직 저장되지 않았다고 확정할 수 없어 요청을 유지합니다.");
    });
  }
  async function closeRequest() {
    if (!closure || !closeConsent) return;
    const id = company.id,
      revision = company.revision;
    await run(async (p) => {
      const result = await p.close(closure, true);
      if (!alive(id, revision)) return;
      const { command: _, receipt, outcome: __, ...value } = result;
      void _;
      void __;
      setStatus(value);
      setDraft(empty);
      setBaseRevision(value.company.revision);
      setNotice(
        receipt
          ? "원래 저장 기록을 확인했습니다."
          : "저장되지 않은 이전 요청을 이 브라우저에서 종료했습니다.",
      );
      onCompany(value.company);
    });
  }
  function close() {
    if (working) return;
    if (
      dirty &&
      !window.confirm(
        "미저장 입력은 닫으면 사라집니다. 이미 보낸 원래 요청은 이 브라우저에 남아 다시 확인할 수 있습니다. 닫을까요?",
      )
    )
      return;
    onClose();
  }
  const inputClass = "w-full min-w-0 rounded-lg border p-2 text-sm";
  return (
    <section aria-label="수동 신청번호 연결" className="min-w-0 space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <h4 className="font-semibold">수동 신청번호 연결</h4>
        <button type="button" disabled={working} onClick={close}>
          닫기
        </button>
      </div>
      <Notice>
        담당자가 선택한 신청 회차와 신청번호를 이 PC에 보관합니다. 접수번호·확인서 발급번호와 구분해
        주세요. 공식 조회나 접수 확인이 아닙니다.
      </Notice>
      <p className="break-words text-sm">
        {company.profile.companyName} · 현재 회사 버전 {company.revision}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {blockedReason && <p role="status">{blockedReason}</p>}
      {working && <p role="status">연결 기록 확인 중</p>}
      <button type="button" disabled={working || !!blockedReason} onClick={() => void read()}>
        저장된 연결 다시 조회
      </button>
      {stale && (
        <p role="alert">
          회사 또는 연결 기록이 바뀌었습니다. 입력은 유지하며 이전 기준으로 새 저장하지 않습니다.
        </p>
      )}
      {status && status.company.revision !== company.revision && !dirty && (
        <button
          type="button"
          disabled={working || !!blockedReason}
          onClick={() => {
            setBaseRevision(status.company.revision);
            onCompany(status.company);
          }}
        >
          최신 연결 반영
        </button>
      )}
      {pending ? (
        <div className="space-y-3 rounded-lg bg-muted/40 p-3">
          <p>원래 요청 결과 확인 필요 · 자동 재전송하지 않습니다.</p>
          <dl className="break-words text-sm">
            <dt>신청번호 / 동작</dt>
            <dd>{pending.applicationNumber ?? "연결 해제"}</dd>
            <dt>담당자 / 사유</dt>
            <dd className="whitespace-pre-wrap">
              {pending.recordedBy} · {pending.reason}
            </dd>
            <dt>원래 회사 버전 / 회차 ID</dt>
            <dd>
              {pending.revision} · {pending.applicationId}
            </dd>
          </dl>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={consent}
              disabled={working || !!blockedReason}
              onChange={(e) => setConsent(e.target.checked)}
            />
            원래 내용 그대로 저장 확인을 다시 요청하겠습니다.
          </label>
          <button
            type="button"
            disabled={working || !!blockedReason || !consent}
            onClick={() => void save(true)}
          >
            원래 요청으로 저장 확인
          </button>
          <button
            type="button"
            disabled={working || !!blockedReason}
            onClick={() => void inspectClosure()}
          >
            이전 요청 종료 가능 여부 확인
          </button>
          {closure?.outcome === "not-recorded-stale" && (
            <>
              <p>
                현재 보관 이력에서 이 요청을 찾지 못했고 원래 회사 버전으로는 더 이상 저장할 수
                없습니다. 전체 DB 복원·소실을 증명하지는 않습니다.
              </p>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={closeConsent}
                  disabled={working}
                  onChange={(e) => setCloseConsent(e.target.checked)}
                />
                이전 요청만 종료하겠습니다.
              </label>
              <button
                type="button"
                disabled={working || !closeConsent}
                onClick={() => void closeRequest()}
              >
                저장되지 않은 이전 요청 종료
              </button>
            </>
          )}
        </div>
      ) : (
        <fieldset disabled={!editable} className="min-w-0 space-y-3">
          <label className="block">
            신청 회차
            <select
              aria-label="번호를 연결할 신청 회차"
              className={selectClass}
              value={draft.applicationId}
              onChange={(e) => edit("applicationId", e.target.value)}
            >
              <option value="">직접 선택해 주세요</option>
              {status?.company.applications.map((c) => (
                <option key={c.id} value={c.id}>
                  {applicationMetadata(status.company, c.id)?.title ?? "회차 확인 필요"}
                </option>
              ))}
            </select>
          </label>
          {chosen && (
            <p className="break-words text-sm">
              현재 연결:{" "}
              {chosen.record?.command.operation === "bind"
                ? chosen.record.command.applicationNumber
                : "미연결"}{" "}
              ·{" "}
              {chosen.state === "stale"
                ? "회사·회차 변경으로 재확인 필요"
                : chosen.state === "unassigned"
                  ? "연결 없음"
                  : "담당자 진술·공식 미확인"}
            </p>
          )}
          <label className="block">
            동작
            <select
              aria-label="신청번호 연결 동작"
              className={selectClass}
              value={draft.operation}
              onChange={(e) => edit("operation", e.target.value as "bind" | "release")}
            >
              <option value="bind">번호 연결·정정</option>
              <option value="release" disabled={chosen?.record?.command.operation !== "bind"}>
                기존 연결 해제
              </option>
            </select>
          </label>
          {draft.operation === "bind" && (
            <label className="block">
              신청번호
              <input
                aria-label="수동 신청번호"
                className={inputClass}
                value={draft.applicationNumber}
                onChange={(e) => edit("applicationNumber", e.target.value)}
              />
            </label>
          )}
          <label className="block">
            기록 담당자
            <input
              aria-label="번호 연결 담당자"
              className={inputClass}
              value={draft.recordedBy}
              onChange={(e) => edit("recordedBy", e.target.value)}
            />
          </label>
          <label className="block">
            연결·정정·해제 사유
            <textarea
              aria-label="번호 연결 사유"
              className={inputClass}
              value={draft.reason}
              onChange={(e) => edit("reason", e.target.value)}
              rows={3}
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            선택한 회차와 번호를 확인했고, 담당자 진술로 보관하겠습니다.
          </label>
          <button type="button" disabled={!consent || !parsed.success} onClick={() => void save()}>
            수동 연결 보관
          </button>
          {dirty && !parsed.success && (
            <p className="text-sm">
              회차·번호(최대200자)·담당자(100자)·사유(2,000자)를 확인해 주세요. 초과 내용을 자동으로
              자르지 않습니다.
            </p>
          )}
        </fieldset>
      )}
      {dirty && !pending && !working && (
        <button
          type="button"
          onClick={() => {
            if (window.confirm("미저장 번호 연결 입력을 취소할까요?")) {
              setDraft(empty);
              setConsent(false);
              setBaseRevision(company.revision);
            }
          }}
        >
          입력 취소
        </button>
      )}
      <p className="text-xs text-muted-foreground">
        전송할 원래 요청의 번호·담당자·사유를 이 브라우저에 잠시 보관합니다. 저장 확인 후 지우며
        브라우저 기록 삭제·다른 주소/브라우저·DB 전체 복원의 복구는 보장하지 않습니다. 이력은
        최대200개입니다.
      </p>
    </section>
  );
}
