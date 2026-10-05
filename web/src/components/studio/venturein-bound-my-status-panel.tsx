"use client";
import { useEffect, useRef, useState } from "react";
import type { StudioCase } from "@/lib/studio-schema";
import { applicationMetadata } from "@/lib/studio-application-types";
import type { VentureMyReadContext } from "@/lib/venturein-my-status-view";
import { ventureMyReadFailure } from "@/lib/venturein-my-status-view";
import { readVentureBoundResult, ventureBoundReadCommand,
  type VentureBoundReadContext, type VentureBoundReadResult } from "@/lib/venturein-bound-my-status";
import { validateNumberStatus, type NumberStatus } from "./application-number-ui";
import { Button } from "@/components/ui/button";
import { formatDate, jsonBody, selectClass, studioFetch, StudioApiError } from "./shared";

type Props = { company: StudioCase; context: VentureMyReadContext | null; blocked: boolean; maskedLoginId: string | null };
export function VentureinBoundMyStatusPanel({ company, context, blocked, maskedLoginId }: Props) {
  const [snapshot, setSnapshot] = useState<NumberStatus | null>(null);
  const [selected, setSelected] = useState("");
  const [result, setResult] = useState<VentureBoundReadResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef(false), sequence = useRef(0), pending = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; pending.current?.abort(); }; }, []);
  function clear(close = false) {
    sequence.current++; pending.current?.abort(); pending.current = null;
    setResult(null); setError(""); setBusy(false);
    if (close) { setSnapshot(null); setSelected(""); }
  }
  const current = snapshot?.current.find(x => x.applicationId === selected);
  const record = current?.state === "manual-unverified" ? current.record : null;
  const target: VentureBoundReadContext | null = context && record && record.command.operation === "bind" && record.command.applicationNumber
    ? { ...context, target: { applicationId: selected, metadataVersionId: record.command.metadataVersionId,
      bindingId: record.id, bindingDigest: record.recordDigest, applicationNumber: record.command.applicationNumber } } : null;
  async function request(kind: "connections" | "screen") {
    if (!context || blocked || pending.current || !active.current || (kind === "screen" && !target)) return;
    const controller = new AbortController(); pending.current = controller;
    const id = ++sequence.current; setBusy(true); setError(""); setResult(null);
    const valid = () => active.current && sequence.current === id && !controller.signal.aborted;
    if (kind === "connections") { setSnapshot(null); setSelected(""); }
    try {
      if (kind === "connections") {
        const value = await studioFetch<unknown>(`/api/studio/cases/${company.id}/application-numbers`, { signal: controller.signal });
        const read = await validateNumberStatus(value, company.id, company.revision);
        if (read.company.revision !== company.revision) throw Error("Changed company");
        if (valid()) setSnapshot(read);
      } else {
        const expected = structuredClone(target!);
        const raw = await studioFetch<unknown>(`/api/studio/cases/${company.id}/venturein/bound-my-status`, {
          method: "POST", ...jsonBody(ventureBoundReadCommand(expected)), signal: controller.signal,
        });
        const value = readVentureBoundResult(raw, expected);
        if (valid()) setResult(value);
      }
    } catch (caught) {
      if (valid()) {
        setSnapshot(null); setSelected("");
        setError(caught instanceof StudioApiError && caught.code === "MY_STATUS_BINDING_CHANGED"
          ? "번호 연결이 바뀌었거나 미확인입니다. 저장된 연결을 다시 확인해 주세요."
          : kind === "connections" ? "현재 회사의 저장 연결을 확인하지 못했습니다. 직접 다시 확인해 주세요."
            : ventureMyReadFailure(caught instanceof StudioApiError ? caught.code : undefined));
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (valid()) setBusy(false);
    }
  }
  return <section aria-label="연결한 신청번호 결과 읽기" className="min-w-0 rounded-2xl border p-5">
    <details onToggle={e => { if (!e.currentTarget.open) clear(true); }}>
      <summary className="cursor-pointer text-sm font-bold">연결한 신청번호 한 건 읽기</summary>
      <div className="mt-4 min-w-0 space-y-4 text-sm leading-6">
        <p className="break-words">대상 회사: <strong>{company.profile.companyName}</strong> · 계정: {maskedLoginId || "미등록"}</p>
        <p>저장된 수동 연결을 확인하고 회차를 직접 선택하세요. 앱 Edge 창에 열린 MY벤처현황에서 그 번호와 같은 한 행만 읽습니다. Codex 내장 브라우저 로그인은 공유되지 않습니다.</p>
        <p>회차 연결은 담당자 진술입니다. 번호 일치는 올바른 회차 귀속·공식 접수증·현재 유효성의 증명이 아닙니다. 결과를 저장하지 않으며 접거나 화면을 나가면 지워집니다.</p>
        {(!context || blocked) && <p>현재 회사·계정 연결과 진행 중인 작업을 먼저 확인해 주세요.</p>}
        <Button type="button" disabled={!context || blocked || busy} onClick={() => void request("connections")}>저장된 번호 연결 확인</Button>
        {snapshot && <>
          <label className="block">읽을 신청 회차
            <select aria-label="읽을 신청 회차" className={selectClass} value={selected} disabled={blocked}
              onChange={e => { clear(); setSelected(e.target.value); }}>
              <option value="">직접 선택해 주세요</option>
              {snapshot.current.map((item, index) => <option key={item.applicationId} value={item.applicationId} disabled={item.state !== "manual-unverified"}>
                {index + 1}. {applicationMetadata(snapshot.company, item.applicationId)?.title || "회차 미확인"} · {item.state === "manual-unverified" ? item.record?.command.applicationNumber : item.state === "stale" ? "연결 재확인 필요" : "연결 없음"}
              </option>)}
            </select>
          </label>
          {target && <div className="break-all rounded-lg border p-3">
            <p>읽을 번호: {target.target.applicationNumber}</p>
            <p>담당자 수동 연결 · 공식 미확인</p>
            <details className="text-xs"><summary>선택한 연결과 세션</summary>
              <p>회차 ID: {target.target.applicationId}</p><p>연결 ID: {target.target.bindingId}</p>
              <p>회사 버전 {target.companyRevision} · 계정 버전 {target.accountRevision} · 연결 기록 버전 {target.workflowRevision}</p>
              <p>세션 시작: {formatDate(target.sessionStartedAt)}</p>
            </details>
          </div>}
          <Button type="button" disabled={!target || blocked || busy} onClick={() => void request("screen")}>
            {busy ? "읽는 중" : "선택한 신청번호 한 번 읽기"}
          </Button>
        </>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {result && <VentureBoundMyStatusResult value={result} />}
      </div>
    </details>
  </section>;
}
export function VentureBoundMyStatusResult({ value }: { value: VentureBoundReadResult }) {
  const observation = value.observation, target = observation.target;
  return <div aria-label="이번 신청번호 대조 결과" className="min-w-0 space-y-2 break-all rounded-xl border p-3">
    <p>화면 읽은 시각: {formatDate(observation.observedAt)} · 통지일과 다릅니다.</p>
    <p>저장 연결의 신청번호: {value.target.applicationNumber}</p>
    {target.state === "matched" && target.row ? <>
      <p className="font-semibold">번호가 같은 한 행을 읽었습니다 · 회차 귀속은 담당자 진술</p>
      <p>신청일 표기: {target.row.applicationDateText || "표시 없음"}</p>
      <p>통지완료일 표기: {target.row.notifiedDateText || "표시 없음"}</p>
      <p>결과 표기: {target.row.resultText || "표시 없음"}</p>
    </> : <p>{target.state === "not-observed" ? "읽은 표에서 같은 번호를 찾지 못했습니다. 미신청·탈락을 뜻하지 않습니다."
      : observation.applicationTable.state === "not-present" ? "신청 결과 표를 찾지 못해 번호를 대조하지 못했습니다."
        : "모호하거나 지원하지 않는 표여서 번호를 대조하지 못했습니다."}</p>}
    <p>공식 접수증·현재 유효성은 미확인입니다. 진행 단계와 확인서 이력은 이 회차에 귀속하지 않습니다. 수동 기록·공식 확인 시각은 변경하지 않았습니다.</p>
  </div>;
}
