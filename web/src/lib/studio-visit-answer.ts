// Node-only capture of local rehearsal answers. No AI, network, or official actions.
import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import { isApplicationSubmission } from "./studio-application-types";
import { originalConflicts, planConflicts } from "./studio-evidence-history";
import type { SourceDocument, StudioCase } from "./studio-schema";
import {
  buildVisitAnswerChecks,
  visitAnswerLimits,
  visitAnswerSchema,
  type VisitAnswer,
  type VisitAnswerInput,
} from "./studio-visit-answer-types";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const visitAnswerInputDigest = (input: VisitAnswerInput) => hash(JSON.stringify(input));
function fail(message: string, code: string, status = 409): never {
  throw new StudioError(message, status, code);
}
export function assertVisitAnswerCapacity(records: VisitAnswer[]) {
  const size = (value: unknown): number =>
    typeof value === "string"
      ? value.length
      : Array.isArray(value)
        ? value.reduce((sum, item) => sum + size(item), 0)
        : value && typeof value === "object"
          ? Object.values(value).reduce<number>((sum, item) => sum + size(item), 0)
          : 0;
  if (records.length > visitAnswerLimits.versions || size(records) > visitAnswerLimits.text)
    fail(
      "실사 답변 이력의 보관 한도에 도달했습니다. 기존 기록은 보존합니다.",
      "VISIT_ANSWER_LIMIT",
    );
}
export function isVisitAnswerReplay(
  records: VisitAnswer[],
  clientRequestId: string,
  inputDigest: string,
) {
  const matches = records.filter((record) => record.clientRequestId === clientRequestId);
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== inputDigest)
    fail(
      "같은 저장 요청의 답변 내용이 다릅니다. 최신 내용을 확인하고 새 요청으로 저장해 주세요.",
      "VISIT_ANSWER_REQUEST_CONFLICT",
    );
  return true;
}
export type VisitAnswerCompany = StudioCase & { visitAnswers: VisitAnswer[] };
type OriginalReader = (sourceId: string) => {
  source: SourceDocument;
  buffer: Buffer;
  sha256: string;
};
type Generated = Pick<VisitAnswer, "id" | "clientRequestId" | "inputDigest" | "recordedAt">;

export function buildVisitAnswer(
  company: VisitAnswerCompany,
  input: VisitAnswerInput,
  generated: Generated,
  readOriginal: OriginalReader,
): VisitAnswer {
  if (company.visitAnswers.length >= visitAnswerLimits.versions)
    fail("실사 답변 이력의 보관 한도에 도달했습니다.", "VISIT_ANSWER_LIMIT");
  const plans = company.plans.filter((plan) => plan.id === input.planId);
  if (plans.length !== 1)
    fail("이 기업의 고유한 원고 버전을 선택해 주세요.", "VISIT_PLAN_NOT_FOUND", 404);
  const plan = plans[0];
  if (plan.content.interviewQuestions[input.questionIndex] !== input.questionText)
    fail("선택한 원고의 질문 순서와 원문을 다시 확인해 주세요.", "VISIT_QUESTION_CHANGED");
  const planIdentity = {
    planId: plan.id,
    version: plan.version,
    contentSha256: hash(JSON.stringify(plan.content)),
  };
  if (planConflicts(company, planIdentity))
    fail(
      "이미 연결한 원고 버전이 변경되었습니다. 기존 이력을 보존하고 새 원고 버전을 사용해 주세요.",
      "VISIT_PLAN_CHANGED",
    );
  let previous: VisitAnswer | undefined;
  if (input.answerId) {
    const roots = company.visitAnswers.filter(
      (record) => record.id === input.answerId && record.previousVersionId === null,
    );
    if (roots.length !== 1)
      fail("이 기업의 기존 실사 답변을 찾을 수 없습니다.", "VISIT_ANSWER_NOT_FOUND", 404);
    const root = roots[0];
    if (
      root.planId !== input.planId ||
      root.questionIndex !== input.questionIndex ||
      root.questionText !== input.questionText
    )
      fail("기존 답변을 다른 원고·질문으로 옮길 수 없습니다.", "VISIT_ANSWER_ROOT_MISMATCH");
    previous = company.visitAnswers.filter((record) => record.answerId === root.id).at(-1)!;
    if (previous.id !== input.previousVersionId)
      fail("답변 최신 버전이 변경되었습니다. 다시 불러와 주세요.", "VISIT_ANSWER_VERSION_STALE");
  } else if (
    company.visitAnswers.some(
      (record) => record.planId === input.planId && record.questionIndex === input.questionIndex,
    )
  )
    fail(
      "이 원고·질문에 답변 이력이 있습니다. 최신 버전에서 이어서 작성해 주세요.",
      "VISIT_ANSWER_ALREADY_EXISTS",
    );
  if (
    input.review.reviewed &&
    (!previous ||
      !input.answerText.trim() ||
      !input.respondentName.trim() ||
      !input.review.reviewer.trim())
  )
    fail(
      "최초 답변은 미검토로 저장합니다. 후속 내부 검토의 답변·응답자·검토자를 확인해 주세요.",
      "VISIT_REVIEW_INVALID",
      422,
    );
  let submissionSnapshot: VisitAnswer["submissionSnapshot"] = null;
  if (input.submissionRecordId) {
    const submissions = company.applicationEvents.filter(
      (event) => event.id === input.submissionRecordId && isApplicationSubmission(event),
    );
    const submission = submissions.length === 1 ? submissions[0] : undefined;
    if (!submission || !isApplicationSubmission(submission))
      fail("이 기업의 수동 제출 기록을 찾을 수 없습니다.", "VISIT_SUBMISSION_NOT_FOUND", 404);
    if (
      submission.plan.id !== plan.id ||
      submission.plan.version !== plan.version ||
      submission.plan.contentSha256 !== planIdentity.contentSha256
    )
      fail("수동 제출 기록과 선택한 원고의 버전·내용이 다릅니다.", "VISIT_SUBMISSION_MISMATCH");
    submissionSnapshot = {
      id: submission.id,
      applicationId: submission.applicationId,
      version: submission.version,
      recordedAt: submission.recordedAt,
      planContentSha256: submission.plan.contentSha256,
    };
  }
  const references = input.pairs.flatMap((pair) => pair.sources);
  const sourceIds = [...new Set(references.map((source) => source.sourceId))];
  if (sourceIds.length > visitAnswerLimits.sources)
    fail("한 답변 버전에는 서로 다른 자료 10개까지 연결할 수 있습니다.", "VISIT_SOURCE_LIMIT", 413);
  // Resolve every target and exact quotation before opening any original.
  for (const pair of input.pairs) {
    if (!input.answerText.includes(pair.answerQuote))
      fail(
        "대조할 답변은 작성한 답변에서 정확히 인용해 주세요.",
        "VISIT_ANSWER_QUOTE_INVALID",
        422,
      );
    if (pair.planReference) {
      const reference = pair.planReference;
      const sections = plan.content.sections.filter(
        (section) => section.key === reference.sectionKey,
      );
      if (sections.length !== 1 || !sections[0].content.includes(reference.quote))
        fail("선택한 원고의 고유 항목에서 정확히 인용해 주세요.", "VISIT_PLAN_QUOTE_INVALID", 422);
    }
  }
  for (const reference of references) {
    const sources = company.sources.filter((source) => source.id === reference.sourceId);
    if (sources.length !== 1)
      fail("이 기업의 고유한 자료를 선택해 주세요.", "VISIT_SOURCE_NOT_FOUND", 404);
    const source = sources[0];
    if (
      source.updatedAt !== reference.sourceUpdatedAt ||
      (reference.quote === ""
        ? !source.originalName
        : !reference.quote.trim() ||
          source.extraction === "pending" ||
          !source.text.includes(reference.quote))
    )
      fail(
        "현재 자료의 본문과 인용을 확인해 주세요. 미추출 원본은 인용 없이 연결할 수 있습니다.",
        "VISIT_SOURCE_STALE",
      );
  }
  const sourceSnapshots: VisitAnswer["sourceSnapshots"] = [];
  let totalBytes = 0;
  for (const sourceId of sourceIds) {
    const source = company.sources.find((entry) => entry.id === sourceId)!;
    let original: VisitAnswer["sourceSnapshots"][number]["original"] = null;
    if (source.originalName) {
      const current = readOriginal(sourceId);
      if (
        JSON.stringify(current.source) !== JSON.stringify(source) ||
        hash(current.buffer) !== current.sha256
      )
        fail("자료·원본이 변경되었습니다. 다시 불러와 주세요.", "VISIT_SOURCE_STALE");
      totalBytes += current.buffer.length;
      if (current.buffer.length > 12 * 1024 * 1024 || totalBytes > visitAnswerLimits.originalBytes)
        fail("원본은 파일별 12MiB, 합계 24MiB 이내로 연결해 주세요.", "VISIT_ORIGINAL_LIMIT", 413);
      original = {
        sourceId,
        sourceName: source.name,
        originalName: source.originalName,
        mimeType: source.mimeType,
        sizeBytes: current.buffer.length,
        sha256: current.sha256,
        capturedAt: generated.recordedAt,
        sourceUpdatedAt: source.updatedAt,
      };
      if (originalConflicts(company, original))
        fail(
          "이미 연결한 원본이 변경되었습니다. 기존 이력을 보존하고 새 원본을 별도 등록해 주세요.",
          "VISIT_ORIGINAL_CHANGED",
        );
    }
    sourceSnapshots.push({
      sourceId,
      sourceName: source.name,
      sourceUpdatedAt: source.updatedAt,
      extraction: source.extraction,
      textSha256: hash(source.text),
      original,
    });
  }
  const record = visitAnswerSchema.parse({
    ...generated,
    ...input,
    answerId: input.answerId ?? generated.id,
    previousVersionId: previous?.id ?? null,
    version: (previous?.version ?? 0) + 1,
    origin: "manual",
    questionSnapshot: {
      planId: plan.id,
      planVersion: plan.version,
      planTitle: plan.content.title,
      planContentSha256: planIdentity.contentSha256,
      questionIndex: input.questionIndex,
      questionText: input.questionText,
      questionSha256: hash(input.questionText),
    },
    submissionSnapshot,
    sourceSnapshots,
    checkVersion: "paired-spelling-v1",
    checks: buildVisitAnswerChecks(input),
    review: {
      reviewedAt: input.review.reviewed ? generated.recordedAt : null,
      reviewer: input.review.reviewer,
      note: input.review.note,
    },
  });
  assertVisitAnswerCapacity([...company.visitAnswers, record]);
  for (const snapshot of sourceSnapshots) {
    if (!snapshot.original) continue;
    const current = readOriginal(snapshot.sourceId);
    const source = company.sources.find((entry) => entry.id === snapshot.sourceId)!;
    if (
      JSON.stringify(current.source) !== JSON.stringify(source) ||
      current.sha256 !== snapshot.original.sha256 ||
      hash(current.buffer) !== snapshot.original.sha256 ||
      current.buffer.length !== snapshot.original.sizeBytes
    )
      fail(
        "저장 중 원본이 변경되었습니다. 이 답변 버전은 저장하지 않았습니다.",
        "VISIT_ORIGINAL_CHANGED",
      );
  }
  return record;
}
