"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BusinessPlan, StudioCase } from "@/lib/studio-schema";
import type { PackageRequest } from "@/lib/studio-package-types";
import {
  MAX_PREPARED_PACKAGES,
  preparedPackageSummary,
  type PreparedPackageRequest,
  type PreparedPackageSummary,
} from "@/lib/studio-prepared-package-types";
import { PackagePanel, readPackageDownload } from "./package-panel";
import {
  preparedPackageCurrent,
  preparedPackageList,
  preparedPackageReceipt,
  preparedPackageDefiniteRejection,
} from "./prepared-package-ui";
import { jsonBody, studioFetch, StudioApiError } from "./shared";
import styles from "./guided-workspace.module.css";

type Pending = { request: PreparedPackageRequest; company: StudioCase };
type Props = {
  company: StudioCase;
  plan?: BusinessPlan;
  dirty: boolean;
  blocked: boolean;
  onBusyChange: (message: string) => void;
  onUnsettledChange: (value: boolean) => void;
  onClose: () => void;
};

export function PreparedPackagesPanel({
  company,
  plan,
  dirty,
  blocked,
  onBusyChange,
  onUnsettledChange,
  onClose,
}: Props) {
  const [packages, setPackages] = useState<PreparedPackageSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [working, setWorking] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [statusVersion, setStatusVersion] = useState(0);
  const mounted = useRef(true),
    inFlight = useRef(false);
  const pendingRef = useRef<Pending | null>(null);
  const packageBusyRef = useRef(false);
  const listSequence = useRef(0);
  const companyRef = useRef(company);
  useEffect(() => {
    companyRef.current = company;
  }, [company]);
  const base = `/api/studio/cases/${company.id}/prepared-packages`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onUnsettledChange(!!pending);
    return () => onUnsettledChange(false);
  }, [pending, onUnsettledChange]);
  const finish = useCallback((item: PreparedPackageSummary) => {
    listSequence.current++;
    setStatusVersion((version) => version + 1);
    setError("");
    setPackages((previous) =>
      [item, ...previous.filter((entry) => entry.id !== item.id)].sort(
        (a, b) => b.version - a.version,
      ),
    );
    pendingRef.current = null;
    setPending(null);
    setLoaded(true);
    setMessage(
      `준비본 ${item.version}에 원고 v${item.planVersion}과 선택 원본 ${item.sourceIds.length}개를 보관했습니다.`,
    );
  }, []);

  const load = useCallback(async () => {
    const sequence = ++listSequence.current;
    const context = companyRef.current;
    const list = preparedPackageList(await studioFetch<unknown>(base), context);
    if (
      !mounted.current ||
      sequence !== listSequence.current ||
      companyRef.current.id !== context.id ||
      companyRef.current.revision !== context.revision
    )
      return;
    setPackages([...list.packages].sort((a, b) => b.version - a.version));
    setLoaded(true);
    const waiting = pendingRef.current;
    if (waiting) {
      const found = list.packages.find(
        (item) => item.clientRequestId === waiting.request.clientRequestId,
      );
      if (found) {
        const record = preparedPackageReceipt(
          await studioFetch<unknown>(`${base}/${found.id}`),
          waiting.company,
          waiting.request,
        );
        if (
          mounted.current &&
          sequence === listSequence.current &&
          companyRef.current.id === context.id &&
          companyRef.current.revision === context.revision &&
          pendingRef.current === waiting
        )
          finish(preparedPackageSummary(record));
      } else
        setMessage(
          "아직 이 요청의 보관 결과가 없습니다. 잠시 후 조회하거나 같은 요청으로 다시 확인할 수 있습니다.",
        );
    }
  }, [base, finish]);
  useEffect(() => {
    let active = true;
    load().catch(() => {
      if (active && mounted.current)
        setError("준비본 목록을 불러오지 못했습니다. 저장 상태 확인으로 다시 조회해 주세요.");
    });
    return () => {
      active = false;
    };
  }, [load, company.revision]);

  async function post(waiting: Pending) {
    try {
      const raw = await studioFetch<unknown>(base, {
        method: "POST",
        ...jsonBody(waiting.request),
      });
      const record = preparedPackageReceipt(raw, waiting.company, waiting.request);
      if (mounted.current && pendingRef.current === waiting) finish(preparedPackageSummary(record));
      return `준비본 ${record.version} 보관을 마쳤습니다. 기관 접수 기록은 생성하지 않습니다.`;
    } catch (caught) {
      if (
        caught instanceof StudioApiError &&
        preparedPackageDefiniteRejection(caught.status, caught.code)
      ) {
        pendingRef.current = null;
        if (mounted.current) setPending(null);
        if (caught.status === 409)
          throw new Error(
            "준비본을 저장하지 않았습니다. 최신 기업 자료를 불러온 뒤 다시 보관해 주세요.",
          );
      }
      throw caught;
    }
  }
  async function preserve(input: PackageRequest) {
    if (
      inFlight.current ||
      blocked ||
      dirty ||
      pendingRef.current ||
      !loaded ||
      packages.length >= MAX_PREPARED_PACKAGES
    )
      throw new Error("현재 저장 상태와 편집 중인 내용을 먼저 확인해 주세요.");
    const waiting = {
      request: { ...input, clientRequestId: crypto.randomUUID() },
      company: structuredClone(company),
    };
    pendingRef.current = waiting;
    setPending(waiting);
    inFlight.current = true;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      return await post(waiting);
    } finally {
      inFlight.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function check(retry = false) {
    if (inFlight.current || packageBusyRef.current || blocked) return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    onBusyChange("보관한 준비본 상태를 확인하고 있습니다");
    try {
      if (retry && pendingRef.current) await post(pendingRef.current);
      else await load();
    } catch (caught) {
      if (mounted.current)
        setError(caught instanceof Error ? caught.message : "준비본 상태를 확인하지 못했습니다.");
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setWorking(false);
        onBusyChange("");
      }
    }
  }
  async function download(item: PreparedPackageSummary) {
    if (
      inFlight.current ||
      packageBusyRef.current ||
      blocked ||
      pendingRef.current ||
      item.caseId !== company.id
    )
      return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    onBusyChange("보관한 준비본을 내려받고 있습니다");
    let url: string | null = null;
    try {
      const response = await fetch(`${base}/${item.id}/download`, { cache: "no-store" });
      const file = await readPackageDownload(response);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", await file.blob.arrayBuffer())),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (file.blob.size !== item.sizeBytes || digest !== item.zipSha256)
        throw new Error("보관 기록과 다운로드 파일이 일치하지 않습니다.");
      if (!mounted.current) return;
      url = URL.createObjectURL(file.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      const downloadUrl = url;
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      url = null;
      setMessage(
        `준비본 ${item.version}의 다운로드를 요청했습니다. 브라우저 다운로드 목록을 확인해 주세요.`,
      );
    } catch (caught) {
      if (mounted.current)
        setError(caught instanceof Error ? caught.message : "준비본을 내려받지 못했습니다.");
    } finally {
      if (url) URL.revokeObjectURL(url);
      inFlight.current = false;
      if (mounted.current) {
        setWorking(false);
        onBusyChange("");
      }
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <h2 className={styles.heading}>원고와 첨부 보관</h2>
        <button
          type="button"
          className={styles.link}
          disabled={working || packageBusy || !!pending}
          onClick={onClose}
        >
          돌아가기
        </button>
      </div>
      <p className={styles.lead}>
        지금 선택한 내용을 한 버전으로 보관합니다. 자료를 고쳐도 이전 준비본은 유지됩니다.
      </p>
      <div className={styles.notice}>
        이 PC의 준비본입니다. 기관 전송·접수·내부 검토 완료를 대신하지 않습니다.
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className={styles.helper} role="status">
          {message}
        </p>
      )}
      {pending && (
        <div className={styles.notice}>
          <strong>보관 결과를 확인하고 있어요</strong>
          <p>새 요청을 만들지 않고 같은 요청의 기록을 조회합니다.</p>
        </div>
      )}
      <div className={styles.support}>
        <button
          type="button"
          className={styles.link}
          disabled={working || packageBusy || blocked}
          onClick={() => void check()}
        >
          저장 상태 확인
        </button>
        {pending && (
          <button
            type="button"
            className={styles.link}
            disabled={working || packageBusy || blocked}
            onClick={() => void check(true)}
          >
            같은 요청 다시 확인
          </button>
        )}
      </div>
      {plan && (
        <PackagePanel
          key={`${company.id}:${plan.id}`}
          company={company}
          plan={plan}
          dirty={dirty || blocked || !!pending || !loaded || working}
          blockedReason={
            pending
              ? "보관 결과를 확인한 뒤 이어가 주세요."
              : !loaded
                ? "보관 목록을 확인한 뒤 이어가 주세요."
                : working
                  ? "진행 중인 작업이 끝나면 이어갈 수 있습니다."
                  : blocked
                    ? "다른 준비 작업을 마친 뒤 이어가 주세요."
                    : undefined
          }
          onBusyChange={(message) => {
            packageBusyRef.current = !!message;
            setPackageBusy(!!message);
            onBusyChange(message);
          }}
          onPreserve={packages.length >= MAX_PREPARED_PACKAGES ? undefined : preserve}
          statusVersion={statusVersion}
        />
      )}
      {packages.length >= MAX_PREPARED_PACKAGES && (
        <p className={styles.notice}>
          기업별 준비본 {MAX_PREPARED_PACKAGES}개를 모두 보관했습니다. 기존 준비본은 내려받을 수
          있습니다.
        </p>
      )}
      <section aria-label="보관한 준비본" className={styles.sheet}>
        <h3 className={styles.subheading}>보관한 준비본 {packages.length}개</h3>
        {!packages.length && (
          <p className={styles.helper}>
            {loaded ? "아직 보관한 준비본이 없습니다." : "보관한 준비본을 확인하고 있습니다."}
          </p>
        )}
        {packages.map((item) => (
          <details key={item.id} className={styles.details}>
            <summary>
              준비본 {item.version} · 원고 v{item.planVersion} ·{" "}
              {item.draft ? "검토 필요" : "로컬 검토 기록 있음"}
            </summary>
            <p className={styles.body}>{item.planTitle}</p>
            <p className={styles.helper}>
              {preparedPackageCurrent(item, company)
                ? "현재 기업 자료로 만든 준비본입니다."
                : "당시 자료로 보관한 준비본입니다. 현재 자료와 다시 대조해 주세요."}{" "}
              선택 원본 {item.sourceIds.length}개 · {item.createdAt.slice(0, 10)}
            </p>
            <p className={styles.helper}>
              보관 당시 원고 검토 의견 {item.storedReviewCount}개 · 규칙 점검 의견{" "}
              {item.currentRuleReviewCount}개. 검토 의견 수는 기관 평가 점수가 아닙니다.
            </p>
            <button
              type="button"
              className={styles.link}
              disabled={working || packageBusy || blocked || !!pending}
              onClick={() => void download(item)}
            >
              준비본 {item.version} 내려받기
            </button>
          </details>
        ))}
      </section>
    </div>
  );
}
