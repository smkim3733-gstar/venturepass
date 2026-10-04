import { z } from "zod";
import type { StudioCase } from "./studio-schema";
import type { PlanSupplementExecutionRecord } from "./studio-plan-supplement-execution-types";
import { comparePlanSupplement } from "./studio-plan-supplement";
import { planSupplementDraftSchema } from "./studio-plan-supplement-types";
import {
  auditPlanSupplementExecutions,
  supplementDigest,
} from "./studio-plan-supplement-execution-state";
const responseSchema = z.object({
  id: z.string().min(1).max(300),
  model: z.string().min(1).max(200),
  status: z.literal("completed"),
  output: z.array(z.unknown()).max(50),
});
const messageSchema = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  status: z.literal("completed"),
  content: z
    .array(z.object({ type: z.literal("output_text"), text: z.string().max(100000) }))
    .length(1),
});
export function readPlanSupplementResponse(rawJson: string) {
  const response = responseSchema.parse(JSON.parse(rawJson));
  const messages = response.output.filter(
    (item) =>
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "message",
  );
  if (
    messages.length !== 1 ||
    response.output.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        !["message", "reasoning"].includes(String((item as { type?: unknown }).type)),
    )
  )
    throw Error();
  const message = messageSchema.parse(messages[0]);
  const draft = planSupplementDraftSchema.parse(JSON.parse(message.content[0].text));
  return { response, draft };
}
/** A stored SDK response is separately checked against the original context before comparison. No adoption. */
export function planSupplementResult(company: StudioCase, record: PlanSupplementExecutionRecord) {
  auditPlanSupplementExecutions(company);
  const stored = company.planSupplementExecutions?.find((item) => item.id === record.id);
  if (!stored || supplementDigest(stored) !== supplementDigest(record))
    throw Error("SUPPLEMENT_RECORD_CHANGED");
  if (!record.capture) return { state: "result-unconfirmed" as const, proposal: null };
  if (record.capture.kind !== "response") return { state: record.capture.kind, proposal: null };
  try {
    const { response, draft } = readPlanSupplementResponse(record.capture.rawJson);
    // Normalize only our reservation+capture increments. A late response is retained, never rebased.
    if (
      company.revision !== record.finishedRevision ||
      record.finishedRevision !== record.reservationRevision + 1
    )
      return { state: "context-changed" as const, proposal: null };
    const comparison = comparePlanSupplement(
      { ...company, revision: record.command.input.revision },
      record.command.input,
      record.command.approval.binding,
      draft,
    );
    return {
      state: "comparison-ready" as const,
      proposal: {
        ...comparison,
        origin: "captured-sdk-draft" as const,
        executionId: record.id,
        captureSha256: record.captureSha256,
        responseId: response.id,
        responseModel: response.model,
        warnings: [
          ...comparison.warnings,
          "보관한 응답의 형식·원문 위치를 대조했습니다. AI 의미 품질·사람 검토·채택 완료는 아닙니다.",
        ],
      },
    };
  } catch {
    return { state: "captured-response-unusable" as const, proposal: null };
  }
}
