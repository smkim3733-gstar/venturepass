import "server-only";
import { randomUUID } from "node:crypto";
import type { StudioStore } from "./studio-storage";
import { getAiStatus } from "./studio-engine";
import { StudioError } from "./studio-http";
import { assertVentureCompanyWritable } from "./venturein-input-lock";
import {
  answerSuggestionSha,
  answerSuggestionError,
  buildAnswerSuggestionContext,
  buildLocalAnswerSuggestions,
  validateAiAnswerSuggestions,
} from "./studio-answer-suggestion";
import { selectAnswerExcerptsWithAi } from "./studio-answer-suggestion-provider";
import {
  answerSuggestionApprovalSchema,
  answerSuggestionCommandSchema,
  answerSuggestionLimits,
  type AnswerSuggestionApproval,
  type AnswerSuggestionAiPreview,
  type AnswerSuggestionCommand,
} from "./studio-answer-suggestion-types";

type ApprovalEntry = { approval: AnswerSuggestionApproval; used: boolean };
const shared = globalThis as typeof globalThis & {
  __venturepassAnswerSuggestionApprovals?: Map<string, ApprovalEntry>;
  __venturepassAnswerSuggestionJobs?: Set<string>;
};
const approvals = (shared.__venturepassAnswerSuggestionApprovals ??= new Map<
    string,
    ApprovalEntry
  >()),
  jobs = (shared.__venturepassAnswerSuggestionJobs ??= new Set<string>());
function cleanup() {
  const now = Date.now();
  for (const [token, entry] of approvals)
    if (Date.parse(entry.approval.expiresAt) <= now) approvals.delete(token);
}
function model() {
  const status = getAiStatus();
  if (!status.aiConfigured)
    throw new StudioError(
      "AI 제안용 API 키가 설정되지 않았습니다.",
      503,
      "ANSWER_SUGGESTION_AI_NOT_CONFIGURED",
    );
  return status.model;
}
export async function runAnswerSuggestionCommand(
  store: Pick<StudioStore, "get">,
  caseId: string,
  raw: AnswerSuggestionCommand,
) {
  const command = answerSuggestionCommandSchema.parse(raw);
  assertVentureCompanyWritable(caseId);
  cleanup();
  if (jobs.has(caseId)) answerSuggestionError("ANSWER_SUGGESTION_BUSY");
  const context = buildAnswerSuggestionContext(store.get(caseId), command.input);
  if (context.binding.caseId !== caseId) answerSuggestionError("ANSWER_SUGGESTION_STALE");
  if (command.action === "local") return buildLocalAnswerSuggestions(context);
  const currentModel = model(),
    payloadSha256 = answerSuggestionSha(JSON.stringify(context.transmission));
  if (command.action === "prepare-ai") {
    if (approvals.size >= answerSuggestionLimits.approvals)
      answerSuggestionError("ANSWER_SUGGESTION_APPROVAL_LIMIT", 429);
    const approval = answerSuggestionApprovalSchema.parse({
      token: randomUUID(),
      expiresAt: new Date(Date.now() + answerSuggestionLimits.approvalMs).toISOString(),
      binding: context.binding,
      provider: "openai",
      destination: "https://api.openai.com/v1/responses",
      purpose: "select-exact-answer-excerpts",
      model: currentModel,
      payloadSha256,
    });
    approvals.set(approval.token, { approval, used: false });
    return {
      approval,
      transmission: context.transmission,
      externalTransmissionPerformed: false,
    } satisfies AnswerSuggestionAiPreview;
  }
  const approval = command.approval;
  const entry = approvals.get(approval.token);
  function assertApproval() {
    assertVentureCompanyWritable(caseId);
    const fresh = buildAnswerSuggestionContext(store.get(caseId), command.input);
    if (
      !entry ||
      entry.used ||
      Date.parse(entry.approval.expiresAt) <= Date.now() ||
      JSON.stringify(entry.approval) !== JSON.stringify(approval) ||
      JSON.stringify(fresh.binding) !== JSON.stringify(approval.binding) ||
      answerSuggestionSha(JSON.stringify(fresh.transmission)) !== approval.payloadSha256 ||
      model() !== approval.model
    )
      answerSuggestionError("ANSWER_SUGGESTION_APPROVAL_STALE");
    return entry;
  }
  assertApproval();
  jobs.add(caseId);
  try {
    const output = await selectAnswerExcerptsWithAi(context.transmission, currentModel, () => {
      assertApproval().used = true;
    });
    if (!entry?.used) answerSuggestionError("ANSWER_SUGGESTION_APPROVAL_STALE");
    assertVentureCompanyWritable(caseId);
    const fresh = buildAnswerSuggestionContext(store.get(caseId), command.input);
    if (JSON.stringify(fresh.binding) !== JSON.stringify(context.binding))
      answerSuggestionError("ANSWER_SUGGESTION_STALE");
    return validateAiAnswerSuggestions(fresh, output, currentModel);
  } finally {
    jobs.delete(caseId);
    cleanup();
  }
}
