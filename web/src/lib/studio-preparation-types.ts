import { z } from "zod";

export const MAX_PREPARATION_RUNS = 30;
export const MAX_PREPARATION_REQUESTS = 20;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(300);
export const preparationRunSchema = z
  .object({
    id: z.string().uuid(),
    mode: z.literal("assisted"),
    inputFingerprint: hash,
    criteriaVersion: z.string().max(100),
    sourceRevision: z.number().int().nonnegative().safe(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    status: z.enum([
      "running",
      "awaiting_choice",
      "awaiting_materials",
      "awaiting_review",
      "blocked",
      "failed",
    ]),
    phase: z.enum(["diagnosis", "analysis", "choice", "plan", "review"]),
    stale: z.boolean().default(true),
    code: z.string().max(100).nullable(),
    diagnosisId: z.string().uuid().nullable(),
    analysisDigest: hash.nullable(),
    candidates: z.array(z.object({ id: identifier, digest: hash }).strict()).max(3),
    selectedCandidateId: identifier.nullable(),
    selectedCandidateDigest: hash.nullable(),
    planId: z.string().uuid().nullable(),
    planDigest: hash.nullable(),
    steps: z
      .array(
        z
          .object({
            phase: z.enum(["diagnosis", "analysis", "selection", "plan"]),
            state: z.enum(["created", "reused", "selected"]),
            artifactId: z.string().max(300).nullable(),
            at: z.string().datetime(),
          })
          .strict(),
      )
      .max(4),
    requests: z
      .array(z.object({ clientRequestId: z.string().uuid(), digest: hash }).strict())
      .min(1)
      .max(MAX_PREPARATION_REQUESTS),
  })
  .strict();
export type PreparationRun = z.infer<typeof preparationRunSchema>;
const request = {
  revision: z.number().int().nonnegative().safe(),
  clientRequestId: z.string().uuid(),
};
export const preparationRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), ...request }).strict(),
  z.object({ action: z.literal("resume"), ...request, runId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("continue"),
      ...request,
      runId: z.string().uuid(),
      candidateId: identifier,
      candidateDigest: hash,
    })
    .strict(),
]);
export type PreparationRequest = z.infer<typeof preparationRequestSchema>;
