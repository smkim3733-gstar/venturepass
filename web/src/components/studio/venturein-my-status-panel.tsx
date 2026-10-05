"use client";

import { useEffect, useRef, useState } from "react";
import { VentureinBoundMyStatusPanel } from "./venturein-bound-my-status-panel";
import { Button } from "@/components/ui/button";
import type { StudioCase } from "@/lib/studio-schema";
import type { VentureConnectionStatus } from "@/lib/venturein-schema";
import type { VentureWorkflowStatus } from "@/lib/venturein-workflow";
import { readVentureMyResult, ventureMyReadFailure, ventureMyReadCommand, ventureMyReadContext,
  type VentureMyReadContext, type VentureMyReadResult } from "@/lib/venturein-my-status-view";
import { formatDate, jsonBody, studioFetch, StudioApiError } from "./shared";

type Props = { company: StudioCase; connection: VentureConnectionStatus;
  workflow: VentureWorkflowStatus; blocked: boolean };
export function VentureinMyStatusPanel({ company, connection, workflow, blocked }: Props) {
  const context = ventureMyReadContext(company, connection, workflow);
  // A new company/version/session or competing operation cannot inherit an old result.
  const key = JSON.stringify([context, company.id, company.revision, connection.account.revision,
    connection.session.state, connection.session.startedAt, workflow.revision, blocked]);
  return <div className="min-w-0 space-y-4">
    <CurrentMyStatus key={key} context={context} blocked={blocked}
      companyName={company.profile.companyName} maskedLoginId={connection.account.maskedLoginId} />
    <VentureinBoundMyStatusPanel key={"bound:" + key} company={company} context={context} blocked={blocked}
      maskedLoginId={connection.account.maskedLoginId} />
  </div>;
}
function CurrentMyStatus({ context, blocked, companyName, maskedLoginId }: {
  context: VentureMyReadContext | null; blocked: boolean; companyName: string; maskedLoginId: string | null;
}) {
  const [result, setResult] = useState<VentureMyReadResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const sequence = useRef(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; pending.current?.abort(); };
  }, []);
  function close() {
    sequence.current++; pending.current?.abort();
    setResult(null); setError(""); setBusy(false);
  }
  async function read() {
    if (!context || blocked || pending.current || !active.current) return;
    const controller = new AbortController(); pending.current = controller;
    const request = ++sequence.current;
    setBusy(true); setResult(null); setError("");
    try {
      const value = await studioFetch<unknown>(`/api/studio/cases/${context.caseId}/venturein/my-status`, {
        method: "POST", ...jsonBody(ventureMyReadCommand(context)), signal: controller.signal,
      });
      const observed = readVentureMyResult(value, context);
      if (active.current && request === sequence.current && !controller.signal.aborted) setResult(observed);
    } catch (caught) {
      if (active.current && request === sequence.current && !controller.signal.aborted)
        setError(ventureMyReadFailure(caught instanceof StudioApiError ? caught.code : undefined));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (active.current && request === sequence.current) setBusy(false);
    }
  }
  return <section aria-label="MY벤처현황 읽기" className="min-w-0 rounded-2xl border p-5">
    <details onToggle={event => { if (!event.currentTarget.open) close(); }} className="min-w-0">
      <summary className="cursor-pointer text-sm font-bold">MY벤처현황 읽기 · 신청 회차 연결 미확인</summary>
      <div className="mt-4 min-w-0 space-y-4 text-sm leading-6">
        <p className="break-words">대상 회사: <strong>{companyName}</strong> · 계정: {maskedLoginId || "미등록"}</p>
        <p>앱이 연 별도 Edge 창에서 해당 회사의 MY벤처현황을 직접 열어 두세요. 버튼을 누르면 현재 화면만 한 번 읽습니다. Codex 내장 브라우저의 로그인은 공유되지 않습니다.</p>
        <p className="text-muted-foreground">신청 회차·접수증과의 연결, 현재 유효성은 미확인입니다. 수동 기록과 공식 확인 시각은 변경하지 않습니다. 접거나 화면을 나가면 이번 표시는 지워집니다.</p>
        {context && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">읽기 대상 정보</summary>
          <p>연결 시작: {formatDate(context.sessionStartedAt)}</p>
          <p>자료 버전 {context.companyRevision} · 계정 버전 {context.accountRevision} · 연결 기록 버전 {context.workflowRevision}</p>
        </details>}
        {(!context || blocked) && <p>로그인 연결·저장 기록이 일치하는지 확인하고, 진행 중인 작업이나 미저장 변경을 먼저 정리해 주세요.</p>}
        <Button type="button" disabled={!context || blocked || busy} onClick={() => { void read(); }}>
          {busy ? "현재 창 읽는 중" : "현재 MY벤처현황 한 번 읽기"}
        </Button>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {result && <VentureMyStatusResults value={result} />}
      </div>
    </details>
  </section>;
}
const shown = (text: string | null) => text || "표시 없음";
export function VentureMyStatusResults({ value }: { value: VentureMyReadResult }) {
  const observed = value.observation;
  function empty(state: string, count: number) {
    if (state === "unsupported") return "지원하지 않거나 모호한 표 구조입니다. 원래 화면에서 확인해 주세요.";
    if (state === "not-present") return "화면에서 해당 표를 찾지 못했습니다. 이력이 없다는 뜻은 아닙니다.";
    return count === 0 ? "읽은 표에 표시된 행이 없습니다. 미신청·미발급을 증명하지 않습니다." : null;
  }
  return <div aria-label="이번에 읽은 MY벤처현황" className="min-w-0 space-y-4">
    <p>화면 읽은 시각: {formatDate(observed.observedAt)}<br />발행·통지 시각과 다르며, 이후 화면 변경은 자동으로 반영하지 않습니다.</p>
    <p className="font-semibold">회사 화면의 개별 기록 · 로컬 신청 회차 연결 미확인</p>
    <div><h4 className="font-bold">신청 결과 표 ({observed.applications.rows.length}건 읽음)</h4>
      {empty(observed.applications.state, observed.applications.rows.length) && <p>{empty(observed.applications.state, observed.applications.rows.length)}</p>}
      <ul className="mt-2 space-y-3">{observed.applications.rows.map(row => <li key={row.applicationNumber} className="min-w-0 break-all rounded-xl border p-3">
        <p>화면 신청번호: {row.applicationNumber}</p><p>신청일 표기: {shown(row.applicationDateText)}</p>
        <p>통지완료일 표기: {shown(row.notifiedDateText)}</p><p>결과 표기: {shown(row.resultText)}</p>
      </li>)}</ul>
    </div>
    <div><h4 className="font-bold">확인서 이력 표 ({observed.certificates.rows.length}건 읽음)</h4>
      {empty(observed.certificates.state, observed.certificates.rows.length) && <p>{empty(observed.certificates.state, observed.certificates.rows.length)}</p>}
      <ul className="mt-2 space-y-3">{observed.certificates.rows.map(row => <li key={row.certificateNumber} className="min-w-0 break-all rounded-xl border p-3">
        <p>화면 발급번호: {row.certificateNumber}</p><p>유형 표기: {shown(row.typeText)}</p>
        <p>발급일 표기: {shown(row.issuedDateText)}</p><p>유효기간 표기: {shown(row.validityText)}</p>
        <p>최초확인일 표기: {shown(row.firstConfirmedDateText)}</p><p>취소일 표기: {shown(row.cancelledDateText)}</p>
      </li>)}</ul>
    </div>
  </div>;
}
