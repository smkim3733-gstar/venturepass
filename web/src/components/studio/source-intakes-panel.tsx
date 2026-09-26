"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { sourceKindLabels, sourceKinds, type StudioCase } from "@/lib/studio-schema";
import {
  sourceIntakeCommandSchema,
  sourceIntakeEngineSupports,
  sourceIntakeExtensions,
  sourceIntakeLimits,
  sourceIntakePhaseLabels,
  sourceIntakeResultText,
  type SourceIntakeLocalEngine,
  type SourceIntakeItem,
} from "@/lib/studio-source-intake-types";
import {
  sourceIntakeExternalEngineLabels,
  sourceIntakeExternalSupports,
  type SourceIntakeExternalEngine,
} from "@/lib/studio-source-intake-external-types";
import { IntakeExternalApprovalReview } from "./source-intake-external-review";
import {
  intakeCanPrepareExternal,
  intakeExternalCommand,
  validateIntakeExternalPreview,
  type IntakeExternalReview,
} from "./source-intake-external-ui";
import { Notice, formatDate, selectClass, useDirty } from "./shared";
import {
  IntakeHttpError,
  intakeBatchError,
  intakeCanRead,
  intakeCanResume,
  intakeCanUpload,
  intakeCanCancel,
  intakeCommand,
  intakeFileError,
  intakeErrorMessage,
  intakeNonce,
  intakePendingState,
  intakeReplayIsReadOnly,
  sendIntakeRequest,
  validateIntakeResponse,
  validateIntakeStatus,
  type IntakeFile,
  type IntakePending,
} from "./source-intakes-ui";

export type IntakeReviewDraft = {
  itemId: string;
  itemVersion: number;
  revision: number;
  resultId: string;
  originalSha256: string;
  sourceUpdatedAt: string;
  text: string;
  reviewed: boolean;
};
export function intakeReviewDraft(
  company: StudioCase,
  item: SourceIntakeItem,
): IntakeReviewDraft | null {
  if (
    item.phase !== "awaiting_review" ||
    !item.original ||
    !item.result?.content ||
    item.result.discardedAt
  )
    return null;
  return {
    itemId: item.id,
    itemVersion: item.version,
    revision: company.revision,
    resultId: item.result.id,
    originalSha256: item.result.originalSha256,
    sourceUpdatedAt: item.result.sourceUpdatedAt,
    text: sourceIntakeResultText(item.result.content),
    reviewed: false,
  };
}
export function intakeReviewProblem(company: StudioCase, draft: IntakeReviewDraft): string {
  const matches = company.sourceIntakes.filter((item) => item.id === draft.itemId),
    item = matches.length === 1 ? matches[0] : null;
  if (
    company.revision !== draft.revision ||
    !item ||
    item.version !== draft.itemVersion ||
    item.phase !== "awaiting_review" ||
    item.result?.id !== draft.resultId ||
    !item.result.content ||
    item.result.originalSha256 !== draft.originalSha256 ||
    item.result.sourceUpdatedAt !== draft.sourceUpdatedAt ||
    item.original?.sha256 !== draft.originalSha256
  )
    return "기업·원본·결과 버전이 바뀌었습니다. 교정 내용은 유지하며 최신 결과를 다시 확인해 주세요.";
  const sources = company.sources.filter((source) => source.id === item.sourceId);
  if (
    sources.length !== 1 ||
    sources[0].updatedAt !== draft.sourceUpdatedAt ||
    sources[0].extraction !== "pending" ||
    sources[0].text !== ""
  )
    return "자료 본문 또는 원본 연결이 바뀌어 이 결과를 채택할 수 없습니다.";
  if (!draft.text.trim() || draft.text.length > sourceIntakeLimits.resultText)
    return "교정 본문을 1~100,000자 범위로 입력해 주세요.";
  if (!draft.reviewed) return "원본과 교정 본문을 대조한 뒤 확인 항목을 선택해 주세요.";
  return "";
}
export function IntakeResultReview({
  company,
  item,
  draft,
  disabled,
  error,
  onChange,
  onSave,
  onClose,
}: {
  company: StudioCase;
  item: SourceIntakeItem;
  draft: IntakeReviewDraft;
  disabled: boolean;
  error: string;
  onChange: (value: IntakeReviewDraft) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const prefix = useId(),
    problem = intakeReviewProblem(company, draft),
    result = item.result;
  return (
    <section
      aria-label="접수 판독문 교정·채택"
      className="space-y-4 rounded-xl border border-primary/30 p-4"
    >
      <h4 className="font-semibold">미검토 판독문 교정·채택</h4>
      <Notice>
        판독 결과는 아직 분석 근거가 아닙니다. 숫자·날짜·표와 원문 위치를 대조하고 필요한 본문을
        교정해 주세요. 채택 후에도 사실 검증·원고 검토·기관 제출이 완료된 것은 아닙니다.
      </Notice>
      {result && (
        <details>
          <summary className="cursor-pointer text-xs underline">
            저장된 미검토 판독 결과와 위치 보기
          </summary>
          {result.content?.kind === "pages" ? (
            result.content.pages.map((page) => (
              <article key={page.pageNumber} className="mt-3">
                <h5 className="text-xs font-semibold">원본 {page.pageNumber}페이지</h5>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
                  {page.text || "읽힌 글자 없음"}
                </pre>
              </article>
            ))
          ) : (
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap text-xs">
              {result.content?.text ?? "판독문이 명시적으로 폐기되었습니다."}
            </pre>
          )}
          <p className="mt-3 break-all text-xs">판독문 SHA-256: {result.textSha256}</p>
          <p className="break-all text-xs">판독 원본 SHA-256: {result.originalSha256}</p>
        </details>
      )}
      {item.original && (
        <a
          className="inline-block text-xs underline"
          href={`/api/studio/cases/${company.id}/sources/${item.sourceId}`}
          download
        >
          현재 보관 원본 내려받아 대조
        </a>
      )}
      <p className="text-xs">
        다운로드는 현재 파일입니다. 채택 시 원본 SHA·자료 수정시각·결과 ID를 다시 검사합니다. 채택은
        기존 분석과 원고 근거의 재검토가 필요한 변경입니다.
      </p>
      <fieldset disabled={disabled} className="space-y-3">
        <Label htmlFor={`${prefix}-text`}>원본과 대조해 교정할 본문</Label>
        <Textarea
          id={`${prefix}-text`}
          value={draft.text}
          maxLength={sourceIntakeLimits.resultText}
          className="min-h-64 leading-7"
          onChange={(event) => onChange({ ...draft, text: event.target.value, reviewed: false })}
        />
        <p className="text-right text-xs">{draft.text.length.toLocaleString()} / 100,000자</p>
        <label className="flex items-start gap-2 text-sm leading-6">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={draft.reviewed}
            onChange={(event) => onChange({ ...draft, reviewed: event.target.checked })}
          />
          <span>원본과 대조해 교정한 본문을 직접 입력 자료로 채택하는 내용을 확인했습니다.</span>
        </label>
        {problem && <Notice tone="warning">{problem}</Notice>}
        {error && (
          <div role="alert">
            <Notice tone="warning">{error}</Notice>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!!problem} onClick={onSave}>
            확인한 본문 채택
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            교정 닫기
          </Button>
        </div>
      </fieldset>
    </section>
  );
}

type Props = {
  company: StudioCase;
  blockedReason?: string;
  busy: boolean;
  onCompany: (company: StudioCase) => void;
  onBusyChange: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
};
export function SourceIntakesPanel(props: Props) {
  return <SourceIntakesPanelInner key={props.company.id} {...props} />;
}
function SourceIntakesPanelInner({
  company,
  blockedReason = "",
  busy,
  onCompany,
  onBusyChange,
  onDirtyChange,
}: Props) {
  const prefix = useId();
  const [files, setFiles] = useState<IntakeFile[]>([]),
    [review, setReview] = useState<IntakeReviewDraft | null>(null);
  const [externalReview, setExternalReview] = useState<IntakeExternalReview | null>(null);
  const [active, setActive] = useState<string[]>([]),
    [loaded, setLoaded] = useState(false),
    [requesting, setRequesting] = useState(false),
    [checkRequired, setCheckRequired] = useState(false),
    [hasPending, setHasPending] = useState(false);
  const [error, setError] = useState(""),
    [errorCode, setErrorCode] = useState(""),
    [message, setMessage] = useState(""),
    [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const current = useRef(company),
    callbacks = useRef({ onCompany, onBusyChange }),
    mounted = useRef(false),
    inFlight = useRef(false);
  const pending = useRef<IntakePending | null>(null),
    rejected = useRef(false),
    readEpoch = useRef(0);
  const companyId = company.id,
    endpoint = `/api/studio/cases/${companyId}/source-intakes`;
  useEffect(() => {
    current.current = company;
    callbacks.current = { onCompany, onBusyChange };
  }, [company, onCompany, onBusyChange]);
  const apply = useCallback((next: StudioCase) => {
    current.current = next;
    setExternalReview(null);
    setFiles((previous) =>
      previous.filter(
        (entry) =>
          !next.sourceIntakes.some(
            (item) =>
              item.clientFileId === entry.clientFileId &&
              (item.phase === "cancelled" ||
                (item.original && next.sources.some((source) => source.id === item.sourceId))),
          ),
      ),
    );
    callbacks.current.onCompany(next);
  }, []);
  const readStatus = useCallback(async () => {
    const baseline = current.current;
    const epoch = ++readEpoch.current;
    const response = await fetch(endpoint, { cache: "no-store" });
    const raw: unknown = await response.json().catch(() => null);
    if (!mounted.current || current.current.id !== companyId || epoch !== readEpoch.current)
      return null;
    const snapshot = response.ok
      ? validateIntakeStatus(raw, companyId, Math.max(baseline.revision, current.current.revision))
      : null;
    if (!snapshot) throw new Error("저장된 접수 상태를 확인하지 못했습니다. 다시 조회해 주세요.");
    setActive(snapshot.activeItemIds);
    setLoaded(true);
    let unresolved = false;
    if (pending.current) {
      const resolution = intakePendingState(
        snapshot.company,
        companyId,
        pending.current,
        rejected.current,
        snapshot.activeItemIds,
      );
      if (resolution !== "unknown") {
        if (
          resolution === "acknowledged" &&
          pending.current.kind === "command" &&
          pending.current.command.action === "adopt"
        ) {
          setReview(null);
          setMessage("본문 채택 기록을 확인했습니다. 성공한 채택을 다시 실행하지 않습니다.");
        }
        pending.current = null;
        rejected.current = false;
        setHasPending(false);
      } else unresolved = true;
    }
    setCheckRequired(unresolved || snapshot.activeItemIds.length > 0);
    apply(snapshot.company);
    return { ...snapshot, unresolved };
  }, [apply, companyId, endpoint]);
  useEffect(() => {
    mounted.current = true;
    inFlight.current = true;
    callbacks.current.onBusyChange("저장된 파일 접수 상태를 불러오는 중입니다");
    const epoch = readEpoch.current + 1;
    void readStatus()
      .catch(() => {
        if (mounted.current && readEpoch.current === epoch) {
          setError("저장된 접수 상태를 불러오지 못했습니다. ‘저장 상태 확인’을 눌러 주세요.");
          setCheckRequired(true);
        }
      })
      .finally(() => {
        if (mounted.current && readEpoch.current === epoch) {
          inFlight.current = false;
          callbacks.current.onBusyChange("");
        }
      });
    return () => {
      mounted.current = false;
      readEpoch.current = epoch + 1;
    };
  }, [readStatus]);
  useDirty(
    files.length > 0 || review !== null || externalReview !== null || hasPending || requesting,
    onDirtyChange,
  );
  const blocked = !!blockedReason || busy || requesting;
  const actionsBlocked = blocked || !loaded || checkRequired || hasPending || active.length > 0;
  const newFiles = files.filter(
    (entry) => !company.sourceIntakes.some((item) => item.clientFileId === entry.clientFileId),
  );
  const validFiles = newFiles.filter((entry) => !intakeFileError(entry.file));
  const batchProblem = intakeBatchError(validFiles);
  function lock(message: string) {
    inFlight.current = true;
    setRequesting(true);
    callbacks.current.onBusyChange(message);
  }
  function unlock() {
    inFlight.current = false;
    if (mounted.current) {
      setRequesting(false);
      callbacks.current.onBusyChange("");
    }
  }
  async function perform(request: IntakePending) {
    pending.current = request;
    rejected.current = false;
    setHasPending(true);
    try {
      const raw = await sendIntakeRequest(endpoint, request);
      if (!mounted.current || current.current.id !== companyId) return null;
      const next = validateIntakeResponse(raw, companyId, request, current.current.revision);
      if (!next) throw new Error("접수 결과의 기업·버전·요청 기록이 일치하지 않습니다.");
      pending.current = null;
      setHasPending(false);
      setCheckRequired(false);
      const itemId =
        request.kind === "original"
          ? request.itemId
          : request.command.action === "create"
            ? null
            : request.command.itemId;
      if (itemId) {
        setItemErrors((previous) =>
          Object.fromEntries(Object.entries(previous).filter(([id]) => id !== itemId)),
        );
      }
      apply(next);
      return next;
    } catch (caught) {
      if (mounted.current) {
        rejected.current = caught instanceof IntakeHttpError && caught.accepted === false;
        setCheckRequired(true);
        const code = caught instanceof IntakeHttpError ? caught.code : "INTAKE_RESULT_UNKNOWN";
        setErrorCode(code);
        setError(intakeErrorMessage(code));
        if (request.kind === "original")
          setItemErrors((previous) => ({ ...previous, [request.itemId]: code }));
        else if (request.command.action !== "create") {
          const itemId = request.command.itemId;
          setItemErrors((previous) => ({ ...previous, [itemId]: code }));
        }
      }
      throw caught;
    }
  }
  async function refresh() {
    if (blocked || inFlight.current) return;
    lock("저장된 파일 접수 상태만 확인하는 중입니다");
    setError("");
    setErrorCode("");
    try {
      const result = await readStatus();
      if (result?.unresolved)
        setError(
          "이 요청의 저장 기록을 아직 확인하지 못했습니다. 기존 요청으로 결과를 확인할 수 있습니다.",
        );
      else setMessage("저장 상태를 확인했습니다. 완료한 단계를 자동으로 다시 실행하지 않습니다.");
    } catch {
      if (mounted.current)
        setError("저장된 접수 상태를 확인하지 못했습니다. 새 요청은 보내지 않았습니다.");
    } finally {
      unlock();
    }
  }
  async function replay() {
    if (blocked || inFlight.current || !pending.current || !loaded || active.length > 0) return;
    // An explicit GET must precede re-sending an uncertain request.
    lock("같은 요청 번호로 저장 결과를 확인하는 중입니다");
    setError("");
    setErrorCode("");
    try {
      const snapshot = await readStatus();
      if (!snapshot || snapshot.activeItemIds.length || !pending.current) return;
      if (intakeReplayIsReadOnly(pending.current)) {
        setError(
          "외부 요청의 저장 결과가 아직 미확인입니다. 이미 처리·과금됐을 수 있어 같은 요청을 재전송하지 않았습니다. 저장 상태만 다시 확인할 수 있습니다.",
        );
        return;
      }
      await perform(pending.current);
    } catch {
      /* The unchanged request stays available for explicit status checks. */
    } finally {
      unlock();
    }
  }
  async function createAndUpload() {
    if (actionsBlocked || inFlight.current || review || externalReview || batchProblem) return;
    const chosen = [...validFiles];
    lock("선택 파일의 원본을 순서대로 접수하는 중입니다");
    setError("");
    setErrorCode("");
    setMessage("");
    try {
      const request = intakeCommand({
        action: "create",
        revision: current.current.revision,
        clientRequestId: crypto.randomUUID(),
        files: chosen.map((entry) => ({
          clientFileId: entry.clientFileId,
          originalName: entry.file.name,
          sizeBytes: entry.file.size,
          kind: entry.kind,
        })),
      });
      const created = await perform(request);
      if (!created || request.kind !== "command") return;
      const first = created.sourceIntakes.find((item) =>
        item.requests.some((receipt) => receipt.clientRequestId === intakeNonce(request)),
      );
      if (!first) return;
      for (const entry of chosen) {
        if (!mounted.current) return;
        const matches = current.current.sourceIntakes.filter(
          (item) => item.batchId === first.batchId && item.clientFileId === entry.clientFileId,
        );
        if (matches.length !== 1 || !intakeCanUpload(matches[0])) continue;
        const item = matches[0];
        try {
          await perform({
            kind: "original",
            itemId: item.id,
            input: {
              revision: current.current.revision,
              clientRequestId: crypto.randomUUID(),
              expectedItemVersion: item.version,
            },
            file: entry.file,
          });
        } catch {
          if (!rejected.current) return;
          const refreshed = await readStatus();
          if (!refreshed || refreshed.unresolved || refreshed.activeItemIds.length) return;
        }
      }
      if (mounted.current)
        setMessage(
          "파일별 원본 접수 결과를 확인해 주세요. 판독과 본문 채택은 아래에서 별도로 진행합니다.",
        );
    } catch {
      /* preserve pending nonce and successful earlier files */
    } finally {
      unlock();
    }
  }
  async function uploadOriginal(item: SourceIntakeItem) {
    if (actionsBlocked || inFlight.current || review || externalReview || !intakeCanUpload(item))
      return;
    const entry = files.find((file) => file.clientFileId === item.clientFileId);
    if (
      !entry ||
      intakeFileError(entry.file) ||
      entry.file.name !== item.declared.originalName ||
      entry.file.size !== item.declared.sizeBytes
    ) {
      setItemErrors((previous) => ({
        ...previous,
        [item.id]:
          "원래 선언한 이름·크기의 파일을 직접 선택해 주세요. 서버에서 실제 내용을 대조합니다.",
      }));
      return;
    }
    lock("선택한 미접수 원본을 보관하는 중입니다");
    setError("");
    setErrorCode("");
    try {
      await perform({
        kind: "original",
        itemId: item.id,
        input: {
          revision: current.current.revision,
          clientRequestId: crypto.randomUUID(),
          expectedItemVersion: item.version,
        },
        file: entry.file,
      });
    } catch {
      /* GET before another write */
    } finally {
      unlock();
    }
  }
  async function run(item: SourceIntakeItem, engine?: SourceIntakeLocalEngine) {
    if (
      actionsBlocked ||
      inFlight.current ||
      review ||
      externalReview ||
      (engine
        ? !intakeCanRead(item) || !sourceIntakeEngineSupports(item.declared.originalName, engine)
        : !intakeCanResume(item))
    )
      return;
    const common = {
      revision: current.current.revision,
      clientRequestId: crypto.randomUUID(),
      itemId: item.id,
      expectedItemVersion: item.version,
    };
    lock(
      item.phase === "requesting_external"
        ? "이전 외부 요청의 미확인 상태만 정리하는 중입니다. 다시 전송하지 않습니다"
        : engine === "windows-ko"
          ? "이 PC의 Windows OCR로 판독하는 중입니다"
          : "저장된 원본의 로컬 단계를 처리하는 중입니다",
    );
    setError("");
    setErrorCode("");
    try {
      await perform(
        intakeCommand(
          engine ? { action: "run-next", ...common, engine } : { action: "resume", ...common },
        ),
      );
    } catch {
      /* no parser retry without user action */
    } finally {
      unlock();
    }
  }
  async function prepareExternal(item: SourceIntakeItem, engine: SourceIntakeExternalEngine) {
    if (
      actionsBlocked ||
      inFlight.current ||
      review ||
      externalReview ||
      !intakeCanPrepareExternal(item) ||
      !sourceIntakeExternalSupports(item.declared.originalName, engine)
    )
      return;
    const baseline = current.current;
    lock("원본·전송 대상·모델의 승인 미리보기를 준비하는 중입니다. 외부로 보내지 않습니다");
    setError("");
    setErrorCode("");
    setMessage("");
    try {
      const response = await fetch(`${endpoint}/external-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: baseline.revision,
          itemId: item.id,
          expectedItemVersion: item.version,
          engine,
        }),
        cache: "no-store",
      });
      const raw: unknown = await response.json().catch(() => null);
      if (
        !mounted.current ||
        current.current.id !== baseline.id ||
        current.current.revision !== baseline.revision
      )
        return;
      if (!response.ok) {
        const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        throw new IntakeHttpError(
          typeof body.code === "string" && /^[A-Z0-9_]{1,100}$/.test(body.code)
            ? body.code
            : "INTAKE_PREVIEW_FAILED",
          false,
        );
      }
      const preview = validateIntakeExternalPreview(raw, current.current, item, engine);
      if (!preview) throw new Error("Invalid approval preview");
      setExternalReview({
        preview,
        clientRequestId: crypto.randomUUID(),
        approved: false,
        acknowledgePossibleDuplicate: false,
      });
    } catch (caught) {
      if (mounted.current) {
        const code = caught instanceof IntakeHttpError ? caught.code : "INTAKE_PREVIEW_FAILED";
        setErrorCode(code);
        setError(
          caught instanceof IntakeHttpError
            ? intakeErrorMessage(code)
            : "전송 검토안을 확인하지 못했습니다. 외부 전송은 시작하지 않았습니다. 저장 상태와 설정을 확인해 주세요.",
        );
      }
    } finally {
      unlock();
    }
  }
  async function executeExternal() {
    if (actionsBlocked || inFlight.current || review || !externalReview) return;
    const command = intakeExternalCommand(current.current, externalReview);
    if (!command) {
      setError("원본·기업 버전과 전송 동의, 필요한 중복 비용 확인을 다시 확인해 주세요.");
      return;
    }
    lock("승인한 원본의 외부 판독·전사 결과를 기다리는 중입니다");
    setError("");
    setErrorCode("");
    setMessage("");
    setExternalReview(null);
    try {
      await perform(intakeCommand(command));
    } catch {
      /* Retain this nonce for GET-only reconciliation; never replay an external POST. */
    } finally {
      unlock();
    }
  }
  async function adopt() {
    if (
      !review ||
      externalReview ||
      actionsBlocked ||
      inFlight.current ||
      intakeReviewProblem(current.current, review)
    )
      return;
    const parsed = sourceIntakeCommandSchema.safeParse({
      action: "adopt",
      revision: review.revision,
      clientRequestId: crypto.randomUUID(),
      itemId: review.itemId,
      expectedItemVersion: review.itemVersion,
      resultId: review.resultId,
      sourceUpdatedAt: review.sourceUpdatedAt,
      originalSha256: review.originalSha256,
      text: review.text,
      reviewed: true,
    });
    if (!parsed.success) {
      setError("교정 본문과 원본·결과 버전을 확인해 주세요.");
      return;
    }
    lock("확인한 판독문을 자료 본문으로 채택하는 중입니다");
    setError("");
    setErrorCode("");
    try {
      const saved = await perform(intakeCommand(parsed.data));
      if (saved && mounted.current) {
        setReview(null);
        setMessage("교정한 본문을 채택했습니다. 변경된 근거로 분석과 원고를 다시 검토해 주세요.");
      }
    } catch {
      /* corrected text remains available */
    } finally {
      unlock();
    }
  }
  async function discard(item: SourceIntakeItem) {
    if (actionsBlocked || inFlight.current || review || externalReview || !item.result?.content)
      return;
    if (
      !window.confirm(
        item.adoption
          ? "보관한 판독 초안 본문만 비울까요? 이미 채택한 자료 본문, 원본 파일, 작업·채택 기록과 결과 해시는 보존합니다. 비운 판독 초안은 되돌릴 수 없습니다."
          : "미검토 판독문 본문을 폐기할까요? 원본 파일과 작업·결과 식별값은 보존하며, 본문을 되돌리려면 다시 판독해야 합니다.",
      )
    )
      return;
    lock("보관한 판독 초안 본문만 비우는 중입니다");
    setError("");
    setErrorCode("");
    try {
      await perform(
        intakeCommand({
          action: "discard-result",
          revision: current.current.revision,
          clientRequestId: crypto.randomUUID(),
          itemId: item.id,
          expectedItemVersion: item.version,
          resultId: item.result.id,
          confirmed: true,
        }),
      );
    } catch {
      /* retained request can be checked */
    } finally {
      unlock();
    }
  }
  async function cancelAwaiting(item: SourceIntakeItem) {
    if (actionsBlocked || inFlight.current || review || externalReview || !intakeCanCancel(item))
      return;
    if (
      !window.confirm(
        "이 원본 미접수 항목을 취소할까요? 선택한 로컬 파일은 변경하지 않으며 접수 이력은 보존합니다. 이미 보관한 원본이나 판독 결과는 취소하지 않습니다.",
      )
    )
      return;
    lock("원본 미접수 항목을 취소하는 중입니다");
    setError("");
    setErrorCode("");
    try {
      await perform(
        intakeCommand({
          action: "cancel-awaiting-original",
          revision: current.current.revision,
          clientRequestId: crypto.randomUUID(),
          itemId: item.id,
          expectedItemVersion: item.version,
          confirmed: true,
        }),
      );
    } catch {
      /* keep nonce for explicit status check */
    } finally {
      unlock();
    }
  }
  function closeResultReview() {
    if (inFlight.current) return;
    if (!window.confirm("저장하지 않은 교정을 닫을까요? 보관한 원본과 미검토 판독문은 유지합니다."))
      return;
    setReview(null);
  }
  return (
    <section aria-label="복수파일 접수·판독 재개" className="mb-7 space-y-4 rounded-2xl border p-5">
      <h3 className="font-bold">복수파일 접수·판독 재개</h3>
      <Notice>
        원본 접수 → 미검토 판독문 보관 → 교정·확인 후 본문 채택을 구분합니다. 원본 접수·로컬 판독은
        외부 AI로 전송하지 않습니다. 외부 판독·음성전사는 원본·목적지·모델을 별도로 확인하고 동의한
        요청만 전송합니다. 접수·판독만으로 분석 근거나 검토 완료가 되지 않습니다.
      </Notice>
      <p className="text-xs leading-6">
        최대 10개·파일당 12MiB·합계 24MiB. 화면을 닫으면 선택한 파일은 다시 선택해야 합니다. 서버에
        보관한 원본과 판독 결과는 저장 상태에서 이어갑니다. 탭 종료 뒤 무인 처리를 보장하지
        않습니다.
      </p>
      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={blocked} onClick={() => void refresh()}>
          저장 상태 확인
        </Button>
        {hasPending && (
          <Button
            type="button"
            variant="outline"
            disabled={blocked || !loaded || active.length > 0}
            onClick={() => void replay()}
          >
            같은 요청으로 결과 확인
          </Button>
        )}
      </div>
      {!loaded && (
        <p role="status" className="text-sm">
          저장 상태 확인 전에는 접수·판독을 시작하지 않습니다.
        </p>
      )}
      {active.length > 0 && (
        <Notice>
          서버에서 실행 중인 단계가 있습니다. 같은 단계를 다시 시작하지 않습니다. 완료 후 저장
          상태를 확인해 주세요.
        </Notice>
      )}
      {error && (
        <div role="alert">
          <Notice tone="warning">{error}</Notice>
          {errorCode && (
            <details className="mt-2 text-xs">
              <summary>진단정보</summary>
              <p>{errorCode}</p>
            </details>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {externalReview && (
        <IntakeExternalApprovalReview
          company={company}
          review={externalReview}
          disabled={actionsBlocked || !!review}
          onChange={(next) => {
            if (!actionsBlocked && !review && !inFlight.current) setExternalReview(next);
          }}
          onExecute={() => void executeExternal()}
          onClose={() => {
            if (!inFlight.current) setExternalReview(null);
          }}
        />
      )}
      <fieldset
        disabled={actionsBlocked || !!review || !!externalReview}
        className="space-y-3 rounded-xl border p-4"
      >
        <Label htmlFor={`${prefix}-files`}>여러 원본 파일 선택 (외부 AI 미전송)</Label>
        <Input
          id={`${prefix}-files`}
          type="file"
          multiple
          accept={sourceIntakeExtensions.map((extension) => `.${extension}`).join(",")}
          onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []);
            if (newFiles.length && !window.confirm("접수하지 않은 새 파일 선택을 바꿀까요?"))
              return;
            setFiles((previous) => [
              ...previous.filter((entry) =>
                company.sourceIntakes.some((item) => item.clientFileId === entry.clientFileId),
              ),
              ...chosen.map((file) => ({
                clientFileId: crypto.randomUUID(),
                file,
                kind: "technology" as const,
              })),
            ]);
            setError("");
            setErrorCode("");
            setMessage("");
          }}
        />
        {newFiles.map((entry) => (
          <div
            key={entry.clientFileId}
            className="grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-[1fr_10rem_auto]"
          >
            <div className="break-words">
              <p>{entry.file.name}</p>
              <p className="text-xs">{entry.file.size.toLocaleString()} bytes</p>
              {intakeFileError(entry.file) && (
                <p className="text-xs text-destructive">
                  {intakeFileError(entry.file)} 이 파일은 접수에서 제외합니다.
                </p>
              )}
            </div>
            <select
              aria-label="선택 파일 자료 분류"
              className={selectClass}
              value={entry.kind}
              onChange={(event) =>
                setFiles((previous) =>
                  previous.map((file) =>
                    file.clientFileId === entry.clientFileId
                      ? { ...file, kind: event.target.value as IntakeFile["kind"] }
                      : file,
                  ),
                )
              }
            >
              {sourceKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {sourceKindLabels[kind]}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setFiles((previous) =>
                  previous.filter((file) => file.clientFileId !== entry.clientFileId),
                )
              }
            >
              선택 해제
            </Button>
          </div>
        ))}
        {newFiles.length > 0 && batchProblem && (
          <p className="text-xs text-destructive">{batchProblem}</p>
        )}
        <Button
          type="button"
          disabled={!!batchProblem || company.sourceIntakes.length >= sourceIntakeLimits.items}
          onClick={() => void createAndUpload()}
        >
          지원 가능한 {validFiles.length}개 원본 순차 접수
        </Button>
      </fieldset>
      {company.sourceIntakes.length === 0 && (
        <p className="text-sm text-muted-foreground">
          아직 저장된 복수파일 접수 기록이 없습니다. 기존 단일 업로드 자료를 새 작업 이력으로
          추정하지 않습니다.
        </p>
      )}
      <div className="space-y-4">
        {[...company.sourceIntakes].reverse().map((item) => {
          const entry = files.find((file) => file.clientFileId === item.clientFileId),
            isActive = active.includes(item.id),
            canAct = !actionsBlocked && !review && !externalReview && !isActive;
          return (
            <article
              key={item.id}
              aria-label="파일별 접수 상태"
              className="space-y-3 rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="break-words font-semibold">{item.declared.originalName}</h4>
                  <p className="text-xs text-muted-foreground">
                    {sourceKindLabels[item.declared.kind]} ·{" "}
                    {item.declared.sizeBytes.toLocaleString()} bytes · {formatDate(item.updatedAt)}
                  </p>
                </div>
                <Badge variant="outline">{sourceIntakePhaseLabels[item.phase]}</Badge>
              </div>
              {(item.code || itemErrors[item.id]) && (
                <div className="text-xs text-amber-900">
                  <p>{intakeErrorMessage(item.code || itemErrors[item.id])}</p>
                  <details>
                    <summary>이 항목 진단정보</summary>
                    {item.code || itemErrors[item.id]}
                  </details>
                </div>
              )}
              {item.original && (
                <details>
                  <summary className="cursor-pointer text-xs">보관 원본 식별값</summary>
                  <p className="break-all text-xs">SHA-256: {item.original.sha256}</p>
                  <p className="text-xs">
                    {item.original.mimeType || "MIME 미기록"} · {item.original.sizeBytes} bytes
                  </p>
                </details>
              )}
              {item.phase === "awaiting_original" && (
                <div className="space-y-2">
                  <p className="text-xs">
                    원본이 아직 접수되지 않았습니다. 새로고침 후에는 원래 이름·크기의 파일을 직접
                    다시 선택합니다.
                  </p>
                  <Input
                    aria-label="미접수 원본 다시 선택"
                    type="file"
                    disabled={!canAct}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      setFiles((previous) => [
                        ...previous.filter(
                          (selected) => selected.clientFileId !== item.clientFileId,
                        ),
                        { clientFileId: item.clientFileId, file, kind: item.declared.kind },
                      ]);
                    }}
                  />
                  <p className="text-xs">
                    {entry ? "이 화면에 파일 선택 유지 중" : "파일 다시 선택 필요"}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canAct || !entry}
                    onClick={() => void uploadOriginal(item)}
                  >
                    이 원본 접수
                  </Button>
                  {entry && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={!canAct}
                      onClick={() =>
                        setFiles((previous) =>
                          previous.filter((file) => file.clientFileId !== item.clientFileId),
                        )
                      }
                    >
                      선택 파일 해제
                    </Button>
                  )}
                  {intakeCanCancel(item) && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!canAct}
                      onClick={() => void cancelAwaiting(item)}
                    >
                      원본 미접수 항목 취소
                    </Button>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {intakeCanRead(item) && (
                  <>
                    {sourceIntakeEngineSupports(item.declared.originalName, "local-document") && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!canAct}
                        onClick={() => void run(item, "local-document")}
                      >
                        로컬 문서 판독
                      </Button>
                    )}
                    {sourceIntakeEngineSupports(item.declared.originalName, "windows-ko") && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!canAct}
                        onClick={() => void run(item, "windows-ko")}
                      >
                        이 PC의 Windows OCR로 판독
                      </Button>
                    )}
                  </>
                )}
                {intakeCanResume(item) && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canAct}
                    onClick={() => void run(item)}
                  >
                    {item.phase === "requesting_external"
                      ? "외부 요청 상태 정리 (재전송 없음)"
                      : "저장된 로컬 단계 재개"}
                  </Button>
                )}
                {intakeCanPrepareExternal(item) &&
                  sourceIntakeExternalSupports(item.declared.originalName, "ai-document") && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!canAct}
                      onClick={() => void prepareExternal(item, "ai-document")}
                    >
                      OpenAI 문서 판독 전송 검토
                    </Button>
                  )}
                {intakeCanPrepareExternal(item) &&
                  sourceIntakeExternalSupports(item.declared.originalName, "ai-transcription") && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!canAct}
                      onClick={() => void prepareExternal(item, "ai-transcription")}
                    >
                      OpenAI 음성 전사 전송 검토
                    </Button>
                  )}
                {item.phase === "awaiting_review" && item.result?.content && (
                  <Button
                    type="button"
                    disabled={!canAct}
                    onClick={() => {
                      const draft = intakeReviewDraft(company, item);
                      if (draft) {
                        setReview(draft);
                        setError("");
                        setErrorCode("");
                      }
                    }}
                  >
                    저장 판독문 교정·확인
                  </Button>
                )}
                {item.result?.content && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canAct}
                    onClick={() => void discard(item)}
                  >
                    {item.adoption
                      ? "채택한 본문은 유지하고 판독 초안 비우기"
                      : "미검토 판독문 폐기"}
                  </Button>
                )}
              </div>
              {(item.phase === "requesting_external" ||
                item.phase === "external_result_unknown") && (
                <Notice tone="warning">
                  외부 요청은 이미 처리·과금됐을 수 있습니다. 저장 상태 확인·상태 정리는 파일을 다시
                  보내지 않습니다. 새 전송에는 새 원본·모델 검토와 별도 전송·중복 비용 동의가
                  필요합니다.
                </Notice>
              )}
              {item.phase === "adopted" && (
                <p className="text-xs">
                  교정 본문 채택 완료 · 다시 판독하거나 본문을 덮어쓰지 않습니다. 기존 판독문과
                  원본은 구분해 보관합니다. 판독 초안을 비워도 채택한 자료 본문은 유지됩니다.
                </p>
              )}
              {item.phase === "cancelled" && (
                <p className="text-xs">
                  원본 접수 전에 취소했습니다. 이력은 보존하며 원본 업로드·판독을 실행하지 않습니다.
                </p>
              )}
              {item.phase === "result_discarded" && (
                <p className="text-xs">
                  판독문 본문은 명시적으로 폐기했습니다. 원본과 결과 식별값·채택 기록은 보존합니다.
                </p>
              )}
              {item.phase === "awaiting_capacity" && (
                <p className="text-xs">
                  원본은 보관했습니다. 필요 없는 보관 판독 초안을 명시적으로 비운 뒤 남은 로컬
                  단계만 진행해 주세요.
                </p>
              )}
              {item.result?.warnings.map((warning, index) => (
                <p key={index} className="text-xs text-amber-900">
                  {warning}
                </p>
              ))}
              {item.attempts.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs">
                    판독 시도 {item.attempts.length}회 기록
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {item.attempts.map((attempt) => (
                      <li key={attempt.id}>
                        {attempt.engine === "windows-ko"
                          ? "Windows OCR"
                          : attempt.engine === "local-document"
                            ? "로컬 문서"
                            : sourceIntakeExternalEngineLabels[attempt.engine]}{" "}
                        ·{" "}
                        {attempt.status === "completed"
                          ? "판독 결과 보관"
                          : attempt.status === "running"
                            ? "진행 상태 확인 필요"
                            : attempt.status === "unknown"
                              ? "외부 처리 결과 미확인 · 미전송 증명 아님"
                              : "실패"}{" "}
                        · {formatDate(attempt.startedAt)}
                        {attempt.code && (
                          <details>
                            <summary>실패 원인</summary>
                            <p>{intakeErrorMessage(attempt.code)}</p>
                            <p>진단정보: {attempt.code}</p>
                          </details>
                        )}
                        {attempt.externalRequestStarted && "externalApproval" in attempt && (
                          <details>
                            <summary>이 시도에서 승인한 외부 전송 정보</summary>
                            <p className="break-all">
                              {attempt.externalApproval.originalName} ·{" "}
                              {attempt.externalApproval.sizeBytes.toLocaleString()}바이트 ·{" "}
                              {attempt.externalApproval.mimeType || "MIME 미기록"}
                            </p>
                            <p className="break-all">
                              {attempt.externalApproval.provider} ·{" "}
                              {attempt.externalApproval.destination} ·{" "}
                              {attempt.externalApproval.model}
                            </p>
                            <p className="break-all">
                              원본 SHA-256: {attempt.externalApproval.originalSha256}
                            </p>
                            <p>
                              외부 요청 시작 기록은 공급자의 수신·성공·비용 취소 확인이 아닙니다.
                            </p>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {item.previousResults.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs">
                    이전 판독 결과 {item.previousResults.length}개 식별 기록
                  </summary>
                  {item.previousResults.map((past) => (
                    <p key={past.id} className="mt-2 break-all text-xs">
                      {formatDate(past.generatedAt)} · 본문 폐기 · SHA-256: {past.textSha256}
                    </p>
                  ))}
                </details>
              )}
              {review?.itemId === item.id && (
                <IntakeResultReview
                  company={company}
                  item={item}
                  draft={review}
                  disabled={blocked || checkRequired || hasPending || active.length > 0}
                  error={error}
                  onChange={(next) => {
                    if (!blocked && !hasPending) setReview(next);
                  }}
                  onSave={() => void adopt()}
                  onClose={closeResultReview}
                />
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
