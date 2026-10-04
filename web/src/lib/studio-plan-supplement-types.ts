import { z } from "zod";
import { sectionDefinitions } from "./studio-section-definitions";
import {
  answerSuggestionAiSelectionSchema,
  answerSuggestionBindingSchema,
  answerSuggestionInputSchema,
} from "./studio-answer-suggestion-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const planSupplementInputSchema = answerSuggestionInputSchema
  .extend({
    sectionKey: z.enum(sectionDefinitions.map((section) => section.key)),
    baseContentSha256: hash,
  })
  .strict()
  .refine((input) => input.target.kind === "visit-question", {
    message: "보관한 원고의 질문을 선택해 주세요.",
  });
export type PlanSupplementInput = z.infer<typeof planSupplementInputSchema>;
export const planSupplementBindingSchema = z
  .object({
    format: z.literal("one-section-supplement-v1"),
    answer: answerSuggestionBindingSchema,
    basePlanSha256: hash,
    sectionKey: z.enum(sectionDefinitions.map((section) => section.key)),
    payloadSha256: hash,
    inputSha256: hash,
  })
  .strict();
export type PlanSupplementBinding = z.infer<typeof planSupplementBindingSchema>;
export const planSupplementDraftSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(18000)
      .refine((text) => Boolean(text.trim())),
    addedEvidence: answerSuggestionAiSelectionSchema.shape.selections.min(1),
  })
  .strict();
export type PlanSupplementDraft = z.infer<typeof planSupplementDraftSchema>;
