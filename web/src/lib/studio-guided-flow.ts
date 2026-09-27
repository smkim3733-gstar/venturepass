import { currentCandidateSelection } from "./studio-candidate-selection-types";
import type {
  GuidedPreparationApproval,
  GuidedPreparationRun,
} from "./studio-guided-preparation-types";
import type { BusinessPlan, StudioCase } from "./studio-schema";
import {
  deriveGuidedFollowup,
  type GuidedFollowupSummary,
  type GuidedWorkflowTarget,
} from "./studio-guided-followup";

export type GuidedStep = "materials" | "plan" | "application";
export type GuidedDestination =
  "profile" | "sources" | "diagnosis" | "analysis" | "plan" | "workflow" | "venturein";
export type GuidedFlow = {
  step: GuidedStep;
  title: string;
  description: string;
  action: {
    label: string;
    destination: GuidedDestination;
    workflowTarget?: GuidedWorkflowTarget;
  } | null;
  followup?: GuidedFollowupSummary;
  /** Current local review only. Never a submission permission or official result. */
  planReady: boolean;
  guidedInputState: "none" | "unverified" | "current" | "changed";
};
export type GuidedFlowOptions = {
  today?: string;
  busy?: boolean;
  busyMessage?: string;
  /** Fresh GET approval only; older revisions cannot prove the current input scope. */
  guidedApproval?: Pick<GuidedPreparationApproval, "caseId" | "revision" | "inputFingerprint">;
};

function latestPlan(company: StudioCase): BusinessPlan | null {
  const version = Math.max(0, ...company.plans.map((plan) => plan.version));
  const matches = company.plans.filter((plan) => plan.version === version);
  return matches.length === 1 ? matches[0] : null;
}

function planIsOutdated(
  company: StudioCase,
  plan: BusinessPlan,
  guided?: GuidedPreparationRun,
): boolean {
  const created = Date.parse(plan.generatedAt);
  return (
    !Number.isFinite(created) ||
    !company.analysis ||
    plan.candidateId !== company.selectedCandidateId ||
    company.analysis.sourceRevision > plan.sourceRevision ||
    company.sources.some((source) => Date.parse(source.updatedAt) > created) ||
    (!guided && Boolean(company.diagnoses.at(-1)?.stale)) ||
    (!guided && Boolean(company.preparationRuns.at(-1)?.stale))
  );
}

function guidedInputState(
  company: StudioCase,
  guided: GuidedPreparationRun | undefined,
  options: GuidedFlowOptions,
): GuidedFlow["guidedInputState"] {
  if (!guided) return "none";
  if (guided.approval.caseId !== company.id) return "changed";
  const current = options.guidedApproval;
  if (current?.caseId === company.id && current.revision === company.revision) {
    return current.inputFingerprint === guided.approval.inputFingerprint ? "current" : "changed";
  }
  // Names/IDs and timestamps can prove a change, but cannot prove the profile or text is unchanged.
  const sources = company.sources.filter((source) => source.extraction !== "pending");
  if (
    sources.length !== guided.approval.sourceIds.length ||
    sources.some((source) => !guided.approval.sourceIds.includes(source.id)) ||
    sources.some((source) => Date.parse(source.updatedAt) > Date.parse(guided.updatedAt))
  )
    return "changed";
  return "unverified";
}

function planBelongsToGuidedResult(
  company: StudioCase,
  plan: BusinessPlan | null,
  guided: GuidedPreparationRun,
): boolean {
  if (!plan || !guided.planId || !guided.candidateId) return false;
  const matches = company.plans.filter((item) => item.id === guided.planId);
  if (matches.length !== 1 || plan.candidateId !== guided.candidateId) return false;
  const generated = matches[0];
  if (plan.id === generated.id) return true;
  // A saved edit keeps its candidate and source revision while creating a new manual version.
  return (
    plan.mode === "manual" &&
    plan.version > generated.version &&
    plan.sourceRevision >= generated.sourceRevision &&
    Date.parse(plan.generatedAt) >= Date.parse(generated.generatedAt)
  );
}

/** Read-only navigation hints. Existing server validation remains authoritative. */
export function deriveGuidedFlow(company: StudioCase, options: GuidedFlowOptions = {}): GuidedFlow {
  const plan = latestPlan(company);
  const guided = company.guidedPreparationRuns?.at(-1);
  const inputState = guidedInputState(company, guided, options);
  const outdated = Boolean(plan && planIsOutdated(company, plan, guided));
  const pendingSources = company.sources.filter((source) => source.extraction === "pending");
  const run = company.preparationRuns.at(-1);
  const batch = company.preparationAutomation.batches.at(-1);
  const followup = deriveGuidedFollowup(company, { today: options.today });
  const unsettledPreparation = Boolean(
    guided
      ? guided.status !== "awaiting_review" ||
          !planBelongsToGuidedResult(company, plan, guided) ||
          inputState !== "current"
      : (run && run.status !== "awaiting_review") ||
          (batch && !["awaiting_review", "superseded"].includes(batch.status)),
  );
  const planReady = Boolean(
    plan &&
    !outdated &&
    !pendingSources.length &&
    !unsettledPreparation &&
    currentCandidateSelection(company) &&
    plan.confirmedAt &&
    plan.content.sections.length &&
    plan.content.sections.every(
      (section) => section.content.trim() && !section.needsConfirmation,
    ) &&
    !plan.review.some(
      (finding) => finding.severity === "error" || finding.category === "confirmation",
    ),
  );
  const finish = (flow: Omit<GuidedFlow, "planReady" | "guidedInputState">): GuidedFlow =>
    options.busy
      ? {
          ...flow,
          title: options.busyMessage?.trim() || "현재 작업을 처리하고 있어요",
          description: "처리가 끝나면 다음에 필요한 일을 안내합니다.",
          action: null,
          followup,
          planReady,
          guidedInputState: inputState,
        }
      : { ...flow, planReady, guidedInputState: inputState, followup };
  if (followup.state !== "none") {
    return finish({
      step: "application",
      title: followup.title,
      description: followup.description,
      action: followup.action
        ? {
            label: followup.action.label,
            destination: "workflow",
            workflowTarget: followup.action.target,
          }
        : null,
    });
  }
  if (guided?.status === "running" || guided?.status === "failed") {
    return finish({
      step: "plan",
      title:
        guided.status === "running"
          ? "AI 준비의 저장 상태를 확인해 주세요"
          : "중단된 AI 준비 내용을 확인해 주세요",
      description:
        "저장된 결과와 실제 실행 상태를 확인한 뒤 이어갑니다. 이전 계획서는 보관되어 있으며 같은 요청을 자동으로 다시 보내지 않습니다.",
      action: { label: "AI 준비 상태 확인하기", destination: "plan" },
    });
  }
  if (pendingSources.length) {
    return finish({
      step: "materials",
      title: "확인이 필요한 자료가 있어요",
      description: `본문을 확인하지 않은 자료가 ${pendingSources.length}개 있습니다. 원본과 읽어 낸 내용을 확인한 뒤 계획서 준비에 사용합니다.`,
      action: { label: "자료 확인하기", destination: "sources" },
    });
  }
  if (guided && inputState === "changed") {
    return finish({
      step: "plan",
      title: "변경한 자료로 AI 준비 범위를 확인해 주세요",
      description:
        "이전 AI 준비에 사용한 자료와 현재 자료가 달라졌습니다. 최신 자료 범위를 확인한 뒤 이어가며 기존 원고는 보관합니다.",
      action: { label: "현재 준비 범위 확인하기", destination: "plan" },
    });
  }
  if (guided?.status === "awaiting_materials") {
    return finish({
      step: "materials",
      title: "계획서에 필요한 설명을 더 알려 주세요",
      description:
        "이번 AI 분석에서 신청 근거를 더 확인해야 합니다. 이전 원고를 새 분석의 완료 결과로 사용하지 않으며, 가진 자료나 회사 설명을 보완할 수 있습니다.",
      action: { label: "회사 설명 보완하기", destination: "profile" },
    });
  }
  if (guided?.status === "awaiting_choice") {
    const selected = Boolean(currentCandidateSelection(company));
    return finish({
      step: "plan",
      title: selected
        ? "확인한 신청 방향으로 작성을 이어가세요"
        : "새로 준비한 신청 방향을 확인해 주세요",
      description:
        "이번 AI 분석의 신청 방향을 확인한 뒤 계획서를 작성합니다. 이전 원고는 그대로 보관되며, 현재 자료가 반영됐는지 함께 확인합니다.",
      action: selected
        ? { label: "선택한 주제로 작성 이어가기", destination: "plan" }
        : { label: "신청 방향 확인하기", destination: "analysis" },
    });
  }
  if (guided?.status === "awaiting_review" && !planBelongsToGuidedResult(company, plan, guided)) {
    return finish({
      step: "plan",
      title: "이번 AI 작성 결과를 확인해 주세요",
      description:
        "AI 준비 기록과 현재 원고의 연결을 확인하지 못했습니다. 이전 원고는 보관되어 있으며 이번에 저장된 작성 결과를 확인해야 합니다.",
      action: { label: "작성 결과 확인하기", destination: "plan" },
    });
  }
  if (guided && inputState === "unverified") {
    return finish({
      step: "plan",
      title: "현재 자료와 계획서의 연결을 확인해 주세요",
      description:
        "작성 당시와 현재 회사 설명·업종·자료가 같은지 아직 확인하지 못했습니다. 최신 저장 상태를 확인한 뒤 원고 검토를 이어갑니다.",
      action: { label: "현재 준비 상태 확인하기", destination: "plan" },
    });
  }
  if (
    !guided &&
    (run?.status === "running" ||
      run?.status === "failed" ||
      batch?.status === "running" ||
      batch?.status === "failed")
  ) {
    return finish({
      step: "plan",
      title: "저장된 준비 상태를 확인해 주세요",
      description:
        "이전 작업의 저장 여부와 중단 지점을 먼저 확인합니다. 저장된 진행 기록만으로 현재 실행 중이라고 판단하지 않습니다.",
      action: { label: "준비 상태 확인하기", destination: "diagnosis" },
    });
  }
  if (
    outdated ||
    (!guided && (run?.stale || run?.status === "blocked" || batch?.status === "blocked"))
  ) {
    return finish({
      step: "plan",
      title: "달라진 자료를 계획서에 반영해 주세요",
      description:
        "현재 회사 자료와 이전 준비 결과가 일치하는지 다시 확인해야 합니다. 기존 원고와 기록은 보관됩니다.",
      action: { label: "준비 내용 확인하기", destination: "diagnosis" },
    });
  }
  if (!guided && (run?.status === "awaiting_materials" || batch?.status === "awaiting_materials")) {
    return finish({
      step: "materials",
      title: "회사 설명을 조금 더 알려 주세요",
      description:
        "현재 기술과 사업을 설명할 근거가 부족합니다. 가진 자료를 더하거나 회사 설명부터 보완할 수 있습니다.",
      action: { label: "회사 설명 보완하기", destination: "profile" },
    });
  }
  if (plan) {
    return finish(
      planReady
        ? {
            step: "application",
            title: "검토한 계획서로 신청을 준비해 주세요",
            description:
              "현재 원고의 내부 검토 기록이 있습니다. 벤처인 연결에서 실제 입력 항목과 첨부자료를 확인하고 필요한 승인을 진행합니다.",
            action: { label: "신청 준비하기", destination: "venturein" },
          }
        : {
            step: "plan",
            title: "작성된 계획서를 확인해 주세요",
            description:
              "초안의 실제 사실과 확인이 필요한 내용을 검토해 주세요. 수정할 부분만 고치고 기존 자료는 그대로 이어서 사용합니다.",
            action: { label: "계획서 확인하기", destination: "plan" },
          },
    );
  }
  if (company.analysis) {
    const selected = Boolean(currentCandidateSelection(company));
    return finish({
      step: "plan",
      title: selected ? "회사 자료로 계획서를 준비해 주세요" : "신청할 사업 내용을 확인해 주세요",
      description: selected
        ? "확인한 신청 방향과 자료를 바탕으로 원고를 준비합니다. 작성 결과는 제출 전에 검토합니다."
        : "자료에서 찾은 사업 내용과 실제 추진 방향이 맞는지 확인해 주세요. 확인하지 않은 기술이나 실적으로 확정하지 않습니다.",
      action: selected
        ? { label: "계획서 준비하기", destination: "plan" }
        : { label: "신청 방향 확인하기", destination: "analysis" },
    });
  }
  const hasDescription = Boolean(company.profile.technologySummary.trim());
  const hasText = company.sources.some((source) => source.text.trim());
  if (hasDescription || hasText) {
    return finish({
      step: "plan",
      title: "회사 자료로 계획서 준비를 시작해 주세요",
      description:
        "등록한 자료와 회사 설명을 바탕으로 필요한 내용을 확인합니다. 부족한 사실은 질문으로 남기고 확인된 내용부터 준비합니다.",
      action: { label: "계획서 준비하기", destination: "diagnosis" },
    });
  }
  return finish({
    step: "materials",
    title: "가진 회사 자료를 올려 주세요",
    description:
      "사업자등록증, 회사소개서, 재무자료 등 가진 자료부터 시작하세요. 파일이 없으면 회사 설명을 먼저 입력해도 됩니다.",
    action: { label: "자료 올리기", destination: "sources" },
  });
}
