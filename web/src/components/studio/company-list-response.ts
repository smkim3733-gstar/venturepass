import { z } from "zod";
import { stageValues, type CaseSummary } from "@/lib/studio-schema";
import { preparationRunSchema } from "@/lib/studio-preparation-types";

const count = z.number().int().nonnegative().safe();
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const enteredDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const attention = z
  .object({
    pendingSourceCount: count,
    unconfirmedSectionCount: count,
    planReviewRequired: z.boolean(),
    diagnosisState: z.enum(["not_run", "current", "stale"]),
    preparationState: z.union([
      z.enum(["not_started", "stale"]),
      preparationRunSchema.shape.status,
    ]),
    pendingDueDates: z.array(enteredDate),
    undatedTaskCount: count,
    requestsWithoutSentResponse: count,
    certificate: z
      .object({
        recordedUntilDates: z.array(enteredDate),
        missingUntilCount: count,
        needsPreparationCount: count,
        changedTaskCount: count,
      })
      .strict()
      .optional(),
  })
  .strict();
const summary = z
  .object({
    id: z.string().uuid(),
    companyName: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => Boolean(value.trim())),
    industry: z.string().max(100),
    stage: z.enum(stageValues),
    revision: count,
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceCount: count,
    planCount: count,
    pendingTaskCount: count,
    attention: attention.optional(),
  })
  .strict();
const response = z.object({ cases: z.array(summary) }).strict();

export function companyListResponse(value: unknown): CaseSummary[] | null {
  const parsed = response.safeParse(value);
  if (!parsed.success) return null;
  const cases = parsed.data.cases;
  if (new Set(cases.map((item) => item.id)).size !== cases.length) return null;
  return cases;
}
