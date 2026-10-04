// Pure proposal preparation and comparison. No DB writes, keys, clock, SDK or transmission rights.
import { z } from "zod";
import { StudioError } from "./studio-http";
import { STUDIO_AI_INPUT_CHARACTER_LIMIT } from "./studio-ai-input";
import { compareTextExact } from "./studio-plan-diff";
import { sectionDefinitions, type StudioCase } from "./studio-schema";
import {
  planSupplementInputSchema,
  planSupplementBindingSchema,
  planSupplementDraftSchema,
  type PlanSupplementInput,
  type PlanSupplementBinding,
} from "./studio-plan-supplement-types";
export {
  planSupplementInputSchema,
  planSupplementBindingSchema,
  planSupplementDraftSchema,
  type PlanSupplementInput,
  type PlanSupplementBinding,
  type PlanSupplementDraft,
} from "./studio-plan-supplement-types";
import {
  answerSuggestionSha as sha,
  buildAnswerSuggestionContext,
  validateAnswerExcerptSelections,
} from "./studio-answer-suggestion";

function fail(code: string): never {
  throw new StudioError(
    "기준 원고·질문과 선택 자료를 다시 확인해 주세요. 기존 원고는 변경하지 않았습니다.",
    409,
    code,
  );
}
function context(value: StudioCase, raw: PlanSupplementInput) {
  const input = planSupplementInputSchema.parse(raw);
  const answer = buildAnswerSuggestionContext(value, {
    revision: input.revision,
    target: input.target,
    sourceSelections: input.sourceSelections,
  });
  // Explicitly work from the latest stored manuscript; never silently rebase an older draft.
  const target = input.target;
  if (target.kind !== "visit-question") fail("PLAN_SUPPLEMENT_TARGET");
  const plan = value.plans.find((plan) => plan.id === target.planId)!;
  if (
    value.plans.at(-1)?.id !== plan.id ||
    value.plans.some((other) => other.id !== plan.id && other.version >= plan.version) ||
    sha(JSON.stringify(plan.content)) !== input.baseContentSha256
  )
    fail("PLAN_SUPPLEMENT_BASE_CHANGED");
  if (
    plan.content.sections.length !== sectionDefinitions.length ||
    plan.content.sections.some((section, i) => section.key !== sectionDefinitions[i].key)
  )
    fail("PLAN_SUPPLEMENT_STRUCTURE");
  const section = plan.content.sections.find((section) => section.key === input.sectionKey)!;
  // Only this paragraph, this stored question, and explicitly selected registered text.
  // Old citation text is retained locally, not added to the outbound sources implicitly.
  const payload = JSON.stringify({
    purpose: "propose-one-section-supplement",
    question: answer.transmission.targetText,
    section: { key: section.key, title: section.title, content: section.content },
    sources: answer.transmission.sources,
  });
  if (payload.length > STUDIO_AI_INPUT_CHARACTER_LIMIT) fail("PLAN_SUPPLEMENT_INPUT_LIMIT");
  const { review, ...baseIdentity } = plan;
  // Derived review staleness is response-only and is not a new manuscript identity.
  void review;
  const bindingBase = {
    format: "one-section-supplement-v1" as const,
    answer: answer.binding,
    basePlanSha256: sha(JSON.stringify(baseIdentity)),
    sectionKey: input.sectionKey,
    payloadSha256: sha(payload),
  };
  const binding = planSupplementBindingSchema.parse({
    ...bindingBase,
    inputSha256: sha(JSON.stringify(bindingBase)),
  });
  return { input, answer, plan, section, binding, payload };
}
/** A keyless read; its binding is an identity comparison, never a provider approval. */
export function preparePlanSupplement(value: StudioCase, input: PlanSupplementInput) {
  const prepared = context(value, input);
  return {
    binding: prepared.binding,
    payload: prepared.payload,
    characters: prepared.payload.length,
    characterLimit: STUDIO_AI_INPUT_CHARACTER_LIMIT,
    retainedEvidence: structuredClone(prepared.section.evidence),
    transmissionAllowed: false as const,
    databaseChanged: false as const,
    actualTokenCountMeasured: false as const,
    contextFitVerified: false as const,
  };
}
/** Rebuild from current authoritative state before comparing any proposed result. */
export function comparePlanSupplement(
  value: StudioCase,
  input: PlanSupplementInput,
  expected: PlanSupplementBinding,
  raw: unknown,
) {
  const prepared = context(value, input);
  const binding = planSupplementBindingSchema.parse(expected);
  if (JSON.stringify(binding) !== JSON.stringify(prepared.binding))
    fail("PLAN_SUPPLEMENT_BINDING_CHANGED");
  const draft = planSupplementDraftSchema.parse(raw);
  const additions = validateAnswerExcerptSelections(prepared.answer, {
    selections: draft.addedEvidence,
  });
  const content = structuredClone(prepared.plan.content);
  const next = content.sections.find((section) => section.key === input.sectionKey)!;
  next.content = draft.content;
  next.needsConfirmation = true;
  for (const addition of additions) {
    const reference = {
      sourceId: addition.sourceId,
      quote: addition.quote,
      locator: `등록 본문 ${addition.lineStart}~${addition.lineEnd}행`,
    };
    if (
      !next.evidence.some(
        (old) => old.sourceId === reference.sourceId && old.quote === reference.quote,
      )
    )
      next.evidence.push(reference);
  }
  if (JSON.stringify(next) === JSON.stringify(prepared.section)) fail("PLAN_SUPPLEMENT_NO_CHANGE");
  return {
    binding,
    basePlanId: prepared.plan.id,
    basePlanVersion: prepared.plan.version,
    baseSourceRevision: prepared.plan.sourceRevision,
    sectionKey: input.sectionKey,
    before: structuredClone(prepared.section),
    after: structuredClone(next),
    comparison: compareTextExact(prepared.section.content, next.content),
    additions,
    content,
    proposalSha256: sha(JSON.stringify({ binding, draft, content })),
    origin: "supplied-draft" as const,
    reviewStatus: "unreviewed" as const,
    semanticQualityVerified: false as const,
    factVerified: false as const,
    databaseChanged: false as const,
    transmissionAllowed: false as const,
    warnings: [
      "등록된 선택 본문의 인용 위치만 대조했습니다. 문장 의미와 사실·시점·적합성은 별도 확인이 필요합니다.",
      "기존 인용·다른 항목·과제·질문은 그대로 유지했습니다. 기존 인용을 현재 자료로 재검증한 것은 아닙니다.",
      "아직 저장되지 않은 비교안입니다. 전송 동의나 원고 채택·검토 완료를 의미하지 않습니다.",
    ],
  };
}

export const planSupplementPreviewCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare"), input: planSupplementInputSchema }).strict(),
  z
    .object({
      action: z.literal("compare"),
      input: planSupplementInputSchema,
      binding: planSupplementBindingSchema,
      draft: planSupplementDraftSchema,
    })
    .strict(),
]);
