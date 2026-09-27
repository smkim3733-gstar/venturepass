"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ArrowRight, FolderUp, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  caseSchema,
  type SourceDocument,
  type StudioCase,
  type StudioStatus,
} from "@/lib/studio-schema";
import {
  deriveGuidedFlow,
  type GuidedDestination,
  type GuidedStep,
} from "@/lib/studio-guided-flow";
import { currentCandidateSelection } from "@/lib/studio-candidate-selection-types";
import {
  MAX_GUIDED_ATTEMPTS_PER_SCOPE,
  type GuidedPreparationApproval,
  type GuidedPreparationRequest,
} from "@/lib/studio-guided-preparation-types";
import { candidateSelectionAcknowledged, candidateSelectionRequest } from "./candidate-selection";
import {
  guidedPreparationResponse,
  guidedPreparationSnapshot,
  guidedRequestRejected,
} from "./guided-preparation-ui";
import { EvidenceList } from "./evidence";
import { GuidedRepairSummary } from "./guided-repair-summary";
import { guidedQuestions, type GuidedQuestion } from "./guided-questions";
import { GuidedSourceReview } from "./guided-source-review";
import { PreparedPackagesPanel } from "./prepared-packages-panel";
import { GuidedPlanEvidence } from "./guided-plan-evidence";
import { GuidedFollowupStatus } from "./guided-followup-status";
import { useLocalDay } from "./case-attention";
import type { GuidedWorkflowTarget } from "@/lib/studio-guided-followup";
import { jsonBody, studioFetch, useDirty, type StudioMutation } from "./shared";
import styles from "./guided-workspace.module.css";

type Props = {
  company: StudioCase;
  status: StudioStatus | null;
  busy: string;
  blocked: boolean;
  onCompany: (value: StudioCase) => void;
  onBusyChange: (message: string) => void;
  onUnsettledChange: (value: boolean) => void;
  setDirty: (value: boolean) => void;
  mutate: (mutation: StudioMutation) => Promise<StudioCase | null>;
  onDetails: (destination: GuidedDestination, target?: GuidedWorkflowTarget) => void;
  onSettings: () => void;
};

const steps: { id: GuidedStep; label: string }[] = [
  { id: "materials", label: "자료 올리기" },
  { id: "plan", label: "AI 계획서" },
  { id: "application", label: "신청·진행" },
];

export function GuidedWorkspace({
  company,
  status,
  busy,
  blocked,
  onCompany,
  onBusyChange,
  onUnsettledChange,
  setDirty,
  mutate,
  onDetails,
  onSettings,
}: Props) {
  const [currentApproval, setCurrentApproval] = useState<GuidedPreparationApproval | null>(null);
  const today = useLocalDay();
  const flow = deriveGuidedFlow(company, { guidedApproval: currentApproval ?? undefined, today });
  const [step, setStep] = useState<GuidedStep>(flow.step);
  const [describing, setDescribing] = useState(false);
  const [description, setDescription] = useState(company.profile.technologySummary);
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [error, setError] = useState("");
  const [unsettled, setUnsettled] = useState(false);
  const [approval, setApproval] = useState<GuidedPreparationApproval | null>(null);
  const [restartRunId, setRestartRunId] = useState<string | null>(null);
  const [restartAcknowledged, setRestartAcknowledged] = useState(false);
  const [checkedInactive, setCheckedInactive] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [sectionText, setSectionText] = useState("");
  const [sectionVerified, setSectionVerified] = useState(false);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState(false);
  const [answerContext, setAnswerContext] = useState<{
    revision: number;
    questions: GuidedQuestion[];
  } | null>(null);
  const [visibleQuestionCount, setVisibleQuestionCount] = useState(3);
  const [deferred, setDeferred] = useState(false);
  const [sourceReview, setSourceReview] = useState<SourceDocument | null>(null);
  const [sourceReviewDirty, setSourceReviewDirty] = useState(false);
  const [packagePlanId, setPackagePlanId] = useState<string | null>(null);
  const [packageUnsettled, setPackageUnsettled] = useState(false);
  const inFlight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const pendingRequest = useRef<GuidedPreparationRequest | null>(null);
  const editingDirty =
    sourceReviewDirty ||
    (descriptionTouched && description !== company.profile.technologySummary) ||
    editingSection !== null ||
    Object.values(questionAnswers).some((value) => value.trim()) ||
    reason.trim().length > 0;
  useDirty(editingDirty, setDirty);
  useEffect(() => {
    onUnsettledChange(unsettled || packageUnsettled);
    return () => onUnsettledChange(false);
  }, [unsettled, packageUnsettled, onUnsettledChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    // Read only: opening a company never starts AI work or transmits its documents.
    studioFetch<unknown>(`/api/studio/cases/${company.id}/guided-preparation`)
      .then((raw) => {
        const snapshot = guidedPreparationSnapshot(raw, {
          id: company.id,
          revision: company.revision,
        });
        if (active && snapshot?.company.revision === company.revision)
          setCurrentApproval(snapshot.approval);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [company.id, company.revision]);
  const locked = !!busy || blocked || unsettled;
  const latestPlan = [...company.plans].sort((a, b) => b.version - a.version)[0];
  const lastRun = (company.guidedPreparationRuns ?? []).at(-1);
  const retainedDraft = lastRun?.repair?.initialPlanId === latestPlan?.id && !!latestPlan;
  const candidate =
    company.analysis?.candidates.find(
      (item) => item.id === (candidateId ?? company.selectedCandidateId),
    ) ?? company.analysis?.candidates[0];
  const selectedRecord = currentCandidateSelection(company);
  const selection = selectedRecord?.candidateId === candidate?.id ? selectedRecord : null;
  const showPlan =
    !!latestPlan && !["awaiting_choice", "awaiting_materials"].includes(lastRun?.status ?? "");
  const questions = guidedQuestions(company, showPlan ? latestPlan : undefined);
  const shownQuestions = (answering ? (answerContext?.questions ?? questions) : questions).slice(
    0,
    visibleQuestionCount,
  );
  const answerContextChanged = !!answerContext && answerContext.revision !== company.revision;
  const needsReview =
    latestPlan?.content.sections.filter((section) => section.needsConfirmation) ?? [];
  const findings = latestPlan?.review.filter((finding) => finding.severity !== "info") ?? [];
  const aiFindings =
    latestPlan?.content.actionItems.filter((item) => item.startsWith("[AI 검토 의견")) ?? [];
  const editingPlan = company.plans.find((plan) => plan.id === editingPlanId);
  const section = editingPlan?.content.sections.find((item) => item.key === editingSection);
  const editingPlanChanged = editingPlanId !== null && latestPlan?.id !== editingPlanId;
  const existingRunUnknown = lastRun?.status === "running";
  const hasSourceText = company.sources.some(
    (source) => source.extraction !== "pending" && source.text.trim(),
  );
  const hasDescription = company.profile.technologySummary.trim().length > 0;

  function title(value: string, lead: string) {
    return (
      <>
        <h2 className={styles.heading}>{value}</h2>
        <p className={styles.lead}>{lead}</p>
      </>
    );
  }

  function detailLink(label: string, destination: GuidedDestination) {
    return (
      <button
        type="button"
        className={styles.link}
        disabled={locked}
        onClick={() => onDetails(destination)}
      >
        {label}
      </button>
    );
  }
  function goTo(next: GuidedStep) {
    if (busy || blocked || sourceReview || packagePlanId) return;
    setStep(next);
    // Drafts stay in this mounted component when users explore another stage.
    setError("");
  }
  function accept(value: unknown, base: StudioCase) {
    const parsed = caseSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== base.id || parsed.data.revision < base.revision)
      throw new Error("저장한 내용이 현재 회사와 일치하는지 확인하지 못했습니다.");
    onCompany(parsed.data);
    return parsed.data;
  }

  async function readPreparation(base: StudioCase, showApproval: boolean) {
    const raw = await studioFetch<unknown>(`/api/studio/cases/${base.id}/guided-preparation`);
    const snapshot = guidedPreparationSnapshot(raw, base);
    if (!snapshot) throw new Error("최신 준비 상태를 확인하지 못했습니다.");
    if (!mounted.current) return null;
    onCompany(snapshot.company);
    setCurrentApproval(snapshot.approval);
    setCheckedInactive(!snapshot.active);
    if (snapshot.active) {
      setUnsettled(true);
      setError("계획서를 준비하고 있습니다. 잠시 후 저장 상태를 확인해 주세요.");
      return snapshot;
    }
    const request = pendingRequest.current;
    if (request) {
      const found = (snapshot.company.guidedPreparationRuns ?? []).find((run) =>
        run.requests.some((item) => item.clientRequestId === request.clientRequestId),
      );
      if (
        !found ||
        !guidedPreparationResponse({ company: snapshot.company, run: found }, base, request)
      ) {
        setUnsettled(true);
        setError(
          "실행 결과를 확인하지 못했습니다. 중복 전송하지 않고 저장 상태를 다시 확인해 주세요.",
        );
        return snapshot;
      }
      pendingRequest.current = null;
    }
    setUnsettled(false);
    const previous = (snapshot.company.guidedPreparationRuns ?? []).at(-1);
    const sameScope = previous?.approval.inputFingerprint === snapshot.approval.inputFingerprint;
    if (
      showApproval &&
      sameScope &&
      previous &&
      ["awaiting_choice", "awaiting_materials"].includes(previous.status)
    ) {
      setStep("plan");
      setError(
        previous.status === "awaiting_choice"
          ? "준비된 신청 방향을 확인하면 같은 승인 범위로 작성을 이어갑니다."
          : "준비한 질문에 답하거나 필요한 자료를 추가해 주세요.",
      );
      return snapshot;
    }
    if (showApproval && snapshot.aiConfigured) {
      const restart =
        previous &&
        ["running", "failed", "awaiting_review"].includes(previous.status) &&
        (sameScope || previous.status === "running");
      if (
        restart &&
        (snapshot.company.guidedPreparationRuns ?? []).filter(
          (run) => run.approval.inputFingerprint === snapshot.approval.inputFingerprint,
        ).length >= MAX_GUIDED_ATTEMPTS_PER_SCOPE
      ) {
        setError(
          "같은 자료로 준비할 수 있는 횟수에 도달했습니다. 현재 원고를 수정하거나 자료를 보완해 주세요.",
        );
        return snapshot;
      }
      setRestartRunId(restart ? previous.id : null);
      setRestartAcknowledged(false);
      setApproval(snapshot.approval);
    } else if (previous?.status === "running") {
      setError(
        "준비가 중간에 멈춘 기록이 있습니다. 이전 기록을 확인하기 전에는 자동으로 다시 보내지 않습니다.",
      );
    } else if (showApproval)
      setError(
        "AI 서비스 연결이 필요합니다. 자료는 보관되어 있으며, 연결 후 이어서 작성할 수 있습니다.",
      );
    return snapshot;
  }
  async function preparePreview(base = company) {
    if (inFlight.current || busy || blocked || unsettled) return;
    inFlight.current = true;
    onBusyChange("AI가 사용할 자료를 확인하는 중입니다");
    setError("");
    try {
      await readPreparation(base, true);
    } catch {
      if (mounted.current)
        setError("준비 상태를 불러오지 못했습니다. 자료를 다시 전송하지 않았습니다.");
    } finally {
      inFlight.current = false;
      if (mounted.current) onBusyChange("");
    }
  }
  async function reconcile() {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    onBusyChange("저장된 결과를 확인하는 중입니다");
    setError("");
    try {
      await readPreparation(company, false);
    } catch {
      if (mounted.current)
        setError("저장 상태를 확인하지 못했습니다. 작업을 반복하지 않고 이전 자료를 보존합니다.");
    } finally {
      inFlight.current = false;
      if (mounted.current) onBusyChange("");
    }
  }
  async function runPreparation(request: GuidedPreparationRequest, base = company) {
    if (inFlight.current) return;
    inFlight.current = true;
    pendingRequest.current = request;
    setApproval(null);
    setCheckedInactive(false);
    setError("");
    setUnsettled(true);
    onBusyChange("AI가 신청 방향과 사업계획서를 준비하고 근거를 검토하는 중입니다");
    try {
      const response = await fetch(`/api/studio/cases/${base.id}/guided-preparation`, {
        method: "POST",
        cache: "no-store",
        ...jsonBody(request),
      });
      const raw: unknown = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        if (guidedRequestRejected(response.status, raw)) {
          pendingRequest.current = null;
          setUnsettled(false);
        }
        throw new Error(
          typeof body.error === "string" ? body.error : "계획서 준비 결과를 확인하지 못했습니다.",
        );
      }
      const result = guidedPreparationResponse(raw, base, request);
      if (!result) throw new Error("준비 결과가 현재 회사와 일치하는지 확인하지 못했습니다.");
      onCompany(result.company);
      pendingRequest.current = null;
      setUnsettled(false);
      setStep("plan");
      setCandidateId(null);
      setReason("");
      if (result.run.status === "failed")
        setError("AI 준비가 중단되었습니다. 저장된 내용은 보존되며 자동 재전송하지 않습니다.");
    } catch (caught) {
      if (mounted.current)
        setError(
          caught instanceof Error ? caught.message : "계획서 준비 결과를 확인하지 못했습니다.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) onBusyChange("");
    }
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length || inFlight.current || locked) return;
    if (
      files.length + company.sources.length > 40 ||
      files.some((file) => !file.size || file.size > 12 * 1024 * 1024)
    ) {
      setError(
        "자료는 회사별 40개, 파일당 12MB까지 올릴 수 있습니다. 내용이 있는 파일을 선택해 주세요.",
      );
      return;
    }
    inFlight.current = true;
    setError("");
    let current = company;
    let uploaded = 0;
    let uploadUncertain = false;
    try {
      for (const file of files) {
        onBusyChange(`자료를 읽고 보관하는 중입니다 · ${uploaded + 1}/${files.length}`);
        const originalOnly = /\.(png|jpe?g|webp)$/i.test(file.name);
        const form = new FormData();
        form.append("file", file);
        form.append("kind", "other");
        form.append("revision", String(current.revision));
        form.append("allowAi", "false");
        form.append("extractionMode", originalOnly ? "original-only" : "extract");
        uploadUncertain = true;
        let response = await fetch(`/api/studio/cases/${current.id}/sources`, {
          method: "POST",
          body: form,
        });
        let raw: unknown = await response.json();
        // NO_TEXT is rejected before storage. A scanned PDF can safely be kept as an
        // unverified original; uncertain network failures must never trigger a retry.
        if (
          response.status === 422 &&
          raw &&
          typeof raw === "object" &&
          "code" in raw &&
          raw.code === "NO_TEXT" &&
          /\.pdf$/i.test(file.name)
        ) {
          form.set("extractionMode", "original-only");
          response = await fetch(`/api/studio/cases/${current.id}/sources`, {
            method: "POST",
            body: form,
          });
          raw = await response.json();
        }
        if (!mounted.current) return;
        if (!response.ok) {
          if ([400, 403, 409, 413, 415, 422].includes(response.status)) uploadUncertain = false;
          const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          throw new Error(
            typeof body.error === "string" ? body.error : "자료 등록 결과를 확인하지 못했습니다.",
          );
        }
        current = accept(raw, current);
        uploadUncertain = false;
        uploaded += 1;
      }
      setStep(
        current.sources.some((source) => source.extraction !== "pending" && source.text.trim())
          ? "plan"
          : "materials",
      );
      toast.success(`자료 ${uploaded}개를 보관했습니다.`);
      if (
        status?.aiConfigured &&
        current.sources.some((source) => source.extraction !== "pending" && source.text.trim())
      ) {
        onBusyChange("AI가 사용할 자료 범위를 준비하는 중입니다");
        await readPreparation(current, true);
      }
    } catch (caught) {
      if (mounted.current && uploadUncertain) setUnsettled(true);
      if (mounted.current)
        setError(
          `${uploaded ? `${uploaded}개 자료는 보관했습니다. ` : ""}${caught instanceof Error ? caught.message : "자료 등록 상태를 확인하지 못했습니다."} 남은 파일은 자동으로 다시 보내지 않습니다. 자료 목록을 확인해 주세요.`,
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) onBusyChange("");
    }
  }
  async function mutateOnce(mutation: StudioMutation) {
    if (inFlight.current || locked) return null;
    inFlight.current = true;
    try {
      return await mutate(mutation);
    } finally {
      inFlight.current = false;
    }
  }
  async function saveDescription() {
    if (!description.trim() || locked || inFlight.current) return;
    const next = await mutateOnce({
      action: "profile",
      profile: { ...company.profile, technologySummary: description.trim() },
    });
    if (!next || !mounted.current) return;
    setDescribing(false);
    setDescriptionTouched(false);
    setStep("plan");
    setDeferred(false);
    if (status?.aiConfigured) await preparePreview(next);
  }
  async function chooseCandidate() {
    if (!candidate || !reason.trim() || locked || inFlight.current) return;
    const request = candidateSelectionRequest(
      company,
      candidate.id,
      reason.trim(),
      crypto.randomUUID(),
    );
    if (!request) {
      setError("선택할 주제와 이유를 확인해 주세요.");
      return;
    }
    const next = await mutateOnce(request);
    if (!mounted.current) return;
    if (!candidateSelectionAcknowledged(next, company, request) || !next) {
      setError(
        "신청 방향의 저장 결과를 확인하지 못했습니다. 상세 도구에서 최신 선택 기록을 확인해 주세요.",
      );
      return;
    }
    setReason("");
    const run = (next.guidedPreparationRuns ?? []).at(-1);
    if (run?.status === "awaiting_choice")
      await runPreparation(
        {
          action: "continue",
          revision: next.revision,
          clientRequestId: crypto.randomUUID(),
          runId: run.id,
        },
        next,
      );
    else await preparePreview(next);
  }
  function openAnswers() {
    if (!answerContext) setAnswerContext({ revision: company.revision, questions });
    setAnswering(true);
  }
  async function saveAnswers() {
    if (locked || inFlight.current || answerContextChanged) return;
    const answered = (answerContext?.questions ?? questions).filter((question) =>
      questionAnswers[question.id]?.trim(),
    );
    if (!answered.length) {
      setDeferred(true);
      return;
    }
    const answerText =
      "담당자가 입력한 설명입니다. 별도 증빙 확인은 필요합니다.\n\n" +
      answered
        .map((question) => `${question.question}\n답변: ${questionAnswers[question.id].trim()}`)
        .join("\n\n");
    if (answerText.length > 100000) {
      setError(
        "질문과 답변을 합쳐 100,000자까지 저장할 수 있어요. 긴 내용을 줄여 주세요. 입력한 답변은 유지합니다.",
      );
      return;
    }
    const now = new Date().toISOString();
    const next = await mutateOnce({
      action: "source",
      source: {
        id: crypto.randomUUID(),
        name: "사업계획서 준비 답변",
        kind: "consultation",
        text: answerText,
        originalName: null,
        mimeType: null,
        extraction: "manual",
        warnings: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    if (next) {
      setQuestionAnswers({});
      setAnswerContext(null);
      setVisibleQuestionCount(3);
      setAnswering(false);
      await preparePreview(next);
    }
  }
  async function saveSection() {
    if (!latestPlan || !section || editingPlanChanged || locked || inFlight.current) return;
    const next = await mutateOnce({
      action: "save-plan",
      planId: latestPlan.id,
      content: {
        ...latestPlan.content,
        sections: latestPlan.content.sections.map((item) =>
          item.key === section.key
            ? { ...item, content: sectionText, needsConfirmation: !sectionVerified }
            : item,
        ),
      },
    });
    if (next) {
      setEditingSection(null);
      setEditingPlanId(null);
      setSectionVerified(false);
    }
  }
  async function confirmPlan() {
    if (!latestPlan || locked || inFlight.current) return;
    const next = await mutateOnce({ action: "confirm-plan", planId: latestPlan.id });
    if (next) setStep("application");
  }
  function openSection(key: string) {
    const target = latestPlan?.content.sections.find((item) => item.key === key);
    if (!target) return;
    setEditingSection(key);
    setEditingPlanId(latestPlan!.id);
    setSectionText(target.content);
    setSectionVerified(false);
  }

  return (
    <div className={styles.workspace}>
      <nav className={styles.steps} aria-label="신청 준비 3단계">
        {steps.map((item, index) => (
          <button
            type="button"
            key={item.id}
            className={styles.step}
            aria-current={step === item.id ? "step" : undefined}
            disabled={!!busy || blocked || !!sourceReview || !!packagePlanId}
            onClick={() => goTo(item.id)}
          >
            <span className={styles.number}>{index + 1}</span>
            {item.label}
          </button>
        ))}
      </nav>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      {packagePlanId ? (
        <PreparedPackagesPanel
          company={company}
          plan={company.plans.find((item) => item.id === packagePlanId)}
          dirty={editingDirty}
          blocked={blocked || unsettled || existingRunUnknown}
          onBusyChange={onBusyChange}
          onUnsettledChange={setPackageUnsettled}
          onClose={() => setPackagePlanId(null)}
        />
      ) : sourceReview ? (
        <GuidedSourceReview
          key={`${company.id}:${sourceReview.id}`}
          company={company}
          source={company.sources.find((item) => item.id === sourceReview.id) ?? sourceReview}
          busy={!!busy}
          blockedReason={
            blocked || unsettled || existingRunUnknown
              ? "진행 중인 준비 상태를 확인한 뒤 저장해 주세요."
              : ""
          }
          onBusyChange={onBusyChange}
          mutate={mutate}
          onClose={() => {
            setSourceReview(null);
            setSourceReviewDirty(false);
          }}
          onDirtyChange={setSourceReviewDirty}
        />
      ) : busy ? (
        <div role="status" className={styles.sheet}>
          <LoaderCircle aria-hidden="true" className="mb-3 size-5 animate-spin" />
          <h2 className={styles.subheading}>{busy}</h2>
          <p className={styles.helper}>완료되면 다음 내용을 보여 드립니다.</p>
        </div>
      ) : unsettled || existingRunUnknown ? (
        <>
          {title(
            "먼저 저장된 결과를 확인할게요",
            "결과가 불명확한 작업을 자동으로 반복하지 않습니다. 이전 자료와 작성본은 보존됩니다.",
          )}
          <button
            type="button"
            className={styles.primary}
            onClick={() => void reconcile()}
            disabled={!!busy}
          >
            저장 상태 확인
            <ArrowRight aria-hidden="true" />
          </button>
          {checkedInactive && !unsettled && existingRunUnknown && (
            <div className={styles.support}>
              <button type="button" className={styles.link} onClick={() => void preparePreview()}>
                이전 요청을 확인하고 다시 준비
              </button>
            </div>
          )}
        </>
      ) : step === "materials" ? (
        <>
          {describing ? (
            <>
              {title(
                "어떤 사업을 하고 계신가요?",
                "회사 설명부터 시작할 수 있습니다. 없는 실적은 적지 않아도 됩니다.",
              )}
              <section className={styles.sheet}>
                <label className={styles.label} htmlFor="guided-description">
                  현재 제공하는 서비스·기술과 고객
                </label>
                <textarea
                  id="guided-description"
                  className={styles.textarea}
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setDescriptionTouched(true);
                  }}
                  maxLength={10000}
                  placeholder="예: 어떤 고객의 문제를 어떤 방법으로 해결하고 있나요?"
                />
              </section>
              <div className={styles.actions}>
                <button type="button" className={styles.link} onClick={() => setDescribing(false)}>
                  자료 올리기로 돌아가기
                </button>
                {
                  <PrimaryAction
                    disabled={locked || !description.trim()}
                    onClick={() => void saveDescription()}
                  >
                    {"이 설명으로 시작하기"}
                  </PrimaryAction>
                }
              </div>
            </>
          ) : (
            <>
              {title(
                company.sources.length ? "필요한 자료만 추가해 주세요" : "회사 자료만 올려 주세요",
                "가진 자료부터 보관하고, AI가 사업계획서를 준비할 수 있도록 내용을 정리합니다.",
              )}
              <section className={`${styles.sheet} ${styles.upload}`}>
                <FolderUp aria-hidden="true" className={styles.uploadIcon} />
                <h3 className={styles.subheading}>사업자등록증 · 회사소개서 · 재무자료 등</h3>
                <p className={styles.helper}>
                  여러 파일을 함께 선택할 수 있습니다. 파일당 12MB까지 지원합니다.
                </p>
                {
                  <PrimaryAction disabled={locked} onClick={() => fileInput.current?.click()}>
                    {"자료 올리기"}
                  </PrimaryAction>
                }
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="회사 자료 파일 선택"
                  accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp"
                  onChange={(event) => void uploadFiles(event)}
                  disabled={locked}
                />
              </section>
              <div className={styles.support}>
                <button
                  type="button"
                  className={styles.link}
                  disabled={locked}
                  onClick={() => setDescribing(true)}
                >
                  {hasDescription ? "회사 설명 고치기" : "자료 없이 회사 설명부터 시작"}
                </button>
                {company.sources.length > 0 && detailLink("자료 내용 확인·정리", "sources")}
              </div>
              <p className={styles.helper}>
                이 PC에 보관합니다. 외부 AI로 보낼 자료는 별도로 확인받습니다.
              </p>
              {company.sources.length > 0 && (
                <details
                  className={styles.details}
                  open={company.sources.some((source) => source.extraction === "pending")}
                >
                  <summary>올려 둔 자료 {company.sources.length}개</summary>
                  <ul className={styles.files}>
                    {company.sources.map((source) => (
                      <li className={styles.file} key={source.id}>
                        <span>{source.name}</span>
                        <span className={styles.helper}>
                          {source.extraction === "pending"
                            ? "원본 보관 · 본문 확인 필요"
                            : "본문 추출 · 사실 확인은 별도"}
                        </span>
                        <button
                          type="button"
                          className={styles.link}
                          disabled={locked}
                          onClick={() => setSourceReview(source)}
                        >
                          본문 확인·고치기<span className="sr-only"> · {source.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      ) : step === "plan" ? (
        <>
          {editingSection && editingPlan && section ? (
            <>
              {title("바꿀 부분만 고쳐 주세요", "수정본은 새로 보관하고 이전 작성본은 유지합니다.")}
              <section className={styles.sheet}>
                <label className={styles.label} htmlFor="guided-section">
                  {section.title}
                </label>
                <textarea
                  id="guided-section"
                  className={styles.textarea}
                  value={sectionText}
                  onChange={(event) => {
                    setSectionText(event.target.value);
                    setSectionVerified(false);
                  }}
                  maxLength={18000}
                  rows={12}
                />
                <details className={styles.details}>
                  <summary>이 항목의 근거 보기</summary>
                  <EvidenceList company={company} evidence={section.evidence} />
                </details>
                <label className="mt-5 flex items-start gap-3 text-sm leading-7">
                  <input
                    type="checkbox"
                    className="mt-2 size-4 shrink-0"
                    checked={sectionVerified}
                    onChange={(event) => setSectionVerified(event.target.checked)}
                  />
                  이 항목의 사실·수치·근거를 직접 확인했습니다.
                </label>
                <p className={styles.helper}>
                  확인이 끝나지 않았다면 체크하지 않고 수정 내용을 보관할 수 있습니다.
                </p>
              </section>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => {
                    if (
                      sectionText !== section.content &&
                      !window.confirm("수정 중인 내용을 취소할까요?")
                    )
                      return;
                    setEditingSection(null);
                  }}
                >
                  수정 취소
                </button>
                {
                  <PrimaryAction
                    disabled={locked || editingPlanChanged}
                    onClick={() => void saveSection()}
                  >
                    {"수정 반영하기"}
                  </PrimaryAction>
                }
              </div>
              {editingPlanChanged && (
                <p role="alert" className={styles.error}>
                  새 작성본이 생겼습니다. 입력 중인 내용은 이 화면에 보존했고 새 원고에 덮어쓰지
                  않았습니다. 필요한 내용을 복사한 뒤 수정 취소를 눌러 최신 원고를 확인해 주세요.
                </p>
              )}
            </>
          ) : answering && shownQuestions.length ? (
            <>
              {title(
                "아는 내용만 알려 주세요",
                "처음에는 세 가지를 보여 드립니다. 필요한 질문을 더 열어 이어서 답할 수 있어요.",
              )}
              <section className={styles.sheet}>
                {shownQuestions.map((question, index) => (
                  <div key={question.id} className={index ? styles.answer : undefined}>
                    <label htmlFor={`guided-answer-${index}`} className={styles.label}>
                      {question.question}
                    </label>
                    <p className={`${styles.helper} mb-3`}>{question.reason}</p>
                    <textarea
                      id={`guided-answer-${index}`}
                      className={styles.textarea}
                      maxLength={5000}
                      value={questionAnswers[question.id] ?? ""}
                      onChange={(event) =>
                        setQuestionAnswers((current) => ({
                          ...current,
                          [question.id]: event.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
              </section>
              {(answerContext?.questions.length ?? questions.length) > shownQuestions.length && (
                <button
                  type="button"
                  className={styles.link}
                  disabled={locked}
                  onClick={() => setVisibleQuestionCount((count) => count + 3)}
                >
                  남은 질문{" "}
                  {(answerContext?.questions.length ?? questions.length) - shownQuestions.length}개
                  더 보기
                </button>
              )}
              {answerContextChanged && (
                <div className={styles.notice} role="status">
                  <strong>자료가 바뀌어 입력한 답변을 보관하고 있어요</strong>
                  <p>
                    현재 질문과 다시 대조한 뒤 저장해 주세요. 입력 내용은 자동으로 지우지 않습니다.
                  </p>
                  <button
                    type="button"
                    className={styles.link}
                    disabled={locked}
                    onClick={() => {
                      if (
                        Object.values(questionAnswers).some((value) => value.trim()) &&
                        !window.confirm(
                          "입력한 답변을 지우고 현재 질문을 다시 볼까요? 필요한 내용은 먼저 복사해 주세요.",
                        )
                      )
                        return;
                      setQuestionAnswers({});
                      setAnswerContext({ revision: company.revision, questions });
                      setVisibleQuestionCount(3);
                    }}
                  >
                    입력 취소하고 현재 질문 보기
                  </button>
                </div>
              )}
              {deferred && (
                <p className={styles.notice}>
                  답변이 필요한 항목을 남겨 두었습니다. 자료가 준비되면 이어서 답할 수 있습니다.
                </p>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => {
                    setDeferred(true);
                    setAnswering(false);
                  }}
                >
                  지금은 없어요 · 나중에 답하기
                </button>
                {
                  <PrimaryAction
                    disabled={
                      locked ||
                      answerContextChanged ||
                      !Object.values(questionAnswers).some((answer) => answer.trim())
                    }
                    onClick={() => void saveAnswers()}
                  >
                    {"답변 반영하기"}
                  </PrimaryAction>
                }
              </div>
            </>
          ) : lastRun?.status === "failed" && !retainedDraft ? (
            <>
              {title(
                "AI 준비가 중간에 멈췄어요",
                "이전 자료와 원고는 보관했습니다. 저장 상태와 보낼 자료를 확인한 뒤 다시 준비할 수 있습니다.",
              )}
              <section className={styles.sheet}>
                <h3 className={styles.subheading}>자동으로 다시 보내지 않았습니다</h3>
                <p className={styles.helper}>
                  다시 준비할 때는 이전 요청의 처리 가능성과 현재 전송 범위를 확인받습니다.
                </p>
              </section>
              <div className={styles.actions}>
                {detailLink("이전 원고 확인", "plan")}
                {
                  <PrimaryAction disabled={locked} onClick={() => void preparePreview()}>
                    {"확인 후 다시 준비"}
                  </PrimaryAction>
                }
              </div>
            </>
          ) : showPlan && latestPlan ? (
            <>
              {title(
                "준비한 계획서를 확인해 주세요",
                "요약을 먼저 살펴보고, 확인이 필요한 부분이나 다른 내용만 고쳐 주세요.",
              )}
              <section className={`${styles.sheet} ${styles.topic}`}>
                <p className={styles.eyebrow}>
                  {latestPlan.mode === "ai"
                    ? "AI 작성 · 사용자 검토 필요"
                    : latestPlan.mode === "assisted"
                      ? "자료 기반 정리본 · AI 작성 아님"
                      : "수정해 보관한 계획서"}
                </p>
                <h3 className={styles.topicTitle}>{latestPlan.content.title}</h3>
                <p className={styles.body}>{latestPlan.content.summary}</p>
                <details className={styles.details}>
                  <summary>전체 사업계획서 읽기</summary>
                  {latestPlan.content.sections.map((item) => (
                    <article key={item.key} className="mt-6 border-t pt-5">
                      <h4 className={styles.subheading}>{item.title}</h4>
                      <p className={styles.body}>{item.content}</p>
                      <button
                        type="button"
                        className={styles.link}
                        onClick={() => openSection(item.key)}
                        disabled={locked}
                      >
                        이 부분 고치기{item.needsConfirmation ? " · 확인 필요" : ""}
                      </button>
                    </article>
                  ))}
                </details>
              </section>
              <GuidedPlanEvidence company={company} plan={latestPlan} />
              <GuidedRepairSummary company={company} run={lastRun} />
              {(needsReview.length > 0 || findings.length > 0 || aiFindings.length > 0) && (
                <div className={styles.notice}>
                  <strong>확인할 내용이 남아 있어요</strong>
                  <ul className={styles.reviewList}>
                    {[
                      ...aiFindings,
                      ...findings.map((finding) => finding.action || finding.message),
                      ...needsReview.map((item) => `${item.title}: 사실과 근거 확인`),
                    ]
                      .slice(0, 3)
                      .map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                  </ul>
                  {Math.max(findings.length, needsReview.length) > 3 && (
                    <p className="mt-2">나머지는 전체 원고에서 확인할 수 있습니다.</p>
                  )}
                </div>
              )}
              {flow.guidedInputState === "changed" && (
                <p className={styles.notice}>
                  자료가 바뀌어 이전 원고를 보여 드리고 있습니다. 현재 자료로 다시 준비한 뒤 검토를
                  이어가세요.
                </p>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => openSection(latestPlan.content.sections[0]?.key ?? "")}
                  disabled={locked}
                >
                  내용 고치기
                </button>
                {flow.guidedInputState === "changed" ? (
                  <PrimaryAction disabled={locked} onClick={() => void preparePreview()}>
                    {"현재 자료로 다시 준비"}
                  </PrimaryAction>
                ) : flow.guidedInputState === "unverified" ? (
                  <PrimaryAction disabled={locked} onClick={() => void reconcile()}>
                    {"최신 자료 연결 확인"}
                  </PrimaryAction>
                ) : needsReview.length ? (
                  <PrimaryAction disabled={locked} onClick={() => openSection(needsReview[0].key)}>
                    {"확인이 필요한 부분 보기"}
                  </PrimaryAction>
                ) : findings.some(
                    (item) => item.severity === "error" || item.category === "confirmation",
                  ) ? (
                  <PrimaryAction disabled={locked} onClick={() => onDetails("plan")}>
                    {"검토 의견 확인하기"}
                  </PrimaryAction>
                ) : latestPlan.confirmedAt && flow.planReady ? (
                  <PrimaryAction disabled={locked} onClick={() => setStep("application")}>
                    {"신청 준비 이어가기"}
                  </PrimaryAction>
                ) : latestPlan.confirmedAt ? (
                  <PrimaryAction disabled={locked} onClick={() => onDetails("plan")}>
                    {"준비 상태 자세히 확인"}
                  </PrimaryAction>
                ) : (
                  <PrimaryAction disabled={locked} onClick={() => void confirmPlan()}>
                    {"검토 마치고 신청 준비"}
                  </PrimaryAction>
                )}
              </div>
              <details className={styles.details}>
                <summary>추가 자료·AI 다시 작성·내려받기</summary>
                <div className={styles.support}>
                  <button
                    type="button"
                    className={styles.link}
                    disabled={locked}
                    onClick={() => setStep("materials")}
                  >
                    자료 추가
                  </button>
                  <button
                    type="button"
                    className={styles.link}
                    disabled={locked}
                    onClick={() => void preparePreview()}
                  >
                    현재 자료로 AI 다시 작성
                  </button>
                  <button
                    type="button"
                    className={styles.link}
                    disabled={locked}
                    onClick={() => setPackagePlanId(latestPlan.id)}
                  >
                    원고·첨부 보관 및 내려받기
                  </button>
                </div>
              </details>
            </>
          ) : candidate ? (
            <>
              {title(
                "이 방향으로 계획서를 준비할까요?",
                "자료에서 찾은 신청 주제입니다. 실제 사업과 맞는지 확인해 주세요.",
              )}
              <section className={`${styles.sheet} ${styles.topic}`}>
                <p className={styles.eyebrow}>
                  {company.analysis?.mode === "ai"
                    ? "AI 추천 신청 주제"
                    : "자료에서 정리한 신청 주제"}
                </p>
                <h3 className={styles.topicTitle}>{candidate.title}</h3>
                <dl className={styles.facts}>
                  <div className={styles.fact}>
                    <dt>고객의 문제</dt>
                    <dd>{candidate.problem}</dd>
                  </div>
                  <div className={styles.fact}>
                    <dt>해결 방법</dt>
                    <dd>{candidate.solution}</dd>
                  </div>
                  <div className={styles.fact}>
                    <dt>추천 이유</dt>
                    <dd>{candidate.recommendation}</dd>
                  </div>
                </dl>
                <details className={styles.details}>
                  <summary>근거와 확인할 내용</summary>
                  <EvidenceList company={company} evidence={candidate.evidence} />
                  <ul className={styles.reviewList}>
                    {candidate.gaps.map((gap, index) => (
                      <li key={index}>{gap}</li>
                    ))}
                  </ul>
                </details>
              </section>
              {!selection && (
                <div className="mt-5">
                  <label className={styles.label} htmlFor="guided-choice-reason">
                    이 주제가 우리 회사에 맞는 이유를 한 문장으로 알려 주세요
                  </label>
                  <textarea
                    id="guided-choice-reason"
                    className={styles.textarea}
                    maxLength={2000}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="예: 실제로 운영 중인 서비스와 담당 인력의 경험을 설명할 수 있습니다."
                  />
                </div>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => setStep("materials")}
                  disabled={locked}
                >
                  회사 설명·자료 고치기
                </button>
                {selection && lastRun?.status === "awaiting_choice" ? (
                  <PrimaryAction
                    disabled={locked}
                    onClick={() =>
                      void runPreparation({
                        action: "continue",
                        revision: company.revision,
                        clientRequestId: crypto.randomUUID(),
                        runId: lastRun.id,
                      })
                    }
                  >
                    {"선택한 주제로 작성 이어가기"}
                  </PrimaryAction>
                ) : selection ? (
                  <PrimaryAction disabled={locked} onClick={() => void preparePreview()}>
                    {"선택한 주제로 AI 작성"}
                  </PrimaryAction>
                ) : (
                  <PrimaryAction
                    disabled={locked || !reason.trim()}
                    onClick={() => void chooseCandidate()}
                  >
                    {"이 주제로 작성"}
                  </PrimaryAction>
                )}
              </div>
              {(company.analysis?.candidates.length ?? 0) > 1 && (
                <details className={styles.details}>
                  <summary>다른 신청 주제 보기</summary>
                  <div className={styles.support}>
                    {company.analysis?.candidates
                      .filter((item) => item.id !== candidate.id)
                      .map((item) => (
                        <button
                          type="button"
                          className={styles.link}
                          disabled={locked}
                          key={item.id}
                          onClick={() => {
                            setCandidateId(item.id);
                            setReason("");
                          }}
                        >
                          {item.title}
                        </button>
                      ))}
                  </div>
                </details>
              )}
            </>
          ) : (
            <>
              {title(
                hasSourceText || hasDescription
                  ? "이 자료로 계획서를 준비합니다"
                  : "회사 설명부터 시작할 수 있어요",
                hasSourceText || hasDescription
                  ? "현재 자료로 설명할 수 있는 신청 방향을 찾고, 필요한 내용만 질문합니다."
                  : "파일이 없어도 현재 사업과 고객을 설명하면 준비를 시작할 수 있습니다.",
              )}
              {hasSourceText || hasDescription ? (
                <section className={styles.sheet}>
                  <h3 className={styles.subheading}>저장한 자료와 설명</h3>
                  <p className={styles.helper}>
                    자료 {company.sources.length}개{hasDescription ? " · 회사 설명 있음" : ""}
                  </p>
                  {company.profile.technologySummary && (
                    <p className={`${styles.body} mt-4`}>{company.profile.technologySummary}</p>
                  )}
                  {!status?.aiConfigured && (
                    <div className={styles.notice}>
                      <strong>AI 서비스 연결이 필요해요</strong>자료는 보관되어 있습니다. 운영자가
                      연결을 마치면 같은 자료로 이어서 작성할 수 있습니다.
                    </div>
                  )}
                </section>
              ) : (
                <div className={styles.notice}>
                  <strong>가진 자료부터 준비하세요</strong>회사소개서가 없으면 어떤 일을 하는
                  회사인지 직접 설명해 주세요.
                </div>
              )}
              {questions.length > 0 && (
                <div className={styles.notice}>
                  <strong>더 알려 주시면 도움이 되는 내용</strong>
                  <ul className={styles.reviewList}>
                    {shownQuestions.map((question) => (
                      <li key={question.id}>{question.question}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => setStep("materials")}
                  disabled={locked}
                >
                  자료 추가
                </button>
                {hasSourceText || hasDescription ? (
                  status?.aiConfigured ? (
                    <PrimaryAction disabled={locked} onClick={() => void preparePreview()}>
                      {"AI로 계획서 준비"}
                    </PrimaryAction>
                  ) : (
                    <PrimaryAction disabled={locked} onClick={onSettings}>
                      {"AI 연결 상태 확인"}
                    </PrimaryAction>
                  )
                ) : (
                  <PrimaryAction
                    disabled={locked}
                    onClick={() => {
                      setDescribing(true);
                      setStep("materials");
                    }}
                  >
                    {"회사 설명부터 시작"}
                  </PrimaryAction>
                )}
              </div>
              {questions.length > 0 && (
                <div className={styles.support}>
                  <button
                    type="button"
                    className={styles.link}
                    disabled={locked}
                    onClick={() => setDeferred(true)}
                  >
                    지금 자료가 없어요
                  </button>
                </div>
              )}
              {deferred && (
                <p className={styles.helper}>
                  설명과 준비 과제를 보관했습니다. 자료가 생기면 이 화면에서 이어 가세요.
                </p>
              )}
              {!status?.aiConfigured && (
                <details className={styles.details}>
                  <summary>AI 연결 전 할 수 있는 일</summary>
                  {detailLink("저장 자료로 정리본 준비", "analysis")}
                  <p className={styles.helper}>
                    자료를 항목별로 정리하는 기능입니다. AI 사업계획서 작성과 구분합니다.
                  </p>
                </details>
              )}
            </>
          )}
          {!answering &&
            !editingSection &&
            !existingRunUnknown &&
            (questions.length > 0 || answerContext) && (
              <div className={styles.support}>
                <button
                  type="button"
                  className={styles.link}
                  disabled={locked}
                  onClick={openAnswers}
                >
                  {Object.values(questionAnswers).some((value) => value.trim())
                    ? "보관한 답변 보기"
                    : "필요한 질문에 답하기"}
                </button>
              </div>
            )}
        </>
      ) : (
        <>
          {title(
            flow.step === "application" ? flow.title : "신청 준비부터 차례로 이어갑니다",
            flow.step === "application"
              ? flow.description
              : "계획서와 필요한 자료를 확인한 뒤 공식 사이트에 연결합니다.",
          )}
          {flow.followup && flow.followup.state !== "none" && (
            <GuidedFollowupStatus
              stage={company.stage}
              summary={flow.followup}
              disabled={locked}
              onNavigate={(target) => onDetails("workflow", target)}
            />
          )}
          {(!flow.followup || flow.followup.state === "none") && (
            <section className={`${styles.sheet} ${styles.topic}`}>
              <p className={styles.eyebrow}>지금 할 일</p>
              <h3 className={styles.subheading}>
                {flow.step === "application"
                  ? (flow.action?.label ?? "다음 안내 기다리기")
                  : flow.title}
              </h3>
              <p className={styles.helper}>
                {flow.step === "application"
                  ? "입력·첨부할 자료와 최종 제출은 각각 내용을 확인받습니다. 기관 결과가 확인되기 전에는 접수 완료로 표시하지 않습니다."
                  : flow.description}
              </p>
            </section>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.link}
              onClick={() => setStep("plan")}
              disabled={locked}
            >
              계획서 다시 보기
            </button>
            {flow.step === "application" ? (
              flow.action && (
                <PrimaryAction
                  disabled={locked}
                  onClick={() => onDetails(flow.action!.destination, flow.action!.workflowTarget)}
                >
                  {flow.action.label}
                </PrimaryAction>
              )
            ) : (
              <PrimaryAction disabled={locked} onClick={() => setStep(flow.step)}>
                {"현재 준비 단계로 이동"}
              </PrimaryAction>
            )}
          </div>
          <details className={styles.details}>
            <summary>신청 이력·보완·공식 연결</summary>
            <div className={styles.support}>
              {detailLink("기관 안내와 진행 기록", "workflow")}
              {detailLink("벤처인 연결 상태", "venturein")}
            </div>
          </details>
          <div className={styles.support}>
            <button
              type="button"
              className={styles.link}
              disabled={locked}
              onClick={() => setPackagePlanId(latestPlan?.id ?? "history")}
            >
              보관한 준비본 확인
            </button>
          </div>
        </>
      )}
      <Dialog
        open={approval !== null}
        onOpenChange={(open) => {
          if (!busy && !open) setApproval(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {restartRunId
                ? "이 자료로 AI 준비를 다시 진행할까요?"
                : "이 자료로 AI가 계획서를 준비할까요?"}
            </DialogTitle>
            <DialogDescription>
              분석·작성·독립 검토를 이어서 진행합니다. 필요한 신청 방향만 중간에 확인합니다.
            </DialogDescription>
          </DialogHeader>
          {approval && (
            <>
              <dl className={styles.facts}>
                <div className={styles.fact}>
                  <dt>처리 서비스</dt>
                  <dd>
                    {approval.provider} · {approval.model}
                  </dd>
                </div>
                <div className={styles.fact}>
                  <dt>대상 회사</dt>
                  <dd>{company.profile.companyName}</dd>
                </div>
                <div className={styles.fact}>
                  <dt>보낼 내용</dt>
                  <dd>회사 설명·기업정보, 아래 자료의 추출 본문, 작성·검토 과정의 초안</dd>
                </div>
                <div className={styles.fact}>
                  <dt>작성·수정 범위</dt>
                  <dd>
                    {approval.autoRevisionLimit === 1
                      ? "분석·작성·검토 후, 같은 자료로 고칠 수 있는 부분은 최대 1회 자동 수정하고 다시 점검합니다. 확인이 필요한 사실은 남기고 이전 원고도 보관합니다. 분석을 포함해 AI 요청은 최대 5회이며 요청별 사용량·비용이 발생할 수 있습니다."
                      : "분석·작성·독립 검토만 진행합니다. 자동 수정은 포함하지 않습니다."}
                  </dd>
                </div>
              </dl>
              <details className={styles.details}>
                <summary>전송할 자료 {approval.sourceNames.length}개 확인</summary>
                <ul className={styles.files}>
                  {approval.sourceNames.map((name, index) => (
                    <li className={styles.file} key={approval.sourceIds[index]}>
                      {name}
                    </li>
                  ))}
                </ul>
              </details>
              <p className={styles.helper}>
                사업자등록번호 필드와 원본 파일은 포함하지 않습니다. 문서 본문에 기재한 개인정보는
                포함될 수 있으므로 전송 범위를 확인해 주세요. 공식 기관 신청은 실행하지 않습니다.
              </p>
              {restartRunId && (
                <div className={styles.notice}>
                  <strong>이전 요청과 작성본은 보존합니다</strong>
                  <p>
                    이전 요청이 AI 서비스에서 이미 처리됐을 수 있으며, 다시 준비하면 추가
                    사용량·비용이 발생할 수 있습니다. 같은 자료는 처음을 포함해 최대{" "}
                    {MAX_GUIDED_ATTEMPTS_PER_SCOPE}회 준비합니다.
                  </p>
                  <label className="mt-3 flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1.5 size-4 shrink-0"
                      checked={restartAcknowledged}
                      onChange={(event) => setRestartAcknowledged(event.target.checked)}
                    />
                    이전 처리 가능성을 확인했고, 위 범위로 다시 준비하는 데 동의합니다.
                  </label>
                </div>
              )}
              {approval.revision !== company.revision && (
                <p role="alert" className={styles.error}>
                  자료가 바뀌었습니다. 창을 닫고 최신 자료 범위를 다시 확인해 주세요.
                </p>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => setApproval(null)}
                  disabled={!!busy}
                >
                  지금은 자료만 보관
                </button>
                {
                  <PrimaryAction
                    disabled={
                      locked ||
                      approval.revision !== company.revision ||
                      (!!restartRunId && !restartAcknowledged)
                    }
                    onClick={() =>
                      void runPreparation(
                        restartRunId
                          ? {
                              action: "restart",
                              revision: company.revision,
                              clientRequestId: crypto.randomUUID(),
                              approval,
                              approved: true,
                              previousRunId: restartRunId,
                              acknowledgedPreviousAttempt: true,
                            }
                          : {
                              action: "start",
                              revision: company.revision,
                              clientRequestId: crypto.randomUUID(),
                              approval,
                              approved: true,
                            },
                      )
                    }
                  >
                    {restartRunId ? "동의하고 다시 준비" : "허용하고 AI 준비 시작"}
                  </PrimaryAction>
                }
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PrimaryAction({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.primary} disabled={disabled} onClick={onClick}>
      {children}
      <ArrowRight aria-hidden="true" />
    </button>
  );
}
