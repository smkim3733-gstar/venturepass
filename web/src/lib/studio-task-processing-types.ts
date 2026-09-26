import { z } from "zod";

export const taskProcessingStages = ["collecting", "writing", "reviewing", "ready"] as const;
export const taskProcessingStageLabels = {
  collecting: "자료 준비 중",
  writing: "답변 작성 중",
  reviewing: "내용 확인 중",
  ready: "내부 준비 완료(담당자 기록)",
} satisfies Record<(typeof taskProcessingStages)[number], string>;

export const taskPlanReferenceSchema = z
  .object({
    planId: z.string().uuid(),
    sectionKey: z.string().trim().min(1).max(100),
    quote: z.string().trim().min(1).max(1500),
  })
  .strict();
export const taskProcessingSchema = z
  .object({
    stage: z.enum(taskProcessingStages),
    planRefs: z.array(taskPlanReferenceSchema).max(10),
  })
  .strict()
  .refine(
    ({ planRefs }) =>
      new Set(planRefs.map(({ planId, sectionKey }) => JSON.stringify([planId, sectionKey])))
        .size === planRefs.length,
    { message: "같은 원고 버전의 같은 항목은 한 번만 연결해 주세요.", path: ["planRefs"] },
  );
export type TaskProcessing = z.infer<typeof taskProcessingSchema>;
export type TaskPlanReference = z.infer<typeof taskPlanReferenceSchema>;

// Structural shape only: this pure module must not import the containing case schema.
export type TaskProcessingPlan = {
  id: string;
  version: number;
  content: {
    title: string;
    sections: Array<{ key: string; title: string; content: string }>;
  };
};

/** Match only against the selected company's stored, immutable plan versions. */
export function resolveTaskPlanReference(
  plans: readonly TaskProcessingPlan[],
  reference: TaskPlanReference,
) {
  const candidates = plans.filter((plan) => plan.id === reference.planId);
  if (candidates.length !== 1)
    return { state: candidates.length ? "ambiguous-plan" : "missing-plan" } as const;
  const plan = candidates[0];
  const sections = plan.content.sections.filter(
    (section) => section.key === reference.sectionKey.trim(),
  );
  if (sections.length !== 1)
    return { state: sections.length ? "ambiguous-section" : "missing-section" } as const;
  const quote = reference.quote.trim();
  if (!quote || !sections[0].content.includes(quote)) return { state: "quote-mismatch" } as const;
  return {
    state: "matched",
    plan,
    section: sections[0],
    latest: plans.at(-1)?.id === plan.id,
  } as const;
}
