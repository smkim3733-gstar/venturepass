import { isAgencyNoticeRecord } from "@/lib/studio-agency-records";
import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import {
  appealPreparationInputSchema,
  MAX_APPEAL_VERSIONS,
  type AppealPreparationInput,
} from "@/lib/studio-appeal-types";

/** Acknowledges this append without discarding another preparation or unrelated company state. */
export function appealPreparationSaveAcknowledged(
  response: unknown,
  company: StudioCase,
  clientRequestId: string,
  raw: AppealPreparationInput,
): boolean {
  const parsed = caseSchema.safeParse(response),
    original = caseSchema.safeParse(company);
  const input = appealPreparationInputSchema.safeParse(raw);
  if (!parsed.success || !original.success || !input.success) return false;
  const saved = parsed.data,
    before = original.data,
    request = input.data;
  const previous = before.appealPreparations,
    records = saved.appealPreparations;
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    !Number.isSafeInteger(before.revision) ||
    before.revision < 0 ||
    !Number.isSafeInteger(saved.revision) ||
    saved.id !== before.id ||
    saved.revision <= before.revision ||
    previous.length >= MAX_APPEAL_VERSIONS
  )
    return false;
  for (const list of [previous, records]) {
    for (const key of ["id", "clientRequestId"] as const)
      if (new Set(list.map((r) => r[key])).size !== list.length) return false;
    if (new Set(list.map((r) => `${r.preparationId}:${r.version}`)).size !== list.length)
      return false;
  }
  if (previous.some((r) => r.clientRequestId === clientRequestId)) return false;
  const record = records.at(-1);
  if (
    !record ||
    record.clientRequestId !== clientRequestId ||
    !equal(records, [...previous, record])
  )
    return false;
  const notices = before.agencyRecords
    .filter(isAgencyNoticeRecord)
    .filter((notice) => notice.noticeRecordId === request.noticeRecordId);
  if (
    notices.filter((notice) => notice.id === request.noticeRecordId && notice.kind === "notice")
      .length !== 1 ||
    new Set(notices.map((notice) => notice.id)).size !== notices.length ||
    notices.at(-1)?.id !== request.noticeVersionId ||
    notices.at(-1)?.details.category !== "decision"
  )
    return false;
  const prior = request.preparationId
    ? previous.filter((r) => r.preparationId === request.preparationId).at(-1)
    : undefined;
  if (request.preparationId) {
    const roots = previous.filter(
      (r) =>
        r.id === request.preparationId &&
        r.preparationId === r.id &&
        r.previousVersionId === null &&
        r.version === 1,
    );
    if (
      roots.length !== 1 ||
      !prior ||
      prior.id !== request.previousVersionId ||
      roots[0].noticeRecordId !== request.noticeRecordId
    )
      return false;
  } else if (previous.some((r) => r.noticeRecordId === request.noticeRecordId)) return false;
  if (
    record.preparationId !== (request.preparationId ?? record.id) ||
    record.previousVersionId !== request.previousVersionId ||
    record.version !== (prior?.version ?? 0) + 1
  )
    return false;
  for (const key of [
    "noticeRecordId",
    "noticeVersionId",
    "title",
    "intent",
    "intentNote",
    "deadlineOn",
    "deadlineNote",
    "reasons",
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
    {
      ...saved,
      revision: before.revision,
      updatedAt: before.updatedAt,
      appealPreparations: previous,
    },
    before,
  );
}
