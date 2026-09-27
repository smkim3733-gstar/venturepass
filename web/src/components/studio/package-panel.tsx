"use client";

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { BusinessPlan, SourceDocument, StudioCase } from "@/lib/studio-schema";
import {
  PACKAGE_DOWNLOAD_NAME,
  packageLimits,
  packageRequestSchema,
  type PackageRequest,
} from "@/lib/studio-package-types";
import { Notice, jsonBody } from "./shared";

const mebibytes = (bytes: number) => bytes / (1024 * 1024);

export function packageSources(company: StudioCase): SourceDocument[] {
  return company.sources.filter((source) => Boolean(source.originalName));
}

export function selectedPackageSources(company: StudioCase, selected: string[]): string[] | null {
  const available = packageSources(company);
  if (
    selected.length > packageLimits.files ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => available.filter((source) => source.id === id).length !== 1)
  )
    return null;
  return [...selected];
}

/** Only a bounded ZIP attachment becomes a browser download. Never follow a file URL in JSON. */
export async function readPackageDownload(
  response: Response,
  expectedFilename: string = PACKAGE_DOWNLOAD_NAME,
): Promise<{ blob: Blob; filename: string }> {
  if (!/^[a-z0-9][a-z0-9-]*\.zip$/.test(expectedFilename)) {
    await response.body?.cancel();
    throw new Error("다운로드 파일 이름 설정을 확인하지 못했습니다.");
  }
  if (!response.ok) {
    const raw: unknown = await response.json().catch(() => null);
    const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    throw new Error(
      typeof body.error === "string" ? body.error : "제출 준비 묶음을 만들지 못했습니다.",
    );
  }
  if (
    (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !==
    "application/zip"
  ) {
    await response.body?.cancel();
    throw new Error("ZIP 형식의 다운로드 응답을 확인하지 못했습니다.");
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const allowedDisposition = [
    `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(expectedFilename)}`,
    `attachment; filename="${expectedFilename}"`,
  ];
  if (!allowedDisposition.includes(disposition.trim())) {
    await response.body?.cancel();
    throw new Error("다운로드 파일 이름을 확인하지 못했습니다.");
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > packageLimits.zipBytes || Number(declared) < 4)
  ) {
    await response.body?.cancel();
    throw new Error("다운로드 크기가 올바르지 않거나 허용 범위를 초과했습니다.");
  }
  if (!response.body) throw new Error("다운로드할 파일 내용이 없습니다.");
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > packageLimits.zipBytes)
        throw new Error("다운로드 크기가 허용 범위를 초과했습니다.");
      chunks.push(new Uint8Array(chunk.value).buffer);
    }
    if (size < 4 || (declared !== null && size !== Number(declared)))
      throw new Error("다운로드가 완전하지 않습니다. 다시 묶음을 만들어 주세요.");
    const blob = new Blob(chunks, { type: "application/zip" });
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (
      signature[0] !== 0x50 ||
      signature[1] !== 0x4b ||
      signature[2] !== 0x03 ||
      signature[3] !== 0x04
    )
      throw new Error("ZIP 파일의 시작 형식을 확인하지 못했습니다.");
    return { blob, filename: expectedFilename };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

type Props = {
  company: StudioCase;
  plan: BusinessPlan;
  dirty: boolean;
  onBusyChange: (message: string) => void;
  onPreserve?: (request: PackageRequest) => Promise<string>;
  blockedReason?: string;
  /** A confirmed parent recovery invalidates messages from the previous request. */
  statusVersion?: number;
};

export function PackagePanel({
  company,
  plan,
  dirty,
  onBusyChange,
  onPreserve,
  blockedReason,
  statusVersion = 0,
}: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [noticeVersion, setNoticeVersion] = useState(statusVersion);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const binding = `${company.id}:${company.revision}:${plan.id}`;
  const context = useRef(binding);
  const [initialBinding] = useState(binding);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    context.current = binding;
  }, [binding]);
  const stale = binding !== initialBinding;
  const sources = packageSources(company);
  const latestVersion = Math.max(...company.plans.map((item) => item.version));
  const needsReview =
    latestVersion !== plan.version ||
    !company.analysis ||
    company.selectedCandidateId !== plan.candidateId ||
    !plan.confirmedAt ||
    plan.content.sections.some((section) => section.needsConfirmation) ||
    plan.review.some(
      (item) =>
        item.severity === "error" ||
        item.category === "confirmation" ||
        (item.severity !== "info" &&
          [
            "semantic-evidence",
            "contradiction",
            "timeline",
            "financial-plan",
            "fact-vs-plan",
          ].includes(item.category)),
    );
  function toggle(id: string, checked: boolean) {
    if (busy || dirty || stale || inFlight.current) return;
    setSelected((previous) =>
      checked
        ? previous.includes(id) || previous.length >= packageLimits.files
          ? previous
          : [...previous, id]
        : previous.filter((item) => item !== id),
    );
    setMessage("");
    setError("");
  }
  async function download(mode: "download" | "preserve" = "download") {
    if (busy || dirty || stale || inFlight.current) return;
    setNoticeVersion(statusVersion);
    const sourceIds = selectedPackageSources(company, selected);
    const exactPlans = company.plans.filter((item) => item.id === plan.id);
    if (!sourceIds || exactPlans.length !== 1 || exactPlans[0] !== plan) {
      setError("선택한 원고와 원본 자료가 현재 기업에 있는지 다시 확인해 주세요.");
      return;
    }
    const request = packageRequestSchema.safeParse({
      revision: company.revision,
      planId: plan.id,
      sourceIds,
    });
    if (!request.success) {
      setError("묶음의 원고·원본 선택을 확인해 주세요.");
      return;
    }
    const startedBinding = binding;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    onBusyChange(
      mode === "preserve"
        ? "원고와 선택 원본을 이 PC의 준비본으로 보관하고 있습니다"
        : "선택한 원고와 원본으로 이 PC에 보관할 ZIP을 만드는 중입니다",
    );
    let objectUrl: string | null = null;
    try {
      if (mode === "preserve" && onPreserve) {
        const result = await onPreserve(request.data);
        if (mounted.current && context.current === startedBinding) setMessage(result);
        return;
      }
      const response = await fetch(`/api/studio/cases/${company.id}/package`, {
        method: "POST",
        cache: "no-store",
        ...jsonBody(request.data),
      });
      const file = await readPackageDownload(response);
      if (!mounted.current || context.current !== startedBinding) return;
      objectUrl = URL.createObjectURL(file.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = file.filename;
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      // Allow the browser to accept the Blob download before releasing the temporary URL.
      const downloadUrl = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      objectUrl = null;
      setMessage(
        `원고 v${plan.version}과 선택 원본 ${sourceIds.length}개의 ZIP 다운로드를 요청했습니다. 브라우저 다운로드 목록을 확인해 주세요.`,
      );
    } catch (caught) {
      if (mounted.current && context.current === startedBinding)
        setError(
          caught instanceof Error ? caught.message : "제출 준비 묶음을 내려받지 못했습니다.",
        );
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange("");
      }
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border bg-white p-5" aria-labelledby="package-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="package-title" className="font-bold">
            제출 준비 묶음
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            선택한 원고 v{plan.version}의 본문·검토 의견·근거 연결표와 직접 선택한 원본을 ZIP으로
            내려받습니다.
          </p>
        </div>
        <Badge variant="outline">
          {needsReview ? "DRAFT · 담당자 검토 필요" : "생성 시 현재성·검토 상태 재점검"}
        </Badge>
      </div>
      {latestVersion !== plan.version && (
        <Notice tone="warning">
          현재 선택은 원고 v{plan.version}입니다. 최신 v{latestVersion}으로 바꾸지 않고 선택한
          버전을 묶습니다. 버전 순서와 근거의 현재성은 별도로 점검합니다.
        </Notice>
      )}
      <p className="text-xs leading-6 text-muted-foreground">
        미검토·과거 근거·필수 확인·검토 오류가 남은 원고는 묶음에 DRAFT로 표시합니다. 최종 상태와
        사유는 묶음의 안내·목록에서 확인해 주세요. 기관 전송·접수나 내부 검토 완료 기록은 생성하지
        않습니다.
      </p>
      <details className="rounded-xl border p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          포함할 원본 직접 선택 · {selected.length}/{packageLimits.files}개
        </summary>
        <p className="my-3 text-xs leading-6 text-muted-foreground">
          같은 기업에 보관한 원본만 선택할 수 있습니다. 원본을 선택하지 않아도 원고와 점검 자료는
          내려받을 수 있습니다. 파일별 {mebibytes(packageLimits.originalBytes)}MiB·합계{" "}
          {mebibytes(packageLimits.totalOriginalBytes)}MiB 한도는 생성 시 서버에서 확인합니다.
        </p>
        {sources.length ? (
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {sources.map((source) => (
              <label
                className="flex items-start gap-3 rounded-lg border p-3 text-sm"
                key={source.id}
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-teal-700"
                  checked={selected.includes(source.id)}
                  disabled={
                    busy ||
                    dirty ||
                    stale ||
                    (!selected.includes(source.id) && selected.length >= packageLimits.files)
                  }
                  onChange={(event) => toggle(source.id, event.target.checked)}
                />
                <span className="min-w-0 break-words">
                  <span className="block font-medium">{source.name}</span>
                  <span className="block text-xs text-muted-foreground">{source.originalName}</span>
                  {source.extraction === "pending" && (
                    <Badge className="mt-2" variant="outline">
                      본문 확인 필요 · 원본만 포함
                    </Badge>
                  )}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            보관한 원본 파일이 없습니다. 자료함에서 원본을 추가할 수 있습니다.
          </p>
        )}
        {selected.length > 0 && (
          <Button
            className="mt-3"
            variant="outline"
            disabled={busy || dirty || stale}
            onClick={() => {
              setSelected([]);
              setMessage("");
            }}
          >
            원본 선택 해제
          </Button>
        )}
      </details>
      <p className="text-xs leading-6 text-muted-foreground">
        자료 본문 전체를 일괄 포함하지 않습니다. 선택 원본에는 해당 파일의 전체 내용이 들어갑니다.
        원고 버전·기업 자료를 바꾸면 원본을 다시 선택합니다. 원본을 묶는 것만으로 내용 검토가
        완료되지 않습니다.
      </p>
      {dirty && (
        <Notice tone="warning">
          {blockedReason || "원고 수정본을 먼저 저장하거나 편집을 취소한 뒤 묶음을 만들어 주세요."}
        </Notice>
      )}
      {stale && (
        <Notice tone="warning">
          기업 또는 원고 버전이 변경되었습니다. 원고 화면을 다시 열고 원본을 선택해 주세요.
        </Notice>
      )}
      {error && noticeVersion === statusVersion && (
        <div role="alert">
          <Notice tone="warning">
            {error} 자동 재시도하지 않습니다. 상태를 확인한 뒤 다시 만들 수 있습니다.
          </Notice>
        </div>
      )}
      {message && noticeVersion === statusVersion && (
        <p role="status" className="text-sm leading-6">
          {message}
        </p>
      )}
      {onPreserve && (
        <Button disabled={busy || dirty || stale} onClick={() => void download("preserve")}>
          {busy ? "준비본 보관 중…" : "원고와 선택 원본 보관"}
        </Button>
      )}
      <Button
        variant={onPreserve ? "outline" : "default"}
        disabled={busy || dirty || stale}
        onClick={() => void download()}
      >
        <Download />
        {busy ? "ZIP 준비 중…" : `원고 v${plan.version} 제출 준비 ZIP 내려받기`}
      </Button>
    </section>
  );
}
