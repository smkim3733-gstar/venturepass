import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import {
  visitAnswerInputSchema,
  visitAnswerLimits,
  type VisitAnswerInput,
} from "@/lib/studio-visit-answer-types";

/** Acknowledges this append without discarding another answer or unrelated company state. */
export function visitAnswerSaveAcknowledged(
  response: unknown,
  company: StudioCase,
  clientRequestId: string,
  raw: VisitAnswerInput,
): boolean {
  const parsed = caseSchema.safeParse(response),
    original = caseSchema.safeParse(company);
  const input = visitAnswerInputSchema.safeParse(raw);
  if (!parsed.success || !original.success || !input.success) return false;
  const saved = parsed.data,
    before = original.data,
    request = input.data;
  const previous = before.visitAnswers,
    records = saved.visitAnswers;
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    !Number.isSafeInteger(before.revision) ||
    before.revision < 0 ||
    !Number.isSafeInteger(saved.revision) ||
    saved.id !== before.id ||
    saved.revision <= before.revision ||
    previous.length >= visitAnswerLimits.versions
  )
    return false;
  for (const list of [previous, records]) {
    for (const key of ["id", "clientRequestId"] as const)
      if (new Set(list.map((r) => r[key])).size !== list.length) return false;
    if (new Set(list.map((r) => `${r.answerId}:${r.version}`)).size !== list.length) return false;
  }
  if (previous.some((r) => r.clientRequestId === clientRequestId)) return false;
  const record = records.at(-1);
  if (
    !record ||
    record.clientRequestId !== clientRequestId ||
    !equal(records, [...previous, record])
  )
    return false;
  const prior = request.answerId
    ? previous.filter((r) => r.answerId === request.answerId).at(-1)
    : undefined;
  if (request.answerId) {
    const roots = previous.filter(
      (r) =>
        r.id === request.answerId &&
        r.answerId === r.id &&
        r.previousVersionId === null &&
        r.version === 1,
    );
    if (
      roots.length !== 1 ||
      !prior ||
      prior.id !== request.previousVersionId ||
      roots[0].planId !== request.planId ||
      roots[0].questionIndex !== request.questionIndex ||
      roots[0].questionText !== request.questionText
    )
      return false;
  } else if (
    previous.some((r) => r.planId === request.planId && r.questionIndex === request.questionIndex)
  )
    return false;
  if (
    record.answerId !== (request.answerId ?? record.id) ||
    record.previousVersionId !== request.previousVersionId ||
    record.version !== (prior?.version ?? 0) + 1
  )
    return false;
  for (const key of [
    "planId",
    "questionIndex",
    "questionText",
    "submissionRecordId",
    "respondentRole",
    "respondentName",
    "answerText",
    "pairs",
    "followUpNote",
  ] as const)
    if (!equal(record[key], request[key])) return false;
  if (
    !equal(record.review, {
      reviewedAt: request.review.reviewed ? record.recordedAt : null,
      reviewer: request.review.reviewer,
      note: request.review.note,
    })
  )
    return false;
  return equal(
    { ...saved, revision: before.revision, updatedAt: before.updatedAt, visitAnswers: previous },
    before,
  );
}
